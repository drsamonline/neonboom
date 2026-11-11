/* =========================================================================
   NEONBOOM · audio/record.js
   Record from the default input (mic, interface, loopback) straight into a
   sample. MediaRecorder → decodeAudioData → the same registry an imported file
   uses, so a take behaves exactly like any other sample: pads, trim, tempo-fit,
   stems, export.

   Nothing is uploaded anywhere; the stream is consumed locally and stopped the
   moment you stop recording.
   ========================================================================= */
(function (NB) {
  'use strict';

  const Recorder = {
    stream: null,
    recorder: null,
    chunks: [],
    startedAt: 0,
    active: false,
    error: null,

    get supported() {
      return typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia &&
        typeof MediaRecorder !== 'undefined';
    },

    pickMime() {
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      for (const m of candidates) {
        try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
      }
      return '';
    },

    async start() {
      if (this.active) return false;
      if (!this.supported) { this.error = 'unsupported'; NB.bus.emit('record', { state: 'unsupported' }); return false; }

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (err) {
        this.error = err && err.name ? err.name : 'blocked';
        NB.bus.emit('record', { state: this.error });
        return false;
      }

      const mimeType = this.pickMime();
      try {
        this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
      } catch (err) {
        this._release();
        this.error = 'recorder-failed';
        NB.bus.emit('record', { state: this.error });
        return false;
      }

      this.chunks = [];
      this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
      this.recorder.start(120);
      this.startedAt = performance.now();
      this.active = true;
      this.error = null;
      NB.bus.emit('record', { state: 'recording' });
      return true;
    },

    /* Stops the stream, decodes the take and registers it as a sample. */
    async stop() {
      if (!this.active || !this.recorder) return null;
      const elapsed = (performance.now() - this.startedAt) / 1000;

      const done = new Promise((resolve) => {
        this.recorder.onstop = () => resolve(new Blob(this.chunks, { type: this.recorder.mimeType || 'audio/webm' }));
      });
      try { this.recorder.stop(); } catch (e) {}
      const blob = await done;
      this._release();
      this.active = false;
      NB.bus.emit('record', { state: 'idle', seconds: elapsed });

      if (!blob || !blob.size) { this.error = 'empty'; return null; }

      try {
        const bytes = await blob.arrayBuffer();
        const buffer = await NB.Engine.ctx.decodeAudioData(bytes.slice(0));
        const n = NB.Library.list().filter((s) => s.isUser).length + 1;
        const id = NB.Library.register({
          name: `Take ${n}`,
          buffer,
          category: 'Imported',
          color: '#ef5b5b',
          refBpm: NB.Project.bpm,
          isUser: true,
          rawBytes: bytes,
        });
        const sample = NB.Library.get(id);
        NB.bus.emit('library:changed');
        NB.Persistence.saveSoon();
        return sample;
      } catch (err) {
        this.error = 'decode-failed';
        NB.bus.emit('record', { state: this.error });
        return null;
      }
    },

    async toggle() {
      return this.active ? this.stop() : this.start();
    },

    seconds() {
      return this.active ? (performance.now() - this.startedAt) / 1000 : 0;
    },

    _release() {
      if (this.recorder) { try { this.recorder.onstop = null; } catch (e) {} }
      if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); }
      this.recorder = null;
      this.stream = null;
    },
  };

  NB.Recorder = Recorder;
})(window.NB = window.NB || {});
