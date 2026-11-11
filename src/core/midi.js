/* =========================================================================
   NEONBOOM · core/midi.js
   Web MIDI input. Opt-in: the permission prompt only appears when you ask for
   it, and the app is fully playable with a mouse or a finger without it.

   Default mapping (MPC-style, C1 upward):
     notes base+0 … base+15   → the first 16 visible pads, velocity scales level
     note  base+16            → play / pause
     note  base+17            → rewind
   ========================================================================= */
(function (NB) {
  'use strict';

  const Midi = {
    ready: false,
    error: null,
    access: null,
    base: 36,                 // C1
    inputs: [],
    lastNote: 0,

    get supported() { return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess; },

    status() {
      if (!this.supported) return 'unsupported';
      if (this.error) return this.error;
      if (!this.ready) return 'off';
      return this.inputs.length ? `${this.inputs.length} input${this.inputs.length > 1 ? 's' : ''}` : 'no devices';
    },

    /* Call from a user gesture — that is when the browser will show the prompt. */
    async enable() {
      if (!this.supported) { this.error = 'unsupported'; return false; }
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
        this.ready = true;
        this.error = null;
        this.access.onstatechange = () => this.bind();
        this.bind();
        NB.bus.emit('midi', this.status());
        return true;
      } catch (err) {
        this.error = err && err.name ? err.name.toLowerCase() : 'blocked';
        NB.bus.emit('midi', this.status());
        return false;
      }
    },

    bind() {
      if (!this.access) return;
      this.inputs = [];
      this.access.inputs.forEach((input) => {
        this.inputs.push(input.name || 'input');
        input.onmidimessage = (msg) => this.onMessage(msg);
      });
      NB.bus.emit('midi', this.status());
    },

    onMessage(msg) {
      const d = msg && msg.data;
      if (!d || d.length < 2) return;
      const cmd = d[0] & 0xf0;
      const note = d[1];
      const vel = d.length > 2 ? d[2] : 0;
      if (cmd === 0x90 && vel > 0) this.noteOn(note, vel);
      else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) this.noteOff(note);
    },

    noteOn(note, velocity) {
      const idx = note - this.base;
      this.lastNote = note;
      NB.bus.emit('midi:note', { note, velocity });

      if (idx === 16) { NB.Transport.toggle(); return; }
      if (idx === 17) { NB.Transport.rewind(); return; }
      if (idx < 0 || idx > 15) return;

      const samples = NB.Pads.visibleSamples();
      const sample = samples[idx];
      if (!sample) return;
      NB.Pads.trigger(sample.id, velocity / 127);
    },

    noteOff() { /* one-shots: nothing to release */ },
  };

  NB.Midi = Midi;
})(window.NB = window.NB || {});
