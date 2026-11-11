/* =========================================================================
   NEONBOOM · core/util.js
   Tiny helpers, grid math, toasts, haptics. No dependencies.
   ========================================================================= */
(function (NB) {
  'use strict';

  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp  = (a, b, t) => a + (b - a) * t;

  const uid = (() => {
    let n = 1;
    return (p = 'id') => `${p}_${(n++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  })();

  const deepClone = (o) => JSON.parse(JSON.stringify(o));

  const debounce = (fn, ms) => {
    let t = 0;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  const rafThrottle = (fn) => {
    let queued = false, lastArgs;
    return (...args) => {
      lastArgs = args;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fn(...lastArgs); });
    };
  };

  const isTouch = () => matchMedia('(hover:none)').matches;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion:reduce)').matches;

  const haptic = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };

  /* ---------- musical grid --------------------------------------------- */
  const REF_BPM = 90;              // procedural loops are rendered at this tempo
  const BEATS_PER_BAR = 4;
  const SIX_PER_BAR = 16;          // 4/4, 16th-note grid
  const PROJECT_BARS = 64;
  const PX_PER_SIX = 18;           // base pixels per 16th at zoom 1

  const Grid = {
    spSix(bpm) { return (60 / bpm) / 4; },
    sixToSec(sx, bpm) { return sx * Grid.spSix(bpm); },
    secToSix(s, bpm) { return s / Grid.spSix(bpm); },
    toBBT(sx) {
      const s = Math.max(0, sx);
      return {
        bar: Math.floor(s / SIX_PER_BAR) + 1,
        beat: Math.floor((s % SIX_PER_BAR) / 4) + 1,
        six: Math.floor(s % 4) + 1,
      };
    },
    fmtBBT(sx) {
      const { bar, beat, six } = Grid.toBBT(sx);
      return `${String(bar).padStart(3, '0')}:${beat}:${six}`;
    },
    fmtBars(sx) {
      const bars = sx / SIX_PER_BAR;
      return Number.isInteger(bars) ? `${bars} bar${bars === 1 ? '' : 's'}` : `${bars.toFixed(2)} bars`;
    },
  };

  /* Okabe–Ito derived, colour-blind-safe alternative palette */
  const SAFE_COLORS = ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9', '#d55e00',
    '#f0e442', '#8c6bb1', '#4daf4a', '#a6761d', '#1b9e77', '#7570b3',
    '#66a61e', '#e7298a', '#e6ab02', '#666666'];

  const TRACK_COLORS = ['#4fd1c5', '#e85d9c', '#b4e61d', '#ff9f43', '#5b8def', '#ef5b5b',
    '#a56bff', '#2dd4bf', '#f2c94c', '#ff7a90', '#6fcf97', '#9b8cff',
    '#ff6b9d', '#3ddc97', '#ffb020', '#7c8cff'];

  /* Track colours are stored per track, so switching palettes has to rewrite
     them. `paletteColor(i)` is what new tracks and the switcher use. */
  function paletteColor(i) {
    const safe = document.documentElement.dataset.palette === 'safe';
    const list = safe ? SAFE_COLORS : TRACK_COLORS;
    return list[i % list.length];
  }

  function applyPaletteToProject(project) {
    project.tracks.forEach((t, i) => { t.color = paletteColor(i); });
  }

  /* ---------- toasts ---------------------------------------------------- */
  let toastHost;
  function toast(msg, kind = '', ms = 2200) {
    toastHost = toastHost || $('#toasts');
    if (!toastHost) return;
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    toastHost.appendChild(el);
    while (toastHost.children.length > 3) toastHost.firstChild.remove();
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 260);
    }, ms);
  }

  /* ---------- tiny DOM builder ----------------------------------------- */
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    (Array.isArray(children) ? children : children ? [children] : []).forEach(c => {
      if (c == null) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  const fmtDb = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
  const fmtPct = (v) => Math.round(v * 100) + '%';
  const fmtSec = (s) => {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  /* safe filename */
  const slug = (s) => (s || 'neonboom').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

  NB.util = { $, $$, clamp, lerp, uid, deepClone, debounce, rafThrottle, isTouch, reducedMotion,
    haptic, toast, el, fmtDb, fmtPct, fmtSec, slug, Grid, TRACK_COLORS, SAFE_COLORS,
    paletteColor, applyPaletteToProject, REF_BPM, SIX_PER_BAR, PROJECT_BARS, PX_PER_SIX };
})(window.NB = window.NB || {});
