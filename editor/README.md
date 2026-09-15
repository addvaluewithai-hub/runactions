# QServe Video Editor

A lightweight collaborative multitrack editor for the personalized QServe sales-video factory.

## Deploy on Cloudflare Pages

Connect this repository to Cloudflare Pages and use:

- **Production branch:** `main`
- **Build command:** leave empty
- **Build output directory:** `editor`

Pages Functions live in the repository-level `functions/` directory and provide project save + render actions.

### Required Cloudflare environment variables / secrets

- `EDITOR_KEY` — private password used by the editor for write/render actions.
- `GITHUB_TOKEN` — GitHub token with **Contents: Read/Write** and **Actions: Read/Write** on `addvaluewithai-hub/runactions`.

Optional:

- `GITHUB_REPO=addvaluewithai-hub/runactions`
- `GITHUB_BRANCH=main`
- `RENDER_WORKFLOW=render-editor-project.yml`

Never put the GitHub token in browser JavaScript. It stays inside the Cloudflare Function.

Open Rooftop with:

`/?project=rooftop-7000`

## Current editor controls

The editor now exposes the broader editing surface so we can evaluate whether this custom product is enough for QServe:

- multitrack timeline: main video, two overlay tracks, presenter track, graphics/highlights track
- drag clips horizontally and trim both edges
- split clip at playhead
- duration/start/end and source in/out editing
- scene library with approved product/dashboard shots and one-click scene replacement
- insert a scene as an overlay instead of replacing the main scene
- add independent presenter clips anywhere on the timeline
- add text overlays and highlight boxes
- move a clip between tracks
- transform controls: X/Y, width/height, scale, rotation, opacity, radius and border
- cover / contain / fill modes
- fade and zoom transition controls in preview; fade transitions are rendered server-side
- magnetic main-track cut editing, snapping and safe-area overlay
- global presenter position/size/radius preset
- undo / redo, local drafts, reset, JSON import/export
- Save publishes the shared project JSON back to GitHub
- Render dispatches the deterministic GitHub Actions renderer

The final renderer supports main-scene edits plus multitrack image/video/presenter overlays, text, highlight boxes, transforms, opacity, borders and fades. The editor remains intentionally narrower than Premiere/CapCut: it is optimized for this repeatable sales-video format rather than becoming a general NLE.
