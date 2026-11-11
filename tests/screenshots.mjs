import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'img');
fs.mkdirSync(OUT, { recursive: true });
const URL = 'file://' + path.join(ROOT, 'index.html');

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium', headless: 'shell',
  args: ['--no-sandbox', '--mute-audio', '--force-color-profile=srgb', '--font-render-hinting=none'],
});

async function shot(name, w, h, mobile, setup) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 700));
  if (setup) await page.evaluate(setup);
  await new Promise((r) => setTimeout(r, 550));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  if (errs.length) console.log(name, 'ERR', errs);
  console.log('shot', name);
  await page.close();
}

/* 1. desktop hero: arrangement + selected clip + mixer */
await shot('desktop', 1440, 900, false, () => {
  const NB = window.NEONBOOM;
  NB.Timeline.select(NB.Project.tracks[3].clips[0].id);
  NB.Shell.openDrawer('mixer');
  NB.Timeline.zoomFit();
});

/* 2. desktop, pads + fx rack */
await shot('pads-fx', 1440, 900, false, () => {
  const NB = window.NEONBOOM;
  NB.Shell.openDrawer('fx');
  NB.Timeline.select(NB.Project.tracks[0].clips[0].id);
});

/* 3. desktop, inspector focus on a clip + export pane */
await shot('inspector', 1280, 800, false, () => {
  const NB = window.NEONBOOM;
  const clip = NB.Project.tracks[4].clips[0];
  clip.pitch = 3; clip.fadeIn = 4; clip.fadeOut = 6;      // show the sound panel
  NB.Project.swing = 0.18;
  NB.Timeline.select(clip.id);
  NB.Timeline.zoom = 1.1;
  NB.Timeline.resize();
  NB.Timeline.viewport.scrollLeft = 0;
  NB.Shell.openDrawer('mixer');
});

/* 4. phone: pads */
await shot('phone-pads', 390, 844, true, () => {
  const NB = window.NEONBOOM;
  NB.Pads.filter = 'Drums';
  NB.Pads.renderChips(); NB.Pads.render();
});

/* 5. phone: arrangement */
await shot('phone-arrange', 390, 844, true, () => {
  const NB = window.NEONBOOM;
  document.querySelector('#tabbar button[data-view="arrange"]').click();
  setTimeout(() => { NB.Timeline.zoomFit(); NB.Timeline.select(NB.Project.tracks[0].clips[0].id); }, 120);
});

/* 6. phone: mixer drawer */
await shot('phone-mixer', 390, 844, true, () => {
  const NB = window.NEONBOOM;
  document.querySelector('#tabbar button[data-view="mixer"]').click();
});

/* 7. tablet */
await shot('tablet', 834, 1112, true, () => {
  const NB = window.NEONBOOM;
  document.querySelector('#tabbar button[data-view="arrange"]').click();
  setTimeout(() => NB.Timeline.zoomFit(), 150);
});

await browser.close();
console.log('done');
