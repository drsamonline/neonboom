/* =========================================================================
   NEONBOOM · tests/run.mjs — core suite
   Boot, transport, editing, zoom, pads/mixer/FX, export, pointer + touch,
   responsive layout, clip features. Run with `npm test`.
   ========================================================================= */
import { check, open, restart, summary, ROOT, APP, STANDALONE } from './harness.mjs';

/* ---------------------------------------------------------------- 1. boot */
console.log('\n1 · boot & library');
{
  const { page, errors, bootMs } = await open(APP);
  const o = await page.evaluate(() => ({
    samplesAtBoot: window.NEONBOOM.Library.items.size,
    tracks: window.NEONBOOM.Project.tracks.length,
    clips: window.NEONBOOM.Project.tracks.reduce((n, t) => n + t.clips.length, 0),
    timings: window.NEONBOOM.App.timings,
  }));
  const veilGone = await page.waitForFunction(
    "getComputedStyle(document.querySelector('#boot')).display === 'none'",
    { timeout: 8000 }).then(() => true).catch(() => false);
  /* the priority slice must be ready before the veil lifts; the rest streams in */
  check('priority loops ready at first paint', o.samplesAtBoot >= 14, o.samplesAtBoot);
  check('8 tracks', o.tracks === 8, o.tracks);
  check('demo arrangement loaded', o.clips > 20, o.clips);

  const full = await page.waitForFunction(
    "window.NEONBOOM.Library.items.size === 27 && document.querySelectorAll('.pad').length === 27",
    { timeout: 30000 }).then(() => true).catch(() => false);
  check('all 27 loops arrive (background pass)', full);
  const pads = await page.evaluate(() => ({
    pads: document.querySelectorAll('.pad').length,
    waves: document.querySelectorAll('.pad canvas').length,
  }));
  check('one pad per loop', pads.pads === 27, pads.pads);
  check('every pad has a waveform', pads.waves === 27, pads.waves);
  check('boot veil removed', veilGone);
  check('no console errors at boot', errors.length === 0, errors.slice(0, 3));
  console.log(`  boot ${bootMs} ms`);
  await page.close(); await page.__ctx.close();
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

    // delete while playing must silence that clip's sources
    NB.Transport.play(); await sleep(250);
    const id = NB.Project.tracks[1].clips[0].id;
    NB.Timeline.select(id); NB.Timeline.deleteSelected();
    await sleep(250);
    o.sourcesForDeleted = NB.Engine._activeSources.filter((src) => src._clipId === id).length;
    o.deleteReschedules = o.sourcesForDeleted === 0;
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
  check('delete during playback silences the clip', o.deleteReschedules, { sources: o.sourcesForDeleted });
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close(); await page.__ctx.close();
}

await restart();
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
  await page.close(); await page.__ctx.close();
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
  await page.close(); await page.__ctx.close();
}

await restart();
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
  await page.close(); await page.__ctx.close();
}

await restart();
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
  await page.close(); await page.__ctx.close();
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

  /* a held finger is a timing gesture; retry once if the box was busy
     (background loop rendering competes with the long-press timer) */
  const holdAndWait = async () => {
    await page.touchscreen.touchStart(pos.x, pos.y);
    await new Promise((r) => setTimeout(r, 1100));
    await page.touchscreen.touchEnd();
    return page.waitForFunction(
      "document.querySelector('#sheet').classList.contains('on')",
      { timeout: 2000 }).then(() => true).catch(() => false);
  };
  let sheetOpened = await holdAndWait();
  if (!sheetOpened) {
    await page.evaluate(() => window.NEONBOOM.Shell.closeSheet());
    await new Promise((r) => setTimeout(r, 200));
    sheetOpened = await holdAndWait();
  }
  check('long-press opens the clip sheet', sheetOpened);
  check('tapping the scrim closes it again', await (async () => {
    await page.mouse.click(20, 120);                       // scrim area, above the sheet
    await new Promise((r) => setTimeout(r, 250));
    return page.evaluate(() => !document.querySelector('#sheet').classList.contains('on'));
  })());
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
  await page.close(); await page.__ctx.close();
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
  await page.close(); await page.__ctx.close();
}

await restart();
/* ------------------------------------------- 9. pitch, reverse, fades, swing */
console.log('\n9 · pitch, reverse, fades, swing, stems');
{
  const { page, errors } = await open(APP);
  await page.waitForFunction("window.NEONBOOM.Library.items.size === 27", { timeout: 30000 }).catch(() => {});
  const o = await page.evaluate(async () => {
    const NB = window.NEONBOOM, o = {};
    const clip = NB.Project.tracks[0].clips[0];
    const sample = NB.Library.get(clip.sampleId);

    /* pitch is a playbackRate multiplier */
    const base = NB.Schedule.rate({ pitch: 0 }, sample, 92);
    o.rateOctave = NB.Schedule.rate({ pitch: 12 }, sample, 92) / base;
    o.rateFifth = NB.Schedule.rate({ pitch: 7 }, sample, 92) / base;

    /* reverse produces a real reversed copy, cached on the sample */
    const rev = NB.project.reversedBuffer(sample);
    const a = sample.buffer.getChannelData(0), b = rev.getChannelData(0);
    o.reversed = Math.abs(a[a.length - 1] - b[0]) < 1e-6 && Math.abs(a[0] - b[b.length - 1]) < 1e-6;
    o.reverseCached = NB.project.reversedBuffer(sample) === rev;

    /* swing delays odd sixteenths only */
    o.swingEven = NB.Schedule.swingOffsetSix({ startSix: 4 }, 0.4);
    o.swingOdd = NB.Schedule.swingOffsetSix({ startSix: 5 }, 0.4);

    /* a fade in really attenuates the head of the clip.
       Solo the kick track: the demo's snare sits on the same downbeat and
       would mask the difference otherwise. */
    NB.Project.tracks.forEach((t, i) => { t.mute = i !== 0; });
    const render = async (fade) => {
      clip.fadeIn = fade;
      const { rendered } = await NB.Wav.renderArrangement({
        sampleLibrary: NB.Library.items, project: NB.Project, engine: NB.Engine, fx: NB.Fx.snapshot(),
      });
      const ch = rendered.getChannelData(0);
      const sr = rendered.sampleRate;
      let head = 0, body = 0;
      for (let i = 0; i < sr * 0.08; i++) head = Math.max(head, Math.abs(ch[i]));
      for (let i = Math.floor(sr * 0.25); i < Math.floor(sr * 0.6); i++) body = Math.max(body, Math.abs(ch[i]));
      return { head, body };
    };
    const plain = await render(0);
    const faded = await render(6);
    clip.fadeIn = 0;
    NB.Project.tracks.forEach((t) => { t.mute = false; });
    o.fadeHeadPlain = plain.head; o.fadeHeadFaded = faded.head;

    /* stems: one WAV per track, zipped with a real PK header.
       Trim to two bars first — eight full-length renders at once is more
       memory than a small CI pod likes, and the assertion is about count. */
    const snapshot = NB.History.snapshot();
    NB.Project.tracks.forEach((tr) => { tr.clips = tr.clips.filter((c) => c.startSix < 32); });
    const stems = await NB.Wav.renderStems({
      sampleLibrary: NB.Library.items, project: NB.Project, engine: NB.Engine, fx: NB.Fx.snapshot(),
    });
    o.stemCount = stems.length;
    const zip = await NB.Wav.zip(stems.map((x) => ({ name: x.name, blob: x.blob })));
    const head = new Uint8Array(await zip.slice(0, 4).arrayBuffer());
    o.zipMagic = String.fromCharCode(...head);
    o.zipBytes = zip.size;
    o.stemNames = stems.map((x) => x.name).slice(0, 3);
    NB.History.apply(snapshot);
    NB.Timeline.rebuildHeaders(); NB.Timeline.draw();
    return o;
  });
  check('pitch +12 doubles the rate', Math.abs(o.rateOctave - 2) < 0.001, o.rateOctave);
  check('pitch +7 is a fifth', Math.abs(o.rateFifth - 1.4983) < 0.01, o.rateFifth);
  check('reverse buffer is reversed', o.reversed);
  check('reverse buffer is cached', o.reverseCached);
  check('swing leaves even sixteenths alone', o.swingEven === 0);
  check('swing delays odd sixteenths', o.swingOdd > 0.15, o.swingOdd);
  check('fade-in attenuates the clip head', o.fadeHeadFaded < o.fadeHeadPlain * 0.6,
    { plain: o.fadeHeadPlain, faded: o.fadeHeadFaded });
  check('one stem per track with clips', o.stemCount === 8, o.stemCount);
  check('zip has a PK header', o.zipMagic === 'PK\u0003\u0004', o.zipMagic);
  check('zip is non-trivial', o.zipBytes > 500000, o.zipBytes);
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close(); await page.__ctx.close();
}


await summary();
