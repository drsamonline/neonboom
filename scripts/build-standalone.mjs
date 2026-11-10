#!/usr/bin/env node
/* =========================================================================
   NEONBOOM · build-standalone.mjs
   Inlines every stylesheet, script and icon into ONE self-contained HTML file
   that runs from a double-click (file://) with no server, no network and no
   build step at runtime. This is the file shipped in Releases and used as the
   web/PWA/Electron/Capacitor payload.
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('index.html');

/* --- inline stylesheets ------------------------------------------------- */
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => {
  return `<style>\n${read(href)}\n</style>`;
});

/* --- inline scripts (keep order) ---------------------------------------- */
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  return `<script>\n${read(src)}\n</script>`;
});

/* --- inline the icon so a single file has zero external requests -------- */
const icon = read('assets/img/icon.svg');
html = html.replace(/<link rel="icon" href="[^"]+" type="image\/svg\+xml">/,
  `<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}">`);
html = html.replace(/<link rel="apple-touch-icon" href="[^"]+">/, '');

/* --- drop PWA-only references (no server, no manifest fetch) ------------ */
html = html.replace(/<link rel="manifest" href="[^"]+">/, '');
html = html.replace(/<meta property="og:image" content="[^"]+">/, '');

/* --- mark the build ----------------------------------------------------- */
html = html.replace('<head>',
  `<head>\n<!-- NEONBOOM standalone build · ${new Date().toISOString().slice(0, 10)} · runs offline from file:// -->`);

const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'neonboom.html');
fs.writeFileSync(outFile, html);

const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(`built dist/neonboom.html (${kb} KB, single file, no external requests)`);
