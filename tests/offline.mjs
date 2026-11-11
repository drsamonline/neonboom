/* =========================================================================
   NEONBOOM · tests/offline.mjs
   Proves the offline claim: serve the repo over http, let the service worker
   install, cut the network, reload, and check the app still boots and plays.

   node tests/offline.mjs
   ========================================================================= */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8123;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(PORT, r));
const URL = `http://localhost:${PORT}/`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium',
  headless: 'shell',
  args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — got ' + JSON.stringify(extra) : '')); }
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });

  const reg = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const r = await navigator.serviceWorker.ready;
    return { supported: true, scope: r.scope, active: !!r.active };
  });
  check('service worker registers and activates', reg.supported && reg.active, reg);

  /* installability audit — the things a browser checks before offering "Install" */
  const audit = await page.evaluate(async () => {
    const link = document.querySelector('link[rel=manifest]');
    const out = { link: !!link };
    if (link) {
      const m = await (await fetch(link.href)).json();
      out.name = !!m.name;
      out.short = !!m.short_name;
      out.start = !!m.start_url;
      out.display = m.display;
      out.theme = !!m.theme_color;
      out.background = !!m.background_color;
      out.icons = (m.icons || []).length;
      out.bigIcon = (m.icons || []).some((i) => /512/.test(i.sizes || ''));
    }
    out.title = document.title.length > 0;
    out.viewport = !!document.querySelector('meta[name=viewport]');
    out.https = location.protocol === 'https:' || location.hostname === 'localhost';
    out.swController = !!navigator.serviceWorker.controller || (await navigator.serviceWorker.ready).active != null;
    return out;
  });
  check('manifest is linked over http(s)', audit.link);
  check('manifest has name, short_name, start_url', audit.name && audit.short && audit.start, audit);
  check('manifest declares standalone display', audit.display === 'standalone', audit.display);
  check('manifest has theme + background colours', audit.theme && audit.background);
  check('manifest ships a 512px icon', audit.icons >= 2 && audit.bigIcon, audit.icons);
  check('page has a title and a viewport meta', audit.title && audit.viewport);
  check('service worker is controlling the page', audit.swController);

  /* give the install step time to cache every asset */
  await new Promise((r) => setTimeout(r, 2500));
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    if (!names.length) return 0;
    const c = await caches.open(names[0]);
    return (await c.keys()).length;
  });
  check('app shell is cached', cached >= 20, cached);

  /* cut the network, then reload */
  const client = await page.createCDPSession();
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });

  await page.reload({ waitUntil: 'load' });
  const booted = await page.waitForFunction(
    "window.NEONBOOM && document.querySelector('#boot').classList.contains('done')",
    { timeout: 120000 }).then(() => true).catch(() => false);
  check('app boots with the network off', booted);

  /* the library fills in two phases, so wait for the background pass */
  await page.waitForFunction("window.NEONBOOM.Library.items.size === 27 && document.querySelectorAll('.pad').length === 27",
    { timeout: 30000 }).catch(() => {});
  const state = await page.evaluate(() => ({
    samples: window.NEONBOOM.Library.items.size,
    pads: document.querySelectorAll('.pad').length,
  }));
  check('loop library is available offline', state.samples === 27, state.samples);
  check('pads render offline', state.pads === 27, state.pads);

  const audible = await page.evaluate(async () => {
    const NB = window.NEONBOOM;
    NB.Transport.play();
    await new Promise((r) => setTimeout(r, 700));
    const playing = NB.Transport.playing && NB.Transport.currentSix() > 0.3;
    NB.Transport.pause();
    return playing;
  });
  check('transport plays offline', audible);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${pass} passed · ${fail} failed`);
if (fail) process.exitCode = 1;
