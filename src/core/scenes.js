/* =========================================================================
   NEONBOOM · core/scenes.js
   A scene is a named snapshot of the arrangement — tracks, clips, mixer,
   automation, loop region and tempo. Launching one is quantised to the next
   bar so a switch lands on a downbeat instead of mid-beat.

   No second data model: a scene is the same objects the project already
   holds, deep-cloned. Undo, autosave and project files work unchanged.
   ========================================================================= */
(function (NB) {
  'use strict';
  const { uid, Grid, deepClone } = NB.util;

  const Scenes = {
    _pending: 0,

    list() { return NB.Project.scenes || (NB.Project.scenes = []); },

    /* Snapshot the current arrangement into a scene. */
    capture(name, id) {
      const P = NB.Project;
      const scene = {
        id: id || uid('scn'),
        name: name || `Scene ${this.list().length + 1}`,
        bpm: P.bpm,
        loopIn: P.loopIn,
        loopOut: P.loopOut,
        loopEnabled: P.loopEnabled,
        swing: P.swing || 0,
        tracks: deepClone(P.tracks),
        savedAt: Date.now(),
      };
      const list = this.list();
      const at = id ? list.findIndex((s) => s.id === id) : -1;
      if (at >= 0) list[at] = scene;
      else list.push(scene);
      NB.bus.emit('scenes');
      NB.Persistence.saveSoon();
      return scene;
    },

    remove(id) {
      const list = this.list();
      const i = list.findIndex((s) => s.id === id);
      if (i < 0) return false;
      list.splice(i, 1);
      NB.bus.emit('scenes');
      NB.Persistence.saveSoon();
      return true;
    },

    rename(id, name) {
      const scene = this.list().find((s) => s.id === id);
      if (!scene) return false;
      scene.name = name || scene.name;
      NB.bus.emit('scenes');
      NB.Persistence.saveSoon();
      return true;
    },

    get(id) { return this.list().find((s) => s.id === id) || null; },

    /* Apply a snapshot. `keepPosition` leaves the playhead where it is. */
    apply(scene) {
      const P = NB.Project;
      P.tracks = deepClone(scene.tracks);
      P.bpm = scene.bpm;
      P.loopIn = scene.loopIn;
      P.loopOut = scene.loopOut;
      P.loopEnabled = scene.loopEnabled;
      P.swing = scene.swing || 0;

      NB.Engine.ensureTrackBuses(P.tracks.length);
      NB.Engine.applyMix(P.tracks);
      const bpmField = document.getElementById('bpm');
      if (bpmField) bpmField.value = P.bpm;

      NB.Timeline.selectedClipId = null;
      NB.Timeline.selectedClipIds.clear();
      NB.bus.emit('project:replaced');
      NB.Timeline.resize();
      NB.Transport.reanchor();
    },

    /* Launch, quantised to the next bar when the transport is rolling. */
    launch(id) {
      const scene = this.get(id);
      if (!scene) return false;
      NB.History.push('Launch scene');

      if (!NB.Transport.playing) {
        this.apply(scene);
        NB.util.toast(scene.name, '', 1400);
        return true;
      }

      const P = NB.Project;
      const now = NB.Transport.currentSix();
      const barLen = 16;
      let nextBar = Math.ceil((now + 0.01) / barLen) * barLen;
      const secs = Grid.sixToSec(nextBar - now, P.bpm);

      NB.util.toast(`${scene.name} → bar ${Math.round(nextBar / barLen) + 1}`, '', 1600);
      clearTimeout(this._pending);
      this._pending = setTimeout(() => {
        this.apply(scene);
        /* the playhead continues from the same musical position */
        NB.Transport.reanchor();
      }, Math.max(30, secs * 1000));
      return true;
    },

    cancelPending() {
      clearTimeout(this._pending);
      this._pending = 0;
    },
  };

  NB.Scenes = Scenes;
})(window.NB = window.NB || {});
