/* =========================================================================
   NEONBOOM · audio/schedule.js
   One place that turns a clip into a scheduled AudioBufferSourceNode.
   Live playback and the offline export both call this, so what you hear and
   what you render can never drift apart.

   Handles: tempo sync (playbackRate), pitch (±semitones, sampler-style — it
   changes speed too), reverse, per-clip gain, fade in / fade out, and the
   "skip into the clip" case when playback starts mid-clip.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { Grid } = NB.util;

  const Schedule = {
    /* playbackRate for a clip at the current project tempo and pitch */
    rate(clip, sample, bpm) {
      const pitch = clip.pitch || 0;
      return (bpm / sample.refBpm) * Math.pow(2, pitch / 12);
    },

    /* Swing delays every second sixteenth. 0 = straight, 0.5 ≈ 2:1 shuffle. */
    swingOffsetSix(clip, swing) {
      if (!swing) return 0;
      return clip.startSix % 2 === 1 ? swing * 0.5 : 0;
    },

    /* when the clip sounds, in context seconds, relative to `startCtxTime` */
    when(clip, fromSix, startCtxTime, bpm, swing) {
      const rel = Math.max(0, clip.startSix - fromSix) + this.swingOffsetSix(clip, swing || 0);
      return startCtxTime + Grid.sixToSec(rel, bpm);
    },

    /**
     * Schedule one clip.
     * @returns {AudioBufferSourceNode|null}
     */
    clip(ctx, dest, clip, sample, opts) {
      const { when, fromSix = 0, bpm, swing = 0 } = opts;
      const trimIn = clip.trimStartSix;
      const trimOut = clip.trimEndSix;
      const clipEndSix = clip.startSix + (trimOut - trimIn);
      if (clipEndSix <= fromSix) return null;               // already passed

      const skipSix = Math.max(0, fromSix - clip.startSix);
      const durSix = (trimOut - trimIn) - skipSix;
      if (durSix <= 0) return null;

      const rate = this.rate(clip, sample, bpm);
      const reverse = !!clip.reverse;
      const buffer = reverse ? NB.project.reversedBuffer(sample) : sample.buffer;

      /* buffer offset is in SOURCE time (the sample's own tempo) */
      let bufOffset = ((trimIn + skipSix) / 4) * (60 / sample.refBpm);
      let durSec = (durSix / 4) * (60 / sample.refBpm);
      if (reverse) {
        bufOffset = Math.max(0, buffer.duration - (bufOffset + durSec));
        if (bufOffset + durSec > buffer.duration) durSec = Math.max(0.001, buffer.duration - bufOffset);
      }

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;

      const g = ctx.createGain();
      const level = clip.gain == null ? 1 : clip.gain;
      const playDur = durSec / rate;                        // seconds on the timeline
      const fadeIn = Grid.sixToSec(clip.fadeIn || 0, bpm);
      const fadeOut = Grid.sixToSec(clip.fadeOut || 0, bpm);

      g.gain.cancelScheduledValues(when);
      if (fadeIn > 0.001) {
        g.gain.setValueAtTime(0.0001, when);
        g.gain.linearRampToValueAtTime(level, when + Math.min(fadeIn, playDur));
      } else {
        g.gain.setValueAtTime(level, when);
      }
      if (fadeOut > 0.001) {
        const outStart = when + Math.max(0, playDur - Math.min(fadeOut, playDur));
        g.gain.setValueAtTime(level, outStart);
        g.gain.linearRampToValueAtTime(0.0001, when + playDur);
      }

      src.connect(g);
      g.connect(dest);
      try {
        src.start(Math.max(when, ctx.currentTime + 0.001), bufOffset, durSec);
      } catch (e) {
        return null;
      }
      src._gainNode = g;
      return src;
    },
  };

  NB.Schedule = Schedule;
})(window.NB = window.NB || {});
