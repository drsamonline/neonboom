# Dogfooding — one real session, end to end

The roadmap was empty, so the useful next step was not another feature: it was using the thing.
This is what a scripted first session found, driving the real UI (clicks, uploads, mouse gestures)
rather than the internal API.

Reproduce: `node tests/dogfood.mjs` (needs the app built; see the script header).

## The session

| Step | What it did | Result |
|---|---|---|
| 1 | Opened the template picker, chose **Trap** | 8 tracks, 36 clips, 140 BPM |
| 2 | Uploaded a 1.8 s WAV of a chord stab through the import input | Registered as an `Imported` sample, new category chip, 28th pad |
| 3 | Placed it on track 4 at bar 3 | Clip created at sixteenth 32 |
| 4 | Turned on **Tempo-fit**, set **Pitch +3** | `stretch: true`, pitch applied |
| 5 | Switched track 4 to the automation lane | `level` lane on |
| 6 | Clicked two points in the lane with the mouse | 2 breakpoints, both draggable |
| 7 | Saved a scene, removed the drums, saved another | 2 chips in the strip |
| 8 | Launched the first scene | 37 clips, quantised to the bar |
| 9 | Bounced stems | 8 WAVs, 20 MB zip, 19.5 s |
| 10 | Bounced the master | 2.5 MB WAV, 14.9 s, peak 0.86 |
| 11 | Reloaded the page | Project, sample, scenes and automation all restored |
| 12 | Launched a scene after the reload | **0 missing samples** |

## What it found

### Fixed in 2.4.1 — a scene could play silence after a reload

Scenes hold their own copy of the track list. `Persistence.load()` remapped clip sample ids for the
live tracks but handed `Project.scenes` back untouched. So a scene captured *after* importing a
sample kept the pre-reload id, and launching it after a restart produced a track of clips pointing
at a sample the library no longer had — silence, with no error.

The dogfood pass caught it as one line in a JSON dump (`missing: 1`). There is now a regression
test that imports a sample, captures a scene, reloads, launches it and asserts zero missing ids.

### Fixed in 2.4.1 — the inspector's sliders had no accessible names

The visible `<label>` elements were never associated with their inputs: no `for`/`id`, no
`aria-label`. A screen reader announced "slider" four times in a row. Each now carries an
`aria-label` ("Clip pitch in semitones", "Fade in", …).

## What it did not find, but noticed

- **Stem export is slow**: ~19.5 s for 8 tracks, because it renders the arrangement once per track.
  Correct, and acceptable for a bounce, but it is the one operation where the UI needs a progress
  indicator rather than a spinner-less wait. Left as is — a progress bar is a feature.
- **Nothing else.** No console errors, no failed requests, no dead buttons, no broken layout at any
  step. The four other interactions the script exercises (template, import, automation by mouse,
  scene launch) all worked first time.

## Worth trying next by hand

The script can drive the API and the DOM, but it cannot judge sound. The parts only a person can
assess: whether WSOLA tempo-fit is clean enough on real loops, whether the bitcrusher is usable at
its default settings, and whether the demo arrangement is a good first impression.
