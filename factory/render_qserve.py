import argparse
import json
import subprocess
import tempfile
from pathlib import Path


def run(cmd):
    print("+", " ".join(str(x) for x in cmd))
    subprocess.run([str(x) for x in cmd], check=True)


def render_presenter(presenter: Path, start: float, duration: float, out: Path, w: int, h: int, fps: int):
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps={fps},format=yuv420p"
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", presenter,
        "-an", "-vf", vf, "-r", str(fps), "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
        "-pix_fmt", "yuv420p", out,
    ])


def render_image(image: Path, duration: float, out: Path, w: int, h: int, fps: int):
    filt = (
        f"[0:v]split=2[bg][fg];"
        f"[bg]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},gblur=sigma=28[blur];"
        f"[fg]scale={w-80}:{h-120}:force_original_aspect_ratio=decrease[front];"
        f"[blur][front]overlay=(W-w)/2:(H-h)/2,setsar=1,fps={fps},format=yuv420p[v]"
    )
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-loop", "1", "-framerate", str(fps), "-t", f"{duration:.3f}", "-i", image,
        "-filter_complex", filt, "-map", "[v]", "-an", "-r", str(fps),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", out,
    ])


def render_product_with_pip(
    product: Path,
    presenter: Path,
    presenter_start: float,
    duration: float,
    source_start: float,
    source_end: float,
    out: Path,
    transform: dict,
    w: int,
    h: int,
    fps: int,
):
    available = source_end - source_start
    if available + 0.05 < duration:
        raise ValueError(
            f"Approved product clip {source_start:.2f}-{source_end:.2f} is shorter than destination segment ({duration:.2f}s)"
        )
    scale_width = int(transform.get("scale_width", w))
    crop_height = int(transform.get("crop_height", h))
    crop_y = int(transform.get("crop_y", 244))
    pip_width = int(transform.get("pip_width", 300))
    x_margin = int(transform.get("pip_x_margin", 36))
    pip_y = int(transform.get("pip_y", 80))
    filt = (
        f"[0:v]scale={scale_width}:-2,crop={w}:{crop_height}:0:{crop_y},setsar=1,fps={fps}[base];"
        f"[1:v]scale={pip_width}:-2,pad=iw+12:ih+12:6:6:color=white,setsar=1[pip];"
        f"[base][pip]overlay=W-w-{x_margin}:{pip_y}:shortest=1,format=yuv420p[v]"
    )
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{source_start:.3f}", "-t", f"{duration:.3f}", "-i", product,
        "-ss", f"{presenter_start:.3f}", "-t", f"{duration:.3f}", "-i", presenter,
        "-filter_complex", filt, "-map", "[v]", "-an", "-r", str(fps),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", out,
    ])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lead", required=True)
    ap.add_argument("--work", default="work")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    root = Path.cwd()
    lead = json.loads(Path(args.lead).read_text(encoding="utf-8"))
    timeline = json.loads((root / lead["timeline"]).read_text(encoding="utf-8"))
    library = json.loads((root / lead["clip_library"]).read_text(encoding="utf-8"))
    clips = library["clips"]
    transform = library.get("transform", {})

    work = Path(args.work)
    presenter = work / lead["assets"]["presenter"]["filename"]
    product = work / lead["assets"]["product"]["filename"]
    qr = work / lead["assets"]["qr"]["filename"]
    mockup = work / lead["assets"]["mockup"]["filename"]
    for p in (presenter, product, qr, mockup):
        if not p.exists():
            raise FileNotFoundError(p)

    w = int(timeline["canvas"]["width"])
    h = int(timeline["canvas"]["height"])
    fps = int(timeline["canvas"]["fps"])
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="qserve-render-") as td:
        temp = Path(td)
        rendered = []
        expected_start = 0.0
        for idx, seg in enumerate(timeline["segments"]):
            start = float(seg["start"])
            end = float(seg["end"])
            if abs(start - expected_start) > 0.02:
                raise ValueError(f"Timeline gap/overlap before segment {idx}: expected {expected_start}, got {start}")
            duration = end - start
            if duration <= 0:
                raise ValueError(f"Invalid duration for segment {idx}")
            seg_out = temp / f"seg_{idx:03d}.mp4"
            layout = seg["layout"]
            if layout == "presenter_full":
                render_presenter(presenter, start, duration, seg_out, w, h, fps)
            elif layout == "qr_full":
                render_image(qr, duration, seg_out, w, h, fps)
            elif layout == "mockup_full":
                render_image(mockup, duration, seg_out, w, h, fps)
            elif layout == "product_with_pip":
                clip = clips[seg["clip"]]
                render_product_with_pip(
                    product, presenter, start, duration,
                    float(clip["start"]), float(clip["end"]), seg_out,
                    transform, w, h, fps,
                )
            else:
                raise ValueError(f"Unknown layout: {layout}")
            rendered.append(seg_out)
            expected_start = end

        if abs(expected_start - float(timeline["duration"])) > 0.05:
            raise ValueError("Timeline end does not match declared duration")

        concat_file = temp / "concat.txt"
        concat_file.write_text("\n".join(f"file '{p.as_posix()}'" for p in rendered) + "\n", encoding="utf-8")
        visuals = temp / "visuals.mp4"
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "concat", "-safe", "0", "-i", concat_file,
            "-c", "copy", visuals,
        ])
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", visuals, "-i", presenter,
            "-map", "0:v:0", "-map", "1:a:0?",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-t", f"{float(timeline['duration']):.3f}", "-movflags", "+faststart", output,
        ])

    print(f"Rendered {output} ({output.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
