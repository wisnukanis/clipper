import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def log_step(message):
    print(f"\n[STEP] {message}", flush=True)


def log_info(message):
    print(f"[INFO] {message}", flush=True)


def log_warn(message):
    print(f"[WARN] {message}", flush=True)


def log_progress(stage, overall=None, *, stage_pct=None, clip=None, total=None, note=""):
    fields = [f"stage={str(stage).strip().lower()}"]
    if overall is not None:
        fields.append(f"overall={clamp(float(overall), 0.0, 100.0):.1f}")
    if stage_pct is not None:
        fields.append(f"pct={clamp(float(stage_pct), 0.0, 100.0):.1f}")
    if clip is not None:
        fields.append(f"clip={int(clip)}")
    if total is not None:
        fields.append(f"total={int(total)}")
    if note:
        safe_note = re.sub(r"\s+", "_", str(note).strip())[:80]
        fields.append(f"note={safe_note}")
    print(f"[PROGRESS] {' '.join(fields)}", flush=True)


def load_env():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return

    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def parse_int(value, default):
    normalized = str(value).strip().lower()
    if normalized in {"true", "yes", "on"}:
        return 1
    if normalized in {"false", "no", "off"}:
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_float(value, default):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_keys(value):
    return [key.strip() for key in str(value or "").split(",") if key.strip()]


def cfg():
    transcribe_provider = os.environ.get("TRANSCRIBE_PROVIDER", "offline").strip().lower()
    if transcribe_provider not in {"offline", "auto", "deepgram"}:
        transcribe_provider = "offline"

    return {
        "gemini_keys": parse_keys(os.environ.get("GEMINI_API_KEYS") or os.environ.get("GEMINI_API_KEY")),
        "gemini_model": os.environ.get("GEMINI_MODEL", "gemini-flash-latest"),
        "ai_clip_selection": parse_int(os.environ.get("AI_CLIP_SELECTION_ENABLED"), 1),
        "ai_candidate_max_count": parse_int(os.environ.get("AI_CANDIDATE_MAX_COUNT"), 5),
        "ai_candidate_max_chars": parse_int(os.environ.get("AI_CANDIDATE_MAX_CHARS"), 4000),
        "clip_count": parse_int(os.environ.get("CLIP_COUNT"), 1),
        "min_clip_seconds": parse_int(os.environ.get("MIN_CLIP_SECONDS"), 40),
        "max_clip_seconds": parse_int(os.environ.get("MAX_CLIP_SECONDS"), 60),
        "width": parse_int(os.environ.get("OUTPUT_WIDTH"), 1080),
        "height": parse_int(os.environ.get("OUTPUT_HEIGHT"), 1920),
        "download_max_height": parse_int(os.environ.get("DOWNLOAD_MAX_HEIGHT"), 720),
        "download_crf": parse_int(os.environ.get("DOWNLOAD_COMPRESS_CRF"), 30),
        "final_crf": parse_int(os.environ.get("FINAL_RENDER_CRF"), 27),
        "subtitle_offset": parse_float(os.environ.get("SUBTITLE_OFFSET_SECONDS"), 0.0),
        "smart_crop": parse_int(os.environ.get("SMART_CROP_ENABLED"), 1),
        "smart_crop_mode": os.environ.get("SMART_CROP_MODE", "auto"),
        "smart_crop_sample": parse_float(os.environ.get("SMART_CROP_SAMPLE_SECONDS"), 0.35),
        "smart_crop_smoothing": parse_float(os.environ.get("SMART_CROP_SMOOTHING"), 0.38),
        "smart_crop_max_shift": parse_float(os.environ.get("SMART_CROP_MAX_SHIFT_PER_SECOND"), 0.16),
        "active_speaker_switch_seconds": parse_float(os.environ.get("ACTIVE_SPEAKER_SWITCH_SECONDS"), 1.2),
        "active_speaker_mouth_weight": parse_float(os.environ.get("ACTIVE_SPEAKER_MOUTH_WEIGHT"), 0.55),
        "active_speaker_face_weight": parse_float(os.environ.get("ACTIVE_SPEAKER_FACE_WEIGHT"), 0.30),
        "active_speaker_center_weight": parse_float(os.environ.get("ACTIVE_SPEAKER_CENTER_WEIGHT"), 0.10),
        "active_speaker_stickiness_weight": parse_float(os.environ.get("ACTIVE_SPEAKER_STICKINESS_WEIGHT"), 0.05),
        "active_speaker_max_faces": parse_int(os.environ.get("ACTIVE_SPEAKER_MAX_FACES"), 4),
        "active_speaker_no_face_strategy": os.environ.get("ACTIVE_SPEAKER_NO_FACE_STRATEGY", "visual_content"),
        "active_speaker_no_face_center_after_seconds": parse_float(os.environ.get("ACTIVE_SPEAKER_NO_FACE_CENTER_AFTER_SECONDS"), 6.0),
        "active_speaker_center_fallback_enabled": parse_int(os.environ.get("ACTIVE_SPEAKER_CENTER_FALLBACK_ENABLED"), 0),
        "active_speaker_min_mouth_score_to_switch": parse_float(os.environ.get("ACTIVE_SPEAKER_MIN_MOUTH_SCORE_TO_SWITCH"), 0.06),
        "active_speaker_switch_score_margin": parse_float(os.environ.get("ACTIVE_SPEAKER_SWITCH_SCORE_MARGIN"), 0.12),
        "active_speaker_visual_fallback_enabled": parse_int(os.environ.get("ACTIVE_SPEAKER_VISUAL_FALLBACK_ENABLED"), 1),
        "active_speaker_visual_min_score": parse_float(os.environ.get("ACTIVE_SPEAKER_VISUAL_MIN_SCORE"), 0.025),
        "active_speaker_visual_hold_seconds": parse_float(os.environ.get("ACTIVE_SPEAKER_VISUAL_HOLD_SECONDS"), 1.5),
        "active_speaker_initial_anchor_enabled": parse_int(os.environ.get("ACTIVE_SPEAKER_INITIAL_ANCHOR_ENABLED"), 1),
        "active_speaker_initial_scan_seconds": parse_float(os.environ.get("ACTIVE_SPEAKER_INITIAL_SCAN_SECONDS"), 6.0),
        "active_speaker_initial_sample_seconds": parse_float(os.environ.get("ACTIVE_SPEAKER_INITIAL_SAMPLE_SECONDS"), 0.5),
        "active_speaker_initial_min_score": parse_float(os.environ.get("ACTIVE_SPEAKER_INITIAL_MIN_SCORE"), 0.010),
        "active_speaker_initial_side_bias": parse_float(os.environ.get("ACTIVE_SPEAKER_INITIAL_SIDE_BIAS"), 0.06),
        # ---- Scene mode + new face engine ----
        "scene_mode": (os.environ.get("SCENE_MODE") or os.environ.get("SMART_CROP_MODE") or "auto").strip().lower(),
        "face_engine_pack": os.environ.get("FACE_ENGINE_PACK", "buffalo_sc"),
        "face_engine_det_size": parse_int(os.environ.get("FACE_ENGINE_DET_SIZE"), 640),
        "face_engine_iou": parse_float(os.environ.get("FACE_ENGINE_IOU"), 0.20),
        "face_engine_max_dist": parse_float(os.environ.get("FACE_ENGINE_MAX_DIST"), 0.18),
        "face_engine_max_lost": parse_int(os.environ.get("FACE_ENGINE_MAX_LOST"), 15),
        "face_engine_min_score": parse_float(os.environ.get("FACE_ENGINE_MIN_SCORE"), 0.55),
        "face_engine_use_insightface": parse_int(os.environ.get("FACE_ENGINE_USE_INSIGHTFACE"), 1),
        "fullscreen_blur_strength": parse_int(os.environ.get("FULLSCREEN_BLUR_STRENGTH"), 22),
        "fullscreen_min_segment_seconds": parse_float(os.environ.get("FULLSCREEN_MIN_SEGMENT_SECONDS"), 0.7),
        "crossfade_seconds": parse_float(os.environ.get("CROSSFADE_SECONDS"), 0.4),
        "dynamic_zoom_enabled": parse_int(os.environ.get("DYNAMIC_ZOOM_ENABLED"), 1),
        "dynamic_zoom_width_smooth": parse_float(os.environ.get("DYNAMIC_ZOOM_WIDTH_SMOOTH"), 0.18),
        "dynamic_zoom_center_smooth": parse_float(os.environ.get("DYNAMIC_ZOOM_CENTER_SMOOTH"), 0.30),
        "dynamic_zoom_confidence_fall": parse_float(os.environ.get("DYNAMIC_ZOOM_CONFIDENCE_FALL"), 0.72),
        "dynamic_zoom_confidence_rise": parse_float(os.environ.get("DYNAMIC_ZOOM_CONFIDENCE_RISE"), 0.24),
        "dynamic_zoom_transition_lead": parse_float(os.environ.get("DYNAMIC_ZOOM_TRANSITION_LEAD_SECONDS"), 0.25),
        "transcript_review": parse_int(os.environ.get("TRANSCRIPT_REVIEW_ENABLED"), 1),
        "transcript_review_batch": parse_int(os.environ.get("TRANSCRIPT_REVIEW_BATCH_SIZE"), 80),
        "language": os.environ.get("VIDEO_LANGUAGE", "id"),
        "transcribe_provider": transcribe_provider,
        "deepgram_enabled": parse_int(os.environ.get("DEEPGRAM_ENABLED"), 0),
        "deepgram_keys": parse_keys(os.environ.get("DEEPGRAM_API_KEYS") or os.environ.get("DEEPGRAM_API_KEY")),
        "deepgram_model": os.environ.get("DEEPGRAM_MODEL", "nova-3"),
        "deepgram_language": os.environ.get("DEEPGRAM_LANGUAGE") or os.environ.get("VIDEO_LANGUAGE", "id"),
        "deepgram_timeout": parse_int(os.environ.get("DEEPGRAM_TIMEOUT_SECONDS"), 900),
        "offline_model": os.environ.get("OFFLINE_TRANSCRIBE_MODEL", "small"),
        "offline_device": os.environ.get("OFFLINE_TRANSCRIBE_DEVICE", "cpu"),
        "offline_compute": os.environ.get("OFFLINE_TRANSCRIBE_COMPUTE_TYPE", "int8"),
        "offline_beam_size": parse_int(os.environ.get("OFFLINE_TRANSCRIBE_BEAM_SIZE"), 5),
        "offline_vad_filter": parse_int(os.environ.get("OFFLINE_TRANSCRIBE_VAD_FILTER"), 1),
        "offline_vad_min_silence_ms": parse_int(os.environ.get("OFFLINE_TRANSCRIBE_VAD_MIN_SILENCE_MS"), 500),
        "offline_cpu_threads": parse_int(os.environ.get("OFFLINE_TRANSCRIBE_CPU_THREADS"), 0),
        "offline_num_workers": parse_int(os.environ.get("OFFLINE_TRANSCRIBE_NUM_WORKERS"), 1),
    }


def ensure_dirs():
    for name in ["input", "downloads", "temp", "clips", "output"]:
        (ROOT / name).mkdir(exist_ok=True)


def create_job_id(url):
    digest = url_hash(url)
    stamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(":", "-").replace(".", "-")
    return f"{stamp}-{digest}"


def url_hash(url):
    return hashlib.md5(url.encode("utf-8")).hexdigest()[:8]


def latest_cached_json(url, suffix):
    digest = url_hash(url)
    files = sorted((ROOT / "temp").glob(f"*{digest}-{suffix}.json"), key=lambda path: path.stat().st_mtime, reverse=True)

    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            log_warn(f"Pakai cache lokal: {path.relative_to(ROOT)}")
            return data
        except (OSError, json.JSONDecodeError):
            continue

    return None


def latest_cached_subtitle(url):
    digest = url_hash(url)
    patterns = [f"*{digest}*.vtt", f"*{digest}*.srt"]

    for pattern in patterns:
        files = sorted((ROOT / "temp").glob(pattern), key=lambda path: path.stat().st_mtime, reverse=True)
        for path in files:
            if path.is_file() and path.stat().st_size > 0:
                log_warn(f"Pakai transcript VTT/SRT cache: {path.relative_to(ROOT)}")
                return path

    return None


def run(args, capture=False):
    kwargs = {
        "cwd": ROOT,
        "check": True,
        "text": True,
    }

    if capture:
        kwargs["stdout"] = subprocess.PIPE
        kwargs["stderr"] = subprocess.PIPE

    return subprocess.run(args, **kwargs)


def run_ytdlp(args, capture=False):
    common_args = ytdlp_common_args()

    try:
        return run(["yt-dlp", *common_args, *args], capture=capture)
    except FileNotFoundError:
        return run([sys.executable, "-m", "yt_dlp", *common_args, *args], capture=capture)


def ytdlp_common_args():
    args = []

    cookies_file = os.environ.get("YTDLP_COOKIES_FILE", "").strip()
    cookies_browser = os.environ.get("YTDLP_COOKIES_FROM_BROWSER", "").strip()
    user_agent = os.environ.get("YTDLP_USER_AGENT", "").strip()
    referer = os.environ.get("YTDLP_REFERER", "").strip()
    js_runtimes = os.environ.get("YTDLP_JS_RUNTIMES", "node").strip()
    remote_components = os.environ.get("YTDLP_REMOTE_COMPONENTS", "ejs:github").strip()
    sleep_requests = os.environ.get("YTDLP_SLEEP_REQUESTS", "").strip()
    sleep_interval = os.environ.get("YTDLP_SLEEP_INTERVAL", "").strip()
    max_sleep_interval = os.environ.get("YTDLP_MAX_SLEEP_INTERVAL", "").strip()
    retries = os.environ.get("YTDLP_RETRIES", "").strip()
    fragment_retries = os.environ.get("YTDLP_FRAGMENT_RETRIES", "").strip()
    retry_sleep = os.environ.get("YTDLP_RETRY_SLEEP", "").strip()

    # Prioritas 1: pakai file cookies.txt
    # Letakkan cookies.txt di root project:
    # C:\xampp\htdocs\auto-video-clipper\cookies.txt
    if not cookies_file and os.path.exists("cookies.txt"):
        cookies_file = "cookies.txt"

    if cookies_file:
        args.extend(["--cookies", cookies_file])
    elif cookies_browser:
        args.extend(["--cookies-from-browser", cookies_browser])

    if user_agent:
        args.extend(["--user-agent", user_agent])

    if referer:
        args.extend(["--referer", referer])

    if remote_components:
        args.extend(["--remote-components", remote_components])

    if js_runtimes:
        args.extend(["--js-runtimes", js_runtimes])

    if sleep_requests:
        args.extend(["--sleep-requests", sleep_requests])

    if sleep_interval:
        args.extend(["--sleep-interval", sleep_interval])

    if max_sleep_interval:
        args.extend(["--max-sleep-interval", max_sleep_interval])

    if retries:
        args.extend(["--retries", retries])

    if fragment_retries:
        args.extend(["--fragment-retries", fragment_retries])

    if retry_sleep:
        args.extend(["--retry-sleep", retry_sleep])

    return args


def get_video_info(url):
    result = run_ytdlp(["-J", "--skip-download", "--no-warnings", url], capture=True)
    return json.loads(result.stdout)


def language_candidates(info, preferred):
    subtitles = info.get("subtitles") or {}
    automatic = info.get("automatic_captions") or {}
    available = list(dict.fromkeys([*subtitles.keys(), *automatic.keys()]))

    exact = [lang for lang in [preferred, "id", "en"] if lang in available]
    preferred_prefix = [lang for lang in available if lang.startswith(f"{preferred}-") or lang.startswith(f"{preferred}_")]
    english_prefix = [lang for lang in available if lang.startswith("en-") or lang.startswith("en_")]
    rest = [lang for lang in available if "live_chat" not in lang]

    return list(dict.fromkeys([*exact, *preferred_prefix, *english_prefix, *rest]))


def download_subtitle(url, job_id, language):
    log_step("Ambil transcript/subtitle YouTube.")

    selected_lang = None
    try:
        info = get_video_info(url)
        candidates = language_candidates(info, language)
        selected_lang = candidates[0] if candidates else None
        if selected_lang:
            log_info(f"Transcript tersedia. Bahasa dipakai: {selected_lang}")
    except Exception as exc:
        log_warn(f"Gagal membaca daftar transcript: {exc}")

    output_template = f"temp/{job_id}.%(ext)s"
    sub_langs = selected_lang or f"{language}.*,{language},id.*,id,en.*,en"

    try:
        run_ytdlp(
            [
                "--skip-download",
                "--write-auto-subs",
                "--write-subs",
                "--sub-langs",
                sub_langs,
                "--sub-format",
                "vtt/best",
                "-o",
                output_template,
                url,
            ]
        )
    except subprocess.CalledProcessError as exc:
        log_warn(f"Gagal mengambil subtitle: {exc}")

    candidates = sorted((ROOT / "temp").glob(f"{job_id}*.vtt")) + sorted((ROOT / "temp").glob(f"{job_id}*.srt"))
    if not candidates:
        log_warn("Transcript YouTube tidak ditemukan.")
        return None

    subtitle_path = candidates[0]
    log_info(f"Transcript dipakai: {subtitle_path.relative_to(ROOT)}")
    return subtitle_path


def parse_time(value):
    clean = str(value).replace(",", ".").strip().split(" ")[0]
    parts = clean.split(":")
    try:
        if len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
        return float(clean)
    except ValueError:
        return 0.0


def normalize_text(text):
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", text.lower(), flags=re.UNICODE)).strip()


INLINE_TIMESTAMP_RE = re.compile(r"<(\d{1,2}:\d{2}:\d{2}\.\d{3})>")


def clean_caption_text(line):
    line = re.sub(r"<[^>]+>", "", line)
    line = re.sub(r"\{\\an\d+\}", "", line)
    return re.sub(r"\s+", " ", line).strip()


def parse_vtt(path):
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    segments = []
    timed_words = []

    for index, line in enumerate(lines):
        if "-->" not in line:
            continue

        start_raw, end_raw = [item.strip() for item in line.split("-->", 1)]
        cue_start = parse_time(start_raw)
        cue_end = parse_time(end_raw)
        text_lines = []
        cursor = index + 1

        while cursor < len(lines) and lines[cursor].strip():
            text = lines[cursor].strip()
            if text and not text.startswith("NOTE"):
                text_lines.append(text)
            cursor += 1

        if any(INLINE_TIMESTAMP_RE.search(text) for text in text_lines):
            timed_words.extend(extract_timed_words(text_lines, cue_start, cue_end))
            continue

        if cue_end - cue_start <= 0.05:
            continue

        text = re.sub(r"\s+", " ", " ".join(clean_caption_text(item) for item in text_lines)).strip()
        if text:
            segments.append(
                {
                    "start": cue_start,
                    "end": cue_end,
                    "text": text,
                }
            )

    if len(timed_words) >= 20:
        return build_caption_segments_from_words(timed_words)

    return dedupe_segments(segments)


def extract_timed_words(text_lines, cue_start, cue_end):
    words = []

    for line in text_lines:
        if not INLINE_TIMESTAMP_RE.search(line):
            continue

        parts = INLINE_TIMESTAMP_RE.split(line)
        add_words_at_time(words, clean_caption_text(parts[0]), cue_start)

        for index in range(1, len(parts), 2):
            time_value = parse_time(parts[index])
            if time_value < cue_start - 0.25 or time_value > cue_end + 0.25:
                continue
            chunk = clean_caption_text(parts[index + 1] if index + 1 < len(parts) else "")
            add_words_at_time(words, chunk, time_value)

    return words


def add_words_at_time(result, text, start):
    for word in str(text or "").split():
        cleaned = word.strip()
        if cleaned:
            result.append({"start": float(start), "text": cleaned})


def build_caption_segments_from_words(timed_words):
    words = dedupe_timed_words(timed_words)
    segments = []
    current = []
    start = None
    last_start = None

    def flush(next_start=None):
        nonlocal current, start, last_start
        if not current or start is None or last_start is None:
            return

        if next_start is None:
            end = last_start + 1.1
        elif next_start - last_start > 1.1:
            end = last_start + 1.1
        else:
            end = next_start

        end = max(start + 0.55, end)
        segments.append({"start": start, "end": end, "text": " ".join(current)})
        current = []
        start = None
        last_start = None

    for word in words:
        word_start = float(word["start"])
        text = str(word["text"]).strip()
        if not text:
            continue

        if current:
            elapsed = word_start - float(start)
            gap = word_start - float(last_start)
            if len(current) >= 7 or elapsed >= 1.8 or gap > 1.0:
                flush(word_start)

        if not current:
            start = word_start

        current.append(text)
        last_start = word_start

    flush()
    return dedupe_segments(segments)


def dedupe_timed_words(timed_words):
    result = []
    seen = set()

    ordered = sorted(enumerate(timed_words), key=lambda item: (float(item[1]["start"]), item[0]))

    for _, word in ordered:
        start = round(float(word["start"]), 2)
        text = str(word["text"]).strip()
        key = (start, normalize_text(text))
        if not text or key in seen:
            continue
        seen.add(key)
        result.append({"start": float(word["start"]), "text": text})

    return result


def dedupe_segments(segments):
    result = []

    for segment in sorted(segments, key=lambda item: (item["start"], item["end"])):
        text = segment["text"].strip()
        if not text:
            continue

        if result:
            previous = result[-1]
            prev_text = normalize_text(previous["text"])
            curr_text = normalize_text(text)
            overlaps = segment["start"] <= previous["end"] + 0.25

            if curr_text == prev_text:
                continue

            if overlaps and curr_text and prev_text and curr_text in prev_text:
                continue

            if overlaps and curr_text and prev_text and prev_text in curr_text:
                result[-1] = {
                    **segment,
                    "start": previous["start"],
                    "end": max(previous["end"], segment["end"]),
                    "text": text,
                }
                continue

        result.append({**segment, "text": text})

    return result


def download_audio(url, job_id):
    log_step("Download audio untuk transkripsi.")
    output = ROOT / "temp" / f"{job_id}.mp3"
    run_ytdlp(["-x", "--audio-format", "mp3", "-o", str(output), url])
    return output



def audio_content_type(audio_path):
    suffix = Path(audio_path).suffix.lower()
    if suffix == ".mp3":
        return "audio/mpeg"
    if suffix == ".wav":
        return "audio/wav"
    if suffix == ".m4a":
        return "audio/mp4"
    if suffix == ".webm":
        return "audio/webm"
    if suffix == ".ogg":
        return "audio/ogg"
    return "application/octet-stream"


def mask_secret(value):
    value = str(value or "")
    if not value:
        return "NO_KEY"
    if len(value) <= 12:
        return "***"
    return f"{value[:6]}...{value[-4:]}"


def transcribe_deepgram(audio_path, job_id, config):
    log_step("Transkripsi audio dengan Deepgram Nova-3.")

    keys = config.get("deepgram_keys") or []
    if not keys:
        raise RuntimeError("DEEPGRAM_API_KEYS / DEEPGRAM_API_KEY belum diisi di .env atau environment variable.")

    last_error = None
    for index, api_key in enumerate(keys):
        try:
            log_info(f"Deepgram key {index + 1}/{len(keys)} aktif ({mask_secret(api_key)})")
            return transcribe_deepgram_single_key(audio_path, job_id, config, api_key, index)
        except Exception as exc:
            last_error = exc
            log_warn(f"Deepgram key {index + 1}/{len(keys)} gagal: {exc}")

    raise RuntimeError(f"Semua Deepgram API key gagal: {last_error}")


def transcribe_deepgram_single_key(audio_path, job_id, config, api_key, key_index=0):
    params = {
        "model": config.get("deepgram_model", "nova-3"),
        "language": config.get("deepgram_language") or config.get("language", "id"),
        "smart_format": "true",
        "punctuate": "true",
        "utterances": "true",
        "paragraphs": "false",
    }
    endpoint = "https://api.deepgram.com/v1/listen?" + urllib.parse.urlencode(params)

    audio_path = Path(audio_path)
    audio_size_mb = audio_path.stat().st_size / (1024 * 1024)
    log_info(f"Upload audio ke Deepgram: {audio_path.name} ({audio_size_mb:.2f} MB)")

    request = urllib.request.Request(
        endpoint,
        data=audio_path.read_bytes(),
        headers={
            "Authorization": f"Token {api_key}",
            "Content-Type": audio_content_type(audio_path),
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=int(config.get("deepgram_timeout", 900))) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Deepgram HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Deepgram connection error: {exc}") from exc

    transcript_path = ROOT / "temp" / f"{job_id}-deepgram-key-{key_index + 1}-transcript.json"
    transcript_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    result = normalize_deepgram_segments(data)
    if not result:
        raise RuntimeError("Deepgram berhasil merespons, tetapi segment transkrip kosong.")

    log_info(f"Deepgram menghasilkan {len(result)} segment transkrip.")
    return result


def normalize_deepgram_segments(data):
    results = data.get("results") or {}

    utterance_segments = normalize_deepgram_utterances(results.get("utterances") or [])
    if utterance_segments:
        return utterance_segments

    channels = results.get("channels") or []
    if not channels:
        return []

    alternatives = channels[0].get("alternatives") or []
    if not alternatives:
        return []

    alternative = alternatives[0]
    word_segments = normalize_deepgram_words(alternative.get("words") or [])
    if word_segments:
        return word_segments

    transcript = str(alternative.get("transcript") or "").strip()
    if transcript:
        duration = float((data.get("metadata") or {}).get("duration") or 0)
        return [{"start": 0.0, "end": max(duration, 0.0), "text": transcript}]

    return []


def normalize_deepgram_utterances(utterances):
    result = []

    for utterance in utterances:
        text = str(utterance.get("transcript") or "").strip()
        if not text:
            continue

        try:
            start = float(utterance.get("start") or 0)
            end = float(utterance.get("end") or start)
        except (TypeError, ValueError):
            continue

        if end <= start:
            end = start + 0.75

        words = utterance.get("words") or []
        if len(words) >= 14:
            result.extend(normalize_deepgram_words(words))
        else:
            result.append({"start": start, "end": end, "text": text})

    return dedupe_segments(result)


def normalize_deepgram_words(words):
    result = []
    current_words = []
    current_start = None
    current_end = None
    last_end = None

    def flush():
        nonlocal current_words, current_start, current_end, last_end
        if not current_words or current_start is None:
            current_words = []
            current_start = None
            current_end = None
            last_end = None
            return

        text = re.sub(r"\s+", " ", " ".join(current_words)).strip()
        if text:
            end = current_end if current_end is not None else current_start + 0.75
            if end <= current_start:
                end = current_start + 0.75
            result.append({"start": float(current_start), "end": float(end), "text": text})

        current_words = []
        current_start = None
        current_end = None
        last_end = None

    for item in words:
        raw_word = item.get("punctuated_word") or item.get("word") or ""
        word = str(raw_word).strip()
        if not word:
            continue

        try:
            start = float(item.get("start") or 0)
            end = float(item.get("end") or start)
        except (TypeError, ValueError):
            continue

        if current_start is None:
            current_start = start

        gap = 0 if last_end is None else start - float(last_end)
        elapsed = end - float(current_start)
        sentence_end = bool(re.search(r"[.!?。！？]$", word))

        if current_words and (gap > 1.0 or len(current_words) >= 10 or elapsed >= 3.4):
            flush()
            current_start = start

        current_words.append(word)
        current_end = end
        last_end = end

        if sentence_end and len(current_words) >= 4:
            flush()

    flush()
    return dedupe_segments(result)


def transcribe_audio(audio_path, job_id, config):
    provider = str(config.get("transcribe_provider", "offline")).lower()

    if provider == "offline":
        log_info("TRANSCRIBE_PROVIDER=offline. Deepgram dilewati.")
        return transcribe_offline(audio_path, job_id, config)

    if provider in {"auto", "deepgram"} and int(config.get("deepgram_enabled", 0)) == 1:
        if config.get("deepgram_keys"):
            try:
                return transcribe_deepgram(audio_path, job_id, config)
            except Exception as exc:
                log_warn(f"Deepgram gagal total: {exc}")
                if provider == "deepgram":
                    log_warn("Fallback tetap memakai faster-whisper agar proses lokal tidak putus.")
                log_step("Fallback transkripsi offline dengan faster-whisper.")
        else:
            log_warn("DEEPGRAM_API_KEYS / DEEPGRAM_API_KEY belum diisi. Pakai faster-whisper offline.")
    elif provider == "deepgram":
        log_warn("TRANSCRIBE_PROVIDER=deepgram tetapi DEEPGRAM_ENABLED=0. Pakai faster-whisper offline.")
    else:
        log_warn("TRANSCRIBE_PROVIDER=auto tanpa Deepgram aktif. Pakai faster-whisper offline.")

    return transcribe_offline(audio_path, job_id, config)


def transcribe_offline(audio_path, job_id, config):
    log_step("Transkripsi audio offline dengan faster-whisper.")

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError("faster-whisper belum terinstall. Jalankan: npm run setup:offline") from exc

    model_kwargs = {
        "device": config["offline_device"],
        "compute_type": config["offline_compute"],
    }
    if int(config.get("offline_cpu_threads", 0)) > 0:
        model_kwargs["cpu_threads"] = int(config["offline_cpu_threads"])
    if int(config.get("offline_num_workers", 1)) > 0:
        model_kwargs["num_workers"] = int(config["offline_num_workers"])

    log_info(
        "faster-whisper "
        f"model={config['offline_model']} "
        f"device={config['offline_device']} "
        f"compute={config['offline_compute']} "
        f"beam={config.get('offline_beam_size', 5)}"
    )

    model = WhisperModel(config["offline_model"], **model_kwargs)

    vad_enabled = int(config.get("offline_vad_filter", 1)) == 1
    transcribe_kwargs = {
        "language": config["language"],
        "vad_filter": vad_enabled,
        "beam_size": max(1, int(config.get("offline_beam_size", 5))),
    }
    if vad_enabled:
        transcribe_kwargs["vad_parameters"] = {
            "min_silence_duration_ms": max(100, int(config.get("offline_vad_min_silence_ms", 500)))
        }

    segments, info = model.transcribe(str(audio_path), **transcribe_kwargs)
    result = [
        {"start": float(segment.start), "end": float(segment.end), "text": segment.text.strip()}
        for segment in segments
        if segment.text and segment.text.strip()
    ]

    transcript_path = ROOT / "temp" / f"{job_id}-offline-transcript.json"
    transcript_path.write_text(
        json.dumps(
            {
                "language": info.language,
                "language_probability": info.language_probability,
                "segments": result,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return result


def format_ts(seconds):
    total = max(0, float(seconds))
    h = int(total // 3600)
    m = int((total % 3600) // 60)
    s = int(total % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def transcript_text(segments):
    return "\n".join(
        f"[{format_ts(segment['start'])} - {format_ts(segment['end'])}] {segment['text']}"
        for segment in segments
    )


def extract_json(text):
    raw = str(text or "").strip()
    decoder = json.JSONDecoder()

    try:
        data, _ = decoder.raw_decode(raw)
        return data
    except json.JSONDecodeError:
        pass

    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, re.IGNORECASE)
    if fenced:
        data, _ = decoder.raw_decode(fenced.group(1).strip())
        return data

    start = raw.find("[")
    if start < 0:
        raise ValueError("Gemini tidak mengembalikan JSON array valid.")

    data, _ = decoder.raw_decode(raw[start:])
    return data


def call_gemini(prompt, api_key, model):
    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    payload = json.dumps(
        {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.2,
                "responseMimeType": "application/json",
            },
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        endpoint,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-goog-api-key": api_key,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Gemini HTTP {exc.code}: {detail}") from exc

    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    return "".join(part.get("text", "") for part in parts)


def segment_text_window(segments, start, end, max_chars=180):
    text = " ".join(
        str(segment.get("text", "")).strip()
        for segment in segments
        if float(segment.get("end", 0)) > start and float(segment.get("start", 0)) < end
    )
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."


def local_clip_score(text, start, duration):
    normalized = normalize_text(text)
    score = 0.0
    keyword_weights = {
        "rahasia": 5,
        "ternyata": 5,
        "masalah": 4,
        "kenapa": 4,
        "gimana": 4,
        "caranya": 4,
        "penting": 4,
        "viral": 4,
        "uang": 4,
        "miliar": 4,
        "triliun": 4,
        "ancaman": 4,
        "takut": 3,
        "salah": 3,
        "benar": 3,
        "jangan": 3,
        "jujur": 3,
        "gagal": 3,
        "sukses": 3,
        "bisnis": 3,
        "keluarga": 3,
        "karier": 3,
        "hidup": 3,
        "kalau": 2,
        "tapi": 2,
        "karena": 2,
        "jadi": 2,
        "gue": 1,
        "saya": 1,
    }
    intro_penalties = [
        "assalamualaikum",
        "jangan lupa subscribe",
        "like comment",
        "terima kasih sudah menonton",
    ]

    for keyword, weight in keyword_weights.items():
        if keyword in normalized:
            score += weight

    if re.search(r"\d", text):
        score += 4
    if "?" in text:
        score += 3
    if "!" in text:
        score += 2
    if 40 <= duration <= 65:
        score += 3
    if start < 20:
        score -= 4
    if any(phrase in normalized for phrase in intro_penalties):
        score -= 6

    words = normalized.split()
    unique_ratio = len(set(words)) / max(len(words), 1)
    score += min(len(words) / 12, 8)
    score += unique_ratio * 4
    return score


def local_clip_title(text, index):
    words = [word for word in re.split(r"\s+", text.strip()) if word]
    title = " ".join(words[:8]).strip(" .,!?;:-")
    if not title:
        return f"Clip {index + 1}"
    return title[:70]


def build_candidate_clips(segments, config):
    min_duration = max(10, int(config.get("min_clip_seconds", 40)))
    max_duration = max(min_duration, int(config.get("max_clip_seconds", 60)))
    max_candidates = max(1, min(8, int(config.get("ai_candidate_max_count", 5))))
    max_total_chars = max(700, int(config.get("ai_candidate_max_chars", 4000)))
    per_candidate_chars = max(220, min(1100, max_total_chars // max_candidates))

    scored = []
    for start_index, segment in enumerate(segments):
        start = float(segment.get("start", 0))
        end = start

        for next_segment in segments[start_index:]:
            end = float(next_segment.get("end", end))
            duration = end - start
            if duration < min_duration:
                continue
            if duration > max_duration:
                break

            text = segment_text_window(segments, start, end, max_chars=per_candidate_chars)
            if len(text.split()) < 8:
                continue

            scored.append(
                {
                    "score": local_clip_score(text, start, duration),
                    "start": start,
                    "end": end,
                    "duration": duration,
                    "text": text,
                }
            )

    scored.sort(key=lambda item: item["score"], reverse=True)
    selected = []
    for candidate in scored:
        overlaps = any(
            candidate["start"] < item["end"] and candidate["end"] > item["start"]
            for item in selected
        )
        if overlaps:
            continue
        selected.append(candidate)
        if len(selected) >= max_candidates:
            break

    if not selected and segments:
        start = float(segments[0].get("start", 0))
        end = min(float(segments[-1].get("end", start + max_duration)), start + max_duration)
        selected.append(
            {
                "score": 0,
                "start": start,
                "end": end,
                "duration": end - start,
                "text": segment_text_window(segments, start, end, max_chars=per_candidate_chars),
            }
        )

    candidates = []
    used_chars = 0
    for index, item in enumerate(selected):
        room = max_total_chars - used_chars
        if room <= 80:
            break

        text = str(item["text"]).strip()
        if len(text) > room:
            text = text[: room - 3].rstrip() + "..."

        used_chars += len(text)
        candidates.append(
            {
                "candidate_id": index + 1,
                "start": round(float(item["start"]), 2),
                "end": round(float(item["end"]), 2),
                "duration": round(float(item["duration"]), 2),
                "text": text,
                "local_score": round(float(item["score"]), 2),
            }
        )

    return candidates


def candidate_to_clip(candidate, index=0, reason=""):
    text = str(candidate.get("text", "")).strip()
    title = local_clip_title(text, index)
    return {
        "title": title,
        "reason": reason or "Fallback lokal memilih bagian dengan sinyal hook, angka, konflik, dan kata kunci kuat.",
        "start": float(candidate.get("start", 0)),
        "end": float(candidate.get("end", 0)),
        "hook": text,
        "caption": text,
        "candidate_id": candidate.get("candidate_id") or index + 1,
        "clip_transcript": text,
        "viral_score": int(float(candidate.get("local_score", 0))),
        "publish_decision": "local_fallback",
    }


def find_important_clips(segments, config):
    candidates = build_candidate_clips(segments, config)
    if not candidates:
        raise RuntimeError("Tidak ada kandidat clip lokal dari transcript.")

    local_clips = [candidate_to_clip(item, index) for index, item in enumerate(candidates)]

    if int(config.get("ai_clip_selection", 1)) != 1:
        log_warn("AI_CLIP_SELECTION_ENABLED=0. Pakai kandidat lokal offline.")
        return validate_clips(local_clips, segments, config)

    if not config["gemini_keys"]:
        log_warn("GEMINI_API_KEYS kosong. Pakai fallback analisis lokal offline.")
        return validate_clips(local_clips, segments, config)

    log_info(
        f"Candidate clip lokal: {len(candidates)} kandidat. "
        f"Gemini hanya menerima potongan kandidat <= {config.get('ai_candidate_max_chars', 4000)} karakter."
    )

    prompt = f"""
Anda adalah editor video short-form profesional.

Tugas:
Pilih {config['clip_count']} bagian terbaik dari daftar candidate clip untuk dijadikan clip pendek.

Kriteria:
- Ada hook kuat.
- Ada insight, konflik, edukasi, data menarik, kejutan, emosi, atau kalimat yang cocok untuk short video.
- Durasi minimal {config['min_clip_seconds']} detik.
- Durasi maksimal {config['max_clip_seconds']} detik.
- Mudah dipahami tanpa konteks terlalu panjang.
- Hindari opening basa-basi.
- Cocok untuk TikTok, Instagram Reels, dan YouTube Shorts.
- Untuk tahap ini pilih hanya bagian paling kuat, jangan banyak-banyak.
- Output harus JSON valid saja, tanpa markdown.

Format output:
[
  {{
    "title": "Judul singkat clip",
    "reason": "Alasan bagian ini menarik",
    "start": 80,
    "end": 130,
    "hook": "Kalimat pembuka yang menarik",
    "caption": "Caption posting singkat"
  }}
]

Gunakan start dan end dari candidate yang dipilih. Jangan mengarang fakta di luar candidate transcript.

Candidate clips:
{json.dumps(candidates, ensure_ascii=False, indent=2)}
"""

    last_error = None
    for index, key in enumerate(config["gemini_keys"]):
        try:
            log_info(f"Analisis bagian penting memakai Gemini key {index + 1}/{len(config['gemini_keys'])}")
            clips = extract_json(call_gemini(prompt, key, config["gemini_model"]))
            return validate_clips(clips, segments, config)
        except Exception as exc:
            last_error = exc
            log_warn(f"Gemini key gagal: {exc}")

    log_warn(f"Semua Gemini key gagal. Pakai fallback analisis lokal offline: {last_error}")
    return validate_clips(local_clips, segments, config)


def validate_clips(clips, segments, config):
    if isinstance(clips, dict):
        clips = clips.get("clips") or clips.get("data") or clips.get("results")

    if not isinstance(clips, list):
        raise ValueError("Output clip harus array.")

    max_time = max([float(segment["end"]) for segment in segments] or [0])
    result = []

    for index, clip in enumerate(clips):
        try:
            start = max(0.0, float(clip.get("start")))
            end = max(0.0, float(clip.get("end")))
        except (TypeError, ValueError):
            continue

        if max_time:
            end = min(end, max_time)

        if end <= start:
            continue

        result.append(
            {
                "title": clip.get("title") or f"Clip {index + 1}",
                "reason": clip.get("reason") or "",
                "start": start,
                "end": end,
                "hook": clip.get("hook") or "",
                "caption": clip.get("caption") or "",
                "thumbnail_text": clip.get("thumbnail_text") or clip.get("thumbnailText") or "",
                "viral_score": clip.get("viral_score") or clip.get("viralScore") or 0,
                "publish_decision": clip.get("publish_decision") or clip.get("publishDecision") or "",
                "candidate_id": clip.get("candidate_id") or clip.get("candidateId") or "",
                "clip_transcript": clip.get("clip_transcript")
                or clip.get("clipTranscript")
                or segment_text_window(segments, start, end, max_chars=1200),
            }
        )

    return result[: config["clip_count"]]


def review_clip_transcript_segments(segments, clip, config, job_id, index):
    if int(config.get("transcript_review", 1)) != 1:
        return segments, None

    if not config.get("gemini_keys"):
        log_warn("Transcript review dilewati: GEMINI_API_KEYS kosong.")
        return segments, None

    clip_start = float(clip["start"])
    clip_end = float(clip["end"])
    target_indexes = [
        idx
        for idx, segment in enumerate(segments)
        if float(segment["end"]) > clip_start - 1.5 and float(segment["start"]) < clip_end + 1.5
    ]

    if not target_indexes:
        return segments, None

    reviewed = [dict(segment) for segment in segments]
    batch_size = max(20, int(config.get("transcript_review_batch", 80)))
    corrections = []

    log_step(f"Gemini review subtitle clip {index + 1}.")

    for offset in range(0, len(target_indexes), batch_size):
        batch_indexes = target_indexes[offset : offset + batch_size]
        items = [
            {
                "i": idx,
                "start": format_ts(segments[idx]["start"]),
                "end": format_ts(segments[idx]["end"]),
                "text": segments[idx]["text"],
            }
            for idx in batch_indexes
        ]

        prompt = f"""
Anda adalah editor subtitle bahasa Indonesia yang sangat konservatif.

Tugas:
- Perbaiki HANYA kata/frasa yang jelas salah hasil speech-to-text YouTube.
- Jangan parafrase.
- Jangan mengubah gaya bicara.
- Jangan menerjemahkan.
- Jangan mengganti kalimat yang sudah benar.
- Pertahankan jumlah item dan id `i`.
- Timestamp hanya konteks, jangan diubah.
- Jika ragu, biarkan teks asli.

Output JSON array valid saja:
[
  {{"i": 123, "text": "teks yang sudah dikoreksi atau tetap sama"}}
]

Segmen subtitle:
{json.dumps(items, ensure_ascii=False, indent=2)}
"""

        fixed_items = call_gemini_for_transcript_review(prompt, config)
        for item in fixed_items:
            try:
                idx = int(item.get("i"))
            except (TypeError, ValueError):
                continue

            if idx not in batch_indexes:
                continue

            old_text = str(segments[idx].get("text", "")).strip()
            new_text = re.sub(r"\s+", " ", str(item.get("text", "")).strip())
            if not is_safe_transcript_correction(old_text, new_text):
                continue

            if new_text != old_text:
                reviewed[idx]["text"] = new_text
                corrections.append(
                    {
                        "index": idx,
                        "start": segments[idx]["start"],
                        "end": segments[idx]["end"],
                        "before": old_text,
                        "after": new_text,
                    }
                )

    review_path = ROOT / "temp" / f"{job_id}-clip-{index + 1:02d}-transcript-review.json"
    review_path.write_text(
        json.dumps(
            {
                "clipTitle": clip["title"],
                "start": clip_start,
                "end": clip_end,
                "totalSegmentsChecked": len(target_indexes),
                "totalCorrections": len(corrections),
                "corrections": corrections,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    log_info(f"Transcript review: {len(corrections)} koreksi, {review_path.relative_to(ROOT)}")
    return reviewed, review_path


def call_gemini_for_transcript_review(prompt, config):
    last_error = None

    for index, key in enumerate(config["gemini_keys"]):
        try:
            log_info(f"Review subtitle memakai Gemini key {index + 1}/{len(config['gemini_keys'])}")
            data = extract_json(call_gemini(prompt, key, config["gemini_model"]))
            return data if isinstance(data, list) else []
        except Exception as exc:
            last_error = exc
            log_warn(f"Gemini transcript review gagal: {exc}")

    log_warn(f"Transcript review dilewati: {last_error}")
    return []


def is_safe_transcript_correction(old_text, new_text):
    if not old_text or not new_text:
        return False

    old_words = old_text.split()
    new_words = new_text.split()
    if not old_words or not new_words:
        return False

    ratio = len(new_words) / max(1, len(old_words))
    if ratio < 0.55 or ratio > 1.65:
        return False

    old_norm = normalize_text(old_text)
    new_norm = normalize_text(new_text)
    if not old_norm or not new_norm:
        return False

    # Guard rail: koreksi boleh memperbaiki kata salah, tapi jangan rewrite total.
    common = set(old_norm.split()) & set(new_norm.split())
    min_common = 1 if min(len(old_words), len(new_words)) <= 4 else 2
    return len(common) >= min_common


def seconds_to_ass(seconds):
    total = max(0.0, float(seconds))
    h = int(total // 3600)
    m = int((total % 3600) // 60)
    s = int(total % 60)
    cs = int((total - int(total)) * 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def clean_filename(value):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "", str(value or "untitled"))
    value = re.sub(r"\s+", "-", value).strip("-")
    return value[:80] or "untitled"


def create_ass(segments, clip, index, config, job_id):
    ass_path = ROOT / "temp" / f"{job_id}-clip-{index + 1:02d}.ass"
    events = []
    clip_start = float(clip["start"])
    clip_end = float(clip["end"])
    duration = max(0.5, clip_end - clip_start)
    subtitle_offset = float(config.get("subtitle_offset", 0.0))

    for segment in segments:
        segment_start = float(segment["start"]) + subtitle_offset
        segment_end = float(segment["end"]) + subtitle_offset

        if segment_end <= clip_start or segment_start >= clip_end:
            continue

        cue_start = max(0.0, segment_start - clip_start)
        cue_end = min(duration, segment_end - clip_start)

        if cue_end - cue_start < 0.15:
            cue_end = min(duration, cue_start + 0.55)

        text = re.sub(r"\s+", " ", str(segment.get("text", ""))).strip()
        if text and cue_end > cue_start:
            events.append((cue_start, cue_end, ass_escape(wrap_caption(text))))

    if not events:
        rounded_duration = max(1, int(round(duration)))
        for offset in range(rounded_duration):
            window_start = clip_start + offset - subtitle_offset
            window_end = min(clip_end, window_start + 1.0)
            text = caption_for_window(segments, window_start, window_end)

            if not text:
                continue

            cue_start = float(offset)
            cue_end = min(duration, cue_start + 1.0)
            events.append((cue_start, cue_end, ass_escape(wrap_caption(text))))

    ass = build_ass(events, config)
    ass_path.write_text(ass, encoding="utf-8-sig")
    return ass_path


def caption_for_window(segments, window_start, window_end):
    best_segment = None
    best_overlap = 0.0

    for segment in segments:
        segment_start = float(segment["start"])
        segment_end = float(segment["end"])

        if segment_end <= window_start or segment_start >= window_end:
            continue

        overlap = min(segment_end, window_end) - max(segment_start, window_start)
        if overlap > best_overlap:
            best_segment = segment
            best_overlap = overlap

    if not best_segment:
        return ""

    return re.sub(r"\s+", " ", best_segment["text"]).strip()


def wrap_caption(text, words_per_line=5, lines_per_cue=2):
    words = re.sub(r"\s+", " ", text).strip().split()
    if not words:
        return ""

    words = words[: words_per_line * lines_per_cue]
    lines = [
        " ".join(words[i : i + words_per_line])
        for i in range(0, len(words), words_per_line)
    ]
    return "\\N".join(lines[:lines_per_cue])


def ass_escape(text):
    return (
        str(text)
        .replace("{", "")
        .replace("}", "")
        .replace("\n", "\\N")
    )


def build_ass(events, config):
    width = config["width"]
    height = config["height"]
    font_name = (os.environ.get("SUBTITLE_FONT_FAMILY") or "Segoe UI Semibold").strip() or "Segoe UI Semibold"
    font_size = parse_int(os.environ.get("SUBTITLE_FONT_SIZE"), 52)
    margin_v = parse_int(os.environ.get("SUBTITLE_MARGIN_V"), 600)
    margin_h = parse_int(os.environ.get("SUBTITLE_MARGIN_H"), 140)

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{font_name},{font_size},&H0000FFFF,&H0000FFFF,&H00111111,&H66000000,-1,0,0,0,100,100,0,0,1,4,1,2,{margin_h},{margin_h},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    lines = [header]
    for start, end, text in events:
        lines.append(
            f"Dialogue: 0,{seconds_to_ass(start)},{seconds_to_ass(end)},Caption,,0,0,0,,{text}\n"
        )

    return "".join(lines)


def download_clip_source(url, job_id, clip, index, config):
    start = max(0.0, float(clip["start"]))
    end = max(start + 0.5, float(clip["end"]))
    base = ROOT / "downloads" / f"{job_id}-section-{index + 1:02d}"
    output_template = str(base) + ".%(ext)s"
    section = f"*{start}-{end}"
    max_height = config["download_max_height"]
    formats = [
        f"bv*[height<={max_height}][fps<=30][ext=mp4]+ba[ext=m4a]/b[height<={max_height}][fps<=30][ext=mp4]",
        f"bv*[height<={max_height}][ext=mp4]+ba[ext=m4a]/b[height<={max_height}][ext=mp4]/bv*[height<={max_height}]+ba/b[height<={max_height}]",
        "b[ext=mp4]/b",
    ]

    log_step(f"Download section clip {index + 1}: {format_ts(start)}-{format_ts(end)}")

    last_error = None
    for fmt in formats:
        try:
            run_ytdlp(
                [
                    "-f",
                    fmt,
                    "--download-sections",
                    section,
                    "--force-keyframes-at-cuts",
                    "--merge-output-format",
                    "mp4",
                    "-o",
                    output_template,
                    url,
                ]
            )
            break
        except subprocess.CalledProcessError as exc:
            last_error = exc
            log_warn(f"Download section gagal dengan format ini, coba fallback: {exc}")
    else:
        cached = find_cached_source_clip(url, clip)
        if cached:
            log_warn(f"YouTube sedang membatasi download. Pakai source cache: {cached.relative_to(ROOT)}")
            return cached
        raise last_error

    candidates = sorted(base.parent.glob(f"{base.name}.*"))
    candidates = [path for path in candidates if path.suffix.lower() in [".mp4", ".webm", ".mkv", ".mov"]]
    if not candidates:
        raise RuntimeError(f"File section clip {index + 1} tidak ditemukan.")

    return compress_downloaded_clip(candidates[0], config)


def find_cached_source_clip(url, clip=None):
    digest = url_hash(url)
    if clip:
        matched = find_cached_source_clip_from_results(digest, clip)
        if matched:
            return matched

    patterns = [
        f"*{digest}*section-*-compressed.mp4",
        f"*{digest}*section-*.mp4",
    ]

    for pattern in patterns:
        files = sorted((ROOT / "downloads").glob(pattern), key=lambda path: path.stat().st_mtime, reverse=True)
        for path in files:
            if path.is_file() and path.stat().st_size > 0:
                return path

    return None


def find_cached_source_clip_from_results(digest, clip):
    wanted_start = float(clip["start"])
    wanted_end = float(clip["end"])
    result_files = sorted((ROOT / "output").glob(f"py-result-*{digest}.json"), key=lambda path: path.stat().st_mtime, reverse=True)

    for path in result_files:
        try:
            result = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        for output in result.get("outputs", []):
            try:
                start = float(output.get("start"))
                end = float(output.get("end"))
            except (TypeError, ValueError):
                continue

            if abs(start - wanted_start) > 1.0 or abs(end - wanted_end) > 1.0:
                continue

            for key in ["sourceClipPath", "rawClipPath"]:
                cached = output.get(key)
                if not cached:
                    continue
                cached_path = ROOT / cached
                if cached_path.is_file() and cached_path.stat().st_size > 0:
                    return cached_path

    return None


def compress_downloaded_clip(source_clip, config):
    compressed = source_clip.with_name(f"{source_clip.stem}-compressed.mp4")
    max_height = config["download_max_height"]

    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source_clip),
            "-vf", "fps=30,scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            str(config["download_crf"]),
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-movflags",
            "+faststart",
            str(compressed),
        ]
    )

    try:
        if compressed.exists() and compressed.stat().st_size > 0 and source_clip != compressed:
            source_clip.unlink(missing_ok=True)
    except OSError as exc:
        log_warn(f"Gagal hapus source besar: {exc}")

    return compressed


def centered_video_filter(config):
    width = config["width"]
    height = config["height"]
    return f"fps=30,scale={width}:{height}:force_original_aspect_ratio=increase,setsar=1,crop={width}:{height}"


def resolve_scene_mode_name(config):
    """Map smart_crop_mode + scene_mode env to a SceneMode preset name.

    Legacy values like 'active_speaker', 'face', 'center', 'auto' still work.
    New values map directly: 'podcast', 'solo', 'game', 'reaction', 'sport'.
    """
    raw = str(config.get("scene_mode") or config.get("smart_crop_mode") or "auto").lower().strip()
    legacy_aliases = {
        "off": "center",
        "none": "center",
        "static": "center",
        "face": "auto",
    }
    return legacy_aliases.get(raw, raw)


def smart_video_filter(source_clip, config, job_id, index):
    """Returns (vf_string, crop_path, points). points may be None for legacy single-pass.

    When the resolved scene mode supports `fullscreen` fallback (podcast / game / etc),
    we return points with `modeState` annotation so that the renderer can switch
    to segment-based rendering. The vf_string is still computed for the case where
    only one segment exists (=> single-pass render is fine and faster).
    """
    width = config["width"]
    height = config["height"]
    crop_path = None
    points = []
    crop_mode = str(config.get("smart_crop_mode", "auto")).lower().strip()

    if int(config.get("smart_crop", 1)) != 1 or crop_mode in {"center", "off", "none", "static"}:
        log_info("Smart crop nonaktif untuk render ini. Pakai crop tengah.")
        return centered_video_filter(config), crop_path, None

    try:
        points, crop_path = create_smart_crop_points(source_clip, config, job_id, index)
    except Exception as exc:
        log_warn(f"Smart crop gagal, pakai crop tengah: {exc}")
        return centered_video_filter(config), None, None

    if not points:
        return centered_video_filter(config), crop_path, None

    center_expr = build_interpolated_expression(points, "centerRatio")
    x_expr = f"min(max(iw*({center_expr})-ow/2,0),iw-ow)"
    x_expr = x_expr.replace(",", "\\,")
    log_info(f"Smart crop aktif: {len(points)} titik tracking")

    return (
        f"fps=30,scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"setsar=1,crop={width}:{height}:x='{x_expr}':y='(ih-oh)/2'"
    ), crop_path, points


def build_interpolated_expression(points, key):
    if not points:
        return "0.5"

    if len(points) == 1:
        return f"{float(points[0][key]):.6f}"

    expression = f"{float(points[-1][key]):.6f}"
    for index in range(len(points) - 2, -1, -1):
        start_time = float(points[index]["time"])
        end_time = float(points[index + 1]["time"])
        start_value = float(points[index][key])
        end_value = float(points[index + 1][key])
        duration = max(0.001, end_time - start_time)
        progress = f"min(max((t-{start_time:.3f})/{duration:.3f},0),1)"
        value = f"({start_value:.6f}+({end_value:.6f}-{start_value:.6f})*({progress}))"
        expression = f"if(lt(t,{end_time:.3f}),{value},{expression})"

    return expression


def create_smart_crop_points(source_clip, config, job_id, index):
    try:
        import cv2
    except ImportError:
        log_warn("OpenCV belum tersedia. Jalankan: python -m pip install opencv-python")
        return [], None

    scene_mode_name = resolve_scene_mode_name(config)
    crop_mode = str(config.get("smart_crop_mode", "auto")).lower().strip()

    new_pipeline_modes = {"podcast", "solo", "game", "reaction", "sport", "auto"}
    if scene_mode_name in new_pipeline_modes:
        try:
            points, crop_path = create_scene_mode_crop_points(source_clip, config, job_id, index)
            if points:
                return points, crop_path
            log_warn(f"Scene-mode '{scene_mode_name}' tidak menghasilkan tracking. Fallback ke active speaker legacy.")
        except Exception as exc:
            log_warn(f"Scene-mode '{scene_mode_name}' gagal: {exc}. Fallback ke active speaker legacy.")

    if crop_mode in {"active_speaker", "auto"} or scene_mode_name in new_pipeline_modes:
        points, crop_path = create_active_speaker_crop_points(source_clip, config, job_id, index)
        if points:
            return points, crop_path
        log_warn("Active speaker tidak menghasilkan tracking. Fallback ke face/visual smart crop.")

    cap = cv2.VideoCapture(str(source_clip))
    if not cap.isOpened():
        log_warn("Smart crop tidak bisa membuka source video.")
        return [], None

    source_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    source_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    frame_count = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frame_count / fps if fps > 0 and frame_count > 0 else 0

    if not source_width or not source_height or duration <= 0:
        cap.release()
        return [], None

    target_aspect = float(config["width"]) / float(config["height"])
    source_aspect = float(source_width) / float(source_height)
    if source_aspect <= target_aspect + 0.02:
        cap.release()
        return [], None

    cascade_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
    face_cascade = cv2.CascadeClassifier(str(cascade_path))
    if face_cascade.empty():
        cap.release()
        log_warn("Model face detection OpenCV tidak ditemukan.")
        return [], None

    sample_seconds = max(0.25, float(config.get("smart_crop_sample", 0.75)))
    points = []
    previous_gray = None
    initial_center, initial_score, initial_source = find_initial_visual_anchor_center(
        source_clip,
        source_width,
        source_height,
        config,
    )
    last_center = initial_center
    log_info(
        f"Fallback initial visual anchor: centerRatio={last_center / source_width:.3f}, "
        f"score={initial_score:.4f}, source={initial_source}"
    )
    t = 0.0

    while t < duration:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            break

        center, source, gray = detect_frame_center(frame, face_cascade, previous_gray)
        if source != "face":
            visual_center, visual_score = active_speaker_visual_content_center(
                frame,
                source_width,
                source_height,
                config,
            )
            visual_min_score = max(0.0, float(config.get("active_speaker_visual_min_score", 0.010)))
            if visual_center is not None and visual_score >= visual_min_score:
                center = visual_center
                source = "visual_content"

        if center is None:
            center = last_center
            source = "carry"

        center = clamp(center, 0, source_width)
        points.append(
            {
                "time": round(t, 3),
                "centerX": round(center, 2),
                "centerRatio": round(center / source_width, 6),
                "source": source,
            }
        )
        last_center = center
        previous_gray = gray
        t += sample_seconds

    cap.release()
    points = smooth_smart_crop_points(points, config, source_width)
    points = compress_smart_crop_points(points)

    crop_path = ROOT / "temp" / f"{job_id}-clip-{index + 1:02d}-smart-crop.json"
    crop_path.write_text(
        json.dumps(
            {
                "sourceClipPath": str(Path(source_clip).resolve().relative_to(ROOT)),
                "sourceWidth": source_width,
                "sourceHeight": source_height,
                "sampleSeconds": sample_seconds,
                "points": points,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    return points, crop_path



def create_active_speaker_crop_points(source_clip, config, job_id, index):
    """Create crop tracking points for podcast videos.

    Logic utama:
    - Jika wajah + bibir terdeteksi: crop mengikuti active speaker berdasarkan ukuran wajah dan gerak bibir.
    - Jika wajah terdeteksi tetapi bibir/gerak mulut tidak kuat: tahan speaker aktif sebelumnya agar tidak lompat.
    - Sebelum tracking dimulai: scan beberapa detik awal untuk menentukan initial visual anchor.
    - Jika tidak ada wajah/orang terdeteksi: fallback ke area visual paling berisi, lalu motion center.
    - Jika tidak ada wajah dan tidak ada motion/visual: tahan crop terakhir/initial visual anchor.
    - Center fallback default nonaktif agar podcast side-by-side tidak kosong di tengah.
    """
    try:
        import cv2
        import mediapipe as mp
    except ImportError:
        log_warn("MediaPipe belum tersedia. Jalankan: python -m pip install mediapipe opencv-python numpy")
        return [], None

    if not hasattr(mp, "solutions") or not hasattr(mp.solutions, "face_mesh"):
        log_warn("MediaPipe FaceMesh tidak tersedia di environment ini.")
        return [], None

    cap = cv2.VideoCapture(str(source_clip))
    if not cap.isOpened():
        log_warn("Active speaker crop tidak bisa membuka source video.")
        return [], None

    source_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    source_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    frame_count = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frame_count / fps if fps > 0 and frame_count > 0 else 0

    if not source_width or not source_height or duration <= 0:
        cap.release()
        return [], None

    target_aspect = float(config["width"]) / float(config["height"])
    source_aspect = float(source_width) / float(source_height)
    if source_aspect <= target_aspect + 0.02:
        cap.release()
        return [], None

    sample_seconds = max(0.20, float(config.get("smart_crop_sample", 0.35)))
    switch_seconds = max(0.35, float(config.get("active_speaker_switch_seconds", 1.2)))
    switch_hits_needed = max(1, int(round(switch_seconds / sample_seconds)))

    mouth_weight = float(config.get("active_speaker_mouth_weight", 0.55))
    face_weight = float(config.get("active_speaker_face_weight", 0.30))
    center_weight = float(config.get("active_speaker_center_weight", 0.10))
    stickiness_weight = float(config.get("active_speaker_stickiness_weight", 0.05))
    max_faces = max(1, int(config.get("active_speaker_max_faces", 4)))

    no_face_strategy = str(config.get("active_speaker_no_face_strategy", "visual_content")).lower().strip()
    no_face_center_after_seconds = max(0.5, float(config.get("active_speaker_no_face_center_after_seconds", 6.0)))
    no_face_center_hits = max(1, int(round(no_face_center_after_seconds / sample_seconds)))
    center_fallback_enabled = int(config.get("active_speaker_center_fallback_enabled", 0)) == 1
    min_mouth_score_to_switch = max(0.0, float(config.get("active_speaker_min_mouth_score_to_switch", 0.06)))
    switch_score_margin = max(0.0, float(config.get("active_speaker_switch_score_margin", 0.12)))
    visual_fallback_enabled = int(config.get("active_speaker_visual_fallback_enabled", 1)) == 1
    visual_min_score = max(0.0, float(config.get("active_speaker_visual_min_score", 0.025)))
    visual_hold_seconds = max(0.0, float(config.get("active_speaker_visual_hold_seconds", 1.5)))
    visual_hold_hits = max(1, int(round(visual_hold_seconds / sample_seconds)))

    previous_tracks = {}
    previous_mouth_by_track = {}
    next_track_id = 1
    active_track_id = None
    candidate_track_id = None
    candidate_hits = 0
    no_face_hits = 0
    no_face_total = 0
    motion_fallback_total = 0
    visual_fallback_total = 0
    center_fallback_total = 0
    carry_fallback_total = 0
    low_mouth_hold_total = 0
    visual_candidate_center = None
    visual_candidate_hits = 0

    initial_center, initial_score, initial_source = find_initial_visual_anchor_center(
        source_clip,
        source_width,
        source_height,
        config,
    )
    last_center = initial_center
    log_info(
        f"Initial visual anchor: centerRatio={last_center / source_width:.3f}, "
        f"score={initial_score:.4f}, source={initial_source}"
    )

    previous_motion_gray = None
    points = []

    mp_face_mesh = mp.solutions.face_mesh
    t = 0.0

    with mp_face_mesh.FaceMesh(
        static_image_mode=False,
        max_num_faces=max_faces,
        refine_landmarks=True,
        min_detection_confidence=0.45,
        min_tracking_confidence=0.45,
    ) as face_mesh:
        while t < duration:
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ok, frame = cap.read()
            if not ok:
                break

            motion_center, motion_gray = active_speaker_motion_fallback_center(frame, previous_motion_gray)
            previous_motion_gray = motion_gray

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = face_mesh.process(rgb)

            raw_detections = []
            if result.multi_face_landmarks:
                for face_landmarks in result.multi_face_landmarks:
                    raw = active_speaker_raw_face_metrics(face_landmarks, source_width, source_height)
                    if raw:
                        raw_detections.append(raw)

            detections, previous_tracks, next_track_id = assign_active_speaker_tracks(
                raw_detections,
                previous_tracks,
                next_track_id,
            )
            selected_debug = None

            for det in detections:
                track_id = det["track_id"]
                prev_mouth = previous_mouth_by_track.get(track_id, det["mouth_ratio"])
                mouth_motion = abs(float(det["mouth_ratio"]) - float(prev_mouth))
                previous_mouth_by_track[track_id] = det["mouth_ratio"]

                det.update(
                    active_speaker_score(
                        det,
                        mouth_motion,
                        active_track_id,
                        mouth_weight,
                        face_weight,
                        center_weight,
                        stickiness_weight,
                    )
                )

            if detections:
                no_face_hits = 0
                detections.sort(key=lambda item: item["score"], reverse=True)
                best = detections[0]
                best_track_id = best["track_id"]
                active_det = next((det for det in detections if det["track_id"] == active_track_id), None)
                active_score = float(active_det.get("score", 0.0)) if active_det else 0.0
                best_score = float(best.get("score", 0.0))

                if active_track_id is None:
                    active_track_id = best_track_id
                    candidate_track_id = best_track_id
                    candidate_hits = 0
                elif best_track_id != active_track_id:
                    # Kalau mulut tidak cukup aktif, jangan cepat pindah speaker.
                    # Ini mencegah crop lompat hanya karena wajah lebih besar saat orang diam.
                    has_clear_score_margin = active_det is None or best_score >= active_score + switch_score_margin
                    if float(best.get("mouth_score", 0.0)) < min_mouth_score_to_switch or not has_clear_score_margin:
                        low_mouth_hold_total += 1
                        candidate_track_id = active_track_id
                        candidate_hits = 0
                    elif candidate_track_id == best_track_id:
                        candidate_hits += 1
                    else:
                        candidate_track_id = best_track_id
                        candidate_hits = 1

                    if candidate_hits >= switch_hits_needed:
                        active_track_id = best_track_id
                        candidate_hits = 0
                else:
                    candidate_track_id = best_track_id
                    candidate_hits = 0

                selected = next((det for det in detections if det["track_id"] == active_track_id), best)
                center = selected["center_x"]
                source = "active_speaker"
                last_center = center
                selected_debug = {
                    "faceCount": len(detections),
                    "trackId": int(selected.get("track_id", 0)),
                    "mouthScore": round(float(selected.get("mouth_score", 0.0)), 4),
                    "mouthRatio": round(float(selected.get("mouth_ratio", 0.0)), 4),
                    "faceScore": round(float(selected.get("face_score", 0.0)), 4),
                    "score": round(float(selected.get("score", 0.0)), 4),
                }
            else:
                no_face_hits += 1
                no_face_total += 1

                visual_center = None
                visual_score = 0.0
                if visual_fallback_enabled:
                    visual_center, visual_score = active_speaker_visual_content_center(
                        frame,
                        source_width,
                        source_height,
                        config,
                    )

                if no_face_strategy in ["motion", "motion_center"] and motion_center is not None:
                    center = motion_center
                    source = "no_face_motion"
                    last_center = center
                    motion_fallback_total += 1
                elif no_face_strategy in ["visual", "visual_content", "content", "auto"] and visual_center is not None and visual_score >= visual_min_score:
                    # Untuk podcast side-by-side, tengah sering kosong.
                    # Fallback ini memilih area yang paling banyak detail visualnya
                    # agar crop cenderung ke kiri/kanan yang berisi orang/objek, bukan ke tengah kosong.
                    if visual_candidate_center is None:
                        visual_candidate_center = visual_center
                        visual_candidate_hits = 1
                    elif abs(float(visual_center) - float(visual_candidate_center)) <= source_width * 0.08:
                        visual_candidate_hits += 1
                    else:
                        visual_candidate_center = visual_center
                        visual_candidate_hits = 1

                    if visual_candidate_hits >= visual_hold_hits or no_face_hits >= no_face_center_hits:
                        center = visual_center
                        source = "no_face_visual"
                        last_center = center
                    else:
                        center = last_center
                        source = "no_face_visual_hold"

                    visual_fallback_total += 1
                elif no_face_strategy in ["auto", "visual", "visual_content", "content"] and motion_center is not None:
                    # Jika visual content belum cukup kuat, pakai motion sebagai cadangan.
                    center = motion_center
                    source = "no_face_motion_after_visual"
                    last_center = center
                    motion_fallback_total += 1
                elif no_face_hits < no_face_center_hits or not center_fallback_enabled:
                    center = last_center
                    source = "no_face_carry" if center_fallback_enabled else "no_face_visual_lock"
                    carry_fallback_total += 1
                else:
                    # Center hanya fallback terakhir. Pada podcast, center bisa kosong,
                    # jadi durasi center default dibuat lebih lama lewat env.
                    center = source_width / 2
                    source = "no_face_center"
                    last_center = center
                    center_fallback_total += 1

            center = clamp(center, 0, source_width)
            point = {
                "time": round(t, 3),
                "centerX": round(center, 2),
                "centerRatio": round(center / source_width, 6),
                "source": source,
            }
            if selected_debug:
                point.update(selected_debug)
            points.append(point)
            t += sample_seconds

    cap.release()

    if not points:
        return [], None

    points = smooth_smart_crop_points(points, config, source_width)
    points = compress_smart_crop_points(points)

    crop_path = ROOT / "temp" / f"{job_id}-clip-{index + 1:02d}-active-speaker-crop.json"
    crop_path.write_text(
        json.dumps(
            {
                "sourceClipPath": str(Path(source_clip).resolve().relative_to(ROOT)),
                "sourceWidth": source_width,
                "sourceHeight": source_height,
                "sampleSeconds": sample_seconds,
                "mode": "active_speaker",
                "switchSeconds": switch_seconds,
                "noFaceStrategy": no_face_strategy,
                "noFaceCenterAfterSeconds": no_face_center_after_seconds,
                "centerFallbackEnabled": center_fallback_enabled,
                "initialAnchor": {
                    "centerX": round(float(initial_center), 2),
                    "centerRatio": round(float(initial_center) / float(source_width), 6),
                    "score": round(float(initial_score), 6),
                    "source": initial_source,
                },
                "stats": {
                    "noFaceFrames": no_face_total,
                    "motionFallbackFrames": motion_fallback_total,
                    "visualFallbackFrames": visual_fallback_total,
                    "carryFallbackFrames": carry_fallback_total,
                    "centerFallbackFrames": center_fallback_total,
                    "lowMouthHoldFrames": low_mouth_hold_total,
                },
                "points": points,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    log_info(
        "Active speaker crop aktif: "
        f"{len(points)} titik tracking | "
        f"no-face={no_face_total}, motion-fallback={motion_fallback_total}, "
        f"visual-fallback={visual_fallback_total}, carry={carry_fallback_total}, center={center_fallback_total}, "
        f"initial={initial_source}:{initial_center / source_width:.3f}"
    )
    return points, crop_path


# ---------------------------------------------------------------------------
# Scene-mode pipeline V2 (InsightFace + state machine + fullscreen fallback)
# ---------------------------------------------------------------------------

def create_scene_mode_crop_points(source_clip, config, job_id, index):
    """V2 tracker: InsightFace SCRFD + scene-mode preset + tight/full state machine.

    Each tracking point is annotated with `modeState` ('tight' or 'full') so the
    renderer can split the clip into segments and render each with the correct
    filter (tight crop window vs full-frame fit-with-blur).
    """
    try:
        import cv2
        import numpy as np  # noqa: F401
    except ImportError:
        log_warn("OpenCV/numpy belum tersedia. Scene-mode dibatalkan.")
        return [], None

    try:
        from face_engine import FaceEngine
        from scene_modes import get_mode, CropStateMachine
    except ImportError as exc:
        log_warn(f"Modul scene-mode tidak bisa di-import: {exc}")
        return [], None

    scene_mode_name = resolve_scene_mode_name(config)
    mode = get_mode(scene_mode_name)
    log_info(f"Scene mode aktif: {mode.label} ({mode.name}) - {mode.description}")

    cap = cv2.VideoCapture(str(source_clip))
    if not cap.isOpened():
        log_warn("Scene-mode tracker tidak bisa membuka source video.")
        return [], None

    source_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    source_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    frame_count = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frame_count / fps if fps > 0 and frame_count > 0 else 0

    if not source_width or not source_height or duration <= 0:
        cap.release()
        return [], None

    target_aspect = float(config["width"]) / float(config["height"])
    source_aspect = float(source_width) / float(source_height)
    needs_horizontal_crop = source_aspect > target_aspect + 0.02

    # If source is already 9:16 (or narrower), crop centerRatio is locked at 0.5.
    # We still annotate modeState so renderer can decide tight vs full when needed.

    configured_sample_seconds = max(0.12, float(config.get("smart_crop_sample", 0.35)))
    if mode.name in {"podcast", "auto"}:
        sample_seconds = min(configured_sample_seconds, 0.25)
    else:
        sample_seconds = max(0.20, configured_sample_seconds)
    min_face_score = float(config.get("face_engine_min_score", 0.55))
    min_face_area = 0.006 if mode.name in {"podcast", "auto"} else 0.01

    face_engine = None
    if int(config.get("face_engine_use_insightface", 1)) == 1 and mode.use_insightface:
        try:
            face_engine = FaceEngine(config, log=log_info).load()
        except Exception as exc:
            log_warn(f"InsightFace tidak bisa di-load: {exc}. Scene-mode dibatalkan.")
            cap.release()
            return [], None

    initial_center = source_width / 2.0
    if needs_horizontal_crop and mode.initial_anchor_enabled:
        initial_center, initial_score, initial_source = find_initial_visual_anchor_center(
            source_clip, source_width, source_height, config
        )
        log_info(
            f"Initial anchor (scene-mode): centerRatio={initial_center / source_width:.3f} "
            f"score={initial_score:.4f} source={initial_source}"
        )

    last_center = float(initial_center)
    state_machine = CropStateMachine(mode, sample_seconds)
    points = []
    log_info(f"Scene-mode sample interval: {sample_seconds:.2f}s")

    active_track_id = None
    candidate_track_id = None
    candidate_hits = 0
    switch_hits_needed = max(1, int(round(mode.switch_seconds / sample_seconds)))

    no_face_total = 0
    full_total = 0
    tight_total = 0

    t = 0.0
    while t < duration:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            break

        observations = []
        if face_engine is not None:
            try:
                observations = face_engine.process(frame)
            except Exception as exc:
                log_warn(f"InsightFace error pada t={t:.2f}: {exc}")
                observations = []

        confident = [
            obs for obs in observations
            if obs.score >= min_face_score and obs.area_ratio >= min_face_area
        ]

        face_confidence = 0.0
        if observations:
            best_for_confidence = max(
                observations,
                key=lambda obs: (float(obs.score), float(obs.area_ratio)),
            )
            score_span = max(0.001, 1.0 - min_face_score)
            score_conf = clamp((float(best_for_confidence.score) - min_face_score) / score_span, 0.0, 1.0)
            area_conf = clamp(float(best_for_confidence.area_ratio) / max(0.001, min_face_area * 1.8), 0.0, 1.0)
            face_confidence = clamp(score_conf * 0.68 + area_conf * 0.32, 0.0, 1.0)
            if confident:
                face_confidence = max(face_confidence, 0.70)

        # Active-speaker scoring among confident faces.
        selected = None
        if confident:
            for obs in confident:
                mouth_score = min(1.0, float(obs.mouth_open) * 3.5) * 0.45 + min(1.0, float(obs.mouth_motion) * 10.0) * 0.55
                face_score = min(1.0, float(obs.area_ratio) / 0.08)
                center_score = 1.0 - min(1.0, abs(float(obs.cx) / source_width - 0.5) * 2.0)
                stickiness = 1.0 if obs.track_id == active_track_id else 0.0
                obs.score_total = (
                    mouth_score * mode.mouth_weight
                    + face_score * mode.face_weight
                    + center_score * mode.center_weight
                    + stickiness * mode.stickiness_weight
                )
                obs.mouth_score = mouth_score
                obs.face_score_norm = face_score

            confident.sort(key=lambda o: o.score_total, reverse=True)
            best = confident[0]
            best_track_id = best.track_id

            if active_track_id is None:
                active_track_id = best_track_id
                candidate_track_id = best_track_id
                candidate_hits = 0
            elif best_track_id != active_track_id:
                active_obs = next((o for o in confident if o.track_id == active_track_id), None)
                active_score = float(active_obs.score_total) if active_obs else 0.0
                has_margin = best.score_total >= active_score + mode.switch_score_margin
                if (best.mouth_score < mode.min_mouth_score_to_switch) or not has_margin:
                    candidate_track_id = active_track_id
                    candidate_hits = 0
                elif candidate_track_id == best_track_id:
                    candidate_hits += 1
                else:
                    candidate_track_id = best_track_id
                    candidate_hits = 1
                if candidate_hits >= switch_hits_needed:
                    active_track_id = best_track_id
                    candidate_hits = 0

            selected = next((o for o in confident if o.track_id == active_track_id), best)
            last_center = float(selected.cx)
        else:
            no_face_total += 1

        # State machine: tight vs full
        has_confident_face = bool(confident)
        mode_state = state_machine.update(has_confident_face)
        if mode_state == "full":
            full_total += 1
        else:
            tight_total += 1

        if needs_horizontal_crop:
            center_x = last_center
        else:
            center_x = source_width / 2.0

        center_x = clamp(center_x, 0.0, float(source_width))
        center_ratio = center_x / float(source_width)

        point = {
            "time": round(t, 3),
            "centerX": round(center_x, 2),
            "centerRatio": round(center_ratio, 6),
            "modeState": mode_state,
            "faceConfidence": round(float(face_confidence), 4),
            "faceCount": len(confident),
            "trackId": int(selected.track_id) if selected is not None else -1,
        }
        points.append(point)
        t += sample_seconds

    cap.release()
    if face_engine is not None:
        face_engine.close()

    if not points:
        return [], None

    if needs_horizontal_crop:
        points = smooth_smart_crop_points(points, config, source_width)
        # Re-attach modeState (smoother only writes centerRatio/centerX)
        # Actually smoother preserves keys, but be safe:
        # smooth_smart_crop_points should keep all original keys.

    points = compress_smart_crop_points_preserving_state(points)

    crop_path = ROOT / "temp" / f"{job_id}-clip-{index + 1:02d}-scene-{mode.name}.json"
    crop_path.write_text(
        json.dumps(
            {
                "sourceClipPath": str(Path(source_clip).resolve().relative_to(ROOT)),
                "sourceWidth": source_width,
                "sourceHeight": source_height,
                "sampleSeconds": sample_seconds,
                "mode": "scene_mode",
                "sceneMode": mode.name,
                "stats": {
                    "noFaceFrames": no_face_total,
                    "tightFrames": tight_total,
                    "fullFrames": full_total,
                },
                "points": points,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    log_info(
        f"Scene-mode tracker aktif: {len(points)} titik | tight={tight_total} full={full_total} no-face={no_face_total}"
    )
    return points, crop_path


def compress_smart_crop_points_preserving_state(points):
    """Compress consecutive points but keep mode state changes as boundary points."""
    if len(points) <= 2:
        return points
    out = [points[0]]
    for i in range(1, len(points) - 1):
        prev = out[-1]
        cur = points[i]
        nxt = points[i + 1]
        same_state = cur.get("modeState") == prev.get("modeState") == nxt.get("modeState")
        if not same_state:
            out.append(cur)
            continue
        # Drop redundant point if center barely changed (linear interpolation still fine).
        if abs(float(cur.get("centerRatio", 0)) - float(prev.get("centerRatio", 0))) < 0.001 and \
           abs(float(cur.get("centerRatio", 0)) - float(nxt.get("centerRatio", 0))) < 0.001:
            continue
        out.append(cur)
    out.append(points[-1])
    return out


def find_initial_visual_anchor_center(source_clip, source_width, source_height, config):
    """Cari posisi crop awal agar clip podcast tidak mulai dari tengah kosong.

    Masalah podcast side-by-side:
    - Frame tengah sering berisi meja/background kosong.
    - Wajah kadang belum terdeteksi pada frame pertama.
    - Kalau last_center default = 0.5, opening clip bisa kosong.

    Solusi:
    - Scan beberapa detik awal source clip.
    - Pilih jendela 9:16 yang paling banyak visual content/detail.
    - Beri sedikit side-bias agar area kiri/kanan yang berisi orang bisa menang dari tengah kosong.
    - Jika tidak ada kandidat valid, baru fallback ke tengah.
    """
    if int(config.get("active_speaker_initial_anchor_enabled", 1)) != 1:
        return source_width / 2.0, 0.0, "initial_center_disabled"

    try:
        import cv2
    except ImportError:
        return source_width / 2.0, 0.0, "initial_center_no_cv2"

    cap = cv2.VideoCapture(str(source_clip))
    if not cap.isOpened():
        return source_width / 2.0, 0.0, "initial_center_no_video"

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    frame_count = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frame_count / fps if fps > 0 and frame_count > 0 else 0

    scan_seconds = max(0.5, float(config.get("active_speaker_initial_scan_seconds", 6.0)))
    sample_seconds = max(0.2, float(config.get("active_speaker_initial_sample_seconds", 0.5)))
    min_score = max(0.0, float(config.get("active_speaker_initial_min_score", 0.010)))
    side_bias = max(0.0, float(config.get("active_speaker_initial_side_bias", 0.06)))

    scan_until = min(duration, scan_seconds) if duration > 0 else scan_seconds
    candidates = []
    t = 0.0

    while t <= scan_until + 0.001:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            t += sample_seconds
            continue

        center, score = active_speaker_visual_content_center(frame, source_width, source_height, config)
        if center is not None and score >= min_score:
            center_ratio = float(center) / float(source_width)

            # Podcast sering menaruh orang di sisi kiri/kanan dan tengah kosong.
            # Side bias ringan membantu area sisi menang jika skornya mirip.
            side_bonus = side_bias if (center_ratio < 0.42 or center_ratio > 0.58) else 0.0
            weighted_score = float(score) + side_bonus

            candidates.append(
                {
                    "time": round(t, 3),
                    "center": float(center),
                    "centerRatio": center_ratio,
                    "score": float(score),
                    "weightedScore": weighted_score,
                }
            )

        t += sample_seconds

    cap.release()

    if not candidates:
        return source_width / 2.0, 0.0, "initial_center_no_candidate"

    # Ambil kandidat terbaik, lalu stabilkan dengan median dari kandidat yang mendekati skor terbaik.
    candidates.sort(key=lambda item: item["weightedScore"], reverse=True)
    best = candidates[0]
    threshold = best["weightedScore"] * 0.88
    strong = [item for item in candidates if item["weightedScore"] >= threshold]

    centers = sorted(item["center"] for item in strong)
    stable_center = centers[len(centers) // 2]

    return float(stable_center), float(best["score"]), "initial_visual_anchor"


def active_speaker_motion_fallback_center(frame, previous_gray):
    """Fallback saat wajah/bibir tidak terdeteksi.

    Menggunakan pusat gerakan frame sebagai kandidat crop.
    Kalau tidak ada gerakan, mengembalikan None agar caller bisa carry/center.
    """
    try:
        import cv2
    except ImportError:
        return None, previous_gray

    height, width = frame.shape[:2]
    if not width or not height:
        return None, previous_gray

    small_width = 480
    scale = small_width / float(width)
    small_height = max(1, int(height * scale))
    small = cv2.resize(frame, (small_width, small_height))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)

    motion_center = detect_motion_center(gray, previous_gray, scale)
    return motion_center, gray


def active_speaker_visual_content_center(frame, source_width, source_height, config):
    """Fallback content-aware saat wajah/bibir tidak terdeteksi.

    Masalah umum podcast: crop tengah berisi area kosong/meja/background,
    sementara orang berada di kiri/kanan. Fungsi ini memilih jendela 9:16
    dengan detail visual paling tinggi berdasarkan edge, tekstur, dan saturasi.

    Return:
        (center_x, score) atau (None, 0.0)
    """
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None, 0.0

    height, width = frame.shape[:2]
    if width <= 0 or height <= 0:
        return None, 0.0

    target_aspect = float(config["width"]) / float(config["height"])
    crop_width = int(round(height * target_aspect))

    # Jika source sudah tidak lebih lebar dari target, tidak perlu pilih kiri/kanan.
    if crop_width >= width:
        return width / 2.0, 1.0

    # Downscale agar ringan.
    small_width = 640
    scale = small_width / float(width)
    small_height = max(1, int(round(height * scale)))
    small = cv2.resize(frame, (small_width, small_height))

    # Ambil ROI tengah-atas sampai bawah, hindari border hitam dan caption bawah.
    y1 = int(small_height * 0.08)
    y2 = int(small_height * 0.82)
    roi = small[y1:y2, :]
    if roi.size == 0:
        return None, 0.0

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)

    # Edge/detail: orang, wajah, mikrofon, kursi biasanya memberi detail lebih tinggi daripada background kosong.
    edges = cv2.Canny(gray, 50, 150)
    edge_score = edges.astype("float32") / 255.0

    # Variance/texture: membantu jika background flat/gelap.
    blur = cv2.GaussianBlur(gray, (9, 9), 0)
    texture = cv2.absdiff(gray, blur).astype("float32") / 255.0

    # Saturation: manusia/objek biasanya sedikit lebih kaya warna dari area kosong putih/abu.
    saturation = hsv[:, :, 1].astype("float32") / 255.0

    # Brightness mask: jangan tertipu area hitam total/putih total.
    value = hsv[:, :, 2].astype("float32") / 255.0
    usable = ((value > 0.035) & (value < 0.995)).astype("float32")

    median_value = float(np.median(value))
    contrast = np.abs(value - median_value).astype("float32")
    chroma_or_contrast = ((saturation > 0.14) | (contrast > 0.10)).astype("float32")

    # No-face fallback harus bisa melihat objek/orang statis juga.
    # Edge/motion saja terlalu mudah gagal pada frame podcast yang diam.
    score_map = (
        edge_score * 0.35
        + texture * 0.20
        + saturation * 0.22
        + contrast * 0.23
    ) * usable * (0.35 + chroma_or_contrast * 0.65)
    column_score = score_map.mean(axis=0)

    small_crop_width = max(2, int(round(crop_width * scale)))
    if small_crop_width >= small_width:
        return width / 2.0, float(column_score.mean())

    # Smooth column score agar tidak mudah memilih noise kecil.
    kernel_width = max(3, int(round(small_crop_width * 0.18)))
    kernel = np.ones(kernel_width, dtype="float32") / float(kernel_width)
    column_score = np.convolve(column_score, kernel, mode="same")

    candidates = []
    step = max(4, small_crop_width // 18)
    max_left = small_width - small_crop_width

    for left in range(0, max_left + 1, step):
        right = left + small_crop_width
        window_score = float(column_score[left:right].mean())
        center = left + small_crop_width / 2.0

        # Untuk podcast, area tengah sering kosong. Jangan otomatis menguntungkan center.
        # Beri bonus ringan ke kiri/kanan jika visual content-nya kuat.
        center_ratio = center / small_width
        side_bonus = 0.010 if (center_ratio < 0.42 or center_ratio > 0.58) else 0.0
        # Penalti sangat kecil hanya untuk crop yang terlalu mepet pinggir.
        extreme_edge_penalty = max(0.0, abs(center_ratio - 0.5) - 0.42) * 0.030
        candidates.append((window_score + side_bonus - extreme_edge_penalty, center))

    if not candidates:
        return None, 0.0

    best_score, best_center_small = max(candidates, key=lambda item: item[0])
    global_score = float(column_score.mean())

    # Jika seluruh frame benar-benar flat/kosong, jangan paksa pindah.
    if best_score <= 0.0 or global_score <= 0.00002:
        return None, 0.0

    return float(best_center_small / scale), max(float(best_score), 0.0)


def active_speaker_raw_face_metrics(face_landmarks, width, height):
    landmarks = face_landmarks.landmark
    if not landmarks:
        return None

    xs = [float(lm.x) for lm in landmarks]
    ys = [float(lm.y) for lm in landmarks]

    min_x = max(0.0, min(xs))
    max_x = min(1.0, max(xs))
    min_y = max(0.0, min(ys))
    max_y = min(1.0, max(ys))

    center_x_ratio = (min_x + max_x) / 2.0
    center_y_ratio = (min_y + max_y) / 2.0
    face_w = max(0.001, max_x - min_x)
    face_h = max(0.001, max_y - min_y)

    # MediaPipe FaceMesh landmark indexes:
    # 13 upper inner lip, 14 lower inner lip, 61 left mouth corner, 291 right mouth corner.
    try:
        upper_lip = landmarks[13]
        lower_lip = landmarks[14]
        left_mouth = landmarks[61]
        right_mouth = landmarks[291]
    except IndexError:
        return None

    mouth_open = abs(float(lower_lip.y) - float(upper_lip.y))
    mouth_width = max(0.001, abs(float(right_mouth.x) - float(left_mouth.x)))
    mouth_ratio = mouth_open / mouth_width

    return {
        "center_x": center_x_ratio * float(width),
        "center_y": center_y_ratio * float(height),
        "center_ratio": center_x_ratio,
        "face_w": face_w,
        "face_h": face_h,
        "face_area": face_w * face_h,
        "mouth_ratio": mouth_ratio,
    }


def assign_active_speaker_tracks(raw_detections, previous_tracks, next_track_id):
    detections = []
    used_track_ids = set()
    updated_tracks = {}

    for raw in sorted(raw_detections, key=lambda item: item["face_area"], reverse=True):
        best_track_id = None
        best_distance = 999.0

        for track_id, track in previous_tracks.items():
            if track_id in used_track_ids:
                continue

            dx = float(raw["center_ratio"]) - float(track.get("center_ratio", 0.5))
            dy_pixels = float(raw["center_y"]) - float(track.get("center_y", 0.5))
            distance = abs(dx) + abs(dy_pixels) * 0.0007

            if distance < best_distance:
                best_distance = distance
                best_track_id = track_id

        if best_track_id is None or best_distance > 0.18:
            best_track_id = next_track_id
            next_track_id += 1

        used_track_ids.add(best_track_id)
        det = {**raw, "track_id": best_track_id}
        detections.append(det)
        updated_tracks[best_track_id] = {
            "center_ratio": raw["center_ratio"],
            "center_y": raw["center_y"],
        }

    return detections, updated_tracks, next_track_id


def active_speaker_score(
    det,
    mouth_motion,
    active_track_id,
    mouth_weight,
    face_weight,
    center_weight,
    stickiness_weight,
):
    mouth_open_score = min(1.0, float(det["mouth_ratio"]) * 3.5)
    mouth_motion_score = min(1.0, float(mouth_motion) * 10.0)
    mouth_score = min(1.0, mouth_open_score * 0.45 + mouth_motion_score * 0.55)

    face_score = min(1.0, float(det["face_area"]) / 0.08)
    center_score = 1.0 - min(1.0, abs(float(det["center_ratio"]) - 0.5) * 2.0)
    stickiness_score = 1.0 if active_track_id == det.get("track_id") else 0.0

    score = (
        mouth_score * mouth_weight
        + face_score * face_weight
        + center_score * center_weight
        + stickiness_score * stickiness_weight
    )

    return {
        "score": score,
        "mouth_score": mouth_score,
        "face_score": face_score,
        "center_score": center_score,
        "stickiness_score": stickiness_score,
    }

def detect_frame_center(frame, face_cascade, previous_gray):
    try:
        import cv2
    except ImportError:
        return None, "none", None

    height, width = frame.shape[:2]
    small_width = 480
    scale = small_width / float(width)
    small_height = max(1, int(height * scale))
    small = cv2.resize(frame, (small_width, small_height))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)

    motion_center = detect_motion_center(gray, previous_gray, scale)
    faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(24, 24))

    if len(faces):
        best = None
        best_width = 0
        best_score = -1
        for x, y, face_w, face_h in faces:
            center_x = (x + face_w / 2) / scale
            original_face_w = face_w / scale
            area = face_w * face_h
            motion_bonus = 0
            if motion_center is not None:
                distance = abs(center_x - motion_center)
                motion_bonus = max(0.0, 1.0 - (distance / max(1.0, width)))
            score = area * (1.0 + motion_bonus)
            if score > best_score:
                best = center_x
                best_width = original_face_w
                best_score = score

        if motion_center is not None and best_width < width * 0.16 and abs(best - motion_center) > width * 0.12:
            return motion_center, "motion", gray

        return best, "face", gray

    if motion_center is not None:
        return motion_center, "motion", gray

    return None, "none", gray


def detect_motion_center(gray, previous_gray, scale):
    if previous_gray is None or previous_gray.shape != gray.shape:
        return None

    try:
        import cv2
    except ImportError:
        return None

    diff = cv2.absdiff(gray, previous_gray)
    diff = cv2.GaussianBlur(diff, (7, 7), 0)
    _, mask = cv2.threshold(diff, 22, 255, cv2.THRESH_BINARY)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

    if cv2.countNonZero(mask) < mask.size * 0.012:
        return None

    moments = cv2.moments(mask)
    if moments["m00"] <= 0:
        return None

    return (moments["m10"] / moments["m00"]) / scale


def smooth_smart_crop_points(points, config, source_width):
    if len(points) <= 1:
        return points

    smoothing = clamp(float(config.get("smart_crop_smoothing", 0.38)), 0.05, 1.0)
    max_shift = max(0.02, float(config.get("smart_crop_max_shift", 0.16)))
    smoothed = []
    previous = None

    for point in points:
        ratio = float(point["centerRatio"])

        if previous is None:
            new_ratio = ratio
        else:
            elapsed = max(0.001, float(point["time"]) - float(previous["time"]))
            wanted = float(previous["centerRatio"]) + (ratio - float(previous["centerRatio"])) * smoothing
            max_delta = max_shift * elapsed
            delta = clamp(wanted - float(previous["centerRatio"]), -max_delta, max_delta)
            new_ratio = float(previous["centerRatio"]) + delta

        new_point = {
            **point,
            "centerX": round(new_ratio * float(source_width), 2),
            "centerRatio": round(clamp(new_ratio, 0.0, 1.0), 6),
        }
        smoothed.append(new_point)
        previous = new_point

    return smoothed


def compress_smart_crop_points(points):
    if len(points) <= 2:
        return points

    compressed = [points[0]]
    for point in points[1:-1]:
        previous = compressed[-1]
        if abs(float(point["centerRatio"]) - float(previous["centerRatio"])) >= 0.025:
            compressed.append(point)
            continue
        if point["source"] != previous["source"]:
            compressed.append(point)

    compressed.append(points[-1])
    return compressed


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, float(value)))


def render_clip(source_clip, ass_path, clip, index, config, job_id, *, progress_base=0.0, progress_span=100.0, total_clips=None):
    safe_title = clean_filename(clip["title"])
    final_clip = ROOT / "output" / f"py-final-{index + 1:02d}-{safe_title}.mp4"

    centered_vf = centered_video_filter(config)
    log_progress(
        "tracking",
        progress_base,
        stage_pct=0,
        clip=index + 1,
        total=total_clips,
        note="smart_crop",
    )
    base_vf, crop_path, points = smart_video_filter(source_clip, config, job_id, index)
    log_progress(
        "tracking",
        progress_base + progress_span * 0.22,
        stage_pct=100,
        clip=index + 1,
        total=total_clips,
        note="smart_crop_ready",
    )
    subtitle_path = str(ass_path.resolve()).replace("\\", "/").replace(":", "\\:")
    subtitle_vf = f"{base_vf},subtitles='{subtitle_path}'"

    has_mode_state = points and any("modeState" in p for p in points)
    needs_dynamic_zoom = bool(has_mode_state and int(config.get("dynamic_zoom_enabled", 1)) == 1)

    if needs_dynamic_zoom:
        try:
            from dynamic_zoom_render import render_dynamic_zoom_clip
            full_count = sum(1 for p in points if p.get("modeState") == "full")
            tight_count = sum(1 for p in points if p.get("modeState") == "tight")
            log_info(
                f"Dynamic-zoom render aktif: {tight_count} sample tight, {full_count} sample full"
            )
            log_progress(
                "render",
                progress_base + progress_span * 0.30,
                stage_pct=0,
                clip=index + 1,
                total=total_clips,
                note="dynamic_zoom",
            )

            def _emit_progress(pct: float, label: str):
                overall = progress_base + progress_span * (0.30 + (0.65 * clamp(float(pct), 0.0, 100.0) / 100.0))
                log_progress(
                    "render",
                    overall,
                    stage_pct=pct,
                    clip=index + 1,
                    total=total_clips,
                    note=label,
                )

            render_dynamic_zoom_clip(
                source=Path(source_clip),
                output=final_clip,
                points=points,
                width=config["width"],
                height=config["height"],
                crf=config["final_crf"],
                blur_strength=int(config.get("fullscreen_blur_strength", 22)),
                ass_path=ass_path,
                workdir=ROOT / "temp",
                job_id=job_id,
                index=index,
                log=log_info,
                progress=_emit_progress,
                width_smooth_alpha=float(config.get("dynamic_zoom_width_smooth", 0.18)),
                center_smooth_alpha=float(config.get("dynamic_zoom_center_smooth", 0.30)),
                confidence_fall_alpha=float(config.get("dynamic_zoom_confidence_fall", 0.72)),
                confidence_rise_alpha=float(config.get("dynamic_zoom_confidence_rise", 0.24)),
                transition_lead_seconds=float(config.get("dynamic_zoom_transition_lead", 0.25)),
            )
            log_progress(
                "render",
                progress_base + progress_span * 0.98,
                stage_pct=100,
                clip=index + 1,
                total=total_clips,
                note="dynamic_zoom_done",
            )
            return source_clip, final_clip, crop_path
        except Exception as exc:
            log_warn(f"Dynamic-zoom render gagal: {exc}. Fallback ke single-pass.")

    try:
        log_progress(
            "render",
            progress_base + progress_span * 0.35,
            stage_pct=0,
            clip=index + 1,
            total=total_clips,
            note="ffmpeg",
        )
        run_render(source_clip, final_clip, subtitle_vf, config)
        log_progress(
            "render",
            progress_base + progress_span * 0.98,
            stage_pct=100,
            clip=index + 1,
            total=total_clips,
            note="ffmpeg_done",
        )
    except subprocess.CalledProcessError as exc:
        log_warn(f"Render smart/subtitle gagal, coba crop tengah dengan subtitle: {exc}")
        try:
            run_render(source_clip, final_clip, f"{centered_vf},subtitles='{subtitle_path}'", config)
        except subprocess.CalledProcessError as fallback_exc:
            log_warn(f"Render subtitle gagal, fallback tanpa hardsub: {fallback_exc}")
            run_render(source_clip, final_clip, centered_vf, config)

    log_progress(
        "render",
        progress_base + progress_span * 0.98,
        stage_pct=100,
        clip=index + 1,
        total=total_clips,
        note="render_done",
    )
    return source_clip, final_clip, crop_path


def run_render(source_clip, final_clip, vf, config):
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source_clip),
            "-map_metadata",
            "-1",
            "-vf",
            vf,
            "-r",
            "30",
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            "-level:v",
            "4.1",
            "-preset",
            "veryfast",
            "-crf",
            str(config["final_crf"]),
            "-pix_fmt",
            "yuv420p",
            "-g",
            "60",
            "-bf",
            "0",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            "-shortest",
            str(final_clip),
        ]
    )


def parse_range(value, index):
    start_raw, end_raw = str(value).split("-", 1)
    start = parse_time(start_raw)
    end = parse_time(end_raw)
    if end <= start:
        raise ValueError(f"Range tidak valid: {value}")

    return {
        "title": f"Manual Clip {index + 1}",
        "reason": "Timestamp dipilih manual oleh user.",
        "start": start,
        "end": end,
        "hook": "",
        "caption": "",
    }


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    load_env()

    parser = argparse.ArgumentParser(description="Auto Video Clipper Python Orchestrator")
    parser.add_argument("url")
    parser.add_argument("--range", action="append", default=[], help="Contoh: 00:01:20-00:02:05")
    args = parser.parse_args()

    config = cfg()
    ensure_dirs()

    job_id = create_job_id(args.url)
    log_step(f"Mulai job Python: {job_id}")
    log_info(f"Target upload: {config['width']}x{config['height']} vertical 9:16")
    log_progress("start", 1, note="init")

    subtitle_path = download_subtitle(args.url, job_id, config["language"]) or latest_cached_subtitle(args.url)
    segments = parse_vtt(subtitle_path) if subtitle_path else []
    transcript_source = "youtube" if segments else ""
    if segments:
        log_progress("transcript", 18, note=transcript_source or "youtube")

    if not segments and not args.range:
        cached_segments = latest_cached_json(args.url, "segments")
        if cached_segments:
            segments = cached_segments
            transcript_source = "cache"
            log_progress("transcript", 18, note="cache")
        else:
            audio_path = download_audio(args.url, job_id)
            log_progress("transcript", 8, note="audio_ready")
            segments = transcribe_audio(audio_path, job_id, config)
            transcript_source = config.get("transcribe_provider", "offline")
            log_progress("transcript", 22, note=transcript_source)

    if not segments and not args.range:
        raise RuntimeError("Transkrip kosong. Tidak bisa lanjut.")

    segments_path = ROOT / "temp" / f"{job_id}-segments.json"
    segments_path.write_text(json.dumps(segments, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.range:
        clips = [parse_range(value, index) for index, value in enumerate(args.range)]
        log_progress("clip_select", 32, note="manual_range")
    else:
        cached_clips = latest_cached_json(args.url, "clips")
        if cached_clips:
            clips = validate_clips(cached_clips, segments, config)
            log_progress("clip_select", 32, note="cache")
        else:
            log_step("Gemini mencari bagian penting dari transcript.")
            log_progress("clip_select", 24, note="selecting")
            clips = find_important_clips(segments, config)
            log_progress("clip_select", 32, note="selected")

    if not clips:
        raise RuntimeError("Tidak ada clip valid.")

    clips_path = ROOT / "temp" / f"{job_id}-clips.json"
    clips_path.write_text(json.dumps(clips, ensure_ascii=False, indent=2), encoding="utf-8")

    outputs = []
    total_clips = len(clips)
    clip_span = 64.0 / max(1, total_clips)

    for index, clip in enumerate(clips):
        clip_base = 34.0 + clip_span * index
        log_step(f"Render clip {index + 1}/{len(clips)}: {clip['title']}")
        log_progress("download", clip_base + clip_span * 0.04, stage_pct=0, clip=index + 1, total=total_clips, note="source")
        source_clip = download_clip_source(args.url, job_id, clip, index, config)
        log_progress("download", clip_base + clip_span * 0.18, stage_pct=100, clip=index + 1, total=total_clips, note="source_ready")
        log_progress("subtitle", clip_base + clip_span * 0.20, stage_pct=0, clip=index + 1, total=total_clips, note="review")
        subtitle_segments, review_path = review_clip_transcript_segments(segments, clip, config, job_id, index)
        log_progress("subtitle", clip_base + clip_span * 0.28, stage_pct=60, clip=index + 1, total=total_clips, note="ass")
        ass_path = create_ass(subtitle_segments, clip, index, config, job_id)
        log_progress("subtitle", clip_base + clip_span * 0.30, stage_pct=100, clip=index + 1, total=total_clips, note="ass_ready")
        raw_clip, final_clip, smart_crop_path = render_clip(
            source_clip,
            ass_path,
            clip,
            index,
            config,
            job_id,
            progress_base=clip_base + clip_span * 0.32,
            progress_span=clip_span * 0.64,
            total_clips=total_clips,
        )
        outputs.append(
            {
                "index": index + 1,
                "title": clip["title"],
                "reason": clip["reason"],
                "start": clip["start"],
                "end": clip["end"],
                "duration": clip["end"] - clip["start"],
                "hook": clip["hook"],
                "caption": clip["caption"],
                "transcriptSource": transcript_source,
                "thumbnailText": clip.get("thumbnail_text", ""),
                "viralScore": clip.get("viral_score", 0),
                "publishDecision": clip.get("publish_decision", ""),
                "candidateId": clip.get("candidate_id", ""),
                "clipTranscript": clip.get("clip_transcript", ""),
                "sourceClipPath": str(source_clip.relative_to(ROOT)),
                "rawClipPath": str(raw_clip.relative_to(ROOT)),
                "subtitlePath": str(ass_path.relative_to(ROOT)),
                "transcriptReviewPath": str(review_path.relative_to(ROOT)) if review_path else "",
                "smartCropPath": str(smart_crop_path.relative_to(ROOT)) if smart_crop_path else "",
                "finalPath": str(final_clip.relative_to(ROOT)),
            }
        )
        log_info(f"Output final: {final_clip.relative_to(ROOT)}")
        log_progress("clip_done", clip_base + clip_span * 0.98, stage_pct=100, clip=index + 1, total=total_clips, note="done")

    result = {
        "jobId": job_id,
        "sourceUrl": args.url,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "transcriptSource": transcript_source,
        "transcribeProvider": config.get("transcribe_provider", "offline"),
        "target": "TikTok / Instagram Reels / YouTube Shorts",
        "resolution": f"{config['width']}x{config['height']}",
        "totalClips": len(outputs),
        "outputs": outputs,
    }

    result_path = ROOT / "output" / f"py-result-{job_id}.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    log_step("Selesai.")
    log_progress("done", 100, note="complete")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
