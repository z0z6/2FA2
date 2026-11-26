'use strict';
// Zaszyfrowany sejf: losowy klucz danych (AES-256-GCM) opakowany kluczem z hasła (PBKDF2-SHA256).
// Dzięki temu zmiana hasła i automatyczne odblokowanie nie wymagają ponownego szyfrowania wpisów.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Vault = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const subtle = () => globalThis.crypto.subtle;
  const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ITERATIONS = 600000;

  const toB64 = (bytes) => {
    let s = '';
    const b = new Uint8Array(bytes);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function kekFrom(password, salt, iterations) {
    const base = await subtle().importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function aesEncrypt(key, bytes) {
    const iv = rnd(12);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return { iv: toB64(iv), ct: toB64(ct) };
  }

  async function aesDecrypt(key, box) {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct)));
  }

  const importDekRaw = (raw) => subtle().importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);

  async function wrapDek(dek, password) {
    const salt = rnd(16);
    const kek = await kekFrom(password, salt, ITERATIONS);
    const raw = new Uint8Array(await subtle().exportKey('raw', dek));
    return { kdf: { name: 'PBKDF2-SHA256', iter: ITERATIONS, salt: toB64(salt) }, key: await aesEncrypt(kek, raw) };
  }

  async function create(password, payload, format = '2fa-vault') {
    const dek = await importDekRaw(rnd(32));
    const wrapped = await wrapDek(dek, password);
    const file = { format, v: 1, ...wrapped, data: null, updatedAt: null };
    return { file: await seal(file, dek, payload), dek };
  }

  async function unlock(file, password) {
    if (!file || !file.kdf || !file.key) throw new Error('Plik sejfu jest uszkodzony.');
    const kek = await kekFrom(password, fromB64(file.kdf.salt), file.kdf.iter || ITERATIONS);
    let raw;
    try { raw = await aesDecrypt(kek, file.key); } catch (_) { throw new Error('Nieprawidłowe hasło.'); }
    return importDekRaw(raw);
  }

  async function open(file, dek) {
    if (!file.data) return { entries: [] };
    let bytes;
    try { bytes = await aesDecrypt(dek, file.data); } catch (_) { throw new Error('Nie udało się odszyfrować danych.'); }
    return JSON.parse(dec.decode(bytes));
  }

  async function seal(file, dek, payload) {
    return { ...file, data: await aesEncrypt(dek, enc.encode(JSON.stringify(payload))), updatedAt: new Date().toISOString() };
  }

  async function changePassword(file, dek, newPassword) {
    return { ...file, ...(await wrapDek(dek, newPassword)) };
  }

  const exportDek = async (dek) => toB64(await subtle().exportKey('raw', dek));
  const importDek = (b64) => importDekRaw(fromB64(b64));

  // Kopia zapasowa – samodzielny plik zaszyfrowany osobnym (lub tym samym) hasłem
  async function makeBackup(payload, password) {
    return (await create(password, { ...payload, exportedAt: new Date().toISOString() }, '2fa-backup')).file;
  }

  async function readBackup(file, password) {
    if (!file || (file.format !== '2fa-backup' && file.format !== '2fa-vault')) throw new Error('To nie jest kopia zapasowa tej aplikacji.');
    const dek = await unlock(file, password);
    return open(file, dek);
  }

  function isVaultFile(obj) {
    return !!obj && (obj.format === '2fa-vault' || obj.format === '2fa-backup') && !!obj.kdf && !!obj.key;
  }

  return { create, unlock, open, seal, changePassword, exportDek, importDek, makeBackup, readBackup, isVaultFile, ITERATIONS };
});
