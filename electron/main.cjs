/* NEONBOOM desktop shell — loads the single-file build in a Chromium window.
   No node integration in the renderer: the app is pure web, the shell only
   provides a window, a menu-free frame and a sensible size. */
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 380,
    minHeight: 520,
    backgroundColor: '#08090b',
    title: 'NEONBOOM',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,   // keep the audio clock alive when unfocused
    },
  });

  win.loadFile(path.join(__dirname, 'app', 'index.html'));

  // external links open in the real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
