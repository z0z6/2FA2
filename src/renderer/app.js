'use strict';
// Aplikacja 2FA – wspólny interfejs dla Windows (Electron) i Androida (Capacitor).

(function () {
  const { h, iconEl, toast, sheet, confirm, actionSheet, toggle, segmented, select, group, row, busy } = window.UI;
  const P = window.Platform;
  const $screen = document.getElementById('screen');

  const DEFAULT_PREFS = { theme: 'system', lockAfter: 300, hideCodes: false, clearClipboard: true, autoUnlock: false, sort: 'az', pinned: false, lastBackup: null };
  const S = {
    prefs: { ...DEFAULT_PREFS },
    info: {},
    file: null,
    dek: null,
    entries: [],
    query: '',
    codes: new Map(),
    revealed: new Map(),
    rows: new Map(),
    lastActivity: Date.now(),
    hiddenAt: null,
    ticker: null
  };

  // ───────────────────────── pomocnicze ─────────────────────────
  const COLORS = ['#007aff', '#34c759', '#ff9500', '#af52de', '#ff2d55', '#5856d6', '#30b0c7', '#ff3b30', '#a2845e', '#00c7be'];
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase();
  const titleOf = (e) => e.issuer || e.account || 'Bez nazwy';
  const subOf = (e) => (e.issuer ? e.account : '') || '';
  function colorOf(e) {
    const s = fold(titleOf(e));
    let x = 0;
    for (const ch of s) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[x % COLORS.length];
  }
  function initials(e) {
    const words = titleOf(e).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
  }
  const today = () => new Date().toISOString().slice(0, 10);
  const readText = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Nie udało się odczytać pliku.')); r.readAsText(file); });

  async function savePrefs(patch) {
    Object.assign(S.prefs, patch);
    await P.savePrefs(S.prefs);
  }

  function applyTheme() {
    const t = S.prefs.theme;
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    const dark = t === 'system' ? null : t === 'dark';
    P.setBarsStyle(dark);
  }

  async function persist() {
    S.file = await window.Vault.seal(S.file, S.dek, { v: 1, entries: S.entries });
    await P.saveVault(S.file);
  }

  function passwordField(placeholder, attrs = {}) {
    const input = h('input', { class: 'input lg full', type: 'password', placeholder, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...attrs });
    const eye = h('button', { class: 'field-eye', type: 'button', tabindex: '-1', title: 'Pokaż hasło', html: window.icon('eye', 17) });
    eye.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.innerHTML = window.icon(show ? 'eyeOff' : 'eye', 17);
    });
    const wrap = h('div', { class: 'field-pass' }, input, eye);
    wrap.input = input;
    return wrap;
  }

  function field(label, control, hint) {
    return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
  }

  // ───────────────────────── okno (Electron) ─────────────────────────
  function setupTitlebar() {
    const bar = document.getElementById('titlebar');
    const showBar = P.isElectron && S.info.platform !== 'darwin';
    if (!P.isElectron) { bar.remove(); document.body.classList.add('no-titlebar'); return; }
    if (S.info.platform === 'darwin') document.documentElement.classList.add('platform-darwin');
    if (!showBar) return;
    const traffic = document.getElementById('traffic');
    traffic.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const max = await P.windowControl(b.dataset.act);
      document.body.classList.toggle('maximized', !!max);
    });
    bar.addEventListener('dblclick', async (e) => {
      if (e.target.closest('.traffic')) return;
      const max = await P.windowControl('maximize');
      document.body.classList.toggle('maximized', !!max);
    });
    P.on('window:state', (s) => {
      if (s.maximized != null) document.body.classList.toggle('maximized', s.maximized);
      if (s.focused != null) document.body.classList.toggle('window-blur', !s.focused);
    });
  }

  // ───────────────────────── start ─────────────────────────
  async function init() {
    try { S.info = await P.info(); } catch (_) { S.info = {}; }
    setupTitlebar();
    S.prefs = { ...DEFAULT_PREFS, ...(await P.loadPrefs()) };
    applyTheme();
    if (P.isElectron && S.prefs.pinned) P.windowControl('pin-on');
    S.file = await P.loadVault();
    if (!S.file) return renderSetup();
    if (await tryAutoUnlock()) return;
    renderLock();
  }

  async function tryAutoUnlock() {
    if (!P.canAutoUnlock || !S.prefs.autoUnlock) return false;
    try {
      const b64 = await P.getAutoKey();
      if (!b64) return false;
      await openWithDek(await window.Vault.importDek(b64));
      return true;
    } catch (_) { return false; }
  }

  async function openWithDek(dek) {
    const payload = await window.Vault.open(S.file, dek);
    S.dek = dek;
    S.entries = (payload.entries || []).map((e) => window.OTP.makeEntry(e));
    S.lastActivity = Date.now();
    renderMain();
  }

  function lock() {
    if (!S.dek) return;
    window.UI.closeAllLayers();
    S.dek = null;
    S.entries = [];
    S.codes.clear();
    S.revealed.clear();
    S.rows.clear();
    clearInterval(S.ticker);
    renderLock();
  }

  // ───────────────────────── ekran: pierwsze uruchomienie ─────────────────────────
  function hero(title, text) {
    return h('div', { class: 'hero' },
      h('div', { class: 'logo', html: window.icon('shield', 38) }),
      h('h1', null, title),
      text ? h('p', { class: 'muted' }, text) : null);
  }

  function renderSetup() {
    const p1 = passwordField('Hasło główne', { autofocus: true });
    const p2 = passwordField('Powtórz hasło');
    const err = h('p', { class: 'form-error' });
    const btn = h('button', { class: 'btn primary xl full', type: 'submit' }, 'Utwórz sejf');
    const form = h('form', { class: 'auth-form', onsubmit: (e) => { e.preventDefault(); create(); } },
      p1, p2, err, btn,
      h('div', { class: 'note warn' }, iconEl('warn', 16),
        h('span', null, 'Hasła nie da się odzyskać. Zapisz je w bezpiecznym miejscu i rób kopie zapasowe – bez nich utrata urządzenia oznacza utratę kodów.')),
      h('button', { class: 'btn plain full', type: 'button', onclick: restoreFromBackup }, iconEl('import', 16), 'Przywróć z kopii zapasowej'));

    async function create(initialEntries = [], presetPassword) {
      const pass = presetPassword || p1.input.value;
      if (!presetPassword) {
        if (pass.length < 6) { err.textContent = 'Hasło musi mieć co najmniej 6 znaków.'; return; }
        if (pass !== p2.input.value) { err.textContent = 'Hasła nie są takie same.'; return; }
      }
      err.textContent = '';
      await busy(btn, async () => {
        const { file, dek } = await window.Vault.create(pass, { v: 1, entries: initialEntries });
        S.file = file;
        await P.saveVault(file);
        await openWithDek(dek);
      }, 'Szyfruję…');
    }

    async function restoreFromBackup() {
      const backup = await readBackupFile();
      if (!backup) return;
      await create(backup.entries, backup.password);
      toast(`Przywrócono ${backup.entries.length} kont. Hasło główne jest takie jak hasło kopii.`, 'success', 5000);
    }

    $screen.replaceChildren(h('div', { class: 'auth' },
      hero('Witaj w 2FA', 'Utwórz hasło główne. Zaszyfruje ono wszystkie klucze przechowywane na tym urządzeniu.'),
      form));
    setTimeout(() => p1.input.focus(), 50);
  }

  // ───────────────────────── ekran: blokada ─────────────────────────
  function renderLock() {
    const pass = passwordField('Hasło główne');
    const err = h('p', { class: 'form-error' });
    const btn = h('button', { class: 'btn primary xl full', type: 'submit' }, 'Odblokuj');
    const form = h('form', { class: 'auth-form', onsubmit: (e) => { e.preventDefault(); unlock(); } }, pass, err, btn);
    if (P.canAutoUnlock && S.prefs.autoUnlock) {
      form.appendChild(h('button', { class: 'btn plain full', type: 'button', onclick: async () => { if (!(await tryAutoUnlock())) err.textContent = 'Automatyczne odblokowanie nie działa – wpisz hasło.'; } },
        iconEl('unlock', 16), S.info.platform === 'win32' ? 'Odblokuj kontem Windows' : 'Odblokuj kontem systemu'));
    }
    async function unlock() {
      if (!pass.input.value) { pass.input.focus(); return; }
      err.textContent = '';
      try {
        await busy(btn, async () => {
          const dek = await window.Vault.unlock(S.file, pass.input.value);
          await openWithDek(dek);
        }, 'Odblokowuję…');
      } catch (e) {
        err.textContent = e.message;
        form.classList.remove('shake');
        void form.offsetWidth;
        form.classList.add('shake');
        pass.input.select();
      }
    }
    $screen.replaceChildren(h('div', { class: 'auth' },
      hero('Sejf zablokowany', 'Wpisz hasło główne, aby zobaczyć kody.'),
      form));
    setTimeout(() => pass.input.focus(), 50);
  }

  // ───────────────────────── ekran główny ─────────────────────────
  function sorted() {
    const list = [...S.entries];
    if (S.prefs.sort === 'az') list.sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'pl', { sensitivity: 'base' }) || subOf(a).localeCompare(subOf(b), 'pl'));
    return list;
  }

  function renderMain() {
    const search = h('input', {
      class: 'search-input', type: 'search', placeholder: 'Szukaj', value: S.query, autocomplete: 'off', spellcheck: 'false',
      oninput: (e) => { S.query = e.target.value; renderList(); }
    });
    const nav = h('header', { class: 'nav' },
      h('div', { class: 'nav-row' },
        h('button', { class: 'icon-btn nav-btn', title: 'Zablokuj', onclick: lock, html: window.icon('lock', 20) }),
        h('h1', { class: 'nav-title' }, 'Konta'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'icon-btn nav-btn', title: 'Ustawienia', onclick: openSettings, html: window.icon('gear', 21) }),
        h('button', { class: 'icon-btn nav-btn accent', title: 'Dodaj konto', onclick: openAdd, html: window.icon('plus', 22) })),
      h('div', { class: 'search' }, iconEl('search', 16), search));
    const list = h('div', { class: 'list', id: 'list' });
    const scroller = h('div', { class: 'main-scroll' }, list);
    scroller.addEventListener('scroll', () => nav.classList.toggle('scrolled', scroller.scrollTop > 4));
    $screen.replaceChildren(h('div', { class: 'main' }, nav, scroller,
      h('button', { class: 'fab', title: 'Dodaj konto', onclick: openAdd, html: window.icon('plus', 26) })));
    renderList();
    clearInterval(S.ticker);
    S.ticker = setInterval(tick, 250);
    tick();
  }

  function renderList() {
    const list = document.getElementById('list');
    if (!list) return;
    S.rows.clear();
    const q = fold(S.query.trim());
    const all = sorted();
    const items = q ? all.filter((e) => fold(e.issuer + ' ' + e.account).includes(q)) : all;
    const children = [];

    if (!S.prefs.lastBackup && S.entries.length) {
      children.push(h('button', { class: 'banner', type: 'button', onclick: openBackup },
        iconEl('warn', 18), h('div', null, h('b', null, 'Nie masz kopii zapasowej'), h('span', null, 'Utwórz ją, żeby nie stracić dostępu do kont.')), iconEl('chevronR', 16)));
    }

    if (!S.entries.length) {
      children.push(h('div', { class: 'empty' },
        h('div', { class: 'empty-icon', html: window.icon('qr', 40) }),
        h('h2', null, 'Brak kont'),
        h('p', { class: 'muted' }, 'Włącz weryfikację dwuetapową w wybranym serwisie i zeskanuj pokazany kod QR.'),
        h('button', { class: 'btn primary lg', onclick: openAdd }, iconEl('plus', 16), 'Dodaj konto')));
    } else if (!items.length) {
      children.push(h('div', { class: 'empty small' }, h('p', { class: 'muted' }, `Brak wyników dla „${S.query}”.`)));
    } else {
      children.push(h('div', { class: 'accounts' }, items.map(accountRow)));
      children.push(h('p', { class: 'list-footer' }, S.prefs.hideCodes ? 'Dotknij konta, aby pokazać i skopiować kod.' : 'Dotknij konta, aby skopiować kod.'));
    }
    list.replaceChildren(...children);
    tick();
  }

  const RING = 2 * Math.PI * 15;

  function accountRow(e) {
    const codeEl = h('div', { class: 'acct-code' }, '••• •••');
    const side = h('div', { class: 'acct-side' });
    let ringEl = null, secEl = null;
    if (e.type === 'totp') {
      ringEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ringEl.setAttribute('viewBox', '0 0 36 36');
      ringEl.setAttribute('class', 'ring');
      ringEl.innerHTML = `<circle class="ring-track" cx="18" cy="18" r="15"/><circle class="ring-prog" cx="18" cy="18" r="15" stroke-dasharray="${RING}" stroke-dashoffset="0"/>`;
      secEl = h('span', { class: 'ring-sec' });
      side.append(h('div', { class: 'ring-wrap' }, ringEl, secEl));
    } else {
      side.append(h('button', { class: 'icon-btn hotp-btn', title: 'Nowy kod', onclick: (ev) => { ev.stopPropagation(); nextHotp(e); }, html: window.icon('refresh', 18) }));
    }
    const more = h('button', { class: 'icon-btn more-btn', title: 'Więcej', onclick: (ev) => { ev.stopPropagation(); openEntryActions(e); }, html: window.icon('more', 18) });
    const el = h('div', { class: 'acct', role: 'button', tabindex: '0', onclick: () => copyEntry(e), oncontextmenu: (ev) => { ev.preventDefault(); openEntryActions(e); },
      onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); copyEntry(e); } } },
    h('div', { class: 'avatar', style: { background: colorOf(e) } }, initials(e)),
    h('div', { class: 'acct-main' },
      h('div', { class: 'acct-title' }, h('span', { class: 'acct-issuer' }, titleOf(e)), subOf(e) ? h('span', { class: 'acct-account' }, subOf(e)) : null),
      codeEl),
    side, more);
    S.rows.set(e.id, { el, codeEl, ringEl, secEl, entry: e });
    return el;
  }

  function isHidden(e) {
    if (e.type === 'hotp') return !(S.revealed.get(e.id) > Date.now());
    return S.prefs.hideCodes && !(S.revealed.get(e.id) > Date.now());
  }

  function tick() {
    const now = Date.now();
    if (S.dek && S.prefs.lockAfter > 0 && now - S.lastActivity > S.prefs.lockAfter * 1000) { lock(); return; }
    for (const r of S.rows.values()) {
      const e = r.entry;
      let c = S.codes.get(e.id);
      const ctr = e.type === 'hotp' ? e.counter : window.OTP.totpCounter(e.period, now);
      if (!c || c.counter !== ctr || c.secret !== e.secret || c.digits !== e.digits || c.algorithm !== e.algorithm) {
        if (!c || !c.pending || c.pendingCtr !== ctr) {
          const job = { pending: true, pendingCtr: ctr, code: c ? c.code : null, counter: c ? c.counter : null };
          S.codes.set(e.id, job);
          window.OTP.codeFor(e, now).then((code) => {
            S.codes.set(e.id, { counter: ctr, code, secret: e.secret, digits: e.digits, algorithm: e.algorithm });
            paintRow(r, Date.now());
          }).catch(() => S.codes.set(e.id, { counter: ctr, code: '------', secret: e.secret, digits: e.digits, algorithm: e.algorithm }));
        }
      }
      paintRow(r, now);
    }
  }

  function paintRow(r, now) {
    const e = r.entry;
    const c = S.codes.get(e.id);
    const hidden = isHidden(e);
    const mask = e.digits === 8 ? '•••• ••••' : '••• •••';
    const text = hidden || !c || !c.code ? mask : window.OTP.formatCode(c.code);
    if (r.codeEl.textContent !== text) r.codeEl.textContent = text;
    r.codeEl.classList.toggle('masked', hidden);
    if (r.ringEl) {
      const left = window.OTP.secondsLeft(e.period, now);
      r.ringEl.lastChild.setAttribute('stroke-dashoffset', String(RING * (1 - left / e.period)));
      const sec = String(Math.ceil(left));
      if (r.secEl.textContent !== sec) r.secEl.textContent = sec;
      r.el.classList.toggle('expiring', left <= 5);
    }
  }

  async function currentCode(e) {
    if (e.type === 'hotp') return window.OTP.codeFor(e);
    const c = S.codes.get(e.id);
    const ctr = window.OTP.totpCounter(e.period);
    if (c && c.counter === ctr && c.code && !c.pending) return c.code;
    return window.OTP.codeFor(e);
  }

  async function copyEntry(e) {
    try {
      if (e.type === 'hotp' && isHidden(e)) { await nextHotp(e); }
      const code = await currentCode(e);
      if (S.prefs.hideCodes && e.type === 'totp') S.revealed.set(e.id, Date.now() + 15000);
      await P.copy(code, S.prefs.clearClipboard ? 30000 : 0);
      const r = S.rows.get(e.id);
      if (r) { r.el.classList.remove('copied'); void r.el.offsetWidth; r.el.classList.add('copied'); paintRow(r, Date.now()); }
      toast(`Skopiowano kod: ${titleOf(e)}` + (S.prefs.clearClipboard ? ' · schowek wyczyści się za 30 s' : ''), 'success', 2600);
    } catch (err) { toast('Nie udało się skopiować: ' + err.message, 'error'); }
  }

  async function nextHotp(e) {
    e.counter += 1;
    await persist();
    S.revealed.set(e.id, Date.now() + 120000);
    tick();
  }

  // ───────────────────────── dodawanie kont ─────────────────────────
  function optionRow(icon, color, label, hint, onClick) {
    return row(label, iconEl('chevronR', 16, 'chev'), { icon, color, hint, onClick });
  }

  function openAdd() {
    let s;
    const go = (fn) => () => { s.close(); setTimeout(fn, 80); };
    const rows = [
      optionRow('camera', '#007aff', 'Skanuj kod QR', P.isMobile ? 'Aparatem telefonu' : 'Kamerą internetową', go(scanWithCamera)),
      P.canScanScreen ? optionRow('display', '#5856d6', 'Znajdź kod QR na ekranie', 'Np. kod wyświetlony w przeglądarce', go(scanScreen)) : null,
      optionRow('photo', '#34c759', 'Wczytaj obraz z kodem QR', 'Zrzut ekranu albo zdjęcie', go(scanImageFile)),
      !P.isMobile ? optionRow('paste', '#ff9500', 'Wklej ze schowka', 'Obraz kodu QR lub adres otpauth:// (Ctrl+V)', go(pasteFromClipboard)) : null,
      optionRow('keyboard', '#8e8e93', 'Wpisz klucz ręcznie', 'Gdy serwis pokazuje klucz tekstowy', go(() => openEntryForm(null))),
      optionRow('import', '#30b0c7', 'Importuj z pliku', 'Kopia zapasowa .json lub lista otpauth .txt', go(importFromFile))
    ];
    s = sheet({
      title: 'Dodaj konto',
      body: h('div', null, group(null, rows,
        'Przenosisz konta z Google Authenticatora? Otwórz go, wybierz „Przenieś konta” → „Eksportuj konta” i zeskanuj pokazany kod QR – wszystkie konta zostaną zaimportowane naraz.'))
    });
  }

  async function scanWithCamera() {
    const text = await window.QR.scanCamera();
    if (text) handleText(text);
  }

  async function scanScreen() {
    toast('Szukam kodu QR na ekranie…', 'info', 1800);
    try {
      const shots = await P.captureScreens();
      if (!shots.length) {
        toast('System nie udostępnił obrazu ekranu (np. Wayland bez zgody). Zrób zrzut ekranu i użyj „Wczytaj obraz z kodem QR”.', 'error', 6000);
        return;
      }
      for (const src of shots) {
        const text = await window.QR.decodeImageSource(src);
        if (text) return handleText(text);
      }
      toast('Nie znaleziono kodu QR. Upewnij się, że kod jest w całości widoczny na ekranie.', 'error', 5000);
    } catch (e) { toast('Nie udało się wykonać zrzutu ekranu: ' + e.message, 'error'); }
  }

  async function scanImageFile() {
    const file = await window.QR.pickFile('image/*');
    if (!file) return;
    const text = await window.QR.decodeBlob(file).catch(() => null);
    if (!text) return toast('Na obrazie nie znaleziono kodu QR.', 'error');
    handleText(text);
  }

  async function pasteFromClipboard() {
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const img = it.types.find((t) => t.startsWith('image/'));
          if (img) {
            const text = await window.QR.decodeBlob(await it.getType(img));
            if (text) return handleText(text);
            return toast('Na obrazie ze schowka nie znaleziono kodu QR.', 'error');
          }
          if (it.types.includes('text/plain')) {
            const t = await (await it.getType('text/plain')).text();
            return handleText(t);
          }
        }
      }
      toast('Schowek jest pusty.', 'error');
    } catch (_) {
      toast('Brak dostępu do schowka. Naciśnij Ctrl+V na liście kont.', 'info');
    }
  }

  async function onPaste(ev) {
    if (!S.dek || document.querySelector('.sheet-overlay') || ev.target.closest('input, textarea')) return;
    const items = [...(ev.clipboardData ? ev.clipboardData.items : [])];
    const img = items.find((i) => i.type.startsWith('image/'));
    if (img) {
      ev.preventDefault();
      const text = await window.QR.decodeBlob(img.getAsFile()).catch(() => null);
      return text ? handleText(text) : toast('Na obrazie ze schowka nie znaleziono kodu QR.', 'error');
    }
    const t = ev.clipboardData && ev.clipboardData.getData('text/plain');
    if (t && /otpauth/i.test(t)) { ev.preventDefault(); handleText(t); }
  }

  function handleText(text) {
    const t = String(text || '').trim();
    const r = window.OTP.parseAny(t);
    if (!r.entries.length) {
      toast(r.errors[0] || 'Ten kod nie zawiera danych konta 2FA (otpauth://).', 'error', 4500);
      return;
    }
    if (r.entries.length === 1 && !/otpauth-migration:/i.test(t)) return openEntryForm(r.entries[0], { isNew: true });
    openImportList(r.entries, r.batch);
  }

  // ───────────────────────── formularz konta ─────────────────────────
  function openEntryForm(entry, opts = {}) {
    const isNew = !entry || opts.isNew;
    const e = entry || { type: 'totp', issuer: '', account: '', secret: '', algorithm: 'SHA1', digits: 6, period: 30, counter: 0 };
    const issuer = h('input', { class: 'input lg full', value: e.issuer, placeholder: 'np. Google, GitHub, bank', autocomplete: 'off' });
    const account = h('input', { class: 'input lg full', value: e.account, placeholder: 'np. jan@example.com', autocomplete: 'off', autocapitalize: 'off' });
    const secret = h('input', { class: 'input lg full mono', value: e.secret, placeholder: 'np. JBSW Y3DP EHPK 3PXP', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' });
    const preview = h('div', { class: 'preview' });
    let type = e.type;
    const algorithm = select([{ value: 'SHA1', label: 'SHA-1 (domyślny)' }, { value: 'SHA256', label: 'SHA-256' }, { value: 'SHA512', label: 'SHA-512' }], e.algorithm, () => updatePreview(), { class: 'input lg full' });
    const digits = select([{ value: '6', label: '6 cyfr' }, { value: '7', label: '7 cyfr' }, { value: '8', label: '8 cyfr' }], String(e.digits), () => updatePreview(), { class: 'input lg full' });
    const period = h('input', { class: 'input lg full', type: 'number', min: '5', max: '600', value: String(e.period), oninput: () => updatePreview() });
    const counter = h('input', { class: 'input lg full', type: 'number', min: '0', value: String(e.counter || 0), oninput: () => updatePreview() });
    const periodField = field('Okres (sekundy)', period);
    const counterField = field('Licznik', counter);
    const syncType = () => { periodField.style.display = type === 'totp' ? '' : 'none'; counterField.style.display = type === 'hotp' ? '' : 'none'; };
    const typeCtl = segmented([{ value: 'totp', label: 'Czasowy (TOTP)' }, { value: 'hotp', label: 'Licznikowy (HOTP)' }], type, (v) => { type = v; syncType(); updatePreview(); });
    syncType();

    const collect = () => window.OTP.makeEntry({
      ...e, issuer: issuer.value, account: account.value, secret: isNew ? secret.value : e.secret, type,
      algorithm: algorithm.value, digits: digits.value, period: period.value, counter: counter.value
    });

    let previewTimer = null;
    async function updatePreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        if (!isNew) return;
        if (!secret.value.trim()) { preview.replaceChildren(); return; }
        try {
          const x = collect();
          const code = await window.OTP.codeFor(x);
          preview.replaceChildren(h('span', { class: 'muted' }, 'Bieżący kod: '), h('b', { class: 'mono' }, window.OTP.formatCode(code)),
            h('span', { class: 'muted small' }, ' – wpisz go w serwisie, aby potwierdzić.'));
          preview.classList.remove('bad');
        } catch (err) { preview.replaceChildren(h('span', null, err.message)); preview.classList.add('bad'); }
      }, 150);
    }
    secret.addEventListener('input', updatePreview);
    const advOpen = e.type !== 'totp' || e.algorithm !== 'SHA1' || e.digits !== 6 || e.period !== 30;
    const adv = h('details', { class: 'advanced', open: advOpen || null },
      h('summary', null, 'Ustawienia zaawansowane'),
      h('div', { class: 'fields' }, field('Rodzaj kodu', typeCtl), field('Algorytm', algorithm), field('Długość kodu', digits), periodField, counterField));

    const body = h('div', { class: 'fields' },
      field('Serwis', issuer),
      field('Konto', account),
      isNew ? field('Klucz', secret, 'Klucz tajny z serwisu (litery A–Z i cyfry 2–7). Spacje nie mają znaczenia.') : null,
      isNew ? preview : null,
      adv);

    sheet({
      title: isNew ? 'Nowe konto' : 'Edytuj konto',
      subtitle: isNew && entry ? 'Sprawdź nazwę i zapisz.' : null,
      body,
      actions: [
        { label: 'Anuluj' },
        {
          label: 'Zapisz', kind: 'primary', onClick: async () => {
            const x = collect();
            if (isNew) {
              if (S.entries.some((o) => window.OTP.sameAccount(o, x))) {
                const ok = await confirm({ title: 'To konto już jest na liście', text: 'Ten sam klucz został już dodany. Dodać go jeszcze raz?', ok: 'Dodaj' });
                if (!ok) return false;
              }
              S.entries.push(x);
            } else {
              const i = S.entries.findIndex((o) => o.id === e.id);
              if (i >= 0) S.entries[i] = x;
              S.codes.delete(e.id);
            }
            await persist();
            renderList();
            toast(isNew ? `Dodano konto ${titleOf(x)}` : 'Zapisano zmiany', 'success');
          }
        }
      ]
    });
    updatePreview();
    setTimeout(() => (isNew && !entry ? issuer : account).focus(), 280);
  }

  function openImportList(entries, batch) {
    const state = entries.map((e) => ({ e, dup: S.entries.some((o) => window.OTP.sameAccount(o, e)), on: true }));
    state.forEach((s) => { s.on = !s.dup; });
    const countLabel = () => `Importuj (${state.filter((s) => s.on).length})`;
    let importBtn = null;
    const rows = state.map((s) => {
      const cb = h('input', { type: 'checkbox', class: 'check', checked: s.on, onchange: (ev) => { s.on = ev.target.checked; if (importBtn) importBtn.textContent = countLabel(); } });
      return h('label', { class: 'import-row' },
        cb,
        h('div', { class: 'avatar sm', style: { background: colorOf(s.e) } }, initials(s.e)),
        h('div', { class: 'import-main' }, h('div', { class: 'acct-issuer' }, titleOf(s.e)), h('div', { class: 'acct-account' }, subOf(s.e) || (s.e.type === 'hotp' ? 'licznikowy' : ''))),
        s.dup ? h('span', { class: 'tag' }, 'już dodane') : null);
    });
    const multi = batch && batch.size > 1;
    const sh = sheet({
      title: 'Import kont',
      subtitle: `Znaleziono ${entries.length} ${entries.length === 1 ? 'konto' : entries.length < 5 ? 'konta' : 'kont'}.` + (multi ? ` To kod ${batch.index + 1} z ${batch.size} – po imporcie zeskanuj kolejny.` : ''),
      body: h('div', { class: 'import-list' }, rows),
      actions: [
        { label: 'Anuluj' },
        {
          label: countLabel(), kind: 'primary', onClick: async () => {
            const chosen = state.filter((s) => s.on).map((s) => s.e);
            if (!chosen.length) { toast('Nie zaznaczono żadnego konta.', 'error'); return false; }
            S.entries.push(...chosen);
            await persist();
            renderList();
            toast(`Zaimportowano ${chosen.length} kont.`, 'success');
          }
        }
      ]
    });
    importBtn = sh.panel.querySelector('.sheet-actions .btn.primary');
  }

  // ───────────────────────── działania na koncie ─────────────────────────
  function openEntryActions(e) {
    actionSheet({
      title: titleOf(e),
      subtitle: subOf(e) || null,
      items: [
        { label: 'Kopiuj kod', icon: 'copy', onClick: () => copyEntry(e) },
        { label: 'Edytuj', icon: 'pencil', onClick: () => openEntryForm(e) },
        { label: 'Eksportuj jako kod QR', icon: 'qr', onClick: () => showAccountQr(e) },
        { label: 'Pokaż klucz', icon: 'key', onClick: () => showSecret(e) },
        { label: 'Usuń', icon: 'trash', danger: true, onClick: () => removeEntry(e) }
      ]
    });
  }

  // ───────────────────────── eksport kodem QR ─────────────────────────
  const QR_WARNING = 'Kod QR zawiera klucz konta – każdy, kto go zeskanuje lub sfotografuje, będzie mógł generować Twoje kody. Pokaż go tylko na chwilę i upewnij się, że nikt nie patrzy na ekran.';

  async function showAccountQr(e) {
    const ok = await confirm({ title: 'Pokazać kod QR konta?', text: QR_WARNING, ok: 'Pokaż kod' });
    if (!ok) return;
    const problem = window.OTP.migrationProblem(e);
    sheet({
      title: 'Eksport konta',
      subtitle: titleOf(e) + (subOf(e) ? ' · ' + subOf(e) : ''),
      body: h('div', { class: 'qr-export' },
        window.QR.render(window.OTP.toOtpauth(e)),
        h('ol', { class: 'qr-steps' },
          h('li', null, 'Otwórz Google Authenticator (lub inną aplikację 2FA) na drugim urządzeniu.'),
          h('li', null, 'Dotknij ', h('b', null, '+'), ' → ', h('b', null, 'Zeskanuj kod QR'), '.'),
          h('li', null, 'Sprawdź, czy kody w obu aplikacjach są takie same.')),
        problem ? h('div', { class: 'note warn' }, iconEl('warn', 16), h('span', null, `Uwaga: ${problem}. Inne aplikacje (np. Aegis, 2FAS) obsłużą to konto poprawnie.`)) : null),
      actions: [{ label: 'Gotowe', kind: 'primary' }]
    });
  }

  function openGaExport() {
    if (!S.entries.length) { toast('Nie ma kont do eksportu.', 'error'); return; }
    const state = sorted().map((e) => ({ e, problem: window.OTP.migrationProblem(e) }));
    state.forEach((x) => { x.on = !x.problem; });
    let btn = null;
    const label = () => `Pokaż kody QR (${state.filter((x) => x.on).length})`;
    const all = h('input', { type: 'checkbox', class: 'check', checked: state.every((x) => x.on || x.problem), onchange: (ev) => {
      state.forEach((x, i) => { if (!x.problem) { x.on = ev.target.checked; boxes[i].checked = x.on; } });
      btn.textContent = label();
    } });
    const boxes = [];
    const rows = state.map((x) => {
      const cb = h('input', { type: 'checkbox', class: 'check', checked: x.on, disabled: !!x.problem, onchange: (ev) => { x.on = ev.target.checked; btn.textContent = label(); } });
      boxes.push(cb);
      return h('label', { class: 'import-row' + (x.problem ? ' disabled' : '') }, cb,
        h('div', { class: 'avatar sm', style: { background: colorOf(x.e) } }, initials(x.e)),
        h('div', { class: 'import-main' }, h('div', { class: 'acct-issuer' }, titleOf(x.e)),
          h('div', { class: 'acct-account' }, x.problem ? 'Niezgodne: ' + x.problem : subOf(x.e))));
    });
    const sh = sheet({
      title: 'Eksport do Google Authenticatora',
      subtitle: 'Wybierz konta. Zostaną zapisane w kodach QR, które Google Authenticator wczyta jednym skanem (Przenieś konta → Importuj konta).',
      body: h('div', { class: 'fields' },
        h('label', { class: 'select-all' }, all, h('span', null, 'Zaznacz wszystkie')),
        h('div', { class: 'import-list' }, rows)),
      actions: [
        { label: 'Anuluj' },
        {
          label: label(), kind: 'primary', onClick: async () => {
            const chosen = state.filter((x) => x.on).map((x) => x.e);
            if (!chosen.length) { toast('Nie zaznaczono żadnego konta.', 'error'); return false; }
            const ok = await confirm({ title: 'Pokazać kody QR?', text: QR_WARNING, ok: 'Pokaż kody' });
            if (!ok) return false;
            setTimeout(() => showGaBatches(window.OTP.migrationBatches(chosen)), 120);
          }
        }
      ]
    });
    btn = sh.panel.querySelector('.sheet-actions .btn.primary');
  }

  function showGaBatches(batches) {
    let i = 0;
    const box = h('div', { class: 'qr-export' });
    const counter = h('span', { class: 'qr-counter' });
    const prev = h('button', { class: 'btn lg', type: 'button', onclick: () => go(i - 1) }, iconEl('chevronL', 16), 'Poprzedni');
    const next = h('button', { class: 'btn lg primary', type: 'button', onclick: () => go(i + 1) }, 'Następny', iconEl('chevronR', 16));
    const pager = batches.length > 1 ? h('div', { class: 'qr-pager' }, prev, counter, next) : null;
    const names = h('p', { class: 'qr-names muted' });
    function go(n) {
      i = Math.max(0, Math.min(batches.length - 1, n));
      const b = batches[i];
      box.replaceChildren(window.QR.render(b.uri), names);
      names.textContent = b.entries.map(titleOf).join(', ');
      counter.textContent = `Kod ${i + 1} z ${batches.length}`;
      prev.disabled = i === 0;
      next.disabled = i === batches.length - 1;
    }
    const total = batches.reduce((n, b) => n + b.entries.length, 0);
    sheet({
      title: 'Zeskanuj w Google Authenticatorze',
      subtitle: `${total} ${total === 1 ? 'konto' : total < 5 ? 'konta' : 'kont'}` + (batches.length > 1 ? ` w ${batches.length} kodach QR – zeskanuj je po kolei.` : ' w jednym kodzie QR.'),
      body: h('div', { class: 'fields' },
        box,
        pager,
        h('ol', { class: 'qr-steps' },
          h('li', null, 'W Google Authenticatorze otwórz menu ', h('b', null, '☰'), ' → ', h('b', null, 'Przenieś konta'), ' → ', h('b', null, 'Importuj konta'), '.'),
          h('li', null, 'Dotknij ', h('b', null, 'Zeskanuj kod QR'), ' i wskaż kod' + (batches.length > 1 ? ' – aplikacja sama poprosi o kolejne.' : '.')),
          h('li', null, 'Po imporcie porównaj kody w obu aplikacjach.'))),
      actions: [{ label: 'Gotowe', kind: 'primary' }]
    });
    go(0);
  }

  async function showSecret(e) {
    const ok = await confirm({ title: 'Pokazać klucz?', text: 'Każdy, kto zobaczy klucz, może generować Twoje kody. Upewnij się, że nikt nie patrzy na ekran.', ok: 'Pokaż' });
    if (!ok) return;
    const uri = window.OTP.toOtpauth(e);
    const pretty = e.secret.replace(/(.{4})/g, '$1 ').trim();
    sheet({
      title: 'Klucz konta',
      subtitle: titleOf(e) + (subOf(e) ? ' · ' + subOf(e) : ''),
      body: h('div', { class: 'fields' },
        field('Klucz', h('div', { class: 'secret-box mono' }, pretty)),
        h('button', { class: 'btn lg full', onclick: () => { P.copy(e.secret, 30000); toast('Skopiowano klucz (schowek wyczyści się za 30 s)', 'success'); } }, iconEl('copy', 16), 'Kopiuj klucz'),
        field('Adres otpauth://', h('div', { class: 'secret-box mono small' }, uri), 'Wklej go w innej aplikacji 2FA, aby przenieść konto.'),
        h('button', { class: 'btn lg full', onclick: () => { P.copy(uri, 30000); toast('Skopiowano adres otpauth://', 'success'); } }, iconEl('copy', 16), 'Kopiuj adres')),
      actions: [{ label: 'Gotowe', kind: 'primary' }]
    });
  }

  async function removeEntry(e) {
    const ok = await confirm({
      title: `Usunąć „${titleOf(e)}”?`,
      text: 'Zanim usuniesz konto, wyłącz weryfikację dwuetapową w serwisie albo dodaj je w innej aplikacji. Bez klucza nie zalogujesz się do tego serwisu.',
      ok: 'Usuń', danger: true
    });
    if (!ok) return;
    S.entries = S.entries.filter((o) => o.id !== e.id);
    S.codes.delete(e.id);
    await persist();
    renderList();
    toast('Usunięto konto', 'success');
  }

  // ───────────────────────── kopie zapasowe ─────────────────────────
  function askPassword({ title, subtitle, confirmTwice = false, okLabel = 'Dalej' }) {
    return new Promise((resolve) => {
      const p1 = passwordField('Hasło');
      const p2 = confirmTwice ? passwordField('Powtórz hasło') : null;
      const err = h('p', { class: 'form-error' });
      let done = false;
      const s = sheet({
        title, subtitle,
        body: h('form', { class: 'fields', onsubmit: (ev) => { ev.preventDefault(); s.panel.querySelector('.sheet-actions .primary').click(); } }, p1, p2, err),
        onClose: () => { if (!done) resolve(null); },
        actions: [
          { label: 'Anuluj' },
          {
            label: okLabel, kind: 'primary', onClick: () => {
              const v = p1.input.value;
              if (v.length < (confirmTwice ? 6 : 1)) { err.textContent = confirmTwice ? 'Hasło musi mieć co najmniej 6 znaków.' : 'Wpisz hasło.'; return false; }
              if (p2 && v !== p2.input.value) { err.textContent = 'Hasła nie są takie same.'; return false; }
              done = true;
              resolve(v);
            }
          }
        ]
      });
      setTimeout(() => p1.input.focus(), 280);
    });
  }

  async function openBackup() {
    const pass = await askPassword({ title: 'Zaszyfrowana kopia zapasowa', subtitle: 'Ustal hasło kopii. Możesz użyć hasła głównego. Bez tego hasła kopii nie da się otworzyć.', confirmTwice: true, okLabel: 'Utwórz kopię' });
    if (!pass) return;
    try {
      const backup = await window.Vault.makeBackup({ v: 1, entries: S.entries }, pass);
      const r = await P.saveFile(`2FA-kopia-${today()}.json`, JSON.stringify(backup, null, 1));
      if (!r) return;
      await savePrefs({ lastBackup: new Date().toISOString() });
      renderList();
      toast(r === 'shared' ? 'Kopia gotowa – zapisz ją w bezpiecznym miejscu.' : 'Zapisano kopię zapasową.', 'success');
    } catch (e) { toast('Nie udało się zapisać kopii: ' + e.message, 'error'); }
  }

  async function exportPlain() {
    const ok = await confirm({
      title: 'Eksport bez szyfrowania',
      text: 'Plik będzie zawierał wszystkie klucze jawnym tekstem (adresy otpauth://). Użyj go tylko do przeniesienia kont do innej aplikacji i od razu usuń.',
      ok: 'Eksportuj', danger: true
    });
    if (!ok) return;
    const text = S.entries.map((e) => window.OTP.toOtpauth(e)).join('\n') + '\n';
    try { await P.saveFile(`2FA-otpauth-${today()}.txt`, text); } catch (e) { toast(e.message, 'error'); }
  }

  // Wczytuje plik kopii (.json) – zwraca { entries, password } albo null
  async function readBackupFile() {
    const file = await window.QR.pickFile('.json,application/json');
    if (!file) return null;
    let obj;
    try { obj = JSON.parse(await readText(file)); } catch (_) { toast('To nie jest prawidłowy plik kopii.', 'error'); return null; }
    if (!window.Vault.isVaultFile(obj)) { toast('To nie jest kopia zapasowa tej aplikacji.', 'error'); return null; }
    for (;;) {
      const password = await askPassword({ title: 'Hasło kopii zapasowej', subtitle: file.name, okLabel: 'Otwórz' });
      if (!password) return null;
      try {
        const data = await window.Vault.readBackup(obj, password);
        return { entries: (data.entries || []).map((e) => window.OTP.makeEntry(e)), password };
      } catch (e) { toast(e.message, 'error'); }
    }
  }

  async function importFromFile() {
    const file = await window.QR.pickFile('.json,.txt,image/*,application/json,text/plain');
    if (!file) return;
    if (file.type.startsWith('image/')) {
      const text = await window.QR.decodeBlob(file).catch(() => null);
      return text ? handleText(text) : toast('Na obrazie nie znaleziono kodu QR.', 'error');
    }
    const text = await readText(file);
    let obj = null;
    try { obj = JSON.parse(text); } catch (_) { /* nie JSON */ }
    if (obj && window.Vault.isVaultFile(obj)) {
      for (;;) {
        const password = await askPassword({ title: 'Hasło kopii zapasowej', subtitle: file.name, okLabel: 'Otwórz' });
        if (!password) return;
        try {
          const data = await window.Vault.readBackup(obj, password);
          return openImportList((data.entries || []).map((e) => window.OTP.makeEntry(e)), null);
        } catch (e) { toast(e.message, 'error'); }
      }
    }
    handleText(text);
  }

  // ───────────────────────── ustawienia ─────────────────────────
  function openSettings() {
    const lockOpts = [
      { value: '60', label: 'Po 1 minucie' }, { value: '300', label: 'Po 5 minutach' }, { value: '900', label: 'Po 15 minutach' },
      { value: '3600', label: 'Po 1 godzinie' }, { value: '0', label: 'Nigdy' }
    ];
    const security = [
      row('Automatyczna blokada', select(lockOpts, String(S.prefs.lockAfter), (v) => savePrefs({ lockAfter: Number(v) })), { icon: 'clock', color: '#ff9500', hint: 'Po tym czasie bezczynności lub w tle' }),
      row('Ukrywaj kody', toggle(S.prefs.hideCodes, async (v) => { await savePrefs({ hideCodes: v }); renderList(); }), { icon: 'eyeOff', color: '#5856d6', hint: 'Kod pojawi się po dotknięciu konta' }),
      row('Czyść schowek po 30 s', toggle(S.prefs.clearClipboard, (v) => savePrefs({ clearClipboard: v })), { icon: 'paste', color: '#34c759' })
    ];
    if (P.canAutoUnlock) {
      security.push(row(S.info.platform === 'win32' ? 'Odblokowuj kontem Windows' : 'Odblokowuj kontem systemu', toggle(S.prefs.autoUnlock, async (v) => {
        try {
          await P.setAutoKey(v ? await window.Vault.exportDek(S.dek) : null);
          await savePrefs({ autoUnlock: v });
          toast(v ? 'Sejf będzie otwierał się bez hasła na tym koncie systemu.' : 'Wyłączono odblokowanie bez hasła.', 'success');
        } catch (e) { toast(e.message, 'error'); }
      }), { icon: 'unlock', color: '#007aff', hint: 'Bez wpisywania hasła, gdy jesteś zalogowany na swoje konto (klucz chroniony przez system)' }));
    }
    security.push(row('Zmień hasło główne', iconEl('chevronR', 16, 'chev'), { icon: 'key', color: '#8e8e93', onClick: changePassword }));

    const look = [
      row('Motyw', segmented([{ value: 'system', label: 'Auto' }, { value: 'light', label: 'Jasny' }, { value: 'dark', label: 'Ciemny' }], S.prefs.theme, async (v) => { await savePrefs({ theme: v }); applyTheme(); }), { icon: 'moon', color: '#5856d6' }),
      row('Kolejność', select([{ value: 'az', label: 'Alfabetycznie' }, { value: 'added', label: 'Według dodania' }], S.prefs.sort, async (v) => { await savePrefs({ sort: v }); renderList(); }), { icon: 'sort', color: '#30b0c7' })
    ];
    if (P.isElectron) look.push(row('Zawsze na wierzchu', toggle(S.prefs.pinned, async (v) => { await savePrefs({ pinned: v }); P.windowControl(v ? 'pin-on' : 'pin-off'); }), { icon: 'pin', color: '#ff2d55' }));

    let s;
    const go = (fn) => () => { s.close(); setTimeout(fn, 80); };
    const backup = [
      row('Utwórz zaszyfrowaną kopię', iconEl('chevronR', 16, 'chev'), { icon: 'export', color: '#34c759', onClick: go(openBackup), hint: S.prefs.lastBackup ? 'Ostatnia: ' + new Date(S.prefs.lastBackup).toLocaleDateString('pl-PL') : 'Jeszcze nie utworzono kopii' }),
      row('Importuj z pliku', iconEl('chevronR', 16, 'chev'), { icon: 'import', color: '#007aff', onClick: go(importFromFile), hint: 'Kopia .json, lista otpauth .txt lub obraz QR' }),
      row('Eksportuj do Google Authenticatora', iconEl('chevronR', 16, 'chev'), { icon: 'qr', color: '#5856d6', onClick: go(openGaExport), hint: 'Kody QR do przeniesienia wielu kont naraz' }),
      row('Eksportuj jako tekst otpauth://', iconEl('chevronR', 16, 'chev'), { icon: 'warn', color: '#ff3b30', onClick: go(exportPlain), hint: 'Niezaszyfrowane – do przeniesienia do innej aplikacji' })
    ];
    const about = [
      row('Wersja', h('span', { class: 'muted' }, S.info.version || '1.0.0'), { icon: 'info', color: '#8e8e93' }),
      row('Kont w sejfie', h('span', { class: 'muted' }, String(S.entries.length)), { icon: 'shield', color: '#34c759' })
    ];
    if (P.isElectron && S.info.dataDir) about.push(row('Folder danych', null, { icon: 'folder', color: '#ff9500', hint: S.info.dataDir + (S.info.portable ? ' (wersja przenośna)' : '') }));

    s = sheet({
      title: 'Ustawienia', cls: 'tall',
      body: h('div', null,
        group('Bezpieczeństwo', security),
        group('Wygląd', look),
        group('Kopie zapasowe', backup),
        group('Informacje', about, 'Kody są liczone na tym urządzeniu. Aplikacja nie łączy się z internetem i nie wysyła żadnych danych.'),
        h('button', { class: 'btn lg full danger', onclick: () => { s.close(); setTimeout(lock, 100); } }, iconEl('lock', 16), 'Zablokuj teraz'))
    });
  }

  function changePassword() {
    const cur = passwordField('Obecne hasło');
    const p1 = passwordField('Nowe hasło');
    const p2 = passwordField('Powtórz nowe hasło');
    const err = h('p', { class: 'form-error' });
    sheet({
      title: 'Zmień hasło główne',
      body: h('div', { class: 'fields' }, cur, p1, p2, err),
      actions: [
        { label: 'Anuluj' },
        {
          label: 'Zmień', kind: 'primary', busyLabel: 'Szyfruję…', onClick: async () => {
            err.textContent = '';
            if (p1.input.value.length < 6) { err.textContent = 'Nowe hasło musi mieć co najmniej 6 znaków.'; return false; }
            if (p1.input.value !== p2.input.value) { err.textContent = 'Nowe hasła nie są takie same.'; return false; }
            try { await window.Vault.unlock(S.file, cur.input.value); } catch (_) { err.textContent = 'Obecne hasło jest nieprawidłowe.'; return false; }
            S.file = await window.Vault.changePassword(S.file, S.dek, p1.input.value);
            await P.saveVault(S.file);
            toast('Zmieniono hasło główne.', 'success');
          }
        }
      ]
    });
    setTimeout(() => cur.input.focus(), 280);
  }

  // ───────────────────────── aktywność i blokada ─────────────────────────
  const touch = () => { S.lastActivity = Date.now(); };
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => document.addEventListener(ev, touch, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { S.hiddenAt = Date.now(); return; }
    if (S.hiddenAt && S.dek && S.prefs.lockAfter > 0 && Date.now() - S.hiddenAt > S.prefs.lockAfter * 1000) lock();
    else if (S.dek) tick();
    S.hiddenAt = null;
  });
  document.addEventListener('paste', onPaste);
  P.on('app:lock', () => lock());

  // tryb deweloperski (zrzuty ekranu)
  window.__app = { S, openGaExport, showGaBatches, showAccountQr, openAdd, openSettings, openEntryForm, openImportList, openEntryActions, lock, renderList, handleText, persist };

  init().catch((e) => {
    console.error(e);
    $screen.replaceChildren(h('div', { class: 'auth' }, hero('Błąd uruchomienia', e.message)));
  });
})();
