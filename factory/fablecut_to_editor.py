#!/usr/bin/env python3
"""Convert a FableCut project document into QServe's production-render schema.

FableCut remains the canonical editable timeline.  The converter intentionally
supports the subset QServe uses today (image/video main clips, visual overlays,
and one locked narration source) so final renders can use the proven FFmpeg
renderer instead of streaming thousands of canvas frames through a browser.
"""
import argparse
import json
import math
from pathlib import Path


ALIASES = {
    "m_presenter": "presenter",
    "m_product": "product",
    "m_qr": "qr",
    "m_mockup": "mockup",
    "m_dashboard_menu": "dashboardMenu",
    "m_dashboard_services": "dashboardServices",
    "m_dashboard_requests": "dashboardRequests",
    "m_dashboard_performance": "dashboardPerformance",
}


def alias_for(media):
    mid = str(media.get("id", ""))
    if mid in ALIASES:
        return ALIASES[mid]
    hay = f"{mid} {media.get('name','')}".lower()
    rules = [
        ("presenter", "presenter"),
        ("guest app", "product"),
        ("product", "product"),
        ("qr", "qr"),
        ("mockup", "mockup"),
        ("dashboard", None),
    ]
    if "dashboard" in hay:
        if "menu" in hay:
            return "dashboardMenu"
        if "service" in hay:
            return "dashboardServices"
        if "request" in hay:
            return "dashboardRequests"
        if "performance" in hay:
            return "dashboardPerformance"
    for needle, out in rules:
        if out and needle in hay:
            return out
    # Stable fallback for user-imported media. The current production renderer
    # can consume it once asset_path gains a matching browser-import path.
    return mid or "media"


def media_kind(m):
    k = str(m.get("kind") or m.get("type") or "").lower()
    if k in ("video", "audio", "image"):
        return k
    src = str(m.get("src", "")).lower().split("?", 1)[0]
    if src.endswith((".mp4", ".mov", ".webm", ".mkv", ".m4v")):
        return "video"
    if src.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
        return "image"
    return "image"


def track_clips(project, track_id):
    return sorted(
        [c for c in project.get("clips", []) if c.get("track") == track_id and c.get("kind") != "audio"],
        key=lambda c: (float(c.get("start", 0)), str(c.get("id", ""))),
    )


def coverage_score(clips):
    if not clips:
        return (-1, -1, -1)
    start = min(float(c.get("start", 0)) for c in clips)
    end = max(float(c.get("start", 0)) + float(c.get("duration", 0)) for c in clips)
    dur = sum(max(0, float(c.get("duration", 0))) for c in clips)
    # Prefer a track that starts at zero, spans the project, and has high coverage.
    return (1 if start <= 0.05 else 0, end - start, dur)


def choose_main_track(project):
    candidates = []
    for t in project.get("tracks", []):
        if str(t.get("kind", "")).lower() == "audio":
            continue
        clips = track_clips(project, t.get("id"))
        if clips:
            candidates.append((coverage_score(clips), t, clips))
    if not candidates:
        raise ValueError("FableCut project has no visual track")
    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0][1], candidates[0][2]


def motion_for(clip):
    kf = (clip.get("keyframes") or {}).get("scale") or []
    if len(kf) >= 2 and float(kf[-1].get("v", 1)) > float(kf[0].get("v", 1)) + 0.005:
        return "slowZoom"
    p = clip.get("props") or {}
    x, y, sc = float(p.get("x", 0) or 0), float(p.get("y", 0) or 0), float(p.get("scale", 1) or 1)
    if x < -80:
        return "focusRight"
    if y > 60:
        return "focusTop"
    if sc > 1.04:
        return "focusCenter"
    return ""


def transition_name(v):
    if isinstance(v, str):
        return "fade" if v == "fade" else None
    if isinstance(v, dict):
        return "fade" if v.get("type") == "fade" else None
    return None


def transition_duration(clip):
    vals = []
    for key in ("transitionIn", "transitionOut"):
        v = clip.get(key)
        if isinstance(v, dict) and v.get("duration") is not None:
            try:
                vals.append(float(v["duration"]))
            except Exception:
                pass
    return vals[0] if vals else 0.35


def main_clip(c, aliases):
    p = c.get("props") or {}
    s = float(c.get("start", 0)); d = float(c.get("duration", 0)); e = s + d
    out = {
        "id": c.get("id"),
        "asset": aliases[c.get("mediaId")],
        "label": c.get("name") or c.get("id") or "Clip",
        "start": round(s, 6),
        "end": round(e, 6),
        "sourceIn": round(float(c.get("in", 0) or 0), 6),
        "sourceOut": round(float(c.get("in", 0) or 0) + d, 6),
        "fit": p.get("fit", "cover"),
        "opacity": float(p.get("opacity", 1) or 1),
        "layout": {"x": 0, "y": 0, "w": 100, "h": 100, "scale": 1, "rotate": 0, "radius": 0, "border": 0},
    }
    mot = motion_for(c)
    if mot:
        out["motion"] = mot
    tin, tout = transition_name(c.get("transitionIn")), transition_name(c.get("transitionOut"))
    if tin:
        out["transitionIn"] = tin
    if tout:
        out["transitionOut"] = tout
    if tin or tout:
        out["transitionDuration"] = transition_duration(c)
    return out


def fitted_size(media, props, W, H):
    mw = float(media.get("width") or W); mh = float(media.get("height") or H)
    crop_l = max(0, min(99, float(props.get("cropL", 0) or 0)))
    crop_r = max(0, min(99, float(props.get("cropR", 0) or 0)))
    crop_t = max(0, min(99, float(props.get("cropT", 0) or 0)))
    crop_b = max(0, min(99, float(props.get("cropB", 0) or 0)))
    mw *= max(.01, 1 - (crop_l + crop_r) / 100)
    mh *= max(.01, 1 - (crop_t + crop_b) / 100)
    fit = props.get("fit", "contain")
    if fit == "fill":
        bw, bh = W, H
    else:
        r = max(W / mw, H / mh) if fit == "cover" else min(W / mw, H / mh)
        bw, bh = mw * r, mh * r
    sc = max(.001, float(props.get("scale", 1) or 1))
    return bw * sc, bh * sc


def overlay_clip(c, media_by_id, aliases, W, H):
    p = c.get("props") or {}
    s = float(c.get("start", 0)); d = float(c.get("duration", 0)); e = s + d
    media = media_by_id[c.get("mediaId")]
    bw, bh = fitted_size(media, p, W, H)
    cx = W / 2 + float(p.get("x", 0) or 0)
    cy = H / 2 + float(p.get("y", 0) or 0)
    x, y = cx - bw / 2, cy - bh / 2
    return {
        "id": c.get("id"),
        "asset": aliases[c.get("mediaId")],
        "label": c.get("name") or c.get("id") or "Overlay",
        "start": round(s, 6),
        "end": round(e, 6),
        "sourceIn": round(float(c.get("in", 0) or 0), 6),
        "sourceOut": round(float(c.get("in", 0) or 0) + d, 6),
        "fit": p.get("fit", "contain"),
        "opacity": float(p.get("opacity", 1) or 1),
        "layout": {
            "x": round(x / W * 100, 4), "y": round(y / H * 100, 4),
            "w": round(bw / W * 100, 4), "h": round(bh / H * 100, 4),
            "scale": 1, "rotate": float(p.get("rotation", 0) or 0),
            "radius": float(p.get("cornerRadius", 0) or 0), "border": 4 if float(p.get("cornerRadius", 0) or 0) > 0 else 0,
        },
        "borderColor": "#ffffff",
        "crop": {
            "left": float(p.get("cropL", 0) or 0), "right": float(p.get("cropR", 0) or 0),
            "top": float(p.get("cropT", 0) or 0), "bottom": float(p.get("cropB", 0) or 0),
            "unit": "percent",
        },
    }


def convert(project, slug):
    W, H, fps = int(project.get("width", 1080)), int(project.get("height", 1920)), int(project.get("fps", 30))
    media_list = project.get("media", [])
    media_by_id = {m.get("id"): m for m in media_list}
    aliases = {mid: alias_for(m) for mid, m in media_by_id.items()}

    main_track, main_fc = choose_main_track(project)
    total = max((float(c.get("start", 0)) + float(c.get("duration", 0)) for c in project.get("clips", [])), default=0)

    # Global media crop is enough for the current QServe guest recording; all
    # approved product clips use the same crop. Percent values come from FableCut.
    product_crop = {"top": 0, "bottom": 0}
    product_mid = next((mid for mid, a in aliases.items() if a == "product"), None)
    if product_mid:
        pm = media_by_id[product_mid]
        ph = float(pm.get("height") or 1280)
        pc = next((c for c in project.get("clips", []) if c.get("mediaId") == product_mid), None)
        if pc:
            pp = pc.get("props") or {}
            product_crop = {
                "top": round(ph * float(pp.get("cropT", 0) or 0) / 100),
                "bottom": round(ph * float(pp.get("cropB", 0) or 0) / 100),
            }

    media = {}
    for mid, m in media_by_id.items():
        a = aliases[mid]
        row = {"type": media_kind(m), "src": m.get("src", "")}
        if a == "product":
            row["crop"] = product_crop
        media[a] = row

    tracks = [{
        "id": "visual", "short": "V1", "name": "Main Video", "kind": "main",
        "clips": [main_clip(c, aliases) for c in main_fc],
    }]

    for t in project.get("tracks", []):
        tid = t.get("id")
        if tid == main_track.get("id") or str(t.get("kind", "")).lower() == "audio":
            continue
        cs = track_clips(project, tid)
        if not cs:
            continue
        kind = "presenter" if all(aliases.get(c.get("mediaId")) == "presenter" for c in cs) else "overlay"
        tracks.append({
            "id": f"fc-{tid}", "short": tid, "name": f"FableCut {tid}", "kind": kind,
            "clips": [overlay_clip(c, media_by_id, aliases, W, H) for c in cs],
        })

    audio_clip = next((c for c in project.get("clips", []) if c.get("kind") == "audio"), None)
    audio = {"asset": "presenter", "sourceIn": 0, "sourceOut": total, "locked": True}
    if audio_clip:
        audio["asset"] = aliases.get(audio_clip.get("mediaId"), "presenter")
        audio["sourceIn"] = float(audio_clip.get("in", 0) or 0)
        audio["sourceOut"] = audio["sourceIn"] + float(audio_clip.get("duration", total) or total)

    return {
        "version": 2,
        "slug": slug,
        "title": project.get("name", slug),
        "duration": round(total, 6),
        "fps": fps,
        "canvas": {"width": W, "height": H, "aspect": f"{W}:{H}"},
        "audio": audio,
        "media": media,
        "scenes": [],
        "tracks": tracks,
        "pip": {},
        "editor": {"source": "fablecut", "fablecutRevision": project.get("revision", 0)},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    src = json.loads(Path(args.project).read_text())
    out = convert(src, args.slug)
    path = Path(args.out); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
    print(f"Converted FableCut revision {src.get('revision', 0)} -> {path} ({out['duration']:.3f}s)")


if __name__ == "__main__":
    main()
