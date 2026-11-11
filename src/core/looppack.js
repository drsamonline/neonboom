/* =========================================================================
   NEONBOOM · core/looppack.js
   Optional side asset: a zip of the 27 loops, pre-rendered by the app itself.

   The pack is never required. Boot order is
     loop cache (IndexedDB) → pack (this file) → synthesise.
   If the pack is missing, blocked or slow, the app behaves exactly as before.

   Accepts any zip whose entries are WAVs plus a pack.json manifest, including
   ones made by other tools (deflate is supported via DecompressionStream).
   ========================================================================= */
(function (NB) {
  'use strict';

  const TIMEOUT = (ms) => new Promise((res) => setTimeout(() => res(null), ms));

  /* ------------------------------------------------------------ zip read */
  function readZip(buffer) {
    const dv = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    let eocd = -1;
    const floor = Math.max(0, u8.length - 66000);
    for (let i = u8.length - 22; i >= floor; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip file');

    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const out = [];
    for (let i = 0; i < count; i++) {
      if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buffer, off + 46, nameLen));

      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      out.push({ name, method, bytes: u8.subarray(dataStart, dataStart + compSize) });

      off += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  async function inflate(entry) {
    if (entry.method === 0) return entry.bytes;
    if (entry.method !== 8) throw new Error('Unsupported zip method ' + entry.method);
    if (typeof DecompressionStream === 'undefined') throw new Error('Cannot inflate on this browser');
    const stream = new Blob([entry.bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* ---------------------------------------------------------------- pack */
  const LoopPack = {
    url: 'pack/neonboom-pack-v1.zip',
    version: 1,
    lastResult: null,

    /* Cheap existence check — one HEAD, no body. */
    async probe() {
      if (!/^https?:/.test(location.protocol)) return false;   // file:// cannot fetch
      try {
        const res = await fetch(this.url, { method: 'HEAD', cache: 'no-store' });
        return res.ok;
      } catch (e) { return false; }
    },

    /**
     * Fetch + install the pack next to the app.
     * @returns {Promise<number>} how many loops were installed (0 = not available)
     */
    async load(engine) {
      /* one request, not HEAD-then-GET: a 404 is just as cheap and the browser
         caches the body either way */
      try {
        const res = await fetch(this.url, { cache: 'force-cache' });
        if (!res.ok) { this.lastResult = 'absent'; return 0; }
        const buf = await res.arrayBuffer();
        /* no loop-cache write on this path: the pack is already on disk and in
           the browser cache, and converting 27 buffers to Int16 costs more than
           it saves. File imports still cache, because the source is transient. */
        return await this.ingest(buf, engine, { cache: false });
      } catch (err) {
        console.warn('pack load failed:', err);
        this.lastResult = 'failed';
        return 0;
      }
    },

    /** Install a pack from a File (the file:// escape hatch). */
    async fromFile(file, engine) {
      return this.ingest(await file.arrayBuffer(), engine, { cache: true });
    },

    async ingest(buffer, engine, opts = {}) {
      const writeCache = opts.cache !== false;
      const entries = readZip(buffer);
      const manifestEntry = entries.find((e) => e.name === 'pack.json');
      let manifest = null;
      if (manifestEntry) {
        try { manifest = JSON.parse(new TextDecoder().decode(await inflate(manifestEntry))); } catch (e) {}
      }
      if (manifest && manifest.synthVersion != null && manifest.synthVersion !== NB.project.SYNTH_VERSION) {
        console.warn('pack was rendered by synth v' + manifest.synthVersion +
          ', this build is v' + NB.project.SYNTH_VERSION + ' — using it anyway');
      }

      const byFile = new Map();
      (manifest && manifest.loops ? manifest.loops : []).forEach((l) => byFile.set(l.file, l));

      const wavs = entries.filter((e) => /\.wav$/i.test(e.name));
      let installed = 0;
      let slot = 0;

      /* decode in parallel — one decodeAudioData at a time was the slowest part
         of installing a pack */
      const worker = async () => {
        while (wavs.length) {
          const entry = wavs.shift();
          const meta = byFile.get(entry.name) || null;
          const fn = entry.name.replace(/^.*\//, '').replace(/\.wav$/i, '');
          const id = meta ? meta.id : 'loop_' + fn;
          if (NB.Library.has(id)) continue;

          let bytes, audio;
          try { bytes = await inflate(entry); } catch (e) { continue; }
          try { audio = await engine.ctx.decodeAudioData(bytes.slice().buffer); } catch (e) { continue; }

          const beats = meta && meta.beats ? meta.beats : audio.duration / (60 / NB.util.REF_BPM);
          NB.Library.register({
            id,
            name: meta ? meta.name : fn,
            buffer: audio,
            category: meta ? meta.category : 'Imported',
            color: NB.util.TRACK_COLORS[(slot++) % NB.util.TRACK_COLORS.length],
            beats,
          });
          if (writeCache) NB.LoopCache.put(id, audio, beats);   // fire and forget
          installed++;
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);

      this.lastResult = installed ? 'installed' : 'empty';
      if (installed) NB.bus.emit('library:changed');
      return installed;
    },

    /* Boot helper: try the pack, but never let it hold the veil hostage. */
    async tryAtBoot(engine, budgetMs = 2200) {
      const attempt = this.load(engine).catch(() => 0);
      const won = await Promise.race([attempt, TIMEOUT(budgetMs)]);
      if (won == null) return -1;          // still running in the background
      return won;
    },
  };

  NB.LoopPack = LoopPack;
  NB.readZip = readZip;
})(window.NB = window.NB || {});
