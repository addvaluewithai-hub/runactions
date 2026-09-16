import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => {
  if (!v.startsWith('--')) return [null, null];
  const key = v.slice(2);
  const next = a[i + 1];
  return [key, next && !next.startsWith('--') ? next : 'true'];
}).filter(([k]) => k));

const url = args.url || 'http://127.0.0.1:7777';
const exportsDir = path.resolve(args.exports || 'fablecut-data/exports');
const output = path.resolve(args.out || 'render/fablecut.mp4');
const expectedName = args.name || '';
const timeoutMs = Number(args.timeout || 30 * 60 * 1000);

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(exportsDir, { recursive: true });
const before = new Set(fs.readdirSync(exportsDir));

// Playwright's bundled Linux Chromium intentionally does not ship all proprietary
// media codecs. QServe source media is H.264/AAC, so CI must drive the system
// Google Chrome build (channel=chrome) instead. This is the same browser family
// users run the editor in, but with the codecs required by real MP4 sources.
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--use-gl=swiftshader',
    '--disable-background-media-suspend',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});

const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
const dialogs = [];
const failedResponses = [];
page.on('console', msg => console.log(`[browser:${msg.type()}] ${msg.text()}`));
page.on('pageerror', err => console.error(`[browser:error] ${err.stack || err.message}`));
page.on('requestfailed', req => {
  const failure = req.failure()?.errorText || 'request failed';
  console.error(`[network:failed] ${req.method()} ${req.url()} — ${failure}`);
});
page.on('response', res => {
  if (res.status() >= 400) {
    const row = `${res.status()} ${res.request().method()} ${res.url()}`;
    failedResponses.push(row);
    console.error(`[network:http] ${row}`);
  }
});
page.on('dialog', async dialog => {
  const row = `${dialog.type()}: ${dialog.message()}`;
  dialogs.push(row);
  console.error(`[browser:dialog] ${row}`);
  try { await dialog.dismiss(); } catch {}
});

async function prewarmMedia() {
  return page.evaluate(async () => {
    if (typeof runtime === 'undefined' || typeof project === 'undefined') {
      return { ok: false, reason: 'FableCut runtime/project globals unavailable', rows: [] };
    }

    const waitEvent = (el, event, timeout = 8000) => new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        el.removeEventListener(event, onEvent);
        clearTimeout(timer);
        resolve(value);
      };
      const onEvent = () => finish(true);
      const timer = setTimeout(() => finish(false), timeout);
      el.addEventListener(event, onEvent, { once: true });
    });
    const waitPresented = (el, timeout = 2500) => new Promise(resolve => {
      if (typeof el.requestVideoFrameCallback !== 'function') {
        resolve(true);
        return;
      }
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; resolve(false); }
      }, timeout);
      el.requestVideoFrameCallback(() => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(true);
        }
      });
    });

    const rows = [];
    const clips = project.clips || [];
    for (const clip of clips) {
      if (clip.kind !== 'video') continue;
      const el = runtime.clipEls.get(clip.id);
      if (!(el instanceof HTMLVideoElement)) {
        rows.push({ clip: clip.id, ok: false, reason: 'no video element' });
        continue;
      }

      el.preload = 'auto';
      el.muted = true;
      try { el.pause(); } catch {}
      if (el.readyState < 2) {
        try { el.load(); } catch {}
        await waitEvent(el, 'loadeddata', 8000);
      }
      if (el.error || el.readyState < 2) {
        rows.push({
          clip: clip.id,
          src: el.currentSrc || el.src,
          readyState: el.readyState,
          error: el.error?.message || el.error?.code || 'media did not load',
          ok: false,
        });
        continue;
      }

      const duration = Number.isFinite(el.duration) ? el.duration : 0;
      const requested = Math.max(0, Number(clip.in) || 0);
      const target = duration > 0 ? Math.min(requested, Math.max(0, duration - 0.05)) : requested;
      let seeked = true;
      if (Math.abs((el.currentTime || 0) - target) > 0.035) {
        seeked = false;
        const waiter = waitEvent(el, 'seeked', 8000);
        try { el.currentTime = target; } catch {}
        seeked = await waiter;
      }
      const presented = seeked ? await waitPresented(el, 2500) : false;
      rows.push({
        clip: clip.id,
        target,
        readyState: el.readyState,
        seeked,
        presented,
        currentTime: el.currentTime,
        src: el.currentSrc || el.src,
        ok: el.readyState >= 2 && seeked,
      });
    }
    return { ok: rows.every(r => r.ok), rows };
  });
}

try {
  console.log(`Opening ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#projectName', { timeout: 60000 });
  await page.waitForFunction(
    name => {
      const text = document.getElementById('projectName')?.textContent || '';
      return name ? text.includes(name) : text !== 'Untitled Project';
    },
    expectedName,
    { timeout: 120000 },
  );

  const browserInfo = await page.evaluate(() => {
    const v = document.createElement('video');
    return {
      ua: navigator.userAgent,
      h264: v.canPlayType('video/mp4; codecs="avc1.640028"'),
      aac: v.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
    };
  });
  console.log('[browser-codecs]', JSON.stringify(browserInfo));
  if (!browserInfo.h264) {
    throw new Error(`Browser has no H.264 decode support: ${JSON.stringify(browserInfo)}`);
  }

  await page.waitForTimeout(2500);
  console.log('Project loaded:', await page.locator('#projectName').textContent());

  const mediaHealth = await page.evaluate(() => {
    const bad = [];
    if (typeof runtime === 'undefined') return [{ id: '__runtime__', error: 'runtime unavailable' }];
    for (const [id, el] of runtime.clipEls) {
      if (el instanceof HTMLMediaElement && (el.error || el.readyState === 0)) {
        bad.push({ id, src: el.currentSrc || el.src, readyState: el.readyState, error: el.error?.message || el.error?.code || null });
      }
    }
    return bad;
  }).catch(err => [{ id: '__health__', error: String(err) }]);
  if (mediaHealth.length) console.error('[media-health]', JSON.stringify(mediaHealth));

  console.log('Prewarming video decoders at each clip source-in...');
  const prewarm = await prewarmMedia();
  console.log('[media-prewarm]', JSON.stringify(prewarm));
  if (!prewarm.ok) {
    const failed = prewarm.rows?.filter(r => !r.ok) || [];
    throw new Error(`Media prewarm failed: ${JSON.stringify(failed)}`);
  }

  await page.click('#btnExport');
  await page.waitForFunction(() => !document.getElementById('exportSetup')?.classList.contains('hidden'), null, { timeout: 30000 });

  const fast = page.locator('#engineFast');
  if (await fast.isDisabled()) throw new Error('FableCut Fast export is unavailable; ffmpeg server was not detected.');
  await fast.check();
  console.log('Starting FableCut Fast export');
  await page.click('#btnStartExport');

  await page.waitForFunction(() => !document.getElementById('exportOverlay')?.classList.contains('hidden'), null, { timeout: 30000 });

  const started = Date.now();
  let lastPct = '';
  let lastTitle = '';
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(() => ({
      hidden: document.getElementById('exportOverlay')?.classList.contains('hidden'),
      pct: document.getElementById('exportProgress')?.style.width || '',
      title: document.getElementById('exportTitle')?.textContent || '',
      note: document.getElementById('exportNote')?.textContent || '',
    }));
    if (state.title !== lastTitle) {
      console.log(`Export state: ${state.title}${state.note ? ` — ${state.note}` : ''}`);
      lastTitle = state.title;
    }
    if (state.pct && state.pct !== lastPct) {
      console.log(`Export progress ${state.pct}`);
      lastPct = state.pct;
    }
    if (state.hidden) break;
    await page.waitForTimeout(1000);
  }

  const stillOpen = await page.locator('#exportOverlay').evaluate(el => !el.classList.contains('hidden'));
  if (stillOpen) throw new Error(`FableCut export timed out after ${Math.round(timeoutMs / 60000)} minutes`);
  if (dialogs.some(x => /Export failed:/i.test(x))) {
    throw new Error(dialogs.filter(x => /Export failed:/i.test(x)).join(' | '));
  }

  let candidate = null;
  let stable = 0;
  let lastSize = -1;
  const fileDeadline = Date.now() + 120000;
  while (Date.now() < fileDeadline) {
    const files = fs.readdirSync(exportsDir)
      .filter(f => !before.has(f) && !f.includes('.part') && /\.(mp4|mov|m4v|mkv|webm)$/i.test(f))
      .map(f => ({ name: f, path: path.join(exportsDir, f), stat: fs.statSync(path.join(exportsDir, f)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (files.length) {
      candidate = files[0];
      if (candidate.stat.size === lastSize && candidate.stat.size > 1024) stable += 1;
      else stable = 0;
      lastSize = candidate.stat.size;
      if (stable >= 2) break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!candidate) {
    const detail = [
      dialogs.length ? `dialogs=${dialogs.join(' | ')}` : '',
      failedResponses.length ? `http=${failedResponses.slice(-12).join(' | ')}` : '',
      `lastProgress=${lastPct || 'n/a'}`,
      `lastTitle=${lastTitle || 'n/a'}`,
    ].filter(Boolean).join('; ');
    throw new Error(`No finished FableCut export appeared in ${exportsDir}${detail ? `; ${detail}` : ''}`);
  }

  fs.copyFileSync(candidate.path, output);
  console.log(`Copied ${candidate.path} -> ${output} (${fs.statSync(output).size} bytes)`);
} finally {
  await browser.close();
}
