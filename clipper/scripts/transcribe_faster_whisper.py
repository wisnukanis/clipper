import argparse
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("output")
    parser.add_argument("--language", default="id")
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            "faster-whisper belum terinstall. Jalankan: npm run setup:offline",
            file=sys.stderr,
        )
        return 2

    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
    )

    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        vad_filter=True,
        beam_size=5,
    )

    result = {
        "language": info.language,
        "language_probability": info.language_probability,
        "segments": [
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": segment.text.strip(),
            }
            for segment in segments
            if segment.text and segment.text.strip()
        ],
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
