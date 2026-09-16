#!/usr/bin/env bash
set -euo pipefail

FABLECUT_COMMIT="${FABLECUT_COMMIT:-21ec62f5c1599667d632b78b39e8191ba14f71d9}"
OUT="${FABLECUT_PAGES_OUT:-dist}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Building QServe FableCut Pages bundle from ${FABLECUT_COMMIT}"
git clone --quiet --no-checkout https://github.com/ronak-create/FableCut.git "$TMP/fablecut"
git -C "$TMP/fablecut" checkout --quiet "$FABLECUT_COMMIT"

rm -rf "$OUT"
mkdir -p "$OUT"

for file in index.html app.js style.css favicon.svg meter-worklet.js ruler-worker.js; do
  cp "$TMP/fablecut/$file" "$OUT/$file"
done
cp -R "$TMP/fablecut/icons" "$OUT/icons"
cp -R "$TMP/fablecut/library" "$OUT/library"
cp fablecut/qserve-bootstrap.js "$OUT/qserve-bootstrap.js"

python - "$OUT/index.html" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
needle = '<script src="app.js"></script>'
insert = '<script src="qserve-bootstrap.js"></script>\n<script src="app.js"></script>'
if needle not in s:
    raise SystemExit('Could not find FableCut app.js script tag')
p.write_text(s.replace(needle, insert, 1))
PY

# Static manifest keeps FableCut's built-in SFX/elements/SVG/fonts library fully
# usable on Pages even though there is no persistent Node /api/library server.
python - "$OUT" <<'PY'
from pathlib import Path
import json, sys, urllib.parse
root = Path(sys.argv[1])
lib = root / 'library'
out = {}
for kind in ('sfx','elements','svg','fonts'):
    base = lib / kind
    items = []
    if base.exists():
        for f in sorted(p for p in base.rglob('*') if p.is_file()):
            rel = f.relative_to(base).as_posix()
            src = '/library/' + kind + '/' + '/'.join(urllib.parse.quote(part) for part in rel.split('/'))
            items.append({'name': f.name, 'rel': rel, 'size': f.stat().st_size, 'src': src})
    out[kind] = items
(root / 'library-manifest.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',',':')))
PY

# Seed projects are public read-only fallbacks. User edits are saved by /api/project
# into the QSERVE_PROJECTS R2 binding, never committed back to GitHub from the browser.
mkdir -p "$OUT/projects"
for d in fablecut/projects/*; do
  [ -d "$d" ] || continue
  slug="$(basename "$d")"
  cp "$d/project.json" "$OUT/projects/$slug.json"
done

# Browser preview assets are deliberately lightweight proxies. FableCut's stock
# Node server treats /media as flat, so QServe namespaces filenames with the lead slug.
mkdir -p "$OUT/media"
cp editor/media/rooftop-7000/presenter_proxy.mp4 "$OUT/media/rooftop-7000-presenter.mp4"
cp editor/media/rooftop-7000/product_proxy.mp4 "$OUT/media/rooftop-7000-product.mp4"
cp editor/media/rooftop-7000/qr.jpg "$OUT/media/rooftop-7000-qr.jpg"
cp editor/media/rooftop-7000/mockup.jpg "$OUT/media/rooftop-7000-mockup.jpg"
cp editor/media/rooftop-7000/dashboard_menu.jpg "$OUT/media/rooftop-7000-dashboard-menu.jpg"
cp editor/media/rooftop-7000/dashboard_services.jpg "$OUT/media/rooftop-7000-dashboard-services.jpg"
cp editor/media/rooftop-7000/dashboard_requests.jpg "$OUT/media/rooftop-7000-dashboard-requests.jpg"
cp editor/media/rooftop-7000/dashboard_performance.jpg "$OUT/media/rooftop-7000-dashboard-performance.jpg"

cat > "$OUT/_headers" <<'EOF'
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
  X-Content-Type-Options: nosniff

/api/*
  Cache-Control: no-store

/projects/*
  Cache-Control: no-store

/library-manifest.json
  Cache-Control: public, max-age=3600
EOF

echo "Built $OUT"
find "$OUT" -maxdepth 2 -type f -printf '%p %k KB\n' | sort | head -100
