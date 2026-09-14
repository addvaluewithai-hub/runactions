import argparse
import json
import subprocess
from fractions import Fraction
from pathlib import Path

from timeline_view import build_sheet


def probe(path: Path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ])
    return json.loads(out)


def stream_duration(stream, fallback=0.0):
    try:
        return float(stream.get("duration") or fallback or 0)
    except (TypeError, ValueError):
        return float(fallback or 0)


def stream_fps(stream):
    raw = stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "0/1"
    try:
        value = float(Fraction(raw))
        return value if value > 0 else 30.0
    except (ValueError, ZeroDivisionError):
        return 30.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--expected-duration", type=float, required=True)
    ap.add_argument("--out-dir", default="qa")
    args = ap.parse_args()

    video = Path(args.video)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    data = probe(video)
    fmt = data.get("format", {})
    streams = data.get("streams", [])
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not video_stream:
        raise RuntimeError("No video stream found")

    format_duration = float(fmt.get("duration") or 0)
    video_duration = stream_duration(video_stream, format_duration)
    audio_duration = stream_duration(audio_stream, format_duration) if audio_stream else 0.0
    fps = stream_fps(video_stream)
    video_tolerance = max(0.12, 2.0 / fps)

    checks = {
        "resolution_1080x1920": video_stream.get("width") == 1080 and video_stream.get("height") == 1920,
        "container_duration_match": abs(format_duration - args.expected_duration) <= 0.75,
        "video_duration_match": abs(video_duration - args.expected_duration) <= video_tolerance,
        "has_audio": audio_stream is not None,
        "audio_duration_match": audio_stream is not None and abs(audio_duration - args.expected_duration) <= 0.50,
        "nonempty_file": video.exists() and video.stat().st_size > 1_000_000,
    }
    report = {
        "file": str(video),
        "format_duration": format_duration,
        "video_duration": video_duration,
        "audio_duration": audio_duration,
        "expected_duration": args.expected_duration,
        "fps": fps,
        "video_duration_tolerance": video_tolerance,
        "video_codec": video_stream.get("codec_name"),
        "audio_codec": audio_stream.get("codec_name") if audio_stream else None,
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "checks": checks,
        "passed": all(checks.values()),
    }
    (out_dir / "qa.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    # Contact-sheet sampling must stay inside the actual video stream, not merely
    # the MP4 container/audio duration. This also makes a visual-stream shortfall
    # visible in QA instead of silently passing on container duration alone.
    build_sheet(
        video,
        0.0,
        min(video_duration, args.expected_duration),
        out_dir / "render_contact_sheet.jpg",
        n_frames=16,
        columns=4,
    )
    print(json.dumps(report, indent=2))
    if not report["passed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
