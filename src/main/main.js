'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, safeStorage, clipboard, desktopCapturer, screen, powerMonitor, session } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('2FA');
app.commandLine.appendSwitch('lang', 'pl');
if (process.platform === 'win32') app.setAppUserModelId('pl.projektnumer4.twofa');

// Wersja portable (Windows): dane obok pliku .exe, żeby całość dało się nosić na pendrivie
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataDir = process.env.TWOFA_DATA_DIR || (portableDir ? path.join(portableDir, '2FA - dane') : path.join(app.getPath('userData'), 'dane'));
const shotsDir = process.env.TWOFA_SHOTS;

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
const KEYS = { vault: 'sejf.json', prefs: 'ustawienia.json' };
const autoKeyFile = () => path.join(dataDir, 'odblokowanie.bin');

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  if (fs.existsSync(file) && file.endsWith(KEYS.vault)) fs.copyFileSync(file, file + '.bak');
  fs.renameSync(tmp, file);
}

function iconPath() { return path.join(__dirname, '..', 'assets', 'icon.png'); }

function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 440,
    height: 740,
    minWidth: 360,
    minHeight: 520,
    show: false,
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f7',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });
  win.setMenuBarVisibility(false);
  // Ochrona przed zrzutami i udostępnianiem ekranu (Windows/macOS) – kody nie trafią na nagrania
  if (!shotsDir) win.setContentProtection(true);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (shotsDir) {
    win.webContents.on('console-message', (...a) => { const e = a[0]; console.log('[renderer]', e && e.message ? e.message : a.slice(1).join(' ')); });
    win.webContents.once('did-finish-load', () => devScreenshots(shotsDir));
  }
  win.on('maximize', () => emit('window:state', { maximized: true }));
  win.on('unmaximize', () => emit('window:state', { maximized: false }));
  win.on('blur', () => emit('window:state', { focused: false }));
  win.on('focus', () => emit('window:state', { focused: true }));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Tryb deweloperski: zrzuty ekranu kolejnych widoków (TWOFA_SHOTS=katalog, TWOFA_STEPS="nazwa=JS,…")
async function devScreenshots(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  const steps = (process.env.TWOFA_STEPS || 'start').split(',');
  await wait(1200);
  for (const step of steps) {
    const [name, js] = step.split('=');
    if (js) await win.webContents.executeJavaScript(decodeURIComponent(js)).catch((e) => console.error(e));
    await wait(1100);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
  }
  app.quit();
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ─────────────────────────── IPC ───────────────────────────

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
}

let clipTimer = null;
let lastCopied = null;

function registerIpc() {
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, dataDir, portable: !!portableDir }));

  handle('window:control', (action) => {
    if (!win) return false;
    if (action === 'close') { win.close(); return false; }
    if (action === 'minimize') { win.minimize(); return win.isMaximized(); }
    if (action === 'maximize') {
      const target = !win.isMaximized();
      if (target) win.maximize(); else win.unmaximize();
      return target;
    }
    if (action === 'pin-on') { win.setAlwaysOnTop(true); return true; }
    if (action === 'pin-off') { win.setAlwaysOnTop(false); return false; }
    return win.isMaximized();
  });

  handle('store:read', (key) => {
    if (!KEYS[key]) throw new Error('Nieznany klucz.');
    const f = path.join(dataDir, KEYS[key]);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  });

  handle('store:write', (key, value) => {
    if (!KEYS[key]) throw new Error('Nieznany klucz.');
    const f = path.join(dataDir, KEYS[key]);
    if (value == null) { try { fs.unlinkSync(f); } catch (_) { /* brak */ } return true; }
    writeAtomic(f, String(value));
    return true;
  });

  handle('autokey:get', () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(fs.readFileSync(autoKeyFile()));
    } catch (_) { return null; }
  });

  handle('autokey:set', (b64) => {
    if (!b64) { try { fs.unlinkSync(autoKeyFile()); } catch (_) { /* brak */ } return false; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('System nie udostępnia bezpiecznego magazynu kluczy.');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(autoKeyFile(), safeStorage.encryptString(String(b64)));
    return true;
  });

  handle('clipboard:copy', (text, clearMs) => {
    clipboard.writeText(String(text));
    clearTimeout(clipTimer);
    lastCopied = clearMs > 0 ? String(text) : null;
    if (clearMs > 0) clipTimer = setTimeout(() => { if (clipboard.readText() === lastCopied) clipboard.clear(); lastCopied = null; }, clearMs);
    return true;
  });

  handle('file:save', async (name, text) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Zapisz plik',
      defaultPath: path.join(app.getPath('documents'), name),
      filters: [{ name: name.endsWith('.txt') ? 'Tekst' : 'Kopia 2FA', extensions: [name.split('.').pop()] }]
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, text);
    return r.filePath;
  });

  handle('screen:capture', async () => {
    const displays = screen.getAllDisplays();
    const w = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
    const h = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
    const wasVisible = win.isVisible() && !win.isMinimized();
    if (wasVisible) win.setOpacity(0);
    await new Promise((r) => setTimeout(r, 250));
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
      return sources.map((s) => s.thumbnail.toDataURL());
    } finally {
      if (wasVisible) win.setOpacity(1);
    }
  });

  handle('shell:openExternal', (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
}

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  fs.mkdirSync(dataDir, { recursive: true });
  // tylko kamera (skanowanie QR) i odczyt schowka (wklejanie kodu) – reszta uprawnień zablokowana
  const allowed = ['media', 'clipboard-read', 'clipboard-sanitized-write'];
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.includes(permission));
  registerIpc();
  createWindow();
  // blokada sejfu, gdy użytkownik blokuje komputer lub usypia system
  powerMonitor.on('lock-screen', () => emit('app:lock', 'system'));
  powerMonitor.on('suspend', () => emit('app:lock', 'system'));
  app.on('activate', showWindow);
});

app.on('before-quit', () => { if (lastCopied && clipboard.readText() === lastCopied) clipboard.clear(); });
app.on('window-all-closed', () => app.quit());
