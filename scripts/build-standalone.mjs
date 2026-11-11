#!/usr/bin/env node
/* =========================================================================
   NEONBOOM · build-standalone.mjs
   Inlines every stylesheet, script and icon into ONE self-contained HTML file
   that runs from a double-click (file://) with no server and no network.

   Emits two files:
     dist/neonboom.html       readable — what you read, debug and learn from
     dist/neonboom.min.html   minified — what you ship and download

   The readable build is the source of truth; the minified one is produced from
   it, so they cannot drift.
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/* terser is a dev dependency. If it is missing (a bare checkout, a CI job that
   skipped npm install) the readable build is still produced and the minified
   one is skipped with a warning rather than failing the build. */
let minifyJS = null;
try {
  ({ minify: minifyJS } = await import('terser'));
} catch (e) {
  console.warn('terser not installed — skipping dist/neonboom.min.html (run npm install)');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/* ------------------------------------------------------------- css ------
   Conservative: strip comments, collapse whitespace, drop spaces around
   structural punctuation. Nothing is reordered or rewritten. */
function minifyCSS(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>~+])\s*/g, '$1')
    .replace(/;}/g, '}')
    .replace(/\s*!\s*important/g, '!important')
    .trim();
}

/* ------------------------------------------------------------- html ----- */
let html = read('index.html');

const cssChunks = [];
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => {
  cssChunks.push(read(href));
  return `<!--css:${cssChunks.length - 1}-->`;
});

const jsChunks = [];
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  jsChunks.push({ src, code: read(src) });
  return `<!--js:${jsChunks.length - 1}-->`;
});

/* inline the icon so a single file has zero external requests */
const icon = read('assets/img/icon.svg');
html = html.replace(/<link rel="icon" href="[^"]+" type="image\/svg\+xml">/,
  `<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}">`);
html = html.replace(/<link rel="apple-touch-icon" href="[^"]+">/, '');
html = html.replace(/<link rel="manifest" href="[^"]+">/, '');
html = html.replace(/<meta property="og:image" content="[^"]+">/, '');

const stamp = new Date().toISOString().slice(0, 10);

/* ------------------------------------------------- readable build ----- */
let out = html
  .replace('<head>', `<head>\n<!-- NEONBOOM standalone build · ${stamp} · runs offline from file:// -->`)
  .replace(/<!--css:(\d+)-->/g, (_, i) => `<style>\n${cssChunks[i]}\n</style>`)
  .replace(/<!--js:(\d+)-->/g, (_, i) => `<script>\n${jsChunks[i].code}\n</script>`);

const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const readable = path.join(outDir, 'neonboom.html');
fs.writeFileSync(readable, out);

/* ------------------------------------------------- minified build ----- */
const minifiedJS = [];
if (!minifyJS) {
  console.log(`built dist/neonboom.html      ${kb(readable)} KB  (readable only)`);
  process.exit(0);
}
for (const chunk of jsChunks) {
  const res = await minifyJS(chunk.code, {
    compress: { passes: 2, drop_debugger: true },
    mangle: true,
    format: { comments: false },
    sourceMap: false,
  });
  if (!res || typeof res.code !== 'string') throw new Error('terser failed on ' + chunk.src);
  minifiedJS.push(res.code);
}

let outMin = html
  .replace('<head>', `<head>\n<!-- NEONBOOM minified build · ${stamp} · readable source: neonboom.html -->`)
  .replace(/<!--css:(\d+)-->/g, (_, i) => `<style>${minifyCSS(cssChunks[i])}</style>`)
  .replace(/<!--js:(\d+)-->/g, (_, i) => `<script>${minifiedJS[i]}</script>`)
  .replace(/\n{2,}/g, '\n');

const minified = path.join(outDir, 'neonboom.min.html');
fs.writeFileSync(minified, outMin);

const kb = (f) => (fs.statSync(f).size / 1024).toFixed(0);
console.log(`built dist/neonboom.html      ${kb(readable)} KB  (readable)`);
console.log(`built dist/neonboom.min.html  ${kb(minified)} KB  (minified, ${Math.round((1 - fs.statSync(minified).size / fs.statSync(readable).size) * 100)}% smaller)`);
