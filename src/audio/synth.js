/* =========================================================================
   NEONBOOM · audio/synth.js
   Procedural loop library. Every loop is rendered once, offline, into a real
   AudioBuffer at REF_BPM, so afterwards it behaves exactly like an imported
   sample (peaks, trim, tempo-sync via playbackRate).
   ========================================================================= */
(function (NB) {
  'use strict';
  const { REF_BPM } = NB.util;

  const Synth = {
    /* render a patch into a stereo buffer */
    async render(seconds, scheduleFn) {
      const rate = 44100;
      const oac = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
      scheduleFn(oac);
      return oac.startRendering();
    },

    /* White noise is full-band to Nyquist, which reads as fizz — especially
       once a 7 kHz high-pass has removed everything that would mask it. One
       gentle two-pole low-pass at ~11 kHz keeps hats and snares bright without
       the hiss. */
    noiseBuffer(ctx, seconds) {
      const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      /* two-pole low-pass, fc ≈ 11 kHz — before the return, obviously */
      const a = 1 - Math.exp(-2 * Math.PI * 11000 / ctx.sampleRate);
      let y1 = 0, y2 = 0;
      for (let i = 0; i < len; i++) {
        y1 += a * (d[i] - y1);
        y2 += a * (y1 - y2);
        d[i] = y2;
      }
      return buf;
    },

    /* ---------- one-shot voices ---------- */
    kickHit(ctx, t, dest, pitch = 150) {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      const g = ctx.createGain();
      osc.frequency.setValueAtTime(pitch, t);
      osc.frequency.exponentialRampToValueAtTime(38, t + 0.14);
      g.gain.setValueAtTime(1, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
      osc.connect(g); g.connect(dest);
      osc.start(t); osc.stop(t + 0.34);
    },
    snareHit(ctx, t, dest) {
      const noise = ctx.createBufferSource(); noise.buffer = this.noiseBuffer(ctx, 0.2);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(1, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      noise.connect(bp); bp.connect(ng); ng.connect(dest);
      const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 180;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.6, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      osc.connect(og); og.connect(dest);
      noise.start(t); noise.stop(t + 0.2); osc.start(t); osc.stop(t + 0.13);
    },
    clapHit(ctx, t, dest) {
      for (let i = 0; i < 3; i++) {
        const off = t + i * 0.011;
        const noise = ctx.createBufferSource(); noise.buffer = this.noiseBuffer(ctx, 0.09);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 4;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.5, off); g.gain.exponentialRampToValueAtTime(0.001, off + 0.08);
        noise.connect(bp); bp.connect(g); g.connect(dest); noise.start(off); noise.stop(off + 0.09);
      }
    },
    hatHit(ctx, t, dest, open = false) {
      const noise = ctx.createBufferSource(); noise.buffer = this.noiseBuffer(ctx, open ? 0.35 : 0.06);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.32 : 0.05));
      noise.connect(hp); hp.connect(g); g.connect(dest);
      noise.start(t); noise.stop(t + (open ? 0.35 : 0.07));
    },
    crashHit(ctx, t, dest) {
      const noise = ctx.createBufferSource(); noise.buffer = this.noiseBuffer(ctx, 1.2);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
      noise.connect(hp); hp.connect(g); g.connect(dest); noise.start(t); noise.stop(t + 1.2);
    },
    bass808(ctx, t, dur, dest, freq) {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.9, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(g); g.connect(dest); osc.start(t); osc.stop(t + dur + 0.05);

      /* octave-up saturated harmonic: makes the note audible on laptop/phone
         speakers that cannot reproduce the 40-60 Hz fundamental at all. */
      const osc2 = ctx.createOscillator(); osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(freq * 2, t);
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) { const x = (i / 255) * 2 - 1; curve[i] = Math.tanh(x * 2.2); }
      shaper.curve = curve; shaper.oversample = '2x';
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, t);
      g2.gain.linearRampToValueAtTime(0.35, t + 0.015);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, dur * 0.8));
      osc2.connect(shaper); shaper.connect(g2); g2.connect(dest);
      osc2.start(t); osc2.stop(t + dur + 0.05);
    },
    stabChord(ctx, t, dur, dest, freqs) {
      freqs.forEach((f, i) => {
        const osc = ctx.createOscillator(); osc.type = i === 0 ? 'sawtooth' : 'square';
        osc.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.001, t);
        g.gain.linearRampToValueAtTime(0.22, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
        osc.connect(lp); lp.connect(g); g.connect(dest); osc.start(t); osc.stop(t + dur + 0.05);
      });
    },
    scratchHit(ctx, t, dest) {
      const noise = ctx.createBufferSource(); noise.buffer = this.noiseBuffer(ctx, 0.5);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 6;
      bp.frequency.setValueAtTime(400, t);
      bp.frequency.linearRampToValueAtTime(2200, t + 0.12);
      bp.frequency.linearRampToValueAtTime(300, t + 0.28);
      bp.frequency.linearRampToValueAtTime(1800, t + 0.42);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.48);
      noise.connect(bp); bp.connect(g); g.connect(dest); noise.start(t); noise.stop(t + 0.5);
    },
    tomHit(ctx, t, dest, pitch = 180) {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      const g = ctx.createGain();
      osc.frequency.setValueAtTime(pitch, t);
      osc.frequency.exponentialRampToValueAtTime(pitch * 0.55, t + 0.22);
      g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      osc.connect(g); g.connect(dest); osc.start(t); osc.stop(t + 0.3);
    },
    rimHit(ctx, t, dest) {
      const osc = ctx.createOscillator(); osc.type = 'square'; osc.frequency.value = 1400;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
      osc.connect(g); g.connect(dest); osc.start(t); osc.stop(t + 0.05);
      const noise = ctx.createBufferSource(); noise.buffer = this.noiseBuffer(ctx, 0.04);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.3, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      noise.connect(hp); hp.connect(ng); ng.connect(dest); noise.start(t); noise.stop(t + 0.05);
    },
    shakerHit(ctx, t, dest) {
      const noise = ctx.createBufferSource(); noise.buffer = this.noiseBuffer(ctx, 0.09);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 6000; bp.Q.value = 0.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.28, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      noise.connect(bp); bp.connect(g); g.connect(dest); noise.start(t); noise.stop(t + 0.09);
    },
    cowbellHit(ctx, t, dest) {
      [800, 540].forEach((f) => {
        const osc = ctx.createOscillator(); osc.type = 'square'; osc.frequency.value = f;
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 3;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
        osc.connect(bp); bp.connect(g); g.connect(dest); osc.start(t); osc.stop(t + 0.3);
      });
    },
    rideHit(ctx, t, dest) {
      const noise = ctx.createBufferSource(); noise.buffer = this.noiseBuffer(ctx, 0.6);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000;
      const bell = ctx.createBiquadFilter();
      bell.type = 'peaking'; bell.frequency.value = 8000; bell.Q.value = 2; bell.gain.value = 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
      noise.connect(hp); hp.connect(bell); bell.connect(g); g.connect(dest);
      noise.start(t); noise.stop(t + 0.6);
    },
    arpNote(ctx, t, dur, dest, freq) {
      const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = freq;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(3500, t);
      lp.frequency.exponentialRampToValueAtTime(600, t + Math.max(0.03, dur * 0.9));
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.3, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(lp); lp.connect(g); g.connect(dest); osc.start(t); osc.stop(t + dur + 0.02);
    },
    padVoice(ctx, t, dur, dest, freqs) {
      freqs.forEach((f, i) => {
        const osc = ctx.createOscillator(); osc.type = i % 2 ? 'triangle' : 'sawtooth';
        osc.frequency.value = f * (1 + i * 0.002);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.14, t + dur * 0.4);
        g.gain.linearRampToValueAtTime(0.0001, t + dur);
        osc.connect(lp); lp.connect(g); g.connect(dest); osc.start(t); osc.stop(t + dur + 0.05);
      });
    },
    bellNote(ctx, t, dur, dest, freq) {
      [1, 2.4, 3.8].forEach((mult, i) => {
        const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = freq * mult;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.001, t);
        g.gain.linearRampToValueAtTime(0.28 / (i + 1), t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.connect(g); g.connect(dest); osc.start(t); osc.stop(t + dur + 0.05);
      });
    },
    riserSweep(ctx, t, dur, dest) {
      const noise = ctx.createBufferSource(); noise.buffer = this.noiseBuffer(ctx, dur);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(300, t);
      bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + dur * 0.92);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      noise.connect(bp); bp.connect(g); g.connect(dest); noise.start(t); noise.stop(t + dur + 0.05);
    },
    impactHit(ctx, t, dest) {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(120, t); osc.frequency.exponentialRampToValueAtTime(35, t + 0.9);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
      osc.connect(g); g.connect(dest); osc.start(t); osc.stop(t + 1.2);
      const noise = ctx.createBufferSource(); noise.buffer = this.noiseBuffer(ctx, 0.3);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 800;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.6, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      noise.connect(hp); hp.connect(ng); ng.connect(dest); noise.start(t); noise.stop(t + 0.3);
    },

    /* ---------- full loops (each declares its musical length in beats) ---- */
    async boomBapKick() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb;
      const buf = await this.render(secs, (oac) => {
        this.kickHit(oac, 0, oac.destination);
        this.kickHit(oac, 1.5 * spb, oac.destination, 140);
        this.kickHit(oac, 2.75 * spb, oac.destination, 140);
      });
      return { buffer: buf, beats };
    },
    boomBapSnareClap() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb;
      return this.render(secs, (oac) => {
        this.snareHit(oac, 1 * spb, oac.destination);
        this.clapHit(oac, 1 * spb, oac.destination);
        this.snareHit(oac, 3 * spb, oac.destination);
        this.clapHit(oac, 3 * spb, oac.destination);
      }).then((buf) => ({ buffer: buf, beats }));
    },
    hatRoll() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb;
      return this.render(secs, (oac) => {
        for (let i = 0; i < 16; i++) {
          this.hatHit(oac, i * (spb / 4), oac.destination, i % 8 === 7);
        }
      }).then((buf) => ({ buffer: buf, beats }));
    },
    bassline808() {
      const spb = 60 / REF_BPM, beats = 8, secs = beats * spb + 0.4;
      const notes = [55, 55, 49, 41.2, 55, 61.7, 55, 49];
      return this.render(secs, (oac) => {
        notes.forEach((f, i) => this.bass808(oac, i * spb, spb * 0.9, oac.destination, f));
      }).then((buf) => ({ buffer: buf, beats }));
    },
    stabLoop() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb + 0.3;
      return this.render(secs, (oac) => {
        this.stabChord(oac, 0, spb * 0.8, oac.destination, [220, 261.6, 329.6]);
        this.stabChord(oac, 2 * spb, spb * 0.8, oac.destination, [196, 246.9, 293.7]);
        this.stabChord(oac, 3 * spb, spb * 0.9, oac.destination, [220, 261.6, 329.6]);
      }).then((buf) => ({ buffer: buf, beats }));
    },
    scratchOneShot() {
      return this.render(0.55, (oac) => this.scratchHit(oac, 0, oac.destination))
        .then((buf) => ({ buffer: buf, beats: 1 }));
    },
    crashOneShot() {
      return this.render(1.3, (oac) => this.crashHit(oac, 0, oac.destination))
        .then((buf) => ({ buffer: buf, beats: 1 }));
    },
    async trapKickPattern() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb + 0.3;
      const buf = await this.render(secs, (oac) => {
        this.kickHit(oac, 0, oac.destination);
        this.kickHit(oac, 0.75 * spb, oac.destination, 150);
        this.kickHit(oac, 1.5 * spb, oac.destination, 130);
        this.kickHit(oac, 2.5 * spb, oac.destination, 150);
        this.kickHit(oac, 3.25 * spb, oac.destination, 140);
      });
      return { buffer: buf, beats };
    },
    async fourOnFloorKick() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb + 0.3;
      const buf = await this.render(secs, (oac) => {
        for (let i = 0; i < 4; i++) this.kickHit(oac, i * spb, oac.destination, 150);
      });
      return { buffer: buf, beats };
    },
    async trapSnareGhosts() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb + 0.25;
      const buf = await this.render(secs, (oac) => {
        this.snareHit(oac, 1 * spb, oac.destination);
        this.snareHit(oac, 3 * spb, oac.destination);
        [0.375, 0.625, 2.375, 2.75].forEach((pos) => {
          const t = pos * spb;
          const noise = oac.createBufferSource(); noise.buffer = this.noiseBuffer(oac, 0.05);
          const bp = oac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800;
          const g = oac.createGain();
          g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
          noise.connect(bp); bp.connect(g); g.connect(oac.destination); noise.start(t); noise.stop(t + 0.06);
        });
      });
      return { buffer: buf, beats };
    },
    async rimshotPattern() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb + 0.2;
      const buf = await this.render(secs, (oac) => {
        [0.5, 1.5, 2.5, 3.5].forEach((pos) => this.rimHit(oac, pos * spb, oac.destination));
      });
      return { buffer: buf, beats };
    },
    async trapHatRolls() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb + 0.1;
      const buf = await this.render(secs, (oac) => {
        for (let i = 0; i < 32; i++) this.hatHit(oac, i * (spb / 8), oac.destination, i % 16 === 15);
      });
      return { buffer: buf, beats };
    },
    async shakerLoop() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb + 0.1;
      const buf = await this.render(secs, (oac) => {
        for (let i = 0; i < 16; i++) this.shakerHit(oac, i * (spb / 4), oac.destination);
      });
      return { buffer: buf, beats };
    },
    async cowbellPattern() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb + 0.35;
      const buf = await this.render(secs, (oac) => {
        [0, 1, 2, 2.5, 3].forEach((pos) => this.cowbellHit(oac, pos * spb, oac.destination));
      });
      return { buffer: buf, beats };
    },
    async tomFill() {
      const spb = 60 / REF_BPM, beats = 2, secs = beats * spb + 0.35;
      const buf = await this.render(secs, (oac) => {
        [[0, 200], [0.5, 180], [1, 160], [1.5, 140]].forEach(([pos, pitch]) => this.tomHit(oac, pos * spb, oac.destination, pitch));
      });
      return { buffer: buf, beats };
    },
    async rideLoop() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb + 0.6;
      const buf = await this.render(secs, (oac) => {
        for (let i = 0; i < 8; i++) this.rideHit(oac, i * (spb / 2), oac.destination);
      });
      return { buffer: buf, beats };
    },
    async subBassDrone() {
      const beats = 4, secs = beats * (60 / REF_BPM) + 0.3;
      const buf = await this.render(secs, (oac) => this.bass808(oac, 0, beats * (60 / REF_BPM) * 0.95, oac.destination, 41.2));
      return { buffer: buf, beats };
    },
    async trap808Pattern() {
      const spb = 60 / REF_BPM, beats = 8, secs = beats * spb + 0.4;
      const notes = [41.2, 41.2, 49, 41.2, 55, 49, 41.2, 61.7];
      const buf = await this.render(secs, (oac) => {
        notes.forEach((f, i) => this.bass808(oac, i * spb, spb * 0.85, oac.destination, f));
      });
      return { buffer: buf, beats };
    },
    async arpPluckLoop() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb + 0.25;
      const notes = [261.6, 329.6, 392, 523.3, 392, 329.6, 261.6, 196];
      const buf = await this.render(secs, (oac) => {
        notes.forEach((f, i) => this.arpNote(oac, i * (spb / 2), spb / 2 * 0.9, oac.destination, f));
      });
      return { buffer: buf, beats };
    },
    async padSwell() {
      const beats = 8, secs = beats * (60 / REF_BPM) + 0.4;
      const buf = await this.render(secs, (oac) => this.padVoice(oac, 0, beats * (60 / REF_BPM) * 0.95, oac.destination, [196, 246.9, 293.7]));
      return { buffer: buf, beats };
    },
    async bellMelody() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb + 0.6;
      const notes = [523.3, 659.3, 784, 659.3];
      const buf = await this.render(secs, (oac) => {
        notes.forEach((f, i) => this.bellNote(oac, i * spb, spb * 0.9, oac.destination, f));
      });
      return { buffer: buf, beats };
    },
    async scratchLoopPattern() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb + 0.3;
      const buf = await this.render(secs, (oac) => {
        [0, 1, 2, 2.5, 3].forEach((pos) => this.scratchHit(oac, pos * spb, oac.destination));
      });
      return { buffer: buf, beats };
    },
    async riserFx() {
      const beats = 4, secs = beats * (60 / REF_BPM) + 0.2;
      const buf = await this.render(secs, (oac) => this.riserSweep(oac, 0, beats * (60 / REF_BPM) * 0.95, oac.destination));
      return { buffer: buf, beats };
    },
    async impactOneShot() {
      const buf = await this.render(1.3, (oac) => this.impactHit(oac, 0, oac.destination));
      return { buffer: buf, beats: 1 };
    },

    /* ---------- added in 1.1 ---------- */
    async vinylCrackle() {
      const beats = 4, secs = beats * (60 / REF_BPM);
      const buf = await this.render(secs, (oac) => {
        const noise = oac.createBufferSource(); noise.buffer = this.noiseBuffer(oac, secs);
        const bp = oac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 0.4;
        const g = oac.createGain(); g.gain.value = 0.06;
        noise.connect(bp); bp.connect(g); g.connect(oac.destination);
        noise.start(0); noise.stop(secs);
        for (let i = 0; i < 26; i++) {
          const t = Math.random() * secs * 0.98;
          const pop = oac.createBufferSource(); pop.buffer = this.noiseBuffer(oac, 0.012);
          const pg = oac.createGain();
          pg.gain.setValueAtTime(0.12 + Math.random() * 0.22, t);
          pg.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
          pop.connect(pg); pg.connect(oac.destination); pop.start(t); pop.stop(t + 0.014);
        }
      });
      return { buffer: buf, beats };
    },
    async boomBapFull() {
      const spb = 60 / REF_BPM, beats = 4, secs = beats * spb + 0.2;
      const buf = await this.render(secs, (oac) => {
        [0, 1.5, 2.75].forEach((p, i) => this.kickHit(oac, p * spb, oac.destination, i ? 140 : 150));
        [1, 3].forEach((p) => { this.snareHit(oac, p * spb, oac.destination); this.clapHit(oac, p * spb, oac.destination); });
        for (let i = 0; i < 8; i++) this.hatHit(oac, i * (spb / 2), oac.destination, i === 7);
      });
      return { buffer: buf, beats };
    },
    async dubChord() {
      const spb = 60 / REF_BPM, beats = 8, secs = beats * spb + 0.5;
      const buf = await this.render(secs, (oac) => {
        [0, 3, 5].forEach((p, i) => this.stabChord(oac, p * spb, spb * 1.6, oac.destination,
          i === 2 ? [174.6, 220, 261.6] : [196, 246.9, 293.7]));
      });
      return { buffer: buf, beats };
    },
  };

  NB.Synth = Synth;
})(window.NB = window.NB || {});
