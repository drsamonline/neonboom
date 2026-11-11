/* =========================================================================
   NEONBOOM · dogfood.mjs — build a track end to end, like a user
   Not a unit test: this drives the real UI and the real public API and logs
   every place it had to reach around the interface or got an error.
   ========================================================================= */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const APP = 'file://' + ROOT + 'index.html';
const WAV = ROOT + 'tests/fixtures/import-test.wav';
const friction = [];
const log = (stage, note) => friction.push(`[${stage}] ${note}`);

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/chromium', headless: 'shell',
  args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', async (d) => { await d.accept('Dogfood scene'); });   // prompt()

await page.evaluateOnNewDocument(() => { try { localStorage.setItem('nb-onboarded', '1'); } catch (e) {} });
await page.goto(APP, { waitUntil: 'load' });
await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
await page.waitForFunction("window.NEONBOOM.Library.items.size === 27", { timeout: 40000 }).catch(() => {});

/* ---------------------------------------------------------- 1. template */
await page.evaluate(() => window.NEONBOOM.Shell.openTemplates());
await new Promise((r) => setTimeout(r, 400));
const tplRows = await page.$$('.tplRow');
if (tplRows.length !== 4) log('template', `picker showed ${tplRows.length} rows, expected 4`);
await page.evaluate(() => document.querySelectorAll('.tplRow')[1].click());   // Trap
await new Promise((r) => setTimeout(r, 500));
let s = await page.evaluate(() => ({
  name: NEONBOOM.Project.name, bpm: NEONBOOM.Project.bpm,
  clips: NEONBOOM.Project.tracks.reduce((n, t) => n + t.clips.length, 0),
  tracks: NEONBOOM.Project.tracks.length,
}));
console.log('1 template →', JSON.stringify(s));
if (s.name !== 'Trap') log('template', `expected Trap, got ${s.name}`);
await page.screenshot({ path: `${ROOT}tests/fixtures/dogfood/1-template.png` });

/* ---------------------------------------------------------- 2. import */
const input = await page.$('#fileInput');
if (!input) log('import', 'no #fileInput in the DOM — import is unreachable from code');
else {
  await input.uploadFile(WAV);
  await new Promise((r) => setTimeout(r, 900));
}
s = await page.evaluate(() => {
  const user = NEONBOOM.Library.list().filter((x) => x.isUser);
  return { user: user.length, name: user[0] && user[0].name, cat: user[0] && user[0].category,
    beats: user[0] && user[0].beats, pads: document.querySelectorAll('.pad').length,
    chips: Array.from(document.querySelectorAll('#padChips .chip')).map((c) => c.textContent.trim()) };
});
console.log('2 import →', JSON.stringify(s));
if (!s.user) log('import', 'uploaded WAV did not register a user sample');
if (s.pads < 28) log('import', `pad grid shows ${s.pads} pads, imported sample may not be visible`);
await page.screenshot({ path: `${ROOT}tests/fixtures/dogfood/2-imported.png` });

/* ------------------------------------------------- 3. place + edit clip */
const placed = await page.evaluate(() => {
  const NB = window.NEONBOOM;
  const user = NB.Library.list().find((x) => x.isUser);
  if (!user) return null;
  NB.Timeline.selectedTrackId = NB.Project.tracks[3].id;
  NB.Transport.seekTo(32);
  const clip = NB.project.newClip(user.id, NB.Project.tracks[3].id, 32);
  NB.Project.tracks[3].clips.push(clip);
  NB.bus.emit('clips:changed');
  NB.Timeline.select(clip.id);
  return { id: clip.id, start: clip.startSix, len: clip.trimEndSix };
});
console.log('3 placed →', JSON.stringify(placed));
if (!placed) log('arrange', 'could not place the imported sample from the public API');

/* tempo-fit through the inspector button, not the API */
await new Promise((r) => setTimeout(r, 300));
const fitBtn = await page.$('#clipStretch');
if (!fitBtn) log('inspector', 'no #clipStretch button — tempo-fit is not reachable from the inspector');
else { await fitBtn.click(); await new Promise((r) => setTimeout(r, 200)); }
s = await page.evaluate(() => {
  const NB = window.NEONBOOM, f = NB.project.findClip(NB.Timeline.selectedClipId);
  return { stretch: f && f.clip.stretch, ratio: f ? +NB.Schedule.stretchRatio(f.clip, NB.Library.get(f.clip.sampleId), NB.Project.bpm).toFixed(3) : null };
});
console.log('4 tempo-fit →', JSON.stringify(s));
if (!s.stretch) log('inspector', 'tempo-fit button did not set clip.stretch');

/* pitch through the slider */
const pitch = await page.$('#inspector [data-k=pitch]');
if (!pitch) log('inspector', 'no pitch slider in the inspector');
else await page.evaluate(() => {
  const el = document.querySelector('#inspector [data-k=pitch]');
  el.value = '3'; el.dispatchEvent(new Event('input', { bubbles: true }));
});
s = await page.evaluate(() => {
  const NB = window.NEONBOOM, f = NB.project.findClip(NB.Timeline.selectedClipId);
  return { pitch: f && f.clip.pitch, label: (document.querySelector('#inspector [data-k=pitch]') || {}).getAttribute && document.querySelector('#inspector [data-k=pitch]').getAttribute('aria-label') };
});
console.log('4b pitch →', JSON.stringify(s));
if (s.pitch !== 3) log('inspector', 'the pitch slider did not change clip.pitch');
if (!s.label) log('a11y', 'the pitch slider has no accessible name');
await page.screenshot({ path: `${ROOT}tests/fixtures/dogfood/3-edited.png` });

/* ------------------------------------------------- 4. automation by mouse */
const lane = await page.evaluate(() => {
  const NB = window.NEONBOOM;
  const head = document.querySelectorAll('.trackHead')[3];
  head.querySelector('[data-act=auto]').click();
  return NB.Project.tracks[3].autoMode;
});
console.log('5 automation lane →', lane);
if (!lane) log('automation', 'the A button did not turn on a lane');

/* click two points in the lane with the real mouse */
const box = await page.evaluate(() => {
  const NB = window.NEONBOOM;
  const r = NB.Timeline.canvas.getBoundingClientRect();
  const th = NB.Timeline.trackH();
  return { x: r.left, y: r.top + 3 * th, th, zoom: NB.Timeline.zoom };
});
await page.mouse.click(box.x + 200, box.y + 20);
await new Promise((r) => setTimeout(r, 150));
await page.mouse.click(box.x + 500, box.y + 50);
await new Promise((r) => setTimeout(r, 250));
s = await page.evaluate(() => ({ pts: (NEONBOOM.Project.tracks[3].automation.level || []).length }));
console.log('6 automation points →', JSON.stringify(s));
if (!s.pts) log('automation', 'mouse clicks in the lane added no points');
await page.screenshot({ path: `${ROOT}tests/fixtures/dogfood/4-automation.png` });

/* -------------------------------------------------------- 5. two scenes */
await page.evaluate(() => window.NEONBOOM.Scenes.capture('Drop'));
s = await page.evaluate(() => ({ scenes: NEONBOOM.Scenes.list().length, chips: document.querySelectorAll('.sceneChip').length }));
console.log('7 scene saved →', JSON.stringify(s));
if (!s.chips) log('scenes', 'saved a scene but no chip appeared in the strip');

await page.evaluate(() => {
  const NB = window.NEONBOOM;
  NB.Project.tracks[0].clips = [];
  NB.Scenes.capture('Break');
});
await page.evaluate(() => NB.Scenes.launch(NEONBOOM.Scenes.list()[0].id));
await new Promise((r) => setTimeout(r, 300));
s = await page.evaluate(() => ({ clips: NEONBOOM.Project.tracks.reduce((n, t) => n + t.clips.length, 0) }));
console.log('8 scene launched →', JSON.stringify(s));
await page.screenshot({ path: `${ROOT}tests/fixtures/dogfood/5-scenes.png` });

/* ------------------------------------------------------- 6. bounce stems */
const bounce = await page.evaluate(async () => {
  const NB = window.NEONBOOM;
  const t0 = performance.now();
  const stems = await NB.Wav.renderStems({ sampleLibrary: NB.Library.items, project: NB.Project, engine: NB.Engine, fx: NB.Fx.snapshot() });
  const zip = await NB.Wav.zip(stems);
  return { count: stems.length, ms: Math.round(performance.now() - t0), kb: Math.round(zip.size / 1024) };
});
console.log('9 stems →', JSON.stringify(bounce));
if (!bounce.count) log('export', 'stem export returned nothing');

const wav = await page.evaluate(async () => {
  const NB = window.NEONBOOM;
  const { rendered } = await NB.Wav.renderArrangement({ sampleLibrary: NB.Library.items, project: NB.Project, engine: NB.Engine, fx: NB.Fx.snapshot() });
  const blob = NB.Wav.encodeWAV(rendered);
  let peak = 0; const ch = rendered.getChannelData(0);
  for (let i = 0; i < ch.length; i += 7) peak = Math.max(peak, Math.abs(ch[i]));
  return { kb: Math.round(blob.size / 1024), peak: +peak.toFixed(2), secs: +rendered.duration.toFixed(1) };
});
console.log('10 bounce →', JSON.stringify(wav));

/* --------------------------------------------------- 7. reload + restore */
await page.reload({ waitUntil: 'load' });
await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
await page.waitForFunction("window.NEONBOOM.Library.items.size >= 27", { timeout: 40000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 800));
s = await page.evaluate(() => {
  const NB = window.NEONBOOM;
  return {
    name: NB.Project.name,
    clips: NB.Project.tracks.reduce((n, t) => n + t.clips.length, 0),
    userSamples: NB.Library.list().filter((x) => x.isUser).length,
    scenes: NB.Scenes.list().length,
    sceneChips: document.querySelectorAll('.sceneChip').length,
    automation: (NB.Project.tracks[3].automation.level || []).length,
  };
});
console.log('11 after reload →', JSON.stringify(s));
if (!s.userSamples) log('persistence', 'imported sample did not survive the reload');
if (!s.scenes) log('persistence', 'scenes did not survive the reload');
if (!s.automation) log('persistence', 'automation points did not survive the reload');

/* the real question: does a scene still make sound after the reload? */
const revived = await page.evaluate(async () => {
  const NB = window.NEONBOOM;
  if (!NB.Scenes.list().length) return { skipped: true };
  NB.Scenes.launch(NB.Scenes.list()[0].id);
  await new Promise((r) => setTimeout(r, 300));
  const ids = new Set();
  NB.Project.tracks.forEach((t) => t.clips.forEach((c) => ids.add(c.sampleId)));
  const missing = [...ids].filter((id) => !NB.Library.get(id));
  return { clips: NB.Project.tracks.reduce((n, t) => n + t.clips.length, 0), missing: missing.length };
});
console.log('12 scene after reload →', JSON.stringify(revived));
if (revived.missing) log('persistence', `a launched scene references ${revived.missing} sample id(s) the library no longer has — that scene plays silence`);
await page.screenshot({ path: `${ROOT}tests/fixtures/dogfood/6-reloaded.png` });

console.log('\n--- friction ---');
friction.forEach((f) => console.log(' • ' + f));
console.log('\n--- console errors ---');
console.log(errors.length ? errors.slice(0, 6) : 'none');

await browser.close();
