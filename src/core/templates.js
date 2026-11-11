/* =========================================================================
   NEONBOOM · core/templates.js
   Starting points built from the same loop library — no extra assets, no
   presets to keep in sync. Each template is a function that fills Project.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { uid, SIX_PER_BAR } = NB.util;

  const BAR = SIX_PER_BAR;

  function make(name, bpm, tracks) {
    return { name, bpm, tracks };
  }

  /* fill a track with `count` copies of a loop every `everySix` sixteenths */
  function fill(project, trackIdx, sampleName, everySix, count, offset = 0, gain = 1) {
    const s = NB.Library.byName(sampleName);
    if (!s) return;
    const t = project.tracks[trackIdx];
    if (!t) return;
    const len = Math.round(s.beats * 4);
    for (let i = 0; i < count; i++) {
      t.clips.push({
        id: uid('clp'), sampleId: s.id, trackId: t.id,
        startSix: offset + i * everySix, lengthSix: len,
        trimStartSix: 0, trimEndSix: len, gain,
        pitch: 0, reverse: false, fadeIn: 0, fadeOut: 0,
      });
    }
  }

  const Templates = {
    list() {
      return [
        { id: 'boombap', name: 'Boom Bap', bpm: 92, bars: 8, blurb: 'Kick, snare, hats, 808 and a stabbed chord — the classic.' },
        { id: 'trap', name: 'Trap', bpm: 140, bars: 8, blurb: 'Rolling 32nd hats, ghost snares and a sliding 808.' },
        { id: 'house', name: 'House', bpm: 124, bars: 8, blurb: 'Four on the floor, shaker, dub chord and an arp.' },
        { id: 'empty', name: 'Empty grid', bpm: 90, bars: 8, blurb: 'Eight empty tracks, swing at zero. Start from nothing.' },
      ];
    },

    build(id) {
      const P = NB.Project;
      NB.project.initTracks(8);
      const t = P.tracks;
      const names = ['Drums', 'Snare', 'Hats', 'Bass', 'Chords', 'Lead', 'FX', 'Accents'];
      names.forEach((n, i) => { t[i].name = n; });
      P.loopIn = 0;
      P.loopOut = BAR * 8;
      P.loopEnabled = true;
      P.swing = 0;
      P.fx = null;

      if (id === 'boombap') {
        P.name = 'Boom Bap';
        P.bpm = 92;
        fill(P, 0, 'Boom Bap Kick', BAR, 8);
        fill(P, 1, 'Snare + Clap', BAR, 8);
        fill(P, 2, 'Hi-Hat Roll', BAR, 8);
        fill(P, 3, '808 Slide Bass', BAR * 2, 4);
        fill(P, 4, 'Synth Stab Chord', BAR * 2, 4);
        fill(P, 5, 'Arp Pluck Loop', BAR * 4, 2);
        fill(P, 6, 'Vinyl Crackle Bed', BAR * 4, 2);
        fill(P, 7, 'Crash Accent', BAR * 4, 2);
        t[0].vol = 0.92; t[1].vol = 0.78; t[2].vol = 0.46;
        t[4].vol = 0.55; t[5].vol = 0.48; t[6].vol = 0.32; t[7].vol = 0.62;
        t[3].sendB = 0.08;
        P.swing = 0.08;
      } else if (id === 'trap') {
        P.name = 'Trap';
        P.bpm = 140;
        fill(P, 0, 'Trap Kick Pattern', BAR, 8);
        fill(P, 1, 'Trap Snare + Ghosts', BAR, 8);
        fill(P, 2, 'Trap Hat Rolls (32nd)', BAR, 8);
        fill(P, 3, 'Trap 808 Pattern', BAR * 2, 4);
        fill(P, 4, 'Dub Chord', BAR * 4, 2);
        fill(P, 5, 'Bell Melody', BAR * 4, 2);
        fill(P, 6, 'Vinyl Crackle Bed', BAR * 4, 2);
        fill(P, 7, 'Impact Hit', BAR * 4, 2);
        t[0].vol = 0.9; t[1].vol = 0.7; t[2].vol = 0.42;
        t[3].vol = 0.85; t[4].vol = 0.4; t[5].vol = 0.35;
        t[6].vol = 0.25; t[7].vol = 0.55;
        t[3].sendB = 0.12; t[5].sendA = 0.25; t[5].sendB = 0.3;
        P.swing = 0.12;
      } else if (id === 'house') {
        P.name = 'House';
        P.bpm = 124;
        fill(P, 0, 'Four-on-Floor Kick', BAR, 8);
        fill(P, 1, 'Snare + Clap', BAR * 2, 4, BAR);
        fill(P, 2, 'Shaker Loop', BAR, 8);
        fill(P, 3, 'Sub Bass Drone', BAR * 2, 4);
        fill(P, 4, 'Dub Chord', BAR * 2, 4);
        fill(P, 5, 'Arp Pluck Loop', BAR * 2, 4);
        fill(P, 6, 'Riser FX', BAR * 8, 1);
        fill(P, 7, 'Crash Accent', BAR * 4, 2);
        t[0].vol = 0.9; t[1].vol = 0.55; t[2].vol = 0.4;
        t[3].vol = 0.75; t[4].vol = 0.5; t[5].vol = 0.42;
        t[6].vol = 0.3; t[7].vol = 0.5;
        t[4].sendA = 0.3; t[4].sendB = 0.25; t[5].sendA = 0.35; t[5].sendB = 0.2;
        P.swing = 0;
      } else {
        P.name = 'Untitled beat';
        P.bpm = 90;
        P.loopEnabled = false;
      }
      return P;
    },
  };

  NB.Templates = Templates;
})(window.NB = window.NB || {});
