'use strict';
// Silnik kodów jednorazowych: Base32, HOTP (RFC 4226), TOTP (RFC 6238),
// adresy otpauth:// oraz eksport z Google Authenticatora (otpauth-migration://).
// Działa w przeglądarce (window.OTP) i w Node (require) – korzysta z WebCrypto.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OTP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const subtle = () => globalThis.crypto.subtle;
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const ALGOS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

  // ───── Base32 ─────
  function normalizeSecret(s) {
    return String(s || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  }

  function base32Decode(input) {
    const s = normalizeSecret(input);
    if (!s.length) throw new Error('Pusty klucz.');
    let bits = 0, value = 0;
    const out = [];
    for (const ch of s) {
      const idx = ALPHABET.indexOf(ch);
      if (idx < 0) throw new Error(`Niedozwolony znak w kluczu: „${ch}”. Klucz zawiera tylko litery A–Z i cyfry 2–7.`);
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return new Uint8Array(out);
  }

  function base32Encode(bytes) {
    let bits = 0, value = 0, out = '';
    for (const b of bytes) {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
  }

  function isValidSecret(s) {
    try { return base32Decode(s).length >= 5; } catch (_) { return false; }
  }

  // ───── HOTP / TOTP ─────
  async function hotp(secret, counter, opts = {}) {
    const algorithm = opts.algorithm || 'SHA1';
    const digits = opts.digits || 6;
    const keyBytes = typeof secret === 'string' ? base32Decode(secret) : secret;
    const key = await subtle().importKey('raw', keyBytes, { name: 'HMAC', hash: ALGOS[algorithm] || 'SHA-1' }, false, ['sign']);
    const msg = new Uint8Array(8);
    let c = BigInt(counter);
    for (let i = 7; i >= 0; i--) { msg[i] = Number(c & 0xffn); c >>= 8n; }
    const mac = new Uint8Array(await subtle().sign('HMAC', key, msg));
    const off = mac[mac.length - 1] & 0x0f;
    const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
    return String(bin % 10 ** digits).padStart(digits, '0');
  }

  function totpCounter(period = 30, now = Date.now()) {
    return Math.floor(now / 1000 / period);
  }

  function secondsLeft(period = 30, now = Date.now()) {
    const t = now / 1000;
    return period - (t % period);
  }

  async function codeFor(entry, now = Date.now()) {
    const opts = { algorithm: entry.algorithm, digits: entry.digits };
    if (entry.type === 'hotp') return hotp(entry.secret, entry.counter || 0, opts);
    return hotp(entry.secret, totpCounter(entry.period || 30, now), opts);
  }

  // ───── wpis ─────
  function makeEntry(fields) {
    const algorithm = String(fields.algorithm || 'SHA1').toUpperCase().replace('-', '');
    const digits = Number(fields.digits) || 6;
    const period = Number(fields.period) || 30;
    const type = String(fields.type || 'totp').toLowerCase() === 'hotp' ? 'hotp' : 'totp';
    const secret = normalizeSecret(fields.secret);
    if (!isValidSecret(secret)) throw new Error('Klucz jest nieprawidłowy albo za krótki.');
    if (!ALGOS[algorithm]) throw new Error(`Nieobsługiwany algorytm: ${algorithm}.`);
    if (![6, 7, 8].includes(digits)) throw new Error('Liczba cyfr musi wynosić 6, 7 albo 8.');
    if (period < 5 || period > 600) throw new Error('Okres musi mieścić się w zakresie 5–600 s.');
    return {
      id: fields.id || randomId(),
      type,
      issuer: String(fields.issuer || '').trim(),
      account: String(fields.account || '').trim(),
      secret,
      algorithm,
      digits,
      period,
      counter: type === 'hotp' ? Math.max(0, parseInt(fields.counter, 10) || 0) : 0,
      createdAt: fields.createdAt || new Date().toISOString()
    };
  }

  function randomId() {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(9));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function sameAccount(a, b) {
    return normalizeSecret(a.secret) === normalizeSecret(b.secret) && a.type === b.type;
  }

  // ───── otpauth:// ─────
  function safeDecode(s) {
    try { return decodeURIComponent(s.replace(/\+/g, '%20')); } catch (_) { return s; }
  }

  function parseOtpauth(uri) {
    const text = String(uri || '').trim();
    const m = /^otpauth:\/\/([a-z]+)\/([^?]*)(?:\?(.*))?$/i.exec(text);
    if (!m) throw new Error('To nie jest adres otpauth://.');
    const type = m[1].toLowerCase();
    if (type !== 'totp' && type !== 'hotp') throw new Error(`Nieobsługiwany typ kodu: ${type}.`);
    const label = safeDecode(m[2]);
    const params = {};
    for (const part of (m[3] || '').split('&')) {
      if (!part) continue;
      const i = part.indexOf('=');
      const k = (i < 0 ? part : part.slice(0, i)).toLowerCase();
      params[k] = safeDecode(i < 0 ? '' : part.slice(i + 1));
    }
    let issuer = params.issuer || '';
    let account = label;
    const colon = label.indexOf(':');
    if (colon >= 0) {
      const prefix = label.slice(0, colon).trim();
      account = label.slice(colon + 1).trim();
      if (!issuer) issuer = prefix;
    }
    if (!params.secret) throw new Error('W kodzie brakuje klucza (secret).');
    return makeEntry({
      type, issuer, account,
      secret: params.secret,
      algorithm: params.algorithm || 'SHA1',
      digits: params.digits || 6,
      period: params.period || 30,
      counter: params.counter || 0
    });
  }

  function toOtpauth(e) {
    const label = encodeURIComponent(e.issuer ? `${e.issuer}:${e.account}` : e.account || 'konto');
    const q = [`secret=${e.secret}`];
    if (e.issuer) q.push(`issuer=${encodeURIComponent(e.issuer)}`);
    if (e.algorithm && e.algorithm !== 'SHA1') q.push(`algorithm=${e.algorithm}`);
    if (e.digits && e.digits !== 6) q.push(`digits=${e.digits}`);
    if (e.type === 'hotp') q.push(`counter=${e.counter || 0}`);
    else if (e.period && e.period !== 30) q.push(`period=${e.period}`);
    return `otpauth://${e.type}/${label}?${q.join('&')}`;
  }

  // ───── Google Authenticator: otpauth-migration://offline?data=… (protobuf) ─────
  function b64ToBytes(b64) {
    const s = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  function readProto(bytes) {
    // zwraca listę pól: { no, wire, value }
    const fields = [];
    let i = 0;
    const varint = () => {
      let r = 0n, shift = 0n, b;
      do {
        if (i >= bytes.length) throw new Error('Uszkodzone dane eksportu.');
        b = bytes[i++];
        r |= BigInt(b & 0x7f) << shift;
        shift += 7n;
      } while (b & 0x80);
      return r;
    };
    while (i < bytes.length) {
      const key = Number(varint());
      const no = key >>> 3, wire = key & 7;
      if (wire === 0) fields.push({ no, wire, value: varint() });
      else if (wire === 2) {
        const len = Number(varint());
        if (i + len > bytes.length) throw new Error('Uszkodzone dane eksportu.');
        fields.push({ no, wire, value: bytes.slice(i, i + len) });
        i += len;
      } else if (wire === 5) { i += 4; } else if (wire === 1) { i += 8; } else throw new Error('Nieznany format danych eksportu.');
    }
    return fields;
  }

  const utf8 = (b) => new TextDecoder().decode(b);

  function parseMigration(uri) {
    const m = /^otpauth-migration:\/\/offline\?(.*)$/i.exec(String(uri || '').trim());
    if (!m) throw new Error('To nie jest kod eksportu z Google Authenticatora.');
    const dataParam = m[1].split('&').find((p) => p.toLowerCase().startsWith('data='));
    if (!dataParam) throw new Error('Brak danych w kodzie eksportu.');
    const payload = readProto(b64ToBytes(safeDecode(dataParam.slice(5))));
    const out = [];
    let batch = null;
    for (const f of payload) {
      if (f.no === 4 && f.wire === 0) batch = { ...(batch || {}), index: Number(f.value) };
      if (f.no === 3 && f.wire === 0) batch = { ...(batch || {}), size: Number(f.value) };
      if (f.no !== 1 || f.wire !== 2) continue;
      const p = {};
      for (const g of readProto(f.value)) p[g.no] = g.value;
      const algo = { 2: 'SHA256', 3: 'SHA512' }[Number(p[4] || 0)] || 'SHA1';
      if (Number(p[4] || 0) === 4) continue; // MD5 – nieobsługiwane
      const digits = Number(p[5] || 0) === 2 ? 8 : 6;
      const type = Number(p[6] || 0) === 1 ? 'hotp' : 'totp';
      let name = p[2] ? utf8(p[2]) : '';
      let issuer = p[3] ? utf8(p[3]) : '';
      const c = name.indexOf(':');
      if (c >= 0) { if (!issuer) issuer = name.slice(0, c).trim(); name = name.slice(c + 1).trim(); }
      out.push(makeEntry({
        type, issuer, account: name,
        secret: base32Encode(p[1] || new Uint8Array()),
        algorithm: algo, digits, period: 30,
        counter: p[7] != null ? Number(p[7]) : 0
      }));
    }
    return { entries: out, batch };
  }

  // ───── eksport do Google Authenticatora (otpauth-migration://) ─────
  function pbVarint(n) {
    const out = [];
    let v = BigInt(n);
    do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
    return out;
  }
  function pbField(no, value) {
    if (typeof value === 'number' || typeof value === 'bigint') return [...pbVarint((no << 3) | 0), ...pbVarint(value)];
    const bytes = typeof value === 'string' ? [...new TextEncoder().encode(value)] : [...value];
    return [...pbVarint((no << 3) | 2), ...pbVarint(bytes.length), ...bytes];
  }
  function bytesToB64(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  // Google Authenticator przyjmuje tylko okres 30 s i 6 albo 8 cyfr
  function migrationProblem(e) {
    if (e.type === 'totp' && (e.period || 30) !== 30) return `okres ${e.period} s – Google Authenticator obsługuje tylko 30 s`;
    if (e.digits === 7) return '7 cyfr – Google Authenticator obsługuje 6 lub 8';
    return null;
  }

  function encodeMigration(entries, batch = {}) {
    const params = entries.map((e) => {
      const p = [
        ...pbField(1, base32Decode(e.secret)),
        ...pbField(2, e.account || e.issuer || 'konto'),
        ...(e.issuer ? pbField(3, e.issuer) : []),
        ...pbField(4, { SHA1: 1, SHA256: 2, SHA512: 3 }[e.algorithm] || 1),
        ...pbField(5, e.digits === 8 ? 2 : 1),
        ...pbField(6, e.type === 'hotp' ? 1 : 2)
      ];
      if (e.type === 'hotp') p.push(...pbField(7, e.counter || 0));
      return pbField(1, p);
    });
    const payload = [
      ...params.flat(),
      ...pbField(2, 1),
      ...pbField(3, batch.size || 1),
      ...pbField(4, batch.index || 0),
      ...pbField(5, batch.id || 0)
    ];
    return 'otpauth-migration://offline?data=' + encodeURIComponent(bytesToB64(payload));
  }

  // Dzieli konta na kody QR o rozsądnej wielkości (łatwe do zeskanowania z ekranu)
  function migrationBatches(entries, maxLen = 550) {
    const groups = [];
    let cur = [];
    for (const e of entries) {
      if (cur.length && encodeMigration([...cur, e]).length > maxLen) { groups.push(cur); cur = []; }
      cur.push(e);
    }
    if (cur.length) groups.push(cur);
    const id = (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff) || 1;
    return groups.map((g, i) => ({ entries: g, uri: encodeMigration(g, { size: groups.length, index: i, id }) }));
  }

  // Rozpoznaje dowolny tekst: otpauth://, otpauth-migration:// albo wiele linii.
  function parseAny(text) {
    const lines = String(text || '').split(/\s+/).map((l) => l.trim()).filter(Boolean);
    const entries = [];
    const errors = [];
    let batch = null;
    for (const l of lines) {
      try {
        if (/^otpauth-migration:/i.test(l)) { const r = parseMigration(l); entries.push(...r.entries); batch = r.batch; }
        else if (/^otpauth:/i.test(l)) entries.push(parseOtpauth(l));
      } catch (e) { errors.push(e.message); }
    }
    return { entries, errors, batch };
  }

  function formatCode(code) {
    if (code.length === 6) return code.slice(0, 3) + ' ' + code.slice(3);
    if (code.length === 8) return code.slice(0, 4) + ' ' + code.slice(4);
    if (code.length === 7) return code.slice(0, 3) + ' ' + code.slice(3);
    return code;
  }

  return {
    normalizeSecret, base32Decode, base32Encode, isValidSecret,
    hotp, totpCounter, secondsLeft, codeFor, makeEntry, sameAccount, randomId,
    parseOtpauth, toOtpauth, parseMigration, parseAny, formatCode,
    encodeMigration, migrationBatches, migrationProblem
  };
});
