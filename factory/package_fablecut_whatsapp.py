#!/usr/bin/env python3
import argparse
import json
import pathlib
import subprocess


def media_local_path(project: dict, data_dir: pathlib.Path, media_id: str) -> pathlib.Path:
    item = next((m for m in project.get("media", []) if m.get("id") == media_id), None)
    if item is None:
        raise SystemExit(f"Required media slot not found: {media_id}")
    src = str(item.get("src") or "")
    if not src:
        raise SystemExit(f"Media slot {media_id} has no src")
    if src.startswith("/media/"):
        path = data_dir / src.lstrip("/")
    else:
        path = data_dir / src.lstrip("/")
    if not path.exists():
        raise SystemExit(f"App cover file does not exist: {path}")
    return path


def ffprobe(path: pathlib.Path) -> dict:
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
        "-of", "json", str(path),
    ], text=True)
    return json.loads(out)


def main() -> None:
    ap = argparse.ArgumentParser(description="Package a native FableCut render for WhatsApp outreach.")
    ap.add_argument("--project", required=True)
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--cover-seconds", type=float, default=0.6)
    ap.add_argument("--app-media-id", default="m_mockup")
    ap.add_argument("--crf", type=int, default=21)
    ap.add_argument("--preset", default="slow")
    ap.add_argument("--audio-bitrate", default="160k")
    args = ap.parse_args()

    project_path = pathlib.Path(args.project)
    data_dir = pathlib.Path(args.data_dir)
    input_path = pathlib.Path(args.input)
    output_path = pathlib.Path(args.output)
    project = json.loads(project_path.read_text())
    cover_path = media_local_path(project, data_dir, args.app_media_id)

    if not input_path.exists():
        raise SystemExit(f"Native input render missing: {input_path}")
    if args.cover_seconds <= 0:
        raise SystemExit("cover-seconds must be > 0")

    width = int(project.get("width") or 1080)
    height = int(project.get("height") or 1920)
    fps = float(project.get("fps") or 24)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # The cover is an overlay only: the native timeline and audio remain at t=0.
    # Scale-to-fill avoids letterboxing while preserving the intended 9:16 app artwork.
    filter_complex = (
        f"[1:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1[cover];"
        f"[0:v][cover]overlay=0:0:enable='lt(t,{args.cover_seconds})'[v]"
    )

    cmd = [
        "ffmpeg", "-y",
        "-i", str(input_path),
        "-loop", "1", "-framerate", str(fps), "-i", str(cover_path),
        "-filter_complex", filter_complex,
        "-map", "[v]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", args.preset, "-crf", str(args.crf),
        "-pix_fmt", "yuv420p", "-profile:v", "high",
        "-c:a", "aac", "-b:a", args.audio_bitrate,
        "-movflags", "+faststart", "-shortest",
        str(output_path),
    ]
    print("Packaging WhatsApp delivery:", " ".join(cmd))
    subprocess.check_call(cmd)

    meta = ffprobe(output_path)
    size = int(meta.get("format", {}).get("size") or output_path.stat().st_size)
    result = {
        "output": str(output_path),
        "bytes": size,
        "megabytes_decimal": round(size / 1_000_000, 2),
        "coverSeconds": args.cover_seconds,
        "coverMediaId": args.app_media_id,
        "coverPath": str(cover_path),
        "crf": args.crf,
        "preset": args.preset,
        "audioBitrate": args.audio_bitrate,
        "probe": meta,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    (output_path.parent / "whatsapp-package.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
