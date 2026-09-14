# QServe Video Editor

A lightweight collaborative timeline editor for the personalized QServe sales-video factory.

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

## First-time media setup

Run the GitHub Action **Build QServe editor assets** with `slug=rooftop-7000`. It creates lightweight presenter/product proxies plus QR, mockup and dashboard screenshots under `editor/media/rooftop-7000/` and commits them to `main`.

The browser editor uses only those lightweight proxies. Final renders always use the original high-resolution Drive sources.

## Collaboration model

- `editor/projects/<slug>.json` is the shared source of truth.
- Browser edits are stored locally immediately.
- **Save project** publishes the JSON back to GitHub through the Cloudflare Function.
- ChatGPT can modify the same JSON in GitHub, so both human and AI edits land on the same timeline.
- **Reset draft** restores the last published master.
- **Export JSON** gives a portable backup.
- **Render** saves first, then dispatches the deterministic GitHub Action renderer.

Open a project with:

`/?project=rooftop-7000`

## Current editor controls

- play/pause and frame-position scrubber
- drag clips horizontally
- drag left/right edges to trim
- numeric timeline/source in/out editing
- choose media asset, fit and still-image motion
- toggle presenter picture-in-picture
- adjust presenter overlay width, bottom offset and right margin
- undo, reset, JSON import/export

The editor is intentionally smaller than a general-purpose NLE: it exposes the controls that matter for this repeatable sales-video format without giving up deterministic server-side rendering.
