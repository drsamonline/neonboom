/* =========================================================================
   NEONBOOM · audio/wav.js
   16-bit PCM WAV encoder + offline render of the arrangement.
   The offline graph mirrors the live one exactly (same builder, same FX
   values, same sample-rate — convolver buffers are rate-locked).
   ========================================================================= */
(function (NB) {
  'use strict';
  const { clamp, Grid, SIX_PER_BAR } = NB.util;

  function encodeWAV(audioBuffer) {
    const numCh = audioBuffer.numberOfChannels;
    const len = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
    const bytesPerSample = 2;
    const blockAlign = numCh * bytesPerSample;
    const dataSize = len * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };

    writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data'); view.setUint32(40, dataSize, true);

    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(audioBuffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = clamp(chans[c][i], -1, 1);
        s = s < 0 ? s * 0x8000 : s * 0x7fff;
        view.setInt16(offset, s, true); offset += 2;
      }
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  /* Tail length so reverb/delay decay is never clipped at the end. */
  function tailSeconds(fx, bpm) {
    let tail = 1.2;
    if (fx.reverbMix > 0.001) tail = Math.max(tail, fx.reverbSize + 0.5);
    if (fx.delayMix > 0.001) {
      const stepSec = Grid.sixToSec(fx.delaySync, bpm);
      const fb = clamp(fx.delayFeedback, 0.05, 0.95);
      const repeats = Math.min(16, Math.ceil(Math.log(0.01) / Math.log(fb)));
      tail = Math.max(tail, stepSec * repeats + 0.5);
    }
    return tail;
  }

  async function renderArrangement({ loopOnly = false, sampleLibrary, project, engine, fx }) {
    const bpm = project.bpm;
    let startSix = 0, endSix = SIX_PER_BAR * 4;

    const clipsOf = (t) => (t.clips || []);
    if (loopOnly && project.loopEnabled && project.loopOut > project.loopIn) {
      startSix = project.loopIn;
      endSix = project.loopOut;
    } else {
      project.tracks.forEach((t) => clipsOf(t).forEach((c) => {
        const e = c.startSix + (c.trimEndSix - c.trimStartSix);
        if (e > endSix) endSix = e;
      }));
    }
    if (endSix <= startSix) endSix = startSix + SIX_PER_BAR;

    const sr = engine.ctx.sampleRate;                 // must match live context
    const totalSec = Grid.sixToSec(endSix - startSix, bpm) + tailSeconds(fx, bpm);
    const oac = new OfflineAudioContext(2, Math.ceil(totalSec * sr), sr);

    const om = engine._buildMasterChain(oac, oac.destination);
    om.eqLow.gain.value = fx.eqLow;
    om.eqMid.gain.value = fx.eqMid;
    om.eqHigh.gain.value = fx.eqHigh;
    om.delay.delayTime.value = Grid.sixToSec(fx.delaySync, bpm);
    om.feedback.gain.value = fx.delayFeedback;
    om.delayWet.gain.value = fx.delayMix;
    om.convolver.buffer = NB.ImpulseResponse.generate(oac, fx.reverbSize, fx.reverbDecay);
    om.reverbWet.gain.value = fx.reverbMix;
    om.crusher._bits = fx.crushBits;
    om.crusher._reduction = fx.crushRate;
    om.bitDry.gain.value = 1 - fx.crushMix;
    om.bitWet.gain.value = fx.crushMix;
    om.comp.threshold.value = fx.compThresh;
    om.comp.ratio.value = fx.compRatio;
    om.masterGain.gain.value = fx.masterVol;

    const anySolo = project.tracks.some((t) => t.solo);
    const buses = project.tracks.map((t) => {
      const bus = engine.buildTrackBus(oac, om);
      const audible = !t.mute && (!anySolo || t.solo);
      bus.gain.gain.value = audible ? t.vol : 0;
      if (bus.panner) bus.panner.pan.value = t.pan;
      return bus;
    });

    project.tracks.forEach((track, ti) => {
      const audible = !track.mute && (!anySolo || track.solo);
      if (!audible) return;
      clipsOf(track).forEach((clip) => {
        const sample = sampleLibrary.get(clip.sampleId);
        if (!sample) return;
        const clipStart = clip.startSix;
        const clipEnd = clip.startSix + (clip.trimEndSix - clip.trimStartSix);
        if (clipEnd <= startSix || clipStart >= endSix) return;
        const skip = Math.max(0, startSix - clipStart);
        const rate = bpm / sample.refBpm;
        const when = Grid.sixToSec(Math.max(0, clipStart - startSix), bpm);
        const bufOffsetSec = ((clip.trimStartSix + skip) / 4) * (60 / sample.refBpm);
        const durSec = ((clip.trimEndSix - clip.trimStartSix - skip) / 4) * (60 / sample.refBpm);
        if (durSec <= 0) return;
        const src = oac.createBufferSource();
        src.buffer = sample.buffer;
        src.playbackRate.value = rate;
        src.connect(buses[ti].gain);
        src.start(when, bufOffsetSec, durSec);
      });
    });

    return { rendered: await oac.startRendering(), seconds: totalSec };
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  NB.Wav = { encodeWAV, renderArrangement, download, tailSeconds };
})(window.NB = window.NB || {});
