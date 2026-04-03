"""
ComfyUI 分段自动队列节点 - 最终版
"""

import math, copy, json, time, os, threading, urllib.request, hashlib, uuid
import server, folder_paths
from aiohttp import web

# ── 日志缓冲（前端弹窗读取）──────────────────────────────────────
_sqr_log_buf: dict = {}

def _sqr_log(uid, msg):
    text = "" if msg is None else str(msg)
    print(text)
    if not uid:
        return
    k = str(uid)
    buf = _sqr_log_buf.setdefault(k, [])
    lines = text.splitlines()
    if not lines:
        lines = [""]
    buf.extend(lines)
    if text.endswith("\n"):
        buf.append("")
    if len(buf) > 3000:
        _sqr_log_buf[k] = buf[-3000:]

def _sqr_log_clear(uid):
    _sqr_log_buf.pop(str(uid), None)


def calc_segments(total_frames: int, segments: int) -> list:
    per_seg = ((math.ceil(total_frames / segments) + 3) // 4) * 4 + 1
    result = []
    for i in range(segments):
        skip = i * per_seg
        if i < segments - 1:
            limit = per_seg
        else:
            remaining = total_frames - skip
            limit = ((remaining + 3) // 4) * 4 + 1
        result.append((skip, limit))
    return result


# ── 速度记录（预计时长）──
_SPEED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sqr_speed.json')

def load_speed_record():
    try:
        if os.path.exists(_SPEED_FILE):
            with open(_SPEED_FILE, 'r') as f:
                return json.load(f)
    except Exception:
        pass
    return None

# ── checkpoint 断点保护 ──────────────────────────────────────────
def get_checkpoint_path(unique_id):
    plugin_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(plugin_dir, f"sqr_checkpoint_{unique_id}.json")

def write_checkpoint(unique_id, data):
    try:
        with open(get_checkpoint_path(unique_id), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[SQR] checkpoint 写入失败: {e}")

def read_checkpoint(unique_id):
    try:
        p = get_checkpoint_path(unique_id)
        if not os.path.exists(p):
            return None
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def clear_checkpoint(unique_id):
    try:
        p = get_checkpoint_path(unique_id)
        if os.path.exists(p):
            os.remove(p)
    except Exception:
        pass


def _build_safe_input_copy_name(src_path: str, unique_id=None, prefix: str = "sqr_ref") -> str:
    """为复制到 input/ 的文件生成带来源签名的唯一文件名，避免同名覆盖。"""
    try:
        real = os.path.realpath(src_path)
        st = os.stat(real)
        sig_src = f"{real}|{st.st_mtime_ns}|{st.st_size}"
    except Exception:
        real = os.path.realpath(src_path)
        sig_src = real
    sig = hashlib.sha1(sig_src.encode("utf-8", errors="ignore")).hexdigest()[:12]
    base = os.path.basename(src_path)
    if unique_id:
        return f"{prefix}_{unique_id}_{sig}_{base}"
    return f"{prefix}_{sig}_{base}"


def save_speed_record(total_secs, total_frames_run):
    if total_frames_run <= 0 or total_secs <= 0:
        return
    try:
        from datetime import datetime
        with open(_SPEED_FILE, 'w') as f:
            json.dump({'spf': round(total_secs / total_frames_run, 4),
                       'date': datetime.now().strftime('%Y-%m-%d %H:%M')}, f)
    except Exception:
        pass


def build_plan_text(total_frames, segments, start_from_segment, node_id, frame_rate):
    if total_frames <= 0:
        return "✗ total_frames 必须大于 0。"
    start_from_segment = max(1, min(start_from_segment, segments))
    seg_list  = calc_segments(total_frames, segments)
    start_idx = start_from_segment - 1
    SEP = "═" * 45
    lines = [
        f"参考视频节点：{node_id}  总帧数：{total_frames}",
        f"共 {len(seg_list)} 段，从第 {start_from_segment} 段开始",
        "",
    ]
    for i, (skip, limit) in enumerate(seg_list):
        status = "→ 执行" if i >= start_idx else "  跳过"
        audio_s = skip / frame_rate if frame_rate > 0 else 0
        lines.append(f"  第{i+1}段 skip={skip} limit={limit} 音频={audio_s:.2f}s  {status}")
    lines.append(SEP)
    lines.append("")
    speed = load_speed_record()
    frames_to_run = sum(lmt for ii, (_, lmt) in enumerate(seg_list) if ii >= start_idx)
    segs_to_run_n = len(seg_list) - start_idx
    if speed and frames_to_run > 0:
        est = speed['spf'] * frames_to_run
        est_str = f"{est/3600:.1f}h" if est >= 3600 else f"{est/60:.0f}分钟"
        spf_str = f"{speed['spf']:.1f}s/帧"
        date_str = speed['date']
        lines.append(f"预计执行 {segs_to_run_n} 段约 {est_str}（基于 {date_str} 记录的 {spf_str}，实际因分辨率/步数等可能不同）")
    return "\n".join(lines)


def find_video_combine_node(prompt: dict, combine_node_id: str) -> str | None:
    nid = combine_node_id.strip()
    if nid and nid in prompt:
        return nid
    for nid, node in prompt.items():
        if node.get("class_type") == "VHS_VideoCombine":
            inputs = node.get("inputs", {})
            if inputs.get("save_output") is True:
                return nid
    return None


def find_audio_filename(prompt: dict, node_id: str) -> str | None:
    node = prompt.get(node_id, {})
    inputs = node.get("inputs", {})
    video = inputs.get("video", "")
    if video and isinstance(video, str):
        return video
    return None


def find_animate_embeds_node(prompt: dict) -> str | None:
    for nid, node in prompt.items():
        if node.get("class_type") == "WanVideoAnimateEmbeds":
            return nid
    return None


def queue_prompt(workflow, host="127.0.0.1:8188", client_id="") -> str:
    payload = json.dumps({"prompt": workflow, "client_id": client_id}).encode("utf-8")
    req = urllib.request.Request(
        f"http://{host}/prompt", data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())["prompt_id"]


def wait_for_prompt(prompt_id, host="127.0.0.1:8188", poll=5) -> bool:
    url = f"http://{host}/history/{prompt_id}"
    while True:
        time.sleep(poll)
        try:
            with urllib.request.urlopen(url) as resp:
                history = json.loads(resp.read())
            if prompt_id in history:
                st = history[prompt_id].get("status", {})
                if st.get("completed"):   return True
                if st.get("status_str") == "error": return False
        except Exception:
            pass


def get_output_video_info(prompt_id, combine_node_id, host="127.0.0.1:8188"):
    try:
        with urllib.request.urlopen(f"http://{host}/history/{prompt_id}") as resp:
            history = json.loads(resp.read())
        node_out = history.get(prompt_id, {}).get("outputs", {}).get(str(combine_node_id), {})
        gifs = node_out.get("gifs", [])
        if not gifs:
            return None, None
        gi = gifs[0]
        base_dir = folder_paths.get_output_directory() if gi.get("type") == "output" \
                   else folder_paths.get_input_directory()
        subfolder = gi.get("subfolder", "")
        video_path = os.path.join(base_dir, subfolder, gi["filename"]) if subfolder \
                     else os.path.join(base_dir, gi["filename"])
        import cv2
        cap = cv2.VideoCapture(video_path)
        frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) if cap.isOpened() else None
        cap.release()
        return video_path, frames
    except Exception as e:
        print(f"[SQR] ✗ 获取视频信息失败: {e}")
        return None, None


def interrupt_current(host="127.0.0.1:8188"):
    try:
        urllib.request.urlopen(
            urllib.request.Request(f"http://{host}/interrupt", data=b"", method="POST"))
    except Exception:
        pass


TRANSITION_FRAMES = 32


def merge_videos(video_paths: list, output_path: str, target_fps: float = None) -> bool:
    import subprocess, tempfile
    if not video_paths:
        return False
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt",
                                         delete=False, encoding="utf-8") as f:
            for p in video_paths:
                f.write("file " + repr(p) + "\n")
            list_path = f.name
        if target_fps and target_fps > 0:
            import tempfile as _tf
            converted = []
            fps_str = f"{target_fps:.6f}".rstrip("0").rstrip(".")
            for vp in video_paths:
                tmp = _tf.mktemp(suffix=".mp4")
                cv_cmd = ["ffmpeg", "-y", "-i", vp,
                          "-r", fps_str,
                          "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                          "-c:a", "copy",
                          tmp]
                r2 = subprocess.run(cv_cmd, capture_output=True, text=True)
                if r2.returncode == 0:
                    converted.append(tmp)
                else:
                    converted.append(vp)
            with open(list_path, "w", encoding="utf-8") as lf:
                for p in converted:
                    lf.write("file " + repr(p) + "\n")
            cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
                   "-i", list_path, "-c", "copy", output_path]
        else:
            converted = []
            cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
                   "-i", list_path, "-c", "copy", output_path]
        result = subprocess.run(cmd, capture_output=True, text=True)
        os.unlink(list_path)
        for _tmp in (converted if "converted" in dir() else []):
            try:
                if _tmp not in video_paths and os.path.exists(_tmp):
                    os.unlink(_tmp)
            except Exception:
                pass
        if result.returncode == 0:
            return True
        print(f"[SQR] ffmpeg 错误: {result.stderr[-300:]}")
        return False
    except FileNotFoundError:
        print("[SQR] ✗ 未找到 ffmpeg，请确认系统已安装 ffmpeg 并在 PATH 中")
        return False
    except Exception as e:
        print(f"[SQR] ✗ 合并异常: {e}")
        return False


class SegmentQueueRunner:
    CATEGORY = "video/utils"
    FUNCTION = "run"
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    RETURN_NAMES = ()

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "帧率": ("FLOAT", {"default": 16.0, "min": 1.0, "max": 120.0, "forceInput": True,
                    "tooltip": "视频帧率，必须连接 Load Video 的帧率输出。\nFrame rate: must connect to Load Video fps output."}),
                "总帧数": ("INT", {"default": 0, "min": 0, "max": 99999, "forceInput": True,
                    "tooltip": "参考视频总帧数，必须连接 Load Video 的 frame_count 输出。\nTotal frames: must connect to Load Video frame_count output."}),
                "分段数": ("INT", {"default": 2, "min": 2, "max": 20,
                    "tooltip": "分几段处理。\nNumber of segments."}),
                "从第几段开始": ("INT", {"default": 1, "min": 1, "max": 20,
                    "tooltip": "从第几段开始生成，续跑时填写实际起始段。\nStart from which segment. Set accordingly when resuming."}),
                "执行": ("BOOLEAN", {"default": False,
                    "tooltip": "关闭=预览分段规划；开启=正式执行。\nOff=preview plan only; On=start execution."}),
                "启用续跑": ("BOOLEAN", {"default": False,
                    "tooltip": "开启后使用上方选择的视频作为首段过渡起点。\nEnable resume: use selected video as transition source for first segment."}),
                "参考视频节点ID": ("STRING", {"default": ""}),
                "输出节点ID":     ("STRING", {"default": ""}),
                "动作嵌入节点ID": ("STRING", {"default": ""}),
                "参考图节点ID":   ("STRING", {"default": ""}),
                "分段参考图":     ("STRING", {"default": ""}),
                "续跑视频路径":   ("STRING", {"default": ""}),
                "sqr_save_png":      ("STRING", {"default": "true"}),
                "sqr_frame_offset":  ("INT",    {"default": -1}),
                "sqr_pre_segments":  ("STRING", {"default": ""}),
            },
            "hidden": {
                "过渡跳过帧数": ("INT", {"default": -1}),
                "prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "unique_id": "UNIQUE_ID",
            },
        }

    def run(self,
            总帧数, 帧率, 分段数, 从第几段开始,
            执行, 启用续跑,
            参考视频节点ID, 输出节点ID, 动作嵌入节点ID, 参考图节点ID,
            分段参考图, 续跑视频路径,
            sqr_save_png="true",
            sqr_frame_offset=-1,
            sqr_pre_segments="",
            过渡跳过帧数=-1,
            prompt=None, extra_pnginfo=None, unique_id=None):

        total_frames       = 总帧数
        segments           = 分段数
        start_from_segment = max(1, min(从第几段开始, segments))
        node_id            = 参考视频节点ID.strip()
        frame_rate         = 帧率
        combine_nid        = 输出节点ID.strip()
        ae_node_id         = 动作嵌入节点ID.strip()
        resume_video_path  = 续跑视频路径.strip()
        resume_enabled     = bool(resume_video_path)
        skip_frames_manual = 过渡跳过帧数
        ri_node_id         = 参考图节点ID.strip()
        ref_imgs_str       = 分段参考图.strip()

        _frame_offset_param = sqr_frame_offset if sqr_frame_offset >= 0 else -1
        if _frame_offset_param < 0 and prompt and unique_id:
            _self_inputs = (prompt or {}).get(str(unique_id), {}).get("inputs", {})
            _fo_val = _self_inputs.get("sqr_frame_offset", -1)
            _frame_offset_param = int(_fo_val) if _fo_val is not None and int(_fo_val) >= 0 else -1
        _frame_offset = _frame_offset_param if _frame_offset_param >= 0 else 0

        _plan_frames = max(1, total_frames - _frame_offset) if _frame_offset > 0 else total_frames
        plan_text = build_plan_text(
            _plan_frames, segments, start_from_segment, node_id, frame_rate)

        def _do_interrupt():
            try:
                from comfy import model_management as _mm
                _mm.interrupt_current_processing()
                print("[SQR] ✓ 中断标志已设置（内部API）。")
                return
            except Exception:
                pass
            try:
                interrupt_current()
                print("[SQR] ✓ 中断标志已设置（HTTP）。")
            except Exception as _e:
                print(f"[SQR] ⚠ 中断设置失败: {_e}")

        if not 执行:
            msg = "[预览模式]\n" + plan_text
            def _pi(): time.sleep(0.005); _do_interrupt()
            threading.Thread(target=_pi, daemon=True).start()
            _sqr_log(unique_id, msg)
            return {}

        if total_frames <= 0:
            _sqr_log(unique_id, "[SQR] ✗ 总帧数必须大于 0。")
            return {}
        if not node_id:
            _sqr_log(unique_id, "[SQR] ✗ 参考视频节点ID 不能为空。")
            return {}

        _sqr_full_prompt = (extra_pnginfo or {}).get("sqr_full_prompt")
        _effective_prompt = _sqr_full_prompt if _sqr_full_prompt else prompt
        _need_interrupt = (_sqr_full_prompt is None)
        _client_id = str((extra_pnginfo or {}).get("sqr_client_id") or "")

        if node_id not in (_effective_prompt or {}):
            _sqr_log(unique_id, f"[SQR] ✗ 找不到节点 ID「{node_id}」（完整工作流中）。")
            return {}

        print(f"[SQR] sqr_frame_offset: 参数={sqr_frame_offset}, 实际使用={_frame_offset}"
              f" | 工作流来源={'extra_pnginfo' if _sqr_full_prompt else 'prompt(回退)'}")
        if _frame_offset > 0:
            _remaining = max(1, total_frames - _frame_offset)
            seg_list = calc_segments(_remaining, segments)
        else:
            seg_list = calc_segments(total_frames, segments)
        start_idx   = start_from_segment - 1
        segs_to_run = seg_list[start_idx:]
        base_prompt = copy.deepcopy(_effective_prompt)

        ae_nid = ae_node_id or find_animate_embeds_node(base_prompt) or ""
        vc_nid = find_video_combine_node(base_prompt, combine_nid) or ""

        ref_images_list = [x.strip() for x in ref_imgs_str.split(",") if x.strip()] \
                          if ref_imgs_str else []

        # ── 参考图快照 ──────────────────────────────────────────────
        _snap_paths = []
        if ref_images_list:
            import shutil as _snap_shutil
            _snap_ts   = time.strftime('%Y%m%d_%H%M%S')
            _input_dir = folder_paths.get_input_directory()
            _snapped   = []
            for _orig in ref_images_list:
                _src = _orig if os.path.isabs(_orig) \
                       else os.path.join(_input_dir, _orig)
                if os.path.isfile(_src):
                    _snap_name = f"sqr_refsnap_{unique_id}_{_snap_ts}_{os.path.basename(_orig)}"
                    _snap_dst  = os.path.join(_input_dir, _snap_name)
                    if os.path.realpath(_src) != os.path.realpath(_snap_dst):
                        try:
                            _snap_shutil.copy2(_src, _snap_dst)
                            _snapped.append(_snap_dst)
                            _snap_paths.append(_snap_dst)
                        except Exception as _se:
                            print(f"[SQR] ⚠ 参考图快照失败({os.path.basename(_orig)}): {_se}")
                            _snapped.append(_orig)
                    else:
                        _snapped.append(_orig)
                else:
                    _snapped.append(_orig)
            ref_images_list = _snapped

        # ── 续跑视频处理 ──
        manual_video_path = manual_video_frames = None
        if resume_enabled and resume_video_path:
            p = resume_video_path if os.path.isabs(resume_video_path) \
                else os.path.join(folder_paths.get_input_directory(), resume_video_path)
            if os.path.isfile(p):
                try:
                    import shutil as _shutil
                    input_dir = folder_paths.get_input_directory()
                    fname = os.path.basename(p)
                    dst = os.path.join(input_dir, fname)
                    if os.path.realpath(p) != os.path.realpath(dst):
                        _shutil.copy2(p, dst)
                        print(f"[SQR] 已复制续跑视频到 input/: {fname}")
                        p = dst
                    import cv2
                    cap = cv2.VideoCapture(p)
                    if cap.isOpened():
                        manual_video_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                        cap.release()
                    manual_video_path = p
                    print(f"[SQR] ✓ 续跑视频: {fname} ({manual_video_frames}帧)")
                except Exception as e:
                    print(f"[SQR] ✗ 读取续跑视频失败: {e}")
            else:
                print(f"[SQR] ⚠ 续跑视频不存在: {p}")

        width_src = height_src = None
        target_inputs = base_prompt.get(node_id, {}).get("inputs", {})
        if "custom_width" in target_inputs and isinstance(target_inputs["custom_width"], list):
            width_src = target_inputs["custom_width"]
        if "custom_height" in target_inputs and isinstance(target_inputs["custom_height"], list):
            height_src = target_inputs["custom_height"]

        def log(msg: str):
            _sqr_log(unique_id, f"[SQR] {msg}")

        audio_filename = find_audio_filename(base_prompt, node_id)
        if audio_filename:
            _sqr_log(unique_id, f"[SQR] 音频文件: {audio_filename}")
        else:
            _sqr_log(unique_id, f"[SQR] ⚠ 无法获取音频文件名")

        image_src_node = None
        if vc_nid and vc_nid in base_prompt:
            img_input = base_prompt[vc_nid]["inputs"].get("images")
            if isinstance(img_input, list) and len(img_input) == 2:
                image_src_node = img_input
                print(f"[SQR] 图像来源: {image_src_node}")

        pre_segment_paths = [p.strip() for p in sqr_pre_segments.split(",")
                             if p.strip() and os.path.isfile(p.strip())] \
                            if sqr_pre_segments.strip() else []
        if pre_segment_paths:
            print(f"[SQR] 续跑前段素材: {len(pre_segment_paths)} 个文件")

        # ── 每次 run() 生成唯一运行ID，隔离多任务并发的文件名 ──────────
        # 场景1(多工作流)和场景2(同工作流多队列)都依赖此 run_id 避免文件冲突
        run_id = uuid.uuid4().hex[:8]

        def submit_all():
            last_video_path   = manual_video_path
            last_video_frames = manual_video_frames
            segment_output_paths = []
            # sqr_cut_paths 记录 (dir, prefix) 供清理使用，避免依赖文件名正则
            sqr_cut_cleanup = []   # list of (search_dir, prefix_str)
            sqr_cut_paths   = []   # 仅用于合并
            _t0 = time.time()
            _total_frames_ran = sum(limit for _, limit in segs_to_run)
            _all_done = False

            # 日志分隔符：同一节点(uid)多次队列时区分不同任务
            log(f"{'═'*20} 运行ID={run_id} {'═'*20}")
            log(f"AnimateEmbeds节点: [{ae_nid}]")
            log(f"输出节点: [{vc_nid}]")
            if ref_images_list:
                log(f"参考图列表: {ref_images_list}")
            if _frame_offset > 0:
                log(f"=== 重新设计续跑模式（帧偏移={_frame_offset}，跳过前{_frame_offset}帧参考视频）===")
            elif resume_enabled:
                log(f"=== 自动续跑模式 ===")
            else:
                log(f"=== 全新生成 ===")
            if resume_enabled:
                if manual_video_path:
                    log(f"✓ 续跑视频: {os.path.basename(manual_video_path)} ({manual_video_frames}帧)")
                else:
                    log(f"⚠ 续跑已启用但视频无效，首段无过渡")

            for i, (skip, limit) in enumerate(segs_to_run):
                seg_num        = start_idx + i + 1
                total_segs     = len(seg_list)
                use_transition = last_video_path is not None
                wf             = copy.deepcopy(base_prompt)
                TRIM           = 16
                audio_skip_frames = skip

                _actual_skip = skip + _frame_offset
                if _frame_offset > 0:
                    log(f"--- 第{seg_num}/{total_segs}段  实际skip={_actual_skip}（段内{skip}+偏移{_frame_offset}）limit={limit} ---")
                else:
                    log(f"--- 第{seg_num}/{total_segs}段  skip={_actual_skip}  limit={limit} ---")

                wf[node_id]["inputs"]["skip_first_frames"] = _actual_skip
                wf[node_id]["inputs"]["frame_load_cap"]    = limit

                # ── 音频对齐 ──
                if vc_nid and vc_nid in wf and audio_filename:
                    _real_skip = skip + _frame_offset
                    if use_transition:
                        audio_skip_frames    = max(0, _real_skip - TRIM)
                        main_audio_frames    = max(0, _real_skip - TRANSITION_FRAMES)
                        transition_note      = f"主节点skip{_real_skip}-32={main_audio_frames}帧, cut_vc skip{_real_skip}-16={audio_skip_frames}帧"
                    else:
                        audio_skip_frames    = _real_skip
                        main_audio_frames    = _real_skip
                        transition_note      = f"{_real_skip}帧"
                    audio_start_time  = main_audio_frames / frame_rate
                    audio_tmp_id      = f"sqr_audio_{seg_num}"
                    wf[audio_tmp_id] = {
                        "class_type": "VHS_LoadAudioUpload",
                        "inputs": {
                            "audio":      audio_filename,
                            "start_time": audio_start_time,
                            "duration":   0,
                        }
                    }
                    wf[vc_nid]["inputs"]["audio"] = [audio_tmp_id, 0]
                    log(f"  ✓ 主节点音频: start={audio_start_time:.3f}s ({transition_note})")
                elif vc_nid and vc_nid in wf:
                    wf[vc_nid]["inputs"]["audio"] = [node_id, 2]
                    log(f"  ⚠ 音频: 无法获取文件名，直接用LoadVideo音频(skip={skip}帧)")

                # ── transition_video 注入 AnimateEmbeds ──
                if ae_nid and ae_nid in wf:
                    if use_transition:
                        t_skip = skip_frames_manual if skip_frames_manual >= 0 \
                                 else (max(0, last_video_frames - TRANSITION_FRAMES) if last_video_frames else 0)
                        tv_tmp_id = f"sqr_tv_{seg_num}"
                        tv_inputs = {
                            "video":             os.path.basename(last_video_path),
                            "force_rate":        0,
                            "custom_width":      0,
                            "custom_height":     0,
                            "frame_load_cap":    TRANSITION_FRAMES,
                            "skip_first_frames": t_skip,
                            "select_every_nth":  1,
                            "format":            "AnimateDiff",
                        }
                        if width_src:
                            tv_inputs["custom_width"]  = width_src
                        if height_src:
                            tv_inputs["custom_height"] = height_src
                        wf[tv_tmp_id] = {"class_type": "VHS_LoadVideo", "inputs": tv_inputs}
                        wf[ae_nid]["inputs"]["transition_video"] = [tv_tmp_id, 0]
                        log(f"  ✓ 过渡视频: {os.path.basename(last_video_path)} skip={t_skip} limit={TRANSITION_FRAMES}")
                    else:
                        wf[ae_nid]["inputs"].pop("transition_video", None)
                        log(f"  首段无过渡")

                # ── 分段切换参考图 ──
                if ref_images_list and ri_node_id and ri_node_id in wf:
                    img_idx   = min(i, len(ref_images_list) - 1)
                    img_entry = ref_images_list[img_idx]
                    if os.path.isabs(img_entry):
                        import shutil as _shutil
                        input_dir = folder_paths.get_input_directory()
                        src_real  = os.path.realpath(img_entry)
                        if os.path.realpath(os.path.dirname(src_real)) == os.path.realpath(input_dir):
                            img_name = os.path.basename(src_real)
                        else:
                            img_fname = _build_safe_input_copy_name(src_real, unique_id=unique_id, prefix="sqr_refrun")
                            img_dst   = os.path.join(input_dir, img_fname)
                            try:
                                _shutil.copy2(src_real, img_dst)
                            except Exception as e:
                                log(f"  ⚠ 参考图复制失败: {e}")
                            img_name = img_fname
                    else:
                        img_name = img_entry
                    wf[ri_node_id]["inputs"]["image"] = img_name
                    wv = wf[ri_node_id].get("widgets_values", [])
                    if wv: wv[0] = img_name
                    log(f"  ✓ 参考图[{img_idx+1}]: {img_name}")

                # ── 自动裁切 ──
                TRIM = 16
                is_last_seg = (seg_num == total_segs)
                total_raw = limit + (TRANSITION_FRAMES if use_transition else 0)

                image_src = image_src_node
                if not use_transition:
                    trim_start = 0
                    trim_len   = total_raw - TRIM
                    ifb_a = f"sqr_ifb_{seg_num}_a"
                    wf[ifb_a] = {"class_type": "ImageFromBatch",
                                 "inputs": {"image": image_src, "batch_index": trim_start, "length": trim_len}}
                    final_image_node = ifb_a
                    log(f"  裁切：不裁前，裁后{TRIM}帧→输出{trim_len}帧")
                elif is_last_seg:
                    trim_start = TRIM
                    trim_len   = total_raw - TRIM
                    ifb_a = f"sqr_ifb_{seg_num}_a"
                    wf[ifb_a] = {"class_type": "ImageFromBatch",
                                 "inputs": {"image": image_src, "batch_index": trim_start, "length": trim_len}}
                    final_image_node = ifb_a
                    log(f"  裁切：裁前{TRIM}帧，不裁后→输出{trim_len}帧")
                else:
                    trim_start  = TRIM
                    after_front = total_raw - TRIM
                    trim_len    = after_front - TRIM
                    ifb_a = f"sqr_ifb_{seg_num}_a"
                    ifb_b = f"sqr_ifb_{seg_num}_b"
                    wf[ifb_a] = {"class_type": "ImageFromBatch",
                                 "inputs": {"image": image_src, "batch_index": trim_start, "length": after_front}}
                    wf[ifb_b] = {"class_type": "ImageFromBatch",
                                 "inputs": {"image": [ifb_a, 0], "batch_index": 0, "length": trim_len}}
                    final_image_node = ifb_b
                    log(f"  裁切：裁前{TRIM}裁后{TRIM}→输出{trim_len}帧")

                # ── VHS_VideoCombine 双路输出 ──
                if vc_nid and vc_nid in wf:
                    wf[vc_nid]["inputs"]["images"] = image_src

                    cut_vc_id = f"sqr_cut_vc_{seg_num}"
                    cut_inputs = copy.deepcopy(wf[vc_nid]["inputs"])
                    cut_inputs["images"]          = [final_image_node, 0]
                    cut_inputs["save_output"]     = True
                    cut_inputs["save_metadata"]   = False
                    _main_prefix = wf[vc_nid]["inputs"].get("filename_prefix", "")
                    _slash = max(_main_prefix.rfind("/"), _main_prefix.rfind("\\"))
                    _subfolder_prefix = _main_prefix[:_slash+1] if _slash >= 0 else ""
                    # ── 使用 run_id 隔离：不同任务的裁切文件不会同名覆盖 ──
                    _cut_file_prefix = f"sqr_cut_{run_id[:6]}_{seg_num}_"
                    cut_inputs["filename_prefix"] = f"{_subfolder_prefix}{_cut_file_prefix}"

                    if audio_filename:
                        cut_audio_id = f"sqr_cut_audio_{seg_num}"
                        wf[cut_audio_id] = {
                            "class_type": "VHS_LoadAudioUpload",
                            "inputs": {
                                "audio":      audio_filename,
                                "start_time": audio_skip_frames / frame_rate,
                                "duration":   0,
                            }
                        }
                        cut_inputs["audio"] = [cut_audio_id, 0]
                        log(f"  ✓ cut_vc音频: start={audio_skip_frames/frame_rate:.3f}s (={audio_skip_frames}帧)")

                    wf[cut_vc_id] = {"class_type": "VHS_VideoCombine", "inputs": cut_inputs}
                    # 记录清理信息（目录+前缀），不依赖后续文件名解析
                    _cut_search_dir = os.path.join(folder_paths.get_output_directory(),
                                                   _subfolder_prefix.rstrip("/\\")) \
                                      if _subfolder_prefix else folder_paths.get_output_directory()
                    sqr_cut_cleanup.append((_cut_search_dir, _cut_file_prefix))

                if unique_id and unique_id in wf:
                    del wf[unique_id]

                log(f"  → 提交中...")
                try:
                    pid = queue_prompt(wf, client_id=_client_id)
                    log(f"  prompt_id={pid[:8]}...")
                    ok  = wait_for_prompt(pid)
                    if ok:
                        log(f"✓ 第{seg_num}段完成")
                        if is_last_seg:
                            _all_done = True
                        if unique_id:
                            _lv_inputs = base_prompt.get(node_id, {}).get("inputs", {})
                            _ref_video_params = {
                                "video":             _lv_inputs.get("video", ""),
                                "force_rate":        _lv_inputs.get("force_rate", 0),
                                "frame_load_cap":    _lv_inputs.get("frame_load_cap", 0),
                                "skip_first_frames": _lv_inputs.get("skip_first_frames", 0),
                                "select_every_nth":  _lv_inputs.get("select_every_nth", 1),
                            }
                            _next_seg_idx = seg_num
                            if _next_seg_idx < len(seg_list):
                                _frame_offset_for_resume = _frame_offset + seg_list[_next_seg_idx][0]
                            else:
                                _frame_offset_for_resume = _frame_offset + (skip + limit)
                            # ── transition_video 用 run_id 命名，续跑检测时能找到正确文件 ──
                            _trans_fname = f"sqr_trans_{run_id}_seg{seg_num}.mp4"
                            write_checkpoint(unique_id, {
                                "unique_id":              unique_id,
                                "run_id":                 run_id,
                                "completed_seg":          seg_num,
                                "total_segs":             total_segs,
                                "next_seg":               seg_num + 1,
                                "transition_video":       _trans_fname,
                                "ref_images":             ref_images_list,
                                "segments":               segments,
                                "ref_video":              _ref_video_params.get("video", ""),
                                "ref_video_params":       _ref_video_params,
                                "timestamp":              time.strftime("%Y-%m-%d %H:%M:%S"),
                                "base_frame_offset":      _frame_offset,
                                "frame_offset_for_resume": _frame_offset_for_resume,
                            })
                        _elapsed = time.time() - _t0
                        _frames_done = sum(lmt for _, lmt in segs_to_run[:i+1])
                        save_speed_record(_elapsed, _frames_done)

                        cut_vc_id_done = f"sqr_cut_vc_{seg_num}"
                        if vc_nid:
                            cut_vpath, _ = get_output_video_info(pid, cut_vc_id_done)
                            if not cut_vpath:
                                cut_vpath, _ = get_output_video_info(pid, vc_nid)
                            if cut_vpath:
                                segment_output_paths.append(cut_vpath)
                                sqr_cut_paths.append(cut_vpath)
                                log(f"  ✓ 裁切输出: {os.path.basename(cut_vpath)}")
                            else:
                                log(f"  ⚠ 未找到裁切输出视频")

                        # 取完整视频复制为过渡素材，文件名含 run_id，多任务不冲突
                        vpath, vframes = get_output_video_info(pid, vc_nid) if vc_nid else (None, None)
                        if not vpath:
                            log(f"  ⚠ 完整视频获取失败，下段过渡将跳过")
                        if vpath:
                            import shutil
                            input_dir   = folder_paths.get_input_directory()
                            # ── 关键修复：用 run_id 隔离过渡文件，多任务不会互相覆盖 ──
                            input_fname = f"sqr_trans_{run_id}_seg{seg_num}.mp4"
                            input_path  = os.path.join(input_dir, input_fname)
                            try:
                                shutil.copy2(vpath, input_path)
                                last_video_path   = input_path
                                last_video_frames = vframes
                                log(f"  ✓ 已复制: {input_fname} ({vframes}帧，完整未裁切)")
                            except Exception as e:
                                log(f"  ✗ 复制失败: {e}")
                                last_video_path = last_video_frames = None
                        else:
                            log(f"  ⚠ 未找到完整视频，下段过渡将跳过")
                            last_video_path = last_video_frames = None
                    else:
                        log(f"✗ 第{seg_num}段出错，终止。")
                        break
                except Exception as e:
                    log(f"✗ 提交失败：{e}")
                    break

            # ── 合并所有段输出视频 ──
            if pre_segment_paths:
                log(f"续跑合并：前段 {len(pre_segment_paths)} 个 + 本次 {len(segment_output_paths)} 个")
                segment_output_paths = pre_segment_paths + segment_output_paths

            if len(segment_output_paths) >= 2:
                log(f"开始合并 {len(segment_output_paths)} 段视频...")
                output_dir   = folder_paths.get_output_directory()
                if vc_nid and base_prompt and vc_nid in base_prompt:
                    _mp = base_prompt[vc_nid]["inputs"].get("filename_prefix", "")
                    _sl = max(_mp.rfind("/"), _mp.rfind("\\"))
                    _sub = _mp[:_sl+1] if _sl >= 0 else ""
                    if _sub:
                        os.makedirs(os.path.join(output_dir, _sub.rstrip("/\\")), exist_ok=True)
                else:
                    _sub = ""
                # 合并文件名含 run_id，多任务并发时不冲突
                merged_fname = f"sqr_merged_{run_id}_{time.strftime('%Y%m%d_%H%M%S')}_.mp4"
                merged_path  = os.path.join(output_dir, _sub + merged_fname)
                if merge_videos(segment_output_paths, merged_path,
                               target_fps=frame_rate if pre_segment_paths else None):
                    log(f"✓ 合并完成: {_sub + merged_fname}")
                else:
                    log(f"✗ 合并失败，请手动拼接各段视频")
            elif len(segment_output_paths) == 1:
                log(f"只有1段，无需合并")

            # ── 清理临时裁切文件（使用记录的 dir+prefix，无需正则解析文件名）──
            for (_clean_dir, _clean_prefix) in sqr_cut_cleanup:
                try:
                    if not os.path.isdir(_clean_dir):
                        continue
                    for _f in os.listdir(_clean_dir):
                        if not _f.startswith(_clean_prefix):
                            continue
                        _fpath = os.path.join(_clean_dir, _f)
                        # 保留带 -audio 的 mp4
                        if _f.endswith(".mp4") and "-audio" in _f:
                            continue
                        if _f.endswith(".mp4") or _f.endswith(".png"):
                            try:
                                os.remove(_fpath)
                                print(f"[SQR] 已清理临时文件: {_f}")
                            except Exception:
                                pass
                except Exception:
                    pass

            # 清理主节点 png
            _sqr_save_png = (str(sqr_save_png).lower() != "false")
            _should_clean_main_png = not _sqr_save_png
            print(f"[SQR] Save png 设置: {sqr_save_png} → {'保留' if _sqr_save_png else '清理'}主节点 png")

            if _should_clean_main_png and vc_nid and base_prompt and vc_nid in base_prompt:
                try:
                    _main_prefix = base_prompt[vc_nid]["inputs"].get("filename_prefix", "")
                    _output_root = folder_paths.get_output_directory()
                    _sl = max(_main_prefix.rfind("/"), _main_prefix.rfind("\\"))
                    _sub = _main_prefix[:_sl+1] if _sl >= 0 else ""
                    _fname_prefix = _main_prefix[_sl+1:] if _sl >= 0 else _main_prefix
                    _search_dir = os.path.join(_output_root, _sub.rstrip("/\\")) if _sub else _output_root
                    if os.path.isdir(_search_dir) and _fname_prefix:
                        for _f in os.listdir(_search_dir):
                            if _f.startswith(_fname_prefix) and _f.endswith(".png"):
                                try:
                                    os.remove(os.path.join(_search_dir, _f))
                                    print(f"[SQR] 已清理主节点元数据图: {_f}")
                                except Exception:
                                    pass
                except Exception:
                    pass

            if unique_id:
                if _all_done:
                    clear_checkpoint(unique_id)
                    print("[SQR] checkpoint 已清除（全部完成）")
                else:
                    print("[SQR] 任务中断，checkpoint 保留供续跑检测")

            for _sp in _snap_paths:
                try:
                    if os.path.exists(_sp):
                        os.remove(_sp)
                        print(f"[SQR] 已清理参考图快照: {os.path.basename(_sp)}")
                except Exception:
                    pass

            log("═══ 全部完成 ═══")

        # 清除旧 checkpoint（本次重新开始）
        if unique_id:
            clear_checkpoint(unique_id)

        if _frame_offset > 0:
            _mode_header = f"=== 重新设计续跑模式（帧偏移={_frame_offset}，跳过前{_frame_offset}帧）==="
        elif resume_enabled:
            _mode_header = "=== 自动续跑模式 ==="
        else:
            _mode_header = "=== 全新生成 ==="
        exec_msg = _mode_header + "\n" + plan_text

        t = threading.Thread(target=submit_all, daemon=True)
        t.start()
        if _need_interrupt:
            def _ei(): time.sleep(0.005); _do_interrupt()
            threading.Thread(target=_ei, daemon=True).start()
        _sqr_log(unique_id, exec_msg)
        return {}


NODE_CLASS_MAPPINGS        = {"SegmentQueueRunner": SegmentQueueRunner}
NODE_DISPLAY_NAME_MAPPINGS = {"SegmentQueueRunner": "分段队列 🎬 @肥猴🐵 @雪子❄️ "}


# ── 后端 API ─────────────────────────────────────────────────────
@server.PromptServer.instance.routes.get("/sqr/logs")
async def sqr_get_logs(request):
    uid = request.rel_url.query.get("uid", "")
    return web.json_response({"logs": list(_sqr_log_buf.get(str(uid), []))})

@server.PromptServer.instance.routes.post("/sqr/logs/clear")
async def sqr_clear_logs(request):
    _sqr_log_clear(request.rel_url.query.get("uid", ""))
    return web.json_response({"ok": True})

@server.PromptServer.instance.routes.get("/sqr/checkpoint")
async def sqr_get_checkpoint(request):
    uid = request.rel_url.query.get("uid", "")
    if not uid:
        return web.json_response({"checkpoint": None})
    ckpt = read_checkpoint(uid)
    if ckpt:
        input_dir = folder_paths.get_input_directory()
        tv = ckpt.get("transition_video", "")
        tv_path = os.path.join(input_dir, tv) if tv else ""
        ckpt["transition_exists"] = os.path.isfile(tv_path)
        if ckpt["transition_exists"] and tv_path:
            tv_mtime   = os.path.getmtime(tv_path)
            ckpt_mtime = os.path.getmtime(get_checkpoint_path(uid))
            if tv_mtime > ckpt_mtime + 60:
                ckpt["transition_exists"] = False
        import urllib.parse as _up
        cur_params_str = request.rel_url.query.get("ref_params", "")
        ckpt_params    = ckpt.get("ref_video_params", {})
        if not ckpt_params and ckpt.get("ref_video"):
            ckpt_params = {"video": ckpt.get("ref_video")}
        if cur_params_str and ckpt_params:
            try:
                import json as _json
                cur_params = _json.loads(_up.unquote(cur_params_str))
                mismatches = []
                for key in ("video", "force_rate", "frame_load_cap", "skip_first_frames", "select_every_nth"):
                    cv = cur_params.get(key, None)
                    kv = ckpt_params.get(key, None)
                    if key == "video":
                        if str(cv or "") != str(kv or ""):
                            mismatches.append(key)
                    else:
                        try:
                            if float(cv or 0) != float(kv or 0):
                                mismatches.append(key)
                        except (TypeError, ValueError):
                            if str(cv) != str(kv):
                                mismatches.append(key)
                ckpt["ref_video_match"]    = len(mismatches) == 0
                ckpt["ref_video_mismatches"] = mismatches
            except Exception:
                ckpt["ref_video_match"] = True
        else:
            ckpt["ref_video_match"]    = True
            ckpt["ref_video_mismatches"] = []
    return web.json_response({"checkpoint": ckpt})


@server.PromptServer.instance.routes.get("/sqr/pick_images")
async def sqr_pick_images(request):
    import threading
    result = {"paths": [], "error": ""}
    done = threading.Event()
    def _pick():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            paths = filedialog.askopenfilenames(
                title="选择参考图（可多选）",
                filetypes=[("图片文件", "*.png *.jpg *.jpeg *.webp *.bmp"), ("所有文件", "*.*")]
            )
            root.destroy()
            result["paths"] = list(paths)
        except Exception as e:
            result["error"] = str(e)
        finally:
            done.set()
    t = threading.Thread(target=_pick, daemon=True)
    t.start()
    done.wait(timeout=120)
    return web.json_response(result)


@server.PromptServer.instance.routes.get("/sqr/pick_video")
async def sqr_pick_video(request):
    import threading
    result = {"path": "", "error": ""}
    done = threading.Event()
    def _pick():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            path = filedialog.askopenfilename(
                title="选择续跑视频",
                filetypes=[("视频文件", "*.mp4 *.mov *.avi *.mkv *.webm"), ("所有文件", "*.*")]
            )
            root.destroy()
            result["path"] = path or ""
        except Exception as e:
            result["error"] = str(e)
        finally:
            done.set()
    t = threading.Thread(target=_pick, daemon=True)
    t.start()
    done.wait(timeout=120)
    return web.json_response(result)


@server.PromptServer.instance.routes.get("/sqr/list_images")
async def sqr_list_images(request):
    import re
    img_exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    def nat_key(s):
        return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]
    try:
        files = sorted([f for f in os.listdir(folder_paths.get_input_directory())
                        if os.path.splitext(f)[1].lower() in img_exts], key=nat_key)
    except Exception:
        files = []
    return web.json_response({"images": files})


@server.PromptServer.instance.routes.get("/sqr/browse")
async def sqr_browse(request):
    import re
    img_exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

    def nat_key(s):
        return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]

    req_path = request.rel_url.query.get("path", "").strip()

    import platform, string as _str

    if req_path == "__drives__":
        drives = []
        if platform.system() == "Windows":
            for d in _str.ascii_uppercase:
                dp = d + ":\\"
                if os.path.exists(dp):
                    drives.append({"label": dp, "path": dp, "is_drive": True})
        else:
            drives.append({"label": "/", "path": "/", "is_drive": True})
        return web.json_response({"type": "roots", "roots": drives})

    if not req_path:
        starts = []
        for label, p in [("ComfyUI input", folder_paths.get_input_directory()),
                         ("ComfyUI output", folder_paths.get_output_directory())]:
            if os.path.isdir(p):
                starts.append({"label": label, "path": p})
        starts.append({"label": "此电脑", "path": "__drives__", "is_virtual": True})
        home = os.path.expanduser("~")
        for sub in ["Desktop", "桌面", "Pictures", "图片", "Downloads", "下载"]:
            p = os.path.join(home, sub)
            if os.path.isdir(p):
                starts.append({"label": sub, "path": p})
        return web.json_response({"type": "roots", "roots": starts})

    req_path = os.path.realpath(req_path)
    if not os.path.isdir(req_path):
        return web.json_response({"error": "路径不存在"}, status=400)

    try:
        entries = os.listdir(req_path)
    except PermissionError:
        return web.json_response({"error": "无权限访问"}, status=403)

    folders = sorted([e for e in entries
                      if os.path.isdir(os.path.join(req_path, e))
                      and not e.startswith(".")], key=nat_key)
    images  = sorted([e for e in entries
                      if os.path.splitext(e)[1].lower() in img_exts], key=nat_key)

    parent = os.path.dirname(req_path) if req_path != os.path.dirname(req_path) else None

    return web.json_response({
        "type":    "dir",
        "path":    req_path,
        "parent":  parent,
        "folders": folders,
        "images":  images,
    })


@server.PromptServer.instance.routes.get("/sqr/list_videos")
async def sqr_list_videos(request):
    import re
    vid_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
    def sort_key(fname):
        # 新命名格式 sqr_trans_{run_id}_seg{N}.mp4 排最前，按段号排序
        m = re.match(r"sqr_trans_[a-f0-9]+_seg(\d+)\.mp4$", fname, re.IGNORECASE)
        if m:
            return (0, int(m.group(1)), fname)
        # 兼容旧命名格式 segment_transition_seg{N}.mp4
        m = re.match(r"segment_transition_seg(\d+)\.mp4$", fname, re.IGNORECASE)
        if m:
            return (0, int(m.group(1)), fname)
        parts = re.split(r"(\d+)", fname)
        return (1, 0, tuple(int(p) if p.isdigit() else p.lower() for p in parts))
    try:
        files = sorted(
            [f for f in os.listdir(folder_paths.get_input_directory())
             if os.path.splitext(f)[1].lower() in vid_exts],
            key=sort_key
        )
    except Exception:
        files = []
    return web.json_response({"videos": files})


@server.PromptServer.instance.routes.get("/sqr/video_thumb")
async def sqr_video_thumb(request):
    import base64, io
    fpath = request.rel_url.query.get("file", "").strip()
    if not fpath:
        return web.Response(status=400)
    if not os.path.isabs(fpath):
        for d in [folder_paths.get_input_directory(), folder_paths.get_output_directory()]:
            p = os.path.join(d, fpath)
            if os.path.isfile(p):
                fpath = p
                break
    if not os.path.isfile(fpath):
        return web.Response(status=404)
    try:
        import cv2
        cap = cv2.VideoCapture(fpath)
        ok, frame = cap.read()
        cap.release()
        if not ok:
            return web.Response(status=404)
        h, w = frame.shape[:2]
        new_w = 160
        new_h = int(h * new_w / w)
        frame = cv2.resize(frame, (new_w, new_h))
        ok2, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        if not ok2:
            return web.Response(status=500)
        b64 = base64.b64encode(buf.tobytes()).decode()
        return web.Response(body=buf.tobytes(), content_type="image/jpeg")
    except Exception as e:
        return web.Response(status=500)


@server.PromptServer.instance.routes.get("/sqr/browse_videos")
async def sqr_browse_videos(request):
    import re
    vid_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm"}

    def nat_key(s):
        return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]

    def sort_key(fname):
        m = re.match(r"sqr_trans_[a-f0-9]+_seg(\d+)\.mp4$", fname, re.IGNORECASE)
        if m:
            return (0, int(m.group(1)), fname)
        m = re.match(r"segment_transition_seg(\d+)\.mp4$", fname, re.IGNORECASE)
        if m:
            return (0, int(m.group(1)), fname)
        parts = re.split(r"(\d+)", fname)
        return (1, 0, tuple(int(p) if p.isdigit() else p.lower() for p in parts))

    req_path = request.rel_url.query.get("path", "").strip()

    import platform, string as _str

    if req_path == "__drives__":
        drives = []
        if platform.system() == "Windows":
            for d in _str.ascii_uppercase:
                dp = d + ":\\"
                if os.path.exists(dp):
                    drives.append({"label": dp, "path": dp, "is_drive": True})
        else:
            drives.append({"label": "/", "path": "/", "is_drive": True})
        return web.json_response({"type": "roots", "roots": drives})

    if not req_path:
        starts = []
        for label, p in [("ComfyUI input", folder_paths.get_input_directory()),
                         ("ComfyUI output", folder_paths.get_output_directory())]:
            if os.path.isdir(p):
                starts.append({"label": label, "path": p})
        starts.append({"label": "此电脑", "path": "__drives__", "is_virtual": True})
        home = os.path.expanduser("~")
        for sub in ["Desktop", "桌面", "Videos", "视频", "Downloads", "下载"]:
            p = os.path.join(home, sub)
            if os.path.isdir(p):
                starts.append({"label": sub, "path": p})
        return web.json_response({"type": "roots", "roots": starts})

    req_path = os.path.realpath(req_path)
    if not os.path.isdir(req_path):
        return web.json_response({"error": "路径不存在"}, status=400)

    try:
        entries = os.listdir(req_path)
    except PermissionError:
        return web.json_response({"error": "无权限访问"}, status=403)

    folders = sorted([e for e in entries
                      if os.path.isdir(os.path.join(req_path, e))
                      and not e.startswith(".")], key=nat_key)
    videos  = sorted([e for e in entries
                      if os.path.splitext(e)[1].lower() in vid_exts], key=sort_key)
    parent  = os.path.dirname(req_path) if req_path != os.path.dirname(req_path) else None

    return web.json_response({
        "type":    "dir",
        "path":    req_path,
        "parent":  parent,
        "folders": folders,
        "videos":  videos,
    })


@server.PromptServer.instance.routes.get("/sqr/image_thumb")
async def sqr_image_thumb(request):
    fname = request.rel_url.query.get("file", "")
    if not fname:
        return web.Response(status=400)
    if os.path.isabs(fname):
        path = os.path.realpath(fname)
    else:
        path = os.path.join(folder_paths.get_input_directory(), fname)
    if not os.path.isfile(path):
        return web.Response(status=404)
    return web.FileResponse(path, headers={
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    })
