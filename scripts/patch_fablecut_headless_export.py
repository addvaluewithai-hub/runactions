#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: patch_fablecut_headless_export.py <fablecut-app.js>")

path = Path(sys.argv[1])
s = path.read_text()

old = '''function waitForPresentedFrame(el, timeoutMs = 80) {
  return new Promise((res, rej) => {
    if (typeof el.requestVideoFrameCallback !== "function") {
      notePresented(el, el.currentTime);
      res();
      return;
    }
    let done = false;
    const finishOk = (meta) => {
      const mediaTime = meta?.mediaTime;
      if (!Number.isFinite(mediaTime)) return;
      if (done) return;
      done = true;
      clearTimeout(tm);
      notePresented(el, mediaTime);
      res();
    };
    const tm = setTimeout(() => {
      if (done) return;
      done = true;
      rej(new Error("presented frame timeout"));
    }, timeoutMs);
    el.requestVideoFrameCallback((_n, meta) => finishOk(meta));
  });
}'''

new = '''function waitForPresentedFrame(el, timeoutMs = 80) {
  return new Promise((res, rej) => {
    if (typeof el.requestVideoFrameCallback !== "function") {
      notePresented(el, el.currentTime);
      res();
      return;
    }
    // In headless Chrome, requestVideoFrameCallback may never fire for a
    // *paused* element after an accurate currentTime seek even though `seeked`
    // has fired and HAVE_CURRENT_DATA is available. hardSeekVideo() calls this
    // only after its seek settles, so for QServe CI that settled paused frame is
    // authoritative. Keep stock FableCut behaviour everywhere else.
    if (window.__QSERVE_HEADLESS_EXPORT__ && el.paused && !el.seeking && el.readyState >= 2) {
      setTimeout(() => {
        notePresented(el, el.currentTime);
        res();
      }, 0);
      return;
    }
    let done = false;
    const finishOk = (meta) => {
      const mediaTime = meta?.mediaTime;
      if (!Number.isFinite(mediaTime)) return;
      if (done) return;
      done = true;
      clearTimeout(tm);
      notePresented(el, mediaTime);
      res();
    };
    const tm = setTimeout(() => {
      if (done) return;
      done = true;
      rej(new Error("presented frame timeout"));
    }, timeoutMs);
    el.requestVideoFrameCallback((_n, meta) => finishOk(meta));
  });
}'''

if s.count(old) != 1:
    raise SystemExit(
        f"FableCut waitForPresentedFrame anchor changed; expected 1 match, found {s.count(old)}"
    )

s = s.replace(old, new, 1)
path.write_text(s)
print(
    "Applied QServe headless export compatibility patch: "
    "settled paused seeks use seeked/currentTime instead of waiting forever for rvfc"
)
