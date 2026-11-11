/* =========================================================================
   NEONBOOM · audio/engine.js
   AudioContext owner: master FX chain, per-track buses + meters, metronome
   click, sample preview. The same chain builder is reused offline for export.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { clamp } = NB.util;

  /* ---------------------------------------------------------- bitcrusher
     AudioWorklet where available (off the main thread, no deprecation
     warning), ScriptProcessorNode as the fallback for locked-down browsers.
     The module is a Blob URL so it works from file:// and inside any
     OfflineAudioContext without shipping a second file. */
  const CRUSHER_SRC = `
class NB_Bitcrusher extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'reduction', defaultValue: 4, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.phase = 0; this.held = []; }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const step = Math.pow(0.5, params.bits[0]);
    const red = Math.max(1, Math.round(params.reduction[0]));
    for (let ch = 0; ch < output.length; ch++) {
      const inp = input[ch] || input[0];
      const out = output[ch];
      let held = this.held[ch] || 0;
      for (let i = 0; i < out.length; i++) {
        if (this.phase % red === 0) held = step * Math.round(inp[i] / step);
        out[i] = held;
        this.phase++;
      }
      this.held[ch] = held;
    }
    return true;
  }
}
registerProcessor('nb-bitcrusher', NB_Bitcrusher);
`;

  const Worklet = {
    _url: null,
    _ready: new WeakSet(),
    url() {
      /* data:, not blob: — a blob URL inherits the page origin, and a page
         opened from file:// has an opaque origin, which the worklet loader
         refuses. The data URL works from file://, http(s) and Electron alike. */
      if (!this._url) {
        this._url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(CRUSHER_SRC);
      }
      return this._url;
    },
    supported(ctx) { return !!(ctx.audioWorklet && ctx.audioWorklet.addModule && typeof AudioWorkletNode !== 'undefined'); },
    async prepare(ctx) {
      if (!this.supported(ctx) || this._ready.has(ctx)) return this._ready.has(ctx);
      try {
        await ctx.audioWorklet.addModule(this.url());
        this._ready.add(ctx);
        return true;
      } catch (err) {
        console.warn('AudioWorklet unavailable — falling back to ScriptProcessor', err);
        return false;
      }
    },
  };

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
    }

    /* Async because the AudioWorklet module has to be registered before the
       master chain can use it. Callers that cannot await (tests) still work:
       buildMasterChain() falls back to ScriptProcessorNode. */
    async init() {
      await Worklet.prepare(this.ctx);
      this._buildMasterChain(this.ctx);
      return this;
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
      let crusher = null;

      if (Worklet._ready.has(ctx)) {
        try {
          crusher = new AudioWorkletNode(ctx, 'nb-bitcrusher', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          });
          crusher._bits = 8; crusher._reduction = 4;
          crusher._worklet = true;
        } catch (err) { crusher = null; }
      }

      if (!crusher) try {
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
      chain.setCrush = (bits, reduction) => {
        crusher._bits = bits; crusher._reduction = reduction;
        if (crusher._worklet && crusher.parameters) {
          const t = ctx.currentTime;
          crusher.parameters.get('bits').setValueAtTime(bits, t);
          crusher.parameters.get('reduction').setValueAtTime(reduction, t);
        }
      };
      if (ctx === this.ctx) this.master = chain;
      return chain;
    }

    /* per-track bus:
         gain → panner ─┬→ master.input        (dry)
                        ├→ sendA → master.delay     (post-fader delay send)
                        └→ sendB → master.convolver (post-fader reverb send)
       plus a meter tap on the fader. */
    buildTrackBus(ctx, masterChain) {
      /* clips → auto → gain(fader/mute) → panner → master (+ sends).
         Automation writes `auto`, so it never fights the fader or mute. */
      const auto = ctx.createGain(); auto.gain.value = 1;
      const gain = ctx.createGain(); gain.gain.value = 0.85;
      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const post = panner || gain;
      auto.connect(gain);
      gain.connect(post);
      post.connect(masterChain.input);

      const sendA = ctx.createGain(); sendA.gain.value = 0;
      const sendB = ctx.createGain(); sendB.gain.value = 0;
      post.connect(sendA); sendA.connect(masterChain.delay);
      post.connect(sendB); sendB.connect(masterChain.convolver);

      let analyser = null;
      if (ctx.createAnalyser) {
        analyser = ctx.createAnalyser(); analyser.fftSize = 128;
        gain.connect(analyser);
      }
      return { auto, gain, panner, sendA, sendB, analyser };
    }

    ensureTrackBuses(count) {
      while (this.tracks.length < count) {
        this.tracks.push(this.buildTrackBus(this.ctx, this.master));
      }
      while (this.tracks.length > count) {
        const b = this.tracks.pop();
        try {
          b.auto && b.auto.disconnect();
          b.gain.disconnect(); b.panner && b.panner.disconnect();
          b.sendA && b.sendA.disconnect(); b.sendB && b.sendB.disconnect();
        } catch (e) {}
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
    /* Ramp the automation node. `until` is the horizon the ramp should reach,
       which is how the scheduler keeps automation in step with playback. */
    setAutomation(i, value, atTime, until, panValue) {
      const b = this.tracks[i];
      if (!b || !b.auto) return;
      const t = atTime == null ? this.ctx.currentTime : atTime;
      if (value == null) b.auto.gain.cancelScheduledValues(t);
      else b.auto.gain.linearRampToValueAtTime(Math.max(0.0001, value), until == null ? t : until);
      if (panValue !== undefined && b.panner) {
        if (panValue == null) b.panner.pan.cancelScheduledValues(t);
        else b.panner.pan.linearRampToValueAtTime(panValue, until == null ? t : until);
      }
    }

    setTrackSends(i, a, b2) {
      const b = this.tracks[i]; if (!b) return;
      if (b.sendA) b.sendA.gain.setTargetAtTime(clamp(a || 0, 0, 1), this.ctx.currentTime, 0.01);
      if (b.sendB) b.sendB.gain.setTargetAtTime(clamp(b2 || 0, 0, 1), this.ctx.currentTime, 0.01);
    }
    /* Mute/solo is applied as a real gain change, so it is audible instantly
       on already-playing sources — not just the next scheduling pass. */
    applyMix(tracks) {
      const anySolo = tracks.some((t) => t.solo);
      tracks.forEach((t, i) => {
        const audible = !t.mute && (!anySolo || t.solo);
        this.setTrackVolume(i, audible ? t.vol : 0);
        this.setTrackPan(i, t.pan);
        this.setTrackSends(i, audible ? (t.sendA || 0) : 0, audible ? (t.sendB || 0) : 0);
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
  NB.AudioWorklet = Worklet;
})(window.NB = window.NB || {});
