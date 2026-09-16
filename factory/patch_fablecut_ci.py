#!/usr/bin/env python3
"""Apply the small, explicit FableCut patch we need on GitHub runners.

FableCut intentionally waits for the browser to *present* the requested frame
before exporting it. That is the right correctness model, but the stock 80 ms
window is too aggressive for Chromium running under Xvfb/SwiftShader in CI.

This patch only touches the temporary pinned checkout used by the render job;
the editor deployed to Cloudflare remains stock FableCut.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("app_js", type=Path)
    ap.add_argument("--timeout-ms", type=int, default=750)
    ap.add_argument("--attempts", type=int, default=6)
    args = ap.parse_args()

    text = args.app_js.read_text(encoding="utf-8")
    original = text

    wait_pat = re.compile(
        r"function waitForPresentedFrame\(el, timeoutMs = \d+\)"
    )
    text, wait_count = wait_pat.subn(
        f"function waitForPresentedFrame(el, timeoutMs = {args.timeout_ms})",
        text,
        count=1,
    )

    seek_pat = re.compile(
        r"(function hardSeekVideo\(el, mt, attempt = 0\) \{\s*"
        r"const hasRvfc = typeof el\.requestVideoFrameCallback === \"function\";\s*"
        r"const maxAttempts = )\d+(;)"
    )
    text, attempt_count = seek_pat.subn(
        rf"\g<1>{args.attempts}\g<2>", text, count=1
    )

    if wait_count != 1 or attempt_count != 1:
        raise SystemExit(
            "Pinned FableCut seek implementation changed; refusing to apply an "
            f"unsafe patch (wait={wait_count}, attempts={attempt_count})."
        )
    if text == original:
        raise SystemExit("CI patch made no changes")

    args.app_js.write_text(text, encoding="utf-8")
    print(
        f"Patched {args.app_js}: presented-frame timeout={args.timeout_ms} ms, "
        f"hard-seek attempts={args.attempts}"
    )


if __name__ == "__main__":
    main()
