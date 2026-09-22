#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const [dataDirArg, outArg, profileArg = 'delivery'] = process.argv.slice(2);
if (!dataDirArg || !outArg) {
  console.error('usage: node scripts/run_fablecut_native_export.mjs <fablecut-data-dir> <output-file> [profile]');
  process.exit(2);
}

const dataDir = path.resolve(dataDirArg);
const outFile = path.resolve(outArg);
const exportsDir = path.join(dataDir, 'exports');
const baseUrl = process.env.FABLECUT_URL || 'http://127.0.0.1:7777';
const timeoutMs = Number(process.env.FABLECUT_EXPORT_TIMEOUT_MS || 15 * 60 * 1000);

fs.mkdirSync(exportsDir, { recursive: true });
fs.mkdirSync(path.dirname(outFile), { recursive: true });
for (const name of fs.readdirSync(exportsDir)) {
  fs.rmSync(path.join(exportsDir, name), { recursive: true, force: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finishedExports() {
  if (!fs.existsSync(exportsDir)) return [];
  return fs.readdirSync(exportsDir)
    .map((name) => ({ name, file: path.join(exportsDir, name) }))
    .filter(({ name, file }) => !name.includes('.part') && fs.statSync(file).isFile())
    .sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-dev-shm-usage',
    '--no-sandbox',
  ],
});

let page;
let fatalDialog = null;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => console.error(`[browser:error] ${err.stack || err.message || err}`));
  page.on('dialog', async (dialog) => {
    const message = dialog.message();
    console.error(`[browser:dialog:${dialog.type()}] ${message}`);
    if (/export failed:/i.test(message)) fatalDialog = message;
    try { await dialog.dismiss(); } catch {}
  });

  console.log(`Opening native FableCut at ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#btnExport', { state: 'visible', timeout: 60_000 });

  await page.waitForFunction(async () => {
    try {
      const r = await fetch('/api/export/ffmpeg', { cache: 'no-store' });
      const body = await r.json();
      return !!body.available;
    } catch {
      return false;
    }
  }, null, { timeout: 30_000 });

  const projectInfo = await page.evaluate(async () => {
    const r = await fetch('/api/project', { cache: 'no-store' });
    const p = await r.json();
    return {
      name: p.name,
      revision: p.revision,
      width: p.width,
      height: p.height,
      fps: p.fps,
      clips: Array.isArray(p.clips) ? p.clips.length : 0,
      media: Array.isArray(p.media) ? p.media.length : 0,
    };
  });
  console.log('Loaded canonical project:', JSON.stringify(projectInfo));

  await page.click('#btnExport');
  await page.waitForSelector('#exportSetup:not(.hidden)', { timeout: 15_000 });
  await page.selectOption('#exportRangeSel', 'entire');

  await page.waitForFunction(() => {
    const el = document.querySelector('#engineFast');
    return !!el && !el.disabled;
  }, null, { timeout: 15_000 });
  await page.check('#engineFast');

  await page.waitForFunction(() => {
    const s = document.querySelector('#exportProfileSel');
    return !!s && s.options.length > 0;
  }, null, { timeout: 15_000 });

  const availableProfiles = await page.locator('#exportProfileSel option').evaluateAll(
    (opts) => opts.map((o) => ({ value: o.value, text: o.textContent }))
  );
  console.log('Available encoding profiles:', JSON.stringify(availableProfiles));
  if (!availableProfiles.some((p) => p.value === profileArg)) {
    throw new Error(`Requested FableCut encoding profile is unavailable: ${profileArg}`);
  }
  await page.selectOption('#exportProfileSel', profileArg);

  console.log(`Starting native FableCut Fast export with profile=${profileArg}`);
  await page.click('#btnStartExport');
  await page.waitForSelector('#exportOverlay:not(.hidden)', { timeout: 15_000 });

  const started = Date.now();
  let lastProgress = '';
  let finished = null;
  while (Date.now() - started < timeoutMs) {
    if (fatalDialog) throw new Error(fatalDialog);

    const exports = finishedExports();
    if (exports.length) {
      finished = exports[0].file;
      break;
    }

    const status = await page.evaluate(() => ({
      title: document.querySelector('#exportTitle')?.textContent || '',
      note: document.querySelector('#exportNote')?.textContent || '',
      progress: document.querySelector('#exportProgress')?.style?.width || '',
      hidden: document.querySelector('#exportOverlay')?.classList.contains('hidden') ?? true,
    })).catch(() => ({ title: '', note: '', progress: '', hidden: false }));

    const progressKey = `${status.progress}|${status.title}|${status.note}|${status.hidden}`;
    if (progressKey !== lastProgress) {
      console.log(`Export status: ${status.progress || '?'} ${status.title} ${status.note} overlay=${status.hidden ? 'hidden' : 'visible'}`.trim());
      lastProgress = progressKey;
    }

    if (status.hidden && Date.now() - started > 5_000) {
      await sleep(750);
      if (fatalDialog) throw new Error(fatalDialog);
      const exportsAfterClose = finishedExports();
      if (exportsAfterClose.length) {
        finished = exportsAfterClose[0].file;
        break;
      }
      throw new Error(`Native FableCut export closed without producing a file. Last UI state: ${status.title} / ${status.note}`);
    }
    await sleep(500);
  }

  if (!finished) {
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for native FableCut export`);
  }

  // Wait for the final rename/write to settle before copying the artifact.
  let previous = -1;
  for (let i = 0; i < 20; i++) {
    const size = fs.statSync(finished).size;
    if (size > 0 && size === previous) break;
    previous = size;
    await sleep(250);
  }

  fs.copyFileSync(finished, outFile);
  const stat = fs.statSync(outFile);
  console.log(`Native FableCut export complete: ${finished} -> ${outFile} (${stat.size} bytes)`);
} catch (err) {
  if (page) {
    try {
      const diagnostic = path.join(path.dirname(outFile), 'fablecut-native-export-failure.png');
      await page.screenshot({ path: diagnostic, fullPage: true });
      console.error(`Saved failure screenshot: ${diagnostic}`);
    } catch {}
  }
  throw err;
} finally {
  await browser.close();
}
