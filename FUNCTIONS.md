# NEONBOOM — function inventory

Everything the app can do, where it lives, and whether it is covered by the headless test
suite (`npm test` → 66 assertions). "Tested" means an automated assertion exercises it.

Legend: ✅ implemented and tested · 🔎 implemented, verified manually · ⚠️ known limitation

---

## 1. Transport — `src/core/transport.js`

| Function | What it does | Status |
|---|---|---|
| `play()` | Resumes the AudioContext, schedules every audible clip from the current position, starts the metronome scheduler and the rAF tick | ✅ |
| `pause()` | Captures the position from the audio clock, stops all sources, cancels timers | ✅ |
| `stop()` | Pause + return to 0 (or loop-in when looping) | ✅ |
| `rewind()` | Return to loop-in if the playhead is inside the loop, else to 0; resumes if it was playing | ✅ |
| `seekTo(six)` | Jump to a sixteenth position, rescheduling when rolling | ✅ |
| `toggle()` | Play/pause for the button and the space bar | ✅ |
| `currentSix()` | Position derived from `AudioContext.currentTime`, so it never drifts from the audio | ✅ |
| `_scheduleAll(from, t)` | Schedules clips that start after `from` plus any clip that straddles it (with buffer offset), and arms the loop re-entry timer | ✅ |
| `refresh()` | Debounced re-schedule after an edit — delete a clip mid-playback and it stops | ✅ |
| `_startMetronome()` / `_stopMetronome()` | 40 ms look-ahead scheduler that places clicks on the audio clock, accenting bar starts | 🔎 |
| `recordPad(sampleId, trackId)` | Places a clip at the quantised playhead on the selected track | ✅ |
| `onTick(fn)` | Registers a per-frame callback (used by the LCD) | ✅ |

## 2. Audio engine — `src/audio/engine.js`

| Function | What it does | Status |
|---|---|---|
| `AudioEngine` | Owns the `AudioContext` and the master chain | ✅ |
| `_buildMasterChain(ctx, dest)` | EQ → dry/delay/reverb sends → bitcrusher → limiter → master gain → destination. Reused offline for export | ✅ |
| `buildTrackBus(ctx, master)` | Per-track gain → panner → master input, with a meter tap | ✅ |
| `ensureTrackBuses(n)` | Grows or shrinks the bus array when tracks are added/removed | ✅ |
| `setTrackVolume(i,v)` / `setTrackPan(i,p)` | Ramped parameter writes | ✅ |
| `applyMix(tracks)` | Resolves mute/solo into real gains so it silences audio that is already playing | ✅ |
| `readMasterVU(bands)` / `readTrackLevel(i)` | Analyser reads with reusable buffers (no per-frame allocation) | ✅ |
| `preview(buffer, rate)` / `stopPreview()` | Audition a sample through the master chain | ✅ |
| `click(when, accent)` | Metronome voice | 🔎 |
| `ImpulseResponse.generate(ctx, sec, decay)` | Synthetic convolution reverb IR | ✅ |

## 2b. Shared scheduler — `src/audio/schedule.js`

| Function | What it does | Status |
|---|---|---|
| `Schedule.rate(clip, sample, bpm)` | playbackRate from tempo and pitch | ✅ |
| `Schedule.swingOffsetSix(clip, swing)` | delays odd sixteenths only | ✅ |
| `Schedule.when(clip, fromSix, start, bpm, swing)` | context time for a clip | ✅ |
| `Schedule.clip(ctx, dest, clip, sample, opts)` | builds the source + gain envelope (gain, fade in/out, reverse offset) and starts it; used by playback **and** export | ✅ |

## 2c. Optional pack — `src/core/looppack.js`

| Function | What it does | Status |
|---|---|---|
| `readZip(buffer)` | Store/deflate zip reader (EOCD → central dir → entries), no dependency | ✅ |
| `LoopPack.load(engine)` | Fetch `pack/neonboom-pack-v1.zip`, unzip, decode in parallel, register | ✅ |
| `LoopPack.fromFile(file, engine)` | Install from a picked file (the `file://` path); also writes the loop cache | ✅ |
| `LoopPack.tryAtBoot(engine, ms)` | Race the pack against a budget so a slow network never holds the veil | ✅ |
| `LoopPack.probe()` | Cheap existence check (kept for callers that want it) | 🔎 |

## 3. Synthesis — `src/audio/synth.js`

27 generators, each rendering an `AudioBuffer` offline at 90 BPM and declaring its musical
length in beats: kick, snare+clap, hats, 808 bass, stab chord, scratch, crash, trap kick,
four-on-floor, trap snare ghosts, rimshot, 32nd hats, shaker, cowbell, tom fill, ride,
sub drone, trap 808, arp pluck, pad swell, bell melody, scratch loop, riser, impact,
vinyl crackle, full boom-bap loop, dub chord.

Voices: `kickHit`, `snareHit`, `clapHit`, `hatHit`, `crashHit`, `bass808`, `stabChord`,
`scratchHit`, `tomHit`, `rimHit`, `shakerHit`, `cowbellHit`, `rideHit`, `arpNote`,
`padVoice`, `bellNote`, `riserSweep`, `impactHit`, `noiseBuffer`, `render`. ✅ all load at boot.

## 4. Project state — `src/core/project.js`

| Function | What it does | Status |
|---|---|---|
| `Library.register/get/list/byName/categories` | Sample registry with peaks, category, colour, source BPM, user bytes | ✅ |
| `computePeaks(buffer)` | 400-bucket peak envelope for waveform drawing | ✅ |
| `Project` | `name, bpm, snap, loopIn, loopOut, loopEnabled, metronome, tracks[], fx` | ✅ |
| `newTrack/initTracks/addTrack/removeTrack` | Track lifecycle (1–24 tracks) | ✅ |
| `newClip/clipEnd/findClip/removeClip` | Clip helpers | ✅ |
| `History.push/commit/undo/redo` | 80-step snapshot undo/redo with lazy commit so a drag that never moved does not pollute history | ✅ |
| `Persistence.open/save/saveSoon/load/clear` | IndexedDB autosave of project + imported sample bytes, with id remapping on restore | ✅ |
| `projectFile()` / `loadProjectFile()` | Portable `.neonboom.json` save/open (pitch, reverse, fades and swing included) | 🔎 |
| `LoopCache.many/all/put/hydrate` | 16-bit PCM loop cache in IndexedDB, mono when channels match | ✅ |
| `normaliseClip(clip)` | fills in optional clip fields on load | ✅ |
| `reversedBuffer(sample)` | cached reversed copy for reverse playback | ✅ |
| `LoopCache.many/all/put/hydrate` | 16-bit PCM loop cache in IndexedDB, mono when channels match | ✅ |
| `buildDemo()` | The 8-bar demo arrangement | ✅ |

## 5. Timeline — `src/ui/timeline.js`

| Function | What it does | Status |
|---|---|---|
| `init()` | Wires canvases, scroll sync, wheel zoom, `ResizeObserver` | ✅ |
| `resize()` | Viewport-sized canvases at device pixel ratio; spacer sized to project length | ✅ |
| `draw()` | Lanes, grid, loop shading, clips, waveform peaks, labels, selection handles | ✅ |
| `drawOverlay()` | Playhead only — 0.01 ms/frame | ✅ |
| `drawRulerBase()` / `drawRuler()` | Cached ruler base + moving playhead triangle | ✅ |
| `hitTest(x,y)` | Clip hit-testing with screen-pixel edge zones capped at ⅓ of the clip | ✅ |
| pointer drag | Move (snapped), cross-track drag, alt/ctrl-drag duplicate, edge trim (left/right, clamped to sample length) | ✅ |
| long-press / right-click / double-click | Opens the clip action sheet | ✅ |
| `rebuildHeaders()` | Track rows: rename, mute, solo, meter, volume | ✅ |
| `updateMeters()` | 30 fps track meters | 🔎 |
| `setZoom/zoomIn/zoomOut/zoomFit` | 18 %–500 % zoom | ✅ |
| `setMode('scroll'\|'edit')` | On touch: native panning vs. clip dragging | ✅ |
| `splitAtPlayhead/deleteSelected/duplicateSelected/nudge/quantize` | Clip operations | ✅ |
| `scrollToPlayhead()` | Follows the playhead while rolling | 🔎 |

## 6. Pads — `src/ui/pads.js`

`renderChips()` category filters · `render()` waveform tiles · `trigger()` audition + optional record ·
`place()` drop from drag-and-drop · `keyPress()` 1–0/Q/W keyboard audition. ✅

## 7. Mixer — `src/ui/mixer.js`

`mount()` · `render()` strips (fader, pan, mute, solo, meter) · `tickMeters()`.
Strips are rebuilt only on structural change, never while a fader is being dragged. ✅

## 8. FX rack — `src/ui/fx.js`

`mount/render/wire` · `apply(key,val)` pushes to the live graph · `retime()` re-syncs the delay
on tempo change · `snapshot()` feeds the offline export · double-click resets a knob · bitcrusher
on/off chip. ✅

## 9. Inspector — `src/ui/inspector.js`

Selected-clip card (waveform, start/length/end/trim, gain, split, duplicate, quantise, delete,
nudge) · project card (counts, tempo, loop, demo/save/open/export) · track card (name, volume,
pan, clear clips, delete track). ✅

## 10. Shell — `src/ui/shell.js`

| Area | What it does | Status |
|---|---|---|
| Transport bar | Play/stop/rewind/loop/metronome, LCD, BPM stepper + input, master VU, undo/redo, export, help | ✅ |
| LCD | Click → tempo field on desktop, transport sheet on phones; shows BPM + snap on small screens | ✅ |
| Drawer | Mixer · FX rack · Export · Help panes | ✅ |
| Mobile tabs | Pads · Arrange · Mix · FX · More, with bottom sheets | ✅ |
| Clip sheet | Gain, position, duplicate, split, quantise, delete | ✅ |
| Transport sheet | Tempo stepper, snap, metronome, loop toggle, rewind, play | ✅ |
| Keyboard | Space, R, L, K, S, Del, Q, F, M, arrows, ±, Ctrl+Z/Y/D/S, 1–0/Q/W | ✅ |
| Import | File picker + drag-and-drop anywhere; decode, register, persist bytes | 🔎 |
| Project files | Save/open `.neonboom.json` | 🔎 |
| Export | Full arrangement or loop region → 16-bit WAV with FX-matched offline render | ✅ |
| Stems | One WAV per track, zipped by `NB.Wav.zip` (store method, CRC32, no dependency) | ✅ |
| Clip sound | Pitch ±12 st, reverse, fade in/out, gain — live and offline | ✅ |
| Swing | Project-wide 0–60 %, in the inspector and the More sheet | ✅ |
| Install | `beforeinstallprompt` capture + service worker registration on http(s) | 🔎 |
| Toasts | Non-blocking feedback instead of `alert`/`prompt` | ✅ |

## 11. Boot — `src/app.js`

Parallel synthesis (6 workers) with a progress veil → mount UI → restore autosave → load the demo
on first run → reveal. ✅

---

## Known limitations

| # | Limitation | Why it exists | Fix |
|---|---|---|---|
| 1 | Bitcrusher uses `ScriptProcessorNode` | Needs no per-context worklet registration, which matters because export creates a fresh `OfflineAudioContext` each render | Move to `AudioWorkletNode` with a cached module (roadmap) |
| 2 | No per-clip pitch or reverse | Would need a second playback path and a peak re-render | Roadmap |
| 3 | Clip gain is applied at schedule time, not as a live node | Keeps the graph small | Add a per-clip gain node if automation lands |
| 4 | Tempo changes restart playback | Simple, glitch-free rescheduling | Look-ahead scheduler (roadmap) |
| 7 | Pitch is sampler-style (changes speed) | Matches the mental model of a sampler and needs no time-stretch | WSOLA time-stretch (roadmap) |
| 5 | No pinch-to-zoom on the timeline | Native panning is more valuable on touch than a gesture that fights it | Optional: two-finger zoom in edit mode |
| 6 | Imported samples are assumed to match the project tempo | No beat detection | Tempo field per sample + optional onset estimate |
