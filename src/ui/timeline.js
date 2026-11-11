/* =========================================================================
   NEONBOOM · ui/timeline.js
   Canvas arrangement view.

   Two canvases, both sized to the VIEWPORT (never to project length — a
   64-bar project at 400% zoom would be ~74 000 px wide, past the browser's
   canvas limit and silently blank):
     #tlCanvas      content (lanes, grid, clips, waveforms) — redrawn on change
     #phCanvas      playhead overlay — redrawn per animation frame, nothing else
   Native scrolling is preserved by a spacer div; the canvases are translated
   to the scroll origin each frame.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { $, $$, clamp, Grid, SIX_PER_BAR, PROJECT_BARS, PX_PER_SIX, uid, toast, haptic, isTouch } = NB.util;

  const Timeline = {
    zoom: 1,
    mode: 'edit',
    selectedClipId: null,          // primary selection (drives the inspector)
    selectedClipIds: new Set(),    // everything the bulk actions act on
    selectedTrackId: null,
    drag: null,
    longPressTimer: 0,
    _pendingSnap: null,

    get P() { return NB.Project; },
    get tracks() { return NB.Project.tracks; },
    trackH() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--track-h')) || 66; },
    pxPerSix() { return PX_PER_SIX * this.zoom; },
    contentW() { return PROJECT_BARS * SIX_PER_BAR * this.pxPerSix(); },
    contentH() { return this.tracks.length * this.trackH(); },

    /* ------------------------------------------------------------ setup */
    init() {
      this.canvas = $('#tlCanvas');
      this.overlay = document.createElement('canvas');
      this.overlay.id = 'phCanvas';
      this.overlay.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;will-change:transform;';
      this.canvas.after ? this.canvas.after(this.overlay) : this.canvas.parentNode.appendChild(this.overlay);
      this.ruler = $('#ruler');
      this.viewport = $('#tlViewport');
      this.spacer = $('#tlSpacer');
      this.heads = $('#trackHeads');
      this.headsInner = $('#trackHeadsInner');

      this.ctx = this.canvas.getContext('2d');
      this.octx = this.overlay.getContext('2d');
      this.rctx = this.ruler.getContext('2d');

      this.rebuildHeaders();
      this.resize();

      /* scroll → pin canvases, sync headers, repaint */
      this.viewport.addEventListener('scroll', () => {
        this.pinCanvases();
        this.headsInner.style.transform = `translateY(${-this.viewport.scrollTop}px)`;
        this._rulerDirty = true;
        this.draw();
      }, { passive: true });

      /* wheel zoom (ctrl/cmd) + shift-wheel horizontal scroll */
      this.viewport.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.setZoom(this.zoom * (e.deltaY < 0 ? 1.12 : 0.89));
        }
      }, { passive: false });

      this._wireCanvas();
      this._wireRuler();

      new ResizeObserver(() => this.resize()).observe(this.viewport);
      window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));

      NB.bus.on('clips:changed', () => { this.draw(); this.updateStatus(); });
      NB.bus.on('project:replaced', () => { this.rebuildHeaders(); this.resize(); this.updateStatus(); });
      NB.bus.on('playhead', () => this.drawOverlay());
      NB.bus.on('loop', () => { this._rulerDirty = true; this.draw(); });
      NB.bus.on('transport', () => this.drawOverlay());

      /* meters run at ~30fps, independent of playback rAF */
      setInterval(() => this.updateMeters(), 33);
    },

    pinCanvases() {
      const t = `translate(${this.viewport.scrollLeft}px,${this.viewport.scrollTop}px)`;
      this.canvas.style.transform = t;
      this.overlay.style.transform = t;
    },

    resize() {
      const w = Math.max(80, this.viewport.clientWidth);
      const h = Math.max(80, this.viewport.clientHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      [this.canvas, this.overlay].forEach((c) => {
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
        c.style.width = w + 'px'; c.style.height = h + 'px';
      });
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.dpr = dpr;
      this.vw = w; this.vh = h;

      const rw = Math.max(80, w);
      this.ruler.width = Math.round(rw * dpr); this.ruler.height = Math.round(30 * dpr);
      this.ruler.style.width = rw + 'px'; this.ruler.style.height = '30px';
      this.rctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      this.spacer.style.width = this.contentW() + 'px';
      this.spacer.style.height = this.contentH() + 'px';
      this.headsInner.style.height = this.contentH() + 'px';

      this.pinCanvases();
      this._rulerDirty = true;
      this.draw();
      this.drawOverlay();
    },

    /* ------------------------------------------------------ track headers */
    rebuildHeaders() {
      const inner = this.headsInner;
      inner.innerHTML = '';
      this.tracks.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'trackHead' + (t.id === this.selectedTrackId ? ' sel' : '');
        row.dataset.trackId = t.id;
        row.style.height = this.trackH() + 'px';
        row.innerHTML = `
          <div class="thRow">
            <div class="tag" style="background:${t.color}"></div>
            <input class="tname" value="${t.name.replace(/"/g, '&quot;')}" data-act="name" aria-label="Track name">
            <span class="num">${String(i + 1).padStart(2, '0')}</span>
          </div>
          <div class="thRow">
            <button class="tbtn m ${t.mute ? 'on' : ''}" data-act="mute" title="Mute">M</button>
            <button class="tbtn s ${t.solo ? 'on' : ''}" data-act="solo" title="Solo">S</button>
            <div class="meter"><i data-meter="${i}"></i></div>
          </div>
          <div class="thRow">
            <input class="vol" type="range" min="0" max="1" step="0.01" value="${t.vol}" data-act="vol" aria-label="Volume">
          </div>`;
        inner.appendChild(row);
      });
      this.headsInner.style.height = this.contentH() + 'px';
      this.spacer.style.height = this.contentH() + 'px';

      inner.oninput = (e) => {
        const act = e.target.dataset.act;
        const id = e.target.closest('.trackHead').dataset.trackId;
        const t = this.tracks.find((x) => x.id === id);
        if (!t) return;
        if (act === 'vol') { t.vol = parseFloat(e.target.value); NB.Engine.applyMix(this.tracks); }
        if (act === 'name') { t.name = e.target.value; }
      };
      inner.onchange = (e) => {
        const act = e.target.dataset.act;
        if (act === 'name') NB.Persistence.saveSoon();
      };
      inner.onclick = (e) => {
        const btn = e.target.closest('button[data-act]');
        const row = e.target.closest('.trackHead');
        if (!row) return;
        const id = row.dataset.trackId;
        const t = this.tracks.find((x) => x.id === id);
        if (!t) return;
        this.selectedTrackId = id;
        if (btn) {
          if (btn.dataset.act === 'mute') t.mute = !t.mute;
          if (btn.dataset.act === 'solo') t.solo = !t.solo;
          NB.Engine.applyMix(this.tracks);
          this.rebuildHeaders();
          this.draw();
          NB.Persistence.saveSoon();
          haptic(6);
        } else {
          $$('.trackHead', this.headsInner).forEach((r) => r.classList.toggle('sel', r.dataset.trackId === id));
        }
      };
    },

    updateMeters() {
      if (!NB.Engine) return;
      const bars = $$('[data-meter]', this.headsInner);
      for (let i = 0; i < bars.length; i++) {
        const lvl = NB.Engine.readTrackLevel(i);
        const el = bars[i];
        el.style.width = Math.min(100, lvl * 140) + '%';
        el.style.background = lvl > 0.72 ? 'var(--danger)' : lvl > 0.4 ? 'var(--warn)' : 'var(--ok)';
      }
    },

    updateStatus() {
      const sel = this.selectedClipId ? NB.project.findClip(this.selectedClipId) : null;
      NB.bus.emit('selection', sel);
    },

    /* ------------------------------------------------------------ drawing */
    draw() {
      const ctx = this.ctx, W = this.vw, H = this.vh;
      const sx = this.viewport.scrollLeft, sy = this.viewport.scrollTop;
      const px = this.pxPerSix();
      const th = this.trackH();
      const firstTrack = Math.max(0, Math.floor(sy / th));
      const lastTrack = Math.min(this.tracks.length - 1, Math.ceil((sy + H) / th));
      const firstSix = Math.max(0, Math.floor(sx / px) - SIX_PER_BAR);
      const lastSix = Math.ceil((sx + W) / px) + SIX_PER_BAR;

      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(-sx, -sy);

      /* lanes */
      for (let i = firstTrack; i <= lastTrack; i++) {
        const y = i * th;
        ctx.fillStyle = i % 2 === 0 ? '#0d1014' : '#101419';
        ctx.fillRect(sx, y, W, th);
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.fillRect(sx, y + th - 1, W, 1);
      }

      /* grid */
      const step = this.zoom < 0.45 ? SIX_PER_BAR : (this.zoom < 0.9 ? 4 : 1);
      ctx.lineWidth = 1;
      for (let six = firstSix; six <= lastSix; six += step) {
        if (six % SIX_PER_BAR !== 0 && six % 4 !== 0 && step === 1 && this.zoom < 1.6) continue;
        const x = Math.round(six * px) + 0.5;
        const isBar = six % SIX_PER_BAR === 0;
        ctx.strokeStyle = isBar ? 'rgba(90,104,122,.55)' : (six % 4 === 0 ? 'rgba(58,68,80,.5)' : 'rgba(38,45,54,.55)');
        ctx.beginPath(); ctx.moveTo(x, sy); ctx.lineTo(x, sy + H); ctx.stroke();
      }

      /* loop region */
      const P = this.P;
      if (P.loopEnabled) {
        const a = P.loopIn * px, b = P.loopOut * px;
        ctx.fillStyle = 'rgba(255,176,32,.055)';
        ctx.fillRect(a, sy, Math.max(0, b - a), H);
        ctx.strokeStyle = 'rgba(255,176,32,.35)';
        ctx.beginPath(); ctx.moveTo(a + .5, sy); ctx.lineTo(a + .5, sy + H);
        ctx.moveTo(b - .5, sy); ctx.lineTo(b - .5, sy + H); ctx.stroke();
      }

      /* clips */
      const selId = this.selectedClipId;
      const selSet = this.selectedClipIds;
      for (let i = firstTrack; i <= lastTrack; i++) {
        const track = this.tracks[i];
        if (!track) continue;
        const y = i * th + 5, h = th - 11;
        for (const clip of track.clips) {
          const end = clip.startSix + (clip.trimEndSix - clip.trimStartSix);
          if (end < firstSix || clip.startSix > lastSix) continue;
          const x = clip.startSix * px;
          const w = Math.max(3, (end - clip.startSix) * px);
          const sel = clip.id === selId || this.selectedClipIds.has(clip.id);
          const sample = NB.Library.get(clip.sampleId);

          /* body */
          const grad = ctx.createLinearGradient(0, y, 0, y + h);
          grad.addColorStop(0, hexA(track.color, track.mute ? 0.28 : 0.92));
          grad.addColorStop(1, hexA(track.color, track.mute ? 0.16 : 0.58));
          roundRect(ctx, x, y, w, h, 5);
          ctx.fillStyle = grad; ctx.fill();

          /* waveform */
          if (sample && w > 8) {
            const peaks = sample.peaks;
            const total = sample.beats * 4;
            const i0 = clamp(Math.floor((clip.trimStartSix / total) * peaks.length), 0, peaks.length - 1);
            const i1 = clamp(Math.ceil((clip.trimEndSix / total) * peaks.length), i0 + 1, peaks.length);
            const n = i1 - i0, mid = y + h / 2;
            ctx.fillStyle = 'rgba(0,0,0,.38)';
            const stepPx = w > 220 ? 2 : 1;
            for (let p = 0; p < w; p += stepPx) {
              const v = peaks[i0 + Math.floor((p / w) * n)] || 0;
              const bh = Math.max(0.5, v * (h * 0.40));
              ctx.fillRect(x + p, mid - bh, stepPx - 0.35, bh * 2);
            }
          }

          /* header strip + name */
          ctx.fillStyle = 'rgba(0,0,0,.30)';
          roundRect(ctx, x, y, w, 13, 5);
          ctx.fill();
          if (w > 26) {
            ctx.fillStyle = contrastText(track.color);
            ctx.font = '600 9.5px ui-sans-serif,system-ui,-apple-system,sans-serif';
            ctx.save();
            ctx.beginPath(); ctx.rect(x + 4, y, w - 8, 13); ctx.clip();
            ctx.fillText(sample ? sample.name : '…', x + 5, y + 9.5);
            ctx.restore();
          }

          /* fades: a translucent wedge showing what the envelope does */
          const fadeInPx = Math.min(w, (clip.fadeIn || 0) * px);
          const fadeOutPx = Math.min(w, (clip.fadeOut || 0) * px);
          if (fadeInPx > 1) {
            ctx.fillStyle = 'rgba(0,0,0,.42)';
            ctx.beginPath();
            ctx.moveTo(x, y + h); ctx.lineTo(x, y + 13); ctx.lineTo(x + fadeInPx, y + 13);
            ctx.closePath(); ctx.fill();
          }
          if (fadeOutPx > 1) {
            ctx.fillStyle = 'rgba(0,0,0,.42)';
            ctx.beginPath();
            ctx.moveTo(x + w, y + h); ctx.lineTo(x + w, y + 13); ctx.lineTo(x + w - fadeOutPx, y + 13);
            ctx.closePath(); ctx.fill();
          }

          /* pitch / reverse badge */
          const pitch = clip.pitch || 0;
          if ((pitch !== 0 || clip.reverse) && w > 46) {
            const tag = (clip.reverse ? '⏪' : '') + (pitch !== 0 ? (pitch > 0 ? '+' : '') + pitch : '');
            ctx.font = '700 8.5px ui-monospace,Menlo,monospace';
            const tw = ctx.measureText(tag).width + 8;
            ctx.fillStyle = 'rgba(8,10,12,.78)';
            roundRect(ctx, x + w - tw - 3, y + 2.5, tw, 10, 3);
            ctx.fill();
            ctx.fillStyle = '#ffd479';
            ctx.fillText(tag, x + w - tw + 1, y + 10.5);
          }

          /* border / selection */
          roundRect(ctx, x + .5, y + .5, w - 1, h - 1, 5);
          ctx.lineWidth = sel ? 2 : 1;
          ctx.strokeStyle = sel ? '#ffb020' : 'rgba(0,0,0,.55)';
          ctx.stroke();
          if (sel) {
            ctx.fillStyle = '#ffb020';
            ctx.fillRect(x + 2, y + h / 2 - 9, 3, 18);
            ctx.fillRect(x + w - 5, y + h / 2 - 9, 3, 18);
          }
        }
      }
      ctx.restore();
      this.drawRuler();
    },

    drawOverlay() {
      if (!this.octx) return;
      const W = this.vw, H = this.vh;
      const sx = this.viewport.scrollLeft;
      const px = this.pxPerSix();
      const x = NB.Transport.currentSix() * px - sx;
      this.octx.clearRect(0, 0, W, H);
      if (x < -4 || x > W + 4) { this.drawRuler(); return; }
      this.octx.strokeStyle = '#ffb020';
      this.octx.lineWidth = 1.5;
      this.octx.beginPath();
      this.octx.moveTo(Math.round(x) + .5, 0);
      this.octx.lineTo(Math.round(x) + .5, H);
      this.octx.stroke();

      /* marquee rectangle */
      if (this._marquee) {
        const m = this._marquee;
        const rx = Math.min(m.x0, m.x1) - sx, ry = Math.min(m.y0, m.y1) - sy;
        const rw = Math.abs(m.x1 - m.x0), rh = Math.abs(m.y1 - m.y0);
        this.octx.fillStyle = 'rgba(255,176,32,.10)';
        this.octx.fillRect(rx, ry, rw, rh);
        this.octx.strokeStyle = 'rgba(255,176,32,.8)';
        this.octx.lineWidth = 1;
        this.octx.strokeRect(rx + .5, ry + .5, rw, rh);
      }
      this.drawRuler();
    },

    /* static part of the ruler: bars, ticks, loop band. Cached in an
       offscreen canvas and only rebuilt when something actually changes. */
    drawRulerBase() {
      const W = this.vw, H = 30;
      const dpr = this.dpr || 1;
      if (!this._rulerBase) { this._rulerBase = document.createElement('canvas'); this._rbctx = this._rulerBase.getContext('2d'); }
      const b = this._rulerBase;
      if (b.width !== Math.round(W * dpr) || b.height !== Math.round(H * dpr)) {
        b.width = Math.round(W * dpr); b.height = Math.round(H * dpr);
      }
      const ctx = this._rbctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const px = this.pxPerSix();
      const sx = this.viewport.scrollLeft;
      const P = this.P;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#141a21';
      ctx.fillRect(0, 0, W, 30);

      /* loop band */
      if (P.loopEnabled) {
        const a = P.loopIn * px - sx, b = P.loopOut * px - sx;
        ctx.fillStyle = 'rgba(255,176,32,.22)';
        ctx.fillRect(a, 0, Math.max(2, b - a), 6);
        ctx.fillStyle = '#ffb020';
        ctx.fillRect(a - 2, 0, 5, 12);
        ctx.fillRect(b - 3, 0, 5, 12);
      }

      /* bars */
      const firstBar = Math.max(0, Math.floor(sx / (SIX_PER_BAR * px)));
      const lastBar = Math.ceil((sx + W) / (SIX_PER_BAR * px));
      ctx.font = '10px ui-monospace,Menlo,Consolas,monospace';
      for (let bar = firstBar; bar <= lastBar; bar++) {
        const x = Math.round(bar * SIX_PER_BAR * px - sx) + .5;
        ctx.strokeStyle = '#39424e';
        ctx.beginPath(); ctx.moveTo(x, 17); ctx.lineTo(x, 30); ctx.stroke();
        if (bar < PROJECT_BARS) {
          ctx.fillStyle = '#8b96a4';
          ctx.fillText(String(bar + 1), x + 4, 15);
        }
        /* beat ticks */
        const barW = SIX_PER_BAR * px;
        if (barW > 60) {
          for (let b = 1; b < 4; b++) {
            const bx = Math.round(x + (barW * b) / 4) + .5;
            ctx.strokeStyle = '#2b333d';
            ctx.beginPath(); ctx.moveTo(bx, 24); ctx.lineTo(bx, 30); ctx.stroke();
          }
        }
      }

      this._rulerDirty = false;
    },

    drawRuler() {
      if (!this.rctx) return;
      if (!this._rulerBase || this._rulerDirty) this.drawRulerBase();
      const W = this.vw, dpr = this.dpr || 1;
      const ctx = this.rctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.ruler.width, this.ruler.height);
      ctx.drawImage(this._rulerBase, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const phx = NB.Transport.currentSix() * this.pxPerSix() - this.viewport.scrollLeft;
      ctx.fillStyle = '#ffb020';
      ctx.beginPath();
      ctx.moveTo(phx - 5, 0); ctx.lineTo(phx + 5, 0); ctx.lineTo(phx, 9);
      ctx.closePath(); ctx.fill();
    },

    /* ------------------------------------------------------- interactions */
    _local(e) {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: e.clientX - r.left + this.viewport.scrollLeft,
        y: e.clientY - r.top + this.viewport.scrollTop,
      };
    },

    hitTest(x, y) {
      const th = this.trackH();
      const idx = Math.floor(y / th);
      const track = this.tracks[idx];
      if (!track) return null;
      const six = x / this.pxPerSix();
      for (let i = track.clips.length - 1; i >= 0; i--) {
        const c = track.clips[i];
        const end = c.startSix + (c.trimEndSix - c.trimStartSix);
        if (six >= c.startSix && six <= end) {
          /* edge zones are measured in SCREEN pixels (not musical units) and
             capped at a third of the clip so short clips stay draggable. */
          const px = this.pxPerSix();
          const wPx = (end - c.startSix) * px;
          const edgePx = Math.min(isTouch() ? 16 : 9, Math.max(3, wPx / 3));
          const dLeft = (six - c.startSix) * px;
          const dRight = (end - six) * px;
          let edge = null;
          if (dLeft < edgePx) edge = 'left';
          else if (dRight < edgePx) edge = 'right';
          return { clip: c, track, trackIdx: idx, edge };
        }
      }
      return { clip: null, track, trackIdx: idx };
    },

    /* Rubber-band selection on an empty lane. Only engages once the pointer
       has actually moved, so a plain tap still clears the selection. */
    _startMarquee(e, x, y) {
      const c = this.canvas;
      const startX = x, startY = y;
      let active = false;
      const add = e.shiftKey || e.metaKey || e.ctrlKey;

      const move = (ev) => {
        const p = this._local(ev);
        if (!active && Math.hypot(p.x - startX, p.y - startY) < 6) return;
        if (!active) { active = true; this._marquee = { x0: startX, y0: startY, x1: p.x, y1: p.y }; }
        this._marquee.x1 = p.x; this._marquee.y1 = p.y;
        this.draw();
      };
      const up = () => {
        c.removeEventListener('pointermove', move);
        if (active && this._marquee) {
          const m = this._marquee;
          const n = this.selectInRect(m.x0, m.y0, m.x1, m.y1, add);
          if (n) haptic(5);
        } else {
          this.selectedClipId = null;
          this.selectedClipIds.clear();
          this.draw(); this.updateStatus();
        }
        this._marquee = null;
        this.draw();
      };
      c.addEventListener('pointermove', move);
      c.addEventListener('pointerup', up, { once: true });
      c.addEventListener('pointercancel', up, { once: true });
    },

    _wireCanvas() {
      const c = this.canvas;

      c.addEventListener('pointerdown', (e) => {
        if (e.button === 2) return;             // context menu handled below
        c.setPointerCapture(e.pointerId);
        const { x, y } = this._local(e);
        const hit = this.hitTest(x, y);
        if (!hit) return;

        this.selectedTrackId = hit.track.id;
        $$('.trackHead', this.headsInner).forEach((r) => r.classList.toggle('sel', r.dataset.trackId === hit.track.id));

        if (!hit.clip) {
          /* empty lane: start a marquee unless this is a plain tap */
          this._startMarquee(e, x, y);
          return;
        }

        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          this.select(hit.clip.id, true);
          return;                                  // shift-click never drags
        }
        if (!this.selectedClipIds.has(hit.clip.id)) this.select(hit.clip.id);
        else { this.selectedClipId = hit.clip.id; this.draw(); this.updateStatus(); }

        const isTouchEvent = e.pointerType !== 'mouse';
        if (isTouchEvent && this.mode === 'scroll') return;   // tap-select only

        this._pendingSnap = NB.History.snapshot();
        const moved = { v: false };

        if (hit.edge) {
          this.drag = { type: 'trim', edge: hit.edge, clip: hit.clip, startX: x,
            orig: JSON.parse(JSON.stringify(hit.clip)), moved };
        } else if (e.altKey || e.ctrlKey) {
          /* alt-drag duplicates */
          const dup = JSON.parse(JSON.stringify(hit.clip));
          dup.id = uid('clp');
          dup.startSix = hit.clip.startSix + (hit.clip.trimEndSix - hit.clip.trimStartSix);
          hit.track.clips.push(dup);
          this.selectedClipId = dup.id;
          this.drag = { type: 'move', clip: dup, startX: x, origStart: dup.startSix, origTrack: hit.track.id, moved };
          moved.v = true;
        } else {
          const group = this.selectedClipIds.size > 1
            ? this.selectionIds().map((id) => {
                const f = NB.project.findClip(id);
                return f ? { clip: f.clip, start: f.clip.startSix } : null;
              }).filter(Boolean)
            : null;
          this.drag = { type: 'move', clip: hit.clip, startX: x, origStart: hit.clip.startSix,
            origTrack: hit.track.id, moved, group };
        }

        /* long-press → clip actions. The timer is only a convenience: onUp
           re-checks the elapsed time, so a starved timer (heavy render, slow
           device) still opens the sheet instead of silently doing nothing. */
        const pressStart = performance.now();
        this._pressStart = pressStart;
        clearTimeout(this.longPressTimer);
        this.longPressTimer = setTimeout(() => {
          if (this.drag && !this.drag.moved.v) {
            this.drag = null;
            this._pressStart = 0;
            haptic(14);
            NB.Shell.openClipSheet(this.selectedClipId);
          }
        }, 470);

        c.addEventListener('pointermove', onMove);
        c.addEventListener('pointerup', onUp, { once: true });
        c.addEventListener('pointercancel', onUp, { once: true });

        function onMove(ev) {
          const self = Timeline;
          if (!self.drag) return;
          const p = self._local(ev);
          const px = self.pxPerSix();
          const dxSix = (p.x - self.drag.startX) / px;
          if (Math.abs(p.x - self.drag.startX) > 3 && !self.drag.moved.v) {
            self.drag.moved.v = true;
            clearTimeout(self.longPressTimer);
            if (self._pendingSnap) { NB.History.commit(self._pendingSnap, self.drag.type === 'trim' ? 'Trim clip' : 'Move clip'); self._pendingSnap = null; }
          }
          if (!self.drag.moved.v) return;

          if (self.drag.type === 'move') {
            const snap = self.P.snap;
            let ns = Math.round((self.drag.origStart + dxSix) / snap) * snap;
            const delta = Math.max(-self.drag.origStart, ns - self.drag.origStart);
            self.drag.clip.startSix = self.drag.origStart + delta;
            /* move the rest of the selection by the same amount */
            if (self.selectedClipIds.size > 1 && self.drag.group) {
              self.drag.group.forEach((g) => {
                g.clip.startSix = Math.max(0, g.start + delta);
              });
            }
            const th = self.trackH();
            const ni = clamp(Math.floor(p.y / th), 0, self.tracks.length - 1);
            const nt = self.tracks[ni];
            if (nt && nt.id !== self.drag.clip.trackId) {
              const old = self.tracks.find((t) => t.id === self.drag.clip.trackId);
              if (old) old.clips = old.clips.filter((cc) => cc.id !== self.drag.clip.id);
              self.drag.clip.trackId = nt.id;
              nt.clips.push(self.drag.clip);
              self.selectedTrackId = nt.id;
            }
          } else {
            const snap = self.P.snap, o = self.drag.orig;
            if (self.drag.edge === 'right') {
              const sample = NB.Library.get(self.drag.clip.sampleId);
              const maxLen = sample ? Math.round(sample.beats * 4) : o.trimEndSix;
              let ne = Math.round((o.trimEndSix + dxSix) / snap) * snap;
              ne = clamp(ne, o.trimStartSix + snap, maxLen);
              self.drag.clip.trimEndSix = ne;
            } else {
              let nst = Math.round((o.trimStartSix + dxSix) / snap) * snap;
              nst = clamp(nst, 0, o.trimEndSix - snap);
              const delta = nst - o.trimStartSix;
              self.drag.clip.trimStartSix = nst;
              self.drag.clip.startSix = Math.max(0, o.startSix + delta);
            }
          }
          self.draw();
        }

        function onUp() {
          const self = Timeline;
          clearTimeout(self.longPressTimer);
          const held = self._pressStart ? performance.now() - self._pressStart : 0;
          self._pressStart = 0;
          if (held > 450 && self.drag && !self.drag.moved.v) {
            self.drag = null;
            haptic(14);
            NB.Shell.openClipSheet(self.selectedClipId);
            return;
          }
          c.removeEventListener('pointermove', onMove);
          if (self.drag && self.drag.moved.v) {
            self.draw();
            NB.Transport.refresh();
            NB.Persistence.saveSoon();
            self.updateStatus();
          }
          self.drag = null;
          self._pendingSnap = null;
        }
      });

      c.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const { x, y } = this._local(e);
        const hit = this.hitTest(x, y);
        if (hit && hit.clip) {
          this.selectedClipId = hit.clip.id;
          this.draw(); this.updateStatus();
          NB.Shell.openClipSheet(hit.clip.id);
        }
      });

      c.addEventListener('dblclick', (e) => {
        const { x, y } = this._local(e);
        const hit = this.hitTest(x, y);
        if (hit && hit.clip) NB.Shell.openClipSheet(hit.clip.id);
      });

      /* drag & drop from pads */
      c.addEventListener('dragover', (e) => e.preventDefault());
      c.addEventListener('drop', (e) => {
        e.preventDefault();
        const sampleId = e.dataTransfer.getData('text/sample-id');
        if (!sampleId) return;
        const { x, y } = this._local(e);
        const idx = clamp(Math.floor(y / this.trackH()), 0, this.tracks.length - 1);
        const six = Math.round((x / this.pxPerSix()) / this.P.snap) * this.P.snap;
        NB.Pads.place(sampleId, this.tracks[idx].id, Math.max(0, six));
      });
    },

    _wireRuler() {
      const r = this.ruler;
      const localSix = (e) => {
        const rect = r.getBoundingClientRect();
        const x = e.clientX - rect.left + this.viewport.scrollLeft;
        const snap = this.P.snap;
        return Math.max(0, Math.round((x / this.pxPerSix()) / snap) * snap);
      };

      r.addEventListener('pointerdown', (e) => {
        r.setPointerCapture(e.pointerId);
        const P = this.P;
        const six = localSix(e);
        const rect = r.getBoundingClientRect();
        const xPx = e.clientX - rect.left;
        const inA = Math.abs((P.loopIn * this.pxPerSix() - this.viewport.scrollLeft) - xPx) < 12;
        const inB = Math.abs((P.loopOut * this.pxPerSix() - this.viewport.scrollLeft) - xPx) < 12;
        const inside = P.loopEnabled && xPx > P.loopIn * this.pxPerSix() - this.viewport.scrollLeft &&
          xPx < P.loopOut * this.pxPerSix() - this.viewport.scrollLeft;

        if (e.shiftKey || inA || inB || inside) {
          if (!P.loopEnabled) { P.loopEnabled = true; NB.bus.emit('loop'); }
          const anchor = inA ? 'in' : inB ? 'out' : inside ? 'move' : 'new';
          const start = { six, loopIn: P.loopIn, loopOut: P.loopOut };
          const move = (ev) => {
            const s2 = localSix(ev);
            if (anchor === 'in') P.loopIn = Math.min(s2, P.loopOut - P.snap);
            else if (anchor === 'out') P.loopOut = Math.max(s2, P.loopIn + P.snap);
            else if (anchor === 'move') {
              const delta = s2 - start.six;
              const len = start.loopOut - start.loopIn;
              let ni = Math.max(0, start.loopIn + delta);
              P.loopIn = ni; P.loopOut = ni + len;
            } else {
              P.loopIn = Math.min(start.six, s2);
              P.loopOut = Math.max(start.six, s2);
              if (P.loopOut - P.loopIn < P.snap) P.loopOut = P.loopIn + this.P.snap;
            }
            this.draw(); NB.bus.emit('loop');
          };
          const up = () => {
            r.removeEventListener('pointermove', move);
            if (P.loopOut - P.loopIn < this.P.snap) P.loopOut = P.loopIn + SIX_PER_BAR;
            NB.bus.emit('loop');
            NB.Persistence.saveSoon();
            NB.Transport.reanchor();
          };
          r.addEventListener('pointermove', move);
          r.addEventListener('pointerup', up, { once: true });
        } else {
          NB.Transport.seekTo(six);
        }
      });
    },

    /* ---------------------------------------------------------- operations */
    setZoom(z, focusSix) {
      const prev = this.zoom;
      this.zoom = clamp(z, 0.18, 5);
      if (this.zoom === prev) return;
      this.spacer.style.width = this.contentW() + 'px';
      if (focusSix != null) {
        const target = focusSix * this.pxPerSix() - this.vw / 2;
        this.viewport.scrollLeft = Math.max(0, target);
      }
      this._rulerDirty = true;
      this.draw(); this.drawOverlay();
      NB.bus.emit('zoom', this.zoom);
    },
    zoomIn() { this.setZoom(this.zoom * 1.25, NB.Transport.currentSix()); },
    zoomOut() { this.setZoom(this.zoom / 1.25, NB.Transport.currentSix()); },
    zoomFit() {
      let endSix = SIX_PER_BAR * 8;
      this.tracks.forEach((t) => t.clips.forEach((c) => {
        endSix = Math.max(endSix, c.startSix + (c.trimEndSix - c.trimStartSix));
      }));
      this.setZoom((this.vw - 24) / (endSix * PX_PER_SIX));
      this.viewport.scrollLeft = 0;
      this.draw(); this.drawOverlay();
    },

    setMode(m) {
      this.mode = m;
      this.viewport.classList.toggle('edit', m === 'edit');
      NB.bus.emit('mode', m);
    },

    /* ---- clipboard ---------------------------------------------------- */
    copySelected() {
      const f = this.selectedClipId ? NB.project.findClip(this.selectedClipId) : null;
      if (!f) { toast('Select a clip first', 'warn'); return false; }
      this.clipboard = JSON.parse(JSON.stringify(f.clip));
      toast('Copied', '', 1000);
      return true;
    },

    cutSelected() {
      if (!this.copySelected()) return false;
      this.deleteSelected();
      return true;
    },

    paste() {
      if (!this.clipboard) { toast('Clipboard is empty', 'warn'); return false; }
      const P = this.P;
      const track = this.tracks.find((t) => t.id === this.selectedTrackId) || this.tracks[0];
      NB.History.push('Paste clip');
      const clip = JSON.parse(JSON.stringify(this.clipboard));
      clip.id = uid('clp');
      clip.trackId = track.id;
      const six = Math.round(NB.Transport.currentSix() / P.snap) * P.snap;
      clip.startSix = Math.max(0, six);
      track.clips.push(clip);
      this.selectedClipId = clip.id;
      this.selectedTrackId = track.id;
      NB.bus.emit('clips:changed');
      NB.Persistence.saveSoon();
      haptic(6);
      return true;
    },

    select(clipId, additive) {
      if (!clipId) {
        this.selectedClipId = null;
        this.selectedClipIds.clear();
      } else if (additive) {
        if (this.selectedClipIds.has(clipId)) {
          this.selectedClipIds.delete(clipId);
          if (this.selectedClipId === clipId) this.selectedClipId = [...this.selectedClipIds][0] || null;
        } else {
          this.selectedClipIds.add(clipId);
          this.selectedClipId = clipId;
        }
        const f = clipId ? NB.project.findClip(clipId) : null;
        if (f) this.selectedTrackId = f.track.id;
      } else {
        this.selectedClipId = clipId;
        this.selectedClipIds = new Set([clipId]);
        const f = NB.project.findClip(clipId);
        if (f) this.selectedTrackId = f.track.id;
      }
      this.draw(); this.updateStatus();
    },

    selectInRect(x0, y0, x1, y1, additive) {
      const px = this.pxPerSix(), th = this.trackH();
      const left = Math.min(x0, x1) / px, right = Math.max(x0, x1) / px;
      const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
      const hits = [];
      this.tracks.forEach((track, ti) => {
        const ty = ti * th;
        if (ty + th < top || ty > bottom) return;
        track.clips.forEach((c) => {
          const end = c.startSix + (c.trimEndSix - c.trimStartSix);
          if (end >= left && c.startSix <= right) hits.push(c.id);
        });
      });
      if (!additive) this.selectedClipIds.clear();
      hits.forEach((id) => this.selectedClipIds.add(id));
      this.selectedClipId = [...this.selectedClipIds][0] || null;
      this.draw(); this.updateStatus();
      return hits.length;
    },

    selectionIds() {
      if (this.selectedClipIds.size) return [...this.selectedClipIds];
      return this.selectedClipId ? [this.selectedClipId] : [];
    },

    splitAtPlayhead() {
      const id = this.selectedClipId;
      if (!id) { toast('Select a clip first', 'warn'); return; }
      const found = NB.project.findClip(id);
      if (!found) return;
      const { clip, track } = found;
      const six = Math.round(NB.Transport.currentSix());
      const start = clip.startSix, end = start + (clip.trimEndSix - clip.trimStartSix);
      if (six <= start + 0 || six >= end) { toast('Playhead is not over the clip', 'warn'); return; }
      NB.History.push('Split clip');
      const cut = six - start;
      const second = JSON.parse(JSON.stringify(clip));
      second.id = uid('clp');
      second.trimStartSix = clip.trimStartSix + cut;
      second.startSix = six;
      clip.trimEndSix = clip.trimStartSix + cut;
      track.clips.push(second);
      this.selectedClipId = second.id;
      NB.bus.emit('clips:changed');
      NB.Transport.refresh();
      NB.Persistence.saveSoon();
    },

    deleteSelected() {
      const ids = this.selectionIds();
      if (!ids.length) { toast('Nothing selected', 'warn'); return; }
      NB.History.push(ids.length > 1 ? `Delete ${ids.length} clips` : 'Delete clip');
      ids.forEach((id) => NB.project.removeClip(id));
      this.selectedClipId = null;
      this.selectedClipIds.clear();
      NB.bus.emit('clips:changed');
      NB.Transport.refresh();
      NB.Persistence.saveSoon();
      haptic(10);
    },

    duplicateSelected() {
      const ids = this.selectionIds();
      if (!ids.length) { toast('Nothing selected', 'warn'); return; }
      NB.History.push(ids.length > 1 ? `Duplicate ${ids.length} clips` : 'Duplicate clip');
      const made = [];
      ids.forEach((id) => {
        const f = NB.project.findClip(id);
        if (!f) return;
        const dup = JSON.parse(JSON.stringify(f.clip));
        dup.id = uid('clp');
        dup.startSix = f.clip.startSix + (f.clip.trimEndSix - f.clip.trimStartSix);
        f.track.clips.push(dup);
        made.push(dup.id);
      });
      this.selectedClipIds = new Set(made);
      this.selectedClipId = made[0] || null;
      NB.bus.emit('clips:changed');
      NB.Persistence.saveSoon();
    },

    nudge(sixDelta) {
      const ids = this.selectionIds();
      if (!ids.length) return;
      NB.History.push(ids.length > 1 ? `Nudge ${ids.length} clips` : 'Nudge clip');
      ids.forEach((id) => {
        const f = NB.project.findClip(id);
        if (f) f.clip.startSix = Math.max(0, f.clip.startSix + sixDelta);
      });
      NB.bus.emit('clips:changed');
      NB.Transport.refresh();
      NB.Persistence.saveSoon();
    },

    quantize() {
      const ids = this.selectionIds();
      if (!ids.length) { toast('Nothing selected', 'warn'); return; }
      NB.History.push('Quantise');
      const s = this.P.snap;
      ids.forEach((id) => {
        const f = NB.project.findClip(id);
        if (f) f.clip.startSix = Math.round(f.clip.startSix / s) * s;
      });
      NB.bus.emit('clips:changed');
      NB.Transport.refresh();
      toast('Quantized to ' + (s === 1 ? '1/16' : s === 2 ? '1/8' : '1/4'), 'ok', 1200);
    },

    scrollToPlayhead() {
      const x = NB.Transport.currentSix() * this.pxPerSix();
      if (x < this.viewport.scrollLeft || x > this.viewport.scrollLeft + this.vw - 60) {
        this.viewport.scrollLeft = Math.max(0, x - this.vw * 0.35);
      }
    },
  };

  /* ---------- canvas helpers ---------- */
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  /* dark ink on light track colours, light ink on dark ones */
  function contrastText(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? 'rgba(8,10,12,.92)' : 'rgba(255,255,255,.94)';
  }

  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  NB.Timeline = Timeline;
  NB.drawHelpers = { roundRect, hexA };
})(window.NB = window.NB || {});
