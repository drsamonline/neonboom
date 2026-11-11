#!/usr/bin/env node
/* =========================================================================
   NEONBOOM · scripts/build-pack.mjs
   Renders the 27 procedural loops with the app's own synth (in headless
   Chromium) and writes them to pack/neonboom-pack-v1.zip as mono 16-bit WAVs
   plus a manifest.

   The pack is an OPTIONAL side asset: dist/neonboom.html stays self-contained,
   and the app falls back to synthesising when the pack is absent.

     node scripts/build-pack.mjs
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/chromium';
const OUT = path.join(ROOT, 'pack', 'neonboom-pack-v1.zip');

/* ------------------------------------------------------------------ zip */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};

function zipStore(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);           // store
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBytes, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(0, 30);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt16LE(0, 38);
    cd.writeUInt32LE(0, 40);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/* ------------------------------------------------------------- render */
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'load' });
await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
await page.waitForFunction('window.NEONBOOM.Library.items.size === 27', { timeout: 60000 });

const payload = await page.evaluate(async () => {
  const NB = window.NEONBOOM;
  const toB64 = (buf) => new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.readAsDataURL(new Blob([buf]));
  });

  const loops = NB.Library.list().filter((s) => s.id.startsWith('loop_'));
  const files = [];
  for (const s of loops) {
    /* mono: every generator is mono-compatible, and the loop cache already
       stores one channel — the pack follows the same rule */
    const src = s.buffer;
    const ch = src.getChannelData(0);

    /* Trim the decay tail. The generators render a ring-out past the musical
       length; keeping it costs bytes in every pack for sound nobody hears
       after the clip boundary. Keep 0.35 s past the musical end, and never
       cut into a sample that is still above -54 dB. */
    const spb = 60 / 90;                       // REF_BPM
    const musicalEnd = Math.min(src.length, Math.ceil((s.beats * spb + 0.35) * src.sampleRate));
    let last = musicalEnd;
    for (let i = src.length - 1; i >= musicalEnd; i--) {
      if (Math.abs(ch[i]) > 0.002) { last = Math.min(src.length, i + 1); break; }
      last = musicalEnd;
    }
    const keep = Math.max(Math.ceil(src.sampleRate * 0.2), last);

    const mono = new AudioBuffer({ numberOfChannels: 1, length: keep, sampleRate: src.sampleRate });
    mono.copyToChannel(ch.subarray(0, keep), 0);
    const blob = NB.Wav.encodeWAV(mono);
    const ab = await blob.arrayBuffer();
    files.push({
      fn: s.id.replace('loop_', ''),
      name: s.name,
      category: s.category,
      beats: s.beats,
      b64: await toB64(ab),
    });
  }
  return { synthVersion: NB.project.SYNTH_VERSION, files };
});
await browser.close();

/* ---------------------------------------------------------------- write */
const entries = [];
const manifest = {
  format: 'neonboom-pack',
  version: 1,
  synthVersion: payload.synthVersion,
  refBpm: 90,
  generated: new Date().toISOString(),
  note: 'Rendered by NEONBOOM itself. Mono 16-bit WAV at 44.1 kHz. Optional asset — the app synthesises these loops when the pack is absent.',
  loops: [],
};

for (const f of payload.files) {
  const data = Buffer.from(f.b64, 'base64');
  const file = `loops/${f.fn}.wav`;
  entries.push({ name: file, data });
  manifest.loops.push({ id: 'loop_' + f.fn, name: f.name, category: f.category, beats: f.beats, file, bytes: data.length });
}

entries.unshift({ name: 'pack.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const zip = zipStore(entries);
fs.writeFileSync(OUT, zip);

const mb = (zip.length / 1048576).toFixed(1);
console.log(`built pack/neonboom-pack-v1.zip — ${payload.files.length} loops, ${mb} MB`);
