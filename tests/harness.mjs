/* =========================================================================
   NEONBOOM · tests/harness.mjs
   Shared headless-Chromium harness: browser lifecycle, page opener, assertion
   counter. Imported by tests/run.mjs (core) and tests/extended.mjs (features).
   ========================================================================= */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP = 'file://' + path.join(ROOT, 'index.html');
export const STANDALONE = 'file://' + path.join(ROOT, 'dist', 'neonboom.html');
export const CHROME = process.env.CHROME_PATH || '/usr/local/bin/chromium';

export let pass = 0, fail = 0;
export const failures = [];
export function check(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++; failures.push(name + (extra !== undefined ? ` (got ${JSON.stringify(extra)})` : ''));
  console.log('  ✗ ' + name + (extra !== undefined ? `  got ${JSON.stringify(extra)}` : ''));
}

const launch = () => puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-gl=swiftshader'],
});

let browser = await launch();
export { browser };

/* 27 rendered loops per page is ~15 MB of AudioBuffers; after a dozen pages the
   renderer starts dying on a 2 GB pod. Restart the browser between blocks. */
export async function restart() {
  try { await browser.close(); } catch (e) {}
  browser = await launch();
}

/* Each section gets its own browser context (same-origin IndexedDB would leak
   one test's project into the next). The browser itself is restarted between
   blocks — a dozen pages of rendered loops exhausts a 2 GB pod. */
export async function open(url, { w = 1440, h = 900, mobile = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.__ctx = context;
  await page.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('nb-onboarded', '1'); } catch (e) {}
  });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
  const bootMs = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 500));
  return { page, errors, bootMs, context };
}


export async function summary() {
  try { await browser.close(); } catch (e) {}
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`  ${pass} passed · ${fail} failed · ${pass + fail} assertions`);
  if (fail) {
    console.log('\n  failures:');
    failures.forEach((f) => console.log('   - ' + f));
    process.exitCode = 1;
  } else {
    console.log('  all green');
  }
}
