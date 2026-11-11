/* =========================================================================
   NEONBOOM · core/transport.js
   Playback clock, look-ahead scheduler, loop region, metronome, live refresh.

   Position is derived from the AudioContext clock (never from rAF drift).
   Clips are NOT all scheduled at once: a 25 ms ticker queues whatever falls
   inside a 180 ms horizon. That makes loop points sample-accurate (the old
   version wrapped with setTimeout), keeps tempo changes possible without a
   restart, and stops a 64-bar project from creating hundreds of nodes up
   front.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { Grid, SIX_PER_BAR, PROJECT_BARS } = NB.util;

  const LOOKAHEAD = 0.18;      // seconds of audio queued ahead of the clock
  const TICK_MS = 25;          // how often we top the queue up

  const Transport = {
    playing: false,
    posSix: 0,
    startCtxTime: 0,
    startPosSix: 0,
    rafId: 0,
    _tickTimer: 0,
    _metroTimer: 0,
    _metroLast: -1,
    _refreshTimer: 0,
    _tickFns: [],
    _events: [],               // {clip, sample, trackIdx, when, fromSix}, sorted by `when`
    _passStartCtx: 0,          // ctx time where the current pass begins
    _passStartSix: 0,          // timeline position where that pass begins

    get engine() { return NB.Engine; },
    get project() { return NB.Project; },

    onTick(fn) { this._tickFns.push(fn); },

    /* ------------------------------------------------------------- clock */
    currentSix() {
      if (!this.playing) return this.posSix;
      const P = this.project;
      let six = this.startPosSix + Grid.secToSix(Math.max(0, this.engine.ctx.currentTime - this.startCtxTime), P.bpm);
      if (P.loopEnabled && P.loopOut > P.loopIn && six >= P.loopOut) {
        const len = P.loopOut - P.loopIn;
        six = P.loopIn + ((six - P.loopIn) % len);
      }
      return six;
    },

    /* ----------------------------------------------------------- control */
    play() {
      const E = this.engine;
      E.resume();
      if (this.playing) return;
      this.playing = true;
      this.startCtxTime = E.ctx.currentTime + 0.06;
      this.startPosSix = this.posSix;
      this._events.length = 0;
      this._passStartCtx = this.startCtxTime;
      this._passStartSix = this.startPosSix;
      this._metroLast = -1;
      this._schedulerTick();
      this._startScheduler();
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
      clearInterval(this._tickTimer);
      this._stopMetronome();
      NB.bus.emit('transport', { playing: false });
    },

    stop() {
      this.pause();
      this.posSix = 0;
      this._events.length = 0;
      NB.bus.emit('transport', { playing: false, stopped: true });
      NB.bus.emit('playhead');
    },

    rewind() {
      const was = this.playing;
      this.pause();
      this.posSix = this.project.loopEnabled && this.posSix > this.project.loopIn ? this.project.loopIn : 0;
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

    /* Tempo can now change while rolling: re-anchor the clock and rebuild the
       queue instead of restarting playback. */
    setBpm(bpm) {
      const P = this.project;
      if (!this.playing) { P.bpm = bpm; return; }
      const pos = this.currentSix();
      this._stopAllSources();
      this._events.length = 0;
      P.bpm = bpm;
      this.posSix = pos;
      this.startPosSix = pos;
      this.startCtxTime = this.engine.ctx.currentTime + 0.03;
      this._passStartCtx = this.startCtxTime;
      this._passStartSix = pos;
      this._metroLast = -1;
      this._schedulerTick();
    },

    /* Re-anchor without touching the tempo (loop toggle, swing change). */
    reanchor() {
      if (!this.playing) return;
      const pos = this.currentSix();
      this._stopAllSources();
      this._events.length = 0;
      this.posSix = pos;
      this.startPosSix = pos;
      this.startCtxTime = this.engine.ctx.currentTime + 0.03;
      this._passStartCtx = this.startCtxTime;
      this._passStartSix = pos;
      this._metroLast = -1;
      this.project.tracks.forEach((t, i) => {
        const bus = this.engine.tracks[i];
        if (!bus || !bus.auto) return;
        bus.auto.gain.cancelScheduledValues(this.startCtxTime);
        bus.auto._autoActive = false;
        if (bus.panner) { bus.panner.pan.cancelScheduledValues(this.startCtxTime); bus.panner._autoActive = false; }
      });
      this._schedulerTick();
    },

    /* --------------------------------------------------------- scheduling */
    _stopAllSources() {
      const list = this.engine._activeSources;
      list.forEach((src) => { try { src.stop(); } catch (e) {} });
      list.length = 0;
    },

    /* Queue every clip that starts inside [passStart, end) for as many passes
       as the horizon needs. Looping simply advances to the next pass. */
    _fill(horizonCtx) {
      const P = this.project, bpm = P.bpm;
      const looping = P.loopEnabled && P.loopOut > P.loopIn;
      const endSix = looping ? P.loopOut : PROJECT_BARS * SIX_PER_BAR;
      const anySolo = P.tracks.some((t) => t.solo);
      let guard = 0;

      while (this._passStartCtx < horizonCtx && guard++ < 64) {
        const passStart = this._passStartSix;
        const passCtx = this._passStartCtx;

        P.tracks.forEach((track, ti) => {
          if (track.mute || (anySolo && !track.solo)) return;
          track.clips.forEach((clip) => {
            const end = clip.startSix + (clip.trimEndSix - clip.trimStartSix);
            if (end <= passStart) return;              // already finished
            if (clip.startSix >= endSix) return;       // outside the loop region
            const late = Math.max(0, passStart - clip.startSix);
            const when = passCtx + Grid.sixToSec(
              Math.max(0, clip.startSix - passStart) + NB.Schedule.swingOffsetSix(clip, P.swing), bpm);
            this._events.push({
              clip,
              sample: NB.Library.get(clip.sampleId),
              trackIdx: ti,
              when,
              fromSix: clip.startSix + late,          // skips the part already gone
            });
          });
        });

        const passLen = Grid.sixToSec(endSix - passStart, bpm);
        if (!looping || passLen <= 0.001) break;      // straight run: one pass
        this._passStartCtx = passCtx + passLen;
        this._passStartSix = P.loopIn;
      }

      if (this._events.length > 1) this._events.sort((a, b) => a.when - b.when);
    },

    _schedulerTick() {
      if (!this.playing) return;
      const E = this.engine;
      const horizon = E.ctx.currentTime + LOOKAHEAD;
      this._fill(horizon);

      this._applyAutomation(E.ctx.currentTime, horizon);

      const list = E._activeSources;
      while (this._events.length && this._events[0].when <= horizon) {
        const ev = this._events.shift();
        const bus = E.tracks[ev.trackIdx];
        if (!ev.sample || !bus) continue;
        const src = NB.Schedule.clip(E.ctx, bus.gain, ev.clip, ev.sample, {
          when: ev.when, fromSix: ev.fromSix, bpm: this.project.bpm, swing: this.project.swing,
        });
        if (src) { src._clipId = ev.clip.id; list.push(src); }
      }

      /* drop finished nodes so the list stays small */
      for (let i = list.length - 1; i >= 0; i--) if (list[i]._ended) list.splice(i, 1);
    },

    /* Ramp each automated track across the same window the clips are queued
       for, so the envelope moves with the audio clock, not the timer. */
    _applyAutomation(fromCtx, horizonCtx) {
      const P = this.project, E = this.engine;
      const sixAt = (t) => this.startPosSix + Grid.secToSix(Math.max(0, t - this.startCtxTime), P.bpm);
      const fromSix = sixAt(fromCtx), toSix = sixAt(horizonCtx);

      P.tracks.forEach((track, i) => {
        const bus = E.tracks[i];
        if (!bus || !bus.auto) return;
        const lvlFrom = NB.project.autoValueAt(track, 'level', fromSix);
        const lvlTo = NB.project.autoValueAt(track, 'level', toSix);
        const panFrom = NB.project.autoValueAt(track, 'pan', fromSix);
        const panTo = NB.project.autoValueAt(track, 'pan', toSix);

        if (lvlFrom == null) {
          if (bus.auto._autoActive) { bus.auto.gain.cancelScheduledValues(fromCtx); bus.auto.gain.setValueAtTime(1, fromCtx); bus.auto._autoActive = false; }
        } else {
          bus.auto._autoActive = true;
          bus.auto.gain.setValueAtTime(Math.max(0.0001, lvlFrom), fromCtx);
          bus.auto.gain.linearRampToValueAtTime(Math.max(0.0001, lvlTo == null ? lvlFrom : lvlTo), horizonCtx);
        }

        if (bus.panner) {
          if (panFrom == null) {
            if (bus.panner._autoActive) { bus.panner.pan.cancelScheduledValues(fromCtx); bus.panner._autoActive = false; }
          } else {
            bus.panner._autoActive = true;
            bus.panner.pan.setValueAtTime(panFrom, fromCtx);
            bus.panner.pan.linearRampToValueAtTime(panTo == null ? panFrom : panTo, horizonCtx);
          }
        }

        /* send automation */
        ['sendA', 'sendB'].forEach((kind) => {
          const node = bus[kind] && bus[kind].gain;
          if (!node) return;
          const from = NB.project.autoValueAt(track, kind, fromSix);
          const to = NB.project.autoValueAt(track, kind, toSix);
          if (from == null) {
            if (node._autoActive) { node.cancelScheduledValues(fromCtx); node._autoActive = false; }
          } else {
            node._autoActive = true;
            node.setValueAtTime(Math.max(0, from), fromCtx);
            node.linearRampToValueAtTime(Math.max(0, to == null ? from : to), horizonCtx);
          }
        });
      });
    },

    _startScheduler() {
      clearInterval(this._tickTimer);
      this._tickTimer = setInterval(() => this._schedulerTick(), TICK_MS);
    },

    /* Re-schedule after an edit so it is heard immediately, not on the next
       transport start. Already-playing audio is stopped (a deleted clip must
       go silent now); the gap is one refresh debounce. */
    refresh() {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => {
        if (!this.playing) return;
        this.reanchor();
      }, 30);
    },

    /* -------------------------------------------------------- metronome */
    _startMetronome() {
      clearInterval(this._metroTimer);
      this._metroTimer = setInterval(() => {
        const P = this.project;
        if (!this.playing || !P.metronome) return;
        const E = this.engine;
        const nowSix = this.currentSix();
        if (this._metroLast > nowSix + 1) this._metroLast = -1;   // loop wrapped
        const aheadSix = Grid.secToSix(0.16, P.bpm);
        let beat = Math.ceil((nowSix + 0.0001) / 4) * 4;
        while (beat < nowSix + aheadSix) {
          if (beat > this._metroLast) {
            const when = E.ctx.currentTime + Grid.sixToSec(beat - nowSix, P.bpm);
            E.click(Math.max(when, E.ctx.currentTime), beat % SIX_PER_BAR === 0);
            this._metroLast = beat;
          }
          beat += 4;
        }
      }, 40);
    },
    _stopMetronome() { clearInterval(this._metroTimer); this._metroTimer = 0; this._metroLast = -1; },

    /* ------------------------------------------------------------- tick */
    _tick() {
      if (!this.playing) return;
      this.posSix = this.currentSix();
      for (let i = 0; i < this._tickFns.length; i++) this._tickFns[i](this.posSix);
      NB.bus.emit('playhead', this.posSix);
      this.rafId = requestAnimationFrame(() => this._tick());
    },

    /* ------------------------------------------------- pad recording */
    recordPad(sampleId, trackId) {
      const P = this.project;
      const six = Math.round(this.currentSix() / P.snap) * P.snap;
      const track = P.tracks.find((t) => t.id === trackId) || P.tracks[0];
      NB.History.push('Record pad');
      const clip = NB.project.newClip(sampleId, track.id, Math.max(0, six));
      track.clips.push(clip);
      NB.bus.emit('clips:changed');
      return clip;
    },
  };

  NB.Transport = Transport;
})(window.NB = window.NB || {});
