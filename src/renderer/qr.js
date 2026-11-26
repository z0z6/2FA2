'use strict';
// Odczyt kodów QR: z aparatu (na żywo), z obrazu (plik/schowek) i ze zrzutu ekranu.

(function () {
  const { h, iconEl, pushLayer, dropLayer } = window.UI;

  function decodeCanvas(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    return r ? r.data : null;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Nie udało się wczytać obrazu.'));
      img.src = src;
    });
  }

  // Próbuje kilku skal: małe kody na dużych zrzutach wymagają pełnej rozdzielczości,
  // zdjęcia z telefonu dekodują się szybciej i pewniej po zmniejszeniu.
  async function decodeImageSource(src) {
    const img = await loadImage(src);
    const w = img.naturalWidth, hgt = img.naturalHeight;
    const scales = [1, 1600 / Math.max(w, hgt), 800 / Math.max(w, hgt)].filter((s, i, a) => s <= 1 && a.indexOf(s) === i);
    if (!scales.length) scales.push(1);
    for (const s of scales) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * s));
      c.height = Math.max(1, Math.round(hgt * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const text = decodeCanvas(c);
      if (text) return text;
      await new Promise((r) => setTimeout(r, 0));
    }
    return null;
  }

  async function decodeBlob(blob) {
    const url = URL.createObjectURL(blob);
    try { return await decodeImageSource(url); } finally { URL.revokeObjectURL(url); }
  }

  // Pełnoekranowy skaner z aparatu. Zwraca odczytany tekst albo null (anulowano).
  function scanCamera() {
    return new Promise((resolve) => {
      let stream = null, timer = null, done = false;
      const video = h('video', { class: 'scan-video', playsinline: true, autoplay: true, muted: true });
      const status = h('p', { class: 'scan-hint' }, 'Uruchamiam aparat…');
      const canvas = document.createElement('canvas');
      const finish = (value, fromBack) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (stream) stream.getTracks().forEach((t) => t.stop());
        dropLayer(close, fromBack === true);
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 200);
        resolve(value);
      };
      const close = (fromBack) => finish(null, fromBack);
      const overlay = h('div', { class: 'scanner' },
        video,
        h('div', { class: 'scan-frame' }, h('span', { class: 'c tl' }), h('span', { class: 'c tr' }), h('span', { class: 'c bl' }), h('span', { class: 'c br' })),
        h('div', { class: 'scan-top' }, h('button', { class: 'scan-close', type: 'button', onclick: () => close(), html: window.icon('x', 18) })),
        h('div', { class: 'scan-bottom' }, h('h3', null, 'Zeskanuj kod QR'), status));
      document.body.appendChild(overlay);
      pushLayer(close);
      requestAnimationFrame(() => overlay.classList.add('show'));

      const tick = () => {
        if (done) return;
        if (video.readyState >= 2 && video.videoWidth) {
          const s = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * s);
          canvas.height = Math.round(video.videoHeight * s);
          canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, canvas.width, canvas.height);
          const text = decodeCanvas(canvas);
          if (text) { if (navigator.vibrate) navigator.vibrate(40); finish(text); return; }
        }
        timer = setTimeout(tick, 160);
      };

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        status.textContent = 'To urządzenie nie udostępnia aparatu.';
        return;
      }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
        .then((s) => {
          if (done) { s.getTracks().forEach((t) => t.stop()); return; }
          stream = s;
          video.srcObject = s;
          video.play().catch(() => {});
          status.textContent = 'Ustaw kod QR w ramce – odczyt nastąpi automatycznie.';
          tick();
        })
        .catch((err) => {
          status.textContent = err && err.name === 'NotAllowedError'
            ? 'Brak zgody na użycie aparatu. Zezwól na dostęp w ustawieniach systemu.'
            : 'Nie znaleziono aparatu. Użyj innej metody dodawania.';
        });
    });
  }

  // Wybór pliku (obraz, kopia .json, lista .txt)
  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', accept, style: { display: 'none' } });
      input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
      input.addEventListener('cancel', () => { resolve(null); input.remove(); });
      document.body.appendChild(input);
      input.click();
    });
  }

  // Rysuje kod QR jako SVG (zawsze czarne na białym – tak skanuje każdy aparat, także w trybie ciemnym)
  function render(text, ecc = 'M') {
    const qr = window.qrcode(0, ecc);
    qr.addData(text, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const q = 4;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
    }
    const size = n + 2 * q;
    const wrap = h('div', { class: 'qr-code', role: 'img', 'aria-label': 'Kod QR' });
    wrap.innerHTML = `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
    return wrap;
  }

  window.QR = { decodeImageSource, decodeBlob, scanCamera, pickFile, render, iconEl };
})();
