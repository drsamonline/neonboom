# Contributing

Thanks for looking. NEONBOOM is deliberately small, and the fastest way to keep it that way is
to keep the rules boring.

## Ground rules

1. **No new runtime dependencies.** The shipped app is plain scripts, plain CSS and the platform.
   A PR that adds a framework, a UI kit or a build step for the runtime will be closed.
2. **Keep the single-file build working.** `npm run build` must still produce a
   `dist/neonboom.html` that runs from `file://`.
3. **No network calls.** No analytics, no fonts from a CDN, no telemetry, no sample downloads.
4. **Stay inside the budget.** `dist/neonboom.html` should stay under 220 KB.
5. **Touch is not an afterthought.** Any new control needs a ≥ 40 px target and a state that is
   reachable without hover.

## Workflow

```bash
git clone https://github.com/drsamonline/neonboom.git
cd neonboom
npm install          # puppeteer-core, dev only
npm run build        # dist/neonboom.html
npm test             # 66 headless assertions
```

Before opening a PR:

- `npm test` is green.
- `npm run build` succeeds and the standalone file boots.
- If you changed layout, run `npm run screenshots` and include the new images in the PR.
- If you changed behaviour, add an assertion to `tests/run.mjs`.

## Where things live

`src/core` is state and time, `src/audio` is sound, `src/ui` is DOM and canvas, `src/app.js` is the
boot order. Modules hang off `window.NB` and are loaded in dependency order from `index.html` —
if you add a file, add the `<script>` tag in the right place and to the list in `sw.js` and
`scripts/build-standalone.mjs` picks it up automatically.

## Licence of contributions

By opening a pull request you agree your contribution is licensed under the same
PolyForm Noncommercial 1.0.0 terms as the project.
