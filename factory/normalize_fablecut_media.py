#!/usr/bin/env python3
"""Normalize video sources for deterministic, fast frame seeking in FableCut CI.

The browser compositor seeks repeatedly while exporting. Long GOPs and VFR input
make requestVideoFrameCallback much less predictable on GitHub-hosted runners.
We therefore create high-quality CFR H.264 intermediates with frequent keyframes
and update the temporary project.json to point at them.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path, PurePosixPath


def ffprobe_duration(path: Path) -> float | None:
    try:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(path),
            ],
            text=True,
        ).strip()
        return float(out)
    except Exception:
        return None


def normalize(src: Path, dst: Path, fps: int) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    gop = max(1, round(fps / 2))
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-y",
        "-fflags", "+genpts",
        "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", f"fps={fps}",
        "-fps_mode", "cfr",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "15",
        "-pix_fmt", "yuv420p",
        "-g", str(gop),
        "-keyint_min", str(gop),
        "-sc_threshold", "0",
        "-movflags", "+faststart",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000",
        str(dst),
    ]
    print("Normalizing:", src, "->", dst)
    subprocess.check_call(cmd)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", type=Path, required=True)
    ap.add_argument("--data-dir", type=Path, required=True)
    args = ap.parse_args()

    project = json.loads(args.project.read_text(encoding="utf-8"))
    fps = int(round(float(project.get("fps") or 30)))
    media_dir = args.data_dir / "media"

    changed = 0
    for media in project.get("media", []):
        if media.get("kind") != "video":
            continue
        src_url = str(media.get("src") or "")
        if not src_url.startswith("/media/"):
            raise SystemExit(f"Expected local /media source for {media.get('id')}: {src_url}")

        rel = PurePosixPath(src_url[len("/media/"):])
        src = media_dir / Path(*rel.parts)
        if not src.exists():
            raise SystemExit(f"Missing video source for normalization: {src}")

        dst_name = f"{src.stem}.ci.mp4"
        dst = src.with_name(dst_name)
        normalize(src, dst, fps)

        before = ffprobe_duration(src)
        after = ffprobe_duration(dst)
        if before is not None and after is not None and abs(before - after) > 0.20:
            raise SystemExit(
                f"Normalization changed duration too much for {media.get('id')}: "
                f"{before:.3f}s -> {after:.3f}s"
            )

        media["src"] = "/media/" + str(rel.with_name(dst_name))
        changed += 1
        print(
            f"Normalized {media.get('id')}: duration "
            f"{before if before is not None else 'n/a'} -> {after if after is not None else 'n/a'}"
        )

    if not changed:
        print("No video media needed normalization")
    args.project.write_text(
        json.dumps(project, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Updated project with {changed} CI-normalized video source(s)")


if __name__ == "__main__":
    main()
