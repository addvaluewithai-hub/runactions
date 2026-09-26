#!/usr/bin/env python3
import argparse
import json
import mimetypes
import pathlib
import re
import urllib.parse
import urllib.request
from PIL import Image


def safe_slug(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip()).strip("-").lower()
    return value or "lead"


def ext_from(url: str, content_type: str | None) -> str:
    path_ext = pathlib.PurePosixPath(urllib.parse.urlparse(url).path).suffix.lower()
    if path_ext in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"}:
        return path_ext
    if content_type:
        guessed = mimetypes.guess_extension(content_type.split(";", 1)[0].strip())
        if guessed:
            return ".jpg" if guessed == ".jpe" else guessed
    return ".png"


def download_image(url: str, dest_base: pathlib.Path) -> pathlib.Path:
    req = urllib.request.Request(url, headers={"User-Agent": "qserve-fablecut-lead-variant/1.0"})
    with urllib.request.urlopen(req, timeout=120) as response:
        content_type = response.headers.get("Content-Type", "")
        ext = ext_from(url, content_type)
        dest = dest_base.with_suffix(ext)
        with open(dest, "wb") as f:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
    try:
        with Image.open(dest) as img:
            img.verify()
    except Exception as exc:
        raise SystemExit(f"Downloaded lead asset is not a valid image: {url} -> {dest}: {exc}")
    return dest


def replace_media(project: dict, media_id: str, path: pathlib.Path, lead_name: str, label: str) -> None:
    item = next((m for m in project.get("media", []) if m.get("id") == media_id), None)
    if item is None:
        raise SystemExit(f"Required FableCut media slot not found: {media_id}")
    with Image.open(path) as img:
        width, height = img.size
    item["src"] = "/media/" + path.name
    item["name"] = f"{lead_name} — {label}"
    item["width"] = width
    item["height"] = height


def main() -> None:
    ap = argparse.ArgumentParser(description="Inject per-lead QR/app images into a canonical FableCut project copy.")
    ap.add_argument("--project", required=True)
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--lead-name", required=True)
    ap.add_argument("--qr-url", required=True)
    ap.add_argument("--app-url", required=True)
    ap.add_argument("--qr-media-id", default="m_qr")
    ap.add_argument("--app-media-id", default="m_mockup")
    args = ap.parse_args()

    project_path = pathlib.Path(args.project)
    data_dir = pathlib.Path(args.data_dir)
    media_dir = data_dir / "media"
    media_dir.mkdir(parents=True, exist_ok=True)

    project = json.loads(project_path.read_text())
    lead_slug = safe_slug(args.lead_name)

    qr_path = download_image(args.qr_url, media_dir / f"lead-{lead_slug}-qr")
    app_path = download_image(args.app_url, media_dir / f"lead-{lead_slug}-app")

    replace_media(project, args.qr_media_id, qr_path, args.lead_name, "QR")
    replace_media(project, args.app_media_id, app_path, args.lead_name, "App")

    project.setdefault("qserveVariant", {})
    project["qserveVariant"].update({
        "leadName": args.lead_name,
        "leadSlug": lead_slug,
        "qrMediaId": args.qr_media_id,
        "appMediaId": args.app_media_id,
        "qrSourceUrl": args.qr_url,
        "appSourceUrl": args.app_url,
    })
    project_path.write_text(json.dumps(project, ensure_ascii=False, indent=2) + "\n")

    print(json.dumps({
        "lead": args.lead_name,
        "leadSlug": lead_slug,
        "qr": {"path": str(qr_path), "mediaId": args.qr_media_id},
        "app": {"path": str(app_path), "mediaId": args.app_media_id},
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
