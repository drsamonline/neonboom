/* =========================================================================
   NEONBOOM · ui/mixer.js
   Per-track strips: fader, pan, mute, solo, live level meter.
   Rebuilt only on structural change — never while a fader is being dragged.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { $, $$, el, toast, haptic } = NB.util;

  const Mixer = {
    mount(host) {
      this.host = host;
      this.render();
      if (!this._meterHooked) { this._meterHooked = true; NB.util.Frame.add(() => this.tickMeters()); }
      NB.bus.on('project:replaced', () => this.render());
    },

    render() {
      if (!this.host) return;
      const P = NB.Project;
      this.host.innerHTML = '';
      const row = el('div', { class: 'mixRow' });

      P.tracks.forEach((t, i) => {
        const strip = el('div', { class: 'mstrip' + (t.id === NB.Timeline.selectedTrackId ? ' sel' : '') });
        strip.dataset.trackId = t.id;
        strip.innerHTML = `
          <div class="mtrk">${String(i + 1).padStart(2, '0')}</div>
          <div class="mname" style="color:${t.color}" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>
          <div class="mstripMeter"><i></i></div>
          <input class="mfader" type="range" min="0" max="1" step="0.01" value="${t.vol}" data-midi="track:${i}:vol" aria-label="${escapeHtml(t.name)} volume">
          <div class="mval">${Math.round(t.vol * 100)}%</div>
          <input class="mpan" type="range" min="-1" max="1" step="0.02" value="${t.pan}" data-midi="track:${i}:pan" aria-label="${escapeHtml(t.name)} pan">
          <div class="msend" title="Delay send"><b>A</b><input class="msendA" type="range" min="0" max="1" step="0.01" value="${t.sendA || 0}" data-midi="track:${i}:sendA" aria-label="Delay send"></div>
          <div class="msend" title="Reverb send"><b>B</b><input class="msendB" type="range" min="0" max="1" step="0.01" value="${t.sendB || 0}" data-midi="track:${i}:sendB" aria-label="Reverb send"></div>
          <div class="mbtns">
            <button class="tbtn m ${t.mute ? 'on' : ''}" data-act="mute">M</button>
            <button class="tbtn s ${t.solo ? 'on' : ''}" data-act="solo">S</button>
          </div>`;
        row.appendChild(strip);
      });

      const add = el('button', { class: 'btn', text: '+ Track', style: 'align-self:flex-start;margin-left:4px;' });
      add.addEventListener('click', () => NB.Shell.addTrack());
      row.appendChild(add);
      this.host.appendChild(row);

      this.host.oninput = (e) => {
        const strip = e.target.closest('.mstrip');
        if (!strip) return;
        const t = P.tracks.find((x) => x.id === strip.dataset.trackId);
        if (!t) return;
        if (e.target.classList.contains('mfader')) {
          t.vol = parseFloat(e.target.value);
          strip.querySelector('.mval').textContent = Math.round(t.vol * 100) + '%';
          NB.Engine.applyMix(P.tracks);
        }
        if (e.target.classList.contains('mpan')) {
          t.pan = parseFloat(e.target.value);
          NB.Engine.setTrackPan(P.tracks.indexOf(t), t.pan);
        }
        if (e.target.classList.contains('msendA')) {
          t.sendA = parseFloat(e.target.value);
          NB.Engine.setTrackSends(P.tracks.indexOf(t), t.sendA, t.sendB || 0);
        }
        if (e.target.classList.contains('msendB')) {
          t.sendB = parseFloat(e.target.value);
          NB.Engine.setTrackSends(P.tracks.indexOf(t), t.sendA || 0, t.sendB);
        }
      };
      this.host.onchange = () => NB.Persistence.saveSoon();
      this.host.onclick = (e) => {
        const btn = e.target.closest('button[data-act]');
        const strip = e.target.closest('.mstrip');
        if (!strip) return;
        const t = P.tracks.find((x) => x.id === strip.dataset.trackId);
        if (!t) return;
        if (!btn) { NB.Timeline.selectedTrackId = t.id; this.render(); NB.Timeline.rebuildHeaders(); return; }
        if (btn.dataset.act === 'mute') t.mute = !t.mute;
        if (btn.dataset.act === 'solo') t.solo = !t.solo;
        NB.Engine.applyMix(P.tracks);
        this.render();
        NB.Timeline.rebuildHeaders();
        NB.Timeline.draw();
        NB.Persistence.saveSoon();
        haptic(6);
      };
    },

    tickMeters() {
      if (!this.host || !NB.Engine || !this.host.offsetParent) return;
      const bars = $$('.mstrip .mstripMeter i', this.host);
      for (let i = 0; i < bars.length; i++) {
        const lvl = NB.Engine.readTrackLevel(i);
        bars[i].style.width = Math.min(100, lvl * 150) + '%';
        bars[i].style.background = lvl > 0.72 ? 'var(--danger)' : lvl > 0.4 ? 'var(--warn)' : 'var(--ok)';
      }
    },
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  NB.Mixer = Mixer;
})(window.NB = window.NB || {});
