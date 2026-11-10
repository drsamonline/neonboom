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
    version: '1.1.0',

    async boot() {
      const bar = $('#bootBar'), msg = $('#bootMsg');
      const set = (pct, text) => {
        bar.style.width = pct + '%';
        if (text) msg.textContent = text;
      };

      set(4, 'starting audio engine…');
      NB.Engine = new NB.AudioEngine();
      const E = NB.Engine;

      /* ---------- synthesise the library, four renders at a time ---------- */
      set(8, 'synthesising loop library…');
      const total = LOOP_MANIFEST.length;
      let done = 0;
      const queue = LOOP_MANIFEST.slice();
      const workers = Array.from({ length: 6 }, async () => {
        while (queue.length) {
          const [name, category, fn] = queue.shift();
          try {
            const { buffer, beats } = await NB.Synth[fn].call(NB.Synth);
            NB.Library.register({
              id: 'loop_' + fn,
              name, buffer, category,
              color: NB.util.TRACK_COLORS[done % NB.util.TRACK_COLORS.length],
              beats,
            });
          } catch (err) {
            console.error('loop failed:', name, err);
          }
          done++;
          set(8 + (done / total) * 74, `synthesised ${done}/${total} · ${name}`);
        }
      });
      await Promise.all(workers);

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

      /* ---------- restore ---------- */
      set(94, 'looking for your last session…');
      let restored = false;
      try {
        await NB.Persistence.open();
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

      NB.Shell.syncLoopBtn();
      NB.Shell.openDrawer('mixer');

      set(100, 'ready');
      setTimeout(() => {
        $('#boot').classList.add('done');
        setTimeout(() => { $('#boot').style.display = 'none'; }, 400);
        NB.Timeline.resize();
        if (restored) toast('Restored your last session', '', 2200);
      }, 120);

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
