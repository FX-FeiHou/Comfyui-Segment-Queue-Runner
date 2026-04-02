"""
ComfyUI 分段自动队列节点 - 最终版
"""

import math, copy, json, time, os, threading, urllib.request
import server, folder_paths
from aiohttp import web

# ── 日志缓冲（前端弹窗读取）──────────────────────────────────────
_sqr_log_buf: dict = {}

def _sqr_log(uid, msg):
    text = "" if msg is None else str(msg)

    # 控制台仍然按原样输出，方便调试
    print(text)

    if not uid:
        return

    k = str(uid)
    buf = _sqr_log_buf.setdefault(k, [])

    # 按行写入缓冲，避免整段多行日志在前端变成一条
    lines = text.splitlines()

    # splitlines() 对空字符串会返回 []，这里补成一条空行
    if not lines:
        lines = [""]

    buf.extend(lines)

    # 如果原文本以换行结尾，补一个空行，保留视觉间隔
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
    # 预计时长
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
    """找主输出 VHS_VideoCombine 节点"""
    nid = combine_node_id.strip()
    if nid and nid in prompt:
        return nid
    # 自动找 save_output=True 的 VHS_VideoCombine
    for nid, node in prompt.items():
        if node.get("class_type") == "VHS_VideoCombine":
            inputs = node.get("inputs", {})
            if inputs.get("save_output") is True:
                return nid
    return None


def find_audio_filename(prompt: dict, node_id: str) -> str | None:
    """从 target LoadVideo 节点取视频文件名，用于创建临时音频节点"""
    node = prompt.get(node_id, {})
    inputs = node.get("inputs", {})
    # widgets_values 里的 video 字段
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
    """用 ffmpeg concat demuxer 拼接多个视频。
    target_fps: 指定时对所有视频重新编码为统一帧率（续跑时前段帧率可能不同）。
    """
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
            # 先把每个视频转换为目标帧率的临时文件，再 concat
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
                    # 转换失败，用原文件
                    converted.append(vp)
            # 重写 list_path 用转换后的文件
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
        # 清理临时转换文件
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
        # 永远不缓存：每次点运行按钮都强制重新执行节点
        return float("nan")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 顺序：节点ID按钮占位、总帧数、帧率、分段数、从第几段、参考图按钮占位、执行、续跑按钮占位、启用续跑
                # 节点 ID 字段（由 JS 按钮填入，用户不直接编辑）


                # 主要参数
                "帧率": ("FLOAT", {"default": 16.0, "min": 1.0, "max": 120.0, "forceInput": True,
                    "tooltip": "视频帧率，必须连接 Load Video 的帧率输出。\nFrame rate: must connect to Load Video fps output."}),
                "总帧数": ("INT", {"default": 0, "min": 0, "max": 99999, "forceInput": True,
                    "tooltip": "参考视频总帧数，必须连接 Load Video 的 frame_count 输出。\nTotal frames: must connect to Load Video frame_count output."}),
                "分段数": ("INT", {"default": 2, "min": 2, "max": 20,
                    "tooltip": "分几段处理。\nNumber of segments."}),
                "从第几段开始": ("INT", {"default": 1, "min": 1, "max": 20,
                    "tooltip": "从第几段开始生成，续跑时填写实际起始段。\nStart from which segment. Set accordingly when resuming."}),

                # 执行
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
                "sqr_save_png":      ("STRING", {"default": "true"}),  # 由 JS 设置控制
                "sqr_frame_offset":  ("INT",    {"default": -1}),       # 情形B续跑帧偏移
                "sqr_pre_segments":  ("STRING", {"default": ""}),       # 续跑前段素材路径，逗号分隔
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

        # 兼容别名
        total_frames       = 总帧数
        segments           = 分段数
        start_from_segment = max(1, min(从第几段开始, segments))
        node_id            = 参考视频节点ID.strip()
        frame_rate         = 帧率
        combine_nid        = 输出节点ID.strip()
        ae_node_id         = 动作嵌入节点ID.strip()
        resume_video_path  = 续跑视频路径.strip()
        resume_enabled     = bool(resume_video_path)  # 有路径即为续跑模式
        skip_frames_manual = 过渡跳过帧数
        ri_node_id         = 参考图节点ID.strip()
        ref_imgs_str       = 分段参考图.strip()


        # ── 提前计算帧偏移（重新设计续跑模式需要用它修正 plan_text）──
        # 双重读取：优先从参数注入，备用从 prompt 里直接读（防止序列化跳过）
        _frame_offset_param = sqr_frame_offset if sqr_frame_offset >= 0 else -1
        if _frame_offset_param < 0 and prompt and unique_id:
            _self_inputs = (prompt or {}).get(str(unique_id), {}).get("inputs", {})
            _fo_val = _self_inputs.get("sqr_frame_offset", -1)
            _frame_offset_param = int(_fo_val) if _fo_val is not None and int(_fo_val) >= 0 else -1
        _frame_offset = _frame_offset_param if _frame_offset_param >= 0 else 0

        # plan_text 使用与实际执行一致的帧数（重新设计续跑时为剩余帧数）
        _plan_frames = max(1, total_frames - _frame_offset) if _frame_offset > 0 else total_frames
        plan_text = build_plan_text(
            _plan_frames, segments, start_from_segment, node_id, frame_rate)

        def _do_interrupt():
            """优先用 ComfyUI 内部 API 直接设置中断标志（同步、无 HTTP 开销）。"""
            try:
                from comfy import model_management as _mm
                _mm.interrupt_current_processing()
                print("[SQR] ✓ 中断标志已设置（内部API）。")
                return
            except Exception:
                pass
            try:
                # 回退：HTTP interrupt
                interrupt_current()
                print("[SQR] ✓ 中断标志已设置（HTTP）。")
            except Exception as _e:
                print(f"[SQR] ⚠ 中断设置失败: {_e}")

        if not 执行:
            msg = "[预览模式]\n" + plan_text
            # 5ms 后中断：足够 ShowText 显示计划文本（< 1ms），早于 SDPose 启动（> 100ms）
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

        # JS 端精简提交时，完整工作流通过 extra_pnginfo.sqr_full_prompt 传入
        # 若存在则用完整版构建分段 wf，否则回退到当前 prompt（含中断保底）
        _sqr_full_prompt = (extra_pnginfo or {}).get("sqr_full_prompt")
        _effective_prompt = _sqr_full_prompt if _sqr_full_prompt else prompt
        # 精简提交时 SDPose 根本不在队列里，无需中断；回退时保留中断保底
        _need_interrupt = (_sqr_full_prompt is None)
        # 前端 client_id：分段 prompt 带上它，采样预览和节点缩略图才能正确路由到浏览器
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

        # 找 AnimateEmbeds
        ae_nid = ae_node_id or find_animate_embeds_node(base_prompt) or ""

        # 找主输出 VHS_VideoCombine
        vc_nid = find_video_combine_node(base_prompt, combine_nid) or ""

        # 解析参考图
        ref_images_list = [x.strip() for x in ref_imgs_str.split(",") if x.strip()] \
                          if ref_imgs_str else []

        # 续跑视频：如果是外部路径则复制到 input/ 目录再使用（和参考图处理方式一致）
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
                    # 只有不在 input/ 目录时才复制
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

        # 从 target LoadVideo 的 inputs 里取宽高来源（连线 [src_node, slot]）
        # 供动态创建的 transition LoadVideo 使用，确保宽高与用户设置同步
        width_src = height_src = None
        target_inputs = base_prompt.get(node_id, {}).get("inputs", {})
        if "custom_width" in target_inputs and isinstance(target_inputs["custom_width"], list):
            width_src = target_inputs["custom_width"]   # [get_node_id, slot]
        if "custom_height" in target_inputs and isinstance(target_inputs["custom_height"], list):
            height_src = target_inputs["custom_height"]

        def log(msg: str):
            _sqr_log(unique_id, f"[SQR] {msg}")

        # 从 target LoadVideo 取视频文件名（用于创建临时音频节点）
        audio_filename = find_audio_filename(base_prompt, node_id)
        if audio_filename:
            _sqr_log(unique_id, f"[SQR] 音频文件: {audio_filename}")
        else:
            _sqr_log(unique_id, f"[SQR] ⚠ 无法获取音频文件名")

        # 找图像来源节点（裁切前插入 ImageFromBatch 用）
        # VHS_VideoCombine[vc_nid].images 的上游节点即为图像来源
        image_src_node = None
        if vc_nid and vc_nid in base_prompt:
            img_input = base_prompt[vc_nid]["inputs"].get("images")
            if isinstance(img_input, list) and len(img_input) == 2:
                image_src_node = img_input  # [node_id, slot]
                print(f"[SQR] 图像来源: {image_src_node}")

        # 解析续跑前段素材路径（需求6：续跑时把前段和本次一起合并）
        pre_segment_paths = [p.strip() for p in sqr_pre_segments.split(",")
                             if p.strip() and os.path.isfile(p.strip())] \
                            if sqr_pre_segments.strip() else []
        if pre_segment_paths:
            print(f"[SQR] 续跑前段素材: {len(pre_segment_paths)} 个文件")

        def submit_all():
            last_video_path   = manual_video_path
            last_video_frames = manual_video_frames
            segment_output_paths = []  # 每段裁切后输出视频路径（按顺序，用于最终合并）
            sqr_cut_paths = []           # 合并完成后清理的临时裁切文件
            _t0 = time.time()
            _total_frames_ran = sum(limit for _, limit in segs_to_run)
            _all_done = False  # 标记是否全部段正常完成（中途中断则保留 checkpoint）

            log(f"AnimateEmbeds节点: [{ae_nid}]")
            log(f"输出节点: [{vc_nid}]")
            if ref_images_list:
                log(f"参考图列表: {ref_images_list}")
            # 运行模式标识
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
                TRIM           = 16  # 每端裁切帧数，提前定义供音频计算使用
                audio_skip_frames = skip  # 默认值，后面音频块会精确覆写

                # 日志：头部直接显示实际注入 Load Video 的 skip 值（Bug C 修复）
                _actual_skip = skip + _frame_offset
                if _frame_offset > 0:
                    log(f"--- 第{seg_num}/{total_segs}段  实际skip={_actual_skip}（段内{skip}+偏移{_frame_offset}）limit={limit} ---")
                else:
                    log(f"--- 第{seg_num}/{total_segs}段  skip={_actual_skip}  limit={limit} ---")

                # ── 参考视频分段 ──
                wf[node_id]["inputs"]["skip_first_frames"] = _actual_skip
                wf[node_id]["inputs"]["frame_load_cap"]    = limit

                # ── 音频对齐 ──
                # 主节点[312]接完整生成帧（含transition），帧序列：
                #   有transition: [0..31]=transition帧 + [32..32+limit-1]=本段内容
                #   完整帧第0帧对应时间轴第(skip - TRANSITION_FRAMES)帧
                #   → 主节点音频起点 = (skip - TRANSITION_FRAMES) / fps
                #
                # cut_vc接裁切后帧，裁掉前16帧后，第0帧对应时间轴第(skip - TRIM)帧
                #   → cut_vc音频起点 = (skip - TRIM) / fps = (skip - 16) / fps
                #   → 即 audio_skip_frames（下面计算）
                #
                # 无transition（第1段）：完整帧就是本段内容，第0帧对应skip帧
                #   → 主节点和cut_vc音频起点都是 skip / fps
                if vc_nid and vc_nid in wf and audio_filename:
                    # 实际音频帧 = skip（段内相对偏移）+ _frame_offset（情形B起始偏移）
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
                    # 没有音频文件名时退回到 LoadVideo 直接输出
                    wf[vc_nid]["inputs"]["audio"] = [node_id, 2]
                    log(f"  ⚠ 音频: 无法获取文件名，直接用LoadVideo音频(skip={skip}帧)")

                # ── transition_video 直接注入 AnimateEmbeds ──
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
                        # 注入宽高（与用户设置同步）
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
                    # 支持完整路径：若是绝对路径则复制到 input/ 目录后使用文件名
                    if os.path.isabs(img_entry):
                        import shutil as _shutil
                        img_fname = os.path.basename(img_entry)
                        img_dst   = os.path.join(folder_paths.get_input_directory(), img_fname)
                        # 只有源文件不在 input/ 目录时才复制，避免同文件占用报错
                        if os.path.realpath(img_entry) != os.path.realpath(img_dst):
                            try:
                                _shutil.copy2(img_entry, img_dst)
                            except Exception as e:
                                log(f"  ⚠ 参考图复制失败: {e}")
                        img_name = img_fname
                    else:
                        img_name = img_entry
                    wf[ri_node_id]["inputs"]["image"] = img_name
                    wv = wf[ri_node_id].get("widgets_values", [])
                    if wv: wv[0] = img_name
                    log(f"  ✓ 参考图[{img_idx+1}]: {img_name}")

                # ── 自动裁切（固定模式，动态注入 ImageFromBatch）──
                # 规则：
                #   第1段（无transition）：不裁前，裁后16帧
                #   中间段（有transition）：裁前16，裁后16
                #   最后段（有transition）：裁前16，不裁后
                # 实现：动态创建 1~2 个 ImageFromBatch 节点插在图像输出和 VHS_VideoCombine 之间
                TRIM = 16
                is_last_seg = (seg_num == total_segs)
                total_raw = limit + (TRANSITION_FRAMES if use_transition else 0)

                image_src = image_src_node  # [node_id, slot] 格式
                if not use_transition:
                    # 第1段：不裁前，裁后16
                    trim_start = 0
                    trim_len   = total_raw - TRIM  # 去掉尾16
                    ifb_a = f"sqr_ifb_{seg_num}_a"
                    wf[ifb_a] = {"class_type": "ImageFromBatch",
                                 "inputs": {"image": image_src, "batch_index": trim_start, "length": trim_len}}
                    final_image_node = ifb_a
                    log(f"  裁切：不裁前，裁后{TRIM}帧→输出{trim_len}帧")
                elif is_last_seg:
                    # 最后段：裁前16，不裁后
                    trim_start = TRIM
                    trim_len   = total_raw - TRIM
                    ifb_a = f"sqr_ifb_{seg_num}_a"
                    wf[ifb_a] = {"class_type": "ImageFromBatch",
                                 "inputs": {"image": image_src, "batch_index": trim_start, "length": trim_len}}
                    final_image_node = ifb_a
                    log(f"  裁切：裁前{TRIM}帧，不裁后→输出{trim_len}帧")
                else:
                    # 中间段：裁前16，裁后16（用2个节点）
                    trim_start  = TRIM
                    after_front = total_raw - TRIM       # 裁前16后剩余
                    trim_len    = after_front - TRIM     # 再裁后16
                    ifb_a = f"sqr_ifb_{seg_num}_a"
                    ifb_b = f"sqr_ifb_{seg_num}_b"
                    wf[ifb_a] = {"class_type": "ImageFromBatch",
                                 "inputs": {"image": image_src, "batch_index": trim_start, "length": after_front}}
                    wf[ifb_b] = {"class_type": "ImageFromBatch",
                                 "inputs": {"image": [ifb_a, 0], "batch_index": 0, "length": trim_len}}
                    final_image_node = ifb_b
                    log(f"  裁切：裁前{TRIM}裁后{TRIM}→输出{trim_len}帧")

                # ── VHS_VideoCombine 双路输出 ──
                # [312] 保留完整未裁视频（存入 history，用于 transition 和合并）
                # sqr_cut_vc_{seg_num} 输出裁切后视频（用户最终看到的版本）
                if vc_nid and vc_nid in wf:
                    # 主节点 [312] 接完整图像，保持原有音频行为不干涉
                    wf[vc_nid]["inputs"]["images"] = image_src

                    # 裁切输出节点（复制 312 的配置，接裁切后图像）
                    cut_vc_id = f"sqr_cut_vc_{seg_num}"
                    cut_inputs = copy.deepcopy(wf[vc_nid]["inputs"])
                    cut_inputs["images"]          = [final_image_node, 0]
                    cut_inputs["save_output"]     = True
                    cut_inputs["save_metadata"]   = False  # 不产生 png 元数据图（sqr_cut系列不需要）
                    # 提取主节点的子文件夹前缀（如 "dancing video/"），sqr_cut 输出到同一位置
                    _main_prefix = wf[vc_nid]["inputs"].get("filename_prefix", "")
                    _slash = max(_main_prefix.rfind("/"), _main_prefix.rfind("\\"))
                    _subfolder_prefix = _main_prefix[:_slash+1] if _slash >= 0 else ""
                    cut_inputs["filename_prefix"] = f"{_subfolder_prefix}sqr_cut_{seg_num}_"

                    # cut_vc 接裁切后帧，第0帧 = 时间轴第(skip-16)帧
                    # audio_skip_frames = skip-16（有transition）或 skip（无transition）
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

                # ── 移除本节点避免递归 ──
                if unique_id and unique_id in wf:
                    del wf[unique_id]

                log(f"  → 提交中...")
                try:
                    pid = queue_prompt(wf, client_id=_client_id)
                    log(f"  prompt_id={pid[:8]}...")
                    ok  = wait_for_prompt(pid)
                    if ok:
                        log(f"✓ 第{seg_num}段完成")
                        # 全部段完成则标记
                        if is_last_seg:
                            _all_done = True
                        # 写断点 checkpoint
                        if unique_id:
                            # 记录 load video 完整参数，作为条件6检测依据
                            _lv_inputs = base_prompt.get(node_id, {}).get("inputs", {})
                            _ref_video_params = {
                                "video":             _lv_inputs.get("video", ""),
                                "force_rate":        _lv_inputs.get("force_rate", 0),
                                "frame_load_cap":    _lv_inputs.get("frame_load_cap", 0),
                                "skip_first_frames": _lv_inputs.get("skip_first_frames", 0),
                                "select_every_nth":  _lv_inputs.get("select_every_nth", 1),
                            }
                            # base_frame_offset = 本次运行的基础帧偏移（供自动续跑使用）
                            # frame_offset_for_resume = 累计偏移（供重新设计续跑使用，从断点位置另起分段）
                            _next_seg_idx = seg_num
                            if _next_seg_idx < len(seg_list):
                                _frame_offset_for_resume = _frame_offset + seg_list[_next_seg_idx][0]
                            else:
                                _frame_offset_for_resume = _frame_offset + (skip + limit)
                            write_checkpoint(unique_id, {
                                "unique_id":              unique_id,
                                "completed_seg":          seg_num,
                                "total_segs":             total_segs,
                                "next_seg":               seg_num + 1,
                                "transition_video":       f"segment_transition_seg{seg_num}.mp4",
                                "ref_images":             ref_images_list,
                                "segments":               segments,
                                "ref_video":              _ref_video_params.get("video", ""),
                                "ref_video_params":       _ref_video_params,
                                "timestamp":              time.strftime("%Y-%m-%d %H:%M:%S"),
                                "base_frame_offset":      _frame_offset,
                                "frame_offset_for_resume": _frame_offset_for_resume,
                            })
                        # 每段完成后更新速度记录（跑任意一段都有数据）
                        _elapsed = time.time() - _t0
                        _frames_done = sum(lmt for _, lmt in segs_to_run[:i+1])
                        save_speed_record(_elapsed, _frames_done)

                        # 取裁切后视频路径（用于最终合并，从 sqr_cut_vc 取）
                        cut_vc_id_done = f"sqr_cut_vc_{seg_num}"
                        if vc_nid:
                            cut_vpath, _ = get_output_video_info(pid, cut_vc_id_done)
                            if not cut_vpath:
                                cut_vpath, _ = get_output_video_info(pid, vc_nid)
                            if cut_vpath:
                                segment_output_paths.append(cut_vpath)
                                sqr_cut_paths.append(cut_vpath)   # 合并后清理
                                log(f"  ✓ 裁切输出: {os.path.basename(cut_vpath)}")
                            else:
                                log(f"  ⚠ 未找到裁切输出视频")

                        # 取完整视频（从主节点 vc_nid 取，接的是 image_src 完整帧）
                        vpath, vframes = get_output_video_info(pid, vc_nid) if vc_nid else (None, None)
                        if not vpath:
                            log(f"  ⚠ 完整视频获取失败，下段过渡将跳过")
                        if vpath:
                            import shutil
                            input_dir   = folder_paths.get_input_directory()
                            input_fname = f"segment_transition_seg{seg_num}.mp4"
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
            # 续跑时：将前段素材拼到本次产出前面，一起合并成完整成品
            if pre_segment_paths:
                log(f"续跑合并：前段 {len(pre_segment_paths)} 个 + 本次 {len(segment_output_paths)} 个")
                segment_output_paths = pre_segment_paths + segment_output_paths

            if len(segment_output_paths) >= 2:
                log(f"开始合并 {len(segment_output_paths)} 段视频...")
                output_dir   = folder_paths.get_output_directory()
                # 合并文件也放到与主节点相同的子文件夹
                if vc_nid and base_prompt and vc_nid in base_prompt:
                    _mp = base_prompt[vc_nid]["inputs"].get("filename_prefix", "")
                    _sl = max(_mp.rfind("/"), _mp.rfind("\\"))
                    _sub = _mp[:_sl+1] if _sl >= 0 else ""
                    if _sub:
                        os.makedirs(os.path.join(output_dir, _sub.rstrip("/\\")), exist_ok=True)
                else:
                    _sub = ""
                merged_fname = f"sqr_merged_{seg_num:04d}_.mp4"
                merged_path  = os.path.join(output_dir, _sub + merged_fname)
                if merge_videos(segment_output_paths, merged_path,
                               target_fps=frame_rate if pre_segment_paths else None):
                    log(f"✓ 合并完成: {_sub + merged_fname}")
                else:
                    log(f"✗ 合并失败，请手动拼接各段视频")
            elif len(segment_output_paths) == 1:
                log(f"只有1段，无需合并")

            # 清理临时裁切文件：
            # - 删除不带音频的 sqr_cut_*.mp4（无用）和 sqr_cut_*.png（VHS元数据图）
            # - 保留带 -audio 的 sqr_cut_*-audio.mp4（有声音，供用户手动剪辑）
            import re as _re
            _cleaned_prefixes = set()
            for _p in sqr_cut_paths:
                try:
                    _dir  = os.path.dirname(_p)
                    _base = os.path.basename(_p)
                    # 提取 sqr_cut_N_ 前缀（支持子文件夹）
                    _m = _re.match(r".*(sqr_cut_\d+_)", _base)
                    if not _m:
                        continue
                    _prefix = _m.group(1)
                    if _prefix in _cleaned_prefixes:
                        continue
                    _cleaned_prefixes.add(_prefix)
                    for _f in os.listdir(_dir):
                        if not _f.startswith(_prefix):
                            continue
                        _fpath = os.path.join(_dir, _f)
                        # 保留带 -audio 的 mp4
                        if _f.endswith(".mp4") and "-audio" in _f:
                            continue
                        # 删除不带 -audio 的 mp4 和所有 png
                        if _f.endswith(".mp4") or _f.endswith(".png"):
                            try:
                                os.remove(_fpath)
                                print(f"[SQR] 已清理临时文件: {_f}")
                            except Exception:
                                pass
                except Exception:
                    pass

            # 清理主节点 [312] 因重执行产生的 png
            # 是否清理由 SQR 节点设置的 save_png 参数决定（从 extra_pnginfo 传入）
            _sqr_save_png = (str(sqr_save_png).lower() != "false")  # "false"=清理, 其它=保留
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
            log("═══ 全部完成 ═══")

        # 清除旧 checkpoint（本次重新开始，旧断点失效）
        if unique_id:
            clear_checkpoint(unique_id)

        # 运行模式标识（与控制台日志格式一致，ShowText 同步显示）
        if _frame_offset > 0:
            _mode_header = f"=== 重新设计续跑模式（帧偏移={_frame_offset}，跳过前{_frame_offset}帧）==="
        elif resume_enabled:
            _mode_header = "=== 自动续跑模式 ==="
        else:
            _mode_header = "=== 全新生成 ==="
        exec_msg = _mode_header + "\n" + plan_text

        t = threading.Thread(target=submit_all, daemon=True)
        t.start()
        # 精简提交时 SDPose 不在队列，无需中断；回退到完整 prompt 时保留 5ms 中断保底
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
    """返回指定节点的 checkpoint 信息"""
    uid = request.rel_url.query.get("uid", "")
    if not uid:
        return web.json_response({"checkpoint": None})
    ckpt = read_checkpoint(uid)
    # 验证 transition 视频是否真实存在且是本次任务产生的
    if ckpt:
        input_dir = folder_paths.get_input_directory()
        tv = ckpt.get("transition_video", "")
        tv_path = os.path.join(input_dir, tv) if tv else ""
        ckpt["transition_exists"] = os.path.isfile(tv_path)
        if ckpt["transition_exists"] and tv_path:
            tv_mtime   = os.path.getmtime(tv_path)
            ckpt_mtime = os.path.getmtime(get_checkpoint_path(uid))
            # 视频应在 checkpoint 写入之前（或几乎同时）产生
            # 若视频比 checkpoint 新超过 60 秒，说明是后来别的任务覆盖的旧文件
            if tv_mtime > ckpt_mtime + 60:
                ckpt["transition_exists"] = False
        # 条件6：load video 完整参数是否一致（前端传入 JSON，后端比对）
        import urllib.parse as _up
        cur_params_str = request.rel_url.query.get("ref_params", "")
        ckpt_params    = ckpt.get("ref_video_params", {})
        # 兼容旧 checkpoint（只有 ref_video 字段的）
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
                    # 数字类型用数值比较，字符串用字符串比较
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
    """用 tkinter 弹出原生文件选择窗口，支持多选图片"""
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
    """用 tkinter 弹出原生文件选择窗口，单选视频"""
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
    # 保留兼容旧接口（列 input/ 目录）
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
    """浏览任意目录，返回子文件夹列表和图片文件列表"""
    import re
    img_exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

    def nat_key(s):
        return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]

    req_path = request.rel_url.query.get("path", "").strip()

    import platform, string as _str

    # 「此电脑」虚拟入口：展开为所有盘符
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

    # 没有指定路径时返回常用起始目录
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

    # 安全检查：必须是绝对路径且真实存在
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
    # 保留兼容旧接口，列 input/ 目录视频（自然排序，segment_transition_seg 系列排最前）
    import re
    vid_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
    def sort_key(fname):
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
    """返回视频第一帧的缩略图（base64 PNG）"""
    import base64, io
    fpath = request.rel_url.query.get("file", "").strip()
    if not fpath:
        return web.Response(status=400)
    # 支持绝对路径和相对路径（相对于 input/ 或 output/）
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
        # 缩小到宽度 160
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
    """浏览任意目录，返回子文件夹列表和视频文件列表"""
    import re
    vid_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm"}

    def nat_key(s):
        return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]

    def sort_key(fname):
        m = re.match(r"segment_transition_seg(\d+)\.mp4$", fname, re.IGNORECASE)
        if m:
            return (0, int(m.group(1)), fname)
        parts = re.split(r"(\d+)", fname)
        return (1, 0, tuple(int(p) if p.isdigit() else p.lower() for p in parts))

    req_path = request.rel_url.query.get("path", "").strip()

    import platform, string as _str

    # 「此电脑」虚拟入口：展开为所有盘符
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
    # 支持完整路径（文件浏览器模式）和纯文件名（旧模式，从 input/ 目录取）
    if os.path.isabs(fname):
        path = os.path.realpath(fname)
    else:
        path = os.path.join(folder_paths.get_input_directory(), fname)
    if not os.path.isfile(path):
        return web.Response(status=404)
    return web.FileResponse(path)
