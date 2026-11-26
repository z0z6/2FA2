'use strict';
// Warstwa platformy: ta sama aplikacja działa w Electronie (Windows/Linux), w Capacitorze (Android)
// i – do podglądu – w zwykłej przeglądarce. Reszta kodu korzysta wyłącznie z window.Platform.

(function () {
  const APP_VERSION = '1.1.0'; // musi być zgodna z package.json (sprawdza to test)
  const cap = window.Capacitor;
  const isElectron = !!window.api;
  const isAndroid = !isElectron && !!cap && cap.isNativePlatform && cap.isNativePlatform();
  const kind = isElectron ? 'electron' : isAndroid ? 'android' : 'web';

  const plugin = (name) => {
    cap.Plugins = cap.Plugins || {};
    return cap.Plugins[name] || cap.registerPlugin(name);
  };
  const P = isAndroid ? {
    prefs: plugin('Preferences'),
    clip: plugin('Clipboard'),
    fs: plugin('Filesystem'),
    share: plugin('Share'),
    bars: plugin('SystemBars')
  } : {};

  // ───── magazyn: sejf (zaszyfrowany) i ustawienia (jawne, bez sekretów) ─────
  async function readKey(key) {
    if (isElectron) return window.api.read(key);
    if (isAndroid) return (await P.prefs.get({ key })).value || null;
    try { return localStorage.getItem('twofa.' + key); } catch (_) { return null; }
  }

  async function writeKey(key, value) {
    if (isElectron) return window.api.write(key, value);
    if (isAndroid) return value == null ? P.prefs.remove({ key }) : P.prefs.set({ key, value });
    try { value == null ? localStorage.removeItem('twofa.' + key) : localStorage.setItem('twofa.' + key, value); } catch (_) { /* brak */ }
  }

  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };

  let clipTimer = null;

  const Platform = {
    kind,
    isElectron,
    isAndroid,
    isMobile: isAndroid || (!isElectron && /Android|iPhone|iPad/i.test(navigator.userAgent)),
    canScanScreen: isElectron,
    canAutoUnlock: isElectron,

    async info() {
      if (isElectron) return window.api.info();
      return { version: APP_VERSION, platform: kind };
    },

    async loadVault() { return parse(await readKey('vault')); },
    async saveVault(obj) { return writeKey('vault', JSON.stringify(obj)); },
    async loadPrefs() { return parse(await readKey('prefs')) || {}; },
    async savePrefs(obj) { return writeKey('prefs', JSON.stringify(obj)); },

    // Klucz automatycznego odblokowania – tylko Electron, chroniony przez system (DPAPI w Windows)
    async getAutoKey() { return isElectron ? window.api.autoKeyGet() : null; },
    async setAutoKey(b64) { if (isElectron) return window.api.autoKeySet(b64 || null); },

    async copy(text, clearAfterMs) {
      if (isElectron) return window.api.copy(text, clearAfterMs || 0);
      if (isAndroid) await P.clip.write({ string: text });
      else await navigator.clipboard.writeText(text);
      clearTimeout(clipTimer);
      if (clearAfterMs) {
        clipTimer = setTimeout(async () => {
          try {
            if (isAndroid) {
              const cur = await P.clip.read();
              if (cur && cur.value === text) await P.clip.write({ string: ' ' });
            } else if ((await navigator.clipboard.readText()) === text) await navigator.clipboard.writeText('');
          } catch (_) { /* brak dostępu – pomijamy */ }
        }, clearAfterMs);
      }
    },

    // Zapis pliku: Windows – okno „Zapisz jako”, Android – arkusz udostępniania (Dysk, Pliki, e-mail…)
    async saveFile(name, text) {
      if (isElectron) return window.api.saveFile(name, text);
      if (isAndroid) {
        const r = await P.fs.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
        try {
          await P.share.share({ title: name, dialogTitle: 'Zapisz lub wyślij plik', url: r.uri });
        } finally {
          setTimeout(() => P.fs.deleteFile({ path: name, directory: 'CACHE' }).catch(() => {}), 120000);
        }
        return 'shared';
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return name;
    },

    // Zrzut wszystkich ekranów (Windows) – do wyszukania kodu QR widocznego np. w przeglądarce
    async captureScreens() { return isElectron ? window.api.captureScreens() : []; },

    openExternal(url) {
      if (isElectron) return window.api.openExternal(url);
      window.open(url, '_blank');
    },

    windowControl(action) { return isElectron ? window.api.windowControl(action) : null; },

    setBarsStyle(dark) {
      if (!isAndroid) return;
      P.bars.setStyle({ style: dark == null ? 'DEFAULT' : dark ? 'DARK' : 'LIGHT' }).catch(() => {});
    },

    on(channel, fn) { return isElectron ? window.api.on(channel, fn) : () => {}; }
  };

  window.Platform = Platform;
  document.documentElement.classList.add('platform-' + kind);
  if (Platform.isMobile) document.documentElement.classList.add('mobile');
})();
