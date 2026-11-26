# 2FA

Autorska aplikacja do kodów weryfikacji dwuetapowej (jak Google Authenticator) na **Windows**, **Linuksa** i **Androida**.
Jeden wspólny interfejs (HTML/JS, wygląd w stylu iOS, po polsku) uruchamiany w Electronie (Windows, Linux) i w Capacitorze (Android).

## Funkcje

- kody **TOTP** (czasowe) i **HOTP** (licznikowe), SHA-1/256/512, 6–8 cyfr, dowolny okres – zgodne z RFC 4226/6238, czyli z każdym serwisem, który obsługuje Google Authenticatora,
- dodawanie kont: **skan kodu QR aparatem**, **wyszukanie kodu QR na ekranie** (Windows – np. kod w przeglądarce), obraz z pliku, wklejenie ze schowka (Ctrl+V), ręczne wpisanie klucza,
- **import z Google Authenticatora** (Przenieś konta → Eksportuj konta → zeskanuj kod QR) – wiele kont naraz,
- **zaszyfrowany sejf**: AES-256-GCM, klucz z hasła głównego przez PBKDF2-SHA256 (600 000 iteracji),
- automatyczna blokada (bezczynność, aplikacja w tle, zablokowanie komputera), opcjonalne odblokowanie kontem Windows (DPAPI),
- ukrywanie kodów, czyszczenie schowka po 30 s, ochrona przed zrzutami ekranu (Windows: ochrona okna, Android: FLAG_SECURE),
- **eksport kodem QR**: pojedyncze konto (dowolna aplikacja 2FA) albo wiele kont naraz w formacie „Przenieś konta” Google Authenticatora,
- **zaszyfrowane kopie zapasowe** (.json) i eksport do innych aplikacji (lista `otpauth://`),
- tryb jasny/ciemny, bez internetu – nic nie jest wysyłane poza urządzenie.

## Pobieranie

Każdy push na `main` buduje w GitHub Actions (zakładka **Actions** → ostatnie uruchomienie → *Artifacts*):

- `2FA-windows-portable` – przenośny `2FA-<wersja>-portable.exe` (dane zapisuje w folderze „2FA - dane” obok pliku .exe),
- `2FA-linux-AppImage` – `2FA-<wersja>-linux-x86_64.AppImage`: nadaj prawo uruchamiania (`chmod +x`) i uruchom; dane trafiają do `~/.config/2FA/dane`,
- `2FA-android-apk` – `2FA-<wersja>-android.apk` do instalacji na telefonie (trzeba zezwolić na instalację z nieznanych źródeł).

Tag `v*` (np. `v1.1.0`) tworzy wydanie (Release) ze wszystkimi trzema plikami.

## Podpis aplikacji na Androida

Bez dodatkowej konfiguracji APK jest podpisywany kluczem testowym z repozytorium (`android/app/debug.keystore`),
dzięki czemu kolejne wersje instalują się jako aktualizacja i nie kasują danych.
Lepiej ustawić własny, tajny klucz – w *Settings → Secrets and variables → Actions* dodaj:

| Sekret | Zawartość |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | plik `.jks` zakodowany base64 (`base64 -w0 release.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | hasło magazynu kluczy |
| `ANDROID_KEY_ALIAS` | alias klucza |
| `ANDROID_KEY_PASSWORD` | hasło klucza |

Klucz utworzysz poleceniem: `keytool -genkeypair -v -keystore release.jks -alias twofa -keyalg RSA -keysize 4096 -validity 10000`.
Uwaga: zmiana klucza wymaga jednorazowego odinstalowania aplikacji – **najpierw zrób kopię zapasową** w Ustawieniach.

## Rozwój

```bash
npm install
npm test            # testy silnika (wektory RFC 4226/6238, import, szyfrowanie)
npm start           # Electron
npm run dist:win    # przenośny .exe (na Windows)
npm run dist:linux  # AppImage (na Linuksie)
npx cap sync android && npx cap open android   # Android Studio
```

Wersję zmieniasz w `package.json` i w `src/renderer/platform.js` (`APP_VERSION`) – test pilnuje zgodności.

### Struktura

| Ścieżka | Zawartość |
|---|---|
| `src/renderer/core/otp.js` | Base32, HOTP/TOTP, `otpauth://`, import `otpauth-migration://` |
| `src/renderer/core/vault.js` | szyfrowanie sejfu i kopii zapasowych (WebCrypto) |
| `src/renderer/platform.js` | warstwa platformy: Electron / Android (Capacitor) / przeglądarka |
| `src/renderer/app.js`, `ui.js`, `qr.js`, `styles.css` | interfejs |
| `src/main/main.js`, `src/preload.js` | Electron: okno, zapis plików, schowek, zrzut ekranu, DPAPI |
| `android/` | projekt Capacitor (FLAG_SECURE, obsługa „Wstecz”, aparat, ikony) |

Biblioteki w `src/renderer/vendor`: [jsQR](https://github.com/cozmo/jsQR) (Apache-2.0), [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT), Capacitor core (MIT); czcionka Inter (OFL).
