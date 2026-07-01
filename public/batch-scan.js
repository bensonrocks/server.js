// public/batch-scan.js
// Batch Camera Scan — standalone module for IDEALSCAN
//
// Provides a full-screen overlay with a live camera viewfinder that
// continuously reads barcodes, deduplicates them, and collects up to
// MAX_ITEMS unique values in a numbered list before submitting them
// all at once via a caller-supplied callback.
//
// Debounce behaviour:
//   • A barcode already in the list is never re-added (O(1) Set lookup).
//   • After a manual remove the same value is blocked for REMOVAL_COOLDOWN ms
//     so the camera cannot instantly re-add it while it's still in frame.
//   • Multiple barcodes visible simultaneously are all captured in one frame
//     via BarcodeDetector's native multi-result API.
//
// Usage (from app.js or any script):
//   BatchScan.open(values => {
//     values.forEach(val => handleItemScan(val));   // or any batch action
//   });
//   BatchScan.close();   // programmatic close (e.g. from parent close handler)

'use strict';

window.BatchScan = (() => {
  // ── Configuration ───────────────────────────────────────────────────────────
  const MAX_ITEMS        = 10;
  const REMOVAL_COOLDOWN = 3000;   // ms before a removed item can be re-scanned

  // ── Private state ───────────────────────────────────────────────────────────
  let _stream    = null;
  let _raf       = null;
  let _detector  = null;
  let _items     = [];             // ordered array of unique barcode strings
  let _itemsSet  = new Set();      // O(1) duplicate check
  let _removedAt = new Map();      // val → timestamp of manual removal
  let _onSubmit  = null;
  let _ready     = false;          // HTML injected into DOM yet?

  // ── DOM bootstrap (injected once on first open()) ───────────────────────────

  function _bootstrap() {
    if (_ready) return;
    _ready = true;

    const el = document.createElement('div');
    el.id        = 'batchScanOverlay';
    el.className = 'bs-overlay hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Batch Scan Mode');

    el.innerHTML = `
      <div class="bs-header">
        <div class="bs-header-left">
          <!-- Barcode icon -->
          <svg class="bs-hdr-icon" viewBox="0 0 22 22" fill="none" aria-hidden="true">
            <rect x="1"  y="3" width="2"   height="16" rx=".6" fill="currentColor"/>
            <rect x="5"  y="3" width="3"   height="16" rx=".6" fill="currentColor"/>
            <rect x="10" y="3" width="1.5" height="16" rx=".6" fill="currentColor"/>
            <rect x="13" y="3" width="2.5" height="16" rx=".6" fill="currentColor"/>
            <rect x="17" y="3" width="2"   height="16" rx=".6" fill="currentColor"/>
            <rect x="0"  y="9.5" width="22" height="3" rx="1.5" fill="#22c55e"/>
          </svg>
          <span class="bs-hdr-title">Batch Scan</span>
        </div>
        <div class="bs-header-right">
          <div class="bs-badge" id="bsBadge">0 / ${MAX_ITEMS}</div>
          <button class="bs-close-btn" id="bsCloseBtn">&#10005; Cancel</button>
        </div>
      </div>

      <div class="bs-viewfinder" id="bsViewfinder">
        <video id="bsVideo" autoplay playsinline muted></video>
        <div class="bs-aim" aria-hidden="true">
          <div class="bs-corner bs-tl"></div>
          <div class="bs-corner bs-tr"></div>
          <div class="bs-corner bs-bl"></div>
          <div class="bs-corner bs-br"></div>
          <div class="bs-scan-line"></div>
        </div>
        <div id="bsFlash"  class="bs-flash  hidden"></div>
        <div id="bsCapMsg" class="bs-cap-msg hidden">Max ${MAX_ITEMS} items &mdash; remove some to continue scanning</div>
      </div>

      <div class="bs-panel">
        <div class="bs-panel-hdr">
          <span class="bs-panel-label">
            Scanned Items
            <span class="bs-count-pill" id="bsCountPill">0</span>
          </span>
          <button class="bs-link-btn" id="bsClearBtn">Clear all</button>
        </div>
        <div id="bsList" class="bs-list">
          <p class="bs-empty-hint">Point the camera at barcodes &mdash; they appear here automatically</p>
        </div>
      </div>

      <div class="bs-footer">
        <span class="bs-footer-note" id="bsFooterNote">0 items ready</span>
        <button class="bs-submit-btn" id="bsSubmitBtn" disabled>Submit All &#8594;</button>
      </div>`;

    document.body.appendChild(el);

    document.getElementById('bsCloseBtn').addEventListener('click',  _close);
    document.getElementById('bsClearBtn').addEventListener('click',  _clearAll);
    document.getElementById('bsSubmitBtn').addEventListener('click', _submitAll);
  }

  // ── Camera ──────────────────────────────────────────────────────────────────

  async function _startCamera() {
    const viewfinder = document.getElementById('bsViewfinder');

    if (!('BarcodeDetector' in window)) {
      viewfinder.innerHTML = _noSupportHTML('Camera barcode scanning is not available on this device.',
        'Requires Chrome or Edge on Android. Use a physical scanner or the manual input field instead.');
      return;
    }

    try {
      if (!_detector) {
        let fmts;
        try   { fmts = await BarcodeDetector.getSupportedFormats(); }
        catch { fmts = ['code_128','ean_13','ean_8','qr_code','upc_a','upc_e','code_39','itf','data_matrix']; }
        _detector = new BarcodeDetector({ formats: fmts });
      }

      _stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      });

      const video = document.getElementById('bsVideo');
      video.srcObject = _stream;
      await new Promise(resolve => { video.onloadedmetadata = resolve; });
      await video.play();
      _loop();
    } catch (err) {
      document.getElementById('bsViewfinder').innerHTML =
        _noSupportHTML('Camera error', _esc(err.message));
    }
  }

  function _stopCamera() {
    if (_raf)    { cancelAnimationFrame(_raf); _raf = null; }
    if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  }

  async function _loop() {
    if (!_stream) return;
    const video = document.getElementById('bsVideo');
    try {
      if (video && video.readyState >= 2) {
        // BarcodeDetector returns ALL barcodes visible in the current frame —
        // this is the native multi-barcode detection path.
        const barcodes = await _detector.detect(video);
        for (const bc of barcodes) {
          const val = (bc.rawValue || '').trim();
          if (val) _onBarcode(val);
        }
      }
    } catch { /* detection errors are transient — keep looping */ }
    _raf = requestAnimationFrame(_loop);
  }

  function _noSupportHTML(title, detail) {
    return `<div class="bs-nosupport">
      <div class="bs-nosupport-icon">&#128483;</div>
      <p><strong>${title}</strong></p>
      <p class="hint">${detail}</p>
    </div>`;
  }

  // ── Item management ─────────────────────────────────────────────────────────

  function _onBarcode(val) {
    // 1. Already captured → skip (this is the main debounce — once in the Set
    //    the camera will never re-add the same value no matter how many frames
    //    the barcode stays visible).
    if (_itemsSet.has(val)) return;

    // 2. At the item cap → show the hint and skip.
    if (_items.length >= MAX_ITEMS) {
      document.getElementById('bsCapMsg').classList.remove('hidden');
      return;
    }

    // 3. Removal cooldown — prevents the camera from instantly re-adding a value
    //    the user just removed while it is still in the viewfinder.
    const removedTs = _removedAt.get(val);
    if (removedTs && Date.now() - removedTs < REMOVAL_COOLDOWN) return;

    _items.push(val);
    _itemsSet.add(val);
    _renderList();
    _showFlash(val);
  }

  function _removeItem(val) {
    _items = _items.filter(v => v !== val);
    _itemsSet.delete(val);
    _removedAt.set(val, Date.now());
    document.getElementById('bsCapMsg').classList.add('hidden');
    _renderList();
  }

  function _clearAll() {
    _items = [];
    _itemsSet.clear();
    // No per-value cooldown on clear-all — user explicitly wants a fresh start.
    document.getElementById('bsCapMsg').classList.add('hidden');
    _renderList();
  }

  function _showFlash(val) {
    const el = document.getElementById('bsFlash');
    el.innerHTML = `<span class="bs-flash-tick">&#10003;</span> ${_esc(val)}`;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 1600);
  }

  // ── List rendering ──────────────────────────────────────────────────────────

  function _renderList() {
    const n         = _items.length;
    const listEl    = document.getElementById('bsList');
    const submitBtn = document.getElementById('bsSubmitBtn');

    // Header counts
    const badgeEl = document.getElementById('bsBadge');
    const pillEl  = document.getElementById('bsCountPill');
    const noteEl  = document.getElementById('bsFooterNote');
    if (badgeEl)   badgeEl.textContent = `${n} / ${MAX_ITEMS}`;
    if (pillEl)    pillEl.textContent  = n;
    if (noteEl)    noteEl.textContent  = n === 0 ? '0 items ready'
                                       : n === 1 ? '1 item ready to submit'
                                       : `${n} items ready to submit`;
    if (submitBtn) submitBtn.disabled  = n === 0;

    if (!n) {
      listEl.innerHTML = '<p class="bs-empty-hint">Point the camera at barcodes &mdash; they appear here automatically</p>';
      return;
    }

    listEl.innerHTML = _items.map((val, i) => `
      <div class="bs-item" data-val="${_esc(val)}">
        <span class="bs-item-idx">${i + 1}</span>
        <code  class="bs-item-val">${_esc(val)}</code>
        <button class="bs-item-del" data-val="${_esc(val)}"
                aria-label="Remove ${_esc(val)}" title="Remove">&#10005;</button>
      </div>`).join('');

    listEl.querySelectorAll('.bs-item-del').forEach(btn =>
      btn.addEventListener('click', () => _removeItem(btn.dataset.val))
    );
  }

  // ── Submit ──────────────────────────────────────────────────────────────────

  function _submitAll() {
    if (!_items.length) return;
    const vals = [..._items];  // snapshot before close clears state
    _close();
    if (_onSubmit) _onSubmit(vals);
  }

  // ── Utility ─────────────────────────────────────────────────────────────────

  function _esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Open the batch scan overlay.
   * @param {function(string[]): void} onSubmitCallback
   *   Called with an array of unique scanned barcode strings when the user
   *   taps "Submit All". Called with an empty array if closed without scanning.
   */
  function open(onSubmitCallback) {
    _bootstrap();
    _onSubmit = onSubmitCallback || null;

    // Reset state for this session
    _items = [];
    _itemsSet.clear();
    _removedAt.clear();

    document.getElementById('batchScanOverlay').classList.remove('hidden');
    document.getElementById('bsCapMsg').classList.add('hidden');
    document.body.classList.add('bs-open');
    _renderList();
    _startCamera();
  }

  function _close() {
    _stopCamera();
    const ov = document.getElementById('batchScanOverlay');
    if (ov) ov.classList.add('hidden');
    document.body.classList.remove('bs-open');
  }

  return { open, close: _close };
})();
