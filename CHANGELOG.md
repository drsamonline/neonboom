# Changelog

All notable changes to NEONBOOM. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

---

## [2.1.0] — 2026-11-11

MIDI CC learn — the knobs on your controller can drive the app.

### Added
- **CC learn**, two steps: press *Learn* in *More → Appearance*, move a control in the app (that
  names the target), then move a knob on the controller (that names the CC). The mapping is
  stored in `localStorage` and survives a reload.
- Every rack knob and every mixer fader, pan and send carries a stable `data-midi` id, so bindings
  are one selector away.
- A bound CC is applied by setting the control's value and dispatching `input`, which means every
  existing handler runs — no second code path for "MIDI-driven" changes.

### Changed
- CC messages are now routed before note messages, and while learning the next CC is consumed by
  the binding rather than by a mapping.

---

## [2.0.0] — 2026-11-11

MIDI input, and a version number that reflects a finished feature set rather than a new API.

### Added
- **Web MIDI input** (`src/core/midi.js`), opt-in from *More → Appearance → MIDI in*:
  - notes **36–51** fire the first 16 visible pads, **velocity scales the level**;
  - note **52** starts/stops, **53** rewinds;
  - device hot-plug is picked up through `onstatechange`, and the sheet reports how many inputs
    are connected.
- Velocity flows through `Engine.preview(buffer, rate, level)` and `Pads.trigger(id, velocity)`.

### Changed
- The permission prompt only appears when you press **Enable** — the app never asks for MIDI on
  load, and stays fully playable with mouse or touch without it.

### Notes on 2.0
The feature set is what I set out to build: pads, arrangement, mixer with sends, master FX,
automation, templates, clip editor, stems, offline PWA, desktop and Android builds, and now
hardware input. Anything after this is additive.

---

## [1.9.0] — 2026-11-11

Two builds, one source. The size trend gets a real answer instead of another raised limit.

### Added
- **`dist/neonboom.min.html`** — the same single file, minified: **275 KB → 177 KB (−35 %)**.
  JS through terser, CSS through a conservative minifier (comments and whitespace only — no
  rewriting), produced *from* the readable build so the two cannot drift.
- Both files are attached to every release, both are served by Pages, and both are booted by the
  test suite (library, transport, stylesheet, zero failed requests, zero console errors).

### Changed
- `scripts/build-standalone.mjs` emits both files in one pass.
- CI budgets are now split: **200 KB** for the minified file people download, 320 KB for the
  readable source. The tripwire finally measures the thing that matters.
- `terser` is a **dev** dependency — the shipped app still has zero runtime dependencies.

---

## [1.8.0] — 2026-11-11

Automation lanes — the last big musical feature on the roadmap.

### Added
- **Per-track automation** for **level** and **pan**. Press **A** in a track header to cycle the lane
  off → level → pan. Click to add a point, drag to move it, alt-click to remove it.
- Automation runs on its own `auto` gain node *ahead of* the fader, so the envelope and the
  mute/solo/volume controls never fight over the same parameter.
- Playback drives the envelope from the scheduler: each 25 ms tick ramps the node across the same
  180 ms window the clips are queued for, so automation moves with the audio clock.
- Export schedules one ramp per breakpoint inside the offline context, so a bounce matches.

### Changed
- `buildTrackBus` chain is now clips → **auto** → fader → panner → master (+ sends).
- Automation is saved in the project file and restored with the autosave.

---

## [1.7.0] — 2026-11-11

Editing polish and the accessibility pass.

### Added
- **Clip editor** (inspector → *Edit waveform*, or the clip sheet): the full sample with draggable
  trim handles, plus **Normalise**, **Fit 1 bar**, **Fit 2 bars**, **Half length** and **Reset trim**.
  Non-destructive — it moves trim handles, gain and pitch, never the buffer, so undo covers it.
- **Empty-lane hints**: a track with no clips says what to do, with different wording on touch.
- **Screen-reader announcements** for transport state and clip edits (`aria-live`, visually hidden).
- **First-run tips**: three cards, shown once, remembered in `localStorage`.

### Changed
- One shared `requestAnimationFrame` loop (throttled to ~30 fps) now drives the master VU, the
  per-track meters and the mixer meters. Three `setInterval` timers used to do the same job.

### Fixed
- Nothing user-facing; the suite needed `nb-onboarded` preset so the tips sheet would not cover
  the app during tests.

---

## [1.6.0] — 2026-11-11

Editing and accessibility: templates, multi-select, and a palette you can actually read.

### Added
- **Templates** (`src/core/templates.js`): Boom Bap, Trap, House and an empty grid. Each is built
  from the same loop library with mixer levels, sends, swing and loop length already set — no
  preset assets to keep in sync.
- **Multi-select**: shift-click to add or remove, or drag a marquee over empty lane space. Move,
  nudge, quantise, duplicate and delete then act on the whole selection; the inspector shows a
  bulk card instead of a single clip.
- **Colour-blind-safe palette** (Okabe–Ito derived) and a **larger-text mode**, both in
  *More → Appearance* and remembered in `localStorage`.
- Track colours are now resolved through `util.paletteColor()`, so switching palettes rewrites the
  existing tracks instead of only affecting new ones.

### Changed
- `Timeline.select(id, additive)` maintains a `Set` of selected clips; `selectionIds()` is the one
  place bulk operations read from.
- Dragging any clip in a multi-selection moves the whole group by the same snapped delta.
- Marquee only engages after 6 px of movement, so a plain tap on empty space still deselects.

### Fixed
- The phone long-press test now retries once: the gesture races the background loop render, and a
  starved timer occasionally missed the window. (The app itself was already time-checked on
  pointerup; this is test hygiene, not a behaviour change.)

---

## [1.5.0] — 2026-11-11

The transport rewrite: a look-ahead scheduler replaces "schedule everything, then wrap with a
`setTimeout`".

### Changed
- **Look-ahead scheduling.** A 25 ms ticker queues whatever falls inside a 180 ms horizon instead
  of scheduling the whole arrangement at `play()`. Consequences:
  - loop points are **sample-accurate** — the next pass is queued on the audio clock, not by a
    timer that drifts by tens of milliseconds;
  - **tempo can change while rolling** (`Transport.setBpm`) — the clock re-anchors and the queue
    rebuilds instead of the old pause/play restart;
  - a 64-bar project no longer builds hundreds of `AudioBufferSourceNode`s up front — the queue
    holds a window, not the arrangement.
- `currentSix()` computes the loop wrap arithmetically instead of re-anchoring on a timer, so the
  playhead and the audio agree at the seam.
- Loop toggle and swing changes call `Transport.reanchor()` rather than stopping playback.
- Metronome scheduling is relative to the playhead, so it survives a loop wrap.

### Removed
- `Transport._scheduleAll()` and the loop re-entry `setTimeout` — both replaced by `_fill()` and
  `_schedulerTick()`.

### Fixed
- Deleting a clip while rolling now silences that clip specifically; sources carry `_clipId` so the
  scheduler can be checked, and the test asserts on the id rather than on a list length.

---

## [1.4.0] — 2026-11-11

Mixer sends, a real history panel, clipboard, and the bitcrusher finally moves off the
deprecated `ScriptProcessorNode`.

### Added
- **Per-track delay and reverb sends** (A/B on every mixer strip). Post-fader, so they follow
  the volume, and honoured by the offline export — the sends are wired to the master's existing
  delay and convolver instead of duplicating them.
- **History panel** (drawer → *History*): every edit is a named step — *Split clip*, *Nudge clip*,
  *Paste clip*, *Add track* — newest first, one click to jump back to the state before it.
- **Clipboard**: copy / cut / paste clips (`Ctrl+C`, `Ctrl+X`, `Ctrl+V`). Paste lands on the
  selected track at the playhead, snapped.

### Changed
- The bitcrusher is an **AudioWorkletNode** when the browser allows it, with the
  `ScriptProcessorNode` kept as a fallback. The module is loaded from a `data:` URL, not a
  `blob:` one: a page opened from `file://` has an opaque origin, and the worklet loader
  refuses blob URLs there — which is exactly how the standalone file is opened.
- Mixer strips are slightly shorter so faders, pan and both sends fit inside the drawer.

### Fixed
- Export now prepares the worklet inside its `OfflineAudioContext`, so the crusher sounds the
  same offline as live.

---

## [1.3.0] — 2026-11-11

The optional pack. The core file is unchanged in spirit — still one self-contained
`dist/neonboom.html` — but a second, separate asset can now skip synthesis entirely.

### Added
- **`pack/neonboom-pack-v1.zip`** (6.9 MB): the 27 loops as mono 16-bit WAVs plus a
  `pack.json` manifest, rendered by the app's own synth via `scripts/build-pack.mjs`.
  No third-party samples, so the PolyForm licence covers it like the code.
- **`src/core/looppack.js`**: dependency-free zip reader (store + deflate via
  `DecompressionStream`), parallel decode, install into the library. Boot order is now
  **loop cache → pack → synthesise**.
- **"Load pack…"** in the Export pane and the More sheet, for `file://` and for anyone
  who wants to hand-carry the pack.
- Bundled builds (Electron, Android) get a `<meta name="neonboom-pack-local">` tag and load
  the pack automatically; the open web can opt in with `?pack=1`.
- `npm run build:pack` and `npm run test:pack`.

### Why it is opt-in on the web
Measured, not assumed: fetching 6.9 MB takes ~1.5 s even on a local server, while the
priority half of the library synthesises in about the same time. On a slow connection the
pack would make the first visit *slower*, so the web default is the button, and the loop
cache already makes every visit after the first instant.

### Changed
- Pages deploy ships `pack/`; releases attach the pack; the desktop payload includes it.
- The zip writer is shared in spirit between the app (`NB.Wav.zip`) and the build script.

---

## [1.2.0] — 2026-11-11

The speed-and-groove release: it takes the top of the 1.1 roadmap.

### Added
- **Loop cache.** The 27 procedural loops are rendered once, stored in IndexedDB as 16-bit
  PCM (mono when both channels match, which they do), and re-hydrated on the next visit.
  A warm start is a memory copy. Measured in the headless harness: **4.7 s → 1.6 s**.
- **Phased boot.** Only the loops the demo and the first screenful of pads need are waited for;
  the rest stream in after the veil lifts and the pad grid fills itself in.
- **Per-clip pitch** (±12 semitones, sampler-style: it changes speed with the pitch).
- **Per-clip reverse**, with a reversed buffer cached per sample.
- **Per-clip fade in / fade out** envelopes, drawn as wedges on the clip and applied in the
  audio graph — so the export matches.
- **Swing** (0–60 %) that delays every second sixteenth, applied to playback *and* export.
- **Stem export**: one WAV per track through the same master chain, bundled into a zip by a
  dependency-free store-only ZIP writer (`NB.Wav.zip`).
- A shared scheduler (`src/audio/schedule.js`) that both live playback and the offline render
  call, so the two can no longer drift apart.

### Changed
- Boot now opens storage *before* synthesising, because the cache is the reason not to synthesise.
- `Persistence.load()` skips the sample store entirely when the project has no imports.
- Long-press on a clip is now driven by elapsed time as well as a timer, so a starved timer on a
  busy device still opens the sheet.
- Sheets dismiss on `pointerdown` rather than `click`: a long-press opens the sheet while the
  finger is still down, and the compatibility click used to close it instantly.

### Fixed
- Flaky long-press dismissal on touch.
- Test suite shared one browser profile across sections, so one section's autosaved project leaked
  into the next; each section now gets its own browser context.

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
