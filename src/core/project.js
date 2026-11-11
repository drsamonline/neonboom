/* =========================================================================
   NEONBOOM · core/project.js
   Sample registry, project state, track/clip operations, undo+redo history,
   IndexedDB autosave, project file import/export and the demo arrangement.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { uid, deepClone, clamp, TRACK_COLORS, REF_BPM, SIX_PER_BAR } = NB.util;

  /* ------------------------------------------------------------------ bus */
  const bus = {
    _h: {},
    on(evt, fn) { (this._h[evt] = this._h[evt] || []).push(fn); return fn; },
    emit(evt, data) { (this._h[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.warn(e); } }); },
  };

  /* -------------------------------------------------------------- library */
  const Library = {
    items: new Map(),

    register({ id: fixedId, name, buffer, category, color, refBpm = REF_BPM, isUser = false, rawBytes = null, beats = null }) {
      /* Procedural loops pass a stable id (loop_<generator>) so a saved
         project resolves its clips again after a reload. Imported samples
         get a fresh unique id each session and are remapped on load. */
      const id = fixedId || uid('smp');
      const computedBeats = beats != null ? beats : buffer.duration / (60 / refBpm);
      this.items.set(id, {
        id, name, buffer, category, color, refBpm, isUser, rawBytes,
        beats: Math.max(0.25, computedBeats),
        peaks: computePeaks(buffer),
      });
      return id;
    },
    get(id) { return this.items.get(id); },
    has(id) { return this.items.has(id); },
    list() { return Array.from(this.items.values()); },
    byName(name) { return this.list().find((s) => s.name === name) || null; },
    categories() { return Array.from(new Set(this.list().map((s) => s.category))); },
  };

  function computePeaks(buffer, buckets = 400) {
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    const step = Math.max(1, Math.floor(buffer.length / buckets));
    const peaks = new Float32Array(buckets);
    for (let b = 0; b < buckets; b++) {
      let max = 0;
      const start = b * step, end = Math.min(buffer.length, start + step);
      for (let i = start; i < end; i++) {
        const v = Math.max(Math.abs(ch0[i]), Math.abs(ch1[i]));
        if (v > max) max = v;
      }
      peaks[b] = max;
    }
    return peaks;
  }

  /* -------------------------------------------------------------- project */
  const DEFAULT_TRACKS = 8;

  function newTrack(i) {
    return {
      id: uid('trk'), name: `Track ${i + 1}`,
      color: NB.util.paletteColor(i),
      vol: 0.85, pan: 0, sendA: 0, sendB: 0, mute: false, solo: false, clips: [],
    };
  }

  const Project = {
    name: 'Untitled beat',
    bpm: 90,
    snap: 2,                       // sixteenths per snap step
    loopIn: 0, loopOut: SIX_PER_BAR * 4, loopEnabled: false,
    swing: 0,                       // 0-0.6, delays every second 16th
    tracks: [],
    metronome: false,
    fx: null,                       // last FX rack values (restored on boot)
  };

  function initTracks(n = DEFAULT_TRACKS) {
    Project.tracks = Array.from({ length: n }, (_, i) => newTrack(i));
  }

  function newClip(sampleId, trackId, startSix) {
    const s = Library.get(sampleId);
    const lengthSix = Math.max(1, Math.round((s ? s.beats : 1) * 4));
    return { id: uid('clp'), sampleId, trackId, startSix,
      lengthSix, trimStartSix: 0, trimEndSix: lengthSix, gain: 1,
      pitch: 0, reverse: false, fadeIn: 0, fadeOut: 0 };
  }

  /* Older projects (and the demo builder) create clips by hand, so normalise
     the optional fields once on load instead of guarding at every call site. */
  function normaliseClip(c) {
    c.gain = c.gain == null ? 1 : c.gain;
    c.pitch = c.pitch || 0;
    c.reverse = !!c.reverse;
    c.fadeIn = c.fadeIn || 0;
    c.fadeOut = c.fadeOut || 0;
    return c;
  }

  /* Reversed playback needs a reversed copy of the buffer; build it once per
     sample and keep it on the sample object. */
  function reversedBuffer(sample) {
    if (sample._revBuffer) return sample._revBuffer;
    const src = sample.buffer;
    const out = new AudioBuffer({ numberOfChannels: src.numberOfChannels, length: src.length, sampleRate: src.sampleRate });
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
      const a = src.getChannelData(ch);
      const b = out.getChannelData(ch);
      for (let i = 0, n = a.length; i < n; i++) b[i] = a[n - 1 - i];
    }
    sample._revBuffer = out;
    return out;
  }

  function clipEnd(clip) { return clip.startSix + (clip.trimEndSix - clip.trimStartSix); }

  function addTrack() {
    const t = newTrack(Project.tracks.length);
    Project.tracks.push(t);
    return t;
  }
  function removeTrack(id) {
    const i = Project.tracks.findIndex((t) => t.id === id);
    if (i < 0 || Project.tracks.length <= 1) return false;
    Project.tracks.splice(i, 1);
    return true;
  }
  function findClip(clipId) {
    for (const t of Project.tracks) {
      const c = t.clips.find((x) => x.id === clipId);
      if (c) return { clip: c, track: t };
    }
    return null;
  }
  function removeClip(clipId) {
    let hit = false;
    Project.tracks.forEach((t) => {
      const n = t.clips.length;
      t.clips = t.clips.filter((c) => c.id !== clipId);
      if (t.clips.length !== n) hit = true;
    });
    return hit;
  }

  /* -------------------------------------------------------------- history */
  const History = {
    undoStack: [], redoStack: [], labels: [], limit: 80,
    snapshot() {
      return JSON.stringify({
        bpm: Project.bpm, snap: Project.snap,
        loopIn: Project.loopIn, loopOut: Project.loopOut, loopEnabled: Project.loopEnabled,
        name: Project.name, tracks: Project.tracks,
      });
    },
    push(label) {
      this.undoStack.push(this.snapshot());
      this.labels.push(label || 'Edit');
      if (this.undoStack.length > this.limit) { this.undoStack.shift(); this.labels.shift(); }
      this.redoStack.length = 0;
      bus.emit('history', { canUndo: this.canUndo(), canRedo: false });
    },

    /* Human-readable list, newest first, for the history panel. */
    list() {
      return this.undoStack.map((_, i) => ({
        index: i,
        label: this.labels[i] || 'Edit',
        stepsBack: this.undoStack.length - i,
      })).reverse();
    },

    /* Rewind to the state *before* entry i (and drop everything after it). */
    jumpTo(i) {
      if (i < 0 || i >= this.undoStack.length) return false;
      this.redoStack.push(this.snapshot());
      this.apply(this.undoStack[i]);
      this.undoStack.length = i;
      this.labels.length = i;
      bus.emit('history', { canUndo: this.canUndo(), canRedo: true });
      bus.emit('project:replaced');
      return true;
    },
    apply(json) {
      const s = JSON.parse(json);
      Project.bpm = s.bpm; Project.snap = s.snap;
      Project.loopIn = s.loopIn; Project.loopOut = s.loopOut;
      Project.loopEnabled = s.loopEnabled; Project.name = s.name || Project.name;
      Project.tracks = s.tracks;
    },
    undo() {
      if (!this.undoStack.length) return false;
      this.redoStack.push(this.snapshot());
      this.apply(this.undoStack.pop());
      this.labels.pop();
      bus.emit('history', { canUndo: this.canUndo(), canRedo: true });
      bus.emit('project:replaced');
      return true;
    },
    redo() {
      if (!this.redoStack.length) return false;
      this.undoStack.push(this.snapshot());
      this.apply(this.redoStack.pop());
      bus.emit('history', { canUndo: true, canRedo: this.canRedo() });
      bus.emit('project:replaced');
      return true;
    },
    /* commit a snapshot captured BEFORE an interaction started (lazy push:
       a drag that never moved should not pollute the history). */
    commit(json, label) {
      if (!json) return;
      this.undoStack.push(json);
      this.labels.push(label || 'Edit');
      if (this.undoStack.length > this.limit) { this.undoStack.shift(); this.labels.shift(); }
      this.redoStack.length = 0;
      bus.emit('history', { canUndo: true, canRedo: false });
    },
    canUndo() { return this.undoStack.length > 0; },
    canRedo() { return this.redoStack.length > 0; },
  };

  /* ---------------------------------------------------------- persistence */
  const Persistence = {
    db: null, timer: 0, enabled: false,

    open() {
      return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
        const req = indexedDB.open('neonboomDB', 3);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('project')) db.createObjectStore('project', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('samples')) db.createObjectStore('samples', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('loops')) db.createObjectStore('loops', { keyPath: 'id' });
        };
        req.onsuccess = () => { this.db = req.result; this.enabled = true; resolve(); };
        req.onerror = () => reject(req.error);
      });
    },

    saveSoon() {
      if (!this.enabled) return;
      bus.emit('saving');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.save(), 650);
    },

    async save() {
      if (!this.db) return false;
      try {
        const tx = this.db.transaction(['project', 'samples'], 'readwrite');
        tx.objectStore('project').put({
          id: 'current', name: Project.name, bpm: Project.bpm, snap: Project.snap,
          loopIn: Project.loopIn, loopOut: Project.loopOut, loopEnabled: Project.loopEnabled,
          metronome: Project.metronome, swing: Project.swing, fx: Project.fx || null,
          userSampleCount: Library.list().filter((x) => x.isUser).length,
          tracks: Project.tracks, savedAt: Date.now(),
        });
        Library.list().forEach((s) => {
          if (s.isUser && s.rawBytes) {
            tx.objectStore('samples').put({
              id: s.id, name: s.name, category: s.category, color: s.color,
              refBpm: s.refBpm, bytes: s.rawBytes,
            });
          }
        });
        await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; tx.onabort = res; });
        bus.emit('saved', new Date());
        return true;
      } catch (err) {
        console.warn('autosave failed (non-fatal):', err);
        return false;
      }
    },

    async load(engine) {
      if (!this.db) return false;
      const read = (store, fn) => new Promise((res) => {
        try {
          const tx = this.db.transaction(store, 'readonly');
          const rq = fn(tx.objectStore(store));
          rq.onsuccess = () => res(rq.result);
          rq.onerror = () => res(null);
        } catch (e) { res(null); }
      });
      const proj = await read('project', (s) => s.get('current'));
      /* skip the sample store entirely when the project has no imports —
         it is a second transaction and, on a cold profile, a slow one */
      const samples = proj && proj.userSampleCount > 0
        ? ((await read('samples', (s) => s.getAll())) || [])
        : [];

      const idMap = {};
      for (const s of samples) {
        try {
          const buf = await engine.ctx.decodeAudioData(s.bytes.slice(0));
          idMap[s.id] = Library.register({
            name: s.name, buffer: buf, category: s.category || 'Imported',
            color: s.color || TRACK_COLORS[0], refBpm: s.refBpm || REF_BPM,
            isUser: true, rawBytes: s.bytes,
          });
        } catch (e) { console.warn('sample restore failed', s.name, e); }
      }
      if (!proj || !Array.isArray(proj.tracks)) return false;

      Project.name = proj.name || Project.name;
      Project.bpm = proj.bpm || 90;
      Project.snap = proj.snap || 2;
      Project.loopIn = proj.loopIn || 0;
      Project.loopOut = proj.loopOut || SIX_PER_BAR * 4;
      Project.loopEnabled = !!proj.loopEnabled;
      Project.metronome = !!proj.metronome;
      Project.swing = proj.swing || 0;
      Project.fx = proj.fx || null;
      Project.tracks = proj.tracks.map((t) => ({
        ...t,
        clips: (t.clips || [])
          .map((c) => normaliseClip({ ...c, sampleId: idMap[c.sampleId] || c.sampleId }))
          .filter((c) => Library.items.has(c.sampleId)),
      }));
      return true;
    },

    async clear() {
      if (!this.db) return;
      const tx = this.db.transaction(['project', 'samples'], 'readwrite');
      tx.objectStore('project').clear();
      tx.objectStore('samples').clear();
    },
  };

  /* ------------------------------------------------------------ loop cache
     The 27 procedural loops cost ~2 s to synthesise. They are deterministic,
     so the rendered PCM is cached in IndexedDB as 16-bit and re-hydrated on
     the next visit: a warm start is a memory copy, not a synthesis run.
     Bump SYNTH_VERSION whenever a generator changes. */
  const SYNTH_VERSION = 1;

  const LoopCache = {
    key(name) { return `${name}@v${SYNTH_VERSION}@${REF_BPM}`; },

    /* Read only the rows we need for the first paint. */
    async many(names) {
      const map = new Map();
      if (!Persistence.db || !names.length) return map;
      await new Promise((res) => {
        try {
          const tx = Persistence.db.transaction('loops', 'readonly');
          const store = tx.objectStore('loops');
          let left = names.length;
          names.forEach((n) => {
            const rq = store.get(this.key(n));
            rq.onsuccess = () => {
              if (rq.result) map.set(this.key(n), rq.result);
              if (--left === 0) res();
            };
            rq.onerror = () => { if (--left === 0) res(); };
          });
          tx.oncomplete = res;
          tx.onerror = res;
        } catch (e) { res(); }
      });
      return map;
    },

    async all() {
      if (!Persistence.db) return new Map();
      const rows = await new Promise((res) => {
        try {
          const tx = Persistence.db.transaction('loops', 'readonly');
          const rq = tx.objectStore('loops').getAll();
          rq.onsuccess = () => res(rq.result || []);
          rq.onerror = () => res([]);
        } catch (e) { res([]); }
      });
      const map = new Map();
      rows.forEach((r) => map.set(r.id, r));
      return map;
    },

    /* Float32 → Int16 halves the storage and is inaudible for these loops.
       The generators are mono-compatible (no panners), so a duplicate channel
       is detected and stored once — another 2x off the cache and the read. */
    async put(name, buffer, beats) {
      if (!Persistence.db) return false;
      const len = buffer.length;
      const ch0 = buffer.getChannelData(0);
      const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
      let mono = true;
      if (ch1) {
        for (let i = 0; i < len; i += 257) {
          if (Math.abs(ch0[i] - ch1[i]) > 1e-6) { mono = false; break; }
        }
      }
      const channels = mono ? 1 : buffer.numberOfChannels;
      const data = new Int16Array(channels * len);
      for (let c = 0; c < channels; c++) {
        const src = c === 0 ? ch0 : buffer.getChannelData(c);
        const off = c * len;
        for (let i = 0; i < len; i++) {
          const v = Math.max(-1, Math.min(1, src[i]));
          data[off + i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
      }
      try {
        const tx = Persistence.db.transaction('loops', 'readwrite');
        tx.objectStore('loops').put({
          id: this.key(name), name, beats, channels, length: len,
          sampleRate: buffer.sampleRate, data,
        });
        await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; tx.onabort = res; });
        return true;
      } catch (e) { return false; }
    },

    hydrate(row, ctx) {
      /* cached mono rows are expanded back to stereo so every downstream
         assumption (peaks, reverse, export) stays the same */
      const outCh = Math.max(2, row.channels);
      const buf = ctx.createBuffer(outCh, row.length, row.sampleRate);
      const len = row.length;
      const data = row.data;
      for (let c = 0; c < outCh; c++) {
        const dst = buf.getChannelData(c);
        const off = (c % row.channels) * len;
        for (let i = 0; i < len; i++) dst[i] = data[off + i] / 32768;
      }
      return buf;
    },

    async clear() {
      if (!Persistence.db) return;
      try {
        const tx = Persistence.db.transaction('loops', 'readwrite');
        tx.objectStore('loops').clear();
      } catch (e) {}
    },
  };

  /* ------------------------------------------------- project file (JSON) */
  function projectFile() {
    return {
      format: 'neonboom-project',
      version: 1,
      exportedAt: new Date().toISOString(),
      name: Project.name, bpm: Project.bpm, snap: Project.snap,
      loopIn: Project.loopIn, loopOut: Project.loopOut, loopEnabled: Project.loopEnabled,
      swing: Project.swing,
      tracks: Project.tracks.map((t) => ({
        name: t.name, color: t.color, vol: t.vol, pan: t.pan,
        sendA: t.sendA || 0, sendB: t.sendB || 0, mute: t.mute, solo: t.solo,
        clips: t.clips.map((c) => ({
          sampleName: (Library.get(c.sampleId) || {}).name || 'missing',
          startSix: c.startSix, trimStartSix: c.trimStartSix, trimEndSix: c.trimEndSix,
          gain: c.gain, pitch: c.pitch, reverse: c.reverse, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
        })),
      })),
    };
  }

  function loadProjectFile(json, engine) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (data.format !== 'neonboom-project') throw new Error('Not a NEONBOOM project file');
    Project.name = data.name || 'Imported beat';
    Project.bpm = clamp(data.bpm || 90, 40, 220);
    Project.snap = data.snap || 2;
    Project.loopIn = data.loopIn || 0;
    Project.loopOut = data.loopOut || SIX_PER_BAR * 4;
    Project.loopEnabled = !!data.loopEnabled;
    Project.tracks = (data.tracks || []).map((t, i) => {
      const track = newTrack(i);
      track.name = t.name || track.name;
      track.color = t.color || track.color;
      track.vol = t.vol == null ? 0.85 : t.vol;
      track.pan = t.pan || 0;
      track.sendA = t.sendA || 0; track.sendB = t.sendB || 0;
      track.mute = !!t.mute; track.solo = !!t.solo;
      track.clips = (t.clips || []).map((c) => {
        const s = Library.byName(c.sampleName);
        if (!s) return null;
        return normaliseClip({ id: uid('clp'), sampleId: s.id, trackId: track.id, startSix: c.startSix,
          lengthSix: c.trimEndSix - c.trimStartSix, trimStartSix: c.trimStartSix,
          trimEndSix: c.trimEndSix, gain: c.gain, pitch: c.pitch,
          reverse: c.reverse, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
      }).filter(Boolean);
      return track;
    });
    if (!Project.tracks.length) initTracks();
    return true;
  }

  /* ---------------------------------------------------------- demo beat */
  function buildDemo() {
    Project.name = 'Neon Boom (demo)';
    Project.bpm = 92;
    Project.loopIn = 0; Project.loopOut = SIX_PER_BAR * 8; Project.loopEnabled = true;
    initTracks(8);

    const BAR = SIX_PER_BAR;              // 16 sixteenths
    const fill = (trackIdx, sampleName, everySix, count, offset = 0) => {
      const s = Library.byName(sampleName);
      if (!s) return;
      const t = Project.tracks[trackIdx];
      const len = Math.round(s.beats * 4);
      for (let i = 0; i < count; i++) {
        t.clips.push({ id: uid('clp'), sampleId: s.id, trackId: t.id,
          startSix: offset + i * everySix, lengthSix: len,
          trimStartSix: 0, trimEndSix: len, gain: 1 });
      }
    };

    const names = ['Drums', 'Snare', 'Hats', 'Bass', 'Chords', 'Lead', 'FX', 'Accents'];
    names.forEach((n, i) => { Project.tracks[i].name = n; });

    fill(0, 'Boom Bap Kick', BAR, 8);
    fill(1, 'Snare + Clap', BAR, 8);
    fill(2, 'Hi-Hat Roll', BAR, 8);
    fill(3, '808 Slide Bass', BAR * 2, 4);
    fill(4, 'Synth Stab Chord', BAR * 2, 4);
    fill(5, 'Arp Pluck Loop', BAR * 4, 2);
    fill(6, 'Vinyl Crackle Bed', BAR * 4, 2);
    fill(7, 'Crash Accent', BAR * 4, 2);

    Project.tracks[0].vol = 0.92;
    Project.tracks[1].vol = 0.78;
    Project.tracks[2].vol = 0.46;
    Project.tracks[4].vol = 0.55;
    Project.tracks[5].vol = 0.48;
    Project.tracks[6].vol = 0.32;
    Project.tracks[7].vol = 0.62;
    return Project;
  }

  NB.bus = bus;
  NB.Library = Library;
  NB.Project = Project;
  NB.History = History;
  NB.Persistence = Persistence;
  NB.project = { initTracks, newTrack, newClip, clipEnd, addTrack, removeTrack, findClip,
    removeClip, projectFile, loadProjectFile, buildDemo, computePeaks,
    normaliseClip, reversedBuffer, SYNTH_VERSION };
  NB.LoopCache = LoopCache;
})(window.NB = window.NB || {});
