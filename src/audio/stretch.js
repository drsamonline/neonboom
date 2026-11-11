/* =========================================================================
   NEONBOOM · audio/stretch.js
   WSOLA (waveform-similarity overlap-add) time stretching.

   Used for one thing: fitting a loop to the project tempo *without* changing
   its pitch. Tempo sync normally rides on `playbackRate`, which is a tape
   speed change — correct for a sampler, wrong when you just want a 90 BPM loop
   to sit at 92 BPM.

   Pure Float32Array maths, so it works identically in the live context and in
   the offline export, and needs no AudioWorklet.
   ========================================================================= */
(function (NB) {
  'use strict';

  const FRAME = 1024;          // analysis/synthesis frame
  const HOP = FRAME / 2;       // synthesis hop
  const SEARCH = 192;          // ± samples of similarity search
  const COARSE = 8;            // first pass step
  const FINE = 2;              // refinement step

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }
  const WINDOW = hann(FRAME);

  /* Best offset near `target` whose first HOP samples match `ref` best. */
  function bestOffset(src, target, ref, limit) {
    let best = 0;
    let bestScore = -Infinity;

    const score = (off) => {
      const p = target + off;
      if (p < 0 || p + HOP > limit) return -Infinity;
      let s = 0;
      for (let i = 0; i < HOP; i += 2) s += src[p + i] * ref[i];   // every 2nd sample is plenty
      return s;
    };

    for (let off = -SEARCH; off <= SEARCH; off += COARSE) {
      const s = score(off);
      if (s > bestScore) { bestScore = s; best = off; }
    }
    const coarse = best;
    for (let off = coarse - COARSE; off <= coarse + COARSE; off += FINE) {
      const s = score(off);
      if (s > bestScore) { bestScore = s; best = off; }
    }
    return best;
  }

  /**
   * Stretch `buffer` so it plays `ratio` times slower (ratio > 1 = longer).
   * Pitch is preserved: the output is overlap-added, not resampled.
   */
  function stretchBuffer(buffer, ratio) {
    const r = Math.max(0.25, Math.min(4, ratio));
    const sr = buffer.sampleRate;
    const inLen = buffer.length;
    const outLen = Math.max(FRAME, Math.round(inLen * r));
    const out = new AudioBuffer({
      numberOfChannels: buffer.numberOfChannels,
      length: outLen,
      sampleRate: sr,
    });

    const hopA = HOP / r;          // analysis hop

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = out.getChannelData(ch);
      let prevRef = new Float32Array(HOP);     // tail of the last frame we wrote
      let inPos = 0;
      let outPos = 0;

      while (outPos + FRAME < outLen && inPos + FRAME < inLen) {
        const off = bestOffset(src, Math.round(inPos), prevRef, inLen);
        const p = Math.max(0, Math.min(inLen - FRAME, Math.round(inPos) + off));

        for (let i = 0; i < FRAME; i++) dst[outPos + i] += src[p + i] * WINDOW[i];

        /* reference for the next search: the natural continuation of this frame */
        for (let i = 0; i < HOP; i++) {
          prevRef[i] = src[Math.min(inLen - 1, p + HOP + i)];
        }

        inPos += hopA;
        outPos += HOP;
      }

      /* normalise the overlap-add ripples (Hann at 50 % overlap sums to ~1) */
      for (let i = 0; i < outLen; i++) {
        if (dst[i] > 1.6 || dst[i] < -1.6) dst[i] = Math.max(-1, Math.min(1, dst[i]));
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- caching */
  const cache = new Map();          // key → AudioBuffer
  const CACHE_LIMIT = 24;

  function keyFor(sample, ratio) {
    return `${sample.id}@${ratio.toFixed(3)}`;
  }

  /** Cached stretch, so a loop is only ever stretched once per ratio. */
  function forSample(sample, ratio) {
    if (!sample || Math.abs(ratio - 1) < 0.005) return sample.buffer;
    const key = keyFor(sample, ratio);
    if (cache.has(key)) return cache.get(key);

    const stretched = stretchBuffer(sample.buffer, ratio);
    cache.set(key, stretched);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return stretched;
  }

  function clearCache() { cache.clear(); }

  NB.Stretch = { stretchBuffer, forSample, clearCache, FRAME, HOP };
})(window.NB = window.NB || {});
