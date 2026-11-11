# NEONBOOM — enhancement list

Written to answer three questions: **how do we make it faster, how do we make it work with no
network at all, and how do we make it more useful without turning a 190 KB single file into a
framework.** Every item is scored for effort and for bloat risk, so the cheap wins can be taken
first and the expensive ones argued about later.

Effort: **S** ≈ under a day · **M** ≈ 1–3 days · **L** ≈ a week or more.
Bloat: **low** = no new dependency, small diff · **med** = a new subsystem · **high** = new
dependency or a second code path to maintain.

---

## 0. Where it stands now (measured, not guessed)

| Metric | Current (1.2.0) |
|---|---|
| Boot, cold (27 offline renders) | ≈ 3.7 s headless · ≈ 1.5–2 s on a normal laptop |
| Boot, warm (loop cache) | ≈ 1.6 s headless · under a second on a normal laptop |
| Timeline full repaint | 2.6 ms/frame |
| Playhead overlay | 0.01 ms/frame |
| Idle memory | ~40 MB (27 AudioBuffers, ~2 s each) |
| Payload | 190 KB single file, 0 requests at runtime |
| Tests | 66 headless assertions |

---

## 1. Faster

### 1.1 Boot time — the only slow thing in the app

The 27 loops are rendered one batch at a time through `OfflineAudioContext`. That is CPU work on
the main thread's audio renderer.

| # | Idea | Effort | Bloat | Gain |
|---|---|---|---|---|
| 1 | ~~Persist rendered loops as 16-bit PCM and re-hydrate~~ — **shipped in 1.2.0** (`NB.LoopCache`) | — | — | warm boot 4.7 s → 1.6 s |
| 2 | ~~Lazy-render the library: priority slice first, rest in the background~~ — **shipped in 1.2.0** | — | — | first paint ~1 s sooner |
| 3 | **Ship a pre-rendered loop pack** (one `.json` of base64 PCM, or a `.wav` per loop) built by `npm run build:loops`, fetched only if present, with procedural synthesis as the fallback. | M | med | boot ≈ 0.3 s, at the cost of ~2 MB of assets |
| 4 | Render at 32 kHz instead of 44.1 kHz for the drum loops (they lose nothing above 16 kHz). | S | low | ~25 % less render time and memory |
| 5 | Skip peaks computation for loops longer than N seconds and compute lazily on first draw. | S | low | minor |

Recommendation: **1 + 2**. They keep the "nothing to download" property and remove the wait
entirely after the first visit.

### 1.2 Playback and scheduling

| # | Idea | Effort | Bloat | Gain |
|---|---|---|---|---|
| 6 | ~~Look-ahead scheduler~~ — **shipped in 1.5.0** (25 ms tick, 180 ms horizon, sample-accurate loop points, live tempo) | — | — | — |
| 7 | **Reuse `AudioBufferSourceNode` gain nodes** per track instead of one gain per clip. | S | low | fewer nodes on dense arrangements |
| 8 | ~~Move the bitcrusher to AudioWorklet~~ — **shipped in 1.4.0** (data: URL module, ScriptProcessor fallback) | — | — | — |
| 9 | **Off-main-thread peaks**: compute peaks in a Web Worker when a sample is imported. | S | low | import of a 5-minute file no longer janks |
| 10 | Draw waveforms from a **pre-baked path per sample** (`Path2D` scaled per clip) instead of per-pixel rects. | S | low | ~2× faster clip drawing at high zoom |
| 11 | **Virtualise track rows** vertically as well as horizontally (already horizontal). | S | low | stays smooth past ~30 tracks |
| 12 | Replace the 30 fps `setInterval` meters with a single rAF loop that shares the playhead tick. | S | low | three timers → one (the scheduler added a fourth) |

### 1.3 Perceived speed

| # | Idea | Effort | Bloat |
|---|---|---|---|
| 13 | Optimistic paint on drag: move the clip rectangle immediately, redraw the waveform on pointer-up. | S | low |
| 14 | Preload the first 4 pads' waveforms into the boot veil so the grid never pops in. | S | low |
| 15 | `content-visibility:auto` on the inspector cards and drawer panes. | S | low |

---

## 2. More offline

| # | Idea | Effort | Bloat | Notes |
|---|---|---|---|---|
| 16 | **Versioned cache + update prompt**: bump `CACHE` on build, show "new version ready — reload". | S | low | the service worker already deletes old caches |
| 17 | **Precache the landing page and screenshots** so `docs/` works offline too. | S | low | |
| 18 | **Full offline project storage**: keep rendered loops in Cache Storage so a cold offline start is instant (see 1). | M | low | |
| 19 | **File System Access API** "open/save project in place" on Chromium. | S | low | graceful fallback to download |
| 20 | **Share-target / Web Share** so a project file can be sent to another device. | S | low | |
| 21 | **Periodic background sync** of nothing — deliberately not doing this; the app has no server. | — | — | listed to make the boundary explicit |

---

## 3. More useful (musical)

Ranked by "how much does this change what you can make", not by how fun it is to build.

| # | Feature | Effort | Bloat | Why it matters |
|---|---|---|---|---|
| 22 | ~~Per-clip pitch and reverse~~ — **shipped in 1.2.0** | — | — | — |
| 23 | **Automation lanes** for volume/pan/FX (draw a line, hear it) | L | med | the difference between a loop player and a DAW |
| 24 | ~~Stem export~~ — **shipped in 1.2.0** (`NB.Wav.renderStems` + `NB.Wav.zip`) | — | — | — |
| 25 | ~~Clip fades~~ — **shipped in 1.2.0** (drawn wedges + gain envelope) | — | — | equal-power curves still to do |
| 26 | **MIDI-in** (Web MIDI): pads on notes, knobs on CC | M | low | makes it playable with hardware |
| 27 | **Tap tempo + tempo automation-free half/double** | S | low | the most-requested small thing |
| 28 | **Scene / pattern launcher** (Ableton-style clip rows) | L | med | a different workflow; keep it optional behind a tab |
| 29 | **Sample editor** (trim, normalise, fade, crop to selection) | M | med | imported loops are otherwise un-editable |
| 30 | ~~Per-track FX send amounts~~ — **shipped in 1.4.0** (A/B on every strip, post-fader, exported) | — | — | — |
| 31 | ~~Undo history panel with named steps~~ — **shipped in 1.4.0** (drawer → History, click to jump) | — | — | — |
| 32 | ~~Project templates~~ — **shipped in 1.6.0** (`src/core/templates.js`) | — | — | — |
| 33 | ~~Swing~~ — **shipped in 1.2.0** (0–60 %, playback + export) | — | — | — |
| 34 | **Time-stretch quality switch** (playbackRate vs. simple WSOLA) | L | med | playbackRate changes pitch; WSOLA keeps it |

22, 24, 25, 30, 31, 32, 33, 35, 42, 44 and 45 are done. The next cheapest wins are **29**
(sample editor), **41** (empty-state guidance) and **12** (one rAF for the meters).

---

## 4. Usability and accessibility

| # | Idea | Effort | Bloat |
|---|---|---|---|
| 35 | ~~Colour-blind safe palette~~ — **shipped in 1.6.0** (Okabe–Ito, More → Appearance) | — | — |
| 36 | **Focus rings + full keyboard navigation** on the pad grid and mixer (roving tabindex) | M | low |
| 37 | **`aria-live` announcements** for transport state and clip edits | S | low |
| 38 | **Pinch-to-zoom** on the timeline in edit mode | S | low |
| 39 | **Haptics on clip snap** (already on buttons) | S | low |
| 40 | **Onboarding overlay** — three tips, shown once, dismissible | S | low |
| 41 | **Empty-state guidance** when a track has no clips | S | low |
| 42 | ~~Larger-text mode~~ — **shipped in 1.6.0** | — | — |
| 43 | **Reduced-motion** already respected; extend to the playhead follow | S | low |
| 44 | ~~Multi-select clips~~ — **shipped in 1.6.0** (shift-click + marquee, bulk ops) | — | — |
| 45 | ~~Copy/paste clips~~ — **shipped in 1.4.0** (Ctrl+C/X/V, paste at playhead) | — | — |

---

## 5. Distribution and project health

| # | Idea | Effort | Bloat |
|---|---|---|---|
| 46 | **Signed desktop builds in CI** (already wired; add code-signing secrets) | M | low |
| 47 | **Release APK via Gradle in CI** (debug APK already builds) | M | low |
| 48 | **Lighthouse/PWA CI check** on every PR | S | low |
| 49 | **Bundle-size budget** in CI: fail if `dist/neonboom.html` grows past 220 KB | S | low |
| 50 | **Visual regression screenshots** in CI (the harness already captures them) | S | low |
| 51 | **i18n**: extract UI strings into one dictionary, ship hi/bn/ta | M | med |
| 52 | **Docs site** generated from FUNCTIONS.md | S | low |

---

## 6. Deliberately rejected (bloat control)

These come up often. They are listed so the decision is visible rather than re-litigated.

| Rejected | Why |
|---|---|
| React/Vue/Svelte rewrite | The UI is ~60 DOM nodes updated imperatively; a framework would add 40 KB and a build step for no user-visible gain |
| A sample marketplace | Requires a server, breaks the offline promise |
| Cloud project sync | Same, plus privacy |
| Analytics | Contradicts the "no telemetry" claim on the landing page |
| Web MIDI *output* + external synth hosting | Scope creep into a different product |
| Video export / social sharing renders | Heavy (encoder), and the WAV already gets people into their editor |
| A plugin (VST/AU) build | The browser is the host; a wrapper would double the maintenance surface |
| Bundling samples **into** the app file | Would kill the 190 KB single file — but an *optional side pack* does not, see §8 |

---

## 8. Optional sample pack — design

The single-file promise is about the **core**: `neonboom.html` must stay small, self-contained
and offline. An optional pack is a separate download that the app *can* use and never *needs*.
It does not break the promise, and it is the cheapest way to make a cold start instant.

### Why it is safe to ship

| Concern | Answer |
|---|---|
| Licensing | The pack is rendered **by this app's own synth** (`src/audio/synth.js`) by a build script. No third-party samples, no clearance work, same PolyForm licence as the code. |
| Bloat | Zero bytes added to `dist/neonboom.html`. The pack is a separate asset, fetched only if present. |
| Offline | Downloaded once into Cache Storage, then available offline forever. If it is missing, the app synthesises exactly as it does today. |
| Determinism | Same generators, same REF_BPM, same `SYNTH_VERSION` — a pack and a live render are sample-identical. |

### Format

```
neonboom-pack-v1.zip
├── pack.json          { version, synthVersion, refBpm, loops:[{name, category, beats, file}] }
└── loops/
    ├── boomBapKick.wav
    └── … 26 more, 16-bit mono 44.1 kHz
```

- WAV (not a custom binary): debuggable, and a user can drag any file straight into the pads.
- Mono because every generator is mono-compatible — already exploited by the loop cache.
- Expected size: **≈ 6 MB** (≈ 70 s of mono 44.1 kHz/16-bit). Gzip gains ~5% — audio does not compress, so no deflate.

### Load order (unchanged fallback chain)

| Step | What happens | Cost |
|---|---|---|
| 1 | Loop cache in IndexedDB has the row | ~0 ms |
| 2 | Pack present → fetch once → decode → fill the cache | ~0.4 s, then cached |
| 3 | No pack → synthesise (today's behaviour) | ~3.7 s cold |

### Where the pack comes from

| Target | Delivery |
|---|---|
| Web / PWA | `pack/neonboom-pack-v1.zip` next to `index.html`; `HEAD` check on boot, `fetch` only if it answers |
| Single file (`file://`) | Cannot fetch — so a **"Load pack…" file picker** in the Export/More pane; the zip goes into the loop cache like any import |
| Electron | Shipped inside the app bundle as a resource, loaded from disk |
| Android | Capacitor asset, copied into the web dir |

### Work

| # | Task | Effort | Bloat |
|---|---|---|---|
| 53 | ~~`scripts/build-pack.mjs`~~ — **shipped in 1.3.0** | — | — |
| 54 | ~~`LoopPack.load()`~~ — **shipped in 1.3.0** (single fetch, parallel decode, no HEAD round trip) | — | — |
| 55 | ~~"Load pack…" picker~~ — **shipped in 1.3.0** (Export pane + More sheet) | — | — |
| 56 | ~~CI attaches the pack~~ — **shipped in 1.3.0** (release + Pages + desktop payload) | — | — |
| 57 | ~~Size/licence story in README + landing~~ — **shipped in 1.3.0** | — | — |

**Measured after shipping:** the pack is 6.9 MB and installs in ~2.0 s on a local server
(1.5 s of that is the fetch, 0.5 s the decode). That is *not* faster than synthesising the
priority half, which is why it is opt-in on the web and automatic only when bundled.
The loop cache remains the real win; the pack is for wrapped builds and offline hand-carry.

## 7. Suggested order of work

1. ~~Cache rendered loops (1) + lazy render (2)~~ — **done in 1.2.0**.
2. ~~Per-clip pitch/reverse (22), stem export (24), clip fades (25), swing (33)~~ — **done in 1.2.0**.
3. ~~Look-ahead scheduler (6)~~ — **done in 1.5.0**.
4. **AudioWorklet bitcrusher** (8) — removes the last deprecation warning.
5. **Automation lanes** (23) and **MIDI-in** (26) — the two features that change the ceiling.
6. **Optional sample pack** (53–57) — the last 3 s of cold boot, at zero cost to the core file.
