/* =========================================================================
   NEONBOOM · app.js
   Boot sequence: engine → synthesise the loop library (parallel) → mount UI
   → restore autosave (or load the demo on first run) → reveal.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { $, toast } = NB.util;

  const LOOP_MANIFEST = [
    /* name, category, generator — order is stable so saved projects keep
       resolving to the same samples across versions */
    ['Boom Bap Kick', 'Drums', 'boomBapKick'],
    ['Snare + Clap', 'Drums', 'boomBapSnareClap'],
    ['Hi-Hat Roll', 'Drums', 'hatRoll'],
    ['808 Slide Bass', 'Bass', 'bassline808'],
    ['Synth Stab Chord', 'Synths', 'stabLoop'],
    ['Vinyl Scratch Hit', 'Scratch & FX', 'scratchOneShot'],
    ['Crash Accent', 'Scratch & FX', 'crashOneShot'],
    ['Trap Kick Pattern', 'Drums', 'trapKickPattern'],
    ['Four-on-Floor Kick', 'Drums', 'fourOnFloorKick'],
    ['Trap Snare + Ghosts', 'Drums', 'trapSnareGhosts'],
    ['Rimshot Pattern', 'Drums', 'rimshotPattern'],
    ['Trap Hat Rolls (32nd)', 'Drums', 'trapHatRolls'],
    ['Shaker Loop', 'Drums', 'shakerLoop'],
    ['Cowbell Pattern', 'Drums', 'cowbellPattern'],
    ['Tom Fill', 'Drums', 'tomFill'],
    ['Ride Cymbal Loop', 'Drums', 'rideLoop'],
    ['Sub Bass Drone', 'Bass', 'subBassDrone'],
    ['Trap 808 Pattern', 'Bass', 'trap808Pattern'],
    ['Arp Pluck Loop', 'Synths', 'arpPluckLoop'],
    ['Pad Swell', 'Synths', 'padSwell'],
    ['Bell Melody', 'Synths', 'bellMelody'],
    ['Scratch Loop', 'Scratch & FX', 'scratchLoopPattern'],
    ['Riser FX', 'Scratch & FX', 'riserFx'],
    ['Impact Hit', 'Scratch & FX', 'impactOneShot'],
    ['Vinyl Crackle Bed', 'Scratch & FX', 'vinylCrackle'],
    ['Boom Bap Full Loop', 'Drums', 'boomBapFull'],
    ['Dub Chord', 'Synths', 'dubChord'],
  ];

  const App = {
    version: '2.5.0',

    async boot() {
      const bar = $('#bootBar'), msg = $('#bootMsg');
      const set = (pct, text) => {
        bar.style.width = pct + '%';
        if (text) msg.textContent = text;
      };

      const T = { start: performance.now() };
      const mark = (k) => { T[k] = Math.round(performance.now() - T.start); };
      let hydrated = 0;
      set(4, 'starting audio engine…');
      NB.Engine = new NB.AudioEngine();
      const E = NB.Engine;
      await E.init();                       // registers the AudioWorklet module

      mark('engine');

      /* ---------- which loops matter first ----------
         The demo beat and the first screenful of pads only need these. They are
         hydrated from cache (or synthesised) before the veil lifts; everything
         else arrives in the background. */
      const PRIORITY = new Set(['boomBapKick', 'boomBapSnareClap', 'hatRoll', 'bassline808',
        'stabLoop', 'arpPluckLoop', 'vinylCrackle', 'crashOneShot',
        'scratchOneShot', 'trapKickPattern', 'fourOnFloorKick', 'trapSnareGhosts',
        'rimshotPattern', 'trapHatRolls']);

      const idOf = (fn) => 'loop_' + fn;
      const register = (name, category, fn, i, buffer, beats) => {
        NB.Library.register({
          id: idOf(fn), name, buffer, category,
          color: NB.util.TRACK_COLORS[i % NB.util.TRACK_COLORS.length],
          beats,
        });
      };
      const hydrateRows = (rows) => {
        let n = 0;
        LOOP_MANIFEST.forEach(([name, category, fn], i) => {
          if (NB.Library.has(idOf(fn))) return;
          const row = rows.get(NB.LoopCache.key(idOf(fn)));
          if (!row) return;
          try {
            register(name, category, fn, i, NB.LoopCache.hydrate(row, E.ctx), row.beats);
            n++;
          } catch (err) { /* corrupt row: it will be re-synthesised */ }
        });
        return n;
      };

      const renderOne = async ([name, category, fn], i) => {
        if (NB.Library.has(idOf(fn))) return;
        try {
          const { buffer, beats } = await NB.Synth[fn].call(NB.Synth);
          register(name, category, fn, i, buffer, beats);
          NB.LoopCache.put(idOf(fn), buffer, beats);   // fire and forget
        } catch (err) {
          console.error('loop failed:', name, err);
        }
      };

      const runQueue = async (queue, workers) => {
        const q = queue.slice();
        await Promise.all(Array.from({ length: workers }, async () => {
          while (q.length) {
            const [entry, i] = q.shift();
            await renderOne(entry, i);
            done++;
            set(12 + (done / Math.max(1, totalPending)) * 72, `synthesising ${entry[0]}…`);
          }
        }));
      };

      const allEntries = LOOP_MANIFEST.map((entry, i) => [entry, i]);
      let done = 0;
      let totalPending = 0;

      /* ---------- storage, then the priority slice ---------- */
      set(8, 'restoring rendered loops…');
      try {
        await NB.Persistence.open();
        const priorityNames = LOOP_MANIFEST
          .filter(([, , fn]) => PRIORITY.has(fn))
          .map(([, , fn]) => idOf(fn));
        const rows = await NB.LoopCache.many(priorityNames);
        hydrated = hydrateRows(rows);
      } catch (err) {
        console.warn('storage unavailable — loops will render every boot', err);
      }
      mark('storage');

      /* ---------- the optional side pack sits between cache and synth ----------
         It is only pulled automatically when the pack ships *with* the app
         (a <meta> the desktop/Android build injects) or when the URL asks for
         it. Auto-downloading 7 MB on the open web would be slower than just
         synthesising, so the web default is the "Load pack…" button. */
      const packLocal = !!document.querySelector('meta[name="neonboom-pack-local"]');
      const packAsked = new URLSearchParams(location.search).has('pack');
      if ((packLocal || packAsked) && !NB.Library.has(idOf('boomBapKick'))) {
        set(10, 'loading the bundled sample pack…');
        const got = await NB.LoopPack.tryAtBoot(E, packLocal ? 6000 : 2500);
        if (got > 0) {
          hydrated = got;
          set(12, `${got} loops from the pack`);
        } else if (got === -1) {
          NB.LoopPack.load(E).then((n) => { if (n) { NB.bus.emit('library:changed'); NB.Pads.render(); } });
        }
      }
      mark('packMs');

      const phase1 = allEntries.filter(([e]) => PRIORITY.has(e[2]) && !NB.Library.has(idOf(e[2])));
      const phase2 = allEntries.filter(([e]) => !PRIORITY.has(e[2]) && !NB.Library.has(idOf(e[2])));
      totalPending = phase1.length + phase2.length;

      if (hydrated) set(12, `${hydrated} loops restored from cache`);
      await runQueue(phase1, 6);
      mark('phase1');
      Object.assign(T, { hydrated, pack: NB.LoopPack.lastResult, packMs: T.packMs, phase1: phase1.length, phase2: phase2.length });
      App.timings = T;   // live reference: later marks keep landing in it

      /* ---------- project + UI ---------- */
      set(86, 'building the workspace…');
      NB.project.initTracks(8);
      E.ensureTrackBuses(NB.Project.tracks.length);

      NB.Timeline.init();
      NB.Pads.init();
      NB.Mixer.mount($('#drawerBody'));
      NB.Fx.mount(document.createElement('div'));
      NB.Inspector.mount($('#inspector'));
      NB.Shell.init();
      mark('ui');

      /* ---------- restore ---------- */
      set(94, 'looking for your last session…');
      let restored = false;
      try {
        restored = await NB.Persistence.load(E);
      } catch (err) {
        console.warn('storage unavailable — autosave off', err);
      }

      if (restored) {
        if (NB.Project.fx) { Object.assign(NB.Fx.values, NB.Project.fx); NB.Fx.render(); }
        E.ensureTrackBuses(NB.Project.tracks.length);
        E.applyMix(NB.Project.tracks);
        $('#bpm').value = NB.Project.bpm;
        NB.bus.emit('project:replaced');
        NB.bus.emit('library:changed');
        NB.Timeline.zoomFit();
      } else {
        NB.project.buildDemo();
        E.ensureTrackBuses(NB.Project.tracks.length);
        E.applyMix(NB.Project.tracks);
        $('#bpm').value = NB.Project.bpm;
        NB.bus.emit('project:replaced');
        NB.Timeline.zoomFit();
        setTimeout(() => toast('Demo beat loaded — press space to play', 'ok', 3600), 700);
      }

      mark('restore');
      NB.Shell.syncLoopBtn();
      NB.Shell.openDrawer('mixer');
      NB.Shell.maybeOnboard();

      /* ---------- the rest of the library, after the veil lifts ---------- */
      if (phase2.length) {
        setTimeout(async () => {
          let more = 0;
          try { more = hydrateRows(await NB.LoopCache.all()); } catch (e) {}
          if (more) { NB.bus.emit('library:changed'); NB.Pads.render(); }
          const stillMissing = allEntries.filter(([e]) => !NB.Library.has(idOf(e[2])));
          if (stillMissing.length) {
            totalPending = stillMissing.length; done = 0;
            await runQueue(stillMissing, 3);
            NB.bus.emit('library:changed');
            NB.Pads.render();
          }
          mark('phase2');
        }, 40);
      }

      mark('ready');
      set(100, 'ready');
      setTimeout(() => {
        $('#boot').classList.add('done');
        setTimeout(() => { $('#boot').style.display = 'none'; }, 320);
        NB.Timeline.resize();
        if (restored) toast('Restored your last session', '', 2200);
      }, 60);

      window.addEventListener('beforeunload', () => { NB.Persistence.save(); });

      /* expose for debugging / tests */
      window.NEONBOOM = NB;
    },
  };

  NB.App = App;
  window.addEventListener('DOMContentLoaded', () => {
    App.boot().catch((err) => {
      console.error(err);
      const msg = $('#bootMsg');
      if (msg) msg.textContent = 'Could not start: ' + err.message;
    });
  });
})(window.NB = window.NB || {});
