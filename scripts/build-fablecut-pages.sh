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

# Seed projects are public read-only fallbacks. User edits are saved by /api/project
# into the QSERVE_PROJECTS R2 binding, never committed back to GitHub from the browser.
mkdir -p "$OUT/projects"
for d in fablecut/projects/*; do
  [ -d "$d" ] || continue
  slug="$(basename "$d")"
  cp "$d/project.json" "$OUT/projects/$slug.json"
done

# Browser previews use lightweight proxies under the same paths that production
# originals use in CI. That keeps the project.json portable between Pages and Actions.
mkdir -p "$OUT/media/rooftop-7000"
cp editor/media/rooftop-7000/presenter_proxy.mp4 "$OUT/media/rooftop-7000/presenter.mp4"
cp editor/media/rooftop-7000/product_proxy.mp4 "$OUT/media/rooftop-7000/product.mp4"
cp editor/media/rooftop-7000/qr.jpg "$OUT/media/rooftop-7000/qr.jpg"
cp editor/media/rooftop-7000/mockup.jpg "$OUT/media/rooftop-7000/mockup.jpg"
cp editor/media/rooftop-7000/dashboard_menu.jpg "$OUT/media/rooftop-7000/dashboard_menu.jpg"
cp editor/media/rooftop-7000/dashboard_services.jpg "$OUT/media/rooftop-7000/dashboard_services.jpg"
cp editor/media/rooftop-7000/dashboard_requests.jpg "$OUT/media/rooftop-7000/dashboard_requests.jpg"
cp editor/media/rooftop-7000/dashboard_performance.jpg "$OUT/media/rooftop-7000/dashboard_performance.jpg"

cat > "$OUT/_headers" <<'EOF'
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
  X-Content-Type-Options: nosniff

/api/*
  Cache-Control: no-store

/projects/*
  Cache-Control: no-store
EOF

echo "Built $OUT"
find "$OUT" -maxdepth 2 -type f -printf '%p %k KB\n' | sort | head -80
