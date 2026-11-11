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
    ccMap: {},                // { "74": "fx:delayMix" }
    learning: null,           // null | 'control' | 'cc'
    learnTarget: null,

    get supported() { return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess; },

    status() {
      if (!this.supported) return 'unsupported';
      if (this.error) return this.error;
      if (!this.ready) return 'off';
      return this.inputs.length ? `${this.inputs.length} input${this.inputs.length > 1 ? 's' : ''}` : 'no devices';
    },

    /* ---- CC mapping ---------------------------------------------------
       Two-step learn: arm it, move a control in the app (that names the
       target), then move a knob on the controller (that names the CC). The
       binding is applied by setting the control's value and dispatching an
       `input` event, so every existing handler runs unchanged. */
    loadMap() {
      try {
        const raw = localStorage.getItem('nb-ccmap');
        this.ccMap = raw ? JSON.parse(raw) : {};
      } catch (e) { this.ccMap = {}; }
      return this.ccMap;
    },

    saveMap() {
      try { localStorage.setItem('nb-ccmap', JSON.stringify(this.ccMap)); } catch (e) {}
    },

    beginLearn() {
      this.learning = 'control';
      this.learnTarget = null;
      NB.bus.emit('midi:learn', { stage: 'control' });
      return 'control';
    },

    cancelLearn() {
      this.learning = null;
      this.learnTarget = null;
      NB.bus.emit('midi:learn', { stage: null });
    },

    /* called from a capturing input listener while learning */
    offerControl(el) {
      if (this.learning !== 'control') return false;
      const target = el && el.dataset ? el.dataset.midi : null;
      if (!target) return false;
      this.learnTarget = target;
      this.learning = 'cc';
      NB.bus.emit('midi:learn', { stage: 'cc', target });
      return true;
    },

    bindCC(cc) {
      if (!this.learnTarget) return false;
      this.ccMap[String(cc)] = this.learnTarget;
      this.saveMap();
      const target = this.learnTarget;
      this.cancelLearn();
      NB.bus.emit('midi:bound', { cc, target });
      return true;
    },

    clearMap() {
      this.ccMap = {};
      this.saveMap();
      NB.bus.emit('midi:bound', { cleared: true });
    },

    applyCC(cc, value) {
      const target = this.ccMap[String(cc)];
      if (!target) return false;
      const el = document.querySelector(`[data-midi="${target}"]`);
      if (!el) return false;
      const min = parseFloat(el.min || '0');
      const max = parseFloat(el.max || '1');
      const v = min + (value / 127) * (max - min);
      const step = parseFloat(el.step || '0.01') || 0.01;
      el.value = String(Math.round(v / step) * step);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
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
      if (cmd === 0xb0) {                    // control change
        if (this.learning === 'cc') { this.bindCC(note); return; }
        this.applyCC(note, vel);
        return;
      }
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
