/* =========================================================================
   NEONBOOM · audio/engine.js
   AudioContext owner: master FX chain, per-track buses + meters, metronome
   click, sample preview. The same chain builder is reused offline for export.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { clamp } = NB.util;

  /* Synthetic reverb impulse: exponentially decaying stereo noise. */
  const ImpulseResponse = {
    generate(ctx, seconds, decay) {
      const rate = ctx.sampleRate;
      const len = Math.max(1, Math.floor(rate * seconds));
      const buf = ctx.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        }
      }
      return buf;
    },
  };

  class AudioEngine {
    constructor() {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.tracks = [];
      this._activeSources = [];
      this._previewSrc = null;
      this._vuBuf = null;
      this._meterBuf = null;
      this._buildMasterChain(this.ctx);
    }

    /* master chain:
       trackBus → EQ(low/mid/high) → ┬ dry
                                     ├ delay send (tempo synced, feedback)
                                     └ reverb send (convolver, synthetic IR)
                   → sum → bitcrusher(wet/dry) → compressor → masterGain → out
    */
    _buildMasterChain(ctx, dest) {
      dest = dest || ctx.destination;
      const input = ctx.createGain(); input.gain.value = 1;

      const eqLow = ctx.createBiquadFilter();
      eqLow.type = 'lowshelf'; eqLow.frequency.value = 120; eqLow.gain.value = 0;
      const eqMid = ctx.createBiquadFilter();
      eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 0.9; eqMid.gain.value = 0;
      const eqHigh = ctx.createBiquadFilter();
      eqHigh.type = 'highshelf'; eqHigh.frequency.value = 6000; eqHigh.gain.value = 0;
      input.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh);

      const sumBus = ctx.createGain(); sumBus.gain.value = 1;
      eqHigh.connect(sumBus);

      const delay = ctx.createDelay(2.0); delay.delayTime.value = 0.25;
      const feedback = ctx.createGain(); feedback.gain.value = 0.32;
      const delayWet = ctx.createGain(); delayWet.gain.value = 0;
      eqHigh.connect(delay); delay.connect(feedback); feedback.connect(delay);
      delay.connect(delayWet); delayWet.connect(sumBus);

      const convolver = ctx.createConvolver();
      convolver.buffer = ImpulseResponse.generate(ctx, 2.2, 3.2);
      const reverbWet = ctx.createGain(); reverbWet.gain.value = 0;
      eqHigh.connect(convolver); convolver.connect(reverbWet); reverbWet.connect(sumBus);

      /* Bitcrusher via ScriptProcessorNode: deprecated but universally
         supported and needs no async AudioWorklet registration per context —
         which matters because export spins up a fresh OfflineAudioContext
         every render. Guarded: fall back to a passthrough gain. */
      const bitDry = ctx.createGain(); bitDry.gain.value = 1;
      const bitWet = ctx.createGain(); bitWet.gain.value = 0;
      let crusher;
      try {
        crusher = ctx.createScriptProcessor(1024, 2, 2);
        crusher._bits = 8; crusher._reduction = 4;
        crusher.onaudioprocess = (e) => {
          const bits = crusher._bits, red = Math.max(1, crusher._reduction);
          const step = Math.pow(0.5, bits);
          for (let ch = 0; ch < e.outputBuffer.numberOfChannels; ch++) {
            const inp = e.inputBuffer.getChannelData(ch);
            const out = e.outputBuffer.getChannelData(ch);
            let held = 0;
            for (let i = 0; i < inp.length; i++) {
              if (i % red === 0) held = step * Math.round(inp[i] / step);
              out[i] = held;
            }
          }
        };
      } catch (err) {
        crusher = ctx.createGain(); crusher.gain.value = 1;
        crusher._bits = 8; crusher._reduction = 4;
      }
      sumBus.connect(bitDry); sumBus.connect(crusher); crusher.connect(bitWet);
      const postCrush = ctx.createGain();
      bitDry.connect(postCrush); bitWet.connect(postCrush);

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -6; comp.knee.value = 6; comp.ratio.value = 12;
      comp.attack.value = 0.002; comp.release.value = 0.18;

      const masterGain = ctx.createGain(); masterGain.gain.value = 0.9;
      postCrush.connect(comp); comp.connect(masterGain); masterGain.connect(dest);

      let analyser = null;
      if (ctx.createAnalyser) {
        analyser = ctx.createAnalyser(); analyser.fftSize = 256;
        masterGain.connect(analyser);
      }

      const chain = { input, eqLow, eqMid, eqHigh, delay, feedback, delayWet,
        convolver, reverbWet, crusher, bitDry, bitWet, comp, masterGain, analyser };
      if (ctx === this.ctx) this.master = chain;
      return chain;
    }

    /* per-track bus: gain → panner → master.input, plus a meter tap */
    buildTrackBus(ctx, masterChain) {
      const gain = ctx.createGain(); gain.gain.value = 0.85;
      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      gain.connect(panner || masterChain.input);
      if (panner) panner.connect(masterChain.input);
      let analyser = null;
      if (ctx.createAnalyser) {
        analyser = ctx.createAnalyser(); analyser.fftSize = 128;
        gain.connect(analyser);
      }
      return { gain, panner, analyser };
    }

    ensureTrackBuses(count) {
      while (this.tracks.length < count) {
        this.tracks.push(this.buildTrackBus(this.ctx, this.master));
      }
      while (this.tracks.length > count) {
        const b = this.tracks.pop();
        try { b.gain.disconnect(); b.panner && b.panner.disconnect(); } catch (e) {}
      }
    }

    setTrackVolume(i, v) {
      const b = this.tracks[i]; if (!b) return;
      b.gain.gain.setTargetAtTime(clamp(v, 0, 1.4), this.ctx.currentTime, 0.01);
    }
    setTrackPan(i, p) {
      const b = this.tracks[i]; if (!b) return;
      if (b.panner) b.panner.pan.setTargetAtTime(clamp(p, -1, 1), this.ctx.currentTime, 0.01);
    }
    /* Mute/solo is applied as a real gain change, so it is audible instantly
       on already-playing sources — not just the next scheduling pass. */
    applyMix(tracks) {
      const anySolo = tracks.some((t) => t.solo);
      tracks.forEach((t, i) => {
        const audible = !t.mute && (!anySolo || t.solo);
        this.setTrackVolume(i, audible ? t.vol : 0);
        this.setTrackPan(i, t.pan);
      });
    }

    resume() {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    }

    /* ---------- meters ---------- */
    readMasterVU(bands = 10) {
      const an = this.master.analyser;
      if (!an) return new Array(bands).fill(0);
      if (!this._vuBuf || this._vuBuf.length !== an.frequencyBinCount) this._vuBuf = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(this._vuBuf);
      const out = [], chunk = Math.floor(this._vuBuf.length / bands);
      for (let b = 0; b < bands; b++) {
        let sum = 0;
        for (let i = b * chunk; i < (b + 1) * chunk; i++) sum += this._vuBuf[i];
        out.push((sum / chunk) / 255);
      }
      return out;
    }
    readTrackLevel(i) {
      const b = this.tracks[i];
      if (!b || !b.analyser) return 0;
      const an = b.analyser;
      if (!this._meterBuf || this._meterBuf.length !== an.frequencyBinCount) this._meterBuf = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(this._meterBuf);
      let sum = 0;
      for (let k = 0; k < this._meterBuf.length; k++) sum += this._meterBuf[k];
      return (sum / this._meterBuf.length) / 255;
    }

    /* ---------- preview & click ---------- */
    preview(buffer, rate = 1) {
      this.resume();
      if (this._previewSrc) { try { this._previewSrc.stop(); } catch (e) {} }
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      src.connect(this.master.input);
      src.start();
      this._previewSrc = src;
      return src;
    }
    stopPreview() {
      if (this._previewSrc) { try { this._previewSrc.stop(); } catch (e) {} this._previewSrc = null; }
    }

    /* metronome click scheduled on the audio clock */
    click(when, accent) {
      const ctx = this.ctx;
      const osc = ctx.createOscillator(); osc.type = 'square';
      const g = ctx.createGain();
      osc.frequency.value = accent ? 1760 : 1180;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(accent ? 0.28 : 0.16, when + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 600;
      osc.connect(hp); hp.connect(g); g.connect(this.master.input);
      osc.start(when); osc.stop(when + 0.06);
    }
  }

  NB.AudioEngine = AudioEngine;
  NB.ImpulseResponse = ImpulseResponse;
})(window.NB = window.NB || {});
