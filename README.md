# QServe Personalized Sales Video Pipeline

This repo is the experiment runner for turning one master sales recording into personalized lead videos.

## Current first sample

Lead: **Rooftop 7000**

Inputs:
- Master presenter video from Google Drive
- QServe mobile screen recording from Google Drive
- Lead-specific tabletop QR visual
- Lead-specific QServe app mockup

## Pipeline

1. **Gemini 3.5 Flash-Lite** analyzes the presenter video semantically and identifies moments such as digital menu, call waiter, feedback, management visibility, personalized mockup, and CTA.
2. **Faster-Whisper large-v3-turbo** produces audio-aligned timestamps. This is important because raw multimodal model timestamps can drift, especially with mobile recordings and odd video metadata.
3. Gemini receives the audio-aligned transcript and creates semantic edit anchors using those authoritative timestamps.
4. The product screen recording is segmented into usable shots. Its model-produced timestamps are normalized against the real `ffprobe` duration.
5. An edit plan JSON defines the 9:16 timeline: QR opener, presenter full-screen, product demo with presenter PiP, personalized mockup, and CTA.
6. Rendering is deterministic with FFmpeg for the first sample. HyperFrames is a good next layer for reusable web-style motion graphics, brand cards, animated captions, and scalable template rendering, while FFmpeg remains the reliable media cutting/compositing engine.

## Personalization model

The master narration and product footage stay the same. Per lead we swap mainly:

- `venue_name`
- `qr_tabletop_image`
- `personalized_app_mockup`
- optional logo / palette / venue-specific dashboard screenshots

That means after the first timeline is approved, the next lead should only require generating the two personalized visuals and running the same render template.

## Dashboard visuals

The QServe app repo exposes demo routes such as:

- `/dashboard/overview?venue=nile-table`
- `/dashboard/menu?venue=nile-table`
- `/dashboard/requests?venue=nile-table`
- `/dashboard/analytics?venue=nile-table`

Use screenshots from these routes when the narration specifically discusses menu control, service-request status, escalation, or management visibility. Until those screenshots are available, the renderer should prefer presenter footage rather than invent fake dashboard UI.

## Triggering analysis

Open an issue whose title contains:

`[run-video-analysis]`

The workflow downloads both source videos, runs Gemini + Whisper alignment, and uploads a `qserve-video-analysis` artifact containing:

- `aligned_transcript.json`
- `aligned_anchors.json`
- `product_shots_aligned.json`
- `edit_plan.json`

The repository secret expected by the workflow is `GEMINI_API_KEY`.
