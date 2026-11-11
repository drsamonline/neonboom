/* =========================================================================
   NEONBOOM · tests/layout.mjs
   Layout regression without pixel diffing: capture the geometry of the pieces
   that matter at three viewports and compare them against a committed
   baseline. Catches "the transport wrapped", "the timeline lost its width",
   "a panel disappeared" — the failures a screenshot review misses.

     node tests/layout.mjs            # check
     node tests/layout.mjs --update   # rewrite the baseline (review the diff!)
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'file://' + path.join(ROOT, 'index.html');
const BASELINE = path.join(ROOT, 'tests', 'layout-baseline.json');
const UPDATE = process.argv.includes('--update');
const TOLERANCE = 4;          // px, absorbs font/AA differences between machines

const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900, mobile: false },
  { name: 'tablet', w: 834, h: 1112, mobile: true },
  { name: 'phone', w: 390, h: 844, mobile: true },
];

const SELECTORS = [
  '#topbar', '#padPanel', '#arrange', '#inspector', '#tabbar', '#drawer',
  '#padGrid', '.pad', '#ruler', '#tlViewport', '#trackHeads', '.trackHead',
  '.drawerTabs', '#statusbar', '#transport', '.transport', '.lcd', '#btnPlay',
];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium',
  headless: 'shell',
  args: ['--no-sandbox', '--mute-audio'],
});

const measured = {};

for (const vp of VIEWPORTS) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: vp.w, height: vp.h, isMobile: vp.mobile, hasTouch: vp.mobile });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('nb-onboarded', '1'); } catch (e) {}
  });
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 600));

  /* on phones/tablets the arrange view is behind a tab — measure it too */
  if (vp.mobile) {
    await page.evaluate(() => {
      const tab = document.querySelector('#tabbar button[data-view="arrange"]');
      if (tab) tab.click();
    });
    await new Promise((r) => setTimeout(r, 450));
  }

  measured[vp.name] = await page.evaluate((sels) => {
    const out = { viewport: [window.innerWidth, window.innerHeight] };
    sels.forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) { out[sel] = null; return; }
      const r = el.getBoundingClientRect();
      const shown = r.width > 0 && r.height > 0;
      out[sel] = shown ? [Math.round(r.width), Math.round(r.height)] : 'hidden';
    });
    out.overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
    out.canvasPainted = (() => {
      const T = window.NEONBOOM && window.NEONBOOM.Timeline;
      if (!T || !T.ctx) return null;
      try { return T.ctx.getImageData(2, 2, 1, 1).data[3] > 0; } catch (e) { return null; }
    })();
    return out;
  }, SELECTORS);

  await page.close();
  await context.close();
}
await browser.close();

/* ---------------------------------------------------------------- compare */
let failures = 0;
const report = [];

for (const vp of VIEWPORTS) {
  const now = measured[vp.name];
  const was = (UPDATE || !fs.existsSync(BASELINE)) ? null : JSON.parse(fs.readFileSync(BASELINE, 'utf8'))[vp.name];
  if (!was) continue;

  for (const key of Object.keys(now)) {
    if (key === 'viewport') continue;
    const a = now[key], b = was[key];
    if (a === 'hidden' && b === 'hidden') continue;
    if (a === 'hidden' || b === 'hidden' || a === null || b === null) {
      if (a !== b) { failures++; report.push(`${vp.name} ${key}: ${JSON.stringify(b)} → ${JSON.stringify(a)}`); }
      continue;
    }
    const dw = Math.abs(a[0] - b[0]), dh = Math.abs(a[1] - b[1]);
    if (dw > TOLERANCE || dh > TOLERANCE) {
      failures++;
      report.push(`${vp.name} ${key}: ${b[0]}×${b[1]} → ${a[0]}×${a[1]}`);
    }
  }
  if (now.overflowX && !was.overflowX) { failures++; report.push(`${vp.name}: horizontal overflow appeared`); }
}

if (UPDATE || !fs.existsSync(BASELINE)) {
  fs.writeFileSync(BASELINE, JSON.stringify(measured, null, 2) + '\n');
  console.log(`baseline written → tests/layout-baseline.json (${VIEWPORTS.length} viewports)`);
  process.exit(0);
}

if (failures) {
  console.log(`✗ ${failures} layout change${failures > 1 ? 's' : ''}:`);
  report.forEach((r) => console.log('   ' + r));
  console.log('\nIf the change is intended: node tests/layout.mjs --update, then review the diff.');
  process.exitCode = 1;
} else {
  console.log(`✓ layout matches the baseline across ${VIEWPORTS.length} viewports`);
}
