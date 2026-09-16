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

const browser = await chromium.launch({
  headless: false,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--use-gl=swiftshader',
  ],
});

const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
page.on('console', msg => console.log(`[browser:${msg.type()}] ${msg.text()}`));
page.on('pageerror', err => console.error(`[browser:error] ${err.stack || err.message}`));

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

  // Give video/image metadata a moment to settle before composition begins.
  await page.waitForTimeout(3000);
  console.log('Project loaded:', await page.locator('#projectName').textContent());

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
  while (Date.now() - started < timeoutMs) {
    const hidden = await page.locator('#exportOverlay').evaluate(el => el.classList.contains('hidden'));
    const pct = await page.locator('#exportProgress').evaluate(el => el.style.width || '');
    if (pct && pct !== lastPct) {
      console.log(`Export progress ${pct}`);
      lastPct = pct;
    }
    if (hidden) break;
    await page.waitForTimeout(2000);
  }

  const stillOpen = await page.locator('#exportOverlay').evaluate(el => !el.classList.contains('hidden'));
  if (stillOpen) throw new Error(`FableCut export timed out after ${Math.round(timeoutMs / 60000)} minutes`);

  // The stock server writes the finished export to DATA_DIR/exports. Wait until
  // a new non-part file appears and its size is stable before copying it.
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
  if (!candidate) throw new Error(`No finished FableCut export appeared in ${exportsDir}`);

  fs.copyFileSync(candidate.path, output);
  console.log(`Copied ${candidate.path} -> ${output} (${fs.statSync(output).size} bytes)`);
} finally {
  await browser.close();
}
