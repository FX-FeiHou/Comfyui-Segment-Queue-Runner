"""
ComfyUI 分段自动队列节点 - 最终版
"""

import math, copy, json, time, os, threading, urllib.request, urllib.error, hashlib, socket, uuid, tempfile
import server, folder_paths
from aiohttp import web

# ── 日志缓冲（前端弹窗读取）──────────────────────────────────────
_sqr_log_buf: dict = {}
_sqr_log_lock = threading.Lock()
_sqr_progress_buf: dict = {}
_sqr_progress_lock = threading.Lock()

def _sqr_log(uid, msg):
    text = "" if msg is None else str(msg)
    print(text)
    if not uid:
        return
    k = str(uid)
    lines = text.splitlines()
    if not lines:
        lines = [""]
    with _sqr_log_lock:
        buf = list(_sqr_log_buf.setdefault(k, []))
        buf.extend(lines)
        if text.endswith("\n"):
            buf.append("")
        if len(buf) > 3000:
            buf = buf[-3000:]
        _sqr_log_buf[k] = buf

def _sqr_log_clear(uid):
    with _sqr_log_lock:
        _sqr_log_buf.pop(str(uid), None)

def _sqr_progress_set(uid, **fields):
    if not uid:
        return
    with _sqr_progress_lock:
        cur = dict(_sqr_progress_buf.get(str(uid), {}))
        cur.update(fields)
        cur["updated_at"] = time.time()
        _sqr_progress_buf[str(uid)] = cur

def _sqr_progress_get(uid):
    with _sqr_progress_lock:
        return copy.deepcopy(_sqr_progress_buf.get(str(uid), {}))

def _sqr_progress_clear(uid):
    with _sqr_progress_lock:
        _sqr_progress_buf.pop(str(uid), None)


MIN_SEG_FRAMES = 41
_DEFAULT_PROMPT_TIMEOUT_SECS = 12 * 3600


def _sqr_nonneg_int(value, default: int = 0) -> int:
    try:
        iv = int(round(float(value)))
    except Exception:
        return int(default)
    return max(0, iv)


def _sqr_normalize_select_every_nth(value) -> int:
    """分段队列内部始终按 select_every_nth=1 的行为执行。"""
    return 1



def _sqr_round_limit_up(raw_frames: int) -> int:
    """向上对齐到 4n+1。
    例如 41→41，42→45，45→45。"""
    return ((max(0, int(raw_frames)) + 2) // 4) * 4 + 1


def _sqr_round_limit_manual(raw_frames: int) -> int:
    return _sqr_round_limit_up(raw_frames)


def _sqr_max_segment_count(total_frames: int, min_seg_frames: int = MIN_SEG_FRAMES) -> int:
    total_frames = max(0, int(total_frames or 0))
    if total_frames <= 0:
        return 0
    if total_frames < min_seg_frames:
        return 1
    return max(1, total_frames // max(1, int(min_seg_frames or 1)))


def _sqr_calc_average_segments(total_frames: int, segments: int, min_seg_frames: int = MIN_SEG_FRAMES):
    total_frames = max(0, int(total_frames or 0))
    if total_frames <= 0:
        return [], 0, []
    try:
        requested = int(segments or 1)
    except Exception:
        requested = 1
    requested = max(1, requested)
    allowed_max = max(1, _sqr_max_segment_count(total_frames, min_seg_frames))
    actual = min(requested, allowed_max)
    notes = []
    if actual != requested:
        notes.append(f"平均分段请求 {requested} 段，已按最小 {min_seg_frames} 帧限制收敛为 {actual} 段。")

    while actual > 1:
        per_seg = ((math.ceil(total_frames / actual) + 3) // 4) * 4 + 1
        result = []
        for i in range(actual):
            skip = i * per_seg
            if skip >= total_frames:
                break
            if i < actual - 1:
                limit = per_seg
            else:
                remaining = total_frames - skip
                limit = _sqr_round_limit_up(remaining)
            result.append((skip, limit))
        if not result:
            break
        tail_raw = total_frames - result[-1][0]
        if len(result) > 1 and tail_raw < min_seg_frames:
            prev_actual = actual
            actual -= 1
            notes.append(f"平均分段尾段仅 {tail_raw} 帧，不足 {min_seg_frames} 帧，已自动收敛为 {actual} 段。")
            continue
        return result, actual, notes

    return [(0, _sqr_round_limit_up(total_frames))], 1, notes


def _sqr_calc_manual_seed_segments(total_frames: int, segments: int, min_seg_frames: int = MIN_SEG_FRAMES):
    """手动分段模式的初始种子：最小段长底座 + 余量均匀分摊。
    只要理论上还能满足最小段长，就不主动减段；
    每段先给 min_seg_frames，再把剩余帧数以 4 帧为单位尽量均匀地分摊到各段，零头优先留给最后一段。"""
    total_frames = max(0, int(total_frames or 0))
    if total_frames <= 0:
        return [], 0, []
    try:
        requested = int(segments or 1)
    except Exception:
        requested = 1
    requested = max(1, requested)
    allowed_max = max(1, _sqr_max_segment_count(total_frames, min_seg_frames))
    actual = min(requested, allowed_max)
    notes = []
    if actual != requested:
        notes.append(
            f"手动分段请求 {requested} 段，但 {total_frames} 帧在最小 {min_seg_frames} 帧约束下最多只能分 {actual} 段，已自动收敛为 {actual} 段。"
        )

    if actual <= 1:
        return [(0, _sqr_round_limit_manual(total_frames))], 1, notes

    base_total = actual * min_seg_frames
    extra = max(0, total_frames - base_total)
    extra_units = extra // 4
    residual = extra % 4
    base_units = extra_units // actual
    tail_units = extra_units % actual

    raw_lengths = [min_seg_frames + base_units * 4 for _ in range(actual)]
    for idx in range(actual - tail_units, actual):
        if 0 <= idx < actual:
            raw_lengths[idx] += 4
    raw_lengths[-1] += residual

    # 理论上总和应与 total_frames 一致，若因边界值出现偏差，统一修正到最后一段。
    diff = total_frames - sum(raw_lengths)
    raw_lengths[-1] += diff

    result = []
    pos = 0
    for raw_limit in raw_lengths:
        raw_limit = max(1, int(raw_limit))
        limit = _sqr_round_limit_manual(raw_limit)
        result.append((pos, limit))
        pos += raw_limit

    if requested == actual and actual > 1:
        notes.append(
            "手动分段初始化：请求 {req} 段，理论可行，采用“{minf}底座 + 余量均匀分摊”初始方案：{lens}。".format(
                req=actual,
                minf=min_seg_frames,
                lens="/".join(str(x) for x in raw_lengths),
            )
        )
    return result, actual, notes


def _sqr_normalize_resume_kind(value) -> str:
    kind = str(value or "").strip().lower()
    if kind in {"checkpoint_auto", "checkpoint_redesign", "manual_continuous", "manual_noncontinuous"}:
        return kind
    return ""


def _sqr_safe_run_mode(resume_enabled: bool, frame_offset: int, execution_scope: str, resume_kind: str = "") -> str:
    kind = _sqr_normalize_resume_kind(resume_kind)
    if execution_scope == "single_segment":
        return "segment_only"
    if kind == "manual_continuous":
        return "manual_continuous"
    if kind == "manual_noncontinuous":
        return "manual_noncontinuous"
    if frame_offset > 0:
        return "redesign"
    if resume_enabled:
        return "resume"
    return "normal"


def _sqr_progress_payload(uid, **kwargs):
    payload = {"unique_id": str(uid or "")}
    payload.update(kwargs)
    return payload


def _sqr_prepare_manual_splits(total_frames: int, split_points: list, min_seg_frames: int = MIN_SEG_FRAMES):
    total_frames = max(0, int(total_frames or 0))
    if total_frames <= 0:
        return [], []

    notes = []
    raw_points = []
    for raw in (split_points or []):
        try:
            raw_points.append(int(raw))
        except Exception:
            notes.append(f"已忽略无法解析的手动分割点: {raw!r}")

    if total_frames < min_seg_frames:
        if raw_points:
            notes.append(f"总帧数只有 {total_frames}，不足以支持手动多段分割，已忽略全部手动分割点。")
        return [], notes

    sanitized = []
    prev_boundary = 0
    unique_points = sorted(set(raw_points))
    min_k = math.ceil((min_seg_frames - 1) / 4)

    for raw in unique_points:
        if raw <= 0 or raw >= total_frames:
            notes.append(f"已忽略越界手动分割点: {raw}")
            continue

        min_allowed = prev_boundary + min_seg_frames
        max_allowed = total_frames - min_seg_frames
        if max_allowed <= prev_boundary:
            notes.append("后续分段空间不足，剩余手动分割点已忽略。")
            break

        max_k = math.floor((max_allowed - prev_boundary - 1) / 4)
        if max_k < min_k:
            notes.append("后续分段空间不足，剩余手动分割点已忽略。")
            break

        if raw < min_allowed or raw > max_allowed:
            notes.append(f"手动分割点 {raw} 超出可编辑区间 [{min_allowed}, {max_allowed}]，已自动吸附到合法位置。")

        k = round((raw - prev_boundary - 1) / 4)
        if k < min_k:
            k = min_k
        if k > max_k:
            k = max_k

        snapped = prev_boundary + k * 4 + 1
        if snapped <= prev_boundary or total_frames - snapped < min_seg_frames:
            notes.append(f"已忽略无法形成合法分段的手动分割点: {raw}")
            continue
        if snapped != raw:
            notes.append(f"手动分割点 {raw} 已吸附为 {snapped}")

        sanitized.append(snapped)
        prev_boundary = snapped

    deduped_notes = []
    seen = set()
    for note in notes:
        if note not in seen:
            deduped_notes.append(note)
            seen.add(note)
    return sanitized, deduped_notes


def _sqr_validate_seg_list(total_frames: int, seg_list: list, min_seg_frames: int = MIN_SEG_FRAMES) -> list[str]:
    total_frames = max(0, int(total_frames or 0))
    if total_frames <= 0:
        return ["总帧数必须大于 0。"]
    if not seg_list:
        return ["未生成任何有效分段。"]

    errs = []
    prev_skip = None
    for idx, seg in enumerate(seg_list, start=1):
        try:
            skip = int(seg[0])
            limit = int(seg[1])
        except Exception:
            errs.append(f"第{idx}段格式无效: {seg!r}")
            continue
        if skip < 0 or skip >= total_frames:
            errs.append(f"第{idx}段 skip 非法: {skip}")
        if limit <= 0:
            errs.append(f"第{idx}段 limit 非法: {limit}")
        if prev_skip is not None and skip - prev_skip < min_seg_frames:
            errs.append(f"第{idx-1}段与第{idx}段之间不足 {min_seg_frames} 帧。")
        prev_skip = skip

    if len(seg_list) > 1 and prev_skip is not None and total_frames - prev_skip < min_seg_frames:
        errs.append(f"最后一段不足 {min_seg_frames} 帧。")
    return errs


def calc_segments(total_frames: int, segments: int) -> list:
    result, _actual_segments, _notes = _sqr_calc_average_segments(total_frames, segments)
    return result


def calc_segments_by_fixed(total_frames: int, frames_per_seg: int, min_seg_frames: int = MIN_SEG_FRAMES) -> list:
    """固定每段帧数模式：每段 frames_per_seg 帧（必须4n+1），最后一段取剩余补到4n+1。
    如果剩余不足最小段长则合并到前一段。min_seg_frames 由上层传入（用户设置的下限）。"""
    total_frames = max(0, int(total_frames or 0))
    if total_frames <= 0:
        return []

    fps = max(int(min_seg_frames or MIN_SEG_FRAMES), ((int(frames_per_seg) - 1) // 4) * 4 + 1)
    result = []
    pos = 0
    while pos < total_frames:
        remaining = total_frames - pos
        if remaining <= fps:
            limit = _sqr_round_limit_up(remaining)
            if limit < int(min_seg_frames or MIN_SEG_FRAMES) and result:
                prev_skip, _prev_limit = result[-1]
                new_remaining = total_frames - prev_skip
                result[-1] = (prev_skip, _sqr_round_limit_up(new_remaining))
            else:
                result.append((pos, limit))
            break
        result.append((pos, fps))
        pos += fps
    if not result:
        result.append((0, _sqr_round_limit_up(total_frames)))
    return result


def calc_segments_manual(total_frames: int, split_points: list) -> list:
    """手动分段模式：split_points 是用户指定的分段起始帧列表（0-based skip值，不含第一段的0）。
    例如 [109, 202] 表示三段：0-108, 109-201, 202-end。
    每段 limit 补到 4n+1。"""
    total_frames = max(0, int(total_frames or 0))
    if total_frames <= 0:
        return []
    boundaries = [0] + sorted(int(x) for x in (split_points or [])) + [total_frames]
    result = []
    for i in range(len(boundaries) - 1):
        skip = boundaries[i]
        raw_limit = boundaries[i + 1] - skip
        limit = _sqr_round_limit_manual(raw_limit)
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


def _sqr_checkpoint_history_root() -> str:
    root = os.path.join(_sqr_plugin_dir(), "sqr_checkpoint_history")
    os.makedirs(root, exist_ok=True)
    return root


def _sqr_safe_name_fragment(value) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    safe = []
    for ch in raw:
        if ch.isalnum() or ch in ('-', '_'):
            safe.append(ch)
        else:
            safe.append('_')
    return ''.join(safe).strip('_')


def _sqr_checkpoint_history_path(unique_id, data: dict | None = None) -> str:
    data = data or {}
    uid = _sqr_safe_name_fragment(unique_id) or "anon"
    run_stamp = _sqr_safe_name_fragment(data.get("run_stamp"))
    if not run_stamp:
        run_stamp = _sqr_safe_name_fragment(data.get("timestamp"))
    if not run_stamp:
        run_stamp = _sqr_now_stamp()
    return os.path.join(_sqr_checkpoint_history_root(), f"sqr_checkpoint_{uid}_{run_stamp}.json")


def _sqr_write_json_atomic(path: str, payload: dict):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


def write_checkpoint(unique_id, data):
    try:
        payload = copy.deepcopy(data or {})
        if unique_id and not payload.get("unique_id"):
            payload["unique_id"] = unique_id
        path = get_checkpoint_path(unique_id)
        _sqr_write_json_atomic(path, payload)
        try:
            hist_path = _sqr_checkpoint_history_path(unique_id, payload)
            _sqr_write_json_atomic(hist_path, payload)
        except Exception as _hist_e:
            print(f"[SQR] checkpoint 历史归档写入失败: {_hist_e}")
        # 每次写入后顺便跑一次历史清理（有限频锁，基本零成本）
        try:
            _sqr_cleanup_checkpoint_history()
        except Exception:
            pass
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


def _sqr_read_checkpoint_from_path(path: str | None):
    rp = os.path.realpath(str(path or "").strip()) if path else ""
    if not rp or not os.path.isfile(rp):
        return None
    allowed_roots = [_sqr_plugin_dir(), _sqr_checkpoint_history_root()]
    if not any(rp.startswith(os.path.realpath(root) + os.sep) or rp == os.path.realpath(root) for root in allowed_roots):
        return None
    try:
        with open(rp, "r", encoding="utf-8") as f:
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

def _sqr_plugin_dir() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def _sqr_iter_checkpoint_file_paths(include_history: bool = True) -> list[str]:
    paths: list[str] = []
    seen: set[str] = set()
    plugin_dir = _sqr_plugin_dir()
    try:
        names = os.listdir(plugin_dir)
    except Exception:
        names = []
    for name in names:
        if not (name.startswith("sqr_checkpoint_") and name.endswith(".json")):
            continue
        p = os.path.join(plugin_dir, name)
        rp = os.path.realpath(p)
        if rp not in seen:
            seen.add(rp)
            paths.append(rp)
    if include_history:
        hist_root = _sqr_checkpoint_history_root()
        try:
            hnames = os.listdir(hist_root)
        except Exception:
            hnames = []
        for name in hnames:
            if not (name.startswith("sqr_checkpoint_") and name.endswith(".json")):
                continue
            p = os.path.join(hist_root, name)
            rp = os.path.realpath(p)
            if rp not in seen:
                seen.add(rp)
                paths.append(rp)
    return paths


def _sqr_resume_asset_root() -> str:
    root = os.path.join(_sqr_plugin_dir(), "sqr_resume_assets")
    os.makedirs(root, exist_ok=True)
    return root


def _sqr_resolve_plugin_path(path: str | None) -> str | None:
    raw = str(path or "").strip().strip('"').strip("'")
    if not raw:
        return None
    candidates = [raw]
    if not os.path.isabs(raw):
        candidates.append(os.path.join(_sqr_plugin_dir(), raw))
        candidates.append(os.path.join(_sqr_resume_asset_root(), raw))
    for cand in candidates:
        if os.path.exists(cand):
            return os.path.realpath(cand)
    return None


def _sqr_collect_active_resume_asset_dirs() -> set[str]:
    refs: set[str] = set()
    for ckpt_path in _sqr_iter_checkpoint_file_paths(include_history=True):
        try:
            with open(ckpt_path, "r", encoding="utf-8") as f:
                ck = json.load(f)
        except Exception:
            continue
        asset_dir = _sqr_resolve_plugin_path(ck.get("resume_ref_asset_dir", ""))
        if asset_dir and os.path.isdir(asset_dir):
            refs.add(os.path.realpath(asset_dir))
    return refs


def _sqr_cleanup_orphan_resume_assets(keep_dirs: list[str] | None = None, max_age_days: int = 14):
    import shutil
    root = _sqr_resume_asset_root()
    active_dirs = _sqr_collect_active_resume_asset_dirs()
    for kd in (keep_dirs or []):
        if kd:
            active_dirs.add(os.path.realpath(kd))
    now = time.time()
    min_age = max(0, int(max_age_days)) * 86400
    try:
        names = os.listdir(root)
    except Exception:
        return
    for name in names:
        ap = os.path.join(root, name)
        if not os.path.isdir(ap):
            continue
        rp = os.path.realpath(ap)
        if rp in active_dirs:
            continue
        try:
            if min_age > 0 and (now - os.path.getmtime(rp)) < min_age:
                continue
        except Exception:
            pass
        try:
            shutil.rmtree(rp, ignore_errors=True)
        except Exception:
            pass


# ── 历史 checkpoint 清理（已改为手动清理）─────────────────────
# 用户在续跑弹框的"清理模式"中手动删除，不再自动清理。
# 此函数保留为 no-op 以保持接口兼容。
def _sqr_cleanup_checkpoint_history(*args, **kwargs):
    return



def _sqr_freeze_resume_ref_assets(ref_images_list: list[str], unique_id=None, run_stamp: str | None = None):
    import shutil
    originals = [str(x).strip() for x in (ref_images_list or []) if str(x).strip()]
    if not originals:
        return {
            "resume_ref_asset_dir": "",
            "resume_ref_assets": [],
            "ref_images_original": [],
            "resume_ref_asset_manifest": "",
        }

    stamp = str(run_stamp or _sqr_now_stamp())
    asset_dir = os.path.join(_sqr_resume_asset_root(), f"{unique_id or 'anon'}_{stamp}", "refs")
    os.makedirs(asset_dir, exist_ok=True)

    assets: list[str] = []
    entries: list[dict] = []
    for idx, raw in enumerate(originals, start=1):
        src = _sqr_resolve_media_path(raw) or _sqr_resolve_plugin_path(raw)
        ext = ""
        if src:
            ext = os.path.splitext(src)[1]
        if not ext:
            ext = os.path.splitext(str(raw))[1] or ".png"
        dst_name = f"ref_{idx:03d}{ext.lower()}"
        dst = os.path.join(asset_dir, dst_name)
        exists = False
        stored = raw
        resolved = src or ""
        if src and os.path.isfile(src):
            try:
                if os.path.realpath(src) != os.path.realpath(dst):
                    shutil.copy2(src, dst)
                stored = os.path.realpath(dst)
                exists = True
                resolved = os.path.realpath(dst)
            except Exception:
                stored = src
                exists = os.path.isfile(src)
                resolved = src
        else:
            stored = raw
        assets.append(stored)
        entries.append({
            "index": idx,
            "source": raw,
            "asset": stored,
            "resolved": resolved,
            "exists": exists,
        })

    manifest = {
        "unique_id": unique_id,
        "run_stamp": stamp,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "ref_count": len(entries),
        "entries": entries,
    }
    manifest_path = os.path.join(os.path.dirname(asset_dir), "manifest.json")
    try:
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
    except Exception:
        manifest_path = ""

    return {
        "resume_ref_asset_dir": os.path.realpath(asset_dir),
        "resume_ref_assets": assets,
        "ref_images_original": originals,
        "resume_ref_asset_manifest": os.path.realpath(manifest_path) if manifest_path else "",
    }


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
    for _ in range(128):
        cand = f"{base}_{_sqr_now_stamp()}_{uuid.uuid4().hex[:8]}{ext}"
        if not os.path.exists(cand):
            return cand
    return f"{base}_{uuid.uuid4().hex}{ext}"


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

    plugin_path = _sqr_resolve_plugin_path(raw)
    if plugin_path and os.path.isfile(plugin_path):
        return plugin_path

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





def _sqr_get_video_cv_info(video_path: str | None) -> dict:
    info = {"frames": None, "fps": None, "width": None, "height": None}
    path = str(video_path or "").strip()
    if not path:
        return info
    try:
        import cv2
        cap = cv2.VideoCapture(path)
        if cap.isOpened():
            frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            info["frames"] = frames if frames > 0 else None
            info["fps"] = fps if fps > 0 else None
            info["width"] = width if width > 0 else None
            info["height"] = height if height > 0 else None
        cap.release()
    except Exception:
        pass
    return info


def _sqr_get_video_frame_count(video_path: str | None) -> int | None:
    info = _sqr_get_video_cv_info(video_path)
    frames = info.get("frames")
    if frames:
        return int(frames)
    return None


def _sqr_prepare_local_video_asset(raw_path: str | None, unique_id=None, prefix: str = "sqr_local"):
    path = _sqr_resolve_media_path(raw_path)
    if not path or not os.path.isfile(path):
        return None, {"frames": None, "fps": None, "width": None, "height": None}
    src_path = path
    try:
        path = _sqr_copy_into_input(path, unique_id=unique_id, prefix=prefix)
    except Exception:
        path = src_path
    return path, _sqr_get_video_cv_info(path)


def _sqr_clone_load_video_inputs(
    base_inputs: dict | None,
    video_name: str,
    skip_first_frames: int,
    frame_load_cap: int,
    *,
    sync_width_height: bool = True,
) -> dict:
    src = copy.deepcopy(base_inputs or {})
    out = {}
    for key in ("meta_batch", "vae", "force_rate", "format"):
        if key in src:
            out[key] = copy.deepcopy(src[key])
    if sync_width_height:
        for key in ("custom_width", "custom_height"):
            if key in src:
                out[key] = copy.deepcopy(src[key])
    else:
        out["custom_width"] = 0
        out["custom_height"] = 0
    out["video"] = video_name
    out["skip_first_frames"] = int(skip_first_frames)
    out["frame_load_cap"] = int(frame_load_cap)
    if "force_rate" not in out:
        out["force_rate"] = 0
    if "custom_width" not in out:
        out["custom_width"] = 0
    if "custom_height" not in out:
        out["custom_height"] = 0
    out["select_every_nth"] = 1
    if "format" not in out:
        out["format"] = "AnimateDiff"
    return out


def _sqr_compare_video_info(main_info: dict | None, local_info: dict | None) -> list[str]:
    diffs = []
    a = main_info or {}
    b = local_info or {}
    for key, label in (("frames", "帧数"), ("fps", "帧率"), ("width", "宽度"), ("height", "高度")):
        av = a.get(key)
        bv = b.get(key)
        if av is None or bv is None:
            continue
        if key == "fps":
            if abs(float(av) - float(bv)) > 0.01:
                diffs.append(f"{label}:{av}->{bv}")
        elif int(av) != int(bv):
            diffs.append(f"{label}:{av}->{bv}")
    return diffs



def _sqr_workflow_find_node(workflow, node_id):
    try:
        nid = int(node_id)
    except Exception:
        nid = None
    nodes = []
    if isinstance(workflow, dict):
        nodes = workflow.get("nodes") or []
    elif isinstance(workflow, list):
        nodes = workflow
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if nid is not None and node.get("id") == nid:
            return node
        if str(node.get("id")) == str(node_id):
            return node
    return None


def _sqr_extract_ref_video_params(workflow, node_id, fallback_inputs=None):
    src = fallback_inputs if isinstance(fallback_inputs, dict) else {}
    out = {
        "video": src.get("video", "") if not isinstance(src.get("video"), list) else "",
        "force_rate": src.get("force_rate", 0) if not isinstance(src.get("force_rate"), list) else 0,
        "custom_width": src.get("custom_width", 0) if not isinstance(src.get("custom_width"), list) else 0,
        "custom_height": src.get("custom_height", 0) if not isinstance(src.get("custom_height"), list) else 0,
        "frame_load_cap": src.get("frame_load_cap", 0) if not isinstance(src.get("frame_load_cap"), list) else 0,
        "skip_first_frames": src.get("skip_first_frames", 0) if not isinstance(src.get("skip_first_frames"), list) else 0,
        "select_every_nth": src.get("select_every_nth", 1) if not isinstance(src.get("select_every_nth"), list) else 1,
        "format": src.get("format", "AnimateDiff") if not isinstance(src.get("format"), list) else "AnimateDiff",
    }
    node = _sqr_workflow_find_node(workflow, node_id)
    if not isinstance(node, dict):
        return out
    wv = node.get("widgets_values")
    if isinstance(wv, dict):
        out["video"] = wv.get("video", out["video"])
        out["force_rate"] = wv.get("force_rate", out["force_rate"])
        out["custom_width"] = wv.get("custom_width", out["custom_width"])
        out["custom_height"] = wv.get("custom_height", out["custom_height"])
        out["frame_load_cap"] = wv.get("frame_load_cap", out["frame_load_cap"])
        out["skip_first_frames"] = wv.get("skip_first_frames", out["skip_first_frames"])
        out["select_every_nth"] = wv.get("select_every_nth", out["select_every_nth"])
        out["format"] = wv.get("format", out["format"])
    elif isinstance(wv, list) and wv:
        keys = ["video", "force_rate", "custom_width", "custom_height", "frame_load_cap", "skip_first_frames", "select_every_nth", "format"]
        for i, key in enumerate(keys):
            if i < len(wv):
                out[key] = wv[i]
    out["skip_first_frames"] = _sqr_nonneg_int(out.get("skip_first_frames"), 0)
    out["select_every_nth_raw"] = max(1, _sqr_nonneg_int(out.get("select_every_nth"), 1))
    out["select_every_nth"] = _sqr_normalize_select_every_nth(out.get("select_every_nth"))
    return out


def _sqr_guess_available_frames_without_video_info(connected_total_frames: int | None, ref_params: dict | None) -> int | None:
    """当无法读取视频真实信息时，尽量按“忽略 nth”语义回推可用帧数。

    优先目标：不要让 Load Video 因 select_every_nth>1 而把分段队列锁死在缩减后的 frame_count 上。
    这是一个兜底估算，不追求逐帧完全精确，但会优先尊重用户显式设置的 frame_load_cap。"""
    params = ref_params or {}
    connected = max(0, int(connected_total_frames or 0))
    nth_raw = max(1, _sqr_nonneg_int(params.get("select_every_nth_raw", params.get("select_every_nth")), 1))
    cap = _sqr_nonneg_int(params.get("frame_load_cap"), 0)

    if cap > 0:
        if nth_raw > 1 and connected > 0:
            return max(cap, connected * nth_raw)
        return cap

    if nth_raw > 1 and connected > 0:
        return connected * nth_raw

    return connected if connected > 0 else None


def _sqr_resolve_internal_total_frames(connected_total_frames: int | None, video_info: dict | None, ref_params: dict | None):
    """返回 (internal_total_frames, source_tag)。

    source_tag:
    - real_video: 通过真实视频信息 + Load Video 参数精确推导
    - fallback_guess: 在无法读取真实视频时，按忽略 nth 的语义兜底回推
    - connected_input: 直接退回上游连接输入值
    """
    corrected = _sqr_calc_effective_available_frames(video_info, ref_params)
    if corrected is not None and corrected > 0:
        return max(0, int(corrected)), "real_video"

    guessed = _sqr_guess_available_frames_without_video_info(connected_total_frames, ref_params)
    if guessed is not None and guessed > 0:
        return max(0, int(guessed)), "fallback_guess"

    connected = max(0, int(connected_total_frames or 0))
    return connected, "connected_input"


def _sqr_calc_effective_available_frames(video_info: dict | None, ref_params: dict | None) -> int | None:
    """按分段队列内部语义估算 Load Video 的可用帧数。

    规则与前端预览保持一致：
    1) 使用原视频真实帧数；
    2) 若 force_rate>0，则按保持时长不变重算帧数；
    3) 应用 skip_first_frames；
    4) 忽略 select_every_nth>1，统一视为 1；
    5) 仍然保留 frame_load_cap 上限。
    """
    info = video_info or {}
    params = ref_params or {}
    frames = info.get("frames")
    fps = info.get("fps")
    if not frames or int(frames) <= 0:
        return None

    available = int(frames)
    try:
        force_rate = float(params.get("force_rate") or 0)
    except Exception:
        force_rate = 0.0
    try:
        src_fps = float(fps or 0)
    except Exception:
        src_fps = 0.0
    if force_rate > 0 and src_fps > 0:
        available = int(round(available * force_rate / src_fps))

    skip_first = _sqr_nonneg_int(params.get("skip_first_frames"), 0)
    available = max(0, int(available) - skip_first)

    # 分段队列内部忽略 select_every_nth>1，统一按 1 处理；
    # 但 frame_load_cap 仍应保留，否则会出现后端总帧数大于 Load Video 实际可读上限的错觉。
    frame_load_cap = _sqr_nonneg_int(params.get("frame_load_cap"), 0)
    if frame_load_cap > 0:
        available = min(available, frame_load_cap)

    return max(0, int(available))

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
                    segment_mode="average", seg_list_override=None, execution_scope="start_to_end"):
    if total_frames <= 0:
        return "✗ total_frames 必须大于 0。"
    if seg_list_override is not None:
        seg_list = seg_list_override
    else:
        seg_list = calc_segments(total_frames, segments)
    start_from_segment = max(1, min(start_from_segment, len(seg_list)))
    start_idx = start_from_segment - 1
    single_segment = str(execution_scope or "start_to_end") == "single_segment"
    SEP = "═" * 45
    mode_label = {"average": "平均分段", "manual": "手动分段", "fixed": "固定每段帧数"}.get(segment_mode, "平均分段")
    scope_label = f"只跑第 {start_from_segment} 段" if single_segment else f"从第 {start_from_segment} 段开始"
    lines = [
        f"参考视频节点：{node_id}  总帧数：{total_frames}  模式：{mode_label}",
        f"共 {len(seg_list)} 段，执行范围：{scope_label}",
        "",
    ]
    for i, (skip, limit) in enumerate(seg_list):
        status = "→ 执行" if (i == start_idx if single_segment else i >= start_idx) else "  跳过"
        audio_s = skip / frame_rate if frame_rate > 0 else 0
        lines.append(f"  第{i+1}段 skip={skip} limit={limit} 音频={audio_s:.2f}s  {status}")
    lines.append(SEP)
    lines.append("")
    speed = load_speed_record()
    run_indices = [start_idx] if single_segment else list(range(start_idx, len(seg_list)))
    frames_to_run = sum(seg_list[ii][1] for ii in run_indices if 0 <= ii < len(seg_list))
    segs_to_run_n = len(run_indices)
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


WANANIMATEPLUS_ANIMATE_EMBEDS_CLASS = "WanAnimatePlus AnimateEmbeds"
WANANIMATEPLUS_SAMPLER_CLASSES = {
    "WanAnimatePlus Sampler",
    "WanAnimatePlus Samplerv2",
    "WanAnimatePlus SamplerFromSettings",
}


def find_animate_embeds_node(prompt: dict) -> str | None:
    for nid, node in prompt.items():
        if node.get("class_type") == WANANIMATEPLUS_ANIMATE_EMBEDS_CLASS:
            return nid
    return None


def _sqr_find_wananimateplus_sampler_nodes(prompt: dict) -> list[str]:
    return [
        str(nid)
        for nid, node in (prompt or {}).items()
        if isinstance(node, dict) and node.get("class_type") in WANANIMATEPLUS_SAMPLER_CLASSES
    ]


def _sqr_collect_prompt_upstream(node_id, prompt_output, visited: set[str]):
    nid = str(node_id)
    if nid in visited:
        return
    node = prompt_output.get(nid)
    if not isinstance(node, dict):
        return
    visited.add(nid)
    for val in (node.get("inputs") or {}).values():
        if isinstance(val, list) and len(val) == 2:
            src_id = str(val[0])
            if src_id in prompt_output:
                _sqr_collect_prompt_upstream(src_id, prompt_output, visited)


def _sqr_prune_prompt_to_roots(prompt_output: dict, root_ids, extra_keep_ids=None):
    if not isinstance(prompt_output, dict):
        return prompt_output, []
    keep: set[str] = set()
    for rid in (root_ids or []):
        if rid is None:
            continue
        _sqr_collect_prompt_upstream(str(rid), prompt_output, keep)
    for kid in (extra_keep_ids or []):
        sk = str(kid)
        if sk in prompt_output:
            keep.add(sk)
    pruned = {nid: prompt_output[nid] for nid in prompt_output.keys() if nid in keep}
    removed = [nid for nid in prompt_output.keys() if nid not in keep]
    return pruned, removed


def _sqr_child_extra_pnginfo(extra_pnginfo: dict | None) -> dict | None:
    workflow = (extra_pnginfo or {}).get("workflow")
    if isinstance(workflow, dict):
        return {"workflow": workflow}
    return None


def _sqr_vhs_latent_preview_state(extra_pnginfo: dict | None) -> str:
    try:
        extra = ((extra_pnginfo or {}).get("workflow") or {}).get("extra") or {}
        if "VHS_latentpreview" not in extra:
            return "missing"
        return "on" if bool(extra.get("VHS_latentpreview")) else "off"
    except Exception:
        return "missing"


def queue_prompt(workflow, host=None, client_id="", extra_pnginfo=None) -> str:
    body = {"prompt": workflow, "client_id": client_id}
    child_extra_pnginfo = _sqr_child_extra_pnginfo(extra_pnginfo)
    if child_extra_pnginfo:
        body["extra_data"] = {"extra_pnginfo": child_extra_pnginfo}
    payload = json.dumps(body).encode("utf-8")
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


def wait_for_prompt(prompt_id, host=None, poll=5, timeout=_DEFAULT_PROMPT_TIMEOUT_SECS,
                    max_consecutive_errors=120):
    start_ts = time.time()
    last_err = None
    consecutive_round_errors = 0

    while True:
        if timeout and (time.time() - start_ts) >= timeout:
            return False, f"等待超时（>{int(timeout)} 秒）"

        time.sleep(max(0.2, float(poll or 0)))
        round_ok = False
        for _host in [host or _sqr_get_comfy_host(), _sqr_get_comfy_host(force_refresh=True)]:
            try:
                with urllib.request.urlopen(f"http://{_host}/history/{prompt_id}", timeout=10) as resp:
                    history = json.loads(resp.read())
                round_ok = True
                if prompt_id in history:
                    st = history[prompt_id].get("status", {})
                    if st.get("completed"):
                        return True, "completed"
                    if st.get("status_str") == "error":
                        messages = []
                        outputs = history[prompt_id].get("outputs", {}) or {}
                        for _node_data in outputs.values():
                            for _msg in (_node_data.get("errors") or []):
                                if _msg:
                                    messages.append(str(_msg))
                        detail = f"history_status=error{' | ' + '; '.join(messages[:3]) if messages else ''}"
                        return False, detail
                    break
            except Exception as e:
                last_err = e
                continue

        if round_ok:
            consecutive_round_errors = 0
            continue

        consecutive_round_errors += 1
        if max_consecutive_errors and consecutive_round_errors >= int(max_consecutive_errors):
            return False, f"历史查询连续失败 {consecutive_round_errors} 轮：{last_err}"


def get_output_video_info(prompt_id, combine_node_id, host=None):
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
            gi_type = str(gi.get("type") or "output").lower()
            if gi_type == "output":
                base_dir = folder_paths.get_output_directory()
            elif gi_type == "temp":
                # save_output=false 时 VHS 会把文件写到 temp/ 目录，
                # 这里必须正确解析，否则后续过渡视频会拿不到路径。
                try:
                    base_dir = folder_paths.get_temp_directory()
                except Exception:
                    base_dir = folder_paths.get_output_directory()
            else:
                base_dir = folder_paths.get_input_directory()
            subfolder = gi.get("subfolder", "")
            video_path = os.path.join(base_dir, subfolder, gi["filename"]) if subfolder \
                         else os.path.join(base_dir, gi["filename"])
            import cv2
            cap = cv2.VideoCapture(video_path)
            frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) if cap.isOpened() else None
            cap.release()
            return video_path, frames
        except ImportError:
            print("[SQR] ✗ 获取视频帧数失败: opencv-python (cv2) 未安装，请执行 pip install opencv-python")
            return video_path, None
        except Exception as e:
            last_err = e
    print(f"[SQR] ✗ 获取视频信息失败: {last_err}")
    return None, None


def interrupt_current(host=None):
    for _host in [host or _sqr_get_comfy_host(), _sqr_get_comfy_host(force_refresh=True)]:
        try:
            urllib.request.urlopen(
                urllib.request.Request(f"http://{_host}/interrupt", data=b"", method="POST"), timeout=10)
            return
        except Exception:
            continue


TRANSITION_FRAMES = 21
TRANSITION_TRIM_HEAD = (TRANSITION_FRAMES + 1) // 2
TRANSITION_TRIM_TAIL = TRANSITION_FRAMES // 2
SQR_TRIM_MERGE_NEW = "split21"
SQR_TRIM_MERGE_OLD = "trim21"
SQR_TRIM_MERGE_NEW_LEGACY = "trim16"
SQR_TRIM_MERGE_OLD_LEGACY = "trim32"
WANANIMATEPLUS_TRIMS_TRANSITION_CANVAS = True


def _sqr_normalize_trim_merge_mode(value) -> str:
    mode = str(value or "").strip().lower()
    return SQR_TRIM_MERGE_OLD if mode in (SQR_TRIM_MERGE_OLD, SQR_TRIM_MERGE_OLD_LEGACY) else SQR_TRIM_MERGE_NEW


def _sqr_wananimateplus_output_frames(limit: int, use_transition: bool) -> int:
    limit = max(0, int(limit or 0))
    if not use_transition:
        return limit
    expanded = limit + TRANSITION_FRAMES
    aligned = max(0, expanded - ((expanded - 1) % 4))
    return max(0, aligned - TRANSITION_FRAMES)


def _sqr_build_trim_plan(seg_num: int, total_segs: int, use_transition: bool, limit: int, real_skip: int, trim_merge_mode: str,
                         has_prev: bool | None = None, has_next: bool | None = None) -> dict:
    mode = _sqr_normalize_trim_merge_mode(trim_merge_mode)
    total_raw = _sqr_wananimateplus_output_frames(limit, use_transition) if WANANIMATEPLUS_TRIMS_TRANSITION_CANVAS else limit + (TRANSITION_FRAMES if use_transition else 0)
    has_prev = bool(use_transition if has_prev is None else has_prev)
    has_next = bool((seg_num < total_segs) if has_next is None else has_next)

    if WANANIMATEPLUS_TRIMS_TRANSITION_CANVAS:
        trim_start = 0
        trim_tail = 0
        cut_audio_frames = real_skip
        if use_transition:
            align_note = "" if total_raw == int(limit or 0) else f"，4n+1对齐后实际{total_raw}帧"
            trim_desc = f"WanAnimatePlus已内裁过渡{TRANSITION_FRAMES}帧，外部不裁{align_note}→输出{total_raw}帧"
        elif has_next:
            trim_desc = f"首段无过渡，外部不裁→输出{total_raw}帧"
        else:
            trim_desc = f"单段不裁→输出{total_raw}帧"
        trim_len = max(0, total_raw - trim_start - trim_tail)
        return {
            "mode": mode,
            "total_raw": total_raw,
            "trim_start": trim_start,
            "trim_tail": trim_tail,
            "trim_len": trim_len,
            "cut_audio_frames": cut_audio_frames,
            "trim_desc": trim_desc,
        }

    if mode == SQR_TRIM_MERGE_OLD:
        if not use_transition:
            trim_start = 0
            trim_tail = 0
            trim_desc = f"首段不裁→输出{total_raw}帧"
        else:
            trim_start = TRANSITION_FRAMES
            trim_tail = 0
            trim_desc = f"裁前{TRANSITION_FRAMES}帧→输出{max(0, total_raw - TRANSITION_FRAMES)}帧"
        cut_audio_frames = real_skip
    else:
        if has_prev and has_next:
            trim_start = TRANSITION_TRIM_HEAD
            trim_tail = TRANSITION_TRIM_TAIL
            trim_desc = f"中间段/续跑首段裁前{trim_start}帧+裁尾{trim_tail}帧→输出{max(0, total_raw - TRANSITION_FRAMES)}帧"
        elif has_prev and not has_next:
            trim_start = TRANSITION_TRIM_HEAD
            trim_tail = 0
            trim_desc = f"末段/续跑末段裁前{trim_start}帧→输出{max(0, total_raw - trim_start)}帧"
        elif (not has_prev) and has_next:
            trim_start = 0
            trim_tail = TRANSITION_TRIM_TAIL
            trim_desc = f"首段裁尾{trim_tail}帧→输出{max(0, total_raw - trim_tail)}帧"
        else:
            trim_start = 0
            trim_tail = 0
            trim_desc = f"单段不裁→输出{total_raw}帧"
        cut_audio_frames = max(0, real_skip - trim_start)

    trim_len = max(0, total_raw - trim_start - trim_tail)
    return {
        "mode": mode,
        "total_raw": total_raw,
        "trim_start": trim_start,
        "trim_tail": trim_tail,
        "trim_len": trim_len,
        "cut_audio_frames": cut_audio_frames,
        "trim_desc": trim_desc,
    }


def _sqr_ffprobe_video_info(video_path: str) -> dict:
    import subprocess
    info = {"fps": None, "time_base": None, "width": None, "height": None, "codec": None, "pix_fmt": None, "has_audio": None}
    if not video_path or not os.path.isfile(video_path):
        return info
    try:
        cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", video_path]
        resp = subprocess.run(cmd, capture_output=True, text=True)
        if resp.returncode != 0:
            return info
        data = json.loads(resp.stdout or "{}")
        streams = data.get("streams") or []
        vstream = next((s for s in streams if s.get("codec_type") == "video"), None)
        if vstream:
            rfr = str(vstream.get("r_frame_rate") or "0/0")
            try:
                num, den = rfr.split("/", 1)
                num = float(num); den = float(den)
                if den:
                    info["fps"] = num / den
            except Exception:
                pass
            info["time_base"] = vstream.get("time_base")
            info["width"] = vstream.get("width")
            info["height"] = vstream.get("height")
            info["codec"] = vstream.get("codec_name")
            info["pix_fmt"] = vstream.get("pix_fmt")
        info["has_audio"] = any(s.get("codec_type") == "audio" for s in streams)
    except Exception:
        pass
    return info


def _sqr_video_merge_needs_normalize(video_paths: list, target_fps: float | None = None) -> tuple[bool, dict]:
    infos = [_sqr_ffprobe_video_info(p) for p in video_paths]
    reason = {"fps": set(), "time_base": set(), "size": set(), "codec": set(), "pix_fmt": set()}
    valid_fps = []
    for inf in infos:
        if inf.get("fps"):
            valid_fps.append(float(inf["fps"]))
            reason["fps"].add(round(float(inf["fps"]), 6))
        if inf.get("time_base"):
            reason["time_base"].add(str(inf["time_base"]))
        reason["size"].add((inf.get("width"), inf.get("height")))
        if inf.get("codec"):
            reason["codec"].add(str(inf["codec"]))
        if inf.get("pix_fmt"):
            reason["pix_fmt"].add(str(inf["pix_fmt"]))
    # 仅在检测到分段之间规格不一致时才 normalize（重编码）；
    # 同一次 SQR 运行内分段都来自同一个 VHS_VideoCombine，规格天然一致，
    # 此时直接走 -c copy 无损拼接，避免对画质的损伤。
    need = False
    if len(reason["fps"]) > 1 or len(reason["time_base"]) > 1 or len(reason["size"]) > 1 or len(reason["codec"]) > 1 or len(reason["pix_fmt"]) > 1:
        need = True
    normalized = {
        "target_fps": float(target_fps) if target_fps and target_fps > 0 else (sum(valid_fps) / len(valid_fps) if valid_fps else None),
        "reason": {k: sorted(list(v)) for k, v in reason.items() if v},
        "infos": infos,
    }
    return need, normalized


def _sqr_media_meta_root() -> str:
    root = os.path.join(_sqr_plugin_dir(), "sqr_media_meta")
    os.makedirs(root, exist_ok=True)
    return root


def _sqr_media_meta_legacy_path(video_path: str) -> str:
    return f"{video_path}.sqrmeta.json"


def _sqr_media_meta_path(video_path: str) -> str:
    raw = str(video_path or "")
    real = os.path.realpath(raw) if raw else raw
    key_src = real or raw
    digest = hashlib.sha1(key_src.encode("utf-8", errors="ignore")).hexdigest()[:16]
    base_name = os.path.basename(real or raw or "video")
    safe_name = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in base_name).strip("._") or "video"
    return os.path.join(_sqr_media_meta_root(), f"{digest}__{safe_name}.sqrmeta.json")


def _sqr_write_media_meta(video_path: str, data: dict):
    try:
        meta_path = _sqr_media_meta_path(video_path)
        os.makedirs(os.path.dirname(meta_path), exist_ok=True)
        tmp_path = f"{meta_path}.{uuid.uuid4().hex}.tmp"
        payload = dict(data or {})
        payload.setdefault("schema", 1)
        payload.setdefault("video_path", os.path.realpath(video_path) if video_path else str(video_path or ""))
        payload.setdefault("meta_storage", "plugin_dir")
        payload.setdefault("meta_path", os.path.realpath(meta_path))
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, meta_path)
    except Exception as e:
        print(f"[SQR] ⚠ 写入媒体元数据失败: {e}")



def _sqr_read_media_meta(video_path: str) -> dict | None:
    try:
        candidates = [_sqr_media_meta_path(video_path), _sqr_media_meta_legacy_path(video_path)]
        for meta_path in candidates:
            if not os.path.exists(meta_path):
                continue
            with open(meta_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        return None
    except Exception:
        return None
def _sqr_ffprobe_duration_seconds(video_path: str) -> float | None:
    import subprocess
    if not video_path or not os.path.isfile(video_path):
        return None
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            video_path,
        ]
        resp = subprocess.run(cmd, capture_output=True, text=True)
        if resp.returncode != 0:
            return None
        val = float((resp.stdout or "").strip() or 0)
        return val if val > 0 else None
    except Exception:
        return None



def _sqr_ffprobe_has_audio(video_path: str) -> bool:
    return bool(_sqr_ffprobe_video_info(video_path).get("has_audio"))



def _sqr_frames_to_seconds(frame_count: int | float | None, fps: float | int | None) -> float | None:
    try:
        frames = float(frame_count)
        fps_val = float(fps)
    except Exception:
        return None
    if frames < 0 or fps_val <= 1e-9:
        return None
    return frames / fps_val



def _sqr_positive_float(value) -> float | None:
    try:
        v = float(value)
    except Exception:
        return None
    return v if v > 1e-9 else None


def _sqr_prepare_audio_slice(start_frames: int | float | None, requested_frames: int | float | None, fps: float | int | None,
                             max_total_frames: int | float | None = None) -> dict | None:
    try:
        start_val = int(round(float(start_frames or 0)))
        req_val = int(round(float(requested_frames or 0)))
        fps_val = float(fps or 0)
    except Exception:
        return None
    if start_val < 0:
        start_val = 0
    if fps_val <= 1e-9:
        return None
    if max_total_frames is not None:
        try:
            total_val = int(round(float(max_total_frames)))
        except Exception:
            total_val = None
        if total_val is not None:
            req_val = min(req_val, max(0, total_val - start_val))
    if req_val <= 0:
        return None
    start_sec = _sqr_frames_to_seconds(start_val, fps_val)
    duration_sec = _sqr_frames_to_seconds(req_val, fps_val)
    if start_sec is None or duration_sec is None or duration_sec <= 1e-9:
        return None
    return {
        "start_frames": start_val,
        "duration_frames": req_val,
        "start_sec": start_sec,
        "duration_sec": duration_sec,
    }


def _sqr_resolve_timeline_fps(fallback_fps: float | int | None,
                              source_fps: float | int | None = None,
                              force_rate: float | int | None = None,
                              select_every_nth: int | float | None = 1) -> float | None:
    fallback = _sqr_positive_float(fallback_fps)
    source = _sqr_positive_float(source_fps)
    forced = _sqr_positive_float(force_rate)
    # 分段队列内部忽略 select_every_nth>1，统一按 1 处理。
    _ = _sqr_normalize_select_every_nth(select_every_nth)
    base = forced or source
    if base is not None and base > 1e-9:
        return base
    return fallback

def _sqr_meta_timeline_fps(meta: dict | None, fallback_fps: float | int | None = None) -> float | None:
    m = meta or {}
    return (
        _sqr_positive_float(m.get("frame_rate_timeline"))
        or _sqr_positive_float(m.get("frame_rate_used"))
        or _sqr_positive_float(fallback_fps)
    )



def _sqr_collect_continuous_audio_frames(media_paths: list[str] | None, fallback_fps: float | int | None = None) -> int:
    total_frames = 0
    fps_val = None
    try:
        fps_val = float(fallback_fps)
    except Exception:
        fps_val = None
    for raw_path in (media_paths or []):
        path = str(raw_path or "").strip()
        if not path:
            continue
        meta = _sqr_read_media_meta(path) or {}
        seg_fps = _sqr_meta_timeline_fps(meta, fps_val)
        frame_candidates = [
            meta.get("audio_frame_count"),
            meta.get("kept_frame_count"),
            meta.get("trim_len"),
        ]
        seg_frames = None
        for cand in frame_candidates:
            try:
                if cand is not None:
                    seg_frames = int(round(float(cand)))
                    if seg_frames >= 0:
                        break
            except Exception:
                continue
        if seg_frames is None:
            dur = meta.get("duration_sec")
            try:
                dur = float(dur)
            except Exception:
                dur = None
            if dur and dur > 0 and seg_fps and seg_fps > 1e-9:
                seg_frames = int(round(dur * seg_fps))
        if seg_frames is None:
            seg_frames = _sqr_get_video_frame_count(path)
        if seg_frames is None:
            dur_probe = _sqr_ffprobe_duration_seconds(path)
            if dur_probe and seg_fps and seg_fps > 1e-9:
                seg_frames = int(round(float(dur_probe) * seg_fps))
        if seg_frames and seg_frames > 0:
            total_frames += int(seg_frames)
    return max(0, int(total_frames))



def _sqr_replace_video_audio(video_path: str, audio_source_path: str, audio_start_sec: float,
                             duration_sec: float | None = None, output_path: str | None = None) -> tuple[bool, str]:
    import subprocess
    if not video_path or not os.path.isfile(video_path):
        return False, "视频文件不存在"
    src = _sqr_resolve_media_path(audio_source_path) or str(audio_source_path or "")
    if not src or not os.path.isfile(src):
        return False, "音频源不存在"
    if not _sqr_ffprobe_has_audio(src):
        return False, "音频源中没有可用音轨"
    target_path = output_path or video_path
    out_dir = os.path.dirname(os.path.realpath(target_path)) or os.getcwd()
    fd, tmp_path = tempfile.mkstemp(prefix="sqr_audio_remux_", suffix=".mp4", dir=out_dir)
    os.close(fd)
    try:
        start_sec = max(0.0, float(audio_start_sec or 0.0))
        dur_sec = None
        if duration_sec is not None:
            try:
                dur_sec = float(duration_sec)
            except Exception:
                dur_sec = None
        if dur_sec is not None and dur_sec <= 0:
            dur_sec = None

        trim_expr = f"atrim=start={start_sec:.6f}"
        if dur_sec is not None:
            trim_expr += f":duration={dur_sec:.6f}"

        cmd = [
            "ffmpeg", "-y",
            "-i", video_path,
            "-i", src,
            "-filter_complex", f"[1:a:0]{trim_expr},asetpts=PTS-STARTPTS[aout]",
            "-map", "0:v:0",
            "-map", "[aout]",
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            tmp_path,
        ]
        resp = subprocess.run(cmd, capture_output=True, text=True)
        if resp.returncode != 0:
            return False, (resp.stderr or "ffmpeg failed")[-400:]
        os.replace(tmp_path, target_path)
        return True, os.path.basename(target_path)
    except FileNotFoundError:
        return False, "未找到 ffmpeg/ffprobe"
    except Exception as e:
        return False, str(e)
    finally:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except Exception:
            pass


def merge_videos(video_paths: list, output_path: str, target_fps: float = None, log=None) -> bool:
    import subprocess
    import shutil
    _emit = log if callable(log) else (lambda msg: print(f"[SQR] {msg}"))
    if not video_paths:
        return False

    # 入口环境检查：明确告诉用户是否缺 ffmpeg
    if shutil.which("ffmpeg") is None:
        _emit("✗ 视频合并失败：未在系统 PATH 中找到 ffmpeg")
        _emit("  解决方案：")
        _emit("    Windows: 下载 https://www.gyan.dev/ffmpeg/builds/ 解压后将 bin 目录加入 PATH")
        _emit("    macOS:   brew install ffmpeg")
        _emit("    Linux:   apt install ffmpeg / yum install ffmpeg")
        _emit("    整合包:  检查整合包是否自带 ffmpeg，或单独下载 ffmpeg.exe 放到 ComfyUI 根目录")
        return False

    list_path = None
    converted: list[str] = []
    try:
        need_normalize, normalize_info = _sqr_video_merge_needs_normalize(video_paths, target_fps=target_fps)
        merge_sources = list(video_paths)
        if not need_normalize:
            _emit(f"视频合并：检测到 {len(video_paths)} 段视频规格一致，使用 -c copy 无损直接合并（零画质损失）")
        else:
            # 列出具体不一致维度
            _reason = normalize_info.get("reason") or {}
            _diff_items = []
            for _k in ("fps", "codec", "pix_fmt", "size", "time_base"):
                _vs = _reason.get(_k)
                if _vs and len(_vs) > 1:
                    _diff_items.append(f"{_k}={_vs}")
            _diff_desc = " | ".join(_diff_items) if _diff_items else "(未知差异)"
            fps_val = normalize_info.get("target_fps") or target_fps or 16.0
            fps_str = f"{float(fps_val):.6f}".rstrip("0").rstrip(".")
            _emit(f"视频合并：检测到 {len(video_paths)} 段视频规格不一致，将统一转码后合并（轻微画质损失）")
            _emit(f"  不一致项: {_diff_desc}")
            _emit(f"  统一目标 fps: {fps_str}")
            merge_sources = []
            for vp in video_paths:
                fd, tmp = tempfile.mkstemp(prefix="sqr_merge_norm_", suffix=".mp4")
                os.close(fd)
                cv_cmd = [
                    "ffmpeg", "-y", "-i", vp,
                    "-r", fps_str,
                    "-vsync", "cfr",
                    "-video_track_timescale", "90000",
                    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k",
                    tmp,
                ]
                r2 = subprocess.run(cv_cmd, capture_output=True, text=True)
                if r2.returncode != 0:
                    _emit(f"✗ 统一化转码失败: {os.path.basename(vp)} | {r2.stderr[-300:]}")
                    return False
                converted.append(tmp)
                merge_sources.append(tmp)

        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
            for p in merge_sources:
                esc = str(p).replace("'", "'\''")
                f.write(f"file '{esc}'\n")

            list_path = f.name

        cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path, "-c", "copy", output_path]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return True
        _emit(f"✗ ffmpeg concat 失败（{'统一化' if need_normalize else '-c copy'} 模式）: {result.stderr[-300:]}")
        return False
    except FileNotFoundError:
        _emit("✗ 未找到 ffmpeg/ffprobe，请确认系统已安装并在 PATH 中")
        return False
    finally:
        if list_path and os.path.exists(list_path):
            try:
                os.unlink(list_path)
            except Exception:
                pass
        for _tmp in converted:
            try:
                if _tmp and os.path.exists(_tmp):
                    os.unlink(_tmp)
            except Exception:
                pass


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
                "分段数": ("INT", {"default": 2, "min": 1, "max": 1001, "step": 1, "display": "slider",
                    "tooltip": "分几段处理（可在设置处更改最大分段数）。固定每段帧数模式下此值为每段帧数。\nNumber of segments (max adjustable in settings). In fixed mode this is frames per segment."}),
                "从第几段开始": ("INT", {"default": 1, "min": 1, "max": 100, "step": 1, "display": "slider",
                    "tooltip": "从第几段开始生成，续跑时填写实际起始段。\nStart from which segment. Set accordingly when resuming."}),
                "执行": ("BOOLEAN", {"default": False,
                    "tooltip": "关闭=预览分段规划；开启=正式执行。\nOff=preview plan only; On=start execution."}),
                "启用续跑": ("BOOLEAN", {"default": False,
                    "tooltip": "开启后使用上方选择的视频作为首段过渡起点。\nEnable resume: use selected video as transition source for first segment."}),
                "参考视频节点ID": ("STRING", {"default": ""}),
                "输出节点ID":     ("STRING", {"default": ""}),
                "动作嵌入节点ID": ("STRING", {"default": ""}),
                "姿态模型节点ID": ("STRING", {"default": ""}),
                "脸部模型节点ID": ("STRING", {"default": ""}),
                "参考图节点ID":   ("STRING", {"default": ""}),
                "分段参考图":     ("STRING", {"default": ""}),
                "续跑视频路径":   ("STRING", {"default": ""}),
                "本地姿态视频路径": ("STRING", {"default": ""}),
                "本地人脸视频路径": ("STRING", {"default": ""}),
                "sqr_save_png":      ("STRING", {"default": "true"}),
                "sqr_min_seg_frames": ("STRING", {"default": "41"}),
                "sqr_frame_offset":  ("INT",    {"default": -1}),
                "sqr_pre_segments":  ("STRING", {"default": ""}),
                "sqr_segment_mode":  ("STRING", {"default": "average"}),
                "sqr_trim_merge_mode": ("STRING", {"default": "split21"}),
                "sqr_manual_splits": ("STRING", {"default": ""}),
                "sqr_execution_scope": ("STRING", {"default": "start_to_end"}),
                "sqr_resume_kind": ("STRING", {"default": ""}),
                "sqr_real_total_frames": ("INT", {"default": -1}),
                "sqr_real_fps":      ("FLOAT", {"default": -1.0}),
            },
            "hidden": {
                "过渡跳过帧数": ("INT", {"default": -1}),
                "prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "unique_id": "UNIQUE_ID",
            },
        }

    def run(self,
            总帧数, 帧率, 分段数, 从第几段开始,
            执行, 启用续跑,
            参考视频节点ID, 输出节点ID, 动作嵌入节点ID, 姿态模型节点ID, 脸部模型节点ID, 参考图节点ID,
            分段参考图, 续跑视频路径, 本地姿态视频路径="", 本地人脸视频路径="",
            sqr_save_png="true",
            sqr_min_seg_frames="41",
            sqr_frame_offset=-1,
            sqr_pre_segments="",
            sqr_segment_mode="average",
            sqr_trim_merge_mode="split21",
            sqr_manual_splits="",
            sqr_execution_scope="start_to_end",
            sqr_resume_kind="",
            sqr_real_total_frames=-1,
            sqr_real_fps=-1.0,
            过渡跳过帧数=-1,
            prompt=None, extra_pnginfo=None, unique_id=None):

        total_frames       = 总帧数
        segments           = 分段数
        node_id            = 参考视频节点ID.strip()
        frame_rate         = 帧率
        combine_nid        = 输出节点ID.strip()
        ae_node_id         = 动作嵌入节点ID.strip()
        pose_node_id       = 姿态模型节点ID.strip()
        face_node_id       = 脸部模型节点ID.strip()
        resume_video_path  = 续跑视频路径.strip()
        local_pose_video_raw = str(本地姿态视频路径 or "").strip()
        local_face_video_raw = str(本地人脸视频路径 or "").strip()
        resume_enabled     = bool(启用续跑) and bool(resume_video_path)
        skip_frames_manual = 过渡跳过帧数
        ri_node_id         = 参考图节点ID.strip()
        ref_imgs_str       = 分段参考图.strip()
        _segment_mode      = str(sqr_segment_mode or "average").strip()
        _trim_merge_mode   = _sqr_normalize_trim_merge_mode(sqr_trim_merge_mode)
        _manual_splits_str = str(sqr_manual_splits or "").strip()
        _execution_scope = str(sqr_execution_scope or "start_to_end").strip()
        if _execution_scope not in ("start_to_end", "single_segment"):
            _execution_scope = "start_to_end"
        _resume_kind = _sqr_normalize_resume_kind(sqr_resume_kind)
        _segment_only_mode = (_execution_scope == "single_segment")

        # 问题2: 解析前端传来的最小段长设置（来自设置面板的 fixedFrameMin，范围 41-361）
        # 所有分段计算和日志提示都要用这个动态值，而不是硬编码的 MIN_SEG_FRAMES 常量
        try:
            _min_seg_frames = int(float(str(sqr_min_seg_frames or "").strip() or MIN_SEG_FRAMES))
        except Exception:
            _min_seg_frames = MIN_SEG_FRAMES
        # clamp 到合法范围并对齐到 4n+1
        _min_seg_frames = max(MIN_SEG_FRAMES, min(361, _min_seg_frames))
        _min_seg_frames = ((_min_seg_frames - 1) // 4) * 4 + 1
        if _min_seg_frames < MIN_SEG_FRAMES:
            _min_seg_frames = MIN_SEG_FRAMES

        _frame_offset_param = sqr_frame_offset if sqr_frame_offset >= 0 else -1
        if _frame_offset_param < 0 and prompt and unique_id:
            _self_inputs = (prompt or {}).get(str(unique_id), {}).get("inputs", {})
            _fo_val = _self_inputs.get("sqr_frame_offset", -1)
            _frame_offset_param = int(_fo_val) if _fo_val is not None and int(_fo_val) >= 0 else -1
        _frame_offset = _frame_offset_param if _frame_offset_param >= 0 else 0

        _plan_total_frames = int(total_frames or 0)
        try:
            _plan_main_lv_inputs = (prompt or {}).get(str(node_id), {}).get("inputs", {}) if node_id else {}
        except Exception:
            _plan_main_lv_inputs = {}
        _plan_ref_params = _sqr_extract_ref_video_params((extra_pnginfo or {}).get("workflow"), node_id, _plan_main_lv_inputs)
        _plan_ref_video_info = {"frames": None, "fps": None, "width": None, "height": None}
        _plan_ref_video_name = str(_plan_ref_params.get("video") or "").strip()
        if _plan_ref_video_name:
            _plan_ref_real_path = _sqr_resolve_media_path(_plan_ref_video_name)
            if _plan_ref_real_path and os.path.isfile(_plan_ref_real_path):
                _plan_ref_video_info = _sqr_get_video_cv_info(_plan_ref_real_path)
        _plan_total_frames, _plan_total_source = _sqr_resolve_internal_total_frames(_plan_total_frames, _plan_ref_video_info, _plan_ref_params)

        _plan_frames = max(1, _plan_total_frames - _frame_offset) if _frame_offset > 0 else _plan_total_frames
        _segment_adjust_notes = []
        _preview_seg_list = []

        # 根据分段模式计算 seg_list（预览用）
        if _segment_mode == "fixed":
            _preview_seg_list = calc_segments_by_fixed(_plan_frames, segments, min_seg_frames=_min_seg_frames)
            # 固定模式下 segments 是"每段帧数"滑条的实际值，日志里用这个值最直观
            _fixed_per_seg_display = max(int(_min_seg_frames), ((int(segments) - 1) // 4) * 4 + 1)
            if len(_preview_seg_list) != max(1, (int(_plan_frames) + _fixed_per_seg_display - 1) // _fixed_per_seg_display) and _plan_frames >= _min_seg_frames:
                _segment_adjust_notes.append(f"固定分段模式下已根据每段 {_fixed_per_seg_display} 帧的设置自动调整为 {len(_preview_seg_list)} 段。")
        elif _segment_mode == "manual":
            if _manual_splits_str:
                _split_pts_raw = [int(x.strip()) for x in _manual_splits_str.split(",") if x.strip().lstrip("-").isdigit()]
                _split_pts, _manual_notes = _sqr_prepare_manual_splits(_plan_frames, _split_pts_raw, min_seg_frames=_min_seg_frames)
                _segment_adjust_notes.extend(_manual_notes)
                _preview_seg_list = calc_segments_manual(_plan_frames, _split_pts)
            else:
                _preview_seg_list, _preview_actual_segments, _manual_seed_notes = _sqr_calc_manual_seed_segments(_plan_frames, segments, min_seg_frames=_min_seg_frames)
                _segment_adjust_notes.extend(_manual_seed_notes)
        else:
            _preview_seg_list, _preview_actual_segments, _preview_avg_notes = _sqr_calc_average_segments(_plan_frames, segments, min_seg_frames=_min_seg_frames)
            _segment_adjust_notes.extend(_preview_avg_notes)

        _preview_segments = max(1, len(_preview_seg_list)) if _preview_seg_list else max(1, int(segments or 1))
        _preview_seg_errs = _sqr_validate_seg_list(_plan_frames, _preview_seg_list, min_seg_frames=_min_seg_frames)
        if _preview_seg_errs:
            _segment_adjust_notes.extend(_preview_seg_errs)

        start_from_segment = max(1, min(从第几段开始, _preview_segments))
        plan_text = build_plan_text(
            _plan_frames, _preview_segments, start_from_segment, node_id, frame_rate,
            segment_mode=_segment_mode, seg_list_override=_preview_seg_list, execution_scope=_execution_scope)
        if _segment_adjust_notes:
            plan_text = "\n".join(f"[SQR] ⚠ {x}" for x in _segment_adjust_notes) + "\n\n" + plan_text

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
            # 需求6: 手动分段 + 预览模式 → 触发猫猫扭蛋彩蛋（不再跑分段计划预览）23333谁能第一个发现？
            if _segment_mode == "manual":
                _sqr_progress_set(unique_id, **_sqr_progress_payload(
                    unique_id,
                    status="easter_egg_gacha",
                    run_mode="easter_egg",
                    current_segment=0,
                    total_segments=0,
                    completed_segments=0,
                    current_stage="gacha",
                    execution_scope=_execution_scope,
                    last_message="🎰 触发猫猫扭蛋彩蛋",
                ))
                _sqr_log(unique_id, "[SQR] 🎰 手动分段 + 预览模式 = 触发猫猫扭蛋彩蛋")
                def _pi_egg(): time.sleep(0.005); _do_interrupt()
                threading.Thread(target=_pi_egg, daemon=True).start()
                return {}

            _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="planning", run_mode=_sqr_safe_run_mode(resume_enabled, _frame_offset, _execution_scope, _resume_kind), current_segment=0, total_segments=len(_preview_seg_list), completed_segments=0, current_stage="preview", execution_scope=_execution_scope, last_message="预览模式"))
            msg = "[预览模式]\n" + plan_text
            def _pi(): time.sleep(0.005); _do_interrupt()
            threading.Thread(target=_pi, daemon=True).start()
            _sqr_log(unique_id, msg)
            return {}

        if total_frames <= 0:
            _sqr_log(unique_id, "[SQR] ✗ 总帧数必须大于 0。")
            _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="error", run_mode="aborted", current_segment=0, total_segments=0, completed_segments=0, current_stage="aborted", execution_scope=_execution_scope, last_message="总帧数必须大于 0"))
            return {}
        if not node_id:
            _sqr_log(unique_id, "[SQR] ✗ 参考视频节点ID 不能为空。")
            _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="error", run_mode="aborted", current_segment=0, total_segments=0, completed_segments=0, current_stage="aborted", execution_scope=_execution_scope, last_message="参考视频节点ID 不能为空"))
            return {}

        _sqr_full_prompt = (extra_pnginfo or {}).get("sqr_full_prompt")
        _effective_prompt = _sqr_full_prompt if _sqr_full_prompt else prompt
        _need_interrupt = (_sqr_full_prompt is None)
        _client_id = str((extra_pnginfo or {}).get("sqr_client_id") or "")
        _is_remote = bool((extra_pnginfo or {}).get("sqr_is_remote", False))

        if node_id not in (_effective_prompt or {}):
            _sqr_log(unique_id, f"[SQR] ✗ 找不到节点 ID「{node_id}」（完整工作流中）。")
            _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="error", run_mode="aborted", current_segment=0, total_segments=0, completed_segments=0, current_stage="aborted", execution_scope=_execution_scope, last_message=f"找不到节点 ID {node_id}"))
            return {}

        print(f"[SQR] sqr_frame_offset: 参数={sqr_frame_offset}, 实际使用={_frame_offset}"
              f" | 工作流来源={'extra_pnginfo' if _sqr_full_prompt else 'prompt(回退)'}"
              f" | 分段模式={_segment_mode}")
        _run_mode = _sqr_safe_run_mode(resume_enabled, _frame_offset, _execution_scope, _resume_kind)
        base_prompt = copy.deepcopy(_effective_prompt)

        _runtime_main_lv_inputs = base_prompt.get(node_id, {}).get("inputs", {}) if node_id else {}
        _runtime_ref_params = _sqr_extract_ref_video_params((extra_pnginfo or {}).get("workflow"), node_id, _runtime_main_lv_inputs)
        _runtime_ref_video_info = {"frames": None, "fps": None, "width": None, "height": None}
        _runtime_ref_video_name = str(_runtime_ref_params.get("video") or "").strip()
        if _runtime_ref_video_name:
            _runtime_ref_real_path = _sqr_resolve_media_path(_runtime_ref_video_name)
            if _runtime_ref_real_path and os.path.isfile(_runtime_ref_real_path):
                _runtime_ref_video_info = _sqr_get_video_cv_info(_runtime_ref_real_path)
        _runtime_total_frames = int(total_frames or 0)
        _runtime_resolved_total, _runtime_total_source = _sqr_resolve_internal_total_frames(_runtime_total_frames, _runtime_ref_video_info, _runtime_ref_params)
        if _runtime_resolved_total > 0:
            if _runtime_total_frames != _runtime_resolved_total:
                if _runtime_total_source == "real_video":
                    _sqr_log(unique_id, f"[SQR] ℹ Load Video 时序已按 skip_first_frames 修正可用帧数：输入总帧数={_runtime_total_frames} → 实际可用帧数={_runtime_resolved_total}（select_every_nth 始终按1处理）")
                elif _runtime_total_source == "fallback_guess":
                    _sqr_log(unique_id, f"[SQR] ℹ 无法直接读取视频真实帧数，已按 Load Video 参数回推内部可用帧数：输入总帧数={_runtime_total_frames} → 估算可用帧数={_runtime_resolved_total}（select_every_nth 始终按1处理）")
            _runtime_total_frames = _runtime_resolved_total
        _effective_frames = max(1, _runtime_total_frames - _frame_offset) if _frame_offset > 0 else _runtime_total_frames

        _runtime_seg_notes = []
        if _segment_mode == "fixed":
            seg_list = calc_segments_by_fixed(_effective_frames, segments, min_seg_frames=_min_seg_frames)
            _fixed_per_seg_display = max(int(_min_seg_frames), ((int(segments) - 1) // 4) * 4 + 1)
            if len(seg_list) != max(1, (int(_effective_frames) + _fixed_per_seg_display - 1) // _fixed_per_seg_display) and _effective_frames >= _min_seg_frames:
                _runtime_seg_notes.append(f"固定分段模式下已根据每段 {_fixed_per_seg_display} 帧的设置自动调整为 {len(seg_list)} 段。")
        elif _segment_mode == "manual":
            if _manual_splits_str:
                _split_pts_raw = [int(x.strip()) for x in _manual_splits_str.split(",") if x.strip().lstrip("-").isdigit()]
                _split_pts, _manual_notes = _sqr_prepare_manual_splits(_effective_frames, _split_pts_raw, min_seg_frames=_min_seg_frames)
                _runtime_seg_notes.extend(_manual_notes)
                _manual_splits_str = ",".join(str(x) for x in _split_pts)
                seg_list = calc_segments_manual(_effective_frames, _split_pts)
            else:
                seg_list, _runtime_actual_segments, _manual_seed_notes = _sqr_calc_manual_seed_segments(_effective_frames, segments, min_seg_frames=_min_seg_frames)
                _runtime_seg_notes.extend(_manual_seed_notes)
        else:
            seg_list, _runtime_actual_segments, _runtime_avg_notes = _sqr_calc_average_segments(_effective_frames, segments, min_seg_frames=_min_seg_frames)
            _runtime_seg_notes.extend(_runtime_avg_notes)

        _seg_errs = _sqr_validate_seg_list(_effective_frames, seg_list, min_seg_frames=_min_seg_frames)
        if _seg_errs:
            _sqr_log(unique_id, "\n".join(f"[SQR] ✗ {x}" for x in _seg_errs))
            _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="error", run_mode=_run_mode, current_segment=0, total_segments=max(1, len(seg_list)), completed_segments=0, current_stage="aborted", execution_scope=_execution_scope, last_message="分段校验失败"))
            return {}
        if _runtime_seg_notes:
            _sqr_log(unique_id, "\n".join(f"[SQR] ⚠ {x}" for x in _runtime_seg_notes))

        start_from_segment = max(1, min(start_from_segment, max(1, len(seg_list))))
        start_idx   = start_from_segment - 1
        segs_to_run = [seg_list[start_idx]] if _segment_only_mode else seg_list[start_idx:]

        ae_nid = ae_node_id or find_animate_embeds_node(base_prompt) or ""
        vc_nid = find_video_combine_node(base_prompt, combine_nid) or ""

        ref_images_list = [x.strip() for x in ref_imgs_str.split(",") if x.strip()]                           if ref_imgs_str else []
        ref_images_original = list(ref_images_list)
        resume_ref_asset_dir = ""
        resume_ref_assets = []
        resume_ref_asset_manifest = ""
        if unique_id:
            try:
                _frozen_refs = _sqr_freeze_resume_ref_assets(ref_images_list, unique_id=unique_id, run_stamp=_sqr_now_stamp())
                resume_ref_asset_dir = _frozen_refs.get("resume_ref_asset_dir", "")
                resume_ref_assets = list(_frozen_refs.get("resume_ref_assets", []) or [])
                resume_ref_asset_manifest = _frozen_refs.get("resume_ref_asset_manifest", "") or ""
                if resume_ref_assets:
                    ref_images_list = resume_ref_assets
                    print(f"[SQR] ✓ 已固化续跑参考图资产: {len(resume_ref_assets)} 张")
            except Exception as _freeze_e:
                print(f"[SQR] ⚠ 固化续跑参考图资产失败: {_freeze_e}")
        _sqr_cleanup_orphan_resume_assets(keep_dirs=[resume_ref_asset_dir] if resume_ref_asset_dir else None)

        manual_video_path = manual_video_frames = None
        if resume_enabled and resume_video_path:
            p = _sqr_resolve_media_path(resume_video_path)
            if p and os.path.isfile(p):
                try:
                    src_p = p
                    p = _sqr_copy_into_input(p, unique_id=unique_id, prefix="sqr_resume")
                    if os.path.realpath(src_p) != os.path.realpath(p):
                        print(f"[SQR] 已复制续跑视频到 input/: {os.path.basename(p)}")
                    fname = os.path.basename(p)
                    import cv2
                    cap = cv2.VideoCapture(p)
                    if cap.isOpened():
                        manual_video_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                        cap.release()
                    manual_video_path = p
                    print(f"[SQR] ✓ 续跑视频: {fname} ({manual_video_frames}帧)")
                except ImportError:
                    _sqr_log(unique_id, "[SQR] ✗ opencv-python (cv2) 未安装，无法读取续跑视频帧数，请执行 pip install opencv-python")
                    manual_video_path = p
                    manual_video_frames = None
                except Exception as e:
                    print(f"[SQR] ✗ 读取续跑视频失败: {e}")
            else:
                print(f"[SQR] ⚠ 续跑视频不存在或无法解析: {resume_video_path}")

        local_pose_video_path = None
        local_face_video_path = None
        local_pose_video_info = {"frames": None, "fps": None, "width": None, "height": None}
        local_face_video_info = {"frames": None, "fps": None, "width": None, "height": None}
        main_ref_video_info = {"frames": None, "fps": None, "width": None, "height": None}
        main_ref_video_name = ""

        _main_lv_inputs = base_prompt.get(node_id, {}).get("inputs", {}) if node_id else {}
        _main_lv_video = _main_lv_inputs.get("video", "") if isinstance(_main_lv_inputs, dict) else ""
        if isinstance(_main_lv_video, str) and _main_lv_video:
            main_ref_video_name = os.path.basename(_main_lv_video)
            _main_real_path = _sqr_resolve_media_path(_main_lv_video)
            if _main_real_path and os.path.isfile(_main_real_path):
                main_ref_video_info = _sqr_get_video_cv_info(_main_real_path)

        def log(msg: str):
            _sqr_log(unique_id, f"[SQR] {msg}")

        main_ref_params = _runtime_ref_params if '_runtime_ref_params' in locals() else _sqr_extract_ref_video_params((extra_pnginfo or {}).get("workflow"), node_id, _main_lv_inputs)
        main_ref_skip_first = _sqr_nonneg_int(main_ref_params.get("skip_first_frames"), 0)
        if _sqr_nonneg_int((_main_lv_inputs or {}).get("select_every_nth"), 1) > 1:
            log("ℹ 检测到 Load Video 的 select_every_nth>1，分段队列内部已强制按 1 处理。")
        _main_source_fps = _sqr_positive_float(sqr_real_fps) or _sqr_positive_float(main_ref_video_info.get("fps"))
        audio_timeline_fps = _sqr_resolve_timeline_fps(
            frame_rate,
            source_fps=_main_source_fps,
            force_rate=main_ref_params.get("force_rate"),
            select_every_nth=main_ref_params.get("select_every_nth"),
        ) or _sqr_positive_float(frame_rate) or 0.0

        if local_pose_video_raw:
            local_pose_video_path, local_pose_video_info = _sqr_prepare_local_video_asset(local_pose_video_raw, unique_id=unique_id, prefix="sqr_pose")
        if local_face_video_raw:
            local_face_video_path, local_face_video_info = _sqr_prepare_local_video_asset(local_face_video_raw, unique_id=unique_id, prefix="sqr_face")

        if 执行:
            _errs = []
            if local_pose_video_raw and not pose_node_id:
                _errs.append("已选择本地姿态视频，但未填写姿态模型节点ID。")
            if local_face_video_raw and not face_node_id:
                _errs.append("已选择本地人脸视频，但未填写脸部模型节点ID。")
            if (local_pose_video_raw or local_face_video_raw) and not ae_nid:
                _errs.append(f"已选择本地姿态/人脸视频，但未填写 {WANANIMATEPLUS_ANIMATE_EMBEDS_CLASS} 节点ID。")
            if ae_nid and ae_nid not in base_prompt:
                _errs.append(f"{WANANIMATEPLUS_ANIMATE_EMBEDS_CLASS} 节点ID无效: {ae_nid}")
            elif ae_nid and base_prompt.get(ae_nid, {}).get("class_type") != WANANIMATEPLUS_ANIMATE_EMBEDS_CLASS:
                _errs.append(f"节点[{ae_nid}]不是 {WANANIMATEPLUS_ANIMATE_EMBEDS_CLASS}。")
            if local_pose_video_raw:
                if pose_node_id and pose_node_id not in base_prompt:
                    _errs.append(f"姿态模型节点ID无效: {pose_node_id}")
                if not local_pose_video_path:
                    _errs.append(f"本地姿态视频不存在或无法解析: {local_pose_video_raw}")
            if local_face_video_raw:
                if face_node_id and face_node_id not in base_prompt:
                    _errs.append(f"脸部模型节点ID无效: {face_node_id}")
                if not local_face_video_path:
                    _errs.append(f"本地人脸视频不存在或无法解析: {local_face_video_raw}")
            if not _errs:
                _main_ref_params_for_local = main_ref_params
                _needs_end = 0
                _total_frames_bound = max(0, int(_runtime_total_frames or 0))
                for _seg_skip, _seg_limit in segs_to_run:
                    _seg_end = int(_seg_skip) + int(_frame_offset) + int(_seg_limit)
                    if _total_frames_bound > 0:
                        _seg_end = min(_seg_end, _total_frames_bound)
                    _needs_end = max(_needs_end, _seg_end)
                if local_pose_video_path:
                    _pose_avail = _sqr_calc_effective_available_frames(local_pose_video_info, _main_ref_params_for_local)
                    if _pose_avail is not None and _pose_avail < _needs_end:
                        _errs.append(f"本地姿态视频可用帧数不足：按主参考时序策略最多可覆盖 {_pose_avail} 帧，但本次分段最远将访问到第 {_needs_end} 帧。")
                if local_face_video_path:
                    _face_avail = _sqr_calc_effective_available_frames(local_face_video_info, _main_ref_params_for_local)
                    if _face_avail is not None and _face_avail < _needs_end:
                        _errs.append(f"本地人脸视频可用帧数不足：按主参考时序策略最多可覆盖 {_face_avail} 帧，但本次分段最远将访问到第 {_needs_end} 帧。")
            if _errs:
                _msg = "\n".join(f"[SQR] ✗ {x}" for x in _errs)
                _sqr_log(unique_id, _msg)
                return {}

        width_src = height_src = None
        target_inputs = base_prompt.get(node_id, {}).get("inputs", {})
        if "custom_width" in target_inputs and isinstance(target_inputs["custom_width"], list):
            width_src = target_inputs["custom_width"]
        if "custom_height" in target_inputs and isinstance(target_inputs["custom_height"], list):
            height_src = target_inputs["custom_height"]

        _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="queued", run_mode=_run_mode, current_segment=0, total_segments=len(segs_to_run), completed_segments=0, current_stage="queued", execution_scope=_execution_scope, last_message="等待后台线程启动"))

        audio_filename = find_audio_filename(base_prompt, node_id)
        audio_source_path = _sqr_resolve_media_path(audio_filename) if audio_filename else None
        if audio_filename:
            _sqr_log(unique_id, f"[SQR] 音频文件: {audio_filename}")
        else:
            _sqr_log(unique_id, f"[SQR] ⚠ 无法获取音频文件名")
        _src_fps_log = _main_source_fps if _main_source_fps is not None else 0.0
        _force_rate_log = _sqr_positive_float(main_ref_params.get("force_rate")) or 0.0
        try:
            _nth_log = max(1, int(round(float(main_ref_params.get("select_every_nth") or 1))))
        except Exception:
            _nth_log = 1
        _sqr_log(unique_id, f"[SQR] 音频时间轴FPS: 输入={float(frame_rate):.6f} 使用={float(audio_timeline_fps):.6f} 原始={float(_src_fps_log):.6f} force_rate={float(_force_rate_log):.6f} nth={_nth_log}")

        image_src_node = None
        if vc_nid and vc_nid in base_prompt:
            img_input = base_prompt[vc_nid]["inputs"].get("images")
            if isinstance(img_input, list) and len(img_input) == 2:
                image_src_node = img_input
                print(f"[SQR] 图像来源: {image_src_node}")

        pre_segment_paths = []
        if sqr_pre_segments.strip():
            for _p in [p.strip() for p in sqr_pre_segments.split(",") if p.strip()]:
                _rp = _sqr_resolve_media_path(_p)
                if _rp and os.path.isfile(_rp):
                    pre_segment_paths.append(_rp)
        if pre_segment_paths:
            print(f"[SQR] 续跑前段素材: {len(pre_segment_paths)} 个文件")

        assembled_audio_start_sec = None
        assembled_audio_start_frame = None
        assembled_audio_source_path = audio_source_path
        assembled_audio_meta = _sqr_read_media_meta(pre_segment_paths[0]) if pre_segment_paths else None
        assembled_audio_total_frames = _sqr_collect_continuous_audio_frames(pre_segment_paths, audio_timeline_fps)
        assembled_audio_can_remux = (_run_mode in {"normal", "resume", "redesign", "manual_continuous"})
        assembled_audio_reason = ""
        if pre_segment_paths:
            if assembled_audio_meta and str(assembled_audio_meta.get("audio_mode") or "").startswith("continuous_original"):
                _meta_start_frame = assembled_audio_meta.get("audio_start_frame")
                try:
                    if _meta_start_frame is not None:
                        assembled_audio_start_frame = max(0, int(round(float(_meta_start_frame))))
                except Exception:
                    assembled_audio_start_frame = None
                if assembled_audio_start_frame is None:
                    _meta_start_sec = assembled_audio_meta.get("audio_start_sec")
                    try:
                        if _meta_start_sec is not None:
                            assembled_audio_start_sec = max(0.0, float(_meta_start_sec))
                    except Exception:
                        assembled_audio_start_sec = None
                    if assembled_audio_start_sec is not None:
                        _meta_fps = _sqr_meta_timeline_fps(assembled_audio_meta, audio_timeline_fps)
                        try:
                            if _meta_fps is not None:
                                assembled_audio_start_frame = max(0, int(round(assembled_audio_start_sec * float(_meta_fps))))
                        except Exception:
                            assembled_audio_start_frame = None
                if assembled_audio_start_frame is not None:
                    assembled_audio_start_sec = _sqr_frames_to_seconds(assembled_audio_start_frame, audio_timeline_fps)
                meta_source = assembled_audio_meta.get("audio_source_path") or assembled_audio_source_path
                if meta_source:
                    assembled_audio_source_path = meta_source
                if audio_source_path and assembled_audio_source_path:
                    try:
                        if os.path.realpath(str(audio_source_path)) != os.path.realpath(str(assembled_audio_source_path)):
                            assembled_audio_can_remux = False
                            assembled_audio_reason = "前段素材音频源与当前参考视频不一致"
                    except Exception:
                        pass
            elif assembled_audio_can_remux:
                assembled_audio_can_remux = False
                assembled_audio_reason = "前段素材缺少连续音频元数据，无法安全重贴原始音频"

        run_stamp = _sqr_now_stamp()

        def submit_all():
            nonlocal assembled_audio_start_sec, assembled_audio_start_frame, assembled_audio_total_frames
            _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="running", run_mode=_run_mode, current_segment=0, total_segments=len(segs_to_run), completed_segments=0, current_stage="preparing", execution_scope=_execution_scope, last_message="开始准备分段任务"))
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
            if _segment_only_mode:
                log(f"=== 试跑模式：仅执行第{start_from_segment}段 ===")
            elif _run_mode == "manual_continuous":
                log("=== 手动续跑（连续型）===")
            elif _run_mode == "manual_noncontinuous":
                log("=== 手动续跑（非连续型）===")
            elif _frame_offset > 0:
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
            if local_pose_video_path:
                _pose_desc = os.path.basename(local_pose_video_path)
                _pose_frames = local_pose_video_info.get("frames")
                _pose_tail = f" ({_pose_frames}帧)" if _pose_frames else ""
                log(f"✓ 本地姿态视频: {_pose_desc}{_pose_tail} → 接管姿态输入，旁路节点[{pose_node_id}]")
                log("  ✓ 姿态读取策略: 跟随主参考Load Video的帧率、宽高、帧数读取上限、跳过前X帧、间隔、格式与每段skip/limit")
            if local_face_video_path:
                _face_desc = os.path.basename(local_face_video_path)
                _face_frames = local_face_video_info.get("frames")
                _face_tail = f" ({_face_frames}帧)" if _face_frames else ""
                log(f"✓ 本地人脸视频: {_face_desc}{_face_tail} → 接管人脸输入，旁路节点[{face_node_id}]")
                log("  ✓ 人脸读取策略: 跟随主参考Load Video的帧率、帧数读取上限、跳过前X帧、间隔、格式与每段skip/limit，宽高保持原视频")

            for i, (skip, limit) in enumerate(segs_to_run):
                seg_num        = start_idx + i + 1
                total_segs     = len(seg_list)
                use_transition = last_video_path is not None
                _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="running", run_mode=_run_mode, current_segment=seg_num, total_segments=total_segs, completed_segments=i, current_stage="segment_prepare", execution_scope=_execution_scope, last_message=f"准备第{seg_num}段"))
                wf             = copy.deepcopy(base_prompt)
                audio_skip_frames = skip

                _actual_skip = skip + _frame_offset
                _source_skip = main_ref_skip_first + _actual_skip
                if _frame_offset > 0:
                    log(f"--- 第{seg_num}/{total_segs}段  实际skip={_actual_skip}（段内{skip}+偏移{_frame_offset}）source_skip={_source_skip} limit={limit} ---")
                else:
                    log(f"--- 第{seg_num}/{total_segs}段  skip={_actual_skip} source_skip={_source_skip} limit={limit} ---")

                wf[node_id]["inputs"]["skip_first_frames"] = _source_skip
                wf[node_id]["inputs"]["frame_load_cap"]    = limit
                wf[node_id]["inputs"]["select_every_nth"]  = 1

                _real_skip = skip + _frame_offset
                is_last_seg = (seg_num == total_segs)
                trim_plan = _sqr_build_trim_plan(seg_num, total_segs, use_transition, limit, _real_skip, _trim_merge_mode, has_prev=use_transition, has_next=(seg_num < total_segs))
                audio_skip_frames = main_ref_skip_first + trim_plan["cut_audio_frames"]

                if vc_nid and vc_nid in wf and audio_filename:
                    if use_transition and not WANANIMATEPLUS_TRIMS_TRANSITION_CANVAS:
                        main_audio_frames = max(0, main_ref_skip_first + _real_skip - TRANSITION_FRAMES)
                        transition_note   = f"主节点source_skip{main_ref_skip_first}+{_real_skip}-{TRANSITION_FRAMES}={main_audio_frames}帧, cut_vc skip={audio_skip_frames}帧"
                    else:
                        main_audio_frames = main_ref_skip_first + _real_skip
                        if use_transition:
                            transition_note = f"WanAnimatePlus内裁后主节点source_skip={main_audio_frames}帧, cut_vc skip={audio_skip_frames}帧"
                        else:
                            transition_note = f"主节点source_skip={main_audio_frames}帧, cut_vc skip={audio_skip_frames}帧"
                    main_audio_duration_frames = max(0, int(trim_plan.get("total_raw") or limit or 0))
                    _audio_source_total_frames = max(0, int(main_ref_skip_first + total_frames))
                    _main_audio_slice = _sqr_prepare_audio_slice(
                        main_audio_frames,
                        main_audio_duration_frames,
                        audio_timeline_fps,
                        _audio_source_total_frames,
                    )
                    if _main_audio_slice:
                        audio_tmp_id = f"sqr_audio_{seg_num}"
                        wf[audio_tmp_id] = {
                            "class_type": "VHS_LoadAudioUpload",
                            "inputs": {
                                "audio":      audio_filename,
                                "start_time": _main_audio_slice["start_sec"],
                                "duration":   _main_audio_slice["duration_sec"],
                            }
                        }
                        wf[vc_nid]["inputs"]["audio"] = [audio_tmp_id, 0]
                        log(f"  ✓ 主节点音频: start={_main_audio_slice['start_sec']:.3f}s duration={_main_audio_slice['duration_sec']:.3f}s ({transition_note})")
                    else:
                        if use_transition:
                            wf[vc_nid]["inputs"].pop("audio", None)
                            log(f"  ⚠ 主节点音频切片无有效长度，已跳过挂载 ({transition_note})")
                        else:
                            wf[vc_nid]["inputs"]["audio"] = [node_id, 2]
                            log(f"  ⚠ 主节点音频切片无有效长度，回退为LoadVideo音频(skip={skip}帧)")
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

                    _main_lv_node = wf.get(node_id, {})
                    _main_lv_inputs_seg = _main_lv_node.get("inputs", {}) if isinstance(_main_lv_node, dict) else {}
                    _loadvideo_class = _main_lv_node.get("class_type", "VHS_LoadVideo") if isinstance(_main_lv_node, dict) else "VHS_LoadVideo"
                    if local_pose_video_path:
                        pose_lv_id = f"sqr_pose_lv_{seg_num}"
                        wf[pose_lv_id] = {
                            "class_type": _loadvideo_class,
                            "inputs": _sqr_clone_load_video_inputs(
                                _main_lv_inputs_seg,
                                os.path.basename(local_pose_video_path),
                                _source_skip,
                                limit,
                                sync_width_height=True,
                            )
                        }
                        wf[ae_nid]["inputs"]["pose_images"] = [pose_lv_id, 0]
                        log(f"  ✓ 本地姿态输入: {os.path.basename(local_pose_video_path)} skip={_actual_skip} limit={limit} → pose_images（帧率/宽高/间隔/格式均跟随主参考），旁路节点[{pose_node_id}]")
                    if local_face_video_path:
                        face_lv_id = f"sqr_face_lv_{seg_num}"
                        wf[face_lv_id] = {
                            "class_type": _loadvideo_class,
                            "inputs": _sqr_clone_load_video_inputs(
                                _main_lv_inputs_seg,
                                os.path.basename(local_face_video_path),
                                _source_skip,
                                limit,
                                sync_width_height=False,
                            )
                        }
                        wf[ae_nid]["inputs"]["face_images"] = [face_lv_id, 0]
                        log(f"  ✓ 本地人脸输入: {os.path.basename(local_face_video_path)} skip={_actual_skip} limit={limit} → face_images（时序参数跟随主参考，宽高保持原视频），旁路节点[{face_node_id}]")

                if ref_images_list and ri_node_id and ri_node_id in wf:
                    img_idx   = min(i, len(ref_images_list) - 1)
                    img_entry = ref_images_list[img_idx]
                    try:
                        img_real = _sqr_resolve_media_path(img_entry) or _sqr_resolve_plugin_path(img_entry) or img_entry
                        img_input_path = _sqr_copy_into_input(img_real, unique_id=unique_id, prefix="sqr_refrun")
                        img_name = os.path.basename(img_input_path)
                    except Exception as e:
                        img_name = os.path.basename(str(img_entry)) if os.path.isabs(str(img_entry)) else str(img_entry)
                        log(f"  ⚠ 参考图复制失败: {e}")
                    wf[ri_node_id]["inputs"]["image"] = img_name
                    wv = wf[ri_node_id].get("widgets_values", [])
                    if wv: wv[0] = img_name
                    log(f"  ✓ 参考图[{img_idx+1}]: {img_name}")

                image_src = image_src_node
                trim_start = trim_plan["trim_start"]
                trim_len   = trim_plan["trim_len"]
                ifb_a = f"sqr_ifb_{seg_num}_a"
                wf[ifb_a] = {"class_type": "ImageFromBatch",
                             "inputs": {"image": image_src, "batch_index": trim_start, "length": trim_len}}
                final_image_node = ifb_a
                log(f"  输出帧数: {trim_len}帧")

                cut_vc_id = None
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
                    _cut_dir_name = f"sqr_cut_{run_stamp}"
                    _cut_suffix = "_only" if _segment_only_mode else ""
                    _cut_file_prefix = f"sqr_cut_{run_stamp}_seg{seg_num}{_cut_suffix}_"
                    cut_inputs["filename_prefix"] = f"{_subfolder_prefix}{_cut_dir_name}/{_cut_file_prefix}"

                    if audio_filename:
                        _audio_source_total_frames = max(0, int(main_ref_skip_first + total_frames))
                        _cut_audio_slice = _sqr_prepare_audio_slice(
                            audio_skip_frames,
                            trim_len,
                            audio_timeline_fps,
                            _audio_source_total_frames,
                        )
                        if _cut_audio_slice:
                            cut_audio_id = f"sqr_cut_audio_{seg_num}"
                            wf[cut_audio_id] = {
                                "class_type": "VHS_LoadAudioUpload",
                                "inputs": {
                                    "audio":      audio_filename,
                                    "start_time": _cut_audio_slice["start_sec"],
                                    "duration":   _cut_audio_slice["duration_sec"],
                                }
                            }
                            cut_inputs["audio"] = [cut_audio_id, 0]
                            log(f"  ✓ cut_vc音频: start={_cut_audio_slice['start_sec']:.3f}s duration={_cut_audio_slice['duration_sec']:.3f}s (start={_cut_audio_slice['start_frames']}帧 len={_cut_audio_slice['duration_frames']}帧)")
                            if assembled_audio_start_frame is None and not pre_segment_paths:
                                assembled_audio_start_frame = max(0, int(_cut_audio_slice["start_frames"]))
                                assembled_audio_start_sec = _sqr_frames_to_seconds(assembled_audio_start_frame, audio_timeline_fps) or 0.0
                        else:
                            cut_inputs.pop("audio", None)
                            log(f"  ⚠ cut_vc音频切片无有效长度，已跳过挂载 (start={audio_skip_frames}帧 len={trim_len}帧)")

                    wf[cut_vc_id] = {"class_type": "VHS_VideoCombine", "inputs": cut_inputs}
                    _cut_search_dir = os.path.join(folder_paths.get_output_directory(),
                                                   _subfolder_prefix.rstrip("/\\"),
                                                   _cut_dir_name) \
                                      if _subfolder_prefix else os.path.join(folder_paths.get_output_directory(), _cut_dir_name)
                    sqr_cut_cleanup.append((_cut_search_dir, _cut_file_prefix))

                if unique_id and unique_id in wf:
                    del wf[unique_id]

                exec_root_ids = []
                if cut_vc_id and cut_vc_id in wf:
                    exec_root_ids.append(cut_vc_id)
                if vc_nid and vc_nid in wf:
                    exec_root_ids.append(vc_nid)
                if not exec_root_ids:
                    if ae_nid and ae_nid in wf:
                        exec_root_ids.append(ae_nid)
                    elif node_id in wf:
                        exec_root_ids.append(node_id)

                # ── 保留预览分支 ──────────────────────────────
                # preview 类型节点（VHS_VideoCombine / PreviewImage 等）如果被 prune 剔除，
                # 用户就看不到中间结果预览。
                # 保留策略（反转逻辑）：
                #   默认保留所有预览节点，仅排除那些上溯链路经过"被旁路节点"的预览 VC。
                #   被旁路节点 = 姿态/面部模型节点在使用了缓存视频时被 rewire 跳过，
                #   此时这些节点的链路不会执行，它们下游的预览也没有意义且会拉回昂贵计算。
                try:
                    _PREVIEW_TYPES = {
                        "PreviewImage", "SaveImage",
                        "PreviewAudio",
                        "VHS_VideoCombine",
                    }
                    # 构建被旁路的节点集合
                    _bypass_ids = set()
                    if pose_node_id and local_pose_video_path:
                        _bypass_ids.add(str(pose_node_id))
                    if face_node_id and local_face_video_path:
                        _bypass_ids.add(str(face_node_id))

                    def _reaches_bypass(start_id, cache):
                        """上溯 BFS：检查从 start_id 出发能否到达任何被旁路节点。"""
                        if start_id in cache:
                            return cache[start_id]
                        stack = [start_id]
                        visited = set()
                        hit = False
                        while stack:
                            cur = str(stack.pop())
                            if cur in visited:
                                continue
                            visited.add(cur)
                            if cur in _bypass_ids:
                                hit = True
                                break
                            _cn = wf.get(cur)
                            if not isinstance(_cn, dict):
                                continue
                            for _v in (_cn.get("inputs") or {}).values():
                                if isinstance(_v, list) and len(_v) == 2:
                                    stack.append(str(_v[0]))
                        for v in visited:
                            cache[v] = cache.get(v, False) or hit
                        return hit

                    _reach_cache = {}
                    _kept_preview_count = 0
                    for _nid, _n in list(wf.items()):
                        if not isinstance(_n, dict):
                            continue
                        if _n.get("class_type") not in _PREVIEW_TYPES:
                            continue
                        _snid = str(_nid)
                        # 跳过 cut_vc 和主 vc — 它们已在 exec_root_ids 里
                        if _snid == str(cut_vc_id or "") or _snid == str(vc_nid or ""):
                            continue
                        # 默认保留；仅当存在旁路节点且该 VC 上溯能到达旁路节点时排除
                        if _bypass_ids and _reaches_bypass(_snid, _reach_cache):
                            continue
                        if _snid not in exec_root_ids:
                            exec_root_ids.append(_snid)
                            _kept_preview_count += 1
                    if _kept_preview_count > 0:
                        log(f"  ✓ 保留 {_kept_preview_count} 个预览节点用于实时预览")
                except Exception as _prev_e:
                    print(f"[SQR] ⚠ 预览节点保留失败（不影响主流程）: {_prev_e}")

                if exec_root_ids:
                    _wf_before = len(wf)
                    wf, _removed_ids = _sqr_prune_prompt_to_roots(wf, exec_root_ids)
                    _prune_notes = []
                    if local_pose_video_path and pose_node_id:
                        if str(pose_node_id) in _removed_ids:
                            _prune_notes.append(f"姿态节点[{pose_node_id}]已剔除")
                        elif str(pose_node_id) in wf:
                            _prune_notes.append(f"姿态节点[{pose_node_id}]仍在执行图")
                    if local_face_video_path and face_node_id:
                        if str(face_node_id) in _removed_ids:
                            _prune_notes.append(f"脸部节点[{face_node_id}]已剔除")
                        elif str(face_node_id) in wf:
                            _prune_notes.append(f"脸部节点[{face_node_id}]仍在执行图")
                    _note_suffix = f"，{'；'.join(_prune_notes)}" if _prune_notes else ""
                    log(f"  ✓ 已精简执行图: {_wf_before}→{len(wf)} 节点（保留分段输出与过渡缓存输出）{_note_suffix}")

                _sampler_ids = _sqr_find_wananimateplus_sampler_nodes(wf)
                _client_note = f"{_client_id[:8]}..." if _client_id else "(empty)"
                _vhs_preview_state = _sqr_vhs_latent_preview_state(extra_pnginfo)
                if _sampler_ids:
                    log(f"  ✓ 动态采样预览: client_id={_client_note} sampler={','.join(_sampler_ids)} VHS_latentpreview={_vhs_preview_state}")
                else:
                    log("  ⚠ 动态采样预览: 提交图中未找到 WanAnimatePlus Sampler/Samplerv2/SamplerFromSettings")
                if not _client_id:
                    log("  ⚠ 动态采样预览: client_id 为空，WanAnimatePlus 预览事件无法推送到当前浏览器")
                if _vhs_preview_state != "on":
                    log("  ⚠ 动态采样预览: 未检测到 VHS.LatentPreview=on，VideoHelperSuite 动态预览包装器可能不会启用")

                log(f"  → 提交中...")
                try:
                    pid = queue_prompt(wf, client_id=_client_id, extra_pnginfo=extra_pnginfo)
                    _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="running", run_mode=_run_mode, current_segment=seg_num, total_segments=total_segs, completed_segments=i, current_stage="segment_wait", execution_scope=_execution_scope, last_message=f"第{seg_num}段已提交，等待完成"))
                    log(f"  prompt_id={pid[:8]}...")
                    ok, wait_reason = wait_for_prompt(pid)
                    if ok:
                        log(f"✓ 第{seg_num}段完成")
                        if is_last_seg:
                            _all_done = True
                        if unique_id and (not _is_remote) and not _segment_only_mode:
                            _lv_inputs = base_prompt.get(node_id, {}).get("inputs", {})
                            _ref_video_params = _sqr_extract_ref_video_params((extra_pnginfo or {}).get("workflow"), node_id, _lv_inputs)
                            _next_seg_idx = seg_num
                            if _next_seg_idx < len(seg_list):
                                _frame_offset_for_resume = _frame_offset + seg_list[_next_seg_idx][0]
                            else:
                                _frame_offset_for_resume = _frame_offset + (skip + limit)
                            _trans_fname = f"sqr_trans_{run_stamp}_seg{seg_num}.mp4"
                            write_checkpoint(unique_id, {
                                "unique_id":              unique_id,
                                "run_stamp":                 run_stamp,
                                "workflow_snapshot":        (extra_pnginfo or {}).get("workflow"),
                                "prompt_snapshot":          base_prompt,
                                "execution_scope":         _execution_scope,
                                "run_mode":                _run_mode,
                                "resume_kind":            _resume_kind,
                                "completed_seg":          seg_num,
                                "total_segs":             total_segs,
                                "next_seg":               seg_num + 1,
                                "transition_video":       _trans_fname,
                                "ref_images":             ref_images_list,
                                "ref_images_original":    ref_images_original,
                                "resume_ref_assets":      resume_ref_assets or ref_images_list,
                                "resume_ref_asset_dir":   resume_ref_asset_dir,
                                "resume_ref_asset_manifest": resume_ref_asset_manifest,
                                "pose_model_node_id":     pose_node_id,
                                "face_model_node_id":     face_node_id,
                                "local_pose_video_path":  local_pose_video_path or local_pose_video_raw,
                                "local_face_video_path":  local_face_video_path or local_face_video_raw,
                                "segments":               segments,
                                "ref_video":              _ref_video_params.get("video", ""),
                                "ref_video_params":       _ref_video_params,
                                "timestamp":              time.strftime("%Y-%m-%d %H:%M:%S"),
                                "base_frame_offset":      _frame_offset,
                                "frame_offset_for_resume": _frame_offset_for_resume,
                                # ── 三种分段模式的完整记录 ──
                                "segment_mode":           _segment_mode,
                                "trim_merge_mode":        _trim_merge_mode,
                                "segments_param":         segments,
                                "segment_count":          len(seg_list),
                                "manual_splits":          _manual_splits_str,
                                "seg_list":               [list(s) for s in seg_list],
                                "total_frames_used":      total_frames,
                                "frame_rate_used":        frame_rate,
                            })
                        _elapsed = time.time() - _t0
                        _frames_done = sum(lmt for _, lmt in segs_to_run[:i+1])
                        save_speed_record(_elapsed, _frames_done)

                        cut_vc_id_done = f"sqr_cut_vc_{seg_num}"
                        if vc_nid:
                            cut_vpath, _ = get_output_video_info(pid, cut_vc_id_done)
                            if not cut_vpath:
                                cut_vpath, _ = get_output_video_info(pid, vc_nid)
                            _segment_validation_failed = False
                            if cut_vpath:
                                segment_output_paths.append(cut_vpath)
                                sqr_cut_paths.append(cut_vpath)
                                _actual_cut_frames = _sqr_get_video_frame_count(cut_vpath)
                                _expected_cut_frames = trim_plan.get("trim_len")
                                if _actual_cut_frames is None:
                                    log(f"  ⚠ 输出校验: 无法读取帧数（预期{_expected_cut_frames}帧）")
                                else:
                                    _diff = abs(int(_actual_cut_frames) - int(_expected_cut_frames))
                                    # 输出帧数误差分级：
                                    # ≤2: ✓/⚠ 可接受（h264 编码器偶发 GOP 边界问题）
                                    # ≤半段过渡帧: ⚠ 警告但继续（对应 split-trim 量级，
                                    #      一般是 VHS_VideoCombine 在某些 codec/分辨率下的帧率重采样误差）
                                    # >半段过渡帧: ✗ 致命，停止执行
                                    _warn_tolerance = max(TRANSITION_TRIM_HEAD, TRANSITION_TRIM_TAIL)
                                    if _diff <= 2:
                                        _level = "✓" if _diff == 0 else "⚠"
                                        log(f"  {_level} 输出校验: 预期{_expected_cut_frames}帧，实际{_actual_cut_frames}帧，误差{_diff}")
                                    elif _diff <= _warn_tolerance:
                                        log(f"  ✓ 输出校验: 预期{_expected_cut_frames}帧，实际{_actual_cut_frames}帧，误差{_diff}（在编码器容忍范围内，继续执行）")
                                    else:
                                        log(f"  ✗ 输出校验失败: 预期{_expected_cut_frames}帧，实际{_actual_cut_frames}帧，误差{_diff}，停止执行")
                                        _segment_validation_failed = True
                                _cut_duration_expected = _sqr_frames_to_seconds(_expected_cut_frames, audio_timeline_fps) if _expected_cut_frames else None
                                _cut_duration_probe = _sqr_ffprobe_duration_seconds(cut_vpath)
                                _cut_duration = _cut_duration_expected or _cut_duration_probe
                                if _expected_cut_frames:
                                    assembled_audio_total_frames += max(0, int(_expected_cut_frames))
                                _sqr_write_media_meta(cut_vpath, {
                                    "media_role": "segment_cut",
                                    "run_mode": _run_mode,
                                    "resume_kind": _resume_kind,
                                    "audio_mode": "continuous_original_segment",
                                    "audio_source_path": assembled_audio_source_path or audio_source_path or "",
                                    "audio_start_sec": _sqr_frames_to_seconds(audio_skip_frames, audio_timeline_fps),
                                    "audio_start_frame": int(audio_skip_frames),
                                    "audio_frame_count": int(_expected_cut_frames or 0),
                                    "kept_frame_count": int(_expected_cut_frames or 0),
                                    "duration_sec": _cut_duration,
                                    "duration_sec_expected": _cut_duration_expected,
                                    "duration_sec_probe": _cut_duration_probe,
                                    "frame_rate_used": audio_timeline_fps,
                                    "frame_rate_input": frame_rate,
                                    "frame_rate_timeline": audio_timeline_fps,
                                    "continuous_time_axis": True,
                                })
                                log(f"  ✓ 输出文件: {os.path.basename(cut_vpath)}")
                            else:
                                log(f"  ⚠ 未找到输出视频")
                                _segment_validation_failed = True
                            if _segment_validation_failed:
                                _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="error", run_mode=_run_mode, current_segment=seg_num, total_segments=total_segs, completed_segments=i, current_stage="segment_validate", execution_scope=_execution_scope, last_message=f"第{seg_num}段输出帧数异常"))
                                break

                        vpath, vframes = get_output_video_info(pid, vc_nid) if vc_nid else (None, None)
                        if not vpath:
                            log(f"  ⚠ 完整视频获取失败，下段过渡将跳过")
                        if vpath:
                            input_fname = f"sqr_trans_{run_stamp}_seg{seg_num}.mp4"
                            try:
                                input_path = _sqr_copy_into_input(
                                    vpath,
                                    desired_name=input_fname,
                                    unique_id=unique_id,
                                    prefix="sqr_trans",
                                )
                                last_video_path   = input_path
                                last_video_frames = vframes
                                log(f"  ✓ 已复制到 input/: {os.path.basename(input_path)} ({vframes}帧，过渡缓存)")
                            except Exception as e:
                                log(f"  ✗ 复制失败: {e}")
                                last_video_path = last_video_frames = None
                        else:
                            log(f"  ⚠ 未找到完整视频，下段过渡将跳过")
                            last_video_path = last_video_frames = None
                        _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="running", run_mode=_run_mode, current_segment=seg_num, total_segments=total_segs, completed_segments=i+1, current_stage="segment_done", execution_scope=_execution_scope, last_message=f"第{seg_num}段完成"))
                    else:
                        _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="error", run_mode=_run_mode, current_segment=seg_num, total_segments=total_segs, completed_segments=i, current_stage="segment_wait", execution_scope=_execution_scope, last_message=f"第{seg_num}段失败：{wait_reason}"))
                        log(f"✗ 第{seg_num}段出错，终止。原因：{wait_reason}")
                        break
                except Exception as e:
                    _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="error", run_mode=_run_mode, current_segment=seg_num, total_segments=total_segs, completed_segments=i, current_stage="segment_submit", execution_scope=_execution_scope, last_message=f"第{seg_num}段提交失败：{e}"))
                    log(f"✗ 提交失败：{e}")
                    break

            if pre_segment_paths and not _segment_only_mode:
                log(f"续跑合并：前段 {len(pre_segment_paths)} 个 + 本次 {len(segment_output_paths)} 个")
                segment_output_paths = pre_segment_paths + segment_output_paths
            elif pre_segment_paths and _segment_only_mode:
                log("试跑模式：已忽略续跑前段合并，只输出目标段。")

            if _segment_only_mode and len(segment_output_paths) >= 1:
                _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="done", run_mode=_run_mode, current_segment=start_from_segment, total_segments=len(seg_list), completed_segments=1, current_stage="single_done", execution_scope=_execution_scope, last_message=f"试跑模式完成：第{start_from_segment}段"))
                log(f"试跑模式完成：仅输出第{start_from_segment}段，不进入整片合并")
            elif len(segment_output_paths) >= 2:
                _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="merging", run_mode=_run_mode, current_segment=len(segs_to_run), total_segments=len(seg_list), completed_segments=len(segs_to_run), current_stage="merge", execution_scope=_execution_scope, last_message=f"开始合并 {len(segment_output_paths)} 段视频"))
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
                               target_fps=frame_rate, log=log):
                    _merged_duration_probe = _sqr_ffprobe_duration_seconds(merged_path)
                    if assembled_audio_start_frame is not None:
                        assembled_audio_start_sec = _sqr_frames_to_seconds(assembled_audio_start_frame, audio_timeline_fps)
                    _merged_duration_exact = _sqr_frames_to_seconds(assembled_audio_total_frames, audio_timeline_fps) if assembled_audio_total_frames > 0 else None
                    _merged_duration = _merged_duration_exact or _merged_duration_probe
                    _final_audio_mode = "passthrough_segment_audio"
                    if _run_mode == "manual_noncontinuous":
                        log("⚠ 非连续型手动续跑：最终成品保留分段拼接音频，不重贴连续原始音频")
                    else:
                        if assembled_audio_can_remux and assembled_audio_source_path and assembled_audio_start_sec is not None and _merged_duration:
                            ok_audio, msg_audio = _sqr_replace_video_audio(
                                merged_path,
                                assembled_audio_source_path,
                                assembled_audio_start_sec,
                                duration_sec=_merged_duration,
                            )
                            if ok_audio:
                                _final_audio_mode = "continuous_original"
                                log(f"✓ 最终成品音频已重贴原始连续音轨：start={assembled_audio_start_sec:.3f}s duration={_merged_duration:.3f}s")
                            else:
                                log(f"⚠ 最终成品音频重贴失败，已保留分段拼接音频：{msg_audio}")
                        else:
                            _reason = assembled_audio_reason or "缺少音频源、起点或前段元数据"
                            log(f"⚠ 最终成品未重贴连续原始音频：{_reason}")
                    _sqr_write_media_meta(merged_path, {
                        "media_role": "merged",
                        "run_mode": _run_mode,
                        "resume_kind": _resume_kind,
                        "audio_mode": _final_audio_mode,
                        "audio_source_path": assembled_audio_source_path or audio_source_path or "",
                        "audio_start_sec": assembled_audio_start_sec if assembled_audio_start_sec is not None else None,
                        "audio_start_frame": assembled_audio_start_frame if assembled_audio_start_frame is not None else None,
                        "audio_frame_count": int(assembled_audio_total_frames or 0),
                        "duration_sec": _merged_duration,
                        "duration_sec_expected": _merged_duration_exact,
                        "duration_sec_probe": _merged_duration_probe,
                        "frame_rate_used": audio_timeline_fps,
                                    "frame_rate_input": frame_rate,
                                    "frame_rate_timeline": audio_timeline_fps,
                        "continuous_time_axis": _final_audio_mode == "continuous_original",
                    })
                    _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="done", run_mode=_run_mode, current_segment=len(segs_to_run), total_segments=len(seg_list), completed_segments=len(segs_to_run), current_stage="merge_done", execution_scope=_execution_scope, last_message=f"合并完成: {_sub + merged_fname}"))
                    log(f"✓ 合并完成: {_sub + merged_fname}")
                else:
                    _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="error", run_mode=_run_mode, current_segment=len(segs_to_run), total_segments=len(seg_list), completed_segments=max(0, len(segs_to_run)-1), current_stage="merge", execution_scope=_execution_scope, last_message="合并失败，请手动拼接各段视频"))
                    log(f"✗ 合并失败，请手动拼接各段视频")
            elif len(segment_output_paths) == 1:
                _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="done", run_mode=_run_mode, current_segment=1, total_segments=len(seg_list), completed_segments=1, current_stage="single_done", execution_scope=_execution_scope, last_message="单段输出完成"))
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
                    print("[SQR] checkpoint 已清除（全部完成）")
                else:
                    print("[SQR] 任务中断，checkpoint 保留供续跑检测")

            if _all_done or len(segment_output_paths) > 0:
                # 需求6: 全流程跑完时，附带一个 gacha 奖励标志，前端轮询到后会发放抽卡机会
                _gacha_stamp = run_stamp if _all_done else ""
                _sqr_progress_set(unique_id, **_sqr_progress_payload(unique_id, status="done" if _all_done or len(segment_output_paths) > 0 else "error", run_mode=_run_mode, current_segment=len(segs_to_run), total_segments=len(seg_list), completed_segments=len(segment_output_paths), current_stage="finished", execution_scope=_execution_scope, last_message="全部完成" if (_all_done or len(segment_output_paths) > 0) else "任务中断", gacha_reward_run_stamp=_gacha_stamp))
            log("═══ 全部完成 ═══")

        if _segment_only_mode:
            _mode_header = f"=== 试跑模式：仅执行第{start_from_segment}段 ==="
        elif _run_mode == "manual_continuous":
            _mode_header = "=== 手动续跑（连续型）==="
        elif _run_mode == "manual_noncontinuous":
            _mode_header = "=== 手动续跑（非连续型）==="
        elif _frame_offset > 0:
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
NODE_DISPLAY_NAME_MAPPINGS = {"SegmentQueueRunner": "🎬分段队列@肥猴🐵@wuwu🚂@雪子❄️"}


# ── 后端 API ─────────────────────────────────────────────────────
@server.PromptServer.instance.routes.get("/sqr/logs")
async def sqr_get_logs(request):
    uid = request.rel_url.query.get("uid", "")
    with _sqr_log_lock:
        logs = list(_sqr_log_buf.get(str(uid), []))
    return web.json_response({"logs": logs})

@server.PromptServer.instance.routes.get("/sqr/progress")
async def sqr_get_progress(request):
    uid = request.rel_url.query.get("uid", "")
    return web.json_response({"progress": _sqr_progress_get(uid)})

@server.PromptServer.instance.routes.post("/sqr/logs/clear")
async def sqr_clear_logs(request):
    _sqr_log_clear(request.rel_url.query.get("uid", ""))
    return web.json_response({"ok": True})


def _sqr_checkpoint_payload(uid: str, ckpt: dict | None, cur_params_str: str = "", source_path: str = ""):
    if not ckpt:
        return None
    ckpt = copy.deepcopy(ckpt)
    uid = str(uid or ckpt.get("unique_id") or "")
    if uid:
        ckpt["checkpoint_uid"] = uid
    ckpt_path = str(source_path or "").strip() or (get_checkpoint_path(uid) if uid else "")
    if ckpt_path:
        ckpt["checkpoint_path"] = ckpt_path
        try:
            ckpt["checkpoint_mtime"] = os.path.getmtime(ckpt_path)
        except Exception:
            ckpt["checkpoint_mtime"] = 0

    input_dir = folder_paths.get_input_directory()
    tv = ckpt.get("transition_video", "")
    tv_path = os.path.join(input_dir, tv) if tv else ""
    ckpt["transition_exists"] = os.path.isfile(tv_path)
    if ckpt["transition_exists"] and tv_path and ckpt_path and os.path.exists(ckpt_path):
        try:
            tv_mtime = os.path.getmtime(tv_path)
            ckpt_mtime = os.path.getmtime(ckpt_path)
            if tv_mtime > ckpt_mtime + 60:
                ckpt["transition_exists"] = False
        except Exception:
            pass

    raw_resume_refs = list(ckpt.get("resume_ref_assets") or ckpt.get("ref_images") or [])
    resolved_resume_refs = []
    resume_ref_status = []
    for _idx, _raw in enumerate(raw_resume_refs, start=1):
        _resolved = _sqr_resolve_media_path(_raw) or _sqr_resolve_plugin_path(_raw)
        _exists = bool(_resolved and os.path.isfile(_resolved))
        resolved_resume_refs.append(_resolved if _exists else _raw)
        resume_ref_status.append({
            "index": _idx,
            "source": _raw,
            "resolved": _resolved or "",
            "exists": _exists,
        })
    ckpt["resume_ref_assets"] = resolved_resume_refs
    ckpt["resume_ref_asset_status"] = resume_ref_status
    ckpt["resume_ref_total"] = len(resume_ref_status)
    ckpt["resume_ref_existing"] = sum(1 for x in resume_ref_status if x.get("exists"))
    ckpt["resume_ref_missing"] = max(0, ckpt["resume_ref_total"] - ckpt["resume_ref_existing"])
    ckpt["resume_ref_ok"] = ckpt["resume_ref_missing"] == 0
    _asset_dir = _sqr_resolve_plugin_path(ckpt.get("resume_ref_asset_dir", ""))
    ckpt["resume_ref_asset_dir"] = _asset_dir or ckpt.get("resume_ref_asset_dir", "")
    ckpt["resume_ref_asset_dir_exists"] = bool(_asset_dir and os.path.isdir(_asset_dir))

    _pose_src = ckpt.get("local_pose_video_path", "")
    _face_src = ckpt.get("local_face_video_path", "")
    _pose_resolved = _sqr_resolve_media_path(_pose_src) or _sqr_resolve_plugin_path(_pose_src)
    _face_resolved = _sqr_resolve_media_path(_face_src) or _sqr_resolve_plugin_path(_face_src)
    ckpt["local_pose_video_exists"] = bool(_pose_src and _pose_resolved and os.path.isfile(_pose_resolved))
    ckpt["local_face_video_exists"] = bool(_face_src and _face_resolved and os.path.isfile(_face_resolved))
    ckpt["local_pose_video_path"] = _pose_resolved or _pose_src
    ckpt["local_face_video_path"] = _face_resolved or _face_src

    import urllib.parse as _up
    ckpt_params = ckpt.get("ref_video_params", {})
    if not ckpt_params and ckpt.get("ref_video"):
        ckpt_params = {"video": ckpt.get("ref_video")}
    thumb_raw = str((ckpt_params or {}).get("video") or ckpt.get("ref_video") or "").strip()
    thumb_resolved = _sqr_resolve_media_path(thumb_raw)
    ckpt["ref_video_thumb_file"] = thumb_resolved or thumb_raw
    ckpt["ref_video_label"] = os.path.basename(thumb_raw) if thumb_raw else ""

    # ── 进度缩略图：优先使用过渡视频（中断前最后一段的完整视频）取最后一帧 ──
    # 这样每个 checkpoint 卡片的缩略图都能直观反映任务的实际进度
    _trans_thumb_path = ""
    if ckpt.get("transition_exists") and tv_path and os.path.isfile(tv_path):
        _trans_thumb_path = os.path.realpath(tv_path)
    ckpt["progress_thumb_source"] = _trans_thumb_path or ckpt["ref_video_thumb_file"]
    ckpt["progress_thumb_use_last_frame"] = bool(_trans_thumb_path)
    _completed = ckpt.get("completed_seg", 0) or 0
    _total = ckpt.get("total_segs", 0) or 0
    ckpt["progress_seg_label"] = f"{_completed}/{_total}" if _total else ""

    if cur_params_str and ckpt_params:
        try:
            import json as _json
            cur_params = _json.loads(_up.unquote(cur_params_str))
            mismatches = []
            for key in ("video", "force_rate", "custom_width", "custom_height", "frame_load_cap", "skip_first_frames", "select_every_nth", "format"):
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
            ckpt["ref_video_match"] = len(mismatches) == 0
            ckpt["ref_video_mismatches"] = mismatches
        except Exception:
            ckpt["ref_video_match"] = True
            ckpt["ref_video_mismatches"] = []
    else:
        ckpt["ref_video_match"] = True
        ckpt["ref_video_mismatches"] = []
    return ckpt

@server.PromptServer.instance.routes.get("/sqr/checkpoint")
async def sqr_get_checkpoint(request):
    uid = request.rel_url.query.get("uid", "")
    source_path = str(request.rel_url.query.get("path", "") or "").strip()
    raw = _sqr_read_checkpoint_from_path(source_path) if source_path else None
    if raw is None and uid:
        raw = read_checkpoint(uid)
    if raw is None:
        return web.json_response({"checkpoint": None})
    ckpt_uid = str(uid or raw.get("unique_id") or "")
    ckpt = _sqr_checkpoint_payload(ckpt_uid, raw, request.rel_url.query.get("ref_params", ""), source_path=source_path)
    return web.json_response({"checkpoint": ckpt})


@server.PromptServer.instance.routes.get("/sqr/checkpoints")
async def sqr_list_checkpoints(request):
    try:
        _sqr_cleanup_checkpoint_history()
    except Exception:
        pass
    exclude_uid = str(request.rel_url.query.get("exclude_uid", "") or "").strip()
    cur_params_str = request.rel_url.query.get("ref_params", "")
    results = []
    seen_history_ids: set[str] = set()
    hist_root_real = os.path.realpath(_sqr_checkpoint_history_root())
    for ckpt_path in _sqr_iter_checkpoint_file_paths(include_history=True):
        try:
            with open(ckpt_path, "r", encoding="utf-8") as f:
                raw_ckpt = json.load(f)
        except Exception:
            continue
        uid = str(raw_ckpt.get("unique_id") or "")
        ckpt_real = os.path.realpath(ckpt_path)
        is_history_ckpt = ckpt_real.startswith(hist_root_real + os.sep) or ckpt_real == hist_root_real
        if exclude_uid and uid == exclude_uid and not is_history_ckpt:
            continue
        ckpt = _sqr_checkpoint_payload(uid, raw_ckpt, cur_params_str, source_path=ckpt_path)
        if not ckpt:
            continue
        history_id = str(raw_ckpt.get("run_stamp") or "").strip() or f"{uid}|{ckpt_path}"
        if history_id in seen_history_ids:
            continue
        seen_history_ids.add(history_id)
        results.append({
            "unique_id": uid,
            "history_id": history_id,
            "timestamp": ckpt.get("timestamp", ""),
            "completed_seg": ckpt.get("completed_seg", 0),
            "total_segs": ckpt.get("total_segs", 0),
            "next_seg": ckpt.get("next_seg", 0),
            "transition_video": ckpt.get("transition_video", ""),
            "transition_exists": bool(ckpt.get("transition_exists")),
            "segment_mode": ckpt.get("segment_mode", "average"),
            "run_mode": ckpt.get("run_mode", ""),
            "resume_kind": ckpt.get("resume_kind", ""),
            "ref_video_label": ckpt.get("ref_video_label", ""),
            "ref_video_thumb_file": ckpt.get("ref_video_thumb_file", ""),
            "progress_thumb_source": ckpt.get("progress_thumb_source", ""),
            "progress_thumb_use_last_frame": bool(ckpt.get("progress_thumb_use_last_frame")),
            "progress_seg_label": ckpt.get("progress_seg_label", ""),
            "checkpoint_mtime": ckpt.get("checkpoint_mtime", 0),
            "checkpoint_path": ckpt.get("checkpoint_path", ""),
        })
    results.sort(key=lambda x: (x.get("checkpoint_mtime") or 0, x.get("timestamp") or ""), reverse=True)
    return web.json_response({"checkpoints": results})


@server.PromptServer.instance.routes.post("/sqr/checkpoints/delete")
async def sqr_delete_checkpoints(request):
    """手动批量删除 checkpoint 文件。
    请求体: {"paths": ["<绝对路径1>", ...]}
    安全规则:
    - 路径必须落在插件根目录或 sqr_checkpoint_history/ 下
    - 文件名必须形如 sqr_checkpoint_*.json
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    paths = data.get("paths") or []
    if not isinstance(paths, list):
        return web.json_response({"error": "paths must be list"}, status=400)
    plugin_dir_real = os.path.realpath(_sqr_plugin_dir())
    hist_root_real = os.path.realpath(_sqr_checkpoint_history_root())
    deleted = 0
    failed = []
    deleted_paths = []
    for raw in paths:
        try:
            rp = os.path.realpath(str(raw or "").strip())
            if not rp or not os.path.isfile(rp):
                failed.append({"path": str(raw), "error": "文件不存在"})
                continue
            in_plugin_root = (os.path.dirname(rp) == plugin_dir_real)
            in_hist = rp.startswith(hist_root_real + os.sep)
            if not (in_plugin_root or in_hist):
                failed.append({"path": str(raw), "error": "路径不在允许范围内"})
                continue
            base = os.path.basename(rp)
            if not (base.startswith("sqr_checkpoint_") and base.endswith(".json")):
                failed.append({"path": str(raw), "error": "文件名不符合规则"})
                continue
            os.remove(rp)
            deleted += 1
            deleted_paths.append(rp)
            print(f"[SQR] 手动删除 checkpoint: {base}")
        except Exception as e:
            failed.append({"path": str(raw), "error": str(e)})
    return web.json_response({
        "deleted": deleted,
        "deleted_paths": deleted_paths,
        "failed": failed,
    })


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


@server.PromptServer.instance.routes.get("/sqr/video_real_info")
async def sqr_video_real_info(request):
    """读取视频文件的真实帧数和帧率（不经过 Load Video 处理）"""
    fpath = request.rel_url.query.get("file", "").strip()
    if not fpath:
        return web.json_response({"error": "未指定文件"}, status=400)
    fpath = _sqr_resolve_media_path(fpath)
    if not fpath or not os.path.isfile(fpath):
        return web.json_response({"error": f"文件不存在: {request.rel_url.query.get('file', '').strip()}"}, status=404)
    try:
        import cv2
        cap = cv2.VideoCapture(fpath)
        if not cap.isOpened():
            return web.json_response({"error": "无法打开视频文件"}, status=500)
        real_frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        real_fps = cap.get(cv2.CAP_PROP_FPS)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        cap.release()
        # 计算时长
        duration = real_frame_count / real_fps if real_fps > 0 else 0
        return web.json_response({
            "frame_count": real_frame_count,
            "fps": round(real_fps, 3),
            "width": width,
            "height": height,
            "duration": round(duration, 3),
            "file": os.path.realpath(fpath),
            "name": os.path.basename(fpath),
        })
    except ImportError:
        return web.json_response({"error": "cv2 未安装"}, status=500)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


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
    import base64, io
    fpath = request.rel_url.query.get("file", "").strip()
    frame_pos = request.rel_url.query.get("frame", "first").strip().lower()
    if not fpath:
        return web.Response(status=400)
    fpath = _sqr_resolve_media_path(fpath)
    if not fpath or not os.path.isfile(fpath):
        return web.Response(status=404)
    try:
        import cv2
        cap = cv2.VideoCapture(fpath)
        if not cap.isOpened():
            return web.Response(status=500)
        if frame_pos == "last":
            try:
                total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
                if total > 1:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, total - 1))
            except Exception:
                pass
        ok, frame = cap.read()
        if not ok and frame_pos == "last":
            # 取最后一帧失败时降级到第 0 帧
            try:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            except Exception:
                pass
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
    except ImportError:
        return web.Response(status=500, text="cv2 not installed")
    except Exception as e:
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



@server.PromptServer.instance.routes.get("/sqr/video_frame_at")
async def sqr_video_frame_at(request):
    """读取视频文件指定帧并返回 JPEG 缩略图（用于手动分段拖拽预览）"""
    fpath = request.rel_url.query.get("file", "").strip()
    frame_num = int(request.rel_url.query.get("frame", "0"))
    width = int(request.rel_url.query.get("w", "240"))
    if not fpath:
        return web.Response(status=400)
    fpath = _sqr_resolve_media_path(fpath)
    if not fpath or not os.path.isfile(fpath):
        return web.Response(status=404)
    try:
        import cv2
        cap = cv2.VideoCapture(fpath)
        if not cap.isOpened():
            return web.Response(status=500)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        frame_num = max(0, min(frame_num, total - 1))
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_num)
        ok, frame = cap.read()
        cap.release()
        if not ok:
            return web.Response(status=404)
        h, w = frame.shape[:2]
        new_w = min(width, w)
        new_h = int(h * new_w / w)
        frame = cv2.resize(frame, (new_w, new_h))
        ok2, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        if not ok2:
            return web.Response(status=500)
        return web.Response(body=buf.tobytes(), content_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=600"})
    except ImportError:
        return web.Response(status=500, text="cv2 not installed")
    except Exception as e:
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.get("/sqr/video_serve")
async def sqr_video_serve(request):
    """流式提供视频文件（支持 Range 请求）"""
    fpath = request.rel_url.query.get("file", "").strip()
    if not fpath:
        return web.Response(status=400)
    fpath = _sqr_resolve_media_path(fpath)
    if not fpath or not os.path.isfile(fpath):
        return web.Response(status=404)
    return web.FileResponse(fpath, headers={
        "Cache-Control": "public, max-age=3600",
    })

MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024


@server.PromptServer.instance.routes.post("/sqr/upload_images")
async def sqr_upload_images(request):
    import re as _re
    saved = []
    error = ""
    try:
        reader = await request.multipart()
        input_dir = folder_paths.get_input_directory()
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name not in ("files[]", "file"):
                continue
            raw_name = part.filename or f"sqr_upload_{_sqr_now_stamp()}"
            safe_name = _re.sub(r"[^\w\-. ()（）\u4e00-\u9fff]", "_", raw_name)
            dst = os.path.join(input_dir, safe_name)
            if os.path.exists(dst):
                stem, ext = os.path.splitext(safe_name)
                safe_name = f"{stem}_{_sqr_now_stamp()}{ext}"
                dst = os.path.join(input_dir, safe_name)
            written = 0
            with open(dst, "wb") as f:
                while True:
                    chunk = await part.read_chunk(65536)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > MAX_UPLOAD_BYTES:
                        f.close()
                        os.remove(dst)
                        raise ValueError(f"文件超过上限 4 GB")
                    f.write(chunk)
            saved.append(safe_name)
            print(f"[SQR] 上传保存: {safe_name} ({written/1024/1024:.1f} MB)")
    except Exception as e:
        error = str(e)
        print(f"[SQR] ✗ 上传失败: {e}")
    return web.json_response({"saved": saved, "error": error})


@server.PromptServer.instance.routes.post("/sqr/upload_video")
async def sqr_upload_video(request):
    import re as _re
    saved = ""
    error = ""
    try:
        reader = await request.multipart()
        input_dir = folder_paths.get_input_directory()
        part = await reader.next()
        if part is None:
            raise ValueError("未收到文件")
        raw_name = part.filename or f"sqr_upload_{_sqr_now_stamp()}.mp4"
        safe_name = _re.sub(r"[^\w\-. ()（）\u4e00-\u9fff]", "_", raw_name)
        dst = os.path.join(input_dir, safe_name)
        if os.path.exists(dst):
            stem, ext = os.path.splitext(safe_name)
            safe_name = f"{stem}_{_sqr_now_stamp()}{ext}"
            dst = os.path.join(input_dir, safe_name)
        written = 0
        with open(dst, "wb") as f:
            while True:
                chunk = await part.read_chunk(65536)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    f.close()
                    os.remove(dst)
                    raise ValueError("文件超过上限 4 GB")
                f.write(chunk)
        saved = safe_name
        print(f"[SQR] 上传保存(视频): {safe_name} ({written/1024/1024:.1f} MB)")
    except Exception as e:
        error = str(e)
        print(f"[SQR] ✗ 上传视频失败: {e}")
    return web.json_response({"saved": saved, "error": error})
