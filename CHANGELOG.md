# Changelog

All notable changes to NEONBOOM. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

---

## [1.1.1] — 2026-11-11

### Fixed
- The PWA manifest is now attached only over `http(s)`. Loading `index.html` from `file://` no
  longer logs a CORS error for the manifest — which matters for the standalone download, where
  a service worker is impossible anyway.
- Electron packaging metadata (`homepage`) and release uploads: only installers are attached now,
  not the unpacked app directory.

### Changed
- In-app help now carries the full credits, the reading list and a sponsor link, so the licence
  and attribution travel with the downloaded file.

---

## [1.1.0] — 2026-11-11

The rewrite. The 1.0 prototype was a single 2 192-line HTML file; this version splits it into
modules, fixes the bugs found by a headless audit of that file, and redesigns the interface for
phones and tablets.

### Added
- **Pad grid** with waveform tiles, category filters and drag-to-timeline, replacing the flat
  sample list. Arm `REC` to drop a loop at the playhead.
- **Clip inspector** — waveform, position, length, trim points, gain, split/duplicate/quantise/
  nudge/delete.
- **Redo** (the prototype only had undo) with lazy history commits.
- **Per-track live level meters** and a segmented master meter.
- **Metronome** on an audio-clock look-ahead scheduler.
- **Add / remove tracks** (1–24) with bus resizing.
- **Clip gain** per clip.
- **Mobile layout**: tab bar, bottom sheets, transport sheet from the LCD, Scroll/Edit switch,
  long-press clip actions, 40 px+ targets.
- **Offline PWA**: manifest, service worker, install prompt.
- **Single-file build** (`dist/neonboom.html`, 190 KB, zero requests) plus `npm run build`.
- **Project files** (`.neonboom.json`) and portable open/save.
- **Headless test suite** — 66 assertions across boot, transport, editing, zoom extremes, pads,
  mixer, FX, offline render, autosave restore, pointer/touch and three viewport sizes.
- **Electron + Capacitor wrappers** and CI for desktop installers and an Android APK.
- **Docs**: landing page, README with screenshots, function inventory, enhancement list, credits.

### Changed
- The timeline now renders into a **viewport-sized** canvas. The prototype sized the canvas to the
  project: at 400 % zoom a 64-bar project asked for a 73 728 px-wide canvas, past the browser's
  limit, and the timeline rendered **blank**.
- **Mute/solo is a real gain change** on the track bus, so it silences audio that is already
  playing. Previously mute only affected the next scheduling pass.
- **Editing during playback re-schedules**: deleting or moving a clip is heard immediately instead
  of at the end of the clip.
- Mixer strips and track headers are no longer rebuilt on every fader tick.
- VU and LCD updates no longer allocate or write innerHTML per frame.
- Imported samples keep their identity across reloads (the prototype randomised sample ids, so
  every autosaved clip was dropped on restore).
- FX rack settings persist with the project.
- `alert`/`prompt`/`confirm` replaced with toasts, sheets and inline fields.
- Demo project rebuilt: one instrument per track, eight bars, no overlapping clips.

### Fixed
- Timeline blank at high zoom (canvas size limit).
- Mute and solo not audible on already-playing clips.
- Deleted clips continuing to sound until their end.
- Track header drag on a narrow clip impossible at low zoom (edge zone was measured in musical
  units, not screen pixels).
- Ruler re-drawing all bar numbers every animation frame.
- App unusable below ~600 px width (the timeline collapsed to 0 px).
- Every button in the prototype was under the 44 px touch minimum (transport keys were 27 px).

### Removed
- The single-file architecture as the primary source (still shipped as a build artifact).
- `window.prompt` for an imported sample's BPM.

---

## [1.0.0] — 2026-10-30

- First working prototype: single HTML file, 12 tracks, 24 synthesised loops, canvas timeline,
  mixer, FX rack, WAV export, IndexedDB autosave, undo.
