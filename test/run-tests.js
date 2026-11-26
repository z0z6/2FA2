'use strict';
// Testy logiki bez Electrona: node test/run-tests.js
const assert = require('assert');
const OTP = require('../src/renderer/core/otp.js');
const Vault = require('../src/renderer/core/vault.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const ascii = (s) => OTP.base32Encode(new TextEncoder().encode(s));

test('Base32: kodowanie i dekodowanie w obie strony', () => {
  assert.strictEqual(ascii('foobar'), 'MZXW6YTBOI');
  assert.strictEqual(new TextDecoder().decode(OTP.base32Decode('mzxw 6ytb-oi==')), 'foobar');
  assert.throws(() => OTP.base32Decode('ABC1'), /Niedozwolony znak/);
});

test('HOTP: wektory z RFC 4226', async () => {
  const secret = ascii('12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  for (let c = 0; c < expected.length; c++) assert.strictEqual(await OTP.hotp(secret, c), expected[c], 'licznik ' + c);
});

test('TOTP: wektory z RFC 6238 (SHA1/SHA256/SHA512, 8 cyfr)', async () => {
  const seeds = {
    SHA1: ascii('12345678901234567890'),
    SHA256: ascii('12345678901234567890123456789012'),
    SHA512: ascii('1234567890123456789012345678901234567890123456789012345678901234')
  };
  const cases = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826']
  ];
  for (const [t, s1, s256, s512] of cases) {
    const now = t * 1000;
    for (const [algorithm, exp] of [['SHA1', s1], ['SHA256', s256], ['SHA512', s512]]) {
      const code = await OTP.codeFor({ type: 'totp', secret: seeds[algorithm], algorithm, digits: 8, period: 30 }, now);
      assert.strictEqual(code, exp, `${algorithm} @ ${t}`);
    }
  }
});

test('otpauth://: odczyt etykiety, wydawcy i parametrów', () => {
  const e = OTP.parseOtpauth('otpauth://totp/ACME%20Co:jan@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60');
  assert.strictEqual(e.issuer, 'ACME Co');
  assert.strictEqual(e.account, 'jan@example.com');
  assert.strictEqual(e.algorithm, 'SHA256');
  assert.strictEqual(e.digits, 8);
  assert.strictEqual(e.period, 60);
  const h = OTP.parseOtpauth('otpauth://hotp/Serwis?secret=JBSWY3DPEHPK3PXP&counter=7');
  assert.strictEqual(h.type, 'hotp');
  assert.strictEqual(h.counter, 7);
  assert.strictEqual(h.account, 'Serwis');
  assert.throws(() => OTP.parseOtpauth('otpauth://totp/x?issuer=a'), /brakuje klucza/);
  assert.throws(() => OTP.parseOtpauth('https://example.com'), /otpauth/);
});

test('otpauth://: zapis i ponowny odczyt daje ten sam wpis', () => {
  const e = OTP.makeEntry({ issuer: 'Bank Ś', account: 'ąę@x.pl', secret: 'JBSWY3DPEHPK3PXP', digits: 8, period: 45 });
  const back = OTP.parseOtpauth(OTP.toOtpauth(e));
  for (const k of ['issuer', 'account', 'secret', 'digits', 'period', 'algorithm', 'type']) assert.strictEqual(back[k], e[k], k);
});

// prosty koder protobuf do zbudowania przykładowego eksportu Google Authenticatora
function varint(n) { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return out; }
function field(no, wire, value) {
  if (wire === 0) return [...varint((no << 3) | 0), ...varint(value)];
  const bytes = typeof value === 'string' ? [...new TextEncoder().encode(value)] : [...value];
  return [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes];
}

test('otpauth-migration://: import z Google Authenticatora', () => {
  const secret = OTP.base32Decode('JBSWY3DPEHPK3PXP');
  const p1 = [...field(1, 2, secret), ...field(2, 2, 'Google:jan@gmail.com'), ...field(3, 2, 'Google'), ...field(4, 0, 1), ...field(5, 0, 1), ...field(6, 0, 2)];
  const p2 = [...field(1, 2, secret), ...field(2, 2, 'licznik'), ...field(4, 0, 2), ...field(5, 0, 2), ...field(6, 0, 1), ...field(7, 0, 5)];
  const payload = [...field(1, 2, p1), ...field(1, 2, p2), ...field(2, 0, 1), ...field(3, 0, 1), ...field(4, 0, 0)];
  const data = encodeURIComponent(Buffer.from(payload).toString('base64'));
  const { entries, batch } = OTP.parseMigration('otpauth-migration://offline?data=' + data);
  assert.strictEqual(entries.length, 2);
  assert.deepStrictEqual([entries[0].issuer, entries[0].account, entries[0].type, entries[0].digits], ['Google', 'jan@gmail.com', 'totp', 6]);
  assert.strictEqual(entries[0].secret, 'JBSWY3DPEHPK3PXP');
  assert.deepStrictEqual([entries[1].type, entries[1].algorithm, entries[1].digits, entries[1].counter], ['hotp', 'SHA256', 8, 5]);
  assert.deepStrictEqual(batch, { size: 1, index: 0 });
});

test('Eksport do Google Authenticatora: zapis i odczyt otpauth-migration://', () => {
  const list = [
    OTP.makeEntry({ issuer: 'Google', account: 'jan@gmail.com', secret: 'JBSWY3DPEHPK3PXP' }),
    OTP.makeEntry({ issuer: 'Bank Śląski', account: 'Łukasz', secret: 'GEZDGNBVGY3TQOJQ', digits: 8, algorithm: 'SHA256' }),
    OTP.makeEntry({ issuer: '', account: 'serwer', secret: 'MFRGGZDFMZTWQ2LK', type: 'hotp', counter: 42 })
  ];
  const uri = OTP.encodeMigration(list, { size: 1, index: 0, id: 7 });
  const { entries, batch } = OTP.parseMigration(uri);
  assert.deepStrictEqual(batch, { size: 1, index: 0 });
  for (let i = 0; i < list.length; i++) {
    for (const k of ['issuer', 'account', 'secret', 'digits', 'algorithm', 'type', 'counter']) assert.strictEqual(entries[i][k], list[i][k], `${i}.${k}`);
  }
  // wiele kont dzieli się na kilka kodów QR, a każdy da się odczytać
  const many = Array.from({ length: 25 }, (_, i) => OTP.makeEntry({ issuer: 'Serwis ' + i, account: `uzytkownik${i}@example.com`, secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' }));
  const batches = OTP.migrationBatches(many);
  assert.ok(batches.length > 1);
  let total = 0;
  batches.forEach((b, i) => {
    assert.ok(b.uri.length <= 700 || b.entries.length === 1);
    const r = OTP.parseMigration(b.uri);
    assert.deepStrictEqual(r.batch, { size: batches.length, index: i });
    total += r.entries.length;
  });
  assert.strictEqual(total, 25);
  assert.ok(OTP.migrationProblem(OTP.makeEntry({ secret: 'JBSWY3DPEHPK3PXP', period: 60 })));
  assert.strictEqual(OTP.migrationProblem(list[0]), null);
});

test('Generator kodów QR (biblioteka) koduje adres otpauth', () => {
  const qrcode = require('../src/renderer/vendor/qrcode-generator.js');
  const qr = qrcode(0, 'M');
  qr.addData(OTP.encodeMigration([OTP.makeEntry({ issuer: 'X', secret: 'JBSWY3DPEHPK3PXP' })]));
  qr.make();
  assert.ok(qr.getModuleCount() >= 21);
});

test('parseAny: wiele adresów w jednym tekście, błędne pomijane', () => {
  const r = OTP.parseAny('otpauth://totp/A?secret=JBSWY3DPEHPK3PXP\n\notpauth://totp/B?secret=XYZ1\nzwykły tekst');
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.errors.length, 1);
});

test('Walidacja wpisu', () => {
  assert.throws(() => OTP.makeEntry({ secret: 'AB' }), /nieprawidłowy/);
  assert.throws(() => OTP.makeEntry({ secret: 'JBSWY3DPEHPK3PXP', digits: 4 }), /cyfr/);
  assert.throws(() => OTP.makeEntry({ secret: 'JBSWY3DPEHPK3PXP', algorithm: 'MD5' }), /algorytm/);
  assert.strictEqual(OTP.formatCode('123456'), '123 456');
  assert.strictEqual(OTP.formatCode('12345678'), '1234 5678');
});

test('Sejf: utworzenie, odblokowanie, złe hasło, zmiana hasła', async () => {
  const payload = { entries: [OTP.makeEntry({ issuer: 'X', secret: 'JBSWY3DPEHPK3PXP' })] };
  const { file, dek } = await Vault.create('tajne hasło', payload);
  assert.ok(!JSON.stringify(file).includes('JBSWY3DPEHPK3PXP'), 'klucz nie może być jawny w pliku');
  const dek2 = await Vault.unlock(file, 'tajne hasło');
  assert.deepStrictEqual(await Vault.open(file, dek2), payload);
  await assert.rejects(() => Vault.unlock(file, 'złe'), /Nieprawidłowe hasło/);
  const changed = await Vault.changePassword(file, dek, 'nowe hasło');
  await assert.rejects(() => Vault.unlock(changed, 'tajne hasło'), /Nieprawidłowe hasło/);
  assert.deepStrictEqual(await Vault.open(changed, await Vault.unlock(changed, 'nowe hasło')), payload);
  // automatyczne odblokowanie: eksport/import klucza danych
  const restored = await Vault.importDek(await Vault.exportDek(dek));
  const resealed = await Vault.seal(file, dek, { entries: [] });
  assert.deepStrictEqual(await Vault.open(resealed, restored), { entries: [] });
});

test('Kopia zapasowa: zapis i odczyt', async () => {
  const payload = { entries: [OTP.makeEntry({ issuer: 'Y', secret: 'JBSWY3DPEHPK3PXP' })] };
  const backup = await Vault.makeBackup(payload, 'kopia123');
  assert.strictEqual(backup.format, '2fa-backup');
  const read = await Vault.readBackup(JSON.parse(JSON.stringify(backup)), 'kopia123');
  assert.deepStrictEqual(read.entries, payload.entries);
  await assert.rejects(() => Vault.readBackup(backup, 'x'), /Nieprawidłowe hasło/);
});

test('Wersja w aplikacji zgodna z package.json', () => {
  const v = require('../package.json').version;
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/renderer/platform.js'), 'utf8');
  assert.ok(src.includes(`APP_VERSION = '${v}'`), 'zaktualizuj APP_VERSION w src/renderer/platform.js');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('  ✓', t.name); } catch (e) { failed++; console.log('  ✗', t.name, '\n    ', e.message); }
  }
  console.log(failed ? `\n${failed} z ${tests.length} testów nie przeszło` : `\nWszystkie testy (${tests.length}) przeszły`);
  process.exit(failed ? 1 : 0);
})();
