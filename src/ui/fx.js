/* =========================================================================
   NEONBOOM · ui/fx.js
   Master FX rack bound straight to the live graph, plus snapshot() so the
   offline export can reproduce exactly what you hear.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { $, $$, el, Grid, clamp } = NB.util;

  const DEFAULTS = {
    eqLow: 0, eqMid: 0, eqHigh: 0,
    delaySync: 2, delayFeedback: 0.32, delayMix: 0,
    reverbSize: 2.2, reverbDecay: 3.2, reverbMix: 0,
    crushBits: 8, crushRate: 4, crushMix: 0,
    compThresh: -6, compRatio: 12, masterVol: 0.9,
  };

  const Fx = {
    values: { ...DEFAULTS },

    mount(host) {
      this.host = host;
      this.render();
    },

    render() {
      if (!this.host) return;
      const v = this.values;
      this.host.innerHTML = `
        <div class="fxGrid">
          <div class="fxModule">
            <h5>3-band EQ</h5>
            ${row('Low 120 Hz', 'eqLow', -24, 24, 0.5, v.eqLow, (x) => x.toFixed(1) + ' dB')}
            ${row('Mid 1 kHz', 'eqMid', -24, 24, 0.5, v.eqMid, (x) => x.toFixed(1) + ' dB')}
            ${row('High 6 kHz', 'eqHigh', -24, 24, 0.5, v.eqHigh, (x) => x.toFixed(1) + ' dB')}
          </div>
          <div class="fxModule">
            <h5>Tempo delay</h5>
            <div class="knobRow"><label>Sync</label>
              <select id="fxDelaySync" style="flex:1">
                <option value="4"${v.delaySync === 4 ? ' selected' : ''}>1/4</option>
                <option value="2"${v.delaySync === 2 ? ' selected' : ''}>1/8</option>
                <option value="3"${v.delaySync === 3 ? ' selected' : ''}>1/8 dotted</option>
                <option value="1"${v.delaySync === 1 ? ' selected' : ''}>1/16</option>
              </select></div>
            ${row('Feedback', 'delayFeedback', 0, 0.9, 0.01, v.delayFeedback, (x) => Math.round(x * 100) + '%')}
            ${row('Mix', 'delayMix', 0, 1, 0.01, v.delayMix, (x) => Math.round(x * 100) + '%')}
          </div>
          <div class="fxModule">
            <h5>Room reverb</h5>
            ${row('Size', 'reverbSize', 0.4, 4, 0.1, v.reverbSize, (x) => x.toFixed(1) + ' s')}
            ${row('Decay', 'reverbDecay', 0.5, 6, 0.1, v.reverbDecay, (x) => x.toFixed(1))}
            ${row('Mix', 'reverbMix', 0, 1, 0.01, v.reverbMix, (x) => Math.round(x * 100) + '%')}
          </div>
          <div class="fxModule">
            <h5>Bitcrusher <span class="toggleChip ${v.crushMix > 0 ? 'on' : ''}" id="fxCrushChip">${v.crushMix > 0 ? 'ON' : 'OFF'}</span></h5>
            ${row('Bit depth', 'crushBits', 2, 16, 1, v.crushBits, (x) => Math.round(x) + ' bit')}
            ${row('Rate div', 'crushRate', 1, 16, 1, v.crushRate, (x) => Math.round(x) + '×')}
            ${row('Mix', 'crushMix', 0, 1, 0.01, v.crushMix, (x) => Math.round(x * 100) + '%')}
          </div>
          <div class="fxModule">
            <h5>Master</h5>
            ${row('Threshold', 'compThresh', -40, 0, 1, v.compThresh, (x) => Math.round(x) + ' dB')}
            ${row('Ratio', 'compRatio', 1, 20, 0.5, v.compRatio, (x) => x.toFixed(0) + ':1')}
            ${row('Volume', 'masterVol', 0, 1.2, 0.01, v.masterVol, (x) => Math.round(x * 100) + '%')}
          </div>
        </div>`;
      this.wire();
    },

    wire() {
      const m = NB.Engine.master;
      const ctxNow = () => NB.Engine.ctx.currentTime;

      $$('input[data-fx]', this.host).forEach((input) => {
        const key = input.dataset.fx;
        const out = input.parentElement.querySelector('.val');
        const fmt = FORMATS[key] || ((x) => x);
        input.addEventListener('input', () => {
          const val = parseFloat(input.value);
          this.values[key] = val;
          NB.Project.fx = { ...this.values };
          NB.Persistence.saveSoon();
          if (out) out.textContent = fmt(val);
          this.apply(key, val, m, ctxNow());
        });
        /* double-click a knob to reset it */
        input.addEventListener('dblclick', () => {
          const d = DEFAULTS[key];
          input.value = d; this.values[key] = d;
          if (out) out.textContent = fmt(d);
          this.apply(key, d, m, ctxNow());
        });
      });

      const sync = $('#fxDelaySync', this.host);
      if (sync) {
        sync.addEventListener('change', () => {
          this.values.delaySync = parseFloat(sync.value);
          this.apply('delaySync', this.values.delaySync, m, ctxNow());
        });
      }
      const chip = $('#fxCrushChip', this.host);
      if (chip) {
        chip.addEventListener('click', () => {
          const on = this.values.crushMix > 0;
          const next = on ? 0 : 0.6;
          const slider = $('input[data-fx="crushMix"]', this.host);
          if (slider) { slider.value = next; }
          this.values.crushMix = next;
          this.apply('crushMix', next, m, ctxNow());
          chip.classList.toggle('on', !on);
          chip.textContent = on ? 'OFF' : 'ON';
          const out = slider && slider.parentElement.querySelector('.val');
          if (out) out.textContent = Math.round(next * 100) + '%';
        });
      }
      /* push current values into the graph (covers re-mount / undo) */
      Object.keys(this.values).forEach((k) => this.apply(k, this.values[k], m, ctxNow()));
    },

    apply(key, val, m, t) {
      if (!m) return;
      const ramp = (param, v) => param.setTargetAtTime(v, t, 0.01);
      switch (key) {
        case 'eqLow': ramp(m.eqLow.gain, val); break;
        case 'eqMid': ramp(m.eqMid.gain, val); break;
        case 'eqHigh': ramp(m.eqHigh.gain, val); break;
        case 'delaySync': ramp(m.delay.delayTime, Grid.sixToSec(val, NB.Project.bpm)); break;
        case 'delayFeedback': ramp(m.feedback.gain, val); break;
        case 'delayMix': ramp(m.delayWet.gain, val); break;
        case 'reverbSize': m.convolver.buffer = NB.ImpulseResponse.generate(NB.Engine.ctx, val, this.values.reverbDecay); break;
        case 'reverbDecay': m.convolver.buffer = NB.ImpulseResponse.generate(NB.Engine.ctx, this.values.reverbSize, val); break;
        case 'reverbMix': ramp(m.reverbWet.gain, val); break;
        case 'crushBits': m.crusher._bits = val; break;
        case 'crushRate': m.crusher._reduction = val; break;
        case 'crushMix': ramp(m.bitWet.gain, val); ramp(m.bitDry.gain, 1 - val); break;
        case 'compThresh': ramp(m.comp.threshold, val); break;
        case 'compRatio': ramp(m.comp.ratio, val); break;
        case 'masterVol': ramp(m.masterGain.gain, val); break;
      }
    },

    /* keep tempo-synced delay in time when BPM changes */
    retime() { this.apply('delaySync', this.values.delaySync, NB.Engine.master, NB.Engine.ctx.currentTime); },

    snapshot() { return { ...this.values }; },
    reset() {
      this.values = { ...DEFAULTS };
      this.render();
    },
  };

  const FORMATS = {
    eqLow: (x) => x.toFixed(1) + ' dB', eqMid: (x) => x.toFixed(1) + ' dB', eqHigh: (x) => x.toFixed(1) + ' dB',
    delayFeedback: (x) => Math.round(x * 100) + '%', delayMix: (x) => Math.round(x * 100) + '%',
    reverbSize: (x) => x.toFixed(1) + ' s', reverbDecay: (x) => x.toFixed(1),
    reverbMix: (x) => Math.round(x * 100) + '%',
    crushBits: (x) => Math.round(x) + ' bit', crushRate: (x) => Math.round(x) + '×',
    crushMix: (x) => Math.round(x * 100) + '%',
    compThresh: (x) => Math.round(x) + ' dB', compRatio: (x) => x.toFixed(0) + ':1',
    masterVol: (x) => Math.round(x * 100) + '%',
  };

  function row(label, key, min, max, step, value, fmt) {
    return `<div class="knobRow"><label>${label}</label>
      <input type="range" data-fx="${key}" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}">
      <span class="val">${fmt(value)}</span></div>`;
  }

  NB.Fx = Fx;
})(window.NB = window.NB || {});
