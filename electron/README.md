# NEONBOOM desktop build

Wraps `dist/neonboom.html` in an Electron window.

```bash
# 1. build the single-file app from the repo root
cd .. && npm run build

# 2. copy it where the shell expects it
mkdir -p electron/app/pack
cp dist/neonboom.html electron/app/index.html
cp pack/neonboom-pack-v1.zip electron/app/pack/
# tell the app the pack is bundled (it cannot fetch from file://)
node -e "const fs=require('fs');const p='electron/app/index.html';const h=fs.readFileSync(p,'utf8');fs.writeFileSync(p,h.replace('<title>','<meta name=\"neonboom-pack-local\" content=\"1\">\n<title>'))"

# 3. run or package
cd electron && npm install
npm start          # dev
npm run dist       # installers for the current platform
```

`electron-builder` writes installers to `electron/dist/`. CI does this for all three platforms on
every tag — see `.github/workflows/release.yml`. Add `build/icon.ico`, `build/icon.icns` and
`build/icons/512x512.png` (generated from `assets/img/icon-512.png`) before packaging.
