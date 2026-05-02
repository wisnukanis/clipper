import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import textwrap
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


def load_env():
    env_paths = [ROOT.parent / ".env", ROOT / ".env"]

    for env_path in env_paths:
        if not env_path.exists():
            continue

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
    return {
        "gemini_keys": parse_keys(os.environ.get("GEMINI_API_KEYS") or os.environ.get("GEMINI_API_KEY")),
        "gemini_model": os.environ.get("GEMINI_MODEL", "gemini-flash-latest"),
        "clod_key": os.environ.get("CLOD_API_KEY", "").strip(),
        "clod_base_url": os.environ.get("CLOD_BASE_URL", "https://api.clod.io/v1").rstrip("/"),
        "clod_model": os.environ.get("CLOD_MODEL", "DeepSeek V3"),
        "clod_temperature": parse_float(os.environ.get("CLOD_TEMPERATURE"), 0.45),
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
        "smart_crop_sample": parse_float(os.environ.get("SMART_CROP_SAMPLE_SECONDS"), 0.75),
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
        "active_speaker_min_mouth_score_to_switch": parse_float(os.environ.get("ACTIVE_SPEAKER_MIN_MOUTH_SCORE_TO_SWITCH"), 0.06),
        "active_speaker_visual_fallback_enabled": parse_int(os.environ.get("ACTIVE_SPEAKER_VISUAL_FALLBACK_ENABLED"), 1),
        "active_speaker_visual_min_score": parse_float(os.environ.get("ACTIVE_SPEAKER_VISUAL_MIN_SCORE"), 0.025),
        "active_speaker_visual_hold_seconds": parse_float(os.environ.get("ACTIVE_SPEAKER_VISUAL_HOLD_SECONDS"), 1.5),
        "active_speaker_initial_anchor_enabled": parse_int(os.environ.get("ACTIVE_SPEAKER_INITIAL_ANCHOR_ENABLED"), 1),
        "active_speaker_initial_scan_seconds": parse_float(os.environ.get("ACTIVE_SPEAKER_INITIAL_SCAN_SECONDS"), 6.0),
        "active_speaker_initial_sample_seconds": parse_float(os.environ.get("ACTIVE_SPEAKER_INITIAL_SAMPLE_SECONDS"), 0.5),
        "active_speaker_initial_min_score": parse_float(os.environ.get("ACTIVE_SPEAKER_INITIAL_MIN_SCORE"), 0.010),
        "active_speaker_initial_side_bias": parse_float(os.environ.get("ACTIVE_SPEAKER_INITIAL_SIDE_BIAS"), 0.06),
        "transcript_review": parse_int(os.environ.get("TRANSCRIPT_REVIEW_ENABLED"), 1),
        "transcript_review_required": parse_int(os.environ.get("TRANSCRIPT_REVIEW_REQUIRED"), 0),
        "transcript_review_batch": parse_int(os.environ.get("TRANSCRIPT_REVIEW_BATCH_SIZE"), 80),
        "viral_strategy_enabled": parse_int(os.environ.get("VIRAL_STRATEGY_ENABLED"), 1),
        "viral_strategy_required": parse_int(os.environ.get("VIRAL_STRATEGY_REQUIRED"), 0),
        "ai_candidate_max_count": parse_int(os.environ.get("AI_CANDIDATE_MAX_COUNT"), 5),
        "ai_candidate_max_chars": parse_int(os.environ.get("AI_CANDIDATE_MAX_CHARS"), 4000),
        "min_viral_score_to_publish": parse_int(os.environ.get("MIN_VIRAL_SCORE_TO_PUBLISH"), 0),
        "force_publish": parse_int(os.environ.get("FORCE_PUBLISH"), 1),
        "language": os.environ.get("VIDEO_LANGUAGE", "id"),
        "deepgram_enabled": parse_int(os.environ.get("DEEPGRAM_ENABLED"), 1),
        "deepgram_keys": parse_keys(os.environ.get("DEEPGRAM_API_KEYS") or os.environ.get("DEEPGRAM_API_KEY")),
        "deepgram_model": os.environ.get("DEEPGRAM_MODEL", "nova-3"),
        "deepgram_language": os.environ.get("DEEPGRAM_LANGUAGE") or os.environ.get("VIDEO_LANGUAGE", "id"),
        "deepgram_timeout": parse_int(os.environ.get("DEEPGRAM_TIMEOUT_SECONDS"), 900),
        "deepgram_audio_bitrate": os.environ.get("DEEPGRAM_AUDIO_BITRATE", "32k"),
        "deepgram_audio_sample_rate": parse_int(os.environ.get("DEEPGRAM_AUDIO_SAMPLE_RATE"), 16000),
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

    # Prioritas 1: pakai file cookies.txt.
    # Di GitHub Actions file ini dibuat dari secret YTDLP_COOKIES_TXT.
    # Di lokal, letakkan cookies.txt di root folder clipper.
    if not cookies_file and os.path.exists("cookies.txt"):
        cookies_file = "cookies.txt"

    if cookies_file:
        args.extend(["--cookies", cookies_file])
    elif cookies_browser:
        args.extend(["--cookies-from-browser", cookies_browser])

    # Samakan identitas request dengan browser yang dipakai saat export cookies.
    # Ini membantu saat YouTube menolak cookies karena user-agent runner berbeda jauh.
    if user_agent:
        args.extend(["--user-agent", user_agent])

    if referer:
        args.extend(["--referer", referer])

    if remote_components:
        args.extend(["--remote-components", remote_components])

    if js_runtimes:
        args.extend(["--js-runtimes", js_runtimes])

    # Opsi throttling/retry ini opsional. Isi lewat env jika GitHub Actions sering dianggap bot.
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


def prepare_deepgram_audio(audio_path, job_id, config):
    audio_path = Path(audio_path)
    output = ROOT / "temp" / f"{job_id}-deepgram.mp3"
    bitrate = str(config.get("deepgram_audio_bitrate", "32k") or "32k")
    sample_rate = str(config.get("deepgram_audio_sample_rate", 16000) or 16000)

    try:
        run([
            "ffmpeg",
            "-y",
            "-i",
            str(audio_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            sample_rate,
            "-b:a",
            bitrate,
            str(output),
        ], capture=True)

        original_mb = audio_path.stat().st_size / (1024 * 1024)
        output_mb = output.stat().st_size / (1024 * 1024)
        if output_mb > 0:
            log_info(
                f"Audio Deepgram dikompres: {original_mb:.2f} MB -> {output_mb:.2f} MB "
                f"({sample_rate} Hz, {bitrate})."
            )
            return output
    except Exception as exc:
        log_warn(f"Gagal kompres audio Deepgram, pakai audio asli: {exc}")

    return audio_path


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

    upload_audio_path = prepare_deepgram_audio(audio_path, job_id, config)

    last_error = None
    for index, api_key in enumerate(keys):
        try:
            log_info(f"Deepgram key {index + 1}/{len(keys)} aktif ({mask_secret(api_key)})")
            return transcribe_deepgram_single_key(upload_audio_path, job_id, config, api_key, index)
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
    if int(config.get("deepgram_enabled", 1)) != 1:
        raise RuntimeError("DEEPGRAM_ENABLED harus 1. Pipeline ini hanya memakai Deepgram untuk transkripsi.")

    if not config.get("deepgram_keys"):
        raise RuntimeError("DEEPGRAM_API_KEYS / DEEPGRAM_API_KEY wajib diisi. Pipeline ini hanya memakai Deepgram untuk transkripsi.")

    return transcribe_deepgram(audio_path, job_id, config)


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

    starts = [pos for pos in [raw.find("["), raw.find("{")] if pos >= 0]
    if not starts:
        raise ValueError("Gemini tidak mengembalikan JSON valid.")

    data, _ = decoder.raw_decode(raw[min(starts):])
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


def call_clod(prompt, config, max_tokens=1200):
    if not config.get("clod_key"):
        raise RuntimeError("CLOD_API_KEY belum diisi.")

    endpoint = f"{config.get('clod_base_url', 'https://api.clod.io/v1')}/chat/completions"
    payload = json.dumps(
        {
            "model": config.get("clod_model", "DeepSeek V3"),
            "messages": [{"role": "user", "content": prompt}],
            "temperature": float(config.get("clod_temperature", 0.45)),
            "max_completion_tokens": int(max_tokens),
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        endpoint,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config['clod_key']}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"CLOD HTTP {exc.code}: {detail}") from exc

    return str(data.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()


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
        "kalau": 2,
        "tapi": 2,
        "karena": 2,
        "jadi": 2,
        "gue": 1,
        "saya": 1,
    }

    for keyword, weight in keyword_weights.items():
        if keyword in normalized:
            score += weight

    if re.search(r"\d", text):
        score += 4
    if "?" in text:
        score += 3
    if "!" in text:
        score += 2
    if 40 <= duration <= 60:
        score += 3
    if start < 20:
        score -= 4

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


def find_local_important_clips(segments, config, reason=""):
    min_duration = max(10, int(config.get("min_clip_seconds", 40)))
    max_duration = max(min_duration, int(config.get("max_clip_seconds", 60)))
    clip_count = max(1, int(config.get("clip_count", 1)))

    candidates = []
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

            text = segment_text_window(segments, start, end)
            if len(text.split()) < 8:
                continue

            candidates.append({
                "score": local_clip_score(text, start, duration),
                "start": start,
                "end": end,
                "text": text,
            })

    candidates.sort(key=lambda item: item["score"], reverse=True)
    selected = []
    for candidate in candidates:
        overlaps = any(
            candidate["start"] < item["end"] and candidate["end"] > item["start"]
            for item in selected
        )
        if overlaps:
            continue
        selected.append(candidate)
        if len(selected) >= clip_count:
            break

    if not selected and segments:
        start = float(segments[0].get("start", 0))
        end = min(float(segments[-1].get("end", start + max_duration)), start + max_duration)
        selected.append({
            "score": 0,
            "start": start,
            "end": end,
            "text": segment_text_window(segments, start, end),
        })

    clips = []
    for index, item in enumerate(selected):
        title = local_clip_title(item["text"], index)
        clips.append({
            "title": title,
            "reason": reason or "Fallback lokal memilih bagian dengan sinyal hook, angka, konflik, dan kata kunci kuat.",
            "start": round(float(item["start"]), 2),
            "end": round(float(item["end"]), 2),
            "hook": item["text"],
            "caption": item["text"],
        })

    return clips


def build_candidate_clips(segments, config):
    min_duration = max(10, int(config.get("min_clip_seconds", 40)))
    max_duration = max(min_duration, int(config.get("max_clip_seconds", 60)))
    max_candidates = max(1, min(5, int(config.get("ai_candidate_max_count", 5))))
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

            scored.append({
                "score": local_clip_score(text, start, duration),
                "start": start,
                "end": end,
                "duration": duration,
                "text": text,
            })

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
        selected.append({
            "score": 0,
            "start": start,
            "end": end,
            "duration": end - start,
            "text": segment_text_window(segments, start, end, max_chars=per_candidate_chars),
        })

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
        candidates.append({
            "candidate_id": index + 1,
            "start": round(float(item["start"]), 2),
            "end": round(float(item["end"]), 2),
            "duration": round(float(item["duration"]), 2),
            "text": text,
            "local_score": round(float(item["score"]), 2),
        })

    return candidates


def candidate_to_clip(candidate, index=0, reason=""):
    text = str(candidate.get("text", "")).strip()
    return {
        "title": local_clip_title(text, index),
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


def build_viral_strategy_prompt(candidates, config):
    theme = os.environ.get("DEFAULT_THEME", "podcast artis")
    source_title = os.environ.get("SOURCE_TITLE", "")
    candidate_payload = [
        {
            "candidate_id": item["candidate_id"],
            "start": item["start"],
            "end": item["end"],
            "duration": item["duration"],
            "text": item["text"],
        }
        for item in candidates
    ]

    return f"""
Kamu adalah Viral Content Strategist untuk konten Shorts, Reels, dan TikTok.

Tugas kamu bukan hanya membuat caption.
Tugas kamu adalah memilih kandidat clip yang paling berpotensi viral berdasarkan candidate transcript yang diberikan.

Aturan:
- Semua output wajib berdasarkan transcript.
- Jangan mengarang fakta.
- Jangan membuat klaim yang tidak ada di transcript.
- Jangan membuat clickbait menipu.
- Gunakan bahasa Indonesia.
- Hook harus kuat dan pendek.
- Caption harus natural, singkat, dan relevan.
- CTA harus ringan dan memancing komentar.
- Hashtag harus relevan dengan niche.
- Setiap hashtag wajib diawali tanda #.
- Thumbnail text harus 3 sampai 7 kata.
- Pilih angle yang paling kuat secara emosi, konflik, curiosity, relate, atau pelajaran hidup.
- Output wajib JSON valid saja, tanpa markdown.

Niche:
{theme}

Judul video sumber:
{source_title}

Candidate clips:
{json.dumps(candidate_payload, ensure_ascii=False, indent=2)}

Output wajib JSON valid:
{{
  "selected_candidate_id": 1,
  "viral_score": 0,
  "selected_angle": "",
  "viral_reason": "",
  "hook": "",
  "caption": "",
  "cta": "",
  "hashtags": [],
  "thumbnail_text": "",
  "publish_decision": "approved_or_low_quality"
}}
"""


def strategy_result_to_clips(data, candidates, config):
    if isinstance(data, list):
        return data

    if not isinstance(data, dict):
        raise ValueError("Output Gemini viral strategy harus object JSON.")

    try:
        selected_id = int(data.get("selected_candidate_id") or 0)
    except (TypeError, ValueError):
        selected_id = 0

    candidate = next((item for item in candidates if int(item["candidate_id"]) == selected_id), None)
    if candidate is None:
        candidate = candidates[0]

    try:
        viral_score = int(float(data.get("viral_score") or 0))
    except (TypeError, ValueError):
        viral_score = 0

    hashtags = normalize_hashtags(data.get("hashtags") or [])
    hashtags_text = " ".join(hashtags)
    hook = str(data.get("hook") or "").strip() or candidate["text"]

    caption_parts = [
        hook,
        str(data.get("caption") or "").strip(),
        str(data.get("cta") or "").strip(),
        hashtags_text,
    ]
    caption = "\n\n".join(part for part in caption_parts if part)
    thumbnail_text = str(data.get("thumbnail_text") or "").strip()
    publish_decision = str(data.get("publish_decision") or "approved").strip()

    minimum = int(config.get("min_viral_score_to_publish", 0))
    if minimum > 0 and not int(config.get("force_publish", 1)) and viral_score < minimum:
        publish_decision = "low_quality_clip"
        log_warn(f"Viral score {viral_score} di bawah batas {minimum}. Clip ditandai low_quality_clip.")

    return [{
        "title": thumbnail_text or hook,
        "reason": str(data.get("viral_reason") or data.get("selected_angle") or "").strip(),
        "start": float(candidate["start"]),
        "end": float(candidate["end"]),
        "hook": hook,
        "caption": caption or candidate["text"],
        "hashtags": hashtags,
        "thumbnail_text": thumbnail_text,
        "viral_score": viral_score,
        "selected_angle": str(data.get("selected_angle") or "").strip(),
        "publish_decision": publish_decision,
        "candidate_id": candidate["candidate_id"],
        "clip_transcript": candidate["text"],
    }]


def normalize_hashtags(value):
    if isinstance(value, str):
        items = [item.strip() for item in re.split(r"[\s,]+", value) if item.strip()]
    elif isinstance(value, list):
        items = value
    else:
        items = []

    if not items:
        items = ["PodcastIndonesia", "PodcastArtis", "ReelsIndonesia"]

    tags = []
    seen = set()
    for item in items:
        cleaned = re.sub(r"[^\w]", "", str(item).strip().lstrip("#"), flags=re.UNICODE)
        if not cleaned:
            continue
        tag = f"#{cleaned}"
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        tags.append(tag)
        if len(tags) >= 8:
            break
    return tags


def find_important_clips(segments, config):
    candidates = build_candidate_clips(segments, config)
    if not candidates:
        return validate_clips(find_local_important_clips(segments, config), segments, config)

    log_info(
        f"Candidate clip lokal: {len(candidates)} kandidat, "
        f"Gemini hanya menerima potongan pendek <= {config.get('ai_candidate_max_chars', 4000)} karakter."
    )

    if int(config.get("viral_strategy_enabled", 1)) != 1:
        log_warn("Viral strategy Gemini nonaktif. Pakai kandidat lokal.")
        local_clips = [candidate_to_clip(item, index) for index, item in enumerate(candidates)]
        return validate_clips(local_clips, segments, config)

    if not config["gemini_keys"] and not config.get("clod_key"):
        log_warn("GEMINI_API_KEYS dan CLOD_API_KEY kosong. Pakai fallback analisis lokal.")
        local_clips = [candidate_to_clip(item, index) for index, item in enumerate(candidates)]
        return validate_clips(local_clips, segments, config)

    prompt = build_viral_strategy_prompt(candidates, config)
    last_error = None

    for index, key in enumerate(config["gemini_keys"]):
        try:
            log_info(f"Viral strategy memakai Gemini key {index + 1}/{len(config['gemini_keys'])}")
            data = extract_json(call_gemini(prompt, key, config["gemini_model"]))
            clips = strategy_result_to_clips(data, candidates, config)
            return validate_clips(clips, segments, config)
        except Exception as exc:
            last_error = exc
            log_warn(f"Gemini viral strategy gagal: {exc}")

    if config.get("clod_key"):
        try:
            log_info(f"Viral strategy memakai CLOD model {config.get('clod_model', 'DeepSeek V3')}")
            data = extract_json(call_clod(prompt, config, max_tokens=1400))
            clips = strategy_result_to_clips(data, candidates, config)
            return validate_clips(clips, segments, config)
        except Exception as exc:
            last_error = exc
            log_warn(f"CLOD viral strategy gagal: {exc}")

    if int(config.get("viral_strategy_required", 0)) == 1:
        raise RuntimeError(f"Viral strategy gagal dan wajib berhasil: {last_error}")

    log_warn(f"Viral strategy gagal. Pakai fallback kandidat lokal: {last_error}")
    local_clips = [
        candidate_to_clip(item, index, f"Fallback lokal setelah provider AI gagal: {last_error}")
        for index, item in enumerate(candidates)
    ]
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
                "selected_angle": clip.get("selected_angle") or clip.get("selectedAngle") or "",
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

    if not config.get("gemini_keys") and not config.get("clod_key"):
        log_warn("Transcript review dilewati: GEMINI_API_KEYS dan CLOD_API_KEY kosong.")
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

    log_step(f"AI review subtitle clip {index + 1}.")

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
    review_required = int(config.get("transcript_review_required", 0)) == 1
    gemini_keys = config["gemini_keys"] if review_required else config["gemini_keys"][:1]

    for index, key in enumerate(gemini_keys):
        try:
            log_info(f"Review subtitle memakai Gemini key {index + 1}/{len(config['gemini_keys'])}")
            data = extract_json(call_gemini(prompt, key, config["gemini_model"]))
            return data if isinstance(data, list) else []
        except Exception as exc:
            last_error = exc
            log_warn(f"Gemini transcript review gagal: {exc}")

    if review_required and config.get("clod_key"):
        try:
            log_info(f"Review subtitle memakai CLOD model {config.get('clod_model', 'DeepSeek V3')}")
            data = extract_json(call_clod(prompt, config, max_tokens=1200))
            return data if isinstance(data, list) else []
        except Exception as exc:
            last_error = exc
            log_warn(f"CLOD transcript review gagal: {exc}")

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
            events.append((cue_start, cue_end, wrap_caption(text, config)))

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
            events.append((cue_start, cue_end, wrap_caption(text, config)))

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


def wrap_caption(text, config):
    clean = re.sub(r"\s+", " ", str(text or "")).strip()
    if not clean:
        return ""

    width = int(config.get("width", 1080))
    base_size = parse_int(os.environ.get("SUBTITLE_FONT_SIZE"), 46)
    min_size = min(base_size, parse_int(os.environ.get("SUBTITLE_MIN_FONT_SIZE"), 34))
    max_lines = max(2, min(3, parse_int(os.environ.get("SUBTITLE_MAX_LINES"), 3)))
    margin_h = parse_int(os.environ.get("SUBTITLE_MARGIN_H"), 120)
    safe_width = max(360, width - (margin_h * 2))

    for font_size in range(base_size, min_size - 1, -2):
        chars_per_line = subtitle_chars_per_line(safe_width, font_size)
        lines = wrap_text_to_lines(clean, chars_per_line, max_lines, truncate=False)
        if (
            lines
            and all(len(line) <= chars_per_line for line in lines)
            and " ".join(lines).replace("...", "").strip() == clean
        ):
            return subtitle_text_with_size(lines, font_size, base_size)

    chars_per_line = subtitle_chars_per_line(safe_width, min_size)
    lines = wrap_text_to_lines(clean, chars_per_line, max_lines, truncate=True)
    return subtitle_text_with_size(lines, min_size, base_size)


def subtitle_chars_per_line(safe_width, font_size):
    # Serif fonts are visually wider than the previous sans-serif captions.
    return max(12, int(float(safe_width) / max(float(font_size) * 0.54, 1.0)))


def wrap_text_to_lines(text, chars_per_line, max_lines, truncate=False):
    wrapped = textwrap.wrap(
        text,
        width=max(8, int(chars_per_line)),
        break_long_words=True,
        break_on_hyphens=False,
    )

    if len(wrapped) <= max_lines:
        return wrapped

    if not truncate:
        return []

    lines = wrapped[:max_lines]
    remaining = " ".join(wrapped[max_lines:])
    if remaining:
        last = lines[-1]
        room = max(4, int(chars_per_line) - 3)
        lines[-1] = f"{last[:room].rstrip()}..."
    return lines


def subtitle_text_with_size(lines, font_size, base_size):
    text = "\\N".join(ass_escape(line) for line in lines[:3])
    if font_size < base_size:
        return f"{{\\fs{font_size}}}{text}"
    return text


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
    font_family = subtitle_font_family()
    font_size = parse_int(os.environ.get("SUBTITLE_FONT_SIZE"), 46)
    margin_v = parse_int(os.environ.get("SUBTITLE_MARGIN_V"), 400)
    margin_h = parse_int(os.environ.get("SUBTITLE_MARGIN_H"), 120)
    primary_colour = os.environ.get("SUBTITLE_PRIMARY_COLOUR", "&H0030A8D6").strip() or "&H0030A8D6"
    outline_colour = os.environ.get("SUBTITLE_OUTLINE_COLOUR", "&H66000000").strip() or "&H66000000"
    back_colour = os.environ.get("SUBTITLE_SHADOW_COLOUR", "&H99000000").strip() or "&H99000000"
    outline = min(1.0, max(0.0, parse_float(os.environ.get("SUBTITLE_OUTLINE"), 1.0)))
    shadow = max(0.0, parse_float(os.environ.get("SUBTITLE_SHADOW"), 2.0))

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{font_family},{font_size},{primary_colour},{primary_colour},{outline_colour},{back_colour},0,0,0,0,100,100,0,0,1,{outline:g},{shadow:g},2,{margin_h},{margin_h},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    lines = [header]
    for start, end, text in events:
        lines.append(
            f"Dialogue: 0,{seconds_to_ass(start)},{seconds_to_ass(end)},Caption,,0,0,0,,{text}\n"
        )

    return "".join(lines)


def subtitle_font_family():
    font_family = os.environ.get("SUBTITLE_FONT_FAMILY", "Georgia").strip() or "Georgia"
    requested = [
        font_family.split(",")[0].strip(),
        *parse_keys(os.environ.get("SUBTITLE_FALLBACK_FONTS", "Times New Roman,DejaVu Serif")),
    ]
    requested = [font.replace(",", " ").strip() for font in requested if font.strip()]

    try:
        for font in requested:
            result = subprocess.run(
                ["fc-match", "-f", "%{family}", font],
                cwd=ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            families = [item.strip().lower() for item in str(result.stdout or "").split(",")]
            if font.lower() in families:
                return font
    except (OSError, subprocess.SubprocessError):
        pass

    return requested[0] if requested else "Georgia"


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


def smart_video_filter(source_clip, config, job_id, index):
    width = config["width"]
    height = config["height"]
    crop_path = None
    points = []
    crop_mode = str(config.get("smart_crop_mode", "auto")).lower().strip()

    if int(config.get("smart_crop", 1)) != 1 or crop_mode in {"center", "off", "none", "static"}:
        log_info("Smart crop nonaktif untuk render ini. Pakai crop tengah.")
        return centered_video_filter(config), crop_path

    try:
        points, crop_path = create_smart_crop_points(source_clip, config, job_id, index)
    except Exception as exc:
        log_warn(f"Smart crop gagal, pakai crop tengah: {exc}")
        return centered_video_filter(config), None

    if not points:
        return centered_video_filter(config), crop_path

    center_expr = build_interpolated_expression(points, "centerRatio")
    x_expr = f"min(max(iw*({center_expr})-ow/2,0),iw-ow)"
    x_expr = x_expr.replace(",", "\\,")
    log_info(f"Smart crop aktif: {len(points)} titik tracking")

    return (
        f"fps=30,scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"setsar=1,crop={width}:{height}:x='{x_expr}':y='(ih-oh)/2'"
    ), crop_path


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

    crop_mode = str(config.get("smart_crop_mode", "auto")).lower().strip()

    if crop_mode in {"active_speaker", "auto"}:
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
                "sourceClipPath": str(Path(source_clip).relative_to(ROOT)),
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
    - Jika tidak ada wajah dan tidak ada motion/visual: tahan crop terakhir.
    - Center hanya fallback terakhir agar podcast side-by-side tidak kosong di tengah.
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
    min_mouth_score_to_switch = max(0.0, float(config.get("active_speaker_min_mouth_score_to_switch", 0.06)))
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

                if active_track_id is None:
                    active_track_id = best_track_id
                    candidate_track_id = best_track_id
                    candidate_hits = 0
                elif best_track_id != active_track_id:
                    # Kalau mulut tidak cukup aktif, jangan cepat pindah speaker.
                    # Ini mencegah crop lompat hanya karena wajah lebih besar saat orang diam.
                    if float(best.get("mouth_score", 0.0)) < min_mouth_score_to_switch:
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
                elif no_face_hits < no_face_center_hits:
                    center = last_center
                    source = "no_face_carry"
                    carry_fallback_total += 1
                else:
                    # Center hanya fallback terakhir. Pada podcast, center bisa kosong,
                    # jadi durasi center default dibuat lebih lama lewat env.
                    center = source_width / 2
                    source = "no_face_center"
                    last_center = center
                    center_fallback_total += 1

            center = clamp(center, 0, source_width)
            points.append(
                {
                    "time": round(t, 3),
                    "centerX": round(center, 2),
                    "centerRatio": round(center / source_width, 6),
                    "source": source,
                }
            )
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
                "sourceClipPath": str(Path(source_clip).relative_to(ROOT)),
                "sourceWidth": source_width,
                "sourceHeight": source_height,
                "sampleSeconds": sample_seconds,
                "mode": "active_speaker",
                "switchSeconds": switch_seconds,
                "noFaceStrategy": no_face_strategy,
                "noFaceCenterAfterSeconds": no_face_center_after_seconds,
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
    usable = ((value > 0.08) & (value < 0.96)).astype("float32")

    score_map = (edge_score * 0.55 + texture * 0.30 + saturation * 0.15) * usable
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
    if best_score <= 0.0 or global_score <= 0.001:
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


def render_clip(source_clip, ass_path, clip, index, config, job_id):
    safe_title = clean_filename(clip["title"])
    final_clip = ROOT / "output" / f"py-final-{index + 1:02d}-{safe_title}.mp4"

    centered_vf = centered_video_filter(config)
    base_vf, crop_path = smart_video_filter(source_clip, config, job_id, index)
    subtitle_path = str(ass_path.resolve()).replace("\\", "/").replace(":", "\\:")
    subtitle_vf = f"{base_vf},subtitles='{subtitle_path}'"

    try:
        run_render(source_clip, final_clip, subtitle_vf, config)
    except subprocess.CalledProcessError as exc:
        log_warn(f"Render smart/subtitle gagal, coba crop tengah dengan subtitle: {exc}")
        try:
            run_render(source_clip, final_clip, f"{centered_vf},subtitles='{subtitle_path}'", config)
        except subprocess.CalledProcessError as fallback_exc:
            log_warn(f"Render subtitle gagal, fallback tanpa hardsub: {fallback_exc}")
            run_render(source_clip, final_clip, centered_vf, config)

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


def short_manual_title(source_title, index):
    cleaned = re.sub(r"\s+", " ", str(source_title or "")).strip()
    if not cleaned:
        return f"Manual Clip {index + 1}"

    cleaned = re.split(r"\s[-|]\s", cleaned, maxsplit=1)[0].strip()
    words = cleaned.split()
    return " ".join(words[:7]) or f"Manual Clip {index + 1}"


def parse_range(value, index, source_title=""):
    start_raw, end_raw = str(value).split("-", 1)
    start = parse_time(start_raw)
    end = parse_time(end_raw)
    if end <= start:
        raise ValueError(f"Range tidak valid: {value}")

    title = short_manual_title(source_title, index)
    return {
        "title": title,
        "reason": "Timestamp dipilih manual oleh user.",
        "start": start,
        "end": end,
        "hook": title,
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

    subtitle_path = download_subtitle(args.url, job_id, config["language"]) or latest_cached_subtitle(args.url)
    segments = parse_vtt(subtitle_path) if subtitle_path else []
    transcript_source = "youtube" if segments else ""

    if not segments and not args.range:
        cached_segments = latest_cached_json(args.url, "segments")
        if cached_segments:
            segments = cached_segments
            transcript_source = "cache"
        else:
            audio_path = download_audio(args.url, job_id)
            segments = transcribe_audio(audio_path, job_id, config)
            transcript_source = "deepgram"

    if not segments and not args.range:
        raise RuntimeError("Transkrip kosong. Tidak bisa lanjut.")

    segments_path = ROOT / "temp" / f"{job_id}-segments.json"
    segments_path.write_text(json.dumps(segments, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.range:
        source_title = ""
        try:
            source_title = str(get_video_info(args.url).get("title") or "")
        except Exception as exc:
            log_warn(f"Gagal mengambil judul video untuk manual range: {exc}")
        clips = [parse_range(value, index, source_title) for index, value in enumerate(args.range)]
    else:
        cached_clips = latest_cached_json(args.url, "clips")
        if cached_clips:
            clips = validate_clips(cached_clips, segments, config)
        else:
            log_step("Buat kandidat clip lokal, lalu Gemini pilih strategi viral.")
            clips = find_important_clips(segments, config)

    if not clips:
        raise RuntimeError("Tidak ada clip valid.")

    clips_path = ROOT / "temp" / f"{job_id}-clips.json"
    clips_path.write_text(json.dumps(clips, ensure_ascii=False, indent=2), encoding="utf-8")

    outputs = []

    for index, clip in enumerate(clips):
        log_step(f"Render clip {index + 1}/{len(clips)}: {clip['title']}")
        source_clip = download_clip_source(args.url, job_id, clip, index, config)
        subtitle_segments, review_path = review_clip_transcript_segments(segments, clip, config, job_id, index)
        ass_path = create_ass(subtitle_segments, clip, index, config, job_id)
        raw_clip, final_clip, smart_crop_path = render_clip(source_clip, ass_path, clip, index, config, job_id)
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
                "selectedAngle": clip.get("selected_angle", ""),
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

    result = {
        "jobId": job_id,
        "sourceUrl": args.url,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "transcriptSource": transcript_source,
        "target": "TikTok / Instagram Reels / YouTube Shorts",
        "resolution": f"{config['width']}x{config['height']}",
        "totalClips": len(outputs),
        "outputs": outputs,
    }

    result_path = ROOT / "output" / f"py-result-{job_id}.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    log_step("Selesai.")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
