"""
ComfyUI 分段自动队列节点 - 最终版
"""

import math, copy, json, time, os, threading, urllib.request, urllib.error, hashlib, socket
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


def _sqr_format_exc(e: Exception) -> str:
    return f"{type(e).__name__}: {e}"


def _sqr_log_cv2_issue(uid, scene: str, e: Exception):
    detail = _sqr_format_exc(e)
    if isinstance(e, ModuleNotFoundError) and getattr(e, "name", "") == "cv2":
        _sqr_log(uid, f"[SQR] ✗ {scene}: {detail}")
        _sqr_log(uid, "[SQR] ✗ 未安装 cv2 / opencv-python，请安装插件 requirements.txt 中的依赖后重启 ComfyUI。")
    else:
        _sqr_log(uid, f"[SQR] ✗ {scene}: {detail}")


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


def _sqr_is_managed_ref_path(path: str | None, unique_id=None) -> bool:
    base = os.path.basename(str(path or ""))
    if not base:
        return False
    prefixes = ["sqr_refkeep_", "sqr_refsnap_"]
    if unique_id:
        prefixes = [f"sqr_refkeep_{unique_id}_", f"sqr_refsnap_{unique_id}_"]
    return any(base.startswith(pref) for pref in prefixes)


def _sqr_cleanup_ref_images(paths, unique_id=None, keep_paths=None):
    keep = {os.path.realpath(str(p)) for p in (keep_paths or []) if p}
    input_dir = os.path.realpath(folder_paths.get_input_directory())
    for raw in paths or []:
        p = str(raw or "").strip()
        if not p or not _sqr_is_managed_ref_path(p, unique_id=unique_id):
            continue
        real = os.path.realpath(p)
        if real in keep:
            continue
        try:
            if os.path.commonpath([real, input_dir]) != input_dir:
                continue
        except Exception:
            continue
        try:
            if os.path.exists(real):
                os.remove(real)
                print(f"[SQR] 已清理 checkpoint 参考图: {os.path.basename(real)}")
        except Exception:
            pass


def _sqr_prepare_checkpoint_ref_images(ref_images_list, unique_id=None):
    if not ref_images_list:
        return []
    input_dir = folder_paths.get_input_directory()
    os.makedirs(input_dir, exist_ok=True)
    keep_list = []
    stamp = _sqr_now_stamp()
    import shutil as _snap_shutil
    for idx, raw in enumerate(ref_images_list, start=1):
        src = _sqr_resolve_media_path(raw) or str(raw or "").strip()
        if not src:
            continue
        src_real = os.path.realpath(src)
        if _sqr_is_managed_ref_path(src_real, unique_id=unique_id) and os.path.isfile(src_real):
            keep_list.append(src_real)
            continue
        if os.path.isfile(src_real):
            keep_name = f"sqr_refkeep_{unique_id}_{stamp}_{idx:02d}_{os.path.basename(src_real)}" if unique_id else f"sqr_refkeep_{stamp}_{idx:02d}_{os.path.basename(src_real)}"
            keep_dst = os.path.join(input_dir, keep_name)
            try:
                _snap_shutil.copy2(src_real, keep_dst)
                keep_list.append(keep_dst)
            except Exception as e:
                print(f"[SQR] ⚠ 参考图持久化失败({os.path.basename(src_real)}): {e}")
                keep_list.append(src_real)
        else:
            keep_list.append(str(raw))
    return keep_list

_SQR_COMFY_HOST_CACHE = None


def _sqr_now_stamp() -> str:
    return time.strftime("%Y%m%d_%H%M%S") + f"_{int((time.time() % 1) * 1000):03d}"


def _sqr_transition_seg_from_name(fname: str):
    import re
    patterns = [
        r"^sqr_trans_[0-9_]+_seg(\d+)\.mp4$",
        r"^sqr_trans_[a-f0-9]+_seg(\d+)\.mp4$",
        r"^segment_transition_seg(\d+)\.mp4$",
    ]
    for pat in patterns:
        m = re.match(pat, fname, re.IGNORECASE)
        if m:
            return int(m.group(1))
    return None


def _sqr_unique_filepath(path: str) -> str:
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    while True:
        cand = f"{base}_{_sqr_now_stamp()}{ext}"
        if not os.path.exists(cand):
            return cand
        time.sleep(0.002)


def _sqr_collect_comfy_hosts() -> list[str]:
    candidates = []
    seen = set()

    def add(host, port):
        if port in (None, ""):
            return
        try:
            port = int(port)
        except Exception:
            return
        host = str(host or "").strip()
        if host in ("", "0.0.0.0", "::", "[::]"):
            host = "127.0.0.1"
        if host.startswith("http://") or host.startswith("https://"):
            host = host.split("://", 1)[1]
        host = host.strip("/ ")
        key = f"{host}:{port}"
        if key not in seen:
            seen.add(key)
            candidates.append(key)

    inst = getattr(getattr(server, "PromptServer", None), "instance", None)
    if inst is not None:
        add(getattr(inst, "address", None), getattr(inst, "port", None))
        add(getattr(inst, "host", None), getattr(inst, "port", None))
        srv = getattr(inst, "server", None)
        if srv is not None:
            add(getattr(srv, "address", None), getattr(srv, "port", None))
            add(getattr(srv, "host", None), getattr(srv, "port", None))

    add(os.environ.get("COMFYUI_HOST"), os.environ.get("COMFYUI_PORT"))
    add(os.environ.get("SERVER_HOST"), os.environ.get("SERVER_PORT"))

    for port in (8188, 8000, 9000, 8080):
        add("127.0.0.1", port)
        add("localhost", port)
    return candidates


def _sqr_probe_comfy_host(host: str) -> bool:
    for ep in ("/system_stats", "/queue", "/object_info", "/features"):
        try:
            with urllib.request.urlopen(f"http://{host}{ep}", timeout=1.2) as resp:
                code = getattr(resp, "status", 200)
                if code < 500:
                    return True
        except urllib.error.HTTPError as e:
            if e.code < 500:
                return True
        except Exception:
            continue
    return False


def _sqr_get_comfy_host(force_refresh: bool = False) -> str:
    global _SQR_COMFY_HOST_CACHE
    if _SQR_COMFY_HOST_CACHE and not force_refresh:
        return _SQR_COMFY_HOST_CACHE
    for cand in _sqr_collect_comfy_hosts():
        if _sqr_probe_comfy_host(cand):
            _SQR_COMFY_HOST_CACHE = cand
            return cand
    _SQR_COMFY_HOST_CACHE = "127.0.0.1:8188"
    return _SQR_COMFY_HOST_CACHE


def _build_safe_input_copy_name(src_path: str, unique_id=None, prefix: str = "sqr_ref") -> str:
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




def _sqr_media_roots() -> list[str]:
    roots = []
    seen = set()
    for getter_name in ("get_input_directory", "get_output_directory", "get_temp_directory"):
        getter = getattr(folder_paths, getter_name, None)
        if not callable(getter):
            continue
        try:
            p = getter()
        except Exception:
            continue
        if not p:
            continue
        rp = os.path.realpath(str(p))
        if rp not in seen:
            seen.add(rp)
            roots.append(rp)
    return roots


def _sqr_resolve_media_path(path: str | None) -> str | None:
    raw = str(path or "").strip().strip('"').strip("'")
    if not raw:
        return None

    if os.path.isfile(raw):
        return os.path.realpath(raw)

    try:
        ann = folder_paths.get_annotated_filepath(raw)
        if ann and os.path.isfile(ann):
            return os.path.realpath(ann)
    except Exception:
        pass

    candidates = []
    seen = set()

    def add_candidate(p):
        if not p:
            return
        rp = os.path.realpath(p)
        if rp not in seen:
            seen.add(rp)
            candidates.append(rp)

    if os.path.isabs(raw):
        add_candidate(raw)
    else:
        add_candidate(raw)
        base = os.path.basename(raw)
        for root in _sqr_media_roots():
            add_candidate(os.path.join(root, raw))
            if base != raw:
                add_candidate(os.path.join(root, base))

    for cand in candidates:
        if os.path.isfile(cand):
            return cand

    base = os.path.basename(raw)
    if base == raw:
        for root in _sqr_media_roots():
            try:
                for dirpath, _, files in os.walk(root):
                    if base in files:
                        return os.path.realpath(os.path.join(dirpath, base))
            except Exception:
                continue
    return None


def _sqr_copy_into_input(src_path: str, desired_name: str | None = None,
                         unique_id=None, prefix: str = "sqr_copy") -> str:
    src_real = _sqr_resolve_media_path(src_path) or os.path.realpath(str(src_path))
    if not os.path.isfile(src_real):
        raise FileNotFoundError(src_path)

    input_dir = folder_paths.get_input_directory()
    os.makedirs(input_dir, exist_ok=True)

    if os.path.realpath(os.path.dirname(src_real)) == os.path.realpath(input_dir):
        return src_real

    name = (desired_name or "").strip() or os.path.basename(src_real)
    dst = os.path.join(input_dir, name)

    try:
        if os.path.exists(dst) and os.path.samefile(src_real, dst):
            return dst
    except Exception:
        pass

    if os.path.exists(dst):
        if desired_name:
            dst = _sqr_unique_filepath(dst)
        else:
            safe_name = _build_safe_input_copy_name(src_real, unique_id=unique_id, prefix=prefix)
            dst = os.path.join(input_dir, safe_name)

    import shutil
    shutil.copy2(src_real, dst)
    return dst
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


def build_plan_text(total_frames, segments, start_from_segment, node_id, frame_rate,
                    seg_list_override=None):
    if total_frames <= 0:
        return "✗ total_frames 必须大于 0。"
    if seg_list_override is not None:
        seg_list = seg_list_override
    else:
        seg_list = calc_segments(total_frames, segments)
    start_from_segment = max(1, min(start_from_segment, len(seg_list)))
    start_idx = start_from_segment - 1
    SEP = "═" * 45
    lines = [
        f"参考视频节点：{node_id}  总帧数：{total_frames}  模式：平均分段",
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


def queue_prompt(workflow, host=None, client_id="") -> str:
    payload = json.dumps({"prompt": workflow, "client_id": client_id}).encode("utf-8")
    last_err = None
    for _host in [host or _sqr_get_comfy_host(), _sqr_get_comfy_host(force_refresh=True)]:
        try:
            req = urllib.request.Request(
                f"http://{_host}/prompt", data=payload,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())["prompt_id"]
        except Exception as e:
            last_err = e
    raise last_err


def wait_for_prompt(prompt_id, host=None, poll=5) -> bool:
    while True:
        time.sleep(poll)
        for _host in [host or _sqr_get_comfy_host(), _sqr_get_comfy_host(force_refresh=True)]:
            try:
                with urllib.request.urlopen(f"http://{_host}/history/{prompt_id}", timeout=10) as resp:
                    history = json.loads(resp.read())
                if prompt_id in history:
                    st = history[prompt_id].get("status", {})
                    if st.get("completed"):
                        return True
                    if st.get("status_str") == "error":
                        return False
                    break
            except Exception:
                continue


def get_output_video_info(prompt_id, combine_node_id, host=None, logger=None):
    last_err = None
    for _host in [host or _sqr_get_comfy_host(), _sqr_get_comfy_host(force_refresh=True)]:
        try:
            with urllib.request.urlopen(f"http://{_host}/history/{prompt_id}", timeout=10) as resp:
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
            try:
                frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) if cap.isOpened() else None
            finally:
                cap.release()
            return video_path, frames
        except Exception as e:
            last_err = e
    msg = f"✗ 获取视频信息失败: {_sqr_format_exc(last_err)}" if last_err else "✗ 获取视频信息失败"
    if logger:
        logger(msg)
    else:
        print(f"[SQR] {msg}")
    return None, None


def interrupt_current(host=None):
    for _host in [host or _sqr_get_comfy_host(), _sqr_get_comfy_host(force_refresh=True)]:
        try:
            urllib.request.urlopen(
                urllib.request.Request(f"http://{_host}/interrupt", data=b"", method="POST"), timeout=10)
            return
        except Exception:
            continue


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
                "分段数": ("INT", {"default": 2, "min": 1, "max": 100, "step": 1, "display": "slider",
                    "tooltip": "平均分段的段数（最大值可在设置处调整）。\nNumber of average segments (max adjustable in settings)."}),
                "从第几段开始": ("INT", {"default": 1, "min": 1, "max": 100, "step": 1, "display": "slider",
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

        _preview_segments = segments
        start_from_segment = max(1, min(从第几段开始, _preview_segments))
        plan_text = build_plan_text(
            _plan_frames, _preview_segments, start_from_segment, node_id, frame_rate)

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
        _is_remote = bool((extra_pnginfo or {}).get("sqr_is_remote", False))

        if node_id not in (_effective_prompt or {}):
            _sqr_log(unique_id, f"[SQR] ✗ 找不到节点 ID「{node_id}」（完整工作流中）。")
            return {}

        print(f"[SQR] sqr_frame_offset: 参数={sqr_frame_offset}, 实际使用={_frame_offset}"
              f" | 工作流来源={'extra_pnginfo' if _sqr_full_prompt else 'prompt(回退)'}"
              f" | 分段模式=average")
        _effective_frames = max(1, total_frames - _frame_offset) if _frame_offset > 0 else total_frames

        seg_list = calc_segments(_effective_frames, segments)

        start_idx   = start_from_segment - 1
        segs_to_run = seg_list[start_idx:]
        base_prompt = copy.deepcopy(_effective_prompt)

        ae_nid = ae_node_id or find_animate_embeds_node(base_prompt) or ""
        vc_nid = find_video_combine_node(base_prompt, combine_nid) or ""

        ref_images_list = [x.strip() for x in ref_imgs_str.split(",") if x.strip()]                           if ref_imgs_str else []
        if ref_images_list:
            ref_images_list = _sqr_prepare_checkpoint_ref_images(ref_images_list, unique_id=unique_id)

        manual_video_path = manual_video_frames = None
        if resume_enabled and resume_video_path:
            p = _sqr_resolve_media_path(resume_video_path)
            if p and os.path.isfile(p):
                try:
                    src_p = p
                    p = _sqr_copy_into_input(p, unique_id=unique_id, prefix="sqr_resume")
                    if os.path.realpath(src_p) != os.path.realpath(p):
                        _sqr_log(unique_id, f"[SQR] 已复制续跑视频到 input/: {os.path.basename(p)}")
                    fname = os.path.basename(p)
                    import cv2
                    cap = cv2.VideoCapture(p)
                    try:
                        if not cap.isOpened():
                            _sqr_log(unique_id, f"[SQR] ✗ cv2 无法打开续跑视频: {fname}")
                        else:
                            frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                            if frames <= 0:
                                _sqr_log(unique_id, f"[SQR] ✗ 续跑视频帧数异常: {fname} ({frames})")
                            else:
                                manual_video_frames = frames
                                manual_video_path = p
                                _sqr_log(unique_id, f"[SQR] ✓ 续跑视频: {fname} ({manual_video_frames}帧)")
                    finally:
                        cap.release()
                except Exception as e:
                    _sqr_log_cv2_issue(unique_id, "读取续跑视频失败", e)
            else:
                _sqr_log(unique_id, f"[SQR] ⚠ 续跑视频不存在或无法解析: {resume_video_path}")

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

        run_stamp = _sqr_now_stamp()

        def submit_all():
            last_video_path   = manual_video_path
            last_video_frames = manual_video_frames
            segment_output_paths = []
            sqr_cut_cleanup = []
            sqr_cut_paths   = []
            _t0 = time.time()
            _total_frames_ran = sum(limit for _, limit in segs_to_run)
            _all_done = False

            log(f"{'═'*20} 运行时间码={run_stamp} {'═'*20}")
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
                    _cut_file_prefix = f"sqr_cut_{run_stamp}_seg{seg_num}_"
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
                        if unique_id and not _is_remote:
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
                            _trans_fname = f"sqr_trans_{run_stamp}_seg{seg_num}.mp4"
                            write_checkpoint(unique_id, {
                                "unique_id":              unique_id,
                                "run_stamp":                 run_stamp,
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
                                "total_frames_used":      total_frames,
                                "frame_rate_used":        frame_rate,
                            })
                        _elapsed = time.time() - _t0
                        _frames_done = sum(lmt for _, lmt in segs_to_run[:i+1])
                        save_speed_record(_elapsed, _frames_done)

                        cut_vc_id_done = f"sqr_cut_vc_{seg_num}"
                        if vc_nid:
                            cut_vpath, _ = get_output_video_info(pid, cut_vc_id_done, logger=log)
                            if not cut_vpath:
                                cut_vpath, _ = get_output_video_info(pid, vc_nid, logger=log)
                            if cut_vpath:
                                segment_output_paths.append(cut_vpath)
                                sqr_cut_paths.append(cut_vpath)
                                log(f"  ✓ 裁切输出: {os.path.basename(cut_vpath)}")
                            else:
                                log(f"  ⚠ 未找到裁切输出视频")

                        vpath, vframes = get_output_video_info(pid, vc_nid, logger=log) if vc_nid else (None, None)
                        if not vpath:
                            log(f"  ⚠ 完整视频获取失败，下段过渡将跳过")
                        if vpath:
                            import shutil
                            input_dir   = folder_paths.get_input_directory()
                            input_fname = f"sqr_trans_{run_stamp}_seg{seg_num}.mp4"
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
                merged_fname = f"sqr_merged_{run_stamp}.mp4"
                merged_path  = _sqr_unique_filepath(os.path.join(output_dir, _sub + merged_fname))
                merged_fname = os.path.basename(merged_path)
                if merge_videos(segment_output_paths, merged_path,
                               target_fps=frame_rate if pre_segment_paths else None):
                    log(f"✓ 合并完成: {_sub + merged_fname}")
                else:
                    log(f"✗ 合并失败，请手动拼接各段视频")
            elif len(segment_output_paths) == 1:
                log(f"只有1段，无需合并")

            for (_clean_dir, _clean_prefix) in sqr_cut_cleanup:
                try:
                    if not os.path.isdir(_clean_dir):
                        continue
                    for _f in os.listdir(_clean_dir):
                        if not _f.startswith(_clean_prefix):
                            continue
                        _fpath = os.path.join(_clean_dir, _f)
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
                    _sqr_cleanup_ref_images(ref_images_list, unique_id=unique_id)
                    print("[SQR] checkpoint 已清除（全部完成）")
                else:
                    print("[SQR] 任务中断，checkpoint 保留供续跑检测")

            log("═══ 全部完成 ═══")

        if unique_id:
            _old_ckpt = read_checkpoint(unique_id)
            _old_refs = _old_ckpt.get("ref_images", []) if isinstance(_old_ckpt, dict) else []
            clear_checkpoint(unique_id)
            _sqr_cleanup_ref_images(_old_refs, unique_id=unique_id, keep_paths=ref_images_list)

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
NODE_DISPLAY_NAME_MAPPINGS = {"SegmentQueueRunner": "分段队列 🎬 @肥猴🐵 @wuwu🚂 @雪子❄️ "}


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


@server.PromptServer.instance.routes.get("/sqr/list_videos")
async def sqr_list_videos(request):
    import re
    vid_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
    def sort_key(fname):
        m = re.match(r"sqr_trans_[0-9_]+_seg(\d+)\.mp4$", fname, re.IGNORECASE) or re.match(r"sqr_trans_[a-f0-9]+_seg(\d+)\.mp4$", fname, re.IGNORECASE)
        if m:
            return (0, int(m.group(1)), fname)
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
    fpath = request.rel_url.query.get("file", "").strip()
    if not fpath:
        return web.Response(status=400)

    raw_path = fpath
    fpath = _sqr_resolve_media_path(fpath)
    if not fpath or not os.path.isfile(fpath):
        print(f"[SQR] video_thumb: 文件不存在或无法解析: {raw_path}")
        return web.Response(status=404)

    try:
        import cv2
        cap = cv2.VideoCapture(fpath)
        try:
            if not cap.isOpened():
                print(f"[SQR] video_thumb: cv2 无法打开视频: {fpath}")
                return web.Response(status=404)

            ok, frame = cap.read()
            if not ok or frame is None:
                print(f"[SQR] video_thumb: 读取首帧失败: {fpath}")
                return web.Response(status=404)
        finally:
            cap.release()

        h, w = frame.shape[:2]
        new_w = 160
        new_h = int(h * new_w / w)
        frame = cv2.resize(frame, (new_w, new_h))
        ok2, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        if not ok2:
            print(f"[SQR] video_thumb: JPEG 编码失败: {fpath}")
            return web.Response(status=500)

        return web.Response(body=buf.tobytes(), content_type="image/jpeg")

    except ModuleNotFoundError as e:
        if getattr(e, "name", "") == "cv2":
            print("[SQR] video_thumb失败: 未安装 cv2 / opencv-python。请安装 requirements.txt 中的依赖后重启 ComfyUI。")
        else:
            print(f"[SQR] video_thumb失败: {_sqr_format_exc(e)}")
        return web.Response(status=500)
    except Exception as e:
        print(f"[SQR] video_thumb失败: {_sqr_format_exc(e)}")
        return web.Response(status=500)


@server.PromptServer.instance.routes.get("/sqr/browse_videos")
async def sqr_browse_videos(request):
    import re
    vid_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
    def nat_key(s):
        return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]
    def sort_key(fname):
        m = re.match(r"sqr_trans_[0-9_]+_seg(\d+)\.mp4$", fname, re.IGNORECASE) or re.match(r"sqr_trans_[a-f0-9]+_seg(\d+)\.mp4$", fname, re.IGNORECASE)
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
    path = _sqr_resolve_media_path(fname)
    if not path or not os.path.isfile(path):
        return web.Response(status=404)
    return web.FileResponse(path, headers={
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    })




