/* =========================================================================
   NEONBOOM · tests/run.mjs
   Headless Chromium harness. Boots the app (source build and the standalone
   single-file build), drives the public surface, and reports pass/fail.

   npm install && node tests/run.mjs
   ========================================================================= */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'file://' + path.join(ROOT, 'index.html');
const STANDALONE = 'file://' + path.join(ROOT, 'dist', 'neonboom.html');
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/chromium';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++; failures.push(name + (extra !== undefined ? ` (got ${JSON.stringify(extra)})` : ''));
  console.log('  ✗ ' + name + (extra !== undefined ? `  got ${JSON.stringify(extra)}` : ''));
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-gl=swiftshader'],
});

async function open(url, { w = 1440, h = 900, mobile = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
  const bootMs = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 500));
  return { page, errors, bootMs };
}

/* ---------------------------------------------------------------- 1. boot */
console.log('\n1 · boot & library');
{
  const { page, errors, bootMs } = await open(APP);
  const o = await page.evaluate(() => ({
    samples: window.NEONBOOM.Library.items.size,
    tracks: window.NEONBOOM.Project.tracks.length,
    clips: window.NEONBOOM.Project.tracks.reduce((n, t) => n + t.clips.length, 0),
    pads: document.querySelectorAll('.pad').length,
    padWaves: document.querySelectorAll('.pad canvas').length,
    veilGone: getComputedStyle(document.querySelector('#boot')).display === 'none',
  }));
  check('27 loops synthesised', o.samples === 27, o.samples);
  check('8 tracks', o.tracks === 8, o.tracks);
  check('demo arrangement loaded', o.clips > 20, o.clips);
  check('one pad per loop', o.pads === 27, o.pads);
  check('every pad has a waveform', o.padWaves === 27, o.padWaves);
  check('boot veil removed', o.veilGone);
  check('no console errors at boot', errors.length === 0, errors.slice(0, 3));
  console.log(`  boot ${bootMs} ms`);
  await page.close();
}

/* --------------------------------------------------- 2. transport & edit */
console.log('\n2 · transport, clips, undo');
{
  const { page, errors } = await open(APP);
  const o = await page.evaluate(async () => {
    const NB = window.NEONBOOM, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), o = {};
    NB.Transport.play(); await sleep(700);
    o.playing = NB.Transport.playing;
    o.advanced = NB.Transport.currentSix() > 0.4;
    o.sources = NB.Engine._activeSources.length;
    NB.Transport.pause();
    o.paused = !NB.Transport.playing;

    const t0 = NB.Project.tracks[0], n0 = t0.clips.length;
    NB.Timeline.select(t0.clips[0].id);
    NB.Timeline.duplicateSelected(); o.dup = NB.Project.tracks[0].clips.length === n0 + 1;
    NB.Timeline.deleteSelected(); o.del = NB.Project.tracks[0].clips.length === n0;
    o.undo = NB.History.undo() && NB.Project.tracks[0].clips.length === n0 + 1;
    o.redo = NB.History.redo() && NB.Project.tracks[0].clips.length === n0;

    const c = NB.Project.tracks[0].clips[0];
    NB.Timeline.select(c.id);
    NB.Transport.seekTo(c.startSix + 4);
    NB.Timeline.splitAtPlayhead();
    o.split = NB.Project.tracks[0].clips.length === n0 + 1;
    NB.History.undo();
    o.splitUndo = NB.Project.tracks[0].clips.length === n0;

    // live mute = real gain change
    NB.Transport.play(); await sleep(200);
    const before = NB.Engine.tracks[0].gain.gain.value;
    NB.Project.tracks[0].mute = true; NB.Engine.applyMix(NB.Project.tracks); await sleep(120);
    o.muteLive = NB.Engine.tracks[0].gain.gain.value < 0.01 && before > 0.1;
    NB.Project.tracks[0].mute = false; NB.Engine.applyMix(NB.Project.tracks);
    NB.Transport.pause();

    // delete while playing re-schedules the remaining clips
    NB.Transport.play(); await sleep(200);
    const before2 = NB.Engine._activeSources.length;
    const id = NB.Project.tracks[1].clips[0].id;
    NB.Timeline.select(id); NB.Timeline.deleteSelected();
    await sleep(200);
    o.deleteReschedules = NB.Engine._activeSources.length < before2;
    o.before2 = before2; o.after2 = NB.Engine._activeSources.length;
    NB.Transport.pause();
    return o;
  });
  check('play advances the clock', o.playing && o.advanced);
  check('clips are scheduled', o.sources > 0, o.sources);
  check('pause stops', o.paused);
  check('duplicate', o.dup);
  check('delete', o.del);
  check('undo', o.undo);
  check('redo', o.redo);
  check('split at playhead', o.split);
  check('undo after split', o.splitUndo);
  check('mute silences playing audio', o.muteLive);
  check('delete during playback re-schedules', o.deleteReschedules, { before: o.before2, after: o.after2 });
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close();
}

/* ------------------------------------------------ 3. zoom / canvas limits */
console.log('\n3 · timeline rendering at zoom extremes');
{
  const { page } = await open(APP);
  const o = await page.evaluate(() => {
    const NB = window.NEONBOOM, T = NB.Timeline, o = {};
    T.setZoom(5);
    o.canvasW = T.canvas.width;
    o.viewportSized = T.canvas.width <= T.vw * 2 + 2;
    o.spacerWide = parseFloat(T.spacer.style.width) > 50000;
    const d = T.ctx.getImageData(3, 3, 1, 1).data;
    o.drawn = d[3] > 0;
    T.zoomFit();
    o.fit = T.zoom > 0.05 && T.zoom < 5;
    T.setZoom(0.18);
    o.minZoomDrawn = T.ctx.getImageData(3, 3, 1, 1).data[3] > 0;
    return o;
  });
  check('canvas stays viewport-sized at 500%', o.viewportSized, o.canvasW);
  check('project stays 74k px wide in the spacer', o.spacerWide);
  check('canvas is actually painted at 500%', o.drawn);
  check('fit zoom in range', o.fit);
  check('canvas painted at minimum zoom', o.minZoomDrawn);
  await page.close();
}

/* ------------------------------------------------------- 4. pads & record */
console.log('\n4 · pads, record-arm, mixer, fx');
{
  const { page, errors } = await open(APP);
  const o = await page.evaluate(async () => {
    const NB = window.NEONBOOM, o = {};
    document.querySelector('#btnRecArm').click();
    o.armed = NB.Pads.armed;
    NB.Transport.seekTo(32);
    const n = NB.Project.tracks[0].clips.length;
    NB.Pads.trigger([...NB.Library.items.keys()][0]);
    o.recorded = NB.Project.tracks[0].clips.length === n + 1;
    document.querySelector('#btnRecArm').click();

    NB.Shell.openDrawer('mixer');
    o.strips = document.querySelectorAll('.mstrip').length;
    const fader = document.querySelector('.mstrip .mfader');
    fader.value = 0.4; fader.dispatchEvent(new Event('input', { bubbles: true }));
    o.faderLive = document.contains(fader);
    o.faderApplied = Math.abs(NB.Project.tracks[0].vol - 0.4) < 0.001;

    NB.Shell.openDrawer('fx');
    o.modules = document.querySelectorAll('.fxModule').length;
    const delay = document.querySelector('input[data-fx="delayMix"]');
    delay.value = 0.5; delay.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    o.fxApplied = Math.abs(NB.Fx.values.delayMix - 0.5) < 0.001;
    o.fxAudible = NB.Engine.master.delayWet.gain.value > 0.1;

    // filter chips
    NB.Pads.filter = 'Drums'; NB.Pads.render();
    o.filtered = document.querySelectorAll('.pad').length < 27;
    NB.Pads.filter = 'All'; NB.Pads.render();
    return o;
  });
  check('record arm places a clip at the playhead', o.armed && o.recorded);
  check('one mixer strip per track', o.strips === 8, o.strips);
  check('fader is not rebuilt while dragging', o.faderLive);
  check('fader value applies', o.faderApplied);
  check('five FX modules', o.modules === 5, o.modules);
  check('FX value reaches the audio graph', o.fxApplied && o.fxAudible);
  check('category filter narrows the pads', o.filtered);
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close();
}

/* ------------------------------------------------------ 5. export & save */
console.log('\n5 · offline render, WAV, autosave restore');
{
  const { page } = await open(APP);
  const o = await page.evaluate(async () => {
    const NB = window.NEONBOOM, o = {};
    const { rendered, seconds } = await NB.Wav.renderArrangement({
      sampleLibrary: NB.Library.items, project: NB.Project, engine: NB.Engine, fx: NB.Fx.snapshot(),
    });
    let peak = 0, ch = rendered.getChannelData(0);
    for (let i = 0; i < ch.length; i += 97) peak = Math.max(peak, Math.abs(ch[i]));
    o.seconds = seconds; o.peak = peak;
    o.channels = rendered.numberOfChannels;
    const blob = NB.Wav.encodeWAV(rendered);
    o.bytes = blob.size;
    o.header = new TextDecoder().decode((await blob.slice(0, 12).arrayBuffer()));
    // loop-only render ignores material outside the loop region
    const far = NB.project.newClip([...NB.Library.items.keys()][0], NB.Project.tracks[0].id, 16 * 20);
    NB.Project.tracks[0].clips.push(far);
    const full = await NB.Wav.renderArrangement({ sampleLibrary: NB.Library.items,
      project: NB.Project, engine: NB.Engine, fx: NB.Fx.snapshot() });
    const loop = await NB.Wav.renderArrangement({ loopOnly: true, sampleLibrary: NB.Library.items,
      project: NB.Project, engine: NB.Engine, fx: NB.Fx.snapshot() });
    o.loopShorter = loop.seconds < full.seconds;
    o.loopSec = loop.seconds; o.fullSec = full.seconds;
    NB.Project.tracks[0].clips = NB.Project.tracks[0].clips.filter((c) => c.id !== far.id);
    NB.Project.name = 'Test Beat';
    await NB.Persistence.save();
    return o;
  });
  check('offline render produces audio', o.peak > 0.02, o.peak);
  check('render is stereo', o.channels === 2, o.channels);
  check('loop-only render is shorter than the full arrangement', o.loopShorter, { loop: o.loopSec, full: o.fullSec });
  check('WAV has a RIFF header', o.header.startsWith('RIFF') && o.header.includes('WAVE'), o.header);
  check('WAV is non-trivial', o.bytes > 100000, o.bytes);

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
  const after = await page.evaluate(() => ({
    clips: window.NEONBOOM.Project.tracks.reduce((n, t) => n + t.clips.length, 0),
    name: window.NEONBOOM.Project.name,
    bpm: window.NEONBOOM.Project.bpm,
  }));
  check('autosave restores clips after reload', after.clips > 20, after.clips);
  check('autosave restores project name', after.name === 'Test Beat', after.name);
  check('autosave restores tempo', after.bpm === 92, after.bpm);
  await page.close();
}

/* ------------------------------------------------------ 6. pointer / keyboard */
console.log('\n6 · mouse drag, trim, ruler loop, keyboard');
{
  const { page } = await open(APP);
  const geo = await page.evaluate(() => {
    const NB = window.NEONBOOM, T = NB.Timeline;
    const hit = NB.Project.tracks[0].clips[0];
    const px = T.pxPerSix(), r = T.canvas.getBoundingClientRect();
    return { x: r.left + (hit.startSix + 6) * px - T.viewport.scrollLeft,
      y: r.top + 0.5 * T.trackH(), id: hit.id, start: hit.startSix };
  });
  await page.mouse.move(geo.x, geo.y);
  await page.mouse.down();
  await page.mouse.move(geo.x + 120, geo.y, { steps: 8 });
  await page.mouse.up();
  const moved = await page.evaluate((id) => {
    const f = window.NEONBOOM.project.findClip(id);
    return f ? f.clip.startSix : -1;
  }, geo.id);
  check('drag moves a clip', moved > geo.start, { from: geo.start, to: moved });

  const g2 = await page.evaluate(() => {
    const NB = window.NEONBOOM, T = NB.Timeline, c = NB.Project.tracks[1].clips[0];
    const px = T.pxPerSix(), r = T.canvas.getBoundingClientRect();
    const end = c.startSix + (c.trimEndSix - c.trimStartSix);
    return { x: r.left + end * px - T.viewport.scrollLeft - 3, y: r.top + 1.5 * T.trackH(),
      id: c.id, len: c.trimEndSix - c.trimStartSix };
  });
  await page.mouse.move(g2.x, g2.y);
  await page.mouse.down();
  await page.mouse.move(g2.x - 60, g2.y, { steps: 6 });
  await page.mouse.up();
  const trimmed = await page.evaluate((id) => {
    const f = window.NEONBOOM.project.findClip(id);
    return f ? f.clip.trimEndSix - f.clip.trimStartSix : -1;
  }, g2.id);
  check('dragging the edge trims the clip', trimmed < g2.len, { before: g2.len, after: trimmed });

  const ruler = await page.evaluate(() => {
    const r = document.querySelector('#ruler').getBoundingClientRect();
    return { x: r.left, y: r.top + 14 };
  });
  await page.keyboard.down('Shift');
  await page.mouse.move(ruler.x + 80, ruler.y);
  await page.mouse.down();
  await page.mouse.move(ruler.x + 320, ruler.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const loop = await page.evaluate(() => ({ in: window.NEONBOOM.Project.loopIn, out: window.NEONBOOM.Project.loopOut }));
  check('shift-drag on the ruler sets the loop region', loop.out > loop.in, loop);

  await page.keyboard.press('Space');
  await new Promise((r) => setTimeout(r, 300));
  const playing = await page.evaluate(() => window.NEONBOOM.Transport.playing);
  await page.keyboard.press('Space');
  const paused = await page.evaluate(() => !window.NEONBOOM.Transport.playing);
  check('space toggles playback', playing && paused);

  await page.keyboard.press('KeyF');
  const fit = await page.evaluate(() => window.NEONBOOM.Timeline.zoom);
  check('F fits the project', fit > 0.05 && fit < 5, fit);

  const g3 = await page.evaluate(() => {
    const NB = window.NEONBOOM, T = NB.Timeline, c = NB.Project.tracks[2].clips[0];
    const px = T.pxPerSix(), r = T.canvas.getBoundingClientRect();
    return { x: r.left + (c.startSix + 4) * px - T.viewport.scrollLeft, y: r.top + 2.5 * T.trackH() };
  });
  await page.mouse.click(g3.x, g3.y, { button: 'right' });
  const sheet = await page.evaluate(() => document.querySelector('#sheet').classList.contains('on'));
  check('right-click opens the clip sheet', sheet);
  await page.close();
}

/* --------------------------------------------------------------- 7. phone */
console.log('\n7 · phone layout & touch');
{
  const { page, errors } = await open(APP, { w: 390, h: 844, mobile: true });
  const o = await page.evaluate(() => {
    const NB = window.NEONBOOM, o = {};
    o.overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
    o.padsView = document.body.dataset.view === 'pads';
    o.tabbar = getComputedStyle(document.querySelector('#tabbar')).display !== 'none';
    return o;
  });
  check('no horizontal overflow on a 390 px screen', !o.overflowX);
  check('tab bar is present', o.tabbar);
  check('pads is the default view', o.padsView);

  await page.tap('#tabbar button[data-view="arrange"]');
  await new Promise((r) => setTimeout(r, 450));
  const a = await page.evaluate(() => {
    const T = window.NEONBOOM.Timeline;
    return { visible: getComputedStyle(document.querySelector('#arrange')).display,
      fits: Math.abs(parseFloat(T.canvas.style.width) - T.viewport.clientWidth) < 2,
      painted: T.ctx.getImageData(4, 4, 1, 1).data[3] > 0 };
  });
  check('arrange view opens', a.visible === 'flex', a.visible);
  check('timeline canvas matches the viewport', a.fits);
  check('timeline is painted', a.painted);

  const pos = await page.evaluate(() => {
    const NB = window.NEONBOOM, T = NB.Timeline, c = NB.Project.tracks[0].clips[3];
    const px = T.pxPerSix(), r = T.canvas.getBoundingClientRect();
    return { x: r.left + (c.startSix + 2) * px - T.viewport.scrollLeft, y: r.top + 0.5 * T.trackH(), id: c.id };
  });
  await page.touchscreen.tap(pos.x, pos.y);
  await new Promise((r) => setTimeout(r, 250));
  check('tap selects a clip', await page.evaluate((id) => window.NEONBOOM.Timeline.selectedClipId === id, pos.id));

  await page.touchscreen.touchStart(pos.x, pos.y);
  await new Promise((r) => setTimeout(r, 1000));
  await page.touchscreen.touchEnd();
  await new Promise((r) => setTimeout(r, 250));
  check('long-press opens the clip sheet', await page.evaluate(() => document.querySelector('#sheet').classList.contains('on')));
  await page.evaluate(() => window.NEONBOOM.Shell.closeSheet());

  await page.tap('#tabbar button[data-view="mixer"]');
  await new Promise((r) => setTimeout(r, 300));
  check('mixer tab opens the drawer', await page.evaluate(() => document.querySelector('#drawer').classList.contains('mobileOpen')));

  await page.tap('#tabbar button[data-view="more"]');
  await new Promise((r) => setTimeout(r, 300));
  check('more tab opens the project sheet', await page.evaluate(() => document.querySelector('#sheet').classList.contains('on')));
  await page.evaluate(() => window.NEONBOOM.Shell.closeSheet());

  await page.tap('#lcd');
  await new Promise((r) => setTimeout(r, 250));
  check('LCD opens the transport sheet', await page.evaluate(() => document.querySelector('#sheet').classList.contains('on')));
  check('tempo is shown in the LCD on phones', await page.evaluate(() => document.querySelector('#lcdSub').textContent.includes('BPM')));
  await page.evaluate(() => window.NEONBOOM.Shell.closeSheet());

  const targets = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, select')].filter((e) => e.offsetParent);
    return els.map((e) => e.getBoundingClientRect().height).filter((h) => h < 30).length;
  });
  check('no tap target under 30 px', targets === 0, targets);
  check('no console errors on phone', errors.length === 0, errors.slice(0, 3));
  await page.close();
}

/* -------------------------------------------------------------- 8. tablet */
console.log('\n8 · tablet layout');
{
  const { page } = await open(APP, { w: 834, h: 1112, mobile: true });
  const o = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    tabbar: getComputedStyle(document.querySelector('#tabbar')).display !== 'none',
  }));
  check('no horizontal overflow on tablet', !o.overflowX);
  check('tablet uses the tabbed layout', o.tabbar);
  await page.close();
}

/* ---------------------------------------------------------- 9. standalone */
console.log('\n9 · standalone single-file build');
{
  if (!fs.existsSync(path.join(ROOT, 'dist', 'neonboom.html'))) {
    check('dist/neonboom.html exists (run npm run build)', false);
  } else {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [], failed = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('requestfailed', (r) => failed.push(r.url()));
    await page.goto(STANDALONE, { waitUntil: 'load' });
    await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
    const o = await page.evaluate(() => ({
      samples: window.NEONBOOM.Library.items.size,
      pads: document.querySelectorAll('.pad').length,
    }));
    check('standalone build boots', o.samples === 27, o.samples);
    check('standalone build has pads', o.pads === 27, o.pads);
    check('standalone build makes no failed requests', failed.length === 0, failed.slice(0, 3));
    check('standalone build has no console errors', errors.length === 0, errors.slice(0, 3));
    await page.close();
  }
}

await browser.close();

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${pass} passed · ${fail} failed · ${pass + fail} assertions`);
if (fail) {
  console.log('\n  failures:');
  failures.forEach((f) => console.log('   - ' + f));
  process.exitCode = 1;
} else {
  console.log('  all green');
}
