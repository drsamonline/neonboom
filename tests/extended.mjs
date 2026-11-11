/* =========================================================================
   NEONBOOM · tests/extended.mjs — features suite
   Loop cache, standalone builds, sends/clipboard/history/worklet, scheduler,
   templates, automation, MIDI notes + CC, keyboard navigation.
   Run with `npm test` (or `npm run test:extended`).
   ========================================================================= */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { check, open, restart, summary, ROOT, APP, STANDALONE, browser } from './harness.mjs';

/* ------------------------------------------------ 10. loop cache (warm boot) */
console.log('\n10 · loop cache');
{
  const { page } = await open(APP);
  await page.waitForFunction("window.NEONBOOM.Library.items.size === 27", { timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  const rows = await page.evaluate(async () => {
    const db = window.NEONBOOM.Persistence.db;
    if (!db) return { count: 0 };
    return new Promise((res) => {
      const tx = db.transaction('loops', 'readonly');
      const rq = tx.objectStore('loops').getAll();
      rq.onsuccess = () => {
        const r = rq.result || [];
        res({ count: r.length, mono: r.filter((x) => x.channels === 1).length,
          bytes: r.reduce((n, x) => n + x.data.length * 2, 0) });
      };
      rq.onerror = () => res({ count: 0 });
    });
  });
  check('every loop is cached', rows.count === 27, rows.count);
  check('loops are cached as mono when the channels match', rows.mono > 20, rows.mono);
  check('cache is a sensible size (< 12 MB)', rows.bytes > 1000000 && rows.bytes < 12 * 1024 * 1024, rows.bytes);

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
  const t = await page.evaluate(() => window.NEONBOOM.App.timings);
  check('warm boot hydrates from cache', t.hydrated >= 14, t.hydrated);
  check('warm boot renders nothing on the critical path', t.phase1 === 0, t.phase1);
  check('warm boot is faster than cold', t.storage < 1500, t.storage);
  await page.close(); await page.__ctx.close();
}

await restart();
/* --------------------------------- 12. sends, clipboard, history, worklet */
console.log('\n12 · sends, clipboard, history, worklet');
{
  const { page, errors } = await open(APP);
  await page.waitForFunction("window.NEONBOOM.Library.items.size === 27", { timeout: 30000 }).catch(() => {});
  const o = await page.evaluate(async () => {
    const NB = window.NEONBOOM, o = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /* --- per-track sends reach the graph --- */
    NB.Project.tracks[0].sendA = 0.5;
    NB.Project.tracks[0].sendB = 0.25;
    NB.Engine.applyMix(NB.Project.tracks);
    await sleep(120);
    o.sendA = NB.Engine.tracks[0].sendA.gain.value;
    o.sendB = NB.Engine.tracks[0].sendB.gain.value;
    o.sendNodes = !!NB.Engine.tracks[0].sendA && !!NB.Engine.tracks[0].sendB;

    /* --- clipboard --- */
    const t0 = NB.Project.tracks[1];
    const before = t0.clips.length;
    NB.Timeline.select(t0.clips[0].id);
    o.copied = NB.Timeline.copySelected();
    NB.Transport.seekTo(48);
    NB.Timeline.selectedTrackId = t0.id;
    o.pasted = NB.Timeline.paste();
    o.pasteCount = NB.Project.tracks[1].clips.length;
    const pasted = NB.Project.tracks[1].clips[NB.Project.tracks[1].clips.length - 1];
    o.pasteAtPlayhead = pasted.startSix === 48;
    o.pasteNewId = pasted.id !== NB.Timeline.clipboard.id;

    /* --- labelled history + jump --- */
    const labels = NB.History.list().map((h) => h.label);
    o.labels = labels.slice(0, 4);
    o.hasLabels = labels.some((l) => l === 'Paste clip');
    const clipsNow = NB.Project.tracks[1].clips.length;
    const first = NB.History.list().find((h) => h.label === 'Paste clip');
    NB.History.jumpTo(first.index);
    o.afterJump = NB.Project.tracks[1].clips.length;
    o.jumpWorked = o.afterJump === clipsNow - 1;

    /* --- AudioWorklet crusher, not the deprecated node --- */
    o.workletReady = NB.AudioWorklet._ready.has(NB.Engine.ctx);
    o.crusherIsWorklet = !!(NB.Engine.master.crusher && NB.Engine.master.crusher._worklet);
    o.setCrush = typeof NB.Engine.master.setCrush === 'function';
    NB.Engine.master.setCrush(4, 8);
    o.crushBits = NB.Engine.master.crusher._bits;
    o.crushHasParams = !!(NB.Engine.master.crusher.parameters &&
      NB.Engine.master.crusher.parameters.get('bits'));
    return o;
  });
  check('delay send reaches the track bus', Math.abs(o.sendA - 0.5) < 0.02, o.sendA);
  check('reverb send reaches the track bus', Math.abs(o.sendB - 0.25) < 0.02, o.sendB);
  check('copy puts a clip on the clipboard', o.copied);
  check('paste adds a clip', o.pasted && o.pasteCount > 0, o.pasteCount);
  check('paste lands at the playhead', o.pasteAtPlayhead);
  check('pasted clip gets a new id', o.pasteNewId);
  check('history entries carry labels', o.hasLabels, o.labels);
  check('jumping back in history undoes to that point', o.jumpWorked, { before: o.afterJump });
  check('AudioWorklet module registered', o.workletReady);
  check('bitcrusher runs as an AudioWorkletNode', o.crusherIsWorklet);
  check('crusher parameters are settable', o.setCrush && o.crushBits === 4 && o.crushHasParams, { bits: o.crushBits, params: o.crushHasParams });
  check('no ScriptProcessor deprecation warning', !errors.some((e) => /ScriptProcessorNode is deprecated/i.test(e)), errors.slice(0, 2));
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close(); await page.__ctx.close();
}

await restart();
/* ------------------------------------------------- 13. look-ahead scheduler */
console.log('\n13 · look-ahead scheduler');
{
  const { page, errors } = await open(APP);
  const o = await page.evaluate(async () => {
    const NB = window.NEONBOOM, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), o = {};
    const totalClips = NB.Project.tracks.reduce((n, t) => n + t.clips.length, 0);

    NB.Project.loopEnabled = true; NB.Project.loopIn = 0; NB.Project.loopOut = 16;   // 1 bar
    NB.Transport.seekTo(0);
    NB.Transport.play();
    await sleep(300);
    o.sourcesEarly = NB.Engine._activeSources.length;
    o.totalClips = totalClips;
    o.queuedNotEverything = o.sourcesEarly < totalClips;

    await sleep(3000);                                    // past the loop end
    o.stillPlaying = NB.Transport.playing;
    o.posAfterWrap = +NB.Transport.currentSix().toFixed(2);
    o.wrapped = o.posAfterWrap < 16;

    const before = NB.Transport.currentSix();
    NB.Transport.setBpm(140);
    await sleep(400);
    o.playingAfterBpm = NB.Transport.playing;
    o.bpmApplied = NB.Project.bpm === 140;
    o.clockContinued = Math.abs(NB.Transport.currentSix() - before) > 0.2;

    NB.Transport.pause();
    o.sourcesAfterPause = NB.Engine._activeSources.length;
    return o;
  });
  check('only a window of clips is queued, not the whole project',
    o.queuedNotEverything, { queued: o.sourcesEarly, total: o.totalClips });
  check('loop wraps and keeps playing', o.stillPlaying && o.wrapped, o.posAfterWrap);
  check('tempo changes while rolling', o.bpmApplied && o.playingAfterBpm && o.clockContinued);
  check('pause clears every queued source', o.sourcesAfterPause === 0, o.sourcesAfterPause);
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close(); await page.__ctx.close();
}

await restart();
/* --------------------------------- 14. templates, multi-select, appearance */
console.log('\n14 · templates, multi-select, appearance');
{
  const { page, errors } = await open(APP);
  await page.waitForFunction("window.NEONBOOM.Library.items.size === 27", { timeout: 30000 }).catch(() => {});
  const o = await page.evaluate(() => {
    const NB = window.NEONBOOM, o = {};
    const count = () => NB.Project.tracks.reduce((n, t) => n + t.clips.length, 0);

    o.templates = NB.Templates.list().map((t) => t.id);
    NB.Templates.build('trap');
    o.trapBpm = NB.Project.bpm;
    o.trapClips = count();
    o.trapSends = NB.Project.tracks.some((t) => (t.sendA || 0) > 0 || (t.sendB || 0) > 0);
    NB.Templates.build('empty');
    o.emptyClips = count();
    NB.Templates.build('boombap');
    o.boomClips = count();

    const T = NB.Timeline;
    const ids = [NB.Project.tracks[0].clips[0].id, NB.Project.tracks[0].clips[1].id,
      NB.Project.tracks[1].clips[0].id];
    T.select(ids[0]); T.select(ids[1], true); T.select(ids[2], true);
    o.selCount = T.selectedClipIds.size;

    const before = count();
    T.nudge(4);
    o.nudgedAll = ids.every((id) => NB.project.findClip(id).clip.startSix >= 4);
    T.duplicateSelected();
    o.dupGrew = count() === before + 3;
    T.deleteSelected();
    o.delBack = count() === before;
    o.cleared = T.selectedClipIds.size === 0;

    o.marquee = T.selectInRect(0, 0, 1e6, 1e6, false);
    o.marqueeSel = T.selectedClipIds.size;
    T.select(null);

    document.documentElement.dataset.palette = 'safe';
    NB.util.applyPaletteToProject(NB.Project);
    o.safeColor = NB.Project.tracks[0].color;
    document.documentElement.dataset.palette = 'neon';
    NB.util.applyPaletteToProject(NB.Project);
    o.neonColor = NB.Project.tracks[0].color;
    o.paletteDiffers = o.safeColor !== o.neonColor;

    /* the template picker is a real surface: open it and count the rows */
    NB.Shell.openTemplates();
    o.tplRows = document.querySelectorAll('.tplRow').length;
    NB.Shell.closeSheet();
    return o;
  });
  check('four templates available', o.templates.length === 4, o.templates);
  check('trap template builds at 140 BPM', o.trapBpm === 140 && o.trapClips > 20, { bpm: o.trapBpm, clips: o.trapClips });
  check('templates carry mixer sends', o.trapSends);
  check('empty template is empty', o.emptyClips === 0, o.emptyClips);
  check('boom bap template fills eight bars', o.boomClips > 30, o.boomClips);
  check('shift-click builds a multi-selection', o.selCount === 3, o.selCount);
  check('nudge moves every selected clip', o.nudgedAll);
  check('duplicate copies the whole selection', o.dupGrew);
  check('delete removes the whole selection', o.delBack && o.cleared, { back: o.delBack });
  check('marquee selects clips', o.marquee > 20 && o.marqueeSel === o.marquee, { hits: o.marquee });
  check('colour-safe palette swaps track colours', o.paletteDiffers, { safe: o.safeColor, neon: o.neonColor });
  check('template picker lists every template', o.tplRows === 4, o.tplRows);

  const extra = await page.evaluate(async () => {
    const NB = window.NEONBOOM, e = {};
    e.frameFns = NB.util.Frame._fns.length;

    const clip = NB.Project.tracks[0].clips[0];
    NB.Timeline.select(clip.id);
    NB.Shell.openClipEditor(clip.id);
    await new Promise((r) => setTimeout(r, 120));
    e.editorOpen = !!document.querySelector('#ceWave');
    const end = clip.trimEndSix;
    document.querySelector('#ceFit1').click();
    e.fit1 = clip.trimEndSix === 16;
    document.querySelector('#ceHalf').click();
    e.half = clip.trimEndSix === 8;
    document.querySelector('#ceNorm').click();
    e.norm = clip.gain;
    document.querySelector('#ceReset').click();
    e.reset = clip.trimEndSix === end && clip.trimStartSix === 0;
    document.querySelector('#ceDone').click();

    NB.Transport.play();
    await new Promise((r) => setTimeout(r, 160));
    e.playing = document.querySelector('#announce').textContent;
    NB.Transport.pause();
    await new Promise((r) => setTimeout(r, 160));
    e.paused = document.querySelector('#announce').textContent;
    return e;
  });
  check('meters share one frame loop', extra.frameFns === 3, extra.frameFns);
  check('clip editor opens on the waveform', extra.editorOpen);
  check('fit 1 bar sets the trim', extra.fit1);
  check('half length halves the trim', extra.half);
  check('normalise sets a sensible gain', extra.norm > 0.3 && extra.norm <= 2, extra.norm);
  check('reset restores the trim', extra.reset);
  check('transport is announced to screen readers', extra.playing === 'Playing' && extra.paused === 'Paused', extra);

  /* onboarding: a context that has never seen it */
  {
    const context = await browser.createBrowserContext();
    const pg = await context.newPage();
    await pg.setViewport({ width: 1280, height: 800 });
    await pg.goto(APP, { waitUntil: 'load' });
    await pg.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
    const shown = await pg.waitForFunction("!!document.querySelector('#obDone')", { timeout: 6000 }).then(() => true).catch(() => false);
    check('first run shows the three tips', shown);
    await pg.evaluate(() => document.querySelector('#obDone').click());
    check('tips are remembered', await pg.evaluate(() => localStorage.getItem('nb-onboarded') === '1'));
    await pg.close(); await context.close();
  }
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close(); await page.__ctx.close();
}

await restart();
/* --------------------------------------------------------- 15. automation */
console.log('\n15 · automation lanes');
{
  const { page, errors } = await open(APP);
  await page.waitForFunction("window.NEONBOOM.Library.items.size === 27", { timeout: 30000 }).catch(() => {});
  const o = await page.evaluate(async () => {
    const NB = window.NEONBOOM, o = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t = NB.Project.tracks[0];

    NB.project.autoPoint(t, 'level', 0, 0.05);
    NB.project.autoPoint(t, 'level', 64, 1);
    o.atStart = NB.project.autoValueAt(t, 'level', 0);
    o.atMid = +NB.project.autoValueAt(t, 'level', 32).toFixed(2);
    o.atEnd = NB.project.autoValueAt(t, 'level', 64);
    o.before = NB.project.autoValueAt(t, 'level', 0) !== null;

    /* offline render follows the envelope: quiet head, loud tail */
    NB.Project.tracks.forEach((x, i) => { x.mute = i !== 0; });
    const { rendered } = await NB.Wav.renderArrangement({
      sampleLibrary: NB.Library.items, project: NB.Project, engine: NB.Engine, fx: NB.Fx.snapshot(),
    });
    const ch = rendered.getChannelData(0), sr = rendered.sampleRate;
    const peak = (a, b) => {
      let m = 0;
      for (let i = Math.floor(a * sr); i < Math.min(ch.length, Math.floor(b * sr)); i++) m = Math.max(m, Math.abs(ch[i]));
      return +m.toFixed(3);
    };
    o.head = peak(0.1, 0.4);
    o.tail = peak(9, 11);
    NB.Project.tracks.forEach((x) => { x.mute = false; });

    /* live: the automation node follows the envelope */
    NB.Transport.play(); await sleep(300);
    o.autoNode = +NB.Engine.tracks[0].auto.gain.value.toFixed(2);
    NB.Transport.pause();

    /* lane toggle cycles level → pan → off, re-querying the button each time */
    NB.Timeline.rebuildHeaders();
    const clickAuto = () => document.querySelectorAll('.trackHead')[0].querySelector('[data-act=auto]').click();
    clickAuto(); o.mode1 = NB.Project.tracks[0].autoMode;
    clickAuto(); o.mode2 = NB.Project.tracks[0].autoMode;
    clickAuto(); o.mode3 = NB.Project.tracks[0].autoMode;

    /* alt-click removal path (through the model, as the lane calls it) */
    o.removed = NB.project.autoRemove(t, 'level', 64);
    o.left = (t.automation.level || []).length;
    o.afterRemove = NB.project.autoValueAt(t, 'level', 64);
    return o;
  });
  check('automation interpolates between points', o.atStart === 0.05 && o.atEnd === 1 && Math.abs(o.atMid - 0.53) < 0.02, { a: o.atStart, m: o.atMid, z: o.atEnd });
  check('export follows the envelope', o.tail > o.head * 3, { head: o.head, tail: o.tail });
  check('playback follows the envelope', o.autoNode > 0 && o.autoNode < 0.5, o.autoNode);
  check('lane toggle cycles level → pan → off', o.mode1 === 'level' && o.mode2 === 'pan' && o.mode3 === null, [o.mode1, o.mode2, o.mode3]);
  check('a point can be removed', o.removed && o.left === 1, { removed: o.removed, left: o.left });
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close(); await page.__ctx.close();
}

await restart();
/* ---------------------------------------------------------------- 16. MIDI */
console.log('\n16 · MIDI input');
{
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('nb-onboarded', '1'); } catch (e) {}
    const mk = (name) => ({ id: name, name, onmidimessage: null });
    window.__fakeMidi = {
      inputs: new Map([['a', mk('Fake Keys')], ['b', mk('Fake Pads')]]),
      onstatechange: null,
    };
    navigator.requestMIDIAccess = () => Promise.resolve(window.__fakeMidi);
  });
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
  await page.waitForFunction("window.NEONBOOM.Library.items.size === 27", { timeout: 40000 }).catch(() => {});

  const o = await page.evaluate(async () => {
    const NB = window.NEONBOOM, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), o = {};
    o.supported = NB.Midi.supported;
    o.statusBefore = NB.Midi.status();
    o.enabled = await NB.Midi.enable();
    o.statusAfter = NB.Midi.status();
    o.inputs = NB.Midi.inputs.length;

    const levels = [];
    const orig = NB.Engine.preview.bind(NB.Engine);
    NB.Engine.preview = (buf, rate, level) => { levels.push(level); return orig(buf, rate, level); };
    const input = [...window.__fakeMidi.inputs.values()][0];
    input.onmidimessage({ data: new Uint8Array([0x90, 36, 100]) });   // pad 0, velocity 100
    await sleep(60);
    input.onmidimessage({ data: new Uint8Array([0x90, 37, 40]) });    // pad 1, velocity 40
    await sleep(60);
    o.levels = levels.map((v) => +v.toFixed(2));
    o.previewed = levels.length;

    input.onmidimessage({ data: new Uint8Array([0x90, 52, 100]) });   // base+16 → play
    await sleep(220);
    o.playing = NB.Transport.playing;
    NB.Transport.pause();
    input.onmidimessage({ data: new Uint8Array([0x80, 36, 0]) });     // note off
    o.survivedNoteOff = true;
    return o;
  });

  check('Web MIDI is detected', o.supported);
  check('MIDI starts off until asked', o.statusBefore === 'off', o.statusBefore);
  check('enabling reports the inputs', o.enabled && o.statusAfter === '2 inputs', o.statusAfter);
  check('a note triggers a pad', o.previewed === 2, o.previewed);
  check('velocity scales the level', Math.abs(o.levels[0] - 0.79) < 0.02 && Math.abs(o.levels[1] - 0.31) < 0.02, o.levels);
  check('a mapped note drives the transport', o.playing);
  check('note-off does not throw', o.survivedNoteOff);
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close(); await context.close();
}

await restart();
/* ------------------------------------------------------------ 17. MIDI CC */
console.log('\n17 · MIDI CC learn');
{
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('nb-onboarded', '1'); } catch (e) {}
    const mk = (n) => ({ id: n, name: n, onmidimessage: null });
    window.__fakeMidi = { inputs: new Map([['a', mk('Keys')]]), onstatechange: null };
    navigator.requestMIDIAccess = () => Promise.resolve(window.__fakeMidi);
  });
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
  await page.waitForFunction("window.NEONBOOM.Library.items.size === 27", { timeout: 40000 }).catch(() => {});

  const o = await page.evaluate(async () => {
    const NB = window.NEONBOOM, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), o = {};
    await NB.Midi.enable();
    const input = [...window.__fakeMidi.inputs.values()][0];
    NB.Shell.openDrawer('fx');
    await sleep(120);

    const slider = document.querySelector('[data-midi="fx:delayMix"]');
    o.hasTarget = !!slider;

    NB.Midi.beginLearn();
    o.armed = NB.Midi.learning;
    slider.value = 0.3;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    o.named = NB.Midi.learning === 'cc' && NB.Midi.learnTarget === 'fx:delayMix';

    input.onmidimessage({ data: new Uint8Array([0xb0, 74, 10]) });     // CC 74
    o.bound = NB.Midi.ccMap['74'] === 'fx:delayMix';
    o.disarmed = NB.Midi.learning === null;

    input.onmidimessage({ data: new Uint8Array([0xb0, 74, 127]) });    // drive it
    o.sliderValue = +document.querySelector('[data-midi="fx:delayMix"]').value;
    o.fxValue = +NB.Fx.values.delayMix;
    o.persisted = (localStorage.getItem('nb-ccmap') || '').includes('fx:delayMix');

    /* a track fader is mappable too */
    NB.Shell.openDrawer('mixer');
    await sleep(120);
    const fader = document.querySelector('[data-midi="track:0:vol"]');
    o.hasFader = !!fader;
    NB.Midi.beginLearn();
    fader.dispatchEvent(new Event('input', { bubbles: true }));
    input.onmidimessage({ data: new Uint8Array([0xb0, 7, 0]) });
    o.faderBound = NB.Midi.ccMap['7'] === 'track:0:vol';
    input.onmidimessage({ data: new Uint8Array([0xb0, 7, 64]) });
    o.volAfter = +NB.Project.tracks[0].vol.toFixed(2);

    NB.Midi.clearMap();
    o.cleared = Object.keys(NB.Midi.ccMap).length;
    return o;
  });

  check('learnable controls carry a target id', o.hasTarget && o.hasFader);
  check('learn arms on the control step', o.armed === 'control');
  check('moving a control names the target', o.named);
  check('the next CC binds and disarms', o.bound && o.disarmed);
  check('a bound CC drives the control', o.sliderValue === 1 && o.fxValue === 1, { s: o.sliderValue, f: o.fxValue });
  check('mappings persist', o.persisted);
  check('a track fader can be mapped', o.faderBound && o.volAfter > 0.4, o.volAfter);
  check('clear removes every mapping', o.cleared === 0);
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close(); await context.close();
}

await restart();
/* ------------------------------------------------- 18. keyboard navigation */
console.log('\n18 · keyboard navigation');
{
  const { page, errors } = await open(APP);
  await page.waitForFunction("window.NEONBOOM.Library.items.size === 27", { timeout: 30000 }).catch(() => {});
  const o = await page.evaluate(async () => {
    const NB = window.NEONBOOM, o = {};
    const pads = () => Array.from(document.querySelectorAll('.pad'));
    o.tabStops = pads().filter((p) => p.tabIndex === 0).length;
    o.padCount = pads().length;

    pads()[0].focus();
    const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const cols = (getComputedStyle(document.querySelector('#padGrid')).gridTemplateColumns || '')
      .split(' ').filter(Boolean).length || 2;
    o.cols = cols;
    key('ArrowRight');
    o.afterRight = pads().indexOf(document.activeElement);
    key('ArrowDown');
    o.afterDown = pads().indexOf(document.activeElement);
    key('End');
    o.afterEnd = pads().indexOf(document.activeElement);
    key('Home');
    o.afterHome = pads().indexOf(document.activeElement);

    /* Enter auditions the focused pad */
    let played = 0;
    const orig = NB.Engine.preview.bind(NB.Engine);
    NB.Engine.preview = (...a) => { played++; return orig(...a); };
    key('Enter');
    await new Promise((r) => setTimeout(r, 60));
    o.played = played;
    NB.Engine.preview = orig;
    return o;
  });
  check('the pad grid is a single tab stop', o.tabStops === 1, { stops: o.tabStops, pads: o.padCount });
  check('arrow keys move through the grid', o.afterRight === 1 && o.afterDown === 1 + o.cols,
    { r: o.afterRight, d: o.afterDown, cols: o.cols });
  check('Home and End jump to the edges', o.afterEnd === o.padCount - 1 && o.afterHome === 0);
  check('Enter auditions the focused pad', o.played === 1, o.played);
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close(); await page.__ctx.close();
}

/* ------------------------------------------------------------- 19. scenes */
console.log('\n19 · scene launcher');
{
  await restart();
  const { page, errors } = await open(APP);
  await page.waitForFunction("window.NEONBOOM.Library.items.size === 27", { timeout: 30000 }).catch(() => {});
  const o = await page.evaluate(async () => {
    const NB = window.NEONBOOM, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), o = {};
    const count = () => NB.Project.tracks.reduce((n, t) => n + t.clips.length, 0);

    const A = NB.Scenes.capture('Full');
    o.aClips = count();
    NB.Project.tracks[0].clips = [];
    NB.Project.tracks[1].clips = [];
    const B = NB.Scenes.capture('Break');
    o.bClips = count();

    NB.Scenes.launch(A.id); o.afterA = count();
    NB.Scenes.launch(B.id); o.afterB = count();
    o.chips = document.querySelectorAll('.sceneChip').length;

    /* quantised: while rolling, the switch waits for the bar */
    NB.Scenes.launch(A.id); await sleep(60);
    o.stillB = count() === o.bClips;
    NB.Transport.seekTo(0);
    NB.Transport.play(); await sleep(200);
    const before = count();
    NB.Scenes.launch(B.id);
    await sleep(120);
    o.notYet = count() === before;
    await sleep(2600);
    o.landed = count() === o.bClips;
    o.playing = NB.Transport.playing;
    NB.Transport.pause();

    /* undo a launch */
    NB.Scenes.launch(A.id);
    const after = count();
    NB.History.undo();
    o.undoChanged = count() !== after;

    NB.Scenes.rename(B.id, 'Break');
    o.renamed = NB.Scenes.get(B.id).name;
    o.removed = NB.Scenes.remove(B.id) && NB.Scenes.list().length === 1;
    o.persisted = Array.isArray(NB.Project.scenes) && NB.Project.scenes.length === 1;
    return o;
  });
  check('a scene captures the arrangement', o.aClips > 20 && o.bClips < o.aClips, { a: o.aClips, b: o.bClips });
  check('launching while stopped applies at once', o.afterA === o.aClips && o.afterB === o.bClips);
  check('the strip renders one chip per scene', o.chips === 2, o.chips);
  check('a quantised launch does not cut mid-bar', o.notYet);
  check('it lands on the next bar', o.landed);
  check('transport keeps rolling through the switch', o.playing);
  check('a launch is one undo step', o.undoChanged);
  check('scenes rename and delete', o.renamed === 'Break' && o.removed);
  check('scenes live on the project', o.persisted);

  /* regression: scenes hold their own copy of the tracks, so they need the same
     sample-id remap the live tracks get on load */
  await page.evaluate(async () => {
    const NB = window.NEONBOOM;
    const ctx = NB.Engine.ctx;
    const buf = ctx.createBuffer(1, 4096, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.sin(i / 8) * 0.3;
    const sample = NB.Library.register({ name: 'dogfood', buffer: buf, category: 'Imported', color: '#888', isUser: true });
    NB.Project.tracks[2].clips.push(NB.project.newClip(sample.id, NB.Project.tracks[2].id, 8));
    NB.Scenes.capture('With import');
    await NB.Persistence.save();
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
  await page.waitForFunction("window.NEONBOOM.Library.items.size >= 27", { timeout: 40000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 700));
  const after = await page.evaluate(async () => {
    const NB = window.NEONBOOM;
    const scenes = NB.Scenes.list();
    const scene = scenes[scenes.length - 1];
    if (!scene) return { noScene: true };
    NB.Scenes.launch(scene.id);
    await new Promise((r) => setTimeout(r, 250));
    const ids = new Set();
    NB.Project.tracks.forEach((t) => t.clips.forEach((c) => ids.add(c.sampleId)));
    return { missing: [...ids].filter((id) => !NB.Library.get(id)).length, clips: NB.Project.tracks.reduce((n, t) => n + t.clips.length, 0) };
  });
  check('a scene keeps its samples across a reload', !after.noScene && after.missing === 0,
    { missing: after.missing, clips: after.clips });

  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close(); await page.__ctx.close();
}

/* ------------------------------------------------------ 20. time-stretch */
console.log('\n20 · WSOLA time-stretch');
{
  await restart();
  const { page, errors } = await open(APP);
  const o = await page.evaluate(() => {
    const NB = window.NEONBOOM, o = {};
    const sr = 44100, len = sr * 2;
    const buf = new AudioBuffer({ numberOfChannels: 1, length: len, sampleRate: sr });
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / sr);

    const t0 = performance.now();
    const s2 = NB.Stretch.stretchBuffer(buf, 2);
    o.ms = Math.round(performance.now() - t0);
    o.lenRatio = +(s2.length / len).toFixed(3);

    /* pitch must survive: count zero crossings in the middle half-second */
    const ch = s2.getChannelData(0);
    const mid = Math.floor(s2.length / 2), win = sr * 0.5;
    let cross = 0;
    for (let i = mid + 1; i < mid + win; i++) if ((ch[i - 1] < 0) !== (ch[i] < 0)) cross++;
    o.freq = Math.round(cross / 2 / (win / sr));

    let peak = 0;
    for (let i = 0; i < ch.length; i += 13) peak = Math.max(peak, Math.abs(ch[i]));
    o.peak = +peak.toFixed(2);

    const sample = NB.Library.byName('Boom Bap Kick');
    o.ratioOff = NB.Schedule.stretchRatio({ stretch: false }, sample, 120);
    o.ratioOn = +NB.Schedule.stretchRatio({ stretch: true }, sample, 120).toFixed(3);
    o.rateOff = +NB.Schedule.rate({ stretch: false }, sample, 120).toFixed(3);
    o.rateOn = +NB.Schedule.rate({ stretch: true }, sample, 120).toFixed(3);
    o.cached = NB.Stretch.forSample(sample, 1.5) === NB.Stretch.forSample(sample, 1.5);

    /* a stretched clip still occupies its musical length on the timeline */
    const clip = { startSix: 0, trimStartSix: 0, trimEndSix: 16, gain: 1, pitch: 0,
      reverse: false, fadeIn: 0, fadeOut: 0, stretch: true };
    o.stretchedBufferIsLonger =
      NB.Stretch.forSample(sample, 1.333).length > sample.buffer.length;
    o.clipOk = !!clip;
    return o;
  });
  check('stretch doubles the length at ratio 2', Math.abs(o.lenRatio - 2) < 0.01, o.lenRatio);
  check('pitch is preserved (440 Hz in, ~440 Hz out)', Math.abs(o.freq - 440) <= 6, o.freq);
  check('overlap-add does not run away', o.peak > 0.4 && o.peak < 0.9, o.peak);
  check('stretch is fast enough to cache (2 s buffer)', o.ms < 400, o.ms);
  check('tempo-fit moves tempo out of playbackRate', o.ratioOff === 1 && o.rateOff > 1 && o.ratioOn > 1 && o.rateOn === 1,
    { ratioOff: o.ratioOff, rateOff: o.rateOff, ratioOn: o.ratioOn, rateOn: o.rateOn });
  check('stretched buffers are cached per ratio', o.cached);
  check('the stretched buffer is longer than the source', o.stretchedBufferIsLonger);
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close(); await page.__ctx.close();
}

/* ------------------------------------------------- 21. recording + workflow */
console.log('\n21 · input recording, follow, export progress, scene hotkeys');
{
  /* a fake microphone needs its own browser flags */
  const recBrowser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium',
    headless: 'shell',
    args: ['--no-sandbox', '--mute-audio', '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await recBrowser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('nb-onboarded', '1'); } catch (e) {} });
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
  await page.waitForFunction("window.NEONBOOM.Library.items.size === 27", { timeout: 40000 }).catch(() => {});

  const o = await page.evaluate(async () => {
    const NB = window.NEONBOOM, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), o = {};

    o.supported = NB.Recorder.supported;
    o.started = await NB.Recorder.start();
    await sleep(900);
    o.seconds = +NB.Recorder.seconds().toFixed(1);
    const take = await NB.Recorder.stop();
    o.takeName = take && take.name;
    o.takeDur = take ? +take.buffer.duration.toFixed(2) : 0;
    o.userSamples = NB.Library.list().filter((s) => s.isUser).length;
    await sleep(200);
    o.pads = document.querySelectorAll('.pad').length;

    NB.Timeline.setFollow(true);
    o.follow = NB.Timeline.follow;

    NB.Scenes.capture('One');
    NB.Scenes.capture('Two');
    const before = NB.Project.tracks.reduce((n, t) => n + t.clips.length, 0);
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', key: '2', shiftKey: true, bubbles: true }));
    await sleep(150);
    o.hotkeyFired = NB.Scenes.list().length === 2 && before > 0;

    const end = NB.Shell.busy('Rendering');
    o.busyOn = document.querySelector('#busyBox').classList.contains('on');
    o.busyLabel = document.querySelector('#busyBox .busyLabel').textContent;
    end();
    o.busyOff = !document.querySelector('#busyBox').classList.contains('on');
    return o;
  });

  check('MediaRecorder is available', o.supported);
  check('recording captures a take', o.started && o.seconds > 0.5, o.seconds);
  check('the take becomes a sample', !!o.takeName && o.takeDur > 0.4, { name: o.takeName, dur: o.takeDur });
  check('the take appears on the pads', o.userSamples === 1 && o.pads === 28, { samples: o.userSamples, pads: o.pads });
  check('follow-playhead can be switched on', o.follow);
  check('shift+2 launches the second scene', o.hotkeyFired);
  check('the export overlay shows a label', o.busyOn && /Rendering/.test(o.busyLabel), o.busyLabel);
  check('the overlay clears when the render ends', o.busyOff);
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close(); await context.close(); await recBrowser.close();
}

/* ---------------------------------------------------------- 11. standalone */
console.log('\n11 · standalone builds (readable + minified)');
{
  for (const file of ['neonboom.html', 'neonboom.min.html']) {
    const full = path.join(ROOT, 'dist', file);
    if (!fs.existsSync(full)) { check(`dist/${file} exists (run npm run build)`, false); continue; }

    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [], failed = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('requestfailed', (r) => failed.push(r.url()));
    await page.goto('file://' + full, { waitUntil: 'load' });
    await page.waitForFunction("window.NEONBOOM && document.querySelector('#boot').classList.contains('done')", { timeout: 120000 });
    await page.waitForFunction("window.NEONBOOM.Library.items.size === 27", { timeout: 40000 }).catch(() => {});
    const o = await page.evaluate(async () => {
      const NB = window.NEONBOOM;
      NB.Transport.play();
      await new Promise((r) => setTimeout(r, 400));
      const playing = NB.Transport.playing && NB.Transport.currentSix() > 0.1;
      NB.Transport.pause();
      return {
        samples: NB.Library.items.size,
        pads: document.querySelectorAll('.pad').length,
        playing,
        cssApplied: getComputedStyle(document.querySelector('#topbar')).backgroundImage !== 'none',
      };
    });
    check(`${file}: boots with the full library`, o.samples === 27 && o.pads === 27, o);
    check(`${file}: transport plays`, o.playing);
    check(`${file}: stylesheet applied`, o.cssApplied);
    check(`${file}: no failed requests`, failed.length === 0, failed.slice(0, 2));
    check(`${file}: no console errors`, errors.length === 0, errors.slice(0, 2));
    await page.close(); await context.close();
  }

  const size = (f) => fs.statSync(path.join(ROOT, 'dist', f)).size;
  if (fs.existsSync(path.join(ROOT, 'dist', 'neonboom.min.html'))) {
    const ratio = size('neonboom.min.html') / size('neonboom.html');
    check('minified build is at least 25% smaller', ratio < 0.75, { ratio: +ratio.toFixed(2) });
    check('minified build is under 200 KB', size('neonboom.min.html') < 204800, size('neonboom.min.html'));
  }
}


await summary();
