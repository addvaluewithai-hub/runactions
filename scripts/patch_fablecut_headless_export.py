#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: patch_fablecut_headless_export.py <fablecut-app.js>")

path = Path(sys.argv[1])
s = path.read_text()

old = 'function waitForPresentedFrame(el, timeoutMs = 80) {'
new = 'function waitForPresentedFrame(el, timeoutMs = (window.__QSERVE_HEADLESS_EXPORT__ ? 2000 : 80)) {'

if s.count(old) != 1:
    raise SystemExit(f"FableCut waitForPresentedFrame anchor changed; expected 1 match, found {s.count(old)}")

s = s.replace(old, new, 1)
path.write_text(s)
print('Applied QServe headless export compatibility patch: presented-frame timeout 80ms -> 2000ms (headless only)')
