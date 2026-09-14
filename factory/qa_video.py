import argparse
import json
import subprocess
from pathlib import Path

from timeline_view import build_sheet


def probe(path: Path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ])
    return json.loads(out)


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
    duration = float(fmt.get("duration") or video_stream.get("duration") or 0)
    checks = {
        "resolution_1080x1920": video_stream.get("width") == 1080 and video_stream.get("height") == 1920,
        "duration_match": abs(duration - args.expected_duration) <= 0.75,
        "has_audio": audio_stream is not None,
        "nonempty_file": video.exists() and video.stat().st_size > 1_000_000,
    }
    report = {
        "file": str(video),
        "duration": duration,
        "expected_duration": args.expected_duration,
        "video_codec": video_stream.get("codec_name"),
        "audio_codec": audio_stream.get("codec_name") if audio_stream else None,
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "checks": checks,
        "passed": all(checks.values()),
    }
    (out_dir / "qa.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    build_sheet(video, 0.0, min(duration, args.expected_duration), out_dir / "render_contact_sheet.jpg", n_frames=16, columns=4)
    print(json.dumps(report, indent=2))
    if not report["passed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
