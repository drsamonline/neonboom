/* =========================================================================
   NEONBOOM · ui/shell.js
   Transport bar, drawer (mixer / fx / export / help), mobile views, sheets,
   keyboard shortcuts, file import, project files, export.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { $, $$, el, clamp, Grid, toast, haptic, slug, fmtSec } = NB.util;

  const ICONS = {
    play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
    pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>',
  };

  const Shell = {
    drawer: 'mixer',

    init() {
      this.lcd = $('#lcdPos');
      this.playBtn = $('#btnPlay');
      this.bpmInput = $('#bpm');
      this.saveState = $('#saveState');

      this.wireTransport();
      this.wireDrawer();
      this.wireTabs();
      this.wireZoom();
      this.wireImport();
      this.wireKeyboard();
      this.wireSheet();
      this.wireMidiLearn();
      this.wireInstall();

      this.buildVu();
      this.wireLcd();

      NB.bus.on('transport', (s) => { this.onTransport(s); this.announce(s.playing ? 'Playing' : 'Paused'); });
      NB.bus.on('playhead', () => this.updateLcd());
      NB.bus.on('saved', () => this.setSaved(true));
      NB.bus.on('saving', () => this.setSaved(false));
      NB.bus.on('loop', () => this.syncLoopBtn());
      NB.bus.on('announce', (text) => this.announce(text));
      NB.bus.on('history', (s) => {
        $('#btnUndo').disabled = !s.canUndo;
        $('#btnRedo').disabled = !s.canRedo;
      });

      try {
        const pal = localStorage.getItem('nb-palette');
        const size = localStorage.getItem('nb-textsize');
        if (pal) document.documentElement.dataset.palette = pal;
        if (size) document.documentElement.dataset.textsize = size;
      } catch (e) {}

      this.openDrawer('mixer');
      this.updateLcd();
      this.syncLoopBtn();
      $('#btnUndo').disabled = true;
      $('#btnRedo').disabled = true;

      NB.util.Frame.add(() => this.updateVu());
      /* per-frame work stays minimal: LCD text only. Meters run on a timer. */
      NB.Transport.onTick(() => this.updateLcd());
    },

    /* ------------------------------------------------------------ top bar */
    wireTransport() {
      $('#btnPlay').addEventListener('click', () => NB.Transport.toggle());
      $('#btnStop').addEventListener('click', () => NB.Transport.stop());
      $('#btnRewind').addEventListener('click', () => NB.Transport.rewind());
      $('#btnLoop').addEventListener('click', () => {
        const P = NB.Project;
        P.loopEnabled = !P.loopEnabled;
        if (P.loopEnabled && P.loopOut <= P.loopIn) { P.loopIn = 0; P.loopOut = 16 * 4; }
        NB.Timeline.draw();
        this.syncLoopBtn();
        NB.Transport.reanchor();
        NB.Persistence.saveSoon();
        haptic(8);
      });
      $('#btnMetro').addEventListener('click', (e) => {
        NB.Project.metronome = !NB.Project.metronome;
        e.currentTarget.classList.toggle('on', NB.Project.metronome);
        toast(NB.Project.metronome ? 'Metronome on' : 'Metronome off', '', 1200);
      });
      $('#btnUndo').addEventListener('click', () => { if (!NB.History.undo()) toast('Nothing to undo', 'warn', 1200); });
      $('#btnRedo').addEventListener('click', () => { if (!NB.History.redo()) toast('Nothing to redo', 'warn', 1200); });
      $('#btnExport').addEventListener('click', () => this.exportWav());
      $('#btnHelp').addEventListener('click', () => this.openDrawer('help'));
      $('#btnAddTrack').addEventListener('click', () => this.addTrack());

      $$('[data-tempo]').forEach((b) => b.addEventListener('click', () => {
        const P = NB.Project;
        NB.Transport.setBpm(clamp(P.bpm + parseInt(b.dataset.tempo, 10), 40, 220));
        this.bpmInput.value = NB.Project.bpm;
        NB.Fx.retime();
        NB.Persistence.saveSoon();
      }));

      this.bpmInput.addEventListener('change', () => {
        const P = NB.Project;
        NB.Transport.setBpm(clamp(parseInt(this.bpmInput.value || '90', 10), 40, 220));
        this.bpmInput.value = NB.Project.bpm;
        NB.Fx.retime();
        NB.Persistence.saveSoon();
      });

      /* keep the playhead visible while rolling */
      let lastScroll = 0;
      NB.bus.on('playhead', () => {
        if (!NB.Transport.playing) return;
        const now = performance.now();
        if (now - lastScroll < 400) return;
        lastScroll = now;
        NB.Timeline.scrollToPlayhead();
      });
    },

    /* screen readers get the same feedback the eyes get */
    announce(text) {
      const el = $('#announce');
      if (!el) return;
      el.textContent = '';
      setTimeout(() => { el.textContent = text; }, 30);
    },

    onTransport(s) {
      const playing = !!s.playing;
      this.playBtn.classList.toggle('on', playing);
      const svg = this.playBtn.querySelector('svg');
      if (svg) svg.innerHTML = playing ? ICONS.pause : ICONS.play;
      this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    },

    syncLoopBtn() { $('#btnLoop').classList.toggle('on', NB.Project.loopEnabled); },

    updateLcd() {
      const txt = Grid.fmtBBT(NB.Transport.currentSix());
      if (this._lcdText !== txt) { this._lcdText = txt; this.lcd.textContent = txt; }
    },

    wireLcd() {
      const lcd = $('#lcd');
      lcd.addEventListener('click', () => {
        if (window.matchMedia('(max-width:860px)').matches) this.openTransportSheet();
        else { this.bpmInput.focus(); this.bpmInput.select(); }
      });
      this.syncLcdSub();
      setInterval(() => this.syncLcdSub(), 800);
    },

    /* phones drop the separate tempo widget: BPM lives in the LCD line */
    syncLcdSub() {
      const sub = $('#lcdSub');
      if (!sub) return;
      const small = window.matchMedia('(max-width:680px)').matches;
      const txt = small
        ? `${NB.Project.bpm} BPM · ${NB.Project.snap === 1 ? '1/16' : NB.Project.snap === 2 ? '1/8' : '1/4'}`
        : 'BAR · BEAT · 16TH';
      if (sub.textContent !== txt) sub.textContent = txt;
    },

    openTransportSheet() {
      const P = NB.Project;
      this.sheet(`
        <h4>Transport</h4>
        <div class="sheetRow"><label>Tempo</label>
          <button class="btn" id="tsDown" style="min-width:44px">−</button>
          <input type="number" id="tsBpm" value="${P.bpm}" min="40" max="220" style="width:74px;text-align:center">
          <button class="btn" id="tsUp" style="min-width:44px">+</button>
          <span style="font-size:11px;color:var(--ink-2)">BPM</span></div>
        <div class="sheetRow"><label>Snap</label>
          <select id="tsSnap" style="flex:1">
            <option value="4"${P.snap === 4 ? ' selected' : ''}>1/4 bar</option>
            <option value="2"${P.snap === 2 ? ' selected' : ''}>1/8 bar</option>
            <option value="1"${P.snap === 1 ? ' selected' : ''}>1/16 bar</option>
          </select></div>
        <div class="sheetRow"><label>Metronome</label>
          <input type="checkbox" id="tsMetro" ${P.metronome ? 'checked' : ''} style="width:24px;height:24px"></div>
        <div class="sheetRow"><label>Loop</label>
          <span style="font-family:var(--mono);font-size:11px;flex:1">${P.loopEnabled ? Grid.fmtBBT(P.loopIn) + ' → ' + Grid.fmtBBT(P.loopOut) : 'off'}</span>
          <button class="btn" id="tsLoop">${P.loopEnabled ? 'Off' : 'On'}</button></div>
        <div class="sheetBtns">
          <button class="btn" id="tsRewind">Rewind</button>
          <button class="btn primary" id="tsPlay">Play / Pause</button>
        </div>`);
      const s = $('#sheet');
      const setBpm = (v) => {
        NB.Transport.setBpm(clamp(v, 40, 220));
        $('#tsBpm', s).value = NB.Project.bpm;
        this.bpmInput.value = NB.Project.bpm;
        NB.Fx.retime();
        this.syncLcdSub();
        NB.Persistence.saveSoon();
      };
      $('#tsDown', s).addEventListener('click', () => setBpm(P.bpm - 1));
      $('#tsUp', s).addEventListener('click', () => setBpm(P.bpm + 1));
      $('#tsBpm', s).addEventListener('change', (e) => setBpm(parseInt(e.target.value, 10) || P.bpm));
      $('#tsSnap', s).addEventListener('change', (e) => { P.snap = parseInt(e.target.value, 10); this.syncLcdSub(); NB.Persistence.saveSoon(); });
      $('#tsMetro', s).addEventListener('change', (e) => { P.metronome = e.target.checked; $('#btnMetro').classList.toggle('on', P.metronome); });
      $('#tsLoop', s).addEventListener('click', () => { this.closeSheet(); $('#btnLoop').click(); });
      $('#tsRewind', s).addEventListener('click', () => { this.closeSheet(); NB.Transport.rewind(); });
      $('#tsPlay', s).addEventListener('click', () => { this.closeSheet(); NB.Transport.toggle(); });
    },

    buildVu() {
      const host = $('#masterVu');
      host.innerHTML = '';
      for (let i = 0; i < 10; i++) host.appendChild(el('i'));
      this.vuBars = $$('i', host);
    },

    updateVu() {
      if (!this.vuBars || !NB.Engine) return;
      const levels = NB.Engine.readMasterVU(10);
      for (let i = 0; i < this.vuBars.length; i++) {
        const v = levels[i] || 0;
        const bar = this.vuBars[i];
        const cls = v > 0.78 ? 'hot' : v > 0.12 ? 'on' : '';
        if (bar.className !== cls) bar.className = cls;
      }
    },

    setSaved(ok) {
      if (!this.saveState) return;
      this.saveState.textContent = ok ? 'saved' : 'saving…';
      this.saveState.style.color = ok ? 'var(--ink-2)' : 'var(--amber)';
    },

    /* ------------------------------------------------------------- drawer */
    wireDrawer() {
      $$('#drawerTabs button').forEach((b) => {
        b.addEventListener('click', () => this.openDrawer(b.dataset.drawer));
      });
    },

    openDrawer(name) {
      this.drawer = name;
      const drawer = $('#drawer');
      drawer.dataset.open = 'true';
      $$('#drawerTabs button').forEach((b) => b.classList.toggle('on', b.dataset.drawer === name));
      const host = $('#drawerBody');
      if (name === 'mixer') { host.innerHTML = ''; NB.Mixer.mount(host); }
      if (name === 'history') this.renderHistory(host);
      if (name === 'fx') { host.innerHTML = ''; NB.Fx.mount(host); }
      if (name === 'export') this.renderExport(host);
      if (name === 'help') this.renderHelp(host);
      if (window.matchMedia('(max-width:900px)').matches) drawer.classList.add('mobileOpen');
    },

    renderExport(host) {
      host.innerHTML = `
        <div class="pane">
          <h3>Export</h3>
          <p>Renders the arrangement through the same master chain you are hearing and writes a 16-bit PCM WAV. Everything happens on this device — nothing is uploaded.</p>
          <div class="row">
            <button class="btn primary" id="exWav">Download WAV</button>
            <button class="btn" id="exLoop">Download loop region</button>
            <button class="btn" id="exStems">Download stems (.zip)</button>
            <button class="btn" id="exJson">Save project file</button>
            <button class="btn" id="exOpen">Open project file</button>
          </div>
          <div class="row">
            <button class="btn" id="exPack">Load sample pack (.zip)…</button>
            <button class="btn danger" id="exClear">Clear autosave &amp; start over</button>
          </div>
          <p style="font-size:11px;color:var(--ink-2)" id="exPackNote"></p>
          <p style="font-size:11px;color:var(--ink-2)">Tip: bounce a short loop region for a sample pack, or the whole arrangement for a track. Stems render each track on its own, through the same master chain, and arrive as one zip. Long renders (&gt;8 min) take a few seconds and a chunk of memory.</p>
        </div>`;
      $('#exWav', host).addEventListener('click', () => this.exportWav(false));
      $('#exLoop', host).addEventListener('click', () => this.exportWav(true));
      $('#exStems', host).addEventListener('click', () => this.exportStems());
      $('#exJson', host).addEventListener('click', () => this.saveProjectFile());
      $('#exOpen', host).addEventListener('click', () => this.openProjectFile());
      const note = $('#exPackNote', host);
      if (note) {
        note.textContent = NB.LoopPack.lastResult === 'installed'
          ? 'Pack installed — loops came from the pack instead of synthesis.'
          : 'Optional: a pack of the 27 loops (~7 MB) skips synthesis on a cold start. The app works without it.';
      }
      $('#exPack', host).addEventListener('click', () => this.loadPackFile());

      $('#exClear', host).addEventListener('click', async () => {
        if (!confirm('Clear the autosaved project and start fresh? This cannot be undone.')) return;
        await NB.Persistence.clear();
        location.reload();
      });
    },

    renderHistory(host) {
      const list = NB.History.list();
      if (!list.length) {
        host.innerHTML = '<div class="pane"><h3>History</h3><p>Nothing yet — every edit lands here as a named step you can jump back to.</p></div>';
        return;
      }
      host.innerHTML = `<div class="pane">
        <h3>History</h3>
        <p style="margin-bottom:10px">Newest first. Click a step to go back to the state before it.</p>
        <div id="histList"></div>
      </div>`;
      const box = $('#histList', host);
      list.forEach((h) => {
        const row = el('button', { class: 'histRow' });
        row.innerHTML = `<span class="histLabel">${h.label}</span>
          <span class="histStep">${h.stepsBack} step${h.stepsBack === 1 ? '' : 's'} back</span>`;
        row.addEventListener('click', () => {
          NB.History.jumpTo(h.index);
          this.openDrawer('history');
          NB.Persistence.saveSoon();
        });
        box.appendChild(row);
      });
      const clear = el('button', { class: 'btn danger', text: 'Clear history', style: 'margin-top:12px' });
      clear.addEventListener('click', () => {
        NB.History.undoStack.length = 0;
        NB.History.labels.length = 0;
        NB.History.redoStack.length = 0;
        NB.bus.emit('history', { canUndo: false, canRedo: false });
        this.openDrawer('history');
      });
      box.appendChild(clear);
    },

    renderHelp(host) {
      host.innerHTML = `
        <div class="pane">
          <h3>NEONBOOM 1.1</h3>
          <p>A beat workstation that lives in a tab. All 27 loops are synthesised on this device at boot — there are no audio downloads, no account, and no server. Your project autosaves to this browser.</p>
          <h3 style="font-size:12px;margin-top:14px">Keyboard</h3>
          <div class="shortcuts">
            <div><span>Play / pause</span><span class="kbd">Space</span></div>
            <div><span>Rewind</span><span class="kbd">R</span></div>
            <div><span>Loop on / off</span><span class="kbd">L</span></div>
            <div><span>Metronome</span><span class="kbd">K</span></div>
            <div><span>Split at playhead</span><span class="kbd">S</span></div>
            <div><span>Delete clip</span><span class="kbd">Del</span></div>
            <div><span>Duplicate clip</span><span class="kbd">Ctrl D</span></div>
            <div><span>Nudge clip</span><span class="kbd">← →</span></div>
            <div><span>Quantize</span><span class="kbd">Q</span></div>
            <div><span>Undo / redo</span><span class="kbd">Ctrl Z / Y</span></div>
            <div><span>Zoom</span><span class="kbd">- +</span></div>
            <div><span>Fit project</span><span class="kbd">F</span></div>
            <div><span>Mute track</span><span class="kbd">M</span></div>
            <div><span>Audition pads</span><span class="kbd">1-0 Q W</span></div>
            <div><span>MIDI pads</span><span class="kbd">notes 36-51</span></div>
            <div><span>MIDI transport</span><span class="kbd">notes 52 / 53</span></div>
            <div><span>MIDI CC learn</span><span class="kbd">More → Appearance</span></div>
          </div>
          <h3 style="font-size:12px;margin-top:16px">MIDI</h3>
          <p style="font-size:11.5px">Plug in a controller, then <b>More → Appearance → Enable</b> under MIDI in. Notes 36–51 fire the first 16 pads with velocity; note 52 starts and stops; 53 rewinds. For knobs: press <b>Learn</b>, move a control in the app, then move a knob on the controller. Nothing is sent anywhere — the browser talks to the device directly.</p>
          <h3 style="font-size:12px;margin-top:16px">Credits &amp; licence</h3>
          <p style="font-size:11.5px">Built by <b>Dr Sohil Momin</b> · <a href="https://github.com/drsamonline/neonboom" target="_blank" rel="noopener">github.com/drsamonline/neonboom</a>.
          Licensed under the <b>PolyForm Noncommercial License 1.0.0</b> — free for personal, study, teaching, research and non-profit use; commercial use needs a separate licence.</p>
          <p style="font-size:11.5px">No third-party code, fonts or samples are bundled: all 27 loops are synthesised here at boot, and the reverb impulse is generated noise. The techniques follow public Web Audio documentation and the reading list in CREDITS.md — <i>The Audio Programming Book</i> (Boulanger &amp; Lazzarini, MIT Press), <i>Web Audio API</i> (Boris Smus, O'Reilly), <i>Designing Sound</i> (Andy Farnell, MIT Press), <i>Musimathics</i> (Gareth Loy, MIT Press).</p>
          <p style="font-size:11.5px">If this is useful to you: <a href="https://github.com/sponsors/drsamonline" target="_blank" rel="noopener">sponsor the work</a> or <a href="https://github.com/drsamonline/neonboom/issues" target="_blank" rel="noopener">report a bug</a>.</p>
          <div class="row" style="margin-top:10px">
            <button class="btn" id="helpDemo">Load the demo beat</button>
            <button class="btn" id="helpSave">Save project file</button>
          </div>
        </div>`;
      $('#helpDemo', host).addEventListener('click', () => this.loadDemo());
      $('#helpSave', host).addEventListener('click', () => this.saveProjectFile());
    },

    /* -------------------------------------------------------- mobile tabs */
    wireTabs() {
      $$('#tabbar button').forEach((b) => b.addEventListener('click', () => this.setView(b.dataset.view)));
    },

    setView(view) {
      $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
      const drawer = $('#drawer');
      if (view === 'mixer' || view === 'fx') {
        document.body.dataset.view = 'arrange';
        this.openDrawer(view);
        drawer.classList.add('mobileOpen');
        return;
      }
      drawer.classList.remove('mobileOpen');
      if (view === 'more') { this.openMoreSheet(); return; }
      document.body.dataset.view = view;
      if (view === 'arrange') requestAnimationFrame(() => NB.Timeline.resize());
    },

    openMoreSheet() {
      const P = NB.Project;
      this.sheet(`
        <h4>Project</h4>
        <div class="sheetRow"><label>Name</label><input type="text" id="shName" value="${escapeAttr(P.name)}" style="flex:1"></div>
        <div class="sheetRow"><label>Snap</label>
          <select id="shSnap" style="flex:1">
            <option value="4"${P.snap === 4 ? ' selected' : ''}>1/4 bar</option>
            <option value="2"${P.snap === 2 ? ' selected' : ''}>1/8 bar</option>
            <option value="1"${P.snap === 1 ? ' selected' : ''}>1/16 bar</option>
          </select></div>
        <div class="sheetRow"><label>Swing</label>
          <input type="range" id="shSwing" min="0" max="0.6" step="0.02" value="${P.swing || 0}">
          <span class="val" id="shSwingVal">${Math.round((P.swing || 0) * 100)}%</span></div>
        <div class="sheetRow"><label>Metronome</label><input type="checkbox" id="shMetro" ${P.metronome ? 'checked' : ''} style="width:22px;height:22px"></div>
        <div class="sheetBtns">
          <button class="btn" id="shDemo">Templates…</button>
          <button class="btn" id="shSettings">Appearance</button>
          <button class="btn" id="shSave">Save project</button>
          <button class="btn" id="shOpen">Open project</button>
          <button class="btn primary" id="shWav">Export WAV</button>
          <button class="btn" id="shHelp">Shortcuts</button>
          <button class="btn" id="shPack">Load sample pack</button>
          <button class="btn danger" id="shClear">Start over</button>
        </div>`);
      const s = $('#sheet');
      $('#shName', s).addEventListener('change', (e) => { P.name = e.target.value || P.name; NB.Persistence.saveSoon(); });
      $('#shSnap', s).addEventListener('change', (e) => { P.snap = parseInt(e.target.value, 10); NB.Persistence.saveSoon(); });
      $('#shSwing', s).addEventListener('input', (e) => {
        P.swing = parseFloat(e.target.value);
        $('#shSwingVal', s).textContent = Math.round(P.swing * 100) + '%';
      });
      $('#shSwing', s).addEventListener('change', () => { NB.Transport.reanchor(); NB.Persistence.saveSoon(); });
      $('#shMetro', s).addEventListener('change', (e) => { P.metronome = e.target.checked; $('#btnMetro').classList.toggle('on', P.metronome); });
      $('#shDemo', s).addEventListener('click', () => { this.closeSheet(); this.openTemplates(); });
      $('#shSettings', s).addEventListener('click', () => { this.closeSheet(); this.openSettings(); });
      $('#shSave', s).addEventListener('click', () => { this.closeSheet(); this.saveProjectFile(); });
      $('#shOpen', s).addEventListener('click', () => { this.closeSheet(); this.openProjectFile(); });
      $('#shWav', s).addEventListener('click', () => { this.closeSheet(); this.exportWav(); });
      $('#shHelp', s).addEventListener('click', () => { this.closeSheet(); this.openDrawer('help'); });
      $('#shPack', s).addEventListener('click', () => { this.closeSheet(); this.loadPackFile(); });
      $('#shClear', s).addEventListener('click', async () => {
        if (!confirm('Clear the autosaved project and start fresh?')) return;
        await NB.Persistence.clear(); location.reload();
      });
    },

    /* ------------------------------------------------------------- sheets */
    wireSheet() {
      /* pointerdown, not click: a long-press opens the sheet while the finger
         is still down, and the compatibility click that arrives on release
         would close it again immediately. A pointerdown can only come from a
         *new* gesture, so dismissal stays predictable on every device. */
      $('#scrim').addEventListener('pointerdown', () => {
        if (performance.now() - (this._sheetOpenedAt || 0) < 150) return;
        this.closeSheet();
      });
    },

    sheet(html) {
      this._sheetOpenedAt = performance.now();
      const s = $('#sheet');
      s.innerHTML = `<div class="grab"></div>${html}`;
      s.classList.add('on');
      $('#scrim').classList.add('on');
    },

    closeSheet() {
      $('#sheet').classList.remove('on');
      $('#scrim').classList.remove('on');
    },

    openClipSheet(clipId) {
      const f = NB.project.findClip(clipId);
      if (!f) return;
      const { clip } = f;
      const sample = NB.Library.get(clip.sampleId);
      const gain = clip.gain == null ? 1 : clip.gain;
      this.sheet(`
        <h4>${escapeHtml(sample ? sample.name : 'Clip')}</h4>
        <div class="sheetRow"><label>Gain</label>
          <input type="range" id="csGain" min="0" max="1.5" step="0.01" value="${gain}">
          <span class="val" id="csGainVal">${Math.round(gain * 100)}%</span></div>
        <div class="sheetRow"><label>Pitch</label>
          <input type="range" id="csPitch" min="-12" max="12" step="1" value="${clip.pitch || 0}">
          <span class="val" id="csPitchVal">${clip.pitch > 0 ? '+' : ''}${clip.pitch || 0} st</span></div>
        <div class="sheetRow"><label>Fade in</label>
          <input type="range" id="csFadeIn" min="0" max="${Math.floor((clip.trimEndSix - clip.trimStartSix) / 2)}" step="1" value="${clip.fadeIn || 0}">
          <span class="val" id="csFadeInVal">${clip.fadeIn || 0}</span></div>
        <div class="sheetRow"><label>Fade out</label>
          <input type="range" id="csFadeOut" min="0" max="${Math.floor((clip.trimEndSix - clip.trimStartSix) / 2)}" step="1" value="${clip.fadeOut || 0}">
          <span class="val" id="csFadeOutVal">${clip.fadeOut || 0}</span></div>
        <div class="sheetRow"><label>Starts</label><span style="font-family:var(--mono);font-size:11px">${Grid.fmtBBT(clip.startSix)}</span></div>
        <div class="sheetRow"><label>Length</label><span style="font-family:var(--mono);font-size:11px">${Grid.fmtBars(clip.trimEndSix - clip.trimStartSix)}</span></div>
        <div class="sheetBtns">
          <button class="btn" id="csEdit">Edit waveform…</button>
          <button class="btn" id="csRev">${clip.reverse ? '⏪ Reversed' : '⏩ Reverse'}</button>
          <button class="btn" id="csDup">Duplicate</button>
          <button class="btn" id="csSplit">Split here</button>
          <button class="btn" id="csQuant">Quantize</button>
          <button class="btn danger" id="csDel">Delete</button>
        </div>`);
      const s = $('#sheet');
      $('#csGain', s).addEventListener('input', (e) => {
        clip.gain = parseFloat(e.target.value);
        $('#csGainVal', s).textContent = Math.round(clip.gain * 100) + '%';
      });
      $('#csGain', s).addEventListener('change', () => { NB.Transport.refresh(); NB.Persistence.saveSoon(); });
      $('#csPitch', s).addEventListener('input', (e) => {
        clip.pitch = parseInt(e.target.value, 10);
        $('#csPitchVal', s).textContent = (clip.pitch > 0 ? '+' : '') + clip.pitch + ' st';
        NB.Timeline.draw();
      });
      $('#csPitch', s).addEventListener('change', () => { NB.Transport.refresh(); NB.Persistence.saveSoon(); });
      ['csFadeIn', 'csFadeOut'].forEach((id) => {
        const key = id === 'csFadeIn' ? 'fadeIn' : 'fadeOut';
        $('#' + id, s).addEventListener('input', (e) => {
          clip[key] = parseInt(e.target.value, 10);
          $('#' + id + 'Val', s).textContent = clip[key];
          NB.Timeline.draw();
        });
        $('#' + id, s).addEventListener('change', () => { NB.Transport.refresh(); NB.Persistence.saveSoon(); });
      });
      $('#csEdit', s).addEventListener('click', () => { this.closeSheet(); this.openClipEditor(clip.id); });
      $('#csRev', s).addEventListener('click', (e) => {
        NB.History.push();
        clip.reverse = !clip.reverse;
        e.currentTarget.textContent = clip.reverse ? '⏪ Reversed' : '⏩ Reverse';
        NB.Timeline.draw(); NB.Transport.refresh(); NB.Persistence.saveSoon();
      });
      $('#csDup', s).addEventListener('click', () => { this.closeSheet(); NB.Timeline.duplicateSelected(); });
      $('#csSplit', s).addEventListener('click', () => { this.closeSheet(); NB.Timeline.splitAtPlayhead(); });
      $('#csQuant', s).addEventListener('click', () => { this.closeSheet(); NB.Timeline.quantize(); });
      $('#csDel', s).addEventListener('click', () => { this.closeSheet(); NB.Timeline.deleteSelected(); });
    },

    /* --------------------------------------------------------- zoom + mode */
    wireZoom() {
      $$('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.zoom;
        if (a === 'in') NB.Timeline.zoomIn();
        else if (a === 'out') NB.Timeline.zoomOut();
        else NB.Timeline.zoomFit();
      }));
      $$('#modeGrp button').forEach((b) => b.addEventListener('click', () => {
        $$('#modeGrp button').forEach((x) => x.classList.toggle('on', x === b));
        NB.Timeline.setMode(b.dataset.mode);
      }));
      NB.bus.on('zoom', (z) => { $('#zoomLbl').textContent = Math.round(z * 100) + '%'; });
    },

    /* ------------------------------------------------------------- import */
    wireImport() {
      const input = $('#fileInput');
      $('#btnImport').addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        if (input.files.length) this.importFiles(input.files);
        input.value = '';
      });

      /* drag audio anywhere onto the app */
      ['dragover', 'drop'].forEach((evt) => document.addEventListener(evt, (e) => {
        if (!e.dataTransfer) return;
        if (evt === 'dragover') { e.preventDefault(); return; }
        if (e.dataTransfer.files && e.dataTransfer.files.length) {
          e.preventDefault();
          this.importFiles(e.dataTransfer.files);
        }
      }));
    },

    async importFiles(files) {
      const list = Array.from(files).filter((f) => /audio|\.(wav|mp3|ogg|flac|m4a|aac|webm)$/i.test(f.type + f.name));
      if (!list.length) { toast('No audio files found', 'warn'); return; }
      let ok = 0;
      for (const file of list) {
        try {
          const bytes = await file.arrayBuffer();
          const buffer = await NB.Engine.ctx.decodeAudioData(bytes.slice(0));
          NB.Library.register({
            name: file.name.replace(/\.[^.]+$/, ''),
            buffer,
            category: 'Imported',
            color: NB.util.TRACK_COLORS[NB.Library.items.size % NB.util.TRACK_COLORS.length],
            refBpm: NB.Project.bpm,           // assume it already fits the project
            isUser: true,
            rawBytes: bytes,
          });
          ok++;
        } catch (err) {
          console.error('import failed', file.name, err);
          toast(`Could not decode "${file.name}"`, 'err', 3200);
        }
      }
      if (ok) {
        NB.bus.emit('library:changed');
        NB.Persistence.saveSoon();
        toast(`Imported ${ok} file${ok > 1 ? 's' : ''} — tag tempo in the clip panel if it drifts`, 'ok', 3200);
      }
    },

    /* ------------------------------------------------------------ projects */
    maybeOnboard() {
      let seen = false;
      try { seen = localStorage.getItem('nb-onboarded') === '1'; } catch (e) { seen = true; }
      if (seen) return;
      setTimeout(() => {
        this.sheet(`
          <h4>Three things to know</h4>
          <div class="sheetRow"><label>Pads</label>
            <span style="font-size:12px;color:var(--ink-1);flex:1">Tap a pad to hear it. Arm <b>REC</b> and taps drop clips at the playhead.</span></div>
          <div class="sheetRow"><label>Timeline</label>
            <span style="font-size:12px;color:var(--ink-1);flex:1">Drag clips to move, drag an edge to trim, shift-click or marquee to select several.</span></div>
          <div class="sheetRow"><label>Save</label>
            <span style="font-size:12px;color:var(--ink-1);flex:1">It autosaves in this browser. <b>Export</b> writes a WAV; the project file opens on another machine.</span></div>
          <div class="sheetBtns">
            <button class="btn" id="obTpl">Pick a template</button>
            <button class="btn primary" id="obDone">Start</button>
          </div>`, true);
        const s = $('#sheet');
        $('#obDone', s).addEventListener('click', () => { this.closeSheet(); this.markOnboarded(); });
        $('#obTpl', s).addEventListener('click', () => { this.closeSheet(); this.markOnboarded(); this.openTemplates(); });
      }, 1600);
    },

    markOnboarded() {
      try { localStorage.setItem('nb-onboarded', '1'); } catch (e) {}
    },

    openTemplates() {
      const list = NB.Templates.list();
      this.sheet(`
        <h4>Start from a template</h4>
        <p style="font-size:11.5px;color:var(--ink-2);margin:0 0 8px">Replaces the current arrangement. Undo brings it back.</p>
        ${list.map((t) => `<button class="tplRow" data-tpl="${t.id}">
            <span class="tplName">${t.name}<b>${t.bpm} BPM · ${t.bars} bars</b></span>
            <span class="tplBlurb">${t.blurb}</span></button>`).join('')}`, true);
      $$('.tplRow', $('#sheet')).forEach((b) => b.addEventListener('click', () => {
        this.closeSheet();
        this.applyTemplate(b.dataset.tpl);
      }));
    },

    applyTemplate(id) {
      NB.History.push('Load template');
      NB.Templates.build(id);
      NB.Engine.ensureTrackBuses(NB.Project.tracks.length);
      NB.Engine.applyMix(NB.Project.tracks);
      $('#bpm').value = NB.Project.bpm;
      NB.bus.emit('project:replaced');
      NB.Timeline.select(null);
      NB.Timeline.zoomFit();
      NB.Persistence.saveSoon();
      this.syncLoopBtn();
      toast(NB.Project.name + ' — press space', 'ok', 2400);
    },

    /* While MIDI learn is armed, the next control you touch names the target. */
    wireMidiLearn() {
      NB.Midi.loadMap();
      document.addEventListener('input', (e) => {
        if (NB.Midi.learning !== 'control') return;
        const el = e.target;
        if (!el || !el.dataset || !el.dataset.midi) return;
        NB.Midi.offerControl(el);
        this.announce('Control selected — now move a knob on your controller');
        toast('Now move a knob on your controller', '', 2600);
      }, true);

      NB.bus.on('midi:learn', (s) => {
        if (s.stage === 'control') toast('MIDI learn: move a control in the app', '', 2600);
        if (s.stage === 'cc') toast(`Learn: ${s.target} — move a knob now`, '', 3200);
      });
      NB.bus.on('midi:bound', (b) => {
        if (b.cleared) { toast('MIDI mappings cleared', '', 1600); return; }
        toast(`CC ${b.cc} → ${b.target}`, 'ok', 2200);
        this.announce(`Bound controller ${b.cc} to ${b.target}`);
      });
    },

    /* ---------- appearance ---------- */
    openSettings() {
      const root = document.documentElement;
      this.sheet(`
        <h4>Appearance</h4>
        <div class="sheetRow"><label>Palette</label>
          <div class="segmented" id="setPalette">
            <button data-pal="neon" class="${root.dataset.palette !== 'safe' ? 'on' : ''}">Neon</button>
            <button data-pal="safe" class="${root.dataset.palette === 'safe' ? 'on' : ''}">Colour-safe</button>
          </div></div>
        <div class="sheetRow"><label>Text size</label>
          <div class="segmented" id="setText">
            <button data-size="normal" class="${root.dataset.textsize !== 'large' ? 'on' : ''}">Normal</button>
            <button data-size="large" class="${root.dataset.textsize === 'large' ? 'on' : ''}">Larger</button>
          </div></div>
        <div class="sheetRow"><label>MIDI in</label>
          <span style="font-size:11.5px;color:var(--ink-2);flex:1" id="setMidiStatus">${escapeHtml(NB.Midi.status())}</span>
          <button class="btn" id="setMidi">${NB.Midi.ready ? 'Rescan' : 'Enable'}</button></div>
        <div class="sheetRow"><label>MIDI learn</label>
          <span style="font-size:11.5px;color:var(--ink-2);flex:1" id="setCcCount">${Object.keys(NB.Midi.ccMap).length} mapped</span>
          <button class="btn" id="setLearn">Learn</button>
          <button class="btn" id="setClearCc">Clear</button></div>
        <div class="sheetRow"><label>Motion</label>
          <span style="font-size:11px;color:var(--ink-2)">Follows your system reduced-motion setting.</span></div>
        <div class="sheetBtns">
          <button class="btn" id="setTpl">Templates…</button>
          <button class="btn" id="setPack">Load sample pack</button>
        </div>`, true);
      const s = $('#sheet');
      $$('#setPalette button', s).forEach((b) => b.addEventListener('click', () => {
        root.dataset.palette = b.dataset.pal;
        $$('#setPalette button', s).forEach((x) => x.classList.toggle('on', x === b));
        localStorage.setItem('nb-palette', b.dataset.pal);
        NB.util.applyPaletteToProject(NB.Project);
        NB.bus.emit('project:replaced');
        NB.Timeline.rebuildHeaders(); NB.Mixer.render();
      }));
      $$('#setText button', s).forEach((b) => b.addEventListener('click', () => {
        root.dataset.textsize = b.dataset.size;
        $$('#setText button', s).forEach((x) => x.classList.toggle('on', x === b));
        localStorage.setItem('nb-textsize', b.dataset.size);
        requestAnimationFrame(() => NB.Timeline.resize());
      }));
      $('#setMidi', s).addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        const ok = await NB.Midi.enable();
        $('#setMidiStatus', s).textContent = NB.Midi.status();
        e.currentTarget.disabled = false;
        e.currentTarget.textContent = 'Rescan';
        toast(ok ? `MIDI ready — ${NB.Midi.status()}` : `MIDI ${NB.Midi.status()}`, ok ? 'ok' : 'warn', 2600);
      });
      $('#setLearn', s).addEventListener('click', () => {
        this.closeSheet();
        NB.Midi.beginLearn();
      });
      $('#setClearCc', s).addEventListener('click', () => {
        NB.Midi.clearMap();
        $('#setCcCount', s).textContent = '0 mapped';
      });
      $('#setTpl', s).addEventListener('click', () => { this.closeSheet(); this.openTemplates(); });
      $('#setPack', s).addEventListener('click', () => { this.closeSheet(); this.loadPackFile(); });
    },

    loadDemo() {
      NB.History.push('Load demo');
      NB.project.buildDemo();
      NB.Engine.ensureTrackBuses(NB.Project.tracks.length);
      NB.Engine.applyMix(NB.Project.tracks);
      $('#bpm').value = NB.Project.bpm;
      NB.bus.emit('project:replaced');
      NB.Timeline.zoomFit();
      NB.Persistence.saveSoon();
      this.syncLoopBtn();
      toast('Demo beat loaded — press space', 'ok', 2600);
    },

    addTrack() {
      if (NB.Project.tracks.length >= 24) { toast('24 tracks is the practical limit', 'warn'); return; }
      NB.History.push('Add track');
      const t = NB.project.addTrack();
      NB.Engine.ensureTrackBuses(NB.Project.tracks.length);
      NB.Engine.applyMix(NB.Project.tracks);
      NB.Timeline.selectedTrackId = t.id;
      NB.bus.emit('project:replaced');
      NB.Mixer.render();
      NB.Persistence.saveSoon();
      toast('Track added', '', 1200);
    },

    removeTrack(id) {
      if (NB.Project.tracks.length <= 1) { toast('Keep at least one track', 'warn'); return; }
      NB.History.push('Remove track');
      NB.project.removeTrack(id);
      NB.Engine.ensureTrackBuses(NB.Project.tracks.length);
      NB.Engine.applyMix(NB.Project.tracks);
      NB.bus.emit('project:replaced');
      NB.Mixer.render();
      NB.Transport.refresh();
      NB.Persistence.saveSoon();
    },

    saveProjectFile() {
      const blob = new Blob([JSON.stringify(NB.project.projectFile(), null, 2)], { type: 'application/json' });
      NB.Wav.download(blob, `${slug(NB.Project.name)}.neonboom.json`);
      toast('Project file saved', 'ok', 1600);
    },

    openProjectFile() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          NB.History.push();
          NB.project.loadProjectFile(text, NB.Engine);
          NB.Engine.ensureTrackBuses(NB.Project.tracks.length);
          NB.Engine.applyMix(NB.Project.tracks);
          $('#bpm').value = NB.Project.bpm;
          NB.bus.emit('project:replaced');
          NB.Timeline.zoomFit();
          NB.Persistence.saveSoon();
          toast('Project loaded', 'ok');
        } catch (e) {
          toast('Could not read that project file', 'err');
        }
      });
      input.click();
    },

    async exportWav(loopOnly) {
      const btn = $('#btnExport');
      const label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = 'Rendering…';
      const t0 = performance.now();
      try {
        const { rendered, seconds } = await NB.Wav.renderArrangement({
          loopOnly: !!loopOnly,
          sampleLibrary: NB.Library.items,
          project: NB.Project,
          engine: NB.Engine,
          fx: NB.Fx.snapshot(),
        });
        const blob = NB.Wav.encodeWAV(rendered);
        const suffix = loopOnly ? '-loop' : '';
        NB.Wav.download(blob, `${slug(NB.Project.name)}${suffix}-${NB.Project.bpm}bpm.wav`);
        toast(`Rendered ${fmtSec(seconds)} of audio in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'ok', 3200);
      } catch (err) {
        console.error(err);
        toast('Export failed: ' + err.message, 'err', 4000);
      } finally {
        btn.disabled = false;
        btn.innerHTML = label;
      }
    },

    async exportStems() {
      const btn = $('#btnExport');
      const label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = 'Rendering…';
      const t0 = performance.now();
      try {
        const stems = await NB.Wav.renderStems({
          sampleLibrary: NB.Library.items,
          project: NB.Project,
          engine: NB.Engine,
          fx: NB.Fx.snapshot(),
        });
        if (!stems.length) { toast('No clips to render', 'warn'); return; }
        const zip = await NB.Wav.zip(stems.map((s) => ({ name: s.name, blob: s.blob })));
        NB.Wav.download(zip, `${slug(NB.Project.name)}-stems.zip`);
        toast(`${stems.length} stems in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'ok', 3200);
      } catch (err) {
        console.error(err);
        toast('Stem export failed: ' + err.message, 'err', 4000);
      } finally {
        btn.disabled = false;
        btn.innerHTML = label;
      }
    },

    /* ---------- clip editor -------------------------------------------------
       Non-destructive: it moves the trim handles, the clip gain and the pitch,
       never the sample buffer. Undo covers all of it. */
    openClipEditor(clipId) {
      const f = NB.project.findClip(clipId);
      if (!f) return;
      const { clip } = f;
      const sample = NB.Library.get(clip.sampleId);
      if (!sample) return;
      const total = sample.beats * 4;                       // sixteenths in the sample
      const len = clip.trimEndSix - clip.trimStartSix;

      this.sheet(`
        <h4>${escapeHtml(sample.name)}</h4>
        <canvas id="ceWave" width="1120" height="200"
          style="width:100%;height:110px;background:#07090b;border:1px solid var(--line);border-radius:8px;touch-action:none"></canvas>
        <div class="sheetRow"><label>Start</label>
          <span class="val" id="ceIn" style="width:64px">${clip.trimStartSix}</span>
          <label style="flex:0 0 34px">End</label>
          <span class="val" id="ceOut" style="width:64px">${clip.trimEndSix}</span>
          <span style="font-size:11px;color:var(--ink-2);margin-left:auto">of ${total}</span></div>
        <div class="sheetRow"><label>Gain</label>
          <input type="range" id="ceGain" min="0" max="2" step="0.01" value="${clip.gain == null ? 1 : clip.gain}">
          <span class="val" id="ceGainVal">${Math.round((clip.gain == null ? 1 : clip.gain) * 100)}%</span></div>
        <div class="sheetBtns">
          <button class="btn" id="ceNorm">Normalise</button>
          <button class="btn" id="ceFit1">Fit 1 bar</button>
          <button class="btn" id="ceFit2">Fit 2 bars</button>
          <button class="btn" id="ceHalf">Half length</button>
          <button class="btn" id="ceReset">Reset trim</button>
          <button class="btn primary" id="ceDone">Done</button>
        </div>`, true);

      const s = $('#sheet');
      const canvas = $('#ceWave', s);
      const ctx2 = canvas.getContext('2d');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(canvas.clientWidth * dpr) || 1120;
      canvas.height = Math.round(110 * dpr);
      ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = canvas.width / dpr, H = canvas.height / dpr;

      const draw = () => {
        ctx2.clearRect(0, 0, W, H);
        const peaks = sample.peaks;
        const mid = H / 2;
        for (let x = 0; x < W; x++) {
          const v = peaks[Math.floor((x / W) * peaks.length)] || 0;
          const bh = Math.max(1, v * (H * 0.42));
          const inTrim = (x / W) * total >= clip.trimStartSix && (x / W) * total <= clip.trimEndSix;
          ctx2.fillStyle = inTrim ? '#ffb020' : 'rgba(120,132,148,.35)';
          ctx2.fillRect(x, mid - bh, 1, bh * 2);
        }
        /* handles */
        const hx = (clip.trimStartSix / total) * W;
        const hx2 = (clip.trimEndSix / total) * W;
        ctx2.fillStyle = 'rgba(255,176,32,.16)';
        ctx2.fillRect(hx, 0, hx2 - hx, H);
        ctx2.fillStyle = '#ffb020';
        ctx2.fillRect(hx - 2, 0, 4, H);
        ctx2.fillRect(hx2 - 2, 0, 4, H);
        $('#ceIn', s).textContent = clip.trimStartSix;
        $('#ceOut', s).textContent = clip.trimEndSix;
      };
      draw();

      /* drag either handle */
      let dragEdge = null;
      const sixAt = (ev) => {
        const r = canvas.getBoundingClientRect();
        const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
        const six = Math.round((x / r.width) * total);
        return Math.max(0, Math.min(total, six));
      };
      canvas.addEventListener('pointerdown', (ev) => {
        canvas.setPointerCapture(ev.pointerId);
        const six = sixAt(ev);
        dragEdge = Math.abs(six - clip.trimStartSix) < Math.abs(six - clip.trimEndSix) ? 'in' : 'out';
        NB.History.push('Trim clip');
        apply(six);
      });
      canvas.addEventListener('pointermove', (ev) => { if (dragEdge) apply(sixAt(ev)); });
      canvas.addEventListener('pointerup', () => { dragEdge = null; });

      const apply = (six) => {
        if (dragEdge === 'in') clip.trimStartSix = Math.min(six, clip.trimEndSix - 1);
        if (dragEdge === 'out') clip.trimEndSix = Math.max(six, clip.trimStartSix + 1);
        draw();
        NB.Timeline.draw();
      };

      const commit = () => { NB.Transport.refresh(); NB.Persistence.saveSoon(); };

      $('#ceGain', s).addEventListener('input', (e) => {
        clip.gain = parseFloat(e.target.value);
        $('#ceGainVal', s).textContent = Math.round(clip.gain * 100) + '%';
      });
      $('#ceGain', s).addEventListener('change', commit);

      $('#ceNorm', s).addEventListener('click', () => {
        let peak = 0;
        for (let i = 0; i < sample.peaks.length; i++) peak = Math.max(peak, sample.peaks[i]);
        if (peak <= 0.001) return;
        NB.History.push('Normalise clip');
        clip.gain = Math.min(2, Math.round((0.95 / peak) * 100) / 100);
        $('#ceGain', s).value = clip.gain;
        $('#ceGainVal', s).textContent = Math.round(clip.gain * 100) + '%';
        commit();
        toast('Normalised to ' + Math.round(clip.gain * 100) + '%', 'ok', 1400);
      });

      const fitBars = (bars) => {
        NB.History.push(`Fit ${bars} bar${bars > 1 ? 's' : ''}`);
        clip.trimStartSix = 0;
        clip.trimEndSix = Math.max(1, Math.min(total, bars * 16));
        draw(); NB.Timeline.draw(); commit();
      };
      $('#ceFit1', s).addEventListener('click', () => fitBars(1));
      $('#ceFit2', s).addEventListener('click', () => fitBars(2));
      $('#ceHalf', s).addEventListener('click', () => {
        NB.History.push('Halve clip');
        clip.trimEndSix = Math.max(clip.trimStartSix + 1, Math.round((clip.trimStartSix + clip.trimEndSix) / 2));
        draw(); NB.Timeline.draw(); commit();
      });
      $('#ceReset', s).addEventListener('click', () => {
        NB.History.push('Reset trim');
        clip.trimStartSix = 0; clip.trimEndSix = total;
        draw(); NB.Timeline.draw(); commit();
      });
      $('#ceDone', s).addEventListener('click', () => this.closeSheet());
    },

    /* Optional side pack: fetch it when hosted, pick it when not. */
    async loadPackFile() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,application/zip';
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        toast('Reading pack…', '', 1400);
        try {
          const n = await NB.LoopPack.fromFile(file, NB.Engine);
          if (!n) { toast('No usable loops in that zip', 'warn', 3000); return; }
          NB.bus.emit('library:changed');
          NB.Pads.render();
          toast(`${n} loops installed from the pack`, 'ok', 2600);
        } catch (err) {
          console.error(err);
          toast('Could not read that pack: ' + err.message, 'err', 4000);
        }
      });
      input.click();
    },

    /* ----------------------------------------------------------- keyboard */
    wireKeyboard() {
      document.addEventListener('keydown', (e) => {
        const tag = (document.activeElement && document.activeElement.tagName) || '';
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
        const mod = e.ctrlKey || e.metaKey;

        if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? NB.History.redo() : NB.History.undo(); return; }
        if (mod && e.code === 'KeyY') { e.preventDefault(); NB.History.redo(); return; }
        if (mod && e.code === 'KeyD') { e.preventDefault(); NB.Timeline.duplicateSelected(); return; }
        if (mod && e.code === 'KeyC') { e.preventDefault(); NB.Timeline.copySelected(); return; }
        if (mod && e.code === 'KeyX') { e.preventDefault(); NB.Timeline.cutSelected(); return; }
        if (mod && e.code === 'KeyV') { e.preventDefault(); NB.Timeline.paste(); return; }
        if (mod && e.code === 'KeyS') { e.preventDefault(); this.saveProjectFile(); return; }
        if (mod) return;

        switch (e.code) {
          case 'Space': e.preventDefault(); NB.Transport.toggle(); break;
          case 'KeyR': e.preventDefault(); NB.Transport.rewind(); break;
          case 'KeyL': e.preventDefault(); $('#btnLoop').click(); break;
          case 'KeyK': e.preventDefault(); $('#btnMetro').click(); break;
          case 'KeyS': e.preventDefault(); NB.Timeline.splitAtPlayhead(); break;
          case 'Delete': case 'Backspace': e.preventDefault(); NB.Timeline.deleteSelected(); break;
          case 'KeyQ': e.preventDefault(); NB.Timeline.quantize(); break;
          case 'KeyF': e.preventDefault(); NB.Timeline.zoomFit(); break;
          case 'KeyM': {
            e.preventDefault();
            const id = NB.Timeline.selectedTrackId;
            const t = NB.Project.tracks.find((x) => x.id === id) || NB.Project.tracks[0];
            if (t) { t.mute = !t.mute; NB.Engine.applyMix(NB.Project.tracks); NB.Timeline.rebuildHeaders(); NB.Mixer.render(); }
            break;
          }
          case 'ArrowLeft': e.preventDefault(); NB.Timeline.nudge(e.shiftKey ? -4 : -NB.Project.snap); break;
          case 'ArrowRight': e.preventDefault(); NB.Timeline.nudge(e.shiftKey ? 4 : NB.Project.snap); break;
          case 'Minus': case 'NumpadSubtract': NB.Timeline.zoomOut(); break;
          case 'Equal': case 'NumpadAdd': NB.Timeline.zoomIn(); break;
          case 'Escape': this.closeSheet(); break;
          default: {
            const key = e.key.toLowerCase();
            if (/^[0-9qw]$/.test(key)) NB.Pads.keyPress(key);
          }
        }
      });
    },

    /* ------------------------------------------------------------- install */
    wireInstall() {
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        this._installEvent = e;
        const b = $('#btnInstall');
        if (b) { b.hidden = false; b.addEventListener('click', () => { e.prompt(); b.hidden = true; }); }
      });
      /* The manifest is only attached over http(s): fetching it from file://
         is a guaranteed CORS console error for anyone who double-clicks the
         downloaded file, and it buys nothing there. */
      if (location.protocol.startsWith('http')) {
        const link = document.createElement('link');
        link.rel = 'manifest';
        link.href = 'manifest.webmanifest';
        document.head.appendChild(link);
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.register('sw.js').catch(() => {});
        }
      }
    },
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  NB.Shell = Shell;
})(window.NB = window.NB || {});
