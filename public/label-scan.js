// public/label-scan.js — White Label OCR Scanner
//
// Full-screen camera overlay with a fixed targeting frame.
// User aligns a white product label inside the frame, taps Capture,
// and the cropped image is sent to /api/ocr/label for OCR.
//
// Extracts 3-field format from the label:
//   Line 1: SKU        (4–8 digits)
//   Line 2: Batch      (alphanumeric)
//   Line 3: Expiry     (MM/YYYY)
//
// Usage:
//   LabelScan.open(({ sku, batch, expiry }) => handleItemScan(sku));
//   LabelScan.close();

'use strict';

window.LabelScan = (() => {
  // ── State ───────────────────────────────────────────────────────────────────
  let _stream   = null;
  let _onResult = null;
  let _ready    = false;
  let _busy     = false;

  // ── Bootstrap ────────────────────────────────────────────────────────────────
  function _bootstrap() {
    if (_ready) return;
    _ready = true;

    const el = document.createElement('div');
    el.id        = 'labelScanOverlay';
    el.className = 'ls-overlay hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Label OCR Scan');

    el.innerHTML = `
      <div class="ls-header">
        <div class="ls-header-left">
          <svg class="ls-hdr-icon" viewBox="0 0 22 16" fill="none" aria-hidden="true">
            <rect x="0" y="0" width="22" height="16" rx="2.5" stroke="currentColor" stroke-width="1.6" fill="none"/>
            <rect x="2" y="2" width="6" height="3" rx=".5" fill="currentColor" opacity=".55"/>
            <rect x="2" y="6.5" width="8" height="1.5" rx=".5" fill="currentColor" opacity=".55"/>
            <rect x="2" y="9.5" width="5" height="1.5" rx=".5" fill="currentColor" opacity=".55"/>
            <circle cx="17" cy="8" r="3.5" stroke="#22c55e" stroke-width="1.5" fill="none"/>
            <circle cx="17" cy="8" r="1.2" fill="#22c55e"/>
          </svg>
          <span class="ls-hdr-title">Label Scan</span>
        </div>
        <button class="ls-close-btn" id="lsCloseBtn">&#10005; Close</button>
      </div>

      <div class="ls-viewfinder" id="lsViewfinder">
        <video id="lsVideo" autoplay playsinline muted></video>

        <!-- targeting frame — crop area sent to OCR -->
        <div class="ls-aim" id="lsAim">
          <div class="ls-aim-corner ls-aim-tl"></div>
          <div class="ls-aim-corner ls-aim-tr"></div>
          <div class="ls-aim-corner ls-aim-bl"></div>
          <div class="ls-aim-corner ls-aim-br"></div>
          <span class="ls-aim-label">Align white label here</span>
        </div>

        <!-- spinner shown while server OCR runs -->
        <div id="lsCapturing" class="ls-capturing hidden">
          <div class="ls-spinner"></div>
          <span>Reading label&hellip;</span>
        </div>
      </div>

      <div class="ls-capture-bar">
        <p class="ls-hint" id="lsHint">Point camera at the white label and tap Capture</p>
        <button class="ls-capture-btn" id="lsCaptureBtn">&#128247;&nbsp; Capture Label</button>
      </div>

      <div id="lsResult" class="ls-result hidden">
        <div class="ls-result-fields">
          <div class="ls-field">
            <span class="ls-field-lbl">SKU</span>
            <span class="ls-field-val" id="lsSkuVal">&mdash;</span>
          </div>
          <div class="ls-field">
            <span class="ls-field-lbl">Batch</span>
            <span class="ls-field-val" id="lsBatchVal">&mdash;</span>
          </div>
          <div class="ls-field">
            <span class="ls-field-lbl">Expiry</span>
            <span class="ls-field-val" id="lsExpiryVal">&mdash;</span>
          </div>
        </div>
        <div id="lsReview" class="ls-review hidden">&#9888;&#xFE0F; Manual Review Required &mdash; SKU not detected</div>
        <div class="ls-result-btns">
          <button class="ls-retry-btn" id="lsRetryBtn">&#8617; Retry</button>
          <button class="ls-use-btn"   id="lsUseBtn" disabled>&#10003;&nbsp; Use SKU</button>
        </div>
      </div>`;

    document.body.appendChild(el);
    document.getElementById('lsCloseBtn').addEventListener('click',  _close);
    document.getElementById('lsCaptureBtn').addEventListener('click', _captureLabel);
    document.getElementById('lsRetryBtn').addEventListener('click',   _resetResult);
    document.getElementById('lsUseBtn').addEventListener('click',     _useResult);
  }

  // ── Camera ───────────────────────────────────────────────────────────────────
  async function _startCamera() {
    try {
      _stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      const video = document.getElementById('lsVideo');
      video.srcObject = _stream;
      await new Promise(r => { video.onloadedmetadata = r; });
      await video.play();
    } catch (err) {
      _showError(`Camera error: ${err.message}`);
    }
  }

  function _stopCamera() {
    if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  }

  // ── Capture & OCR ────────────────────────────────────────────────────────────
  async function _captureLabel() {
    if (_busy) return;
    _busy = true;

    const video  = document.getElementById('lsVideo');
    const aim    = document.getElementById('lsAim');
    const vfWrap = document.getElementById('lsViewfinder');

    if (!video || video.readyState < 2) {
      _showError('Camera not ready — please wait and try again.');
      _busy = false;
      return;
    }

    // Draw full video frame to offscreen canvas
    const full = document.createElement('canvas');
    full.width  = video.videoWidth;
    full.height = video.videoHeight;
    full.getContext('2d').drawImage(video, 0, 0);

    // Map the aim-box display coordinates → video pixel coordinates
    const vfRect  = vfWrap.getBoundingClientRect();
    const aimRect = aim.getBoundingClientRect();
    const scaleX  = video.videoWidth  / vfRect.width;
    const scaleY  = video.videoHeight / vfRect.height;

    const cx = Math.max(0, Math.round((aimRect.left - vfRect.left) * scaleX));
    const cy = Math.max(0, Math.round((aimRect.top  - vfRect.top)  * scaleY));
    const cw = Math.min(full.width  - cx, Math.round(aimRect.width  * scaleX));
    const ch = Math.min(full.height - cy, Math.round(aimRect.height * scaleY));

    // Crop to aim box
    const cropped = document.createElement('canvas');
    cropped.width  = cw;
    cropped.height = ch;
    cropped.getContext('2d').drawImage(full, cx, cy, cw, ch, 0, 0, cw, ch);

    // Binarise: boosts OCR accuracy on white labels with black text
    _binarise(cropped);

    document.getElementById('lsCaptureBtn').disabled = true;
    document.getElementById('lsCapturing').classList.remove('hidden');

    cropped.toBlob(async blob => {
      const form = new FormData();
      form.append('image', blob, 'label.jpg');
      try {
        const resp = await fetch('/api/ocr/label', {
          method: 'POST',
          headers: { 'x-auth-token': window._authToken || '' },
          body: form,
        });
        const data = await resp.json();
        document.getElementById('lsCapturing').classList.add('hidden');
        _showResult(data);
      } catch (err) {
        document.getElementById('lsCapturing').classList.add('hidden');
        _showError('Network error — please try again.');
      }
    }, 'image/jpeg', 0.92);
  }

  // Adaptive binarisation: converts to grayscale then threshold
  function _binarise(canvas) {
    const ctx  = canvas.getContext('2d');
    const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d    = img.data;
    // Mean brightness
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i+1] + d[i+2]) / 3;
    const mean = sum / (d.length / 4);
    const thresh = mean * 0.65;
    for (let i = 0; i < d.length; i += 4) {
      const v = ((d[i] + d[i+1] + d[i+2]) / 3) > thresh ? 255 : 0;
      d[i] = d[i+1] = d[i+2] = v;
    }
    ctx.putImageData(img, 0, 0);
  }

  // ── Result handling ──────────────────────────────────────────────────────────
  let _lastResult = null;

  function _showResult(data) {
    _lastResult = data;
    document.getElementById('lsCaptureBtn').disabled = false;

    const resultEl = document.getElementById('lsResult');
    resultEl.classList.remove('hidden');
    document.getElementById('lsCapturing').classList.add('hidden');

    document.getElementById('lsSkuVal').textContent    = data.sku    || '—';
    document.getElementById('lsBatchVal').textContent  = data.batch  || '—';
    document.getElementById('lsExpiryVal').textContent = data.expiry || '—';

    const reviewEl = document.getElementById('lsReview');
    const useBtn   = document.getElementById('lsUseBtn');

    if (data.needs_review || !data.sku) {
      reviewEl.classList.remove('hidden');
      useBtn.disabled = true;
    } else {
      reviewEl.classList.add('hidden');
      useBtn.disabled = false;
    }
    _busy = false;
  }

  function _showError(msg) {
    document.getElementById('lsHint').textContent = msg;
    document.getElementById('lsCaptureBtn').disabled = false;
    document.getElementById('lsCapturing').classList.add('hidden');
    _busy = false;
  }

  function _resetResult() {
    document.getElementById('lsResult').classList.add('hidden');
    document.getElementById('lsHint').textContent = 'Point camera at the white label and tap Capture';
    _lastResult = null;
    _busy = false;
  }

  function _useResult() {
    if (!_lastResult || !_lastResult.sku) return;
    const result = { ..._lastResult };
    _close();
    if (_onResult) _onResult(result);
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function open(onResultCallback) {
    _bootstrap();
    _onResult   = onResultCallback || null;
    _lastResult = null;
    _busy       = false;

    const ov = document.getElementById('labelScanOverlay');
    ov.classList.remove('hidden');
    document.body.classList.add('ls-open');

    document.getElementById('lsResult').classList.add('hidden');
    document.getElementById('lsCapturing').classList.add('hidden');
    document.getElementById('lsCaptureBtn').disabled = false;
    document.getElementById('lsHint').textContent = 'Point camera at the white label and tap Capture';

    _startCamera();
  }

  function _close() {
    _stopCamera();
    const ov = document.getElementById('labelScanOverlay');
    if (ov) ov.classList.add('hidden');
    document.body.classList.remove('ls-open');
    _busy = false;
  }

  return { open, close: _close };
})();
