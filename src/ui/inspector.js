/* =========================================================================
   NEONBOOM · ui/inspector.js
   Context panel: the selected clip, the selected track, or the project.
   Everything here is an action on the current selection — no menus to hunt.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { $, el, Grid, SIX_PER_BAR, toast } = NB.util;

  const Inspector = {
    mount(host) {
      this.host = host;
      this.render();
      NB.bus.on('selection', () => this.render());
      NB.bus.on('clips:changed', () => this.render());
      NB.bus.on('project:replaced', () => this.render());
      NB.bus.on('loop', () => this.render());
    },

    render() {
      if (!this.host) return;
      const T = NB.Timeline;
      const sel = T.selectedClipId ? NB.project.findClip(T.selectedClipId) : null;
      this.host.innerHTML = '';

      if (!sel) {
        this.host.appendChild(this.projectCard());
        this.host.appendChild(this.trackCard());
        return;
      }

      const { clip, track } = sel;
      const sample = NB.Library.get(clip.sampleId);
      const len = clip.trimEndSix - clip.trimStartSix;

      const card = el('div', { class: 'insp-card' });
      card.innerHTML = `
        <h4>Clip <span style="color:var(--ink-3);font-weight:400;text-transform:none;letter-spacing:0">${track.name}</span></h4>
        <div class="insp-title">${escapeHtml(sample ? sample.name : 'missing sample')}</div>
        <div class="insp-sub">${sample ? sample.category : '—'} · ${(sample ? sample.refBpm : 90)} BPM source</div>
        <canvas class="insp-wave" width="520" height="112"></canvas>
        <div class="statRow"><span>Starts at</span><b>${Grid.fmtBBT(clip.startSix)}</b></div>
        <div class="statRow"><span>Length</span><b>${Grid.fmtBars(len)}</b></div>
        <div class="statRow"><span>Ends at</span><b>${Grid.fmtBBT(clip.startSix + len)}</b></div>
        <div class="statRow"><span>Trim in / out</span><b>${clip.trimStartSix} / ${clip.trimEndSix}</b></div>
      `;
      this.host.appendChild(card);
      drawClipWave(card.querySelector('canvas'), sample, clip, track.color);

      /* clip gain */
      const gainCard = el('div', { class: 'insp-card' });
      gainCard.innerHTML = `<h4>Clip gain</h4>
        <div class="knobRow"><label>Gain</label>
          <input type="range" min="0" max="1.5" step="0.01" value="${clip.gain == null ? 1 : clip.gain}">
          <span class="val">${Math.round((clip.gain == null ? 1 : clip.gain) * 100)}%</span></div>`;
      const gIn = gainCard.querySelector('input');
      const gOut = gainCard.querySelector('.val');
      gIn.addEventListener('input', () => {
        clip.gain = parseFloat(gIn.value);
        gOut.textContent = Math.round(clip.gain * 100) + '%';
      });
      gIn.addEventListener('change', () => { NB.Transport.refresh(); NB.Persistence.saveSoon(); });
      this.host.appendChild(gainCard);

      /* actions */
      const act = el('div', { class: 'insp-card' });
      act.innerHTML = '<h4>Actions</h4><div class="grid2" id="clipActions"></div>';
      const g = act.querySelector('#clipActions');
      const mk = (label, fn, cls = '') => {
        const b = el('button', { class: 'btn ' + cls, text: label });
        b.addEventListener('click', fn);
        g.appendChild(b);
      };
      mk('Split', () => T.splitAtPlayhead());
      mk('Duplicate', () => T.duplicateSelected());
      mk('Quantize', () => T.quantize());
      mk('Delete', () => T.deleteSelected(), 'danger');
      this.host.appendChild(act);

      const nudge = el('div', { class: 'insp-card' });
      nudge.innerHTML = '<h4>Nudge</h4><div class="grid2" id="nudgeBtns"></div>';
      const nb = nudge.querySelector('#nudgeBtns');
      [['◀ bar', -SIX_PER_BAR], ['◀ 16th', -1], ['16th ▶', 1], ['bar ▶', SIX_PER_BAR]].forEach(([label, d]) => {
        const b = el('button', { class: 'btn', text: label });
        b.addEventListener('click', () => T.nudge(d));
        nb.appendChild(b);
      });
      this.host.appendChild(nudge);
    },

    projectCard() {
      const P = NB.Project;
      const clips = P.tracks.reduce((n, t) => n + t.clips.length, 0);
      const card = el('div', { class: 'insp-card' });
      card.innerHTML = `
        <h4>Project</h4>
        <div class="insp-title">${escapeHtml(P.name)}</div>
        <div class="statRow"><span>Tracks</span><b>${P.tracks.length}</b></div>
        <div class="statRow"><span>Clips</span><b>${clips}</b></div>
        <div class="statRow"><span>Tempo</span><b>${P.bpm} BPM</b></div>
        <div class="statRow"><span>Loop</span><b>${P.loopEnabled ? Grid.fmtBBT(P.loopIn) + ' → ' + Grid.fmtBBT(P.loopOut) : 'off'}</b></div>
        <div class="grid2" style="margin-top:10px" id="projBtns"></div>`;
      const box = card.querySelector('#projBtns');
      const mk = (label, fn, cls = '') => {
        const b = el('button', { class: 'btn ' + cls, text: label });
        b.addEventListener('click', fn);
        box.appendChild(b);
      };
      mk('Load demo', () => NB.Shell.loadDemo());
      mk('Save file', () => NB.Shell.saveProjectFile());
      mk('Open file', () => NB.Shell.openProjectFile());
      mk('Export WAV', () => NB.Shell.exportWav());
      return card;
    },

    trackCard() {
      const P = NB.Project;
      const id = NB.Timeline.selectedTrackId;
      const t = P.tracks.find((x) => x.id === id) || P.tracks[0];
      if (!t) return el('div');
      const card = el('div', { class: 'insp-card' });
      card.innerHTML = `
        <h4>Track <span style="color:var(--ink-3);font-weight:400;text-transform:none;letter-spacing:0">${P.tracks.indexOf(t) + 1}</span></h4>
        <div class="knobRow"><label>Name</label>
          <input type="text" value="${escapeHtml(t.name)}" style="flex:1" maxlength="24"></div>
        <div class="knobRow"><label>Volume</label>
          <input type="range" min="0" max="1" step="0.01" value="${t.vol}"><span class="val">${Math.round(t.vol * 100)}%</span></div>
        <div class="knobRow"><label>Pan</label>
          <input type="range" min="-1" max="1" step="0.02" value="${t.pan}"><span class="val">${t.pan === 0 ? 'C' : (t.pan > 0 ? 'R' : 'L') + Math.round(Math.abs(t.pan) * 100)}</span></div>
        <div class="grid2" style="margin-top:6px" id="trkBtns"></div>`;
      const [nameIn] = card.querySelectorAll('input[type=text]');
      nameIn.addEventListener('change', () => {
        t.name = nameIn.value.slice(0, 24) || t.name;
        NB.Timeline.rebuildHeaders(); NB.Mixer.render(); NB.Persistence.saveSoon();
      });
      const [volIn, panIn] = card.querySelectorAll('input[type=range]');
      volIn.addEventListener('input', () => {
        t.vol = parseFloat(volIn.value);
        volIn.nextElementSibling.textContent = Math.round(t.vol * 100) + '%';
        NB.Engine.applyMix(P.tracks);
        NB.Timeline.rebuildHeaders();
      });
      panIn.addEventListener('input', () => {
        t.pan = parseFloat(panIn.value);
        panIn.nextElementSibling.textContent = t.pan === 0 ? 'C' : (t.pan > 0 ? 'R' : 'L') + Math.round(Math.abs(t.pan) * 100);
        NB.Engine.setTrackPan(P.tracks.indexOf(t), t.pan);
      });
      card.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => NB.Persistence.saveSoon()));

      const box = card.querySelector('#trkBtns');
      const clear = el('button', { class: 'btn danger', text: 'Clear clips' });
      clear.addEventListener('click', () => {
        if (!t.clips.length) { toast('Track is already empty', 'warn'); return; }
        NB.History.push();
        t.clips = [];
        NB.bus.emit('clips:changed');
        NB.Transport.refresh();
        NB.Persistence.saveSoon();
      });
      const del = el('button', { class: 'btn danger', text: 'Delete track' });
      del.addEventListener('click', () => NB.Shell.removeTrack(t.id));
      box.appendChild(clear); box.appendChild(del);
      return card;
    },
  };

  function drawClipWave(canvas, sample, clip, color) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#07090b'; ctx.fillRect(0, 0, w, h);
    if (!sample) return;
    const peaks = sample.peaks;
    const total = sample.beats * 4;
    const i0 = Math.floor((clip.trimStartSix / total) * peaks.length);
    const i1 = Math.ceil((clip.trimEndSix / total) * peaks.length);
    const n = Math.max(1, i1 - i0);
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const v = peaks[Math.min(peaks.length - 1, i0 + Math.floor((x / w) * n))] || 0;
      const bh = Math.max(1, v * (h * 0.44));
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.55 + v * 0.45;
      ctx.fillRect(x, mid - bh, 1, bh * 2);
    }
    ctx.globalAlpha = 1;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  NB.Inspector = Inspector;
})(window.NB = window.NB || {});
