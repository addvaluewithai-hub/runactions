# QServe Video Factory

This repo turns one approved QServe sales-video master into personalized lead videos.

The production path is deliberately simple and deterministic:

1. **Gemini + Faster-Whisper** are used when the master narration or product recording changes, to understand the script and align speech precisely.
2. The product screen recording is reviewed once and converted into an **approved clip library** (`factory/clips.json`). Bad transitions, browser chrome and unusable moments are not selected at render time.
3. A reusable **master timeline** (`timelines/qserve_master_v1.json`) defines when to show the presenter, product footage with presenter PiP, the personalized QR visual and the venue-specific QServe mockup.
4. **FFmpeg** performs deterministic crop, cut, PiP, audio muxing and encoding.
5. A lightweight `timeline_view.py` creates contact sheets for source ranges and the rendered output, inspired by the text-first / on-demand visual inspection approach used by agentic editors.
6. Automated QA validates resolution, duration, audio presence and produces a final contact sheet before the artifact is published.

## Render a lead

The easiest trigger is to open a GitHub issue titled:

```text
[render-qserve] rooftop-7000
```

Or run the **Render QServe personalized video** workflow manually and enter the lead slug.

The workflow uploads an artifact containing:

- `<lead>.mp4`
- `qa/render/qa.json`
- `qa/render/render_contact_sheet.jpg`
- source contact sheets for the important order/waiter flows
- the exact lead manifest, master timeline and approved clip library used for the render

## Add a new lead

Create `leads/<slug>.json`. The presenter video, product recording and master timeline can remain the same; normally only the lead-specific QR image and app mockup change.

Example:

```json
{
  "slug": "new-venue",
  "venue_name": "New Venue",
  "timeline": "timelines/qserve_master_v1.json",
  "clip_library": "factory/clips.json",
  "assets": {
    "presenter": {"drive_id": "...", "filename": "presenter.mp4"},
    "product": {"drive_id": "...", "filename": "product.mp4"},
    "qr": {"drive_id": "...", "filename": "qr.jpg"},
    "mockup": {"drive_id": "...", "filename": "mockup.jpg"}
  }
}
```

Then open:

```text
[render-qserve] new-venue
```

## Product clip library

`factory/clips.json` is intentionally curated once rather than asking a model to rediscover the whole 217-second screen recording on every render. Current reusable scenes include guest home, menu browsing, Arabic menu, order-from-table, staff order receipt, request accepted, call waiter and staff waiter receipt.

`factory/timeline_view.py` can inspect any ambiguous source interval on demand:

```bash
python factory/timeline_view.py work/product.mp4 160 181 -o waiter-flow.jpg --n-frames 16
```

## Analysis workflow

The existing `analyze-video.yml` remains useful for **master-edit changes**. It downloads the master videos, uses Gemini for semantic understanding and Faster-Whisper for audio-aligned timing, and emits aligned transcript/anchor/edit-plan artifacts.

The render factory does **not** call an LLM for every lead. That keeps repeated personalization fast, cheap and reproducible.

## Secrets / requirements

The analysis workflow expects `GEMINI_API_KEY`.

The render workflow does not need an AI API key; it downloads assets from Google Drive, uses FFmpeg/Python, validates the output and publishes a GitHub Actions artifact.
