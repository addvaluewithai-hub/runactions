# QServe FableCut Studio

QServe uses **FableCut for browser editing**, **Cloudflare Pages + Pages Functions + R2 for editor persistence**, and **GitHub Actions for production rendering + QA**.

There is intentionally **no GitHub token in Cloudflare**. When the edit is final, ask ChatGPT to render the saved project; ChatGPT triggers the GitHub workflow using the connected GitHub app.

## Cloudflare Pages deployment

Connect `addvaluewithai-hub/runactions` to Cloudflare Pages with:

- Production branch: `main`
- Root directory: repository root
- Build command: `bash scripts/build-fablecut-pages.sh`
- Build output directory: `dist`

The build fetches the pinned FableCut commit, injects the QServe Pages bridge before `app.js`, copies the Rooftop seed timeline, built-in FableCut libraries, and lightweight browser proxy media.

Open Rooftop after deploy with:

`/?project=rooftop-7000`

## Required R2 binding

Create one R2 bucket (for example `qserve-video-editor`) and bind it to the Pages project as:

`QSERVE_PROJECTS`

The Pages Functions use that binding for:

- `projects/<slug>/project.json` — latest shared FableCut project revision
- `media/<slug>/...` — media imported/replaced from the browser

No GitHub secret is required by Cloudflare.

## Security

The write APIs are same-origin only, but the editor should still be private. Protect the Pages site with **Cloudflare Access** before using it with production projects.

## Browser / render workflow

1. Edit in FableCut on Pages.
2. FableCut saves the project through `PUT /api/project?project=<slug>` to R2 with revision conflict protection.
3. Imported/replaced media is uploaded to R2 through `/api/upload` or `/api/import-url`.
4. When the edit is final, tell ChatGPT: `Render rooftop-7000`.
5. ChatGPT triggers `.github/workflows/render-fablecut.yml` and supplies the saved Cloudflare project URL.
6. GitHub Actions downloads production originals for known QServe assets, fetches user-imported media from the editor origin, converts the FableCut timeline to the QServe production plan, renders, runs QA, and uploads the final artifact.

## Local build smoke test

```bash
bash scripts/build-fablecut-pages.sh
npx wrangler pages dev dist --r2=QSERVE_PROJECTS
```

Without Wrangler/R2, you can still inspect the generated static FableCut bundle under `dist/`, but shared save/upload requires the R2 binding.

## Current Rooftop seed

The seed project is `fablecut/projects/rooftop-7000/project.json`. Browser preview uses lightweight proxies; production rendering resolves the known presenter/product/QR/mockup assets through `fablecut/projects/rooftop-7000/manifest.json`.
