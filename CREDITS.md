# Credits & attribution

NEONBOOM bundles **no third-party code, fonts, images, sample packs or impulse responses.**

- Every sound in the library is generated at runtime by [`src/audio/synth.js`](../src/audio/synth.js)
  using oscillators, filtered noise, gain envelopes and a `WaveShaperNode`.
- The reverb impulse response is synthesised noise with an exponential decay
  (`ImpulseResponse.generate` in [`src/audio/engine.js`](../src/audio/engine.js)) — no IR files.
- The UI uses only system font stacks (`ui-monospace`, `-apple-system`, `Segoe UI`, `Roboto`).
- Icons are hand-written inline SVG or generated PNGs in `assets/img/`.

## Standards and documentation followed

- **Web Audio API** — W3C Recommendation. Node graph, `OfflineAudioContext`,
  `setTargetAtTime` ramping, `ConvolverNode` sample-rate constraints.
- **MDN Web Docs — Web Audio API, Canvas API, Service Worker API** (CC-BY-SA 2.5).
- **Web App Manifest / PWA install criteria** — W3C + browser vendor documentation.
- **Pointer Events** — W3C, for one code path across mouse, touch and pen.
- **PolyForm Noncommercial License 1.0.0** — PolyForm Project.

## Reading list

If you want to understand *why* the DSP here sounds the way it does, these are the books
that cover the territory. Nothing in this repository is copied from them — they are the
public literature behind the techniques:

| Book | Authors | Publisher |
|---|---|---|
| *The Audio Programming Book* | Richard Boulanger, Victor Lazzarini | MIT Press, 2010 |
| *Web Audio API* | Boris Smus | O'Reilly, 2013 |
| *Designing Sound* | Andy Farnell | MIT Press, 2010 |
| *Musimathics, Vol. 1: Musical Elements* | Gareth Loy | MIT Press, 2006 |
| *Musimathics, Vol. 2: Musical Signals* | Gareth Loy | MIT Press, 2011 |
| *Mixing Secrets for the Small Studio* | Mike Senior | Focal Press, 2011 |
| *The Sound Reinforcement Handbook* | Gary Davis, Ralph Jones | Yamaha / Hal Leonard |

## Techniques used, and where they come from

| Technique | Where it is used | Origin |
|---|---|---|
| Pitch-swept sine kick (150 Hz → 38 Hz) | `kickHit` | Classic analogue drum-synth topology (TR-808/909 lineage) |
| Sub + saturated octave layer for 808 bass | `bass808` | Standard 808 sound design: the fundamental is inaudible on laptop speakers, the harmonic is not |
| Band-passed noise snare/clap, triple transient | `snareHit`, `clapHit` | Noise-burst percussion synthesis |
| Two detuned square oscillators through a narrow band-pass | `cowbellHit` | 808 cowbell circuit |
| Saw + low-pass envelope pluck | `arpNote` | Subtractive synthesis |
| Inharmonic bell partials (1, 2.4, 3.8 × f) | `bellNote` | FM/bell additive ratios |
| Tempo-synced delay in 16th-note units | `Fx.apply('delaySync')` | Standard DAW delay sync |
| Synthetic exponentially-decaying noise IR | `ImpulseResponse` | Common convolution reverb test/placeholder IR |
| Peak-envelope waveform drawing | `computePeaks` | Standard audio-editor waveform decimation |

## Third-party licences

None. `puppeteer-core` is a **dev-only** dependency used by the test harness and is not
shipped in any build artifact.
