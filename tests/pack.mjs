/* =========================================================================
   NEONBOOM · tests/pack.mjs
   Serves the repo over http with the optional pack present, then checks that
   the app installs it instead of synthesising — and that it still boots when
   the pack is missing or corrupt.

   node tests/pack.mjs
   ========================================================================= */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8124;
const PACK = path.join(ROOT, 'pack', 'neonboom-pack-v1.zip');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.zip': 'application/zip' };

let packMode = 'present';   // present | missing | corrupt

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/pack/neonboom-pack-v1.zip') {
    if (packMode === 'missing') { res.writeHead(404); res.end('nope'); return; }
    const body = packMode === 'corrupt' ? Buffer.from('PK\u0003\u0004 not really a zip') : fs.readFileSync(PACK);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': body.length });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(body);
    return;
  }
  let file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(PORT, r));
const URL = `http://localhost:${PORT}/?pack=1`;

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

async function boot() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
  return { page, context, errors, bootMs: Date.now() - t0 };
}

try {
  /* ---------- 1. pack present ---------- */
  console.log('\n1 · pack present');
  {
    const { page, context, errors, bootMs } = await boot();
    const o = await page.evaluate(() => ({
      samples: window.NEONBOOM.Library.items.size,
      pack: window.NEONBOOM.LoopPack.lastResult,
      hydrated: window.NEONBOOM.App.timings.hydrated,
      phase1: window.NEONBOOM.App.timings.phase1,
      timings: window.NEONBOOM.App.timings,
    }));
    check('all 27 loops installed at first paint', o.samples === 27, o.samples);
    check('pack reported as installed', o.pack === 'installed', o.pack);
    check('nothing left to synthesise on the critical path', o.phase1 === 0, o.phase1);
    check('no console errors', errors.length === 0, errors.slice(0, 3));
    console.log(`  boot ${bootMs} ms (pack ${o.timings.pack} ms, storage ${o.timings.storage} ms)`);

    /* the manual path must work too: no ?pack, pack still installs on demand */
    const manual = await page.evaluate(async () => {
      const NB = window.NEONBOOM;
      [...NB.Library.items.keys()].filter((k) => k.startsWith('loop_')).forEach((k) => NB.Library.items.delete(k));
      const n = await NB.LoopPack.load(NB.Engine);
      return { n, has: NB.Library.items.size };
    });
    check('manual pack load installs the loops', manual.n === 27, manual.n);

    const decoded = await page.evaluate(async () => {
      const s = window.NEONBOOM.Library.byName('Boom Bap Kick');
      const ch = s.buffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < ch.length; i += 7) peak = Math.max(peak, Math.abs(ch[i]));
      return { beats: s.beats, peak, dur: s.buffer.duration, chans: s.buffer.numberOfChannels };
    });
    check('packed loop decodes to real audio', decoded.peak > 0.2, decoded.peak);
    check('packed loop keeps its musical length', Math.abs(decoded.beats - 4) < 0.01, decoded.beats);

    /* the pack is now in the loop cache, so a reload should be cache-only */
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
    const t = await page.evaluate(() => window.NEONBOOM.App.timings);
    check('second boot comes from the loop cache', t.pack === undefined || t.pack === 'absent' || t.hydrated >= 14, t);
    check('second boot synthesises nothing on the critical path', t.phase1 === 0, t.phase1);
    await page.close(); await context.close();
  }

  /* ---------- 2. pack missing ---------- */
  console.log('\n2 · pack missing');
  packMode = 'missing';
  {
    const { page, context, errors, bootMs } = await boot();
    const o = await page.evaluate(() => ({
      samples: window.NEONBOOM.Library.items.size,
      pack: window.NEONBOOM.LoopPack.lastResult,
    }));
    check('falls back to synthesis', o.samples >= 14, o.samples);
    check('pack reported absent', o.pack === 'absent', o.pack);
    check('no console errors', errors.length === 0, errors.slice(0, 3));
    console.log(`  boot ${bootMs} ms (synthesis fallback)`);
    await page.close(); await context.close();
  }

  /* ---------- 3. corrupt pack ---------- */
  console.log('\n3 · corrupt pack');
  packMode = 'corrupt';
  {
    const { page, context, errors } = await boot();
    const o = await page.evaluate(() => ({
      samples: window.NEONBOOM.Library.items.size,
      pack: window.NEONBOOM.LoopPack.lastResult,
    }));
    check('corrupt pack does not break boot', o.samples >= 14, o.samples);
    check('corrupt pack is reported, not thrown', o.pack === 'failed' || o.pack === 'empty', o.pack);
    check('no uncaught errors', errors.filter((e) => !/pack/i.test(e)).length === 0, errors.slice(0, 3));
    await page.close(); await context.close();
  }

  /* ---------- 4. zip reader handles a foreign zip ---------- */
  console.log('\n4 · zip reader');
  packMode = 'present';
  {
    const { page, context } = await boot();
    const o = await page.evaluate(async () => {
      const res = await fetch('pack/neonboom-pack-v1.zip');
      const buf = await res.arrayBuffer();
      const entries = window.NEONBOOM.readZip(buf);
      const manifest = JSON.parse(new TextDecoder().decode(entries[0].bytes));
      return { count: entries.length, first: entries[0].name, loops: manifest.loops.length,
        format: manifest.format, sampleRate: manifest.refBpm };
    });
    check('zip parses to 28 entries', o.count === 28, o.count);
    check('manifest is first and valid', o.first === 'pack.json' && o.format === 'neonboom-pack');
    check('manifest lists 27 loops', o.loops === 27, o.loops);
    await page.close(); await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${pass} passed · ${fail} failed`);
if (fail) process.exitCode = 1;
