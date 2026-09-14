import argparse
import math
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def extract_frame(video: Path, ts: float, out: Path, width: int = 270):
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{ts:.3f}", "-i", str(video), "-frames:v", "1",
        "-vf", f"scale={width}:-2", str(out),
    ], check=True)
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError(f"No frame produced at {ts:.3f}s")


def build_sheet(video: Path, start: float, end: float, output: Path, n_frames: int = 12, columns: int = 4):
    if end <= start:
        raise ValueError("end must be greater than start")
    n_frames = max(2, n_frames)

    # Sampling exactly at the container duration can legitimately produce no frame:
    # the duration marks the end boundary, while the final frame timestamp is earlier.
    # Stay a little inside the media so QA contact-sheet generation is deterministic.
    span = end - start
    tail_guard = min(0.10, span / max(n_frames, 2))
    sample_end = max(start, end - tail_guard)
    times = [start + (sample_end - start) * i / (n_frames - 1) for i in range(n_frames)]

    with tempfile.TemporaryDirectory(prefix="timeline-view-") as td:
        td = Path(td)
        frames = []
        for i, ts in enumerate(times):
            p = td / f"{i:03d}.jpg"
            try:
                extract_frame(video, ts, p)
            except RuntimeError:
                # Be tolerant of sparse/VFR media: walk back slightly, but never
                # before the requested start point.
                fallback = max(start, ts - 0.10)
                extract_frame(video, fallback, p)
                ts = fallback
            frames.append((ts, Image.open(p).convert("RGB")))

        thumb_w = frames[0][1].width
        thumb_h = frames[0][1].height
        label_h = 34
        rows = math.ceil(n_frames / columns)
        sheet = Image.new("RGB", (columns * thumb_w, rows * (thumb_h + label_h)), "white")
        draw = ImageDraw.Draw(sheet)
        font = ImageFont.load_default()
        for i, (ts, frame) in enumerate(frames):
            x = (i % columns) * thumb_w
            y = (i // columns) * (thumb_h + label_h)
            sheet.paste(frame, (x, y))
            label = f"{ts:06.2f}s"
            draw.rectangle((x, y + thumb_h, x + thumb_w, y + thumb_h + label_h), fill="white")
            draw.text((x + 8, y + thumb_h + 9), label, fill="black", font=font)
        output.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(output, quality=90)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("start", type=float)
    ap.add_argument("end", type=float)
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--n-frames", type=int, default=12)
    ap.add_argument("--columns", type=int, default=4)
    args = ap.parse_args()
    build_sheet(Path(args.video), args.start, args.end, Path(args.output), args.n_frames, args.columns)


if __name__ == "__main__":
    main()
