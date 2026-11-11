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

      /* several clips selected: show a bulk card instead of one clip */
      if (T.selectedClipIds && T.selectedClipIds.size > 1) {
        const n = T.selectedClipIds.size;
        const card = el('div', { class: 'insp-card' });
        card.innerHTML = `<h4>Selection</h4>
          <div class="insp-title">${n} clips</div>
          <div class="insp-sub">drag to move them together · shift-click to add or remove</div>
          <div class="grid2" id="bulkBtns"></div>`;
        const box = card.querySelector('#bulkBtns');
        const mk = (label, fn, cls = '') => {
          const b = el('button', { class: 'btn ' + cls, text: label });
          b.addEventListener('click', fn);
          box.appendChild(b);
        };
        mk('Duplicate', () => T.duplicateSelected());
        mk('Quantise', () => T.quantize());
        mk('Nudge ◀', () => T.nudge(-T.P.snap));
        mk('Nudge ▶', () => T.nudge(T.P.snap));
        mk('Delete', () => T.deleteSelected(), 'danger');
        mk('Deselect', () => T.select(null));
        this.host.appendChild(card);
        this.host.appendChild(this.projectCard());
        return;
      }

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
          <input type="range" aria-label="Clip gain" min="0" max="1.5" step="0.01" value="${clip.gain == null ? 1 : clip.gain}">
          <span class="val">${Math.round((clip.gain == null ? 1 : clip.gain) * 100)}%</span></div>`;
      const gIn = gainCard.querySelector('input');
      const gOut = gainCard.querySelector('.val');
      gIn.addEventListener('input', () => {
        clip.gain = parseFloat(gIn.value);
        gOut.textContent = Math.round(clip.gain * 100) + '%';
      });
      gIn.addEventListener('change', () => { NB.Transport.refresh(); NB.Persistence.saveSoon(); });
      this.host.appendChild(gainCard);

      /* sound: pitch, reverse, fades */
      const sound = el('div', { class: 'insp-card' });
      const pitch = clip.pitch || 0;
      sound.innerHTML = `<h4>Sound</h4>
        <div class="knobRow"><label>Pitch</label>
          <input type="range" aria-label="Clip pitch in semitones" min="-12" max="12" step="1" value="${pitch}" data-k="pitch">
          <span class="val">${pitch > 0 ? '+' : ''}${pitch} st</span></div>
        <div class="knobRow"><label>Fade in</label>
          <input type="range" aria-label="Fade in" min="0" max="${Math.floor(len / 2)}" step="1" value="${clip.fadeIn || 0}" data-k="fadeIn">
          <span class="val">${clip.fadeIn || 0}/16</span></div>
        <div class="knobRow"><label>Fade out</label>
          <input type="range" aria-label="Fade out" min="0" max="${Math.floor(len / 2)}" step="1" value="${clip.fadeOut || 0}" data-k="fadeOut">
          <span class="val">${clip.fadeOut || 0}/16</span></div>
        <div class="grid2" style="margin-top:4px">
          <button class="btn ${clip.reverse ? 'on' : ''}" id="clipReverse">${clip.reverse ? '⏪ Reversed' : '⏩ Reverse'}</button>
          <button class="btn ${clip.stretch ? 'on' : ''}" id="clipStretch">${clip.stretch ? '✓ Tempo-fit' : 'Fit tempo'}</button>
        </div>
        <div class="grid2" style="margin-top:6px">
          <button class="btn" id="clipReset">Reset</button>
        </div>
        <p style="font-size:10.5px;color:var(--ink-2);margin:8px 0 0">${clip.stretch
          ? 'Tempo-fit: the loop is time-stretched to the project tempo, so pitch stays put. The Pitch knob then only changes pitch.'
          : 'Pitch is sampler-style: it changes speed with the pitch, like a turntable. Turn on Tempo-fit to keep the pitch.'}</p>`;
      const fmtPitch = (v) => (v > 0 ? '+' : '') + v + ' st';
      sound.querySelectorAll('input[data-k]').forEach((inp) => {
        const k = inp.dataset.k;
        const out = inp.parentElement.querySelector('.val');
        inp.addEventListener('input', () => {
          clip[k] = k === 'pitch' ? parseInt(inp.value, 10) : parseInt(inp.value, 10);
          out.textContent = k === 'pitch' ? fmtPitch(clip[k]) : `${clip[k]}/16`;
          NB.Timeline.draw();
        });
        inp.addEventListener('change', () => { NB.Transport.refresh(); NB.Persistence.saveSoon(); });
      });
      sound.querySelector('#clipReverse').addEventListener('click', (e) => {
        NB.History.push();
        clip.reverse = !clip.reverse;
        e.currentTarget.classList.toggle('on', clip.reverse);
        e.currentTarget.textContent = clip.reverse ? '⏪ Reversed' : '⏩ Reverse';
        NB.Timeline.draw(); NB.Transport.refresh(); NB.Persistence.saveSoon();
      });
      sound.querySelector('#clipStretch').addEventListener('click', (e) => {
        NB.History.push(clip.stretch ? 'Tempo-fit off' : 'Tempo-fit on');
        clip.stretch = !clip.stretch;
        e.currentTarget.classList.toggle('on', clip.stretch);
        e.currentTarget.textContent = clip.stretch ? '✓ Tempo-fit' : 'Fit tempo';
        NB.Timeline.draw(); NB.Transport.refresh(); NB.Persistence.saveSoon();
        this.render();
      });
      sound.querySelector('#clipReset').addEventListener('click', () => {
        NB.History.push();
        clip.pitch = 0; clip.reverse = false; clip.fadeIn = 0; clip.fadeOut = 0; clip.gain = 1; clip.stretch = false;
        NB.Timeline.draw(); NB.Transport.refresh(); NB.Persistence.saveSoon();
        this.render();
      });
      this.host.appendChild(sound);

      /* actions */
      const act = el('div', { class: 'insp-card' });
      act.innerHTML = '<h4>Actions</h4><div class="grid2" id="clipActions"></div>';
      const g = act.querySelector('#clipActions');
      const mk = (label, fn, cls = '') => {
        const b = el('button', { class: 'btn ' + cls, text: label });
        b.addEventListener('click', fn);
        g.appendChild(b);
      };
      mk('Edit waveform', () => NB.Shell.openClipEditor(clip.id));
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
        <div class="knobRow" style="margin-top:8px"><label>Swing</label>
          <input type="range" min="0" max="0.6" step="0.02" value="${P.swing || 0}" id="projSwing">
          <span class="val">${Math.round((P.swing || 0) * 100)}%</span></div>
        <div class="grid2" style="margin-top:10px" id="projBtns"></div>`;
      const swingIn = card.querySelector('#projSwing');
      const swingOut = swingIn && swingIn.nextElementSibling;
      if (swingIn) {
        swingIn.addEventListener('input', () => {
          P.swing = parseFloat(swingIn.value);
          swingOut.textContent = Math.round(P.swing * 100) + '%';
        });
        swingIn.addEventListener('change', () => { NB.Transport.reanchor(); NB.Persistence.saveSoon(); });
      }

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
