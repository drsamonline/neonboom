/* =========================================================================
   NEONBOOM · ui/pads.js
   The playable surface: a filterable pad grid with waveform tiles.
   Tap = audition. Tap while armed = drop the loop at the playhead.
   Drag a pad onto the timeline to place it exactly where you drop it.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { $, $$, el, toast, haptic, Grid } = NB.util;

  const Pads = {
    filter: 'All',
    armed: false,
    _keyMap: {},

    init() {
      this.grid = $('#padGrid');
      this.chips = $('#padChips');
      this.count = $('#padCount');
      this.recBtn = $('#btnRecArm');

      this.renderChips();
      this.render();

      this._wireKeys();

      this.recBtn.addEventListener('click', () => {
        this.armed = !this.armed;
        this.recBtn.classList.toggle('on', this.armed);
        toast(this.armed ? 'Rec armed — pad taps drop clips at the playhead' : 'Rec off', '', 1600);
        haptic(10);
      });

      NB.bus.on('library:changed', () => { this.renderChips(); this.render(); });
    },

    /* Roving tabindex: one tab stop for the whole grid, arrow keys inside it.
       A 27-pad grid that swallows 27 tab stops is hostile to keyboard users. */
    _wireKeys() {
      this.grid.addEventListener('keydown', (e) => {
        const pads = Array.from(this.grid.querySelectorAll('.pad'));
        if (!pads.length) return;
        const i = pads.indexOf(document.activeElement);
        const cols = (getComputedStyle(this.grid).gridTemplateColumns || '').split(' ').filter(Boolean).length || 3;
        let next = null;
        if (e.key === 'ArrowRight') next = i + 1;
        else if (e.key === 'ArrowLeft') next = i - 1;
        else if (e.key === 'ArrowDown') next = i + cols;
        else if (e.key === 'ArrowUp') next = i - cols;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = pads.length - 1;
        else if (e.key === 'Enter' || e.key === ' ') {
          /* pads fire on pointerdown, so a synthetic click would do nothing */
          if (i >= 0) {
            e.preventDefault();
            const id = pads[i].dataset.id;
            pads[i].classList.add('hit');
            setTimeout(() => pads[i].classList.remove('hit'), 120);
            this.trigger(id);
          }
          return;
        }
        if (next == null) return;
        e.preventDefault();
        const clamped = Math.max(0, Math.min(pads.length - 1, next));
        pads.forEach((p, k) => { p.tabIndex = k === clamped ? 0 : -1; });
        pads[clamped].focus();
      });
    },

    renderChips() {
      const cats = ['All', ...NB.Library.categories()];
      this.chips.innerHTML = '';
      cats.forEach((c) => {
        const b = el('button', { class: 'chip' + (c === this.filter ? ' on' : ''), text: c });
        b.addEventListener('click', () => {
          this.filter = c;
          $$('.chip', this.chips).forEach((x) => x.classList.toggle('on', x.textContent === c));
          this.render();
        });
        this.chips.appendChild(b);
      });
    },

    visibleSamples() {
      const all = NB.Library.list();
      return this.filter === 'All' ? all : all.filter((s) => s.category === this.filter);
    },

    render() {
      const list = this.visibleSamples();
      this.grid.innerHTML = '';
      this._keyMap = {};
      this.count.textContent = `${list.length}`;

      const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'Q', 'W', 'E', 'R', 'A', 'S'];

      list.forEach((s, i) => {
        const pad = el('button', {
          class: 'pad',
          draggable: 'true',
          'data-id': s.id,
          'aria-label': s.name,
          tabindex: i === 0 ? '0' : '-1',
        });
        pad.style.setProperty('--pad-color', s.color);
        pad.innerHTML = `
          <span class="pname">${escapeHtml(s.name)}</span>
          <canvas class="pwave" width="220" height="52"></canvas>
          <span class="pcat"><i></i>${escapeHtml(s.category)}</span>
          ${i < keys.length ? `<span class="pkey">${keys[i]}</span>` : ''}`;

        drawPadWave(pad.querySelector('canvas'), s, s.color);
        if (i < keys.length) this._keyMap[keys[i].toLowerCase()] = s.id;

        pad.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          pad.classList.add('hit');
          setTimeout(() => pad.classList.remove('hit'), 120);
          haptic(8);
          this.trigger(s.id);
        });
        pad.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/sample-id', s.id);
          e.dataTransfer.effectAllowed = 'copy';
        });
        this.grid.appendChild(pad);
      });
    },

    /* audition + optional placement. `velocity` (0..1) comes from MIDI. */
    trigger(sampleId, velocity) {
      const s = NB.Library.get(sampleId);
      if (!s) return;
      const level = velocity == null ? 1 : Math.max(0.05, Math.min(1, velocity));
      NB.Engine.preview(s.buffer, NB.Project.bpm / s.refBpm, level);
      if (this.armed) {
        const trackId = NB.Timeline.selectedTrackId || NB.Project.tracks[0].id;
        const clip = NB.Transport.recordPad(sampleId, trackId);
        NB.Timeline.select(clip.id);
        NB.Persistence.saveSoon();
      }
    },

    place(sampleId, trackId, startSix) {
      NB.History.push();
      const track = NB.Project.tracks.find((t) => t.id === trackId) || NB.Project.tracks[0];
      const clip = NB.project.newClip(sampleId, track.id, Math.max(0, startSix));
      track.clips.push(clip);
      NB.Timeline.selectedClipId = clip.id;
      NB.Timeline.selectedTrackId = track.id;
      NB.bus.emit('clips:changed');
      NB.Timeline.updateStatus();
      NB.Persistence.saveSoon();
      toast(`Added "${(NB.Library.get(sampleId) || {}).name}" at bar ${Grid.toBBT(startSix).bar}`, 'ok', 1400);
    },

    keyPress(key) {
      const id = this._keyMap[key.toLowerCase()];
      if (!id) return false;
      const pad = this.grid.querySelector(`.pad[data-id="${id}"]`);
      if (pad) { pad.classList.add('hit'); setTimeout(() => pad.classList.remove('hit'), 120); }
      this.trigger(id);
      return true;
    },
  };

  function drawPadWave(canvas, sample, color) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const peaks = sample.peaks;
    const mid = h / 2;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(0, mid - 0.5, w, 1);
    const bars = Math.min(w / 2, 110);
    const stepW = w / bars;
    for (let i = 0; i < bars; i++) {
      const v = peaks[Math.floor((i / bars) * peaks.length)] || 0;
      const bh = Math.max(1, v * (h * 0.44));
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.55 + v * 0.45;
      ctx.fillRect(i * stepW, mid - bh, Math.max(1, stepW - 1), bh * 2);
    }
    ctx.globalAlpha = 1;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  NB.Pads = Pads;
})(window.NB = window.NB || {});
