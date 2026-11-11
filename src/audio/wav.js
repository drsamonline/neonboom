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

  async function renderArrangement({ loopOnly = false, soloTrack = null, sampleLibrary, project, engine, fx }) {
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
    await NB.AudioWorklet.prepare(oac);      // same crusher, offline

    const om = engine._buildMasterChain(oac, oac.destination);
    om.eqLow.gain.value = fx.eqLow;
    om.eqMid.gain.value = fx.eqMid;
    om.eqHigh.gain.value = fx.eqHigh;
    om.delay.delayTime.value = Grid.sixToSec(fx.delaySync, bpm);
    om.feedback.gain.value = fx.delayFeedback;
    om.delayWet.gain.value = fx.delayMix;
    om.convolver.buffer = NB.ImpulseResponse.generate(oac, fx.reverbSize, fx.reverbDecay);
    om.reverbWet.gain.value = fx.reverbMix;
    om.setCrush(fx.crushBits, fx.crushRate);
    om.bitDry.gain.value = 1 - fx.crushMix;
    om.bitWet.gain.value = fx.crushMix;
    om.comp.threshold.value = fx.compThresh;
    om.comp.ratio.value = fx.compRatio;
    om.masterGain.gain.value = fx.masterVol;

    const anySolo = project.tracks.some((t) => t.solo);
    const buses = project.tracks.map((t, i) => {
      const bus = engine.buildTrackBus(oac, om);
      const audible = soloTrack != null ? i === soloTrack : (!t.mute && (!anySolo || t.solo));
      bus.gain.gain.value = audible ? t.vol : 0;
      if (bus.panner) bus.panner.pan.value = t.pan;
      if (bus.sendA) bus.sendA.gain.value = audible ? (t.sendA || 0) : 0;
      if (bus.sendB) bus.sendB.gain.value = audible ? (t.sendB || 0) : 0;
      return bus;
    });

    project.tracks.forEach((track, ti) => {
      const audible = soloTrack != null ? ti === soloTrack : (!track.mute && (!anySolo || track.solo));
      if (!audible) return;
      clipsOf(track).forEach((clip) => {
        const sample = sampleLibrary.get(clip.sampleId);
        if (!sample) return;
        const clipEnd = clip.startSix + (clip.trimEndSix - clip.trimStartSix);
        if (clipEnd <= startSix || clip.startSix >= endSix) return;
        NB.Schedule.clip(oac, buses[ti].gain, clip, sample, {
          when: NB.Schedule.when(clip, startSix, 0, bpm, project.swing || 0),
          fromSix: startSix, bpm, swing: project.swing || 0,
        });
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

  /* ---------------------------------------------------------------- stems
     Render each track on its own through the same master chain and bundle the
     WAVs into a store-only ZIP, so the whole thing stays dependency-free. */
  async function renderStems(opts) {
    const out = [];
    const tracks = opts.project.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t.clips.length) continue;
      const { rendered } = await renderArrangement({ ...opts, loopOnly: false, soloTrack: i });
      out.push({ name: `${String(i + 1).padStart(2, '0')}-${slug(t.name)}.wav`, blob: encodeWAV(rendered) });
    }
    return out;
  }

  function slug(s) {
    return (s || 'track').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'track';
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ZIP with stored (uncompressed) entries — WAV data does not compress well
     and this keeps the writer to a few dozen lines. */
  async function zip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = new Uint8Array(await f.blob.arrayBuffer());
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0, true);
      local.setUint16(8, 0, true);          // method: store
      local.setUint16(10, 0, true);         // time
      local.setUint16(12, 0x21, true);      // date (1980-01-01)
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);

      parts.push(new Uint8Array(local.buffer), nameBytes, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, 0, true);
      cd.setUint16(14, 0x21, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint16(30, 0, true);
      cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true);
      cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = central.reduce((n, a) => n + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  NB.Wav = { encodeWAV, renderArrangement, renderStems, zip, download, tailSeconds, slug };
})(window.NB = window.NB || {});
