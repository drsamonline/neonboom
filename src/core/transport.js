/* =========================================================================
   NEONBOOM · core/transport.js
   Playback clock, clip scheduling, loop region, metronome, live refresh.
   Position is derived from the AudioContext clock (never from rAF drift).
   ========================================================================= */
(function (NB) {
  'use strict';
  const { clamp, Grid, SIX_PER_BAR } = NB.util;

  const Transport = {
    playing: false,
    posSix: 0,
    startCtxTime: 0,
    startPosSix: 0,
    loopTimer: 0,
    rafId: 0,
    _metroTimer: 0,
    _metroLast: -1,
    _tickFns: [],
    _refreshTimer: 0,

    get engine() { return NB.Engine; },
    get project() { return NB.Project; },

    onTick(fn) { this._tickFns.push(fn); },

    /* ---------------- clock ---------------- */
    currentSix() {
      if (!this.playing) return this.posSix;
      const elapsed = this.engine.ctx.currentTime - this.startCtxTime;
      return this.startPosSix + Grid.secToSix(Math.max(0, elapsed), this.project.bpm);
    },

    play() {
      const E = this.engine;
      E.resume();
      if (this.playing) return;
      this.playing = true;
      this.startCtxTime = E.ctx.currentTime + 0.06;
      this.startPosSix = this.posSix;
      this._metroLast = -1;
      this._scheduleAll(this.startPosSix, this.startCtxTime);
      this._startMetronome();
      this._tick();
      NB.bus.emit('transport', { playing: true });
    },

    pause() {
      if (!this.playing) return;
      this.posSix = this.currentSix();
      this._stopAllSources();
      this.playing = false;
      cancelAnimationFrame(this.rafId);
      clearTimeout(this.loopTimer);
      this._stopMetronome();
      NB.bus.emit('transport', { playing: false });
    },

    stop() {
      this.pause();
      this.posSix = 0;
      NB.bus.emit('transport', { playing: false, stopped: true });
      NB.bus.emit('playhead');
    },

    rewind() {
      const was = this.playing;
      this.pause();
      this.posSix = Project.loopEnabled && this.posSix > Project.loopIn ? Project.loopIn : 0;
      NB.bus.emit('playhead');
      if (was) this.play();
    },

    seekTo(six) {
      const was = this.playing;
      this.pause();
      this.posSix = Math.max(0, six);
      NB.bus.emit('playhead');
      if (was) this.play();
    },

    toggle() { this.playing ? this.pause() : this.play(); },

    /* ---------------- scheduling ---------------- */
    _stopAllSources() {
      this.engine._activeSources.forEach((src) => { try { src.stop(); } catch (e) {} });
      this.engine._activeSources = [];
    },

    _scheduleAll(fromSix, ctxStartTime) {
      const E = this.engine, P = this.project;
      this._stopAllSources();
      const bpm = P.bpm;
      const anySolo = P.tracks.some((t) => t.solo);

      P.tracks.forEach((track, ti) => {
        if (track.mute || (anySolo && !track.solo)) return;
        track.clips.forEach((clip) => {
          const sample = NB.Library.get(clip.sampleId);
          if (!sample) return;
          const src = NB.Schedule.clip(E.ctx, E.tracks[ti].gain, clip, sample, {
            when: NB.Schedule.when(clip, fromSix, ctxStartTime, bpm, P.swing),
            fromSix, bpm, swing: P.swing,
          });
          if (src) E._activeSources.push(src);
        });
      });

      /* loop re-arm — only when the playhead is actually inside the region */
      clearTimeout(this.loopTimer);
      if (P.loopEnabled && fromSix < P.loopOut) {
        const untilEnd = Grid.sixToSec(P.loopOut - fromSix, bpm);
        this.loopTimer = setTimeout(() => {
          if (!this.playing) return;
          this.posSix = P.loopIn;
          this.startPosSix = P.loopIn;
          this.startCtxTime = E.ctx.currentTime + 0.02;
          this._metroLast = -1;
          this._scheduleAll(P.loopIn, this.startCtxTime);
        }, Math.max(20, untilEnd * 1000));
      }
    },

    /* Re-schedule after an edit (delete / split / move / undo) so the change is
       heard immediately instead of on the next transport start. */
    refresh() {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => {
        if (!this.playing) return;
        const pos = this.currentSix();
        this._stopAllSources();
        this.startPosSix = pos;
        this.posSix = pos;
        this.startCtxTime = this.engine.ctx.currentTime + 0.03;
        this._metroLast = -1;
        this._scheduleAll(pos, this.startCtxTime);
      }, 40);
    },

    /* ---------------- metronome ---------------- */
    _startMetronome() {
      clearInterval(this._metroTimer);
      this._metroTimer = setInterval(() => {
        const P = this.project;
        if (!this.playing || !P.metronome) return;
        const E = this.engine;
        const nowSix = this.currentSix();
        const aheadSix = Grid.secToSix(0.16, P.bpm);
        let beat = Math.ceil((nowSix + 0.0001) / 4) * 4;
        if (this._metroLast > nowSix) beat = Math.max(beat, Math.ceil((this._metroLast + 1) / 4) * 4);
        while (beat < nowSix + aheadSix) {
          if (beat > this._metroLast) {
            const when = this.startCtxTime + Grid.sixToSec(beat - this.startPosSix, P.bpm);
            if (when > E.ctx.currentTime - 0.01) E.click(Math.max(when, E.ctx.currentTime), beat % SIX_PER_BAR === 0);
            this._metroLast = beat;
          }
          beat += 4;
        }
      }, 40);
    },
    _stopMetronome() { clearInterval(this._metroTimer); this._metroTimer = 0; this._metroLast = -1; },

    /* ---------------- tick ---------------- */
    _tick() {
      if (!this.playing) return;
      this.posSix = this.currentSix();
      for (let i = 0; i < this._tickFns.length; i++) this._tickFns[i](this.posSix);
      NB.bus.emit('playhead', this.posSix);
      this.rafId = requestAnimationFrame(() => this._tick());
    },

    /* ---------------- pad recording ---------------- */
    recordPad(sampleId, trackId) {
      const P = this.project;
      const six = Math.round(this.currentSix() / P.snap) * P.snap;
      const track = P.tracks.find((t) => t.id === trackId) || P.tracks[0];
      NB.History.push();
      const clip = NB.project.newClip(sampleId, track.id, Math.max(0, six));
      track.clips.push(clip);
      NB.bus.emit('clips:changed');
      return clip;
    },
  };

  NB.Transport = Transport;
})(window.NB = window.NB || {});
