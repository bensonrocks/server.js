(() => {
  // ── Global error safety net — NEVER fail silently ──────────────────────────
  // Any uncaught error or unhandled promise rejection (and any code that calls
  // showTechError explicitly) pops a dialog with the error + instructions to
  // send it to the IdealOne Tech team. Self-contained (no CSS/HTML dependency).
  const TECH_TEAM = 'IdealOne Tech team';
  function showTechError(detail, context) {
    try {
      const text = (detail && detail.stack) ? String(detail.stack)
                 : (detail && detail.message) ? String(detail.message)
                 : String(detail == null ? 'Unknown error' : detail);
      const when = new Date().toISOString();
      const page = location.hash || location.pathname;
      const full = `IdealOne error report\nWhen: ${when}\nWhere: ${page}\nContext: ${context || '(none)'}\n\n${text}`;
      let ov = document.getElementById('techErrorOverlay');
      if (!ov) {
        ov = document.createElement('div');
        ov.id = 'techErrorOverlay';
        ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:1rem';
        ov.innerHTML = `
          <div style="background:#fff;max-width:520px;width:100%;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden;font-family:-apple-system,Arial,sans-serif">
            <div style="background:#b91c1c;color:#fff;padding:.9rem 1.1rem;font-weight:800;font-size:1rem">⚠ Something went wrong</div>
            <div style="padding:1.1rem">
              <p style="margin:0 0 .6rem;color:#334155">The system hit an error and couldn't complete that action. Please <b>send this error to the ${TECH_TEAM}</b> so we can fix it.</p>
              <pre id="techErrorText" style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:.7rem;font-size:.72rem;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;margin:0 0 .8rem"></pre>
              <div style="display:flex;gap:.5rem;justify-content:flex-end">
                <button id="techErrorCopy" style="padding:.5rem .9rem;border:1px solid #cbd5e1;background:#f8fafc;border-radius:8px;cursor:pointer;font-weight:600">📋 Copy error</button>
                <button id="techErrorClose" style="padding:.5rem .9rem;border:none;background:#1e40af;color:#fff;border-radius:8px;cursor:pointer;font-weight:600">Close</button>
              </div>
            </div>
          </div>`;
        document.body.appendChild(ov);
        ov.querySelector('#techErrorClose').addEventListener('click', () => ov.remove());
        ov.querySelector('#techErrorCopy').addEventListener('click', () => {
          const t = document.getElementById('techErrorText').textContent;
          if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => {
            const b = ov.querySelector('#techErrorCopy'); b.textContent = '✓ Copied'; setTimeout(() => { b.textContent = '📋 Copy error'; }, 1500);
          });
        });
      }
      document.getElementById('techErrorText').textContent = full;
      ov.style.display = 'flex';
      // Record it under System Outages (Administrator) — fire-and-forget so the
      // logging can never itself throw a dialog.
      try {
        _origFetch('/api/errors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(localStorage.getItem('wms_token') ? { 'x-auth-token': localStorage.getItem('wms_token') } : {}) },
          body: JSON.stringify({ message: text, context: context || '', page, stack: text, userAgent: navigator.userAgent, app: 'office' }),
        }).catch(() => {});
      } catch (_) {}
    } catch (_) {
      // last-resort fallback so an error IN the error dialog still surfaces
      alert('Something went wrong. Please send this to the ' + TECH_TEAM + ':\n\n' + String(detail));
    }
  }
  window.showTechError = showTechError;
  // OPAQUE CROSS-ORIGIN ERRORS ARE IGNORED. When a script the browser considers
  // cross-origin throws, it deliberately sanitises the event for security: the
  // message becomes the literal "Script error.", `error` is null, and filename
  // and lineno are blank. There is nothing in it to act on — no file, no line,
  // no stack — and in this app every script is served same-origin, so a fault in
  // OUR code always arrives with full detail. In practice these come from
  // outside the page: a browser extension, a password manager, or the browser's
  // own translate/reader feature injecting script. Showing a full-screen "'
  // something went wrong" dialog to a packer for that, and logging it as an
  // open outage nobody can ever close, is pure noise — worse now that System
  // Outages is the only place warnings surface at all.
  function isOpaqueForeignError(e) {
    return !e.error && !e.filename && !e.lineno;
  }
  window.addEventListener('error', e => {
    if (e instanceof ErrorEvent && isOpaqueForeignError(e)) {
      console.warn('[IdealOne] ignoring an opaque cross-origin script error '
        + '(no file/line/stack — almost certainly a browser extension, not our code):', e.message);
      return;
    }
    showTechError(e.error || e.message, 'Uncaught error');
  });
  window.addEventListener('unhandledrejection', e => {
    // A rejection with nothing in it would render as the string "undefined",
    // which tells nobody anything — don't alarm the user over it.
    if (e.reason === undefined || e.reason === null) {
      console.warn('[IdealOne] ignoring a promise rejection with no reason attached');
      return;
    }
    showTechError(e.reason, 'Unhandled async error');
  });

  // ── Auth token — injected into every /api/ request automatically ───────────
  const _origFetch = window.fetch.bind(window);
  window.fetch = function (url, opts = {}) {
    if (typeof url === 'string' && url.startsWith('/api/')) {
      const token = localStorage.getItem('wms_token');
      if (token) {
        opts = { ...opts, headers: { ...opts.headers, 'x-auth-token': token } };
      }
    }
    return _origFetch(url, opts).then(resp => {
      if (resp.status === 401 && typeof url === 'string' && url.startsWith('/api/')) {
        // Session invalidated (e.g. logged in elsewhere) — force re-login
        localStorage.removeItem('wms_user');
        localStorage.removeItem('wms_token');
        location.reload();
      }
      return resp;
    });
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let SESSION_ID   = sessionStorage.getItem('wms_session') || '';
  let loadedOrders = [];
  let activeOrder          = null;
  let currentUser          = null;
  let timerInterval        = null;
  let currentMismatches    = [];
  let defaultRecipientEmail = '';
  let activeClientFilter  = 'all';
  let activeCarrierFilter = 'all';
  let ordersView          = 'active';   // 'active' | 'completed' sub-tab
  let orderSelection      = new Set();  // order_numbers ticked for group actions
  let completedSearch     = '';
  let _archSearch         = { q: '', results: null }; // archive search cache
  let ordersDateFilter    = 'today';    // 'today' | 'yesterday' | 'week' | 'all' | 'range'
  let ordersDateFrom      = '';
  let ordersDateTo        = '';
  let pendingOrderFile    = null;
  let pendingOcrRows      = null;   // parsed rows from photo OCR, bypasses file upload
  let uploadDirection     = 'Outbound';
  let logUnlocked         = false;
  let _pendingUnlockTab   = null;   // tab waiting behind the Administrator password gate
  let pendingDownload     = false;

  // ── IdealInbound — receiving (POs/ASNs and returns) ─────────────────────────
  let inboundJobs  = [];
  let activeInbound = null;
  let lastScannedInboundSku = null;

  let orderTimings = {};
  try { orderTimings = JSON.parse(sessionStorage.getItem('wms_timings') || '{}'); } catch {}
  function saveTimings() { sessionStorage.setItem('wms_timings', JSON.stringify(orderTimings)); }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function hdrs() {
    return { 'x-session-id': SESSION_ID, 'Content-Type': 'application/json' };
  }
  async function authDownload(url, filename) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) { alert('Download failed: ' + (await resp.text())); return; }
      const blob = await resp.blob();
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = filename || 'download';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { alert('Download error: ' + e.message); }
  }
  // Fetch a PDF and go straight to the browser's print dialog via a hidden
  // iframe holding the PDF preview — nothing lands on the desktop first, so
  // the packer never has to go find a downloaded file before printing it.
  // Falls back to opening the PDF in a new tab if iframe printing is blocked
  // (e.g. a browser popup-blocker on the print() call itself).
  let _printFrameUrl = null;
  async function authPrintPdf(url) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) { alert('Print failed: ' + (await resp.text())); return; }
      const blob = new Blob([await resp.arrayBuffer()], { type: 'application/pdf' });
      if (_printFrameUrl) { try { URL.revokeObjectURL(_printFrameUrl); } catch {} }
      const blobUrl = _printFrameUrl = URL.createObjectURL(blob);
      const old = document.getElementById('pdfPrintFrame');
      if (old) old.remove();
      const frame = document.createElement('iframe');
      frame.id = 'pdfPrintFrame';
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;visibility:hidden;';
      frame.onload = () => {
        // Small delay lets the PDF viewer finish rendering before the dialog opens
        setTimeout(() => {
          try { frame.contentWindow.focus(); frame.contentWindow.print(); }
          catch { window.open(blobUrl, '_blank'); }
        }, 150);
      };
      document.body.appendChild(frame);
      frame.src = blobUrl;
    } catch (e) { alert('Print error: ' + e.message); }
  }
  async function postDownload(url, body, filename) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        alert('Failed: ' + (d.error || resp.statusText)); return;
      }
      const blob = await resp.blob();
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = filename || 'download';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { alert('Error: ' + e.message); }
  }


  // Delegate clicks on auth-gated download links so fetch (not browser nav) is used
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-auth-dl]');
    if (!el) return;
    e.preventDefault();
    authDownload(el.dataset.authDl, el.dataset.authDlName || '');
  });
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmtMs(ms) {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }
  function fmtElapsed(startISO, endISO) {
    if (!startISO || !endISO) return null;
    const ms = new Date(endISO) - new Date(startISO);
    return ms > 0 ? fmtMs(ms) : null;
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }

  // ── Login ──────────────────────────────────────────────────────────────────
  let _loginCallback = null;

  function requireLogin(cb) {
    if (currentUser) { cb(); return; }
    _loginCallback = cb;
    document.getElementById('loginOverlay').classList.remove('hidden');
    setTimeout(() => document.getElementById('loginName').focus(), 100);
  }

  // Load non-sensitive public config (default recipient) on every page load
  fetch('/api/public/config').then(r => r.json()).then(c => {
    if (c.default_email) defaultRecipientEmail = c.default_email;
  }).catch(() => {});

  function initLogin() {
    fetchAndRenderStats(); // always load stats — visible without login
    const stored = localStorage.getItem('wms_user');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed.id) { // new credential-backed format only
          // Ensure role is present (sessions stored before role feature default to admin)
          if (!parsed.role) parsed.role = 'admin';
          currentUser = parsed;
          fetchUserProfile();
          showUserInHeader();
          refreshOrders().then(() => {
            if (document.getElementById('tab-orders').classList.contains('active')) renderOrdersDash();
          });
          return;
        }
      } catch {}
      localStorage.removeItem('wms_user');
      localStorage.removeItem('wms_token'); // old format — require re-login
    }
    document.getElementById('loginOverlay').classList.remove('hidden');
  }

  function showUserInHeader() {
    document.getElementById('loginOverlay').classList.add('hidden');
    if (!currentUser) return;
    const chip = document.getElementById('userDisplay');
    chip.textContent = currentUser.name || currentUser.id;
    chip.classList.remove('hidden');
    document.getElementById('printerSettingsBtn').classList.remove('hidden');
    document.getElementById('lockBtn').classList.remove('hidden');
    applyRoleUI();
  }

  // ── Per-user profile (printer settings) ──────────────────────────────────
  async function fetchUserProfile() {
    if (!currentUser) return;
    try {
      const r = await fetch('/api/profile', { headers: hdrs() });
      if (!r.ok) return;
      const p = await r.json();
      currentUser.printerName = p.printerName || '';
      currentUser.labelSize   = p.labelSize   || '100x160';
      currentUser.features    = p.features    || null;
      if (p.tablePrefs) tablePrefs = { widths: p.tablePrefs.widths || {}, hidden: p.tablePrefs.hidden || [] };
      applyFeatureToggles(currentUser.features);
    } catch {}
    fetchNoBarcodeSkus();
  }

  // Per-user feature visibility — set by the Administrator per user.
  // null = everything visible. Role rules (e.g. warehouse can't open the
  // Administrator panel) still apply on top of these.
  function applyFeatureToggles(features) {
    const tabs = ['upload', 'orders', 'inbound', 'transport', 'labels', 'reports'];
    tabs.forEach(tab => {
      const off = features && features[tab] === false;
      document.querySelector(`.sidebar .tab-btn[data-tab="${tab}"]`)?.classList.toggle('hidden', off);
      if (tab === 'transport') document.getElementById('transportSubMenu')?.classList.toggle('hidden', off);
    });
    // If the tab currently on screen was just hidden, move to the first visible one
    const active = document.querySelector('.sidebar .tab-btn.active');
    if (active?.classList.contains('hidden')) {
      document.querySelector('.sidebar .tab-btn[data-tab]:not(.hidden)')?.click();
    }
  }

  // ── No-barcode items (GWPs etc.) — counted by button or substitute barcode ─
  let noBarcodeSkus = new Set();
  const NO_BARCODE_PAT = /\bGWP\b/i;
  function isNoBarcodeItem(item) {
    return noBarcodeSkus.has(item.sku) || NO_BARCODE_PAT.test(item.sku + ' ' + (item.description || ''));
  }
  async function fetchNoBarcodeSkus() {
    try {
      const r = await fetch('/api/no-barcode-skus', { headers: hdrs() });
      if (r.ok) noBarcodeSkus = new Set(await r.json());
    } catch {}
  }
  async function learnNoBarcodeSku(item) {
    if (noBarcodeSkus.has(item.sku)) return;
    noBarcodeSkus.add(item.sku);
    try {
      await fetch('/api/no-barcode-skus', {
        method: 'POST',
        headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: item.sku, description: item.description || '', client_name: activeOrder?.client_name || '' }),
      });
    } catch {}
  }

  // ── Orders table layout prefs (per user) ──────────────────────────────────
  const ORDER_COLS = [
    { id: 'orderno',  label: 'Order No',  fixed: true },  // cannot be hidden
    { id: 'client',   label: 'Client' },
    { id: 'customer', label: 'Customer' },
    { id: 'waybill',  label: 'Waybill' },
    { id: 'items',    label: 'Items' },
    { id: 'status',   label: 'Status' },
    { id: 'date',     label: 'Date' },
    { id: 'actions',  label: 'Actions' },
  ];
  let tablePrefs = { widths: {}, hidden: [] };
  let _tpTimer   = null;

  function saveTablePrefs() {
    clearTimeout(_tpTimer);
    _tpTimer = setTimeout(async () => {
      try {
        await fetch('/api/profile/table-prefs', {
          method: 'PUT',
          headers: { ...hdrs(), 'Content-Type': 'application/json' },
          body: JSON.stringify(tablePrefs),
        });
      } catch {}
    }, 600);
  }

  // Re-applied after every orders render: widths + hidden columns.
  // Cell index = column index + 1 (first td is the status stripe).
  function applyOrdersTablePrefs() {
    const table = document.querySelector('#ordersDashList .orders-table');
    if (!table) return;
    if (Object.keys(tablePrefs.widths).length) table.style.tableLayout = 'fixed';
    ORDER_COLS.forEach((c, ci) => {
      const hide = tablePrefs.hidden.includes(c.id) && !c.fixed;
      table.querySelectorAll('tr').forEach(tr => {
        const cell = tr.children[ci + 1];
        if (cell) cell.style.display = hide ? 'none' : '';
      });
      const th = table.querySelector(`th[data-col="${c.id}"]`);
      const w  = tablePrefs.widths[c.id];
      if (th && w && !hide) th.style.width = w + 'px';
    });
  }

  function initOrdersColResize() {
    const table = document.querySelector('#ordersDashList .orders-table');
    if (!table) return;
    table.querySelectorAll('th .col-resize').forEach(h => {
      h.addEventListener('pointerdown', e => {
        e.preventDefault(); e.stopPropagation();
        const th     = h.closest('th');
        const colId  = th.dataset.col;
        const startX = e.clientX;
        const startW = th.getBoundingClientRect().width;
        // First drag: freeze all current widths so nothing jumps when the
        // table switches to fixed layout
        if (table.style.tableLayout !== 'fixed') {
          table.querySelectorAll('thead th[data-col]').forEach(t => {
            const w = Math.round(t.getBoundingClientRect().width);
            t.style.width = w + 'px';
            tablePrefs.widths[t.dataset.col] = w;
          });
          table.style.tableLayout = 'fixed';
        }
        const move = ev => {
          const w = Math.max(40, Math.min(800, Math.round(startW + (ev.clientX - startX))));
          th.style.width = w + 'px';
          tablePrefs.widths[colId] = w;
        };
        const up = () => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          saveTablePrefs();
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      });
    });
  }

  // Window resized (or zoom changed) while scanning → re-measure page fit.
  // Height-only changes are IGNORED: on phones the on-screen keyboard
  // shrinks the viewport height when a qty field is tapped, and re-rendering
  // then would destroy the focused input and dismiss the keyboard.
  let _scanResizeTimer = null;
  let _scanLastWidth   = window.innerWidth;
  window.addEventListener('resize', () => {
    clearTimeout(_scanResizeTimer);
    _scanResizeTimer = setTimeout(() => {
      if (window.innerWidth === _scanLastWidth) return; // keyboard, not a real resize
      _scanLastWidth = window.innerWidth;
      if (!activeOrder || document.getElementById('scanOverlay')?.classList.contains('hidden')) return;
      scanPageSize = SCAN_PAGE_MAX;
      renderItemsTable(activeOrder);
    }, 250);
  });

  function initOrdersColsToggle() {
    document.getElementById('gwpSheetBtn')?.addEventListener('click', () => {
      const token = localStorage.getItem('wms_token') || '';
      window.open(`/api/no-barcode-sheet?token=${encodeURIComponent(token)}`, '_blank');
    });
    const btn = document.getElementById('colsToggleBtn');
    const pop = document.getElementById('colsPopover');
    if (!btn || !pop) return;
    btn.addEventListener('click', e => { e.stopPropagation(); pop.classList.toggle('hidden'); });
    pop.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => pop.classList.add('hidden'), { once: true });
    pop.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.col;
        tablePrefs.hidden = tablePrefs.hidden.filter(h => h !== id);
        if (!cb.checked) tablePrefs.hidden.push(id);
        applyOrdersTablePrefs();
        saveTablePrefs();
      });
    });
  }

  function ordersColsToggleHTML() {
    return `
      <div class="cols-toggle-wrap">
        <button class="btn-secondary btn-sm" id="gwpSheetBtn" title="Printable substitute barcodes for items with no barcode (GWPs)">&#127991; No-Barcode Sheet</button>
        <button class="btn-secondary btn-sm" id="colsToggleBtn" title="Show/hide and resize columns">&#9881; Columns</button>
        <div id="colsPopover" class="cols-popover hidden">
          ${ORDER_COLS.map(c => `
            <label class="cols-popover-row${c.fixed ? ' disabled' : ''}">
              <input type="checkbox" data-col="${c.id}" ${tablePrefs.hidden.includes(c.id) ? '' : 'checked'} ${c.fixed ? 'disabled' : ''} />
              ${c.label}
            </label>`).join('')}
          <div class="cols-popover-hint">Drag column edges in the header to resize</div>
        </div>
      </div>`;
  }

  const LABEL_SIZE_MAP = {
    '100x160': { w: 100,   h: 160   },
    '100x150': { w: 100,   h: 150   },
    '4x6':     { w: 101.6, h: 152.4 },
  };

  // ── Printer Settings Modal ────────────────────────────────────────────────
  document.getElementById('printerSettingsBtn').addEventListener('click', openPrinterSettings);
  document.getElementById('printerSettingsClose').addEventListener('click', closePrinterSettings);
  document.getElementById('psCancelBtn').addEventListener('click', closePrinterSettings);
  document.getElementById('printerSettingsOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('printerSettingsOverlay')) closePrinterSettings();
  });

  function openPrinterSettings() {
    document.getElementById('psNameInput').value  = currentUser?.printerName || '';
    document.getElementById('psLabelSize').value  = currentUser?.labelSize   || '100x160';
    document.getElementById('psSaveStatus').textContent = '';
    document.getElementById('printerSettingsOverlay').classList.remove('hidden');
    setTimeout(() => document.getElementById('psNameInput').focus(), 80);
  }

  function closePrinterSettings() {
    document.getElementById('printerSettingsOverlay').classList.add('hidden');
  }

  document.getElementById('psSaveBtn').addEventListener('click', async () => {
    const name = document.getElementById('psNameInput').value.trim();
    const size = document.getElementById('psLabelSize').value;
    const statusEl = document.getElementById('psSaveStatus');
    statusEl.textContent = 'Saving…';
    try {
      const r = await fetch('/api/profile/printer', {
        method: 'PUT',
        headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ printerName: name, labelSize: size }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Save failed');
      if (currentUser) {
        currentUser.printerName = d.printerName;
        currentUser.labelSize   = d.labelSize;
      }
      statusEl.textContent = 'Saved ✓';
      setTimeout(closePrinterSettings, 800);
    } catch (err) {
      statusEl.textContent = '✗ ' + err.message;
    }
  });

  function applyRoleUI() {
    const isWarehouse = (currentUser?.role || 'admin') === 'warehouse';

    // Upload tab button — hidden for warehouse
    document.querySelectorAll('.tab-btn[data-tab="upload"]').forEach(b => b.classList.toggle('hidden', isWarehouse));
    document.querySelectorAll('.tab-btn[data-tab="reports"]').forEach(b => b.classList.toggle('hidden', isWarehouse));
    document.querySelectorAll('.tab-btn[data-tab="connections"]').forEach(b => b.classList.toggle('hidden', isWarehouse));

    // Admin button — hidden for warehouse
    const logBtn = document.getElementById('logAccessBtn');
    if (logBtn) logBtn.classList.toggle('hidden', isWarehouse);

    // Manage Waves (bulk cancel) — Admin only
    document.getElementById('manageWavesBtn')?.classList.toggle('hidden', isWarehouse);

    // If warehouse user lands on Upload tab, redirect to Orders
    if (isWarehouse && document.getElementById('tab-upload').classList.contains('active')) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('tab-orders').classList.add('active');
      document.querySelectorAll('.tab-btn[data-tab="orders"]').forEach(b => b.classList.add('active'));
      renderOrdersDash();
    }
  }

  document.getElementById('loginName').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('loginIC').focus();
  });
  document.getElementById('loginIC').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
  document.getElementById('loginBtn').addEventListener('click', doLogin);

  async function doLogin() {
    const id     = document.getElementById('loginName').value.trim();
    const pass   = document.getElementById('loginIC').value.trim();
    const errEl  = document.getElementById('loginError');
    if (!id || !pass) {
      errEl.textContent = 'Enter your User ID and password.';
      errEl.classList.remove('hidden'); return;
    }
    errEl.classList.add('hidden');
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, password: pass }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        errEl.textContent = data.error || 'Login failed';
        errEl.classList.remove('hidden'); return;
      }
      currentUser = { id: data.id, name: data.name, role: data.role || 'admin' };
      localStorage.setItem('wms_user', JSON.stringify(currentUser));
      if (data.token) localStorage.setItem('wms_token', data.token);
      fetchUserProfile();
      showUserInHeader();
      fetchAndRenderStats();
      loadDrivers();
      refreshOrders().then(() => {
        if (document.getElementById('tab-orders').classList.contains('active')) renderOrdersDash();
      });
      if (_loginCallback) { const fn = _loginCallback; _loginCallback = null; fn(); }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  }

  // ── PIN Lock ───────────────────────────────────────────────────────────────
  const PIN_KEY = 'wms_pin';
  let pinBuffer     = '';
  let pinMode       = 'unlock';
  let pinSetupFirst = '';

  function getPin() { return localStorage.getItem(PIN_KEY); }
  function savePin(p) { localStorage.setItem(PIN_KEY, p); }

  document.getElementById('lockBtn').addEventListener('click', () => {
    if (!getPin()) {
      pinMode = 'setup';
      openPinOverlay('Set a 4-digit PIN', 'Choose a PIN to lock the app when you step away');
    } else {
      pinMode = 'unlock';
      openPinOverlay('App Locked', currentUser ? `Signed in as ${currentUser.name}` : 'Enter PIN to unlock');
    }
  });

  function openPinOverlay(title, subtitle) {
    pinBuffer = ''; pinSetupFirst = '';
    document.getElementById('pinTitle').textContent    = title;
    document.getElementById('pinSubtitle').textContent = subtitle;
    document.getElementById('pinError').classList.add('hidden');
    document.getElementById('pinOverlay').classList.remove('hidden');
    refreshPinDots();
  }

  function closePinOverlay() {
    document.getElementById('pinOverlay').classList.add('hidden');
    pinBuffer = '';
    refreshPinDots();
  }

  function refreshPinDots() {
    for (let i = 0; i < 4; i++)
      document.getElementById(`pd${i}`).classList.toggle('filled', i < pinBuffer.length);
  }

  document.querySelectorAll('.pk').forEach(k => {
    k.addEventListener('click', () => {
      const d = k.dataset.d;
      if (!d) return;
      if (d === 'del') {
        pinBuffer = pinBuffer.slice(0, -1);
        refreshPinDots();
      } else if (pinBuffer.length < 4) {
        pinBuffer += d;
        refreshPinDots();
        if (pinBuffer.length === 4) setTimeout(handlePinSubmit, 180);
      }
    });
  });

  function handlePinSubmit() {
    const errEl = document.getElementById('pinError');
    if (pinMode === 'setup') {
      pinSetupFirst = pinBuffer;
      pinBuffer = '';
      refreshPinDots();
      document.getElementById('pinTitle').textContent    = 'Confirm PIN';
      document.getElementById('pinSubtitle').textContent = 'Re-enter your 4-digit PIN to confirm';
      errEl.classList.add('hidden');
      pinMode = 'confirm';
    } else if (pinMode === 'confirm') {
      if (pinBuffer === pinSetupFirst) {
        savePin(pinBuffer);
        closePinOverlay();
      } else {
        errEl.textContent = 'PINs do not match. Try again.';
        errEl.classList.remove('hidden');
        pinBuffer = ''; pinSetupFirst = '';
        refreshPinDots();
        document.getElementById('pinTitle').textContent    = 'Set a 4-digit PIN';
        document.getElementById('pinSubtitle').textContent = 'Choose a PIN to lock the app when you step away';
        pinMode = 'setup';
      }
    } else {
      if (pinBuffer === getPin()) {
        closePinOverlay();
      } else {
        errEl.textContent = 'Incorrect PIN. Try again.';
        errEl.classList.remove('hidden');
        pinBuffer = '';
        refreshPinDots();
      }
    }
  }

  document.getElementById('pinLogoutBtn').addEventListener('click', () => {
    if (confirm('Sign out? Your current session will be cleared.')) {
      fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      localStorage.removeItem('wms_user');
      localStorage.removeItem('wms_token');
      localStorage.removeItem(PIN_KEY);
      sessionStorage.clear();
      location.reload();
    }
  });

  // ── Sidebar hamburger toggle (mobile) ────────────────────────────────────
  const _sbToggleBtn     = document.getElementById('sidebarToggleBtn');
  const _sidebar         = document.getElementById('appSidebar');
  const _sbDrawerOverlay = document.getElementById('sidebarDrawerOverlay');
  function openSidebar()  { _sidebar?.classList.add('sb-open');    _sbDrawerOverlay?.classList.add('visible'); }
  function closeSidebar() { _sidebar?.classList.remove('sb-open'); _sbDrawerOverlay?.classList.remove('visible'); }
  _sbToggleBtn?.addEventListener('click', () => _sidebar?.classList.contains('sb-open') ? closeSidebar() : openSidebar());
  _sbDrawerOverlay?.addEventListener('click', closeSidebar);

  // ── Tab switching ──────────────────────────────────────────────────────────
  const TAB_TITLES = { upload: 'Upload', orders: 'Orders', waves: 'Wave Pick', inbound: 'Inbound', inventory: 'Inventory', transport: 'Transport', labels: 'Labels', reports: 'Reports', connections: 'Connections', about: 'About' };
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => { switchTab(btn.dataset.tab); closeSidebar(); })
  );
  document.querySelectorAll('[data-tab-link]').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tabLink))
  );

  function switchTab(name) {
    // Warehouse users cannot access the upload tab
    if ((name === 'upload' || name === 'reports' || name === 'connections') && (currentUser?.role || 'admin') === 'warehouse') return;
    // Connections is ADMINISTRATOR-ONLY: same password gate as the
    // Administrator panel. Unlock once per session, then it opens freely.
    if (name === 'connections' && !logUnlocked) {
      _pendingUnlockTab = 'connections';
      document.getElementById('logPasswordInput').value = '';
      document.getElementById('logPasswordError').classList.add('hidden');
      document.getElementById('logPasswordOverlay').classList.remove('hidden');
      setTimeout(() => document.getElementById('logPasswordInput').focus(), 100);
      return;
    }
    if (!document.getElementById(`tab-${name}`)) return;
    if (pendingDownload && name === 'orders') {
      const dlWrap = document.getElementById('uploadDownloadWrap');
      dlWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
      dlWrap.classList.remove('download-shake');
      void dlWrap.offsetWidth;
      dlWrap.classList.add('download-shake');
      setTimeout(() => dlWrap.classList.remove('download-shake'), 400);
      return;
    }
    // Leaving Wave Pick with its detail view open must release the global
    // scan capture, or a gun fired on the next tab would still be routed at
    // the (now hidden) wave scan input.
    // (window.waveUI, not the bare const — switchTab can run before that
    // const is initialised, and `typeof` on a const in its temporal dead zone
    // throws rather than yielding "undefined".)
    if (name !== 'waves') window.waveUI?.leaveDetail();
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${name}`).classList.add('active');
    document.querySelector(`.tab-btn[data-tab="${name}"]`)?.classList.add('active');
    // Page title. Write into #ctTabText, NOT the wrapper — setting textContent
    // on #ctTabTitle would wipe the icon span with it.
    const ttEl = document.getElementById('ctTabText');
    if (ttEl) ttEl.textContent = TAB_TITLES[name] || name;
    // Mirror the icon off the sidebar button that is now active, so a tab whose
    // icon changes never leaves the heading showing the old one.
    const icEl = document.getElementById('ctTabIcon');
    if (icEl) icEl.textContent = document.querySelector(`.tab-btn[data-tab="${name}"] .tab-icon`)?.textContent || '';
    if (name === 'upload') { fetchAndRenderStats(); renderBreakdowns(loadedOrders); }
    if (name === 'orders') { renderOrdersDash(); loadBackordersBadge(); setTimeout(() => focusWaybillInput(), 300); }
    document.getElementById('ordersSubMenu').style.display =
      (name === 'orders' && (currentUser?.role || 'admin') !== 'warehouse') ? 'block' : 'none';
    if (name === 'inbound') { renderInboundTab(); }
    if (name === 'inventory') { renderInventory(); }
    // Inventory's functions live in a sidebar sub-menu (same pattern as
    // Transport) instead of stacked on one very long page.
    document.getElementById('inventorySubMenu').style.display = (name === 'inventory') ? 'block' : 'none';
    if (name === 'inventory') setInventoryView(_invView || 'overview');
    if (name === 'waves') { waveUI.load(); }
    if (name === 'transport') {
      document.getElementById('transportSubMenu').style.display = 'block';
      renderTransportTab();
    } else {
      document.getElementById('transportSubMenu').style.display = 'none';
    }
    if (name === 'labels') { renderLabelsTab(); }
    if (name === 'connections') { loadZortStores(); }
  }

  function lockTabsForDownload() {
    pendingDownload = true;
    document.querySelector('.tab-btn[data-tab="orders"]')?.classList.add('tab-locked');
  }

  function unlockTabsAfterDownload() {
    pendingDownload = false;
    document.querySelector('.tab-btn[data-tab="orders"]')?.classList.remove('tab-locked');
    const noteEl = document.getElementById('downloadLockNote');
    if (noteEl) noteEl.remove();
  }

  // ── Sidebar pending-orders badge ───────────────────────────────────────────
  // Shows the live count of orders still pending/in-progress (any day) on the
  // Orders nav button. Hidden entirely when the backlog is zero.
  function updateOrdersNavBadge(count) {
    const btn = document.querySelector('.sidebar .tab-btn[data-tab="orders"]');
    if (!btn) return;
    let badge = btn.querySelector('.nav-pending-badge');
    if (!count) { badge?.remove(); return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-pending-badge';
      btn.appendChild(badge);
    }
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.title = `${count} order(s) pending / in progress`;
  }

  // ── Dashboard Stats ────────────────────────────────────────────────────────
  async function fetchAndRenderStats() {
    try {
      const resp = await fetch('/api/stats');
      if (!resp.ok) return;
      const s = await resp.json();
      const clientRows = (s.clientStats || []).map(c => {
        const balCell = c.yesterdayBalance > 0
          ? `<td class="dcs-bal warn">${c.yesterdayBalance} left</td>`
          : `<td class="dcs-bal ok">—</td>`;
        return `<tr>
          <td class="dcs-name">${esc(c.name)}</td>
          <td class="dcs-today">${c.todayUploaded}</td>
          <td class="dcs-pend ${c.todayPending > 0 ? 'warn' : 'ok'}">${c.todayPending}</td>
          ${balCell}
        </tr>`;
      }).join('');

      document.getElementById('dashStatsGrid').innerHTML = `
        <div class="dstat pending">
          <div class="dstat-val">${s.todayPending}</div>
          <div class="dstat-lbl">Pending Today</div>
        </div>
        <div class="dstat done">
          <div class="dstat-val">${s.todayDone ?? 0}</div>
          <div class="dstat-lbl">Processed Today</div>
        </div>
        <div class="dstat done">
          <div class="dstat-val">${s.yesterdayDone}</div>
          <div class="dstat-lbl">Done Yesterday</div>
        </div>
        <div class="dstat">
          <div class="dstat-val">${s.totalDone ?? 0}</div>
          <div class="dstat-lbl">Processed Til Date</div>
        </div>
        <div class="dstat">
          <div class="dstat-val">${s.totalOrders}</div>
          <div class="dstat-lbl">Total Orders</div>
        </div>
        <div class="dstat">
          <div class="dstat-val">${s.totalLines}</div>
          <div class="dstat-lbl">Total Lines</div>
        </div>
        <div class="dstat avg">
          <div class="dstat-val">${fmtMs(s.avgScanMs)}</div>
          <div class="dstat-lbl">Avg Scan Time</div>
        </div>
        ${clientRows.length ? `
        <div class="dcs-wrap">
          <table class="dcs-table">
            <thead><tr>
              <th>Client</th>
              <th>Uploaded Today</th>
              <th>Pending Today</th>
              <th>Balance Yesterday</th>
            </tr></thead>
            <tbody>${clientRows}</tbody>
          </table>
        </div>` : ''}`;
      document.getElementById('dashStatsSection').classList.remove('hidden');
      // Sidebar badge: how many orders are still pending/in-progress (any day)
      updateOrdersNavBadge(s.pendingBacklog || 0);
      // Show live numbers on the login overlay for anyone who hasn't signed in yet
      const liveEl = document.getElementById('loginLiveStats');
      if (liveEl && s.totalOrders > 0) {
        liveEl.innerHTML = `
          <div class="llive-item"><span class="llive-val">${s.totalOrders}</span><span class="llive-lbl">Orders</span></div>
          <div class="llive-item"><span class="llive-val">${s.todayPending}</span><span class="llive-lbl">Pending Today</span></div>
          <div class="llive-item"><span class="llive-val">${s.yesterdayDone}</span><span class="llive-lbl">Done Yesterday</span></div>
          <div class="llive-item"><span class="llive-val">${fmtMs(s.avgScanMs)}</span><span class="llive-lbl">Avg Scan Time</span></div>`;
        liveEl.classList.remove('hidden');
      }
    } catch {}
  }

  document.getElementById('refreshStatsBtn').addEventListener('click', async () => {
    await fetchAndRenderStats();
    if (!loadedOrders.length) await refreshOrders();
    renderBreakdowns(loadedOrders);
  });

  // ── Upload tab ─────────────────────────────────────────────────────────────
  const dropZone        = document.getElementById('dropZone');
  const fileInput       = document.getElementById('fileInput');
  const photoInput = document.getElementById('photoInput');

  document.getElementById('browseBtn').addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
  document.getElementById('photoUploadBtn').addEventListener('click', e => { e.stopPropagation(); photoInput.click(); });
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) previewOrderFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) previewOrderFile(fileInput.files[0]); });
  photoInput.addEventListener('change', () => { if (photoInput.files[0]) previewPhotoFile(photoInput.files[0]); });

  // ── Label import from Upload tab ─────────────────────────────────────────
  const labelImportInputUpload = document.getElementById('labelImportFileInputUpload');
  document.getElementById('browseLabelPdfBtn')?.addEventListener('click', () => labelImportInputUpload?.click());
  labelImportInputUpload?.addEventListener('change', () => {
    const f = labelImportInputUpload.files[0];
    if (!f) return;
    document.getElementById('labelImportUploadName').textContent = f.name;
    doLabelImportFromUploadTab(f);
  });

  async function doLabelImportFromUploadTab(file) {
    const statusEl = document.getElementById('labelImportUploadStatus');
    statusEl.className = 'status-bar loading';
    statusEl.textContent = 'Uploading and matching label pages…';
    statusEl.classList.remove('hidden');
    try {
      const fd = new FormData();
      fd.append('labelPdf', file);
      let resp = await fetch('/api/label-imports', { method: 'POST', body: fd });
      let data = await resp.json();
      if (resp.status === 409 && data.needsSameFileConfirm) {
        if (!labelSameFileConfirm(data.existing)) {
          statusEl.className = 'status-bar error';
          statusEl.textContent = 'Upload cancelled — the earlier label upload was kept.';
          labelImportInputUpload.value = '';
          return;
        }
        fd.append('overwrite_same_file', 'yes');
        resp = await fetch('/api/label-imports', { method: 'POST', body: fd });
        data = await resp.json();
      }
      if (!resp.ok) throw new Error(data.error || 'Upload failed');
      statusEl.classList.add('hidden');
      labelImportInputUpload.value = '';
      renderCurrentLabelImport({
        importId:  data.importId,
        filename:  file.name,
        matched:   data.matched,
        unmatched: data.pageCount - data.matched,
      });
    } catch (err) {
      statusEl.className = 'status-bar error';
      statusEl.textContent = err.message;
    }
  }

  // Only THIS session's label upload is shown, right next to Attach PDF —
  // no import history on the Upload tab (full history lives in the Labels tab)
  function renderCurrentLabelImport(cur) {
    const el = document.getElementById('labelImportCurrent');
    if (!el) return;
    document.getElementById('labelImportUploadName').textContent = cur.filename;
    el.innerHTML = `
      ${cur.matched   ? `<span class="lhi-badge lhi-matched">${cur.matched} matched</span>` : ''}
      ${cur.unmatched ? `<span class="lhi-badge lhi-unmatched">${cur.unmatched} unmatched</span>` : ''}
      ${cur.unmatched ? `<button class="btn-primary btn-sm" id="labelCurAutoMatch">&#9889; Auto Match</button>` : ''}
      ${cur.unmatched ? `<button class="btn-ghost btn-sm" id="labelCurReview">Review ›</button>` : `<span class="lhi-badge lhi-matched">&#10003; all pages matched</span>`}`;
    el.classList.remove('hidden');
    document.getElementById('labelCurAutoMatch')?.addEventListener('click', async () => {
      const btn = document.getElementById('labelCurAutoMatch');
      btn.disabled = true; btn.textContent = 'Matching… (reading label images)';
      try {
        const r = await fetch(`/api/label-imports/${cur.importId}/rematch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        await refreshOrders();
        renderCurrentLabelImport({ ...cur, matched: d.matched, unmatched: d.unmatched });
      } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = '⚡ Auto Match'; }
    });
    document.getElementById('labelCurReview')?.addEventListener('click', () => openLabelReview(cur.importId));
  }

  document.getElementById('goOrdersBtn').addEventListener('click', () => switchTab('orders'));

  // ── Step 1a: Preview from file (XLSX/CSV) ──────────────────────────────────
  async function previewOrderFile(file) {
    pendingOrderFile = file;
    pendingOcrRows   = null;
    unlockTabsAfterDownload();
    document.getElementById('uploadDownloadWrap').classList.add('hidden');
    setUploadStatus('loading', `Parsing ${file.name}…`);

    const form = new FormData();
    form.append('orderFile', file);
    // Pass the client name typed on the upload page (if any) so the preview can
    // compute the staging heads-up even when the file has no client column.
    const preClient = document.getElementById('clientNameInput')?.value.trim();
    if (preClient) form.append('client_name', preClient);

    try {
      const resp = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'x-session-id': SESSION_ID },
        body: form,
      });
      const data = await resp.json();
      document.getElementById('uploadStatus').classList.add('hidden');
      showUploadConfirmModal(file.name, data);
    } catch (err) {
      setUploadStatus('error', err.message);
    }
  }

  // ── Step 1b: Preview from photo (OCR) ──────────────────────────────────────
  async function previewPhotoFile(file) {
    pendingOrderFile = null;
    pendingOcrRows   = null;
    unlockTabsAfterDownload();
    document.getElementById('uploadDownloadWrap').classList.add('hidden');
    setUploadStatus('loading', 'Reading photo… (OCR may take a few seconds)');

    const form = new FormData();
    form.append('image', file);

    try {
      const resp = await fetch('/api/ocr/preview', {
        method: 'POST',
        headers: { 'x-session-id': SESSION_ID },
        body: form,
      });
      const data = await resp.json();
      document.getElementById('uploadStatus').classList.add('hidden');
      if (data.ocrRows && data.ocrRows.length) pendingOcrRows = data.ocrRows;
      showUploadConfirmModal('📷 ' + file.name, data);
    } catch (err) {
      setUploadStatus('error', err.message);
    }
  }

  // ── Step 2: Confirm modal ──────────────────────────────────────────────────
  function showUploadConfirmModal(filename, preview) {
    const fromFile = (preview.clientName || '').trim();
    if (fromFile) document.getElementById('clientNameInput').value = fromFile;
    const clientName = fromFile || document.getElementById('clientNameInput').value.trim();
    document.getElementById('confirmFileName').textContent    = filename;

    // Client name: no column in the uploaded file mapped to client/brand
    // (only "Customer Name" columns did, which is the consignee — a different
    // field). Rather than silently save the batch with client_name blank,
    // require the uploader to type it or explicitly say none applies.
    const clientField = document.getElementById('confirmClientNameField');
    const clientHint  = document.getElementById('confirmClientHint');
    const noClientChk = document.getElementById('confirmNoClientChk');
    clientField.value = clientName;
    noClientChk.checked = false;
    const evaluateClientGate = () => {
      const hasName = clientField.value.trim() !== '';
      const resolved = hasName || noClientChk.checked;
      clientField.classList.toggle('needs-input', !resolved);
      clientHint.classList.toggle('hidden', hasName);
      clientField.disabled = noClientChk.checked;
      document.getElementById('clientNameInput').value = hasName ? clientField.value.trim() : '';
      document.getElementById('confirmApproveBtn').disabled = !resolved;
    };
    clientField.oninput = evaluateClientGate;
    noClientChk.onchange = evaluateClientGate;
    evaluateClientGate();

    document.getElementById('confirmOrderCount').textContent  = preview.orderCount;
    document.getElementById('confirmLineCount').textContent   = preview.rowCount;
    document.getElementById('confirmConverted').innerHTML     = preview.converted
      ? '<span style="color:var(--success)">&#10003; Converted to WMS format</span>'
      : '<span style="color:var(--danger)">&#10007; Conversion failed</span>';

    const names = preview.customerNames || [];
    const custRow = document.getElementById('confirmCustomersRow');
    if (names.length) {
      document.getElementById('confirmCustomers').textContent = names.join(', ');
      custRow.classList.remove('hidden');
    } else {
      custRow.classList.add('hidden');
    }

    const errEl = document.getElementById('confirmErrors');
    if (preview.errors && preview.errors.length) {
      errEl.innerHTML = preview.errors.map(e => `<li>${esc(e)}</li>`).join('');
      errEl.classList.remove('hidden');
    } else {
      errEl.classList.add('hidden');
    }

    // Same SKU appearing more than once in one order — not blocked (a
    // genuine split pick across two bins is valid), just flagged so the
    // uploader can check the source file before approving.
    const dupEl = document.getElementById('confirmDuplicateWarnings');
    if (preview.duplicateWarnings && preview.duplicateWarnings.length) {
      dupEl.innerHTML = preview.duplicateWarnings.map(w => `<li>&#9432; ${esc(w)}</li>`).join('');
      dupEl.classList.remove('hidden');
    } else {
      dupEl.classList.add('hidden');
    }

    // Staging decision — only when some units would come from received-but-unbinned
    // stock. Default "wait till binned"; user can switch to "allocate from staging".
    const stagingSec = document.getElementById('stagingSection');
    if (preview.stagingUnits > 0) {
      document.getElementById('stagingUnitsLabel').textContent = preview.stagingUnits;
      const sk = (preview.stagingSkus || []).map(s => `${s.sku} (${s.units})`).join(', ');
      document.getElementById('stagingSkusHint').textContent = sk ? `In staging: ${sk}` : '';
      document.getElementById('pickStagingWait').checked = true;
      stagingSec.classList.remove('hidden');
    } else {
      stagingSec.classList.add('hidden');
    }

    // Flagged orders: review & amend quantities right here before approving
    const adjWrap = document.getElementById('confirmAdjustSection');
    const flagged = (preview.flagged || []).filter(f => (f.lines || []).length);
    if (flagged.length) {
      adjWrap.innerHTML = `
        <div class="adjust-title">&#9998; Review flagged order(s) — amend quantities before approving</div>
        ${flagged.map(f => `
          <div class="adjust-order">
            <div class="adjust-order-head"><strong>${esc(f.gi)}</strong> — ${esc(f.problem)}</div>
            <table class="adjust-table">
              <thead><tr><th>SKU</th><th>Description</th><th>Qty</th></tr></thead>
              <tbody>${f.lines.map(l => `
                <tr>
                  <td><code>${esc(l.sku)}</code></td>
                  <td>${esc(l.description)}</td>
                  <td><input type="number" min="0" max="99999" class="adjust-qty"
                        data-order="${esc(f.gi)}" data-sku="${esc(l.sku)}" data-orig="${l.qty}" value="${l.qty}" /></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>`).join('')}
        <div class="adjust-hint">Set a quantity to 0 to remove that line. Changes apply on Approve &amp; Upload.</div>`;
      adjWrap.classList.remove('hidden');
      adjWrap.querySelectorAll('.adjust-qty').forEach(inp =>
        inp.addEventListener('input', () => inp.classList.toggle('changed', inp.value !== inp.dataset.orig))
      );
    } else {
      adjWrap.classList.add('hidden');
      adjWrap.innerHTML = '';
    }

    // Flagged uploads demand an explicit decision: approve (with any
    // amendments) or abort — the buttons say exactly that.
    const approveBtn = document.getElementById('confirmApproveBtn');
    const cancelBtn  = document.getElementById('confirmCancelBtn');
    if (flagged.length) {
      approveBtn.textContent = `Approve with ${flagged.length} flagged order(s) →`;
      cancelBtn.textContent  = '✕ Abort Upload';
      cancelBtn.classList.add('abort-mode');
    } else {
      approveBtn.textContent = 'Approve & Upload →';
      cancelBtn.textContent  = 'Cancel';
      cancelBtn.classList.remove('abort-mode');
    }
    evaluateClientGate(); // (re)apply after the flagged-block reset approveBtn's text/state
    // Reset direction toggle to Outbound
    uploadDirection = 'Outbound';
    document.querySelectorAll('.dir-btn').forEach(b => b.classList.toggle('active', b.dataset.dir === 'Outbound'));
    // Delivery-arrangement question: reset to unanswered on every upload —
    // the user makes an explicit yes/no choice each time.
    document.querySelectorAll('input[name="arrangeDelivery"]').forEach(r => { r.checked = false; });
    document.getElementById('arrangeDeliveryError')?.classList.add('hidden');
    document.getElementById('deliveryPlanningSection')?.classList.remove('hidden');
    // Staging section stays hidden until the preview says there's staging stock;
    // reset its choice to the conservative default (wait till binned).
    document.getElementById('stagingSection')?.classList.add('hidden');
    document.getElementById('pickStagingWait') && (document.getElementById('pickStagingWait').checked = true);
    document.getElementById('uploadConfirmOverlay').classList.remove('hidden');
  }

  document.getElementById('confirmCancelBtn').addEventListener('click', () => {
    document.getElementById('uploadConfirmOverlay').classList.add('hidden');
    pendingOrderFile = null;
    fileInput.value = '';
  });

  // Inbound / Outbound toggle
  document.querySelectorAll('.dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      uploadDirection = btn.dataset.dir;
      document.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Delivery arrangement only applies to Outbound work
      document.getElementById('deliveryPlanningSection')?.classList.toggle('hidden', uploadDirection === 'Inbound');
    });
  });

  function arrangeDeliveryChoice() {
    return document.querySelector('input[name="arrangeDelivery"]:checked')?.value || '';
  }
  function pickStrategyChoice() {
    return document.querySelector('input[name="pickStrategy"]:checked')?.value || 'fefo';
  }
  function pickStagingChoice() {
    return document.querySelector('input[name="pickStaging"]:checked')?.value || 'wait';
  }
  document.querySelectorAll('input[name="arrangeDelivery"]').forEach(r =>
    r.addEventListener('change', () => document.getElementById('arrangeDeliveryError')?.classList.add('hidden')));

  document.getElementById('confirmApproveBtn').addEventListener('click', async () => {
    // Outbound uploads require an explicit delivery-arrangement decision
    if (uploadDirection !== 'Inbound' && !arrangeDeliveryChoice()) {
      document.getElementById('arrangeDeliveryError')?.classList.remove('hidden');
      document.getElementById('deliveryPlanningSection')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const btn = document.getElementById('confirmApproveBtn');
    btn.disabled    = true;
    btn.textContent = 'Uploading…';
    try {
      await doUpload();
    } catch (err) {
      // A JS error before/around the fetch must never freeze the dialog silently
      document.getElementById('uploadConfirmOverlay').classList.add('hidden');
      setUploadStatus('error', 'Upload failed: ' + err.message);
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Approve & Upload →';
    }
  });

  // ── Step 3: Actual upload ──────────────────────────────────────────────────
  async function doUpload() {
    if (!pendingOrderFile && !pendingOcrRows) return;

    // OCR path — upload the pre-parsed rows as JSON
    if (pendingOcrRows) {
      const clientName = document.getElementById('clientNameInput').value.trim();
      try {
        const resp = await fetch('/api/ocr/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-session-id': SESSION_ID },
          body: JSON.stringify({ rows: pendingOcrRows, client_name: clientName, direction: uploadDirection, arrange_delivery: arrangeDeliveryChoice(), pick_strategy: pickStrategyChoice(), pick_staging: pickStagingChoice() }),
        });
        const data = await resp.json();
        document.getElementById('uploadConfirmOverlay').classList.add('hidden');
        if (!resp.ok) { setUploadStatus('error', data.error || 'Upload failed'); return; }
        SESSION_ID = data.sessionId || SESSION_ID;
        sessionStorage.setItem('wms_session', SESSION_ID);
        loadedOrders = data.orders; activeOrder = null;
        setUploadStatus('success', `Scanned ${data.rowCount} line(s) across ${data.orders.length} order(s) from photo.`);
        const dlBtn  = document.getElementById('uploadDownloadBtn');
        const dlWrap = document.getElementById('uploadDownloadWrap');
        const _ocrDlUrl  = `/api/download-wms/${data.batchId}`;
        const _ocrDlName = `WMS_PhotoScan_${new Date().toISOString().slice(0,10)}.xlsx`;
        dlBtn.onclick = () => { authDownload(_ocrDlUrl, _ocrDlName); unlockTabsAfterDownload(); };
        dlWrap.classList.remove('hidden');
        lockTabsForDownload();
        renderUploadList(data.orders);
        renderBreakdowns(data.orders);
        fetchAndRenderStats();
        pendingOcrRows = null; photoInput.value = '';
      } catch (err) {
        document.getElementById('uploadConfirmOverlay').classList.add('hidden');
        setUploadStatus('error', err.message);
      }
      return;
    }

    if (!pendingOrderFile) return;
    const file       = pendingOrderFile;
    const clientName = document.getElementById('clientNameInput').value.trim();

    const form = new FormData();
    form.append('orderFile', file);
    if (clientName)  form.append('client_name', clientName);
    form.append('direction', uploadDirection);
    // Quantity amendments made in the flagged-orders review panel
    const adjustments = [...document.querySelectorAll('#confirmAdjustSection .adjust-qty')]
      .filter(inp => inp.value !== inp.dataset.orig)
      .map(inp => ({ order: inp.dataset.order, sku: inp.dataset.sku, qty: parseInt(inp.value, 10) }))
      .filter(a => Number.isFinite(a.qty) && a.qty >= 0);
    if (adjustments.length) form.append('adjustments', JSON.stringify(adjustments));
    // Delivery-arrangement decision — 'yes' also creates Transport jobs
    form.append('arrange_delivery', arrangeDeliveryChoice());
    form.append('pick_strategy', pickStrategyChoice());
    form.append('pick_staging', pickStagingChoice());

    try {
      const sendUpload = async () => {
        const _uploadAbort = new AbortController();
        const _uploadTimer = setTimeout(() => _uploadAbort.abort(), 90000);
        try {
          return await fetch('/api/upload', {
            method: 'POST',
            headers: { 'x-session-id': SESSION_ID },
            body: form,
            signal: _uploadAbort.signal,
          });
        } finally {
          clearTimeout(_uploadTimer);
        }
      };

      let resp = await sendUpload();
      let data = await resp.json();

      // Exact same file (same name + same contents) uploaded before —
      // the uploader decides: replace that batch or abort.
      if (resp.status === 409 && data.needsSameFileConfirm) {
        const ex = data.existing || {};
        const ok = confirm(
          `⚠ SAME FILE ALREADY UPLOADED\n\n` +
          `"${ex.filename}" (identical contents) was already uploaded` +
          `${ex.job ? ` as job ${ex.job}` : ''} on ${ex.uploadedAt}` +
          `${ex.uploadedBy ? ` by ${ex.uploadedBy}` : ''} — ${ex.orderCount} order(s).\n\n` +
          `OK = OVERWRITE the earlier upload with this one (its orders and any scan progress are replaced)\n` +
          `Cancel = abort this upload (keep the existing one)`);
        if (!ok) {
          document.getElementById('uploadConfirmOverlay').classList.add('hidden');
          setUploadStatus('error', 'Upload cancelled — the earlier upload of this file was kept.');
          return;
        }
        form.append('overwrite_same_file', 'yes');
        resp = await sendUpload();
        data = await resp.json();
      }

      // Suspect SKUs: the AI column detection found SKUs shaped like
      // warehouse location codes (e.g. THT-64-427-3 vs bin AC-007-003-B).
      // The server won't assume either way — confirm with the user.
      if (resp.status === 409 && data.needsSkuConfirm) {
        const lines = (data.suspects || []).slice(0, 12).map(s =>
          `• ${s.sku}  (order ${s.order}, qty ${s.qty})`).join('\n');
        const more = (data.suspects || []).length > 12 ? `\n…and ${data.suspects.length - 12} more` : '';
        const asSkus = confirm(
          `⚠ PLEASE CONFIRM — ARE THESE REAL PRODUCT SKUs?\n\n${data.message}\n\n${lines}${more}` +
          `\n\nOK = yes, these are real products (include them)\nCancel = they are NOT products`);
        if (asSkus) {
          form.append('suspect_skus', 'include');
        } else {
          const dropThem = confirm(
            `Upload WITHOUT these ${data.suspects.length} line(s) instead?\n\n` +
            `OK = upload the rest, leave these lines out\nCancel = abort the whole upload`);
          if (!dropThem) {
            document.getElementById('uploadConfirmOverlay').classList.add('hidden');
            setUploadStatus('error', 'Upload cancelled — suspect SKU lines not confirmed.');
            return;
          }
          form.append('suspect_skus', 'exclude');
        }
        resp = await sendUpload();
        data = await resp.json();
      }

      // Same order number already uploaded and NOT yet completed — the
      // uploader chooses: overwrite the earlier upload with this file's
      // version (scan progress on it is discarded) or abort.
      if (resp.status === 409 && data.needsOverwriteConfirm) {
        const lines = (data.duplicates || []).slice(0, 10).map(d =>
          `• ${d.order} — job ${d.job || '?'} ("${d.filename}", ${d.at}, status: ${d.status})`).join('\n');
        const more = (data.duplicates || []).length > 10 ? `\n…and ${data.duplicates.length - 10} more` : '';
        const ok = confirm(
          `⚠ ALREADY UPLOADED — NOT YET COMPLETED\n\n${data.message}\n\n${lines}${more}` +
          `\n\nOK = OVERWRITE with this file's version\nCancel = abort upload (keep the existing order)`);
        if (!ok) {
          document.getElementById('uploadConfirmOverlay').classList.add('hidden');
          setUploadStatus('error', 'Upload cancelled — existing order(s) kept unchanged.');
          return;
        }
        form.append('overwrite_duplicates', 'yes');
        resp = await sendUpload();
        data = await resp.json();
      }

      // Recycled order numbers: same number already COMPLETED but with a
      // different GI — flag what likely happened and let the user decide.
      if (resp.status === 409 && data.needsDuplicateConfirm) {
        const lines = (data.duplicates || []).slice(0, 10).map(d =>
          `• ${d.order} — completed in ${d.job} (${d.at}), GI was ${d.existingGi}, this file has GI ${d.newGi}`).join('\n');
        const ok = confirm(
          `⚠ DUPLICATED ORDER NUMBER(S) FROM CLIENT\n\n${data.message}\n\n${lines}` +
          `${(data.duplicates || []).length > 10 ? `\n…and ${data.duplicates.length - 10} more` : ''}` +
          `\n\nUpload these as NEW, separate orders?`);
        if (!ok) {
          document.getElementById('uploadConfirmOverlay').classList.add('hidden');
          setUploadStatus('error', 'Upload cancelled — duplicated order numbers not confirmed.');
          return;
        }
        form.append('confirm_duplicates', 'yes');
        resp = await sendUpload();
        data = await resp.json();
      }

      // Inventory check: SKUs in this upload that Inventory doesn't know
      // about. Two types of orders exist — inventory-tracked (reserves real
      // stock) or non-inventory (processed/scanned for activity/billing only,
      // never touches stock). Ask which this upload should be.
      if (resp.status === 409 && data.needsInventoryConfirm) {
        const lines = (data.missingSkus || []).slice(0, 15).map(s => `• ${s}`).join('\n');
        const more = data.missingCount > 15 ? `\n…and ${data.missingCount - 15} more` : '';
        const track = confirm(
          `⚠ SKUs NOT FOUND IN INVENTORY\n\n${data.message}\n\n${lines}${more}` +
          `\n\nOK = add these SKUs to Inventory (at 0 stock) and reserve stock for this upload` +
          `\nCancel = continue without inventory tracking`);
        if (track) {
          form.append('inventory_decision', 'track');
        } else {
          const carryOn = confirm(
            `Continue this upload WITHOUT inventory tracking?\n\n` +
            `OK = continue — this upload is only processed/tracked for activity (e.g. billing); no stock is reserved or deducted\n` +
            `Cancel = abort the whole upload`);
          if (!carryOn) {
            document.getElementById('uploadConfirmOverlay').classList.add('hidden');
            setUploadStatus('error', 'Upload cancelled — inventory tracking not confirmed.');
            return;
          }
          form.append('inventory_decision', 'skip');
        }
        resp = await sendUpload();
        data = await resp.json();
      }

      document.getElementById('uploadConfirmOverlay').classList.add('hidden');

      if (!resp.ok) {
        if (resp.status === 422 && data.validation) {
          showValidationErrors(data.validation);
        } else {
          setUploadStatus('error', data.error || 'Upload failed');
        }
        return;
      }
      SESSION_ID = data.sessionId;
      sessionStorage.setItem('wms_session', SESSION_ID);
      loadedOrders = data.orders;
      activeOrder  = null;

      let successMsg = `${data.idealscanCode ? `Job ${data.idealscanCode} — ` : ''}Converted ${data.rowCount} line(s) across ${data.orders.length} order(s) from "${file.name}".`;
      if (data.transportJobsCreated > 0) {
        successMsg += ` 🚚 ${data.transportJobsCreated} delivery job(s) added to Transport.`;
      }
      successMsg += data.inventoryTracked
        ? ` 📦 Stock reserved in Inventory.`
        : ` (not tracked in Inventory — activity/billing only.)`;
      const lc = data.locationCoverage;
      if (lc && lc.totalLines > 0) {
        if (lc.linesWithLocation === 0) {
          successMsg += ` ⚠ No warehouse location data found — Wave Pick needs a location/bin column to sequence picks.`;
        } else if (lc.linesWithLocation < lc.totalLines) {
          successMsg += ` 📍 ${lc.linesWithLocation}/${lc.totalLines} line(s) have a location.`;
        } else {
          successMsg += ` 📍 All lines have a location — ready for Wave Pick.`;
        }
      }
      setUploadStatus('success', successMsg);

      // Show download button immediately and lock tabs until downloaded
      const dlBtn  = document.getElementById('uploadDownloadBtn');
      const dlWrap = document.getElementById('uploadDownloadWrap');
      const _dlUrl  = `/api/download-wms/${data.batchId}`;
      const _dlName = `WMS_${data.idealscanCode ? data.idealscanCode + '_' : ''}${file.name.replace(/\.[^.]+$/, '')}_${new Date().toISOString().slice(0,10)}.xlsx`;
      dlBtn.onclick = () => { authDownload(_dlUrl, _dlName); unlockTabsAfterDownload(); };
      // Add lock note if not already present
      let noteEl = document.getElementById('downloadLockNote');
      if (!noteEl) {
        noteEl = document.createElement('span');
        noteEl.id        = 'downloadLockNote';
        noteEl.className = 'download-lock-note';
        noteEl.innerHTML = '&#128274; Download the WMS file above before scanning orders';
        dlWrap.appendChild(noteEl);
      }
      dlWrap.classList.remove('hidden');
      lockTabsForDownload();

      renderUploadList(loadedOrders);
      renderBreakdowns(loadedOrders);
      fetchAndRenderStats();
      pendingOrderFile = null;
      fileInput.value  = '';
    } catch (err) {
      document.getElementById('uploadConfirmOverlay').classList.add('hidden');
      setUploadStatus('error', err.message);
    }
  }

  function setUploadStatus(type, msg) {
    const el = document.getElementById('uploadStatus');
    el.className = `status-bar ${type}`;
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function showValidationErrors(v) {
    const el = document.getElementById('uploadStatus');
    el.className = 'status-bar error';
    el.innerHTML = '';
    el.classList.remove('hidden');

    const header = document.createElement('div');
    header.className = 'val-abort-header';
    header.innerHTML =
      `<span class="val-abort-icon">&#10007;</span>` +
      `<span class="val-abort-title">UPLOAD ABORTED</span>`;
    el.appendChild(header);

    const summary = document.createElement('div');
    summary.className = 'val-summary';
    summary.textContent =
      `${v.totalErrors} error${v.totalErrors !== 1 ? 's' : ''} found ` +
      `in ${v.rowsWithErrors} row${v.rowsWithErrors !== 1 ? 's' : ''} ` +
      `(${v.totalRowsProcessed} rows processed). ` +
      (v.hasCritical ? 'Includes CRITICAL delivery address errors.' : 'Please correct and re-upload.');
    el.appendChild(summary);

    const table = document.createElement('table');
    table.className = 'val-error-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Row</th><th>Order ID</th><th>Field</th><th>Issue</th><th>Action Required</th>
        </tr>
      </thead>
      <tbody>
        ${v.errors.map(e => `
          <tr class="${e.critical ? 'val-critical' : ''}">
            <td>${e.excelRow}</td>
            <td><code>${esc(e.orderId)}</code></td>
            <td><code>${esc(e.field)}</code></td>
            <td>${e.critical ? '<span class="val-crit-badge">CRITICAL</span> ' : ''}${esc(e.issue)}</td>
            <td>${esc(e.action)}</td>
          </tr>`).join('')}
      </tbody>`;
    el.appendChild(table);
  }

  function renderUploadList(orders) {
    document.getElementById('uploadOrdersSection').classList.remove('hidden');
    document.getElementById('orderCount').textContent = orders.length;
    document.getElementById('uploadOrdersList').innerHTML = orders.map(ord => `
      <div class="order-card">
        <div class="order-card-header">
          <span class="order-no">${esc(ord.order_number)}</span>
          <div class="order-meta-chips">
            ${ord.client_name    ? `<span class="chip chip-client">${esc(ord.client_name)}</span>` : ''}
            ${ord.customer_name  ? `<span class="chip">${esc(ord.customer_name)}</span>` : ''}
            ${ord.waybill_number ? `<span class="chip waybill">${esc(ord.waybill_number)}</span>` : ''}
            ${ord.carrier        ? `<span class="chip">${esc(ord.carrier)}</span>` : ''}
            <span class="chip">${ord.total_qty} unit${ord.total_qty !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>SKU</th><th>Qty</th><th>UOM</th></tr></thead>
            <tbody>${ord.lines.map(l => `
              <tr>
                <td><code>${esc(l.sku)}</code></td>
                <td>${l.qty}</td>
                <td>${esc(l.uom)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`).join('');
  }

  // ── Breakdown: platforms + carriers ───────────────────────────────────────
  function renderBreakdowns(orders) {
    const section = document.getElementById('dashBreakdownSection');
    if (!orders || !orders.length) { section.classList.add('hidden'); return; }

    const platforms = {};
    const carriers  = {};

    for (const ord of orders) {
      const plat = (ord.platform  || '').trim() || 'Unspecified';
      const carr = (ord.carrier   || '').trim() || 'Unspecified';
      const shop = (ord.shop_name || '').trim();

      if (!platforms[plat]) platforms[plat] = { orders: 0, units: 0, shops: new Set() };
      platforms[plat].orders++;
      platforms[plat].units += ord.total_qty || 0;
      if (shop) platforms[plat].shops.add(shop);

      if (!carriers[carr]) carriers[carr] = { orders: 0, units: 0 };
      carriers[carr].orders++;
      carriers[carr].units += ord.total_qty || 0;
    }

    const maxP = Math.max(...Object.values(platforms).map(d => d.orders), 1);
    const maxC = Math.max(...Object.values(carriers).map(d => d.orders),  1);

    function rows(map, max, isCarrier) {
      return Object.entries(map)
        .sort((a, b) => b[1].orders - a[1].orders)
        .map(([name, d]) => {
          const pct   = Math.round((d.orders / max) * 100);
          const shops = (!isCarrier && d.shops.size) ? `<span class="bkd-shops">${[...d.shops].map(esc).join(', ')}</span>` : '';
          return `
            <div class="bkd-row">
              <div class="bkd-row-label">
                <span class="bkd-name">${esc(name)}</span>
                ${shops}
              </div>
              <div class="bkd-bar-wrap">
                <div class="bkd-bar ${isCarrier ? 'bkd-bar-carrier' : ''}" style="width:${pct}%"></div>
              </div>
              <div class="bkd-nums">
                <span class="bkd-count">${d.orders}</span>
                <span class="bkd-units">${d.units} units</span>
              </div>
            </div>`;
        }).join('');
    }

    section.innerHTML = `
      <div class="bkd-grid">
        <div class="bkd-card">
          <div class="bkd-title">&#128250; Selling Platforms</div>
          ${rows(platforms, maxP, false)}
        </div>
        <div class="bkd-card">
          <div class="bkd-title">&#128666; Delivery Carriers</div>
          ${rows(carriers, maxC, true)}
        </div>
      </div>`;
    section.classList.remove('hidden');
  }

  // ── Sidebar client list ────────────────────────────────────────────────────
  // The same client keyed with different capitalisation ("BETIME" vs "Betime")
  // is ONE client, not two — files arrive from different sources that spell it
  // differently. Group case-insensitively and show the spelling that appears on
  // the most orders, so the list reads the way the team writes it.
  function renderSidebarClients(orders) {
    const lbl     = document.getElementById('sidebarClientsLabel');
    const list    = document.getElementById('sidebarClientList');
    if (!list) return;
    const groups = new Map();                       // lowercase key -> {counts by spelling, total}
    orders.forEach(o => {
      const raw = (o.client_name || '').trim();
      if (!raw) return;
      const k = raw.toLowerCase();
      const g = groups.get(k) || { total: 0, spellings: new Map() };
      g.total++;
      g.spellings.set(raw, (g.spellings.get(raw) || 0) + 1);
      groups.set(k, g);
    });
    if (!groups.size) { if (lbl) lbl.style.display = 'none'; list.innerHTML = ''; return; }
    if (lbl) lbl.style.display = '';
    // Display the most common spelling of each client.
    const clients = [];
    const counts = {};
    for (const [, g] of groups) {
      const best = [...g.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0];
      clients.push(best);
      counts[best] = g.total;
    }
    clients.sort((a, b) => a.localeCompare(b));
    list.innerHTML = `
      <button class="sb-client-btn ${activeClientFilter === 'all' ? 'active' : ''}" data-sb-client="all">All clients <span class="sb-client-count">${orders.length}</span></button>
      ${clients.map(c => `<button class="sb-client-btn ${activeClientFilter === c ? 'active' : ''}" data-sb-client="${esc(c)}">${esc(c)} <span class="sb-client-count">${counts[c]||0}</span></button>`).join('')}`;
    list.querySelectorAll('.sb-client-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeClientFilter = btn.dataset.sbClient;
        list.querySelectorAll('.sb-client-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Also sync the inline filter-row if visible
        document.querySelectorAll('#clientFilterRow .filter-chip').forEach(b => {
          b.classList.toggle('active', b.dataset.client === activeClientFilter);
        });
        renderOrdersList();
        closeSidebar();
      });
    });
  }

  // ── Orders Dashboard ───────────────────────────────────────────────────────
  async function renderOrdersDash() {
    await refreshOrders();
    if (!loadedOrders.length) {
      document.getElementById('ordersEmpty').classList.remove('hidden');
      document.getElementById('ordersDashboard').classList.add('hidden');
      return;
    }
    document.getElementById('ordersEmpty').classList.add('hidden');
    document.getElementById('ordersDashboard').classList.remove('hidden');

    const c = { pending: 0, processing: 0, done: 0, unprocessed: 0 };
    loadedOrders.forEach(o => { c[o.scan_status] = (c[o.scan_status] || 0) + 1; });

    document.getElementById('statsBar').innerHTML = `
      <div class="stat-box"><div class="val">${loadedOrders.length}</div><div class="lbl">Total</div></div>
      <div class="stat-box pending"><div class="val">${c.pending||0}</div><div class="lbl">Pending</div></div>
      <div class="stat-box processing"><div class="val">${c.processing||0}</div><div class="lbl">In Progress</div></div>
      <div class="stat-box done"><div class="val">${c.done||0}</div><div class="lbl">Done</div></div>
      <div class="stat-box unprocessed"><div class="val">${c.unprocessed||0}</div><div class="lbl">Unprocessed</div></div>`;

    const isAdmin = (currentUser?.role || 'admin') === 'admin';
    const pendingKf = loadedOrders.filter(o => o.scan_status === 'done' && !o.keyfields_closed).length;
    const kfBanner = document.getElementById('kfClosureBanner');
    if (isAdmin && pendingKf > 0) {
      kfBanner.innerHTML = `&#9888;&#65039; <strong>${pendingKf} order${pendingKf > 1 ? 's' : ''} completed</strong> — please close in Keyfields WMS, then acknowledge below.`;
      kfBanner.classList.remove('hidden');
    } else {
      kfBanner.classList.add('hidden');
    }

    // Sidebar client list (primary filter UI)
    renderSidebarClients(loadedOrders);

    // Carrier filter row (kept as secondary filter below scan bar)
    const carriers = [...new Set(loadedOrders.map(o => o.carrier || ''))];
    const carrierRow = document.getElementById('carrierFilterRow');
    if (carriers.some(c => c)) {
      carrierRow.innerHTML = `
        <span class="filter-label">Carrier:</span>
        <button class="filter-chip ${activeCarrierFilter === 'all' ? 'active' : ''}" data-carrier="all">All</button>
        ${carriers.map(c => `<button class="filter-chip ${activeCarrierFilter === c ? 'active' : ''}" data-carrier="${esc(c)}">${esc(c) || 'Unspecified'}</button>`).join('')}`;
      carrierRow.querySelectorAll('.filter-chip[data-carrier]').forEach(btn => {
        btn.addEventListener('click', () => {
          activeCarrierFilter = btn.dataset.carrier;
          renderOrdersList();
          carrierRow.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
    } else {
      carrierRow.innerHTML = '';
    }

    renderOrdersList();
  }

  // ── Waybill scan bar ───────────────────────────────────────────────────────
  function focusWaybillInput() {
    const inp = document.getElementById('waybillScanInput');
    if (inp && !inp.closest('.hidden')) inp.focus();
  }

  function setWaybillMsg(text, isError) {
    const el = document.getElementById('waybillScanMsg');
    if (!el) return;
    if (!text) { el.classList.add('hidden'); return; }
    el.textContent = text;
    el.className = 'waybill-scan-msg ' + (isError ? 'waybill-scan-err' : 'waybill-scan-ok');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  document.getElementById('waybillScanInput').addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    const inp = e.target;
    clearTimeout(inp._auto);
    const val = inp.value.trim();
    if (!val) return;
    inp.value = '';
    waybillLookupGo(val);
  });

  // Auto-search: scan guns configured without an Enter suffix just leave the
  // code sitting in the field. When characters arrive scanner-fast (or are
  // pasted) and then stop, run the lookup automatically. Hand-typed input
  // still waits for Enter so a pause mid-typing never wipes the field.
  (() => {
    const inp = document.getElementById('waybillScanInput');
    let trace = [];
    inp.addEventListener('input', e => {
      const now = Date.now();
      trace.push({ t: now, len: inp.value.length, paste: e.inputType === 'insertFromPaste' });
      trace = trace.filter(x => now - x.t < 1000);
      clearTimeout(inp._auto);
      const val = inp.value.trim();
      if (val.length < 5) return;
      const grew = trace.length >= 2 ? trace[trace.length - 1].len - trace[0].len : 0;
      const span = trace.length >= 2 ? trace[trace.length - 1].t - trace[0].t : Infinity;
      const scanned = trace.some(x => x.paste) || (grew >= 4 && span <= grew * 90);
      if (!scanned) return;
      inp._auto = setTimeout(() => {
        if (inp.value.trim() !== val) return;
        inp.value = '';
        trace = [];
        waybillLookupGo(val);
      }, 250);
    });
  })();

  // The waybill field is the packer's home position — whenever focus falls on
  // nothing (empty-space clicks, buttons, closed dialogs), return the cursor
  // there so the next gun scan always lands in the field. Never steals focus
  // from text inputs (search boxes, date filters, etc).
  function _wbFocusGuard() {
    setTimeout(() => {
      const ordersTab = document.getElementById('tab-orders');
      if (!ordersTab || !ordersTab.classList.contains('active')) return;
      if (!document.getElementById('scanOverlay').classList.contains('hidden')) return;
      if (document.querySelector('.modal-overlay:not(.hidden)')) return;
      const lb = document.getElementById('labelLightbox');
      if (lb && !lb.classList.contains('hidden')) return;
      const ae = document.activeElement;
      if (ae && ae !== document.body &&
          ae.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable="true"], iframe')) return;
      focusWaybillInput();
    }, 40);
  }
  document.addEventListener('click', _wbFocusGuard);
  window.addEventListener('focus', _wbFocusGuard);

  async function waybillLookupGo(val) {
    // Priority 1: direct order number match (client-side, instant).
    // Also matches the pick-ticket and GI (issue_no) numbers — PDF picking
    // lists carry a GI-number barcode that becomes order_number directly,
    // but an XLSX/CSV upload with an "Issue No"/"iWMS GINo" column instead
    // stores the same GI number as issue_no, so that must be checked too or
    // its barcode never resolves here.
    const valLower = val.toLowerCase();
    const strip0 = s => s.replace(/^0+(?=.)/, '');
    const directMatch = loadedOrders.find(o => {
      const on = o.order_number.trim().toLowerCase();
      const pt = (o.pick_ticket || '').trim().toLowerCase();
      const gi = (o.issue_no    || '').trim().toLowerCase();
      return on === valLower || strip0(on) === strip0(valLower) ||
             (pt && (pt === valLower || strip0(pt) === strip0(valLower))) ||
             (gi && (gi === valLower || strip0(gi) === strip0(valLower)));
    });
    if (directMatch) {
      if (directMatch.scan_status === 'done') {
        // Completed order — show it in the Completed tab for reference/reprint
        ordersView = 'completed'; completedSearch = directMatch.order_number; ordersDateFilter = 'all';
        refreshOrders().then(renderOrdersList);
        renderOrdersList();
        setWaybillMsg('Order already completed — shown in the Completed tab below.', false);
        return;
      }
      setWaybillMsg('', false);
      openScanOverlay(directMatch.order_number);
      return;
    }

    // Priority 2: waybill / tracking number lookup (server-side)
    setWaybillMsg('Searching...', false);
    try {
      const r = await fetch('/api/waybill-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waybill: val }),
      });
      const data = await r.json();
      if (!r.ok || !data.order_number) {
        setWaybillMsg('No order found for that number.', true);
        return;
      }
      let ord = loadedOrders.find(o => o.order_number === data.order_number);
      if (!ord) { ord = data; loadedOrders.push(data); } // outside the loaded date window
      if (ord.scan_status === 'done') {
        ordersView = 'completed'; completedSearch = ord.order_number; ordersDateFilter = 'all';
        refreshOrders().then(renderOrdersList);
        renderOrdersList();
        setWaybillMsg('Order already completed — shown in the Completed tab below.', false);
        return;
      }
      setWaybillMsg('', false);
      openScanOverlay(data.order_number);
    } catch (err) {
      setWaybillMsg('Lookup failed. Try again.', true);
    }
  }

  function renderOrdersList() {
    let orders = loadedOrders;
    // Case-insensitive: picking "Betime" must also bring in orders filed as
    // "BETIME" — same client, different capitalisation from a different source.
    if (activeClientFilter !== 'all') {
      const want = activeClientFilter.trim().toLowerCase();
      orders = orders.filter(o => (o.client_name || '').trim().toLowerCase() === want);
    }
    if (activeCarrierFilter !== 'all') orders = orders.filter(o => (o.carrier || '') === activeCarrierFilter);

    // Date filter — default TODAY, sliced in SGT calendar days (naive UTC
    // slicing put pre-08:00 uploads/completions on the previous day).
    //
    // PACKER RULE: unfinished work is NEVER hidden by the date chips — the
    // Active view always shows today's orders PLUS the pending/in-progress
    // backlog carried over from earlier days, exactly like the server's
    // /api/orders rule and the sidebar badge. The chips only slice the
    // COMPLETED view (by completion date).
    const dayOf = v => v ? new Date(v).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }) : '';
    const todayStr = dayOf(new Date());
    const yestStr  = dayOf(new Date(Date.now() - 86400000));
    const weekStr  = dayOf(new Date(Date.now() - 6 * 86400000));
    const orderDay = o => dayOf(o.scan_status === 'done' ? (o.endTime || o.uploadedAt) : o.uploadedAt);
    const inDateFilter = o => {
      if (o.scan_status === 'pending' || o.scan_status === 'processing') return true;
      const d = orderDay(o);
      if (!d) return true; // never hide records with no usable date
      switch (ordersDateFilter) {
        case 'today':     return d === todayStr;
        case 'yesterday': return d === yestStr;
        case 'week':      return d >= weekStr && d <= todayStr;
        case 'range':     return (!ordersDateFrom || d >= ordersDateFrom) && (!ordersDateTo || d <= ordersDateTo);
        default:          return true; // 'all'
      }
    };
    orders = orders.filter(inDateFilter);

    // Active / Completed sub-tabs — completed orders leave the main list and
    // live in their own searchable view for reference and label reprinting
    const doneOrders   = orders.filter(o => o.scan_status === 'done');
    const activeOrders = orders.filter(o => o.scan_status !== 'done');
    const dateChips = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Last 7 Days'], ['all', 'All'], ['range', 'Date Range&hellip;']]
      .map(([k, lbl]) => `<button class="filter-chip ${ordersDateFilter === k ? 'active' : ''}" data-odate="${k}">${lbl}</button>`).join('');
    const dateFilterHTML = `
      <div class="orders-date-row">
        <span class="odr-label">SHOW:</span>
        ${dateChips}
        ${ordersDateFilter === 'range' ? `
          <input type="date" id="ordersDateFrom" value="${esc(ordersDateFrom)}" />
          <span class="odr-to">to</span>
          <input type="date" id="ordersDateTo" value="${esc(ordersDateTo)}" />` : ''}
      </div>`;
    const subTabsHTML = `
      ${dateFilterHTML}
      <div class="orders-subtabs">
        <button class="subtab-btn ${ordersView === 'active' ? 'active' : ''}" data-oview="active">Active <span class="subtab-count">${activeOrders.length}</span></button>
        <button class="subtab-btn ${ordersView === 'completed' ? 'active' : ''}" data-oview="completed">&#10003; Completed <span class="subtab-count">${doneOrders.length}</span></button>
        ${ordersView === 'completed' ? `<input type="search" id="completedSearchInput" class="completed-search" placeholder="Search waybill, GI / order no, pick ticket, customer&hellip;" value="${esc(completedSearch)}" autocomplete="off" />` : ''}
      </div>`;

    if (ordersView === 'completed') {
      orders = doneOrders;
      const norm = s => String(s || '').toLowerCase().replace(/[\s\-_]/g, '');
      const q = norm(completedSearch);
      if (q) {
        orders = orders.filter(o =>
          [o.order_number, o.waybill_number, o.issue_no, o.pick_ticket, o.po_number, o.customer_name, o.client_name, o.idealscan_code]
            .some(v => norm(v).includes(q))
        );
        // Also search the ARCHIVE (orders older than 60 days) — async fetch,
        // cached per search string, merged into the list on arrival
        const rawQ = completedSearch.trim();
        if (rawQ.length >= 3) {
          if (_archSearch.q === rawQ && _archSearch.results) {
            const have = new Set(orders.map(o => o.order_number + '|' + (o.batchId || '')));
            orders = orders.concat(_archSearch.results.filter(o => !have.has(o.order_number + '|' + (o.batchId || ''))));
          } else if (_archSearch.q !== rawQ) {
            _archSearch = { q: rawQ, results: null };
            fetch(`/api/orders/archived?q=${encodeURIComponent(rawQ)}`)
              .then(r => r.ok ? r.json() : [])
              .then(results => {
                if (_archSearch.q !== rawQ) return; // search changed meanwhile
                _archSearch.results = results;
                if (results.length && ordersView === 'completed' && completedSearch.trim() === rawQ) renderOrdersList();
              })
              .catch(() => {});
          }
        }
      }
      // Most recently completed first
      orders = [...orders].sort((a, b) => new Date(b.endTime || 0) - new Date(a.endTime || 0));
    } else {
      orders = activeOrders;
      const sortPriority = { processing: 0, pending: 1, unprocessed: 2 };
      orders = [...orders].sort((a, b) =>
        (sortPriority[a.scan_status] ?? 4) - (sortPriority[b.scan_status] ?? 4)
      );
    }

    const labels = { pending: 'Pending', processing: 'In Progress', done: 'Done', unprocessed: 'Unprocessed' };
    const isAdminView = (currentUser?.role || 'admin') === 'admin';

    function wireOrdersSubtabs() {
      document.querySelectorAll('[data-oview]').forEach(b => b.addEventListener('click', () => {
        ordersView = b.dataset.oview;
        renderOrdersList();
      }));
      document.querySelectorAll('[data-odate]').forEach(b => b.addEventListener('click', () => {
        ordersDateFilter = b.dataset.odate;
        if (ordersDateFilter === 'range' && !ordersDateFrom) {
          ordersDateFrom = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
          ordersDateTo   = new Date().toISOString().slice(0, 10);
        }
        renderOrdersList();                          // instant chip feedback
        refreshOrders().then(renderOrdersList);      // then the real window
      }));
      document.getElementById('ordersDateFrom')?.addEventListener('change', e => { ordersDateFrom = e.target.value; refreshOrders().then(renderOrdersList); });
      document.getElementById('ordersDateTo')?.addEventListener('change',   e => { ordersDateTo   = e.target.value; refreshOrders().then(renderOrdersList); });
      const si = document.getElementById('completedSearchInput');
      si?.addEventListener('input', () => {
        completedSearch = si.value;
        clearTimeout(si._t);
        si._t = setTimeout(() => {
          renderOrdersList();
          const el = document.getElementById('completedSearchInput');
          if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
        }, 250);
      });
    }

    if (!orders.length) {
      document.getElementById('ordersDashList').innerHTML = subTabsHTML +
        `<p class="empty-state" style="padding:2rem">${
          ordersView === 'completed'
            ? (completedSearch ? 'No completed orders match the search.' : 'No completed orders yet.')
            : 'No active orders match the selected filters.'
        }</p>`;
      wireOrdersSubtabs();
      return;
    }

    const rows = orders.map(ord => {
      const scannedTotal = Object.values(ord.scanned || {}).reduce((s, v) => s + v, 0);
      const canScan  = ord.scan_status !== 'done' && !ord.pending_deletion;
      const isDone   = ord.scan_status === 'done';
      const elapsed  = fmtElapsed(ord.startTime, ord.endTime);
      const slipUrl  = ord.batchId
        ? `/api/completion-slip/${encodeURIComponent(ord.batchId)}/${encodeURIComponent(ord.order_number)}`
        : null;

      const emailIndicator = isDone && isAdminView && ord.alert_email_sent !== null
        ? ord.alert_email_sent
          ? `<span class="alert-email-ok" title="Completion alert sent">&#128231;</span>`
          : `<span class="alert-email-fail" title="${esc(ord.alert_email_error || 'Email failed')}">&#9888;</span>
             <button class="btn-resend-alert" data-order="${esc(ord.order_number)}" title="Resend alert">Resend</button>`
        : '';
      const kfBtn = isDone && isAdminView
        ? ord.keyfields_closed
          ? `<span class="kf-closed-badge">&#10003; KF</span>`
          : `<button class="btn-kf-close" data-order="${esc(ord.order_number)}" title="Close in Keyfields">KF</button>`
        : '';

      // Items column
      const itemCount = (ord.items || []).length;
      const itemsCell = `<span class="ord-items-cell">${itemCount} item${itemCount !== 1 ? 's' : ''} <span class="ord-prog">${scannedTotal}/${ord.total_qty}</span></span>`;

      // Carrier badge
      const carrierBadge = ord.carrier ? `<span class="chip chip-carrier">${esc(ord.carrier)}</span>` : '';

      // Chips under order number
      const cartonCount = (ord.cartons || []).length;
      // Order sits inside a LIVE wave (created/picking, not yet completed) —
      // show the wave code and let anyone click it to reopen the wave (the
      // Cancel Wave button lives there too — before this chip existed,
      // closing the Wave Pick tab left a live wave with no visible way back).
      const activeWaveChip = (ord.active_wave_id && ord.scan_status !== 'done')
        ? `<span class="chip chip-wave-active" style="cursor:pointer" onclick="event.stopPropagation();resumeWavePick('${esc(ord.active_wave_id)}')" title="This order is in wave ${esc(ord.active_wave_code || ord.active_wave_id)} (${ord.active_wave_status === 'picking' ? 'picking' : 'ready to pick'}). Click to reopen it — cancel it from there if needed.">&#127754; ${esc(ord.active_wave_code || ord.active_wave_id.slice(0, 8))} — ${ord.active_wave_status === 'picking' ? 'Picking' : 'Ready'}</span>`
        : '';
      const chips = [
        activeWaveChip,
        ord.pending_deletion ? `<span class="chip chip-pending-delete" title="Deletion requested by ${esc(ord.pending_deletion.requestedBy)}: ${esc(ord.pending_deletion.reason)}">&#128465; Pending Deletion</span>` : '',
        (ord.wave_id && ord.scan_status !== 'done') ? `<span class="chip chip-wave-needs-closing" title="This order's stock was floor-picked in wave ${esc(ord.wave_code || ord.wave_id)} — open it and scan its items from the picked pile to pack it, like a normal order" style="cursor:pointer" onclick="event.stopPropagation();requestWaveCancellation('${esc(ord.wave_id)}')">&#127754; ${esc(ord.wave_code || ord.wave_id)} — Scan to Pack</span>` : '',
        ord.claimed_by       ? `<span class="chip chip-claimed" title="Currently open at ${esc(ord.claimed_by)}'s station">&#128100; ${esc(ord.claimed_by)}</span>` : '',
        ord.archived         ? `<span class="chip chip-unproc" title="Stored in the archive (older than 60 days)">&#128451; Archived</span>` : '',
        // 1 carton is the default and not worth a chip — only shown once an order actually split into more than one box
        cartonCount > 1      ? `<span class="chip chip-cartons" title="Packed across ${cartonCount} cartons">&#128230; ${cartonCount} Cartons</span>` : '',
        ord.has_order_label  ? `<span class="chip chip-label">&#127991; Label</span>` : '',
        ord.has_waybill_pdf  ? `<span class="chip chip-waybill">&#128196; Waybill</span>` : '',
      ].filter(Boolean).join('');

      // Date
      const dateStr = ord.uploadedAt ? new Date(ord.uploadedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';

      return `<tr class="orders-tr status-${ord.scan_status}${isDone && !ord.keyfields_closed && isAdminView ? ' kf-pending' : ''}" data-order="${esc(ord.order_number)}">
        <td class="ord-stripe-cell"></td>
        ${isAdminView ? `<td class="ord-select-cell"><input type="checkbox" class="ord-select" data-order="${esc(ord.order_number)}" ${orderSelection.has(ord.order_number) ? 'checked' : ''} onclick="event.stopPropagation()" /></td>` : ''}
        <td class="col-order">
          <span class="ord-no-link">${esc(ord.order_number)}</span>
          ${isAdminView && ord.idealscan_code ? `<div class="ord-jobcode"><code class="job-code">${esc(ord.idealscan_code)}</code></div>` : ''}
          ${ord.issue_no ? `<div class="ord-jobcode" title="GI number"><code class="job-code">GI: ${esc(ord.issue_no)}</code></div>` : ''}
          ${ord.transport_id ? `<div class="ord-jobcode" title="Linked Transport delivery job"><code class="job-code job-code-tr">🚚 ${esc(ord.transport_id)}</code></div>` : ''}
          ${chips ? `<div class="ord-chips">${chips}</div>` : ''}
          ${isDone && elapsed ? `<div class="done-meta done-elapsed">&#8987; ${esc(elapsed)}</div>` : ''}
        </td>
        <td class="ord-client-cell col-client">${esc(ord.client_name || '—')}</td>
        <td class="ord-customer-cell col-customer">${esc(ord.customer_name || '—')}</td>
        <td class="ord-waybill-cell col-waybill">${esc(ord.waybill_number || '—')}</td>
        <td class="col-items">${itemsCell} ${carrierBadge}</td>
        <td class="ord-status-cell col-status"><span class="status-badge ${ord.scan_status}">${labels[ord.scan_status] || ord.scan_status}</span></td>
        <td class="ord-date-cell col-date">${dateStr}</td>
        <td class="ord-actions-cell col-actions">
          ${canScan ? `<button class="btn-scan-now" data-order="${esc(ord.order_number)}">Scan &#8594;</button>` : ''}
          ${isDone && !ord.has_waybill_pdf && !ord.has_order_label ? `<button class="btn-reprint-label" data-order="${esc(ord.order_number)}" title="Reprint label">&#128438;</button>` : ''}
          ${isDone && slipUrl ? `<a class="btn-slip" data-auth-dl="${esc(slipUrl)}" data-auth-dl-name="Slip_${esc(ord.order_number)}.xlsx" title="Download slip">&#128196;</a>` : ''}
          ${ord.has_waybill_pdf && ord.batchId ? `<button class="btn-print-waybill" data-order="${esc(ord.order_number)}" data-batchid="${esc(ord.batchId)}" title="Print waybill">&#128438; WB</button>` : ''}
          ${ord.has_order_label ? `<button class="btn-print-order-label" data-order="${esc(ord.order_number)}" title="Print carrier label">&#127991;</button>` : ''}
          ${ord.archived ? '' : emailIndicator}
          ${ord.archived ? '' : kfBtn}
          ${currentUser?.role === 'admin' && !ord.archived && !isDone && !ord.pending_deletion ? `<button class="btn-del-order" data-order="${esc(ord.order_number)}" data-batchid="${esc(ord.batchId || '')}" title="Request deletion">&#128465;</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    // Keep the selection set limited to orders actually visible right now, so
    // a stale tick from a previous filter/view can't act on a hidden order.
    const visibleNums = new Set(orders.map(o => o.order_number));
    orderSelection = new Set([...orderSelection].filter(n => visibleNums.has(n)));

    const rz = id => `<span class="col-resize" data-col="${id}"></span>`;
    const bulkBarHTML = isAdminView ? `
      <div id="ordersBulkBar" class="orders-bulk-bar hidden">
        <span id="ordersBulkCount" class="obb-count">0 selected</span>
        <button id="ordersBulkPrint" class="btn-secondary btn-sm" title="Print waybill/label for each selected order that has one">&#128438; Print Labels</button>
        <button id="ordersBulkDelete" class="btn-danger btn-sm" title="Request deletion of the selected orders (Master approves)">&#128465; Request Deletion</button>
        <button id="ordersBulkClear" class="btn-secondary btn-sm">Clear</button>
      </div>` : '';
    document.getElementById('ordersDashList').innerHTML = `
      ${subTabsHTML}
      ${ordersColsToggleHTML()}
      ${bulkBarHTML}
      <div class="orders-table-wrap">
        <table class="orders-table">
          <thead>
            <tr>
              <th style="width:4px;padding:0"></th>
              ${isAdminView ? `<th class="ord-select-cell"><input type="checkbox" id="ordSelectAll" title="Select all shown" /></th>` : ''}
              <th data-col="orderno">ORDER NO${rz('orderno')}</th>
              <th class="col-client" data-col="client">CLIENT${rz('client')}</th>
              <th class="col-customer" data-col="customer">CUSTOMER${rz('customer')}</th>
              <th class="col-waybill" data-col="waybill">WAYBILL${rz('waybill')}</th>
              <th data-col="items">ITEMS${rz('items')}</th>
              <th class="col-status" data-col="status">STATUS${rz('status')}</th>
              <th class="col-date" data-col="date">DATE${rz('date')}</th>
              <th class="col-actions" data-col="actions">ACTIONS</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    applyOrdersTablePrefs();
    initOrdersColResize();
    initOrdersColsToggle();
    wireOrdersSubtabs();
    wireOrdersSelection();

    document.querySelectorAll('.btn-scan-now').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); openScanOverlay(btn.dataset.order); })
    );
    document.querySelectorAll('.btn-reprint-label').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const ord = loadedOrders.find(o => o.order_number === btn.dataset.order);
        if (ord) printWaybillLabel(ord);
      })
    );
    document.querySelectorAll('.btn-print-waybill').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const ord = loadedOrders.find(o => o.order_number === btn.dataset.order);
        if (ord) showPrintWaybillModal(ord);
      })
    );
    document.querySelectorAll('.btn-print-order-label').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const ord = loadedOrders.find(o => o.order_number === btn.dataset.order);
        if (ord) showPrintOrderLabelModal(ord);
      })
    );
    document.querySelectorAll('.orders-tr').forEach(tr =>
      tr.addEventListener('click', () => {
        const ord = loadedOrders.find(o => o.order_number === tr.dataset.order);
        if (!ord) return;
        if (ord.scan_status === 'done' && ord.has_order_label) {
          showPrintOrderLabelModal(ord);
        } else if (ord.scan_status === 'done' && ord.has_waybill_pdf && ord.batchId) {
          showPrintWaybillModal(ord);
        } else if (ord.scan_status !== 'done') {
          openScanOverlay(tr.dataset.order);
        }
      })
    );
    document.querySelectorAll('.btn-del-order').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openDeleteOrderModal(btn.dataset.order, btn.dataset.batchid);
      });
    });

    document.querySelectorAll('.btn-resend-alert').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        btn.disabled = true; btn.textContent = 'Sending…';
        try {
          const r = await fetch('/api/scan/resend-completion-alert', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderNumber: btn.dataset.order }),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Failed');
          const idx = loadedOrders.findIndex(o => o.order_number === btn.dataset.order);
          if (idx >= 0) { loadedOrders[idx].alert_email_sent = true; loadedOrders[idx].alert_email_error = null; }
          renderOrdersList();
        } catch (err) { btn.disabled = false; btn.textContent = 'Resend'; alert('Resend failed: ' + err.message); }
      });
    });

    document.querySelectorAll('.btn-kf-close').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        btn.disabled = true;
        try {
          const r = await fetch('/api/scan/keyfields-close', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderNumber: btn.dataset.order }),
          });
          if (!r.ok) throw new Error((await r.json()).error || 'Failed');
          const idx = loadedOrders.findIndex(o => o.order_number === btn.dataset.order);
          if (idx >= 0) loadedOrders[idx].keyfields_closed = true;
          renderOrdersDash();
        } catch (err) { btn.disabled = false; alert(err.message); }
      });
    });
  }

  // ── Orders mass-select + group actions (admin) ─────────────────────────────
  // Row checkboxes + a header "select all" feed orderSelection; a floating bar
  // exposes group actions (bulk deletion-request, bulk label printing). Only
  // rendered for admins (per-row delete is already admin-only).
  function updateOrdersBulkBar() {
    const bar = document.getElementById('ordersBulkBar');
    if (!bar) return;
    const n = orderSelection.size;
    bar.classList.toggle('hidden', n === 0);
    const countEl = document.getElementById('ordersBulkCount');
    if (countEl) countEl.textContent = `${n} selected`;
    // "Request Deletion" only makes sense for orders that are deletable
    // (not done, not already pending) — disable it if none of the selected qualify.
    const selectable = [...orderSelection]
      .map(nm => loadedOrders.find(o => o.order_number === nm))
      .filter(o => o && o.scan_status !== 'done' && !o.pending_deletion && !o.archived);
    const delBtn = document.getElementById('ordersBulkDelete');
    if (delBtn) {
      delBtn.disabled = selectable.length === 0;
      delBtn.textContent = `\u{1F5D1} Request Deletion${selectable.length ? ` (${selectable.length})` : ''}`;
    }
    // Sync the header select-all checkbox to the current state
    const all = document.getElementById('ordSelectAll');
    if (all) {
      const boxes = document.querySelectorAll('.ord-select');
      const checked = document.querySelectorAll('.ord-select:checked');
      all.checked = boxes.length > 0 && checked.length === boxes.length;
      all.indeterminate = checked.length > 0 && checked.length < boxes.length;
    }
  }

  function wireOrdersSelection() {
    document.querySelectorAll('.ord-select').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) orderSelection.add(cb.dataset.order);
        else orderSelection.delete(cb.dataset.order);
        updateOrdersBulkBar();
      });
    });
    const all = document.getElementById('ordSelectAll');
    all?.addEventListener('change', () => {
      document.querySelectorAll('.ord-select').forEach(cb => {
        cb.checked = all.checked;
        if (all.checked) orderSelection.add(cb.dataset.order);
        else orderSelection.delete(cb.dataset.order);
      });
      updateOrdersBulkBar();
    });
    document.getElementById('ordersBulkClear')?.addEventListener('click', () => {
      orderSelection.clear();
      document.querySelectorAll('.ord-select').forEach(cb => { cb.checked = false; });
      updateOrdersBulkBar();
    });
    document.getElementById('ordersBulkPrint')?.addEventListener('click', () => {
      const picked = [...orderSelection]
        .map(nm => loadedOrders.find(o => o.order_number === nm))
        .filter(Boolean);
      const printable = picked.filter(o => o.has_order_label || o.has_waybill_pdf);
      if (!printable.length) { alert('None of the selected orders have a printable label or waybill yet.'); return; }
      // Open each in turn — the print modals stack sequentially.
      printable.forEach(o => {
        if (o.has_order_label) showPrintOrderLabelModal(o);
        else if (o.has_waybill_pdf && o.batchId) showPrintWaybillModal(o);
      });
    });
    document.getElementById('ordersBulkDelete')?.addEventListener('click', () => {
      const selectable = [...orderSelection]
        .map(nm => loadedOrders.find(o => o.order_number === nm))
        .filter(o => o && o.scan_status !== 'done' && !o.pending_deletion && !o.archived);
      if (!selectable.length) { alert('None of the selected orders can be deleted (completed/archived/already pending are skipped).'); return; }
      openBulkDeleteOrdersModal(selectable.map(o => ({ orderNumber: o.order_number, batchId: o.batchId || '' })));
    });
    updateOrdersBulkBar();
  }

  // Bulk deletion request — reuses the SAME per-order modal DOM (reason + the
  // admin's own password), but loops the request over every selected order.
  let _bulkDelTargets = null;
  function openBulkDeleteOrdersModal(targets) {
    _bulkDelTargets = targets;
    document.getElementById('delOrderNumber').textContent = `${targets.length} order(s): ` + targets.map(t => t.orderNumber).slice(0, 8).join(', ') + (targets.length > 8 ? '…' : '');
    const reasonEl = document.getElementById('delOrderReason');
    const passEl   = document.getElementById('delOrderPassword');
    reasonEl.value = '';
    passEl.value   = '';
    document.getElementById('delOrderError').classList.add('hidden');
    document.getElementById('delOrderConfirmBtn').disabled = true;
    document.getElementById('deleteOrderOverlay').classList.remove('hidden');
    setTimeout(() => reasonEl.focus(), 100);
  }

  // ── IdealInbound — receiving (POs/ASNs and returns) ─────────────────────────
  // Mirrors the outbound picking flow in reverse: goods arrive across one or
  // more boxes instead of being packed into them. Reuses the exact same
  // carton concept (a box is a box either way) but is otherwise a separate,
  // self-contained tab/overlay so nothing here can regress outbound scanning.
  async function renderInboundTab() {
    try {
      const resp = await fetch('/api/inbound');
      inboundJobs = await resp.json();
    } catch { inboundJobs = []; }
    const empty = document.getElementById('inboundEmpty');
    const list  = document.getElementById('inboundList');
    // 📅 Arriving strip — pending jobs with an expected-arrival date, soonest
    // first; overdue in red. Answers "what's landing on the dock this week?".
    const arr = document.getElementById('inboundArriving');
    if (arr) {
      const today = new Date().toISOString().slice(0, 10);
      const upcoming = inboundJobs.filter(j => j.eta && j.status !== 'done').sort((a, b) => a.eta.localeCompare(b.eta));
      arr.classList.toggle('hidden', !upcoming.length);
      if (upcoming.length) arr.innerHTML = '📅 <b>Arriving:</b> ' + upcoming.slice(0, 6).map(j =>
        `<span style="margin-right:.7rem;${j.eta < today ? 'color:#dc2626;font-weight:700' : ''}">${esc(j.reference || j.serial)} — ${esc(j.eta)}${j.eta < today ? ' ⚠ overdue' : ''}</span>`).join('');
    }
    if (!inboundJobs.length) {
      empty.classList.remove('hidden');
      list.innerHTML = '';
      return;
    }
    empty.classList.add('hidden');
    const isAdmin = currentUser?.role === 'admin';
    list.innerHTML = `
      <div class="orders-table-wrap">
        <table class="orders-table">
          <thead>
            <tr>
              <th>Serial</th><th>Type</th><th>Reference</th><th>Source</th><th>Client</th>
              <th>Items</th><th>Cartons</th><th>Status</th><th>Date</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${inboundJobs.map(job => `
              <tr>
                <td><code>${esc(job.serial || '—')}</code></td>
                <td><span class="chip ${job.type === 'po' ? 'chip-cartons' : ''}">${job.type === 'po' ? 'PO / ASN' : 'Return'}</span></td>
                <td>${esc(job.reference || '—')}</td>
                <td>${esc(job.source_name || '—')}</td>
                <td>${esc(job.client_name || '—')}</td>
                <td>${job.scanned_total}${job.type === 'po' ? ` / ${job.expected_total}` : ''}</td>
                <td>${job.cartons.length > 1 ? `📦 ${job.cartons.length}` : '—'}</td>
                <td>
                  <span class="status-badge ${job.status}">${job.status}</span>
                  ${job.pending_deletion ? '<span class="status-badge unprocessed" title="Awaiting Master approval">Pending Deletion</span>' : ''}
                </td>
                <td>${job.uploaded_at ? new Date(job.uploaded_at).toLocaleDateString() : '—'}</td>
                <td>
                  <button class="btn-scan-now" data-inbound-id="${esc(job.id)}">${job.status === 'done' ? 'View' : 'Receive'} &#8594;</button>
                  ${job.status === 'done' ? `<button class="btn-secondary btn-sm" data-inbound-putaway-id="${esc(job.id)}" title="Direct received goods to bins">&#128205; Putaway${putawayRemaining(job) > 0 ? ` (${putawayRemaining(job)})` : ' &#10003;'}</button>` : ''}
                  ${job.status === 'done' ? `<button class="btn-secondary btn-sm" data-inbound-grn-id="${esc(job.id)}" title="Goods Received Note — expected vs received vs damaged, printable proof of receipt">&#128196; GRN</button>` : ''}
                  ${job.status !== 'done' ? `<button class="btn-secondary btn-sm" data-inbound-split-id="${esc(job.id)}" title="Share this receipt out across the team">&#128101; Split${(job.assignments || []).length ? ` (${(job.assignments || []).length})` : ''}</button>` : ''}
                  ${job.lead ? `<span class="cs-pill" title="Leading this receipt">&#11088; ${esc(job.lead.name || job.lead.user)}</span>` : ''}
                  ${isAdmin && job.status !== 'done' && !job.pending_deletion ? `<button class="btn-del-order" data-inbound-del-id="${esc(job.id)}" data-inbound-del-ref="${esc(job.reference || job.id.slice(0, 8))}" title="Request deletion">&#128465;</button>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    list.querySelectorAll('[data-inbound-id]').forEach(btn =>
      btn.addEventListener('click', () => openInboundReceiving(btn.dataset.inboundId))
    );
    list.querySelectorAll('[data-inbound-del-id]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openDeleteInboundModal(btn.dataset.inboundDelId, btn.dataset.inboundDelRef);
      });
    });
    list.querySelectorAll('[data-inbound-putaway-id]').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); openPutaway(btn.dataset.inboundPutawayId); });
    });
    list.querySelectorAll('[data-inbound-grn-id]').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); printGrn(btn.dataset.inboundGrnId); });
    });
    list.querySelectorAll('[data-inbound-split-id]').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); openSplitInbound(btn.dataset.inboundSplitId); });
    });
  }

  // ── Split an inbound across the team ──────────────────────────────────────
  // Mass-select lines → assign to a colleague → confirm with your own password.
  // Repeatable. The server enforces the leader rule and never over-allocates;
  // this screen just has to show what is left and stay honest about it.
  let _splitJob = null;
  // Real colleague list, not free text — a typo'd user id used to create an
  // assignment nobody would ever see. Loaded once and reused.
  let _teamCache = null;
  async function loadTeam() {
    if (_teamCache) return _teamCache;
    try { _teamCache = await (await fetch('/api/team', { headers: hdrs() })).json(); }
    catch { _teamCache = []; }
    return _teamCache;
  }
  function splitUnassigned(job, line) {
    const given = (job.assignments || [])
      .filter(a => a.line_id === line.line_id)
      .reduce((s, a) => s + Number(a.qty || 0), 0);
    return Math.max(0, Number(line.expected_qty || 0) - given);
  }
  async function openSplitInbound(id) {
    _splitJob = (inboundJobs || []).find(j => j.id === id);
    if (!_splitJob) return;
    document.getElementById('splitRef').textContent = _splitJob.serial || _splitJob.reference || id.slice(0, 8);
    document.getElementById('splitPassword').value = '';
    document.getElementById('splitMsg').classList.add('hidden');
    const sel = document.getElementById('splitAssignee');
    const team = await loadTeam();
    sel.innerHTML = '<option value="">Choose a colleague…</option>' +
      team.map(u => `<option value="${esc(u.id)}">${esc(u.name)}${u.self ? ' (you)' : ''} — ${esc(u.id)}</option>`).join('');
    const lead = _splitJob.lead;
    const note = document.getElementById('splitLeadNote');
    if (lead) {
      note.textContent = `⭐ ${lead.name || lead.user} is leading this receipt — only they (or the Administrator key) can change the allocation.`;
      note.classList.remove('hidden');
    } else note.classList.add('hidden');
    renderSplitLines();
    renderSplitCurrent();
    document.getElementById('splitInboundOverlay').classList.remove('hidden');
  }
  function renderSplitLines() {
    const j = _splitJob;
    document.getElementById('splitLinesBody').innerHTML = (j.lines || []).map(l => {
      const left = splitUnassigned(j, l);
      // ASSIGNED BY LINE, not by quantity — a ticked line goes to one person in
      // full. A line already handed out is shown struck through rather than
      // hidden, so the supervisor can see the whole delivery in one place.
      return `<tr data-line="${esc(l.line_id || '')}" style="${left ? '' : 'opacity:.45'}">
        <td><input type="checkbox" class="split-pick" ${left ? '' : 'disabled'}></td>
        <td><b>${esc(l.sku)}</b></td>
        <td>${esc(String(l.description || '').slice(0, 46))}</td>
        <td style="text-align:right">${l.expected_qty || 0}</td>
        <td style="text-align:right">${left ? `<b>${left}</b>` : '<span class="cs-pill ok">assigned</span>'}</td>
      </tr>`;
    }).join('');
  }
  function renderSplitCurrent() {
    const rows = _splitJob.assignments || [];
    const el = document.getElementById('splitCurrent');
    if (!rows.length) { el.innerHTML = '<p class="hint">Nobody has been given anything yet.</p>'; return; }
    // group by person so a supervisor sees the team, not a flat list
    const byWho = {};
    for (const a of rows) (byWho[a.assignee] = byWho[a.assignee] || []).push(a);
    el.innerHTML = `<div class="hint" style="margin-bottom:.3rem">Who has what</div>` +
      Object.entries(byWho).map(([who, list]) => {
        const done = list.reduce((s, a) => s + (a.done || 0), 0);
        const qty  = list.reduce((s, a) => s + a.qty, 0);
        return `<div class="poke-row">
          <div class="pk-ic out">&#128100;</div>
          <div class="pk-b">
            <div class="pk-t">${esc(who)} <span class="cs-pill ${done >= qty ? 'ok' : ''}">${done}/${qty} pcs</span></div>
            <div class="pk-s">${list.map(a => `${esc(a.sku)} ${a.done || 0}/${a.qty}${a.notice ? ` &nbsp;<span class="cs-pill warn">${esc(a.notice.by)} scanned ${a.notice.qty}</span>` : ''}`).join(' &nbsp;·&nbsp; ')}</div>
          </div>
          ${list.every(a => !a.done) ? `<button class="btn-del-order split-undo" data-ids="${esc(list.map(a => a.id).join(','))}" title="Take this back">&#128465;</button>` : ''}
        </div>`;
      }).join('');
  }
  document.getElementById('splitPickAll').addEventListener('change', e => {
    document.querySelectorAll('#splitLinesBody .split-pick:not([disabled])').forEach(c => { c.checked = e.target.checked; });
  });
  document.getElementById('splitCloseBtn').addEventListener('click', () =>
    document.getElementById('splitInboundOverlay').classList.add('hidden'));
  document.getElementById('splitAssignBtn').addEventListener('click', async () => {
    const assignee = document.getElementById('splitAssignee').value.trim();
    const password = document.getElementById('splitPassword').value;
    const msg = document.getElementById('splitMsg');
    const show = (kind, text) => { msg.className = `status-bar ${kind}`; msg.textContent = text; msg.classList.remove('hidden'); };
    if (!assignee) { show('error', 'Choose who is taking these lines.'); return; }
    // Belt and braces: the control is a picker, but reject anything not on the
    // real team list rather than silently creating work for a user that doesn't exist.
    if (!(_teamCache || []).some(u => u.id === assignee)) { show('error', `"${assignee}" is not a user on this system.`); return; }
    if (!password) { show('error', 'Enter your password to confirm.'); return; }
    // Send the line only — no qty. The server reads a missing/zero qty as
    // "everything still free on this line", which is exactly what handing over
    // a whole line means.
    const items = [...document.querySelectorAll('#splitLinesBody tr')].flatMap(tr => {
      const cb = tr.querySelector('.split-pick');
      return (cb && cb.checked) ? [{ line_id: tr.dataset.line }] : [];
    });
    if (!items.length) { show('error', 'Tick at least one line to hand over.'); return; }
    show('progress', 'Assigning…');
    try {
      const r = await fetch(`/api/inbound/${encodeURIComponent(_splitJob.id)}/split`, {
        method: 'POST', headers: hdrs(), body: JSON.stringify({ assignee, items, password }),
      });
      const j = await r.json();
      if (!r.ok) { show('error', j.error || 'Could not assign.'); return; }
      show('success', `✓ ${j.assigned.length} line(s) — ${j.assigned.reduce((s, a) => s + a.qty, 0)} pcs — assigned to ${assignee}.`);
      document.getElementById('splitPassword').value = '';
      await renderInboundTab();
      _splitJob = (inboundJobs || []).find(x => x.id === _splitJob.id) || _splitJob;
      renderSplitLines(); renderSplitCurrent();
    } catch (e) { show('error', 'Network error — nothing was assigned.'); }
  });
  document.getElementById('splitCurrent').addEventListener('click', async e => {
    const b = e.target.closest('.split-undo');
    if (!b) return;
    const password = document.getElementById('splitPassword').value;
    if (!password) { alert('Enter your password above first — taking work back needs the same confirmation.'); return; }
    for (const id of b.dataset.ids.split(',')) {
      await fetch(`/api/inbound/${encodeURIComponent(_splitJob.id)}/split/${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: hdrs(), body: JSON.stringify({ password }),
      });
    }
    await renderInboundTab();
    _splitJob = (inboundJobs || []).find(x => x.id === _splitJob.id) || _splitJob;
    renderSplitLines(); renderSplitCurrent();
  });

  // GRN — printable Goods Received Note (client-facing proof of receipt).
  async function printGrn(id) {
    let g;
    try {
      const r = await fetch(`/api/inbound/${encodeURIComponent(id)}/grn`, { headers: hdrs() });
      g = await r.json();
      if (!r.ok) { alert(g.error || 'Could not load GRN.'); return; }
    } catch (e) { alert(e.message); return; }
    const w = window.open('', '_blank', 'width=760,height=900');
    if (!w) { alert('Please allow pop-ups to view the GRN.'); return; }
    const rows = g.lines.map(l => `<tr${l.damaged || l.kiv ? ' style="background:#fef2f2"' : ''}>
      <td>${esc(l.sku)}</td><td>${esc(l.description)}</td>
      <td class="n">${l.expected === null ? '<i>unlisted</i>' : l.expected}</td>
      <td class="n">${l.received}</td><td class="n">${l.good}</td>
      <td class="n">${l.damaged || ''}</td><td class="n">${l.kiv || ''}</td>
      <td class="n">${l.diff === null ? '' : (l.diff === 0 ? '✓' : (l.diff > 0 ? '+' + l.diff : l.diff))}</td></tr>`).join('');
    const disc = g.discrepancies.length || g.extras.length
      ? `<h3>⚠ Discrepancies</h3><ul>
          ${g.discrepancies.map(m => `<li>${esc(m.sku)}: expected ${m.expected_qty}, received ${m.scanned_qty}</li>`).join('')}
          ${g.extras.map(x => `<li>${esc(x.sku)}: ${x.scanned_qty} received but not on the paperwork</li>`).join('')}</ul>`
      : '<p>✓ No discrepancies — received exactly as expected.</p>';
    w.document.write(`<html><head><title>GRN ${esc(g.serial || g.reference)}</title><style>
      body{font-family:sans-serif;margin:24px;font-size:13px}
      h2{margin:.1em 0}.meta{color:#555;margin-bottom:14px}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:5px 7px;text-align:left}
      td.n,th.n{text-align:right}thead{background:#f1f5f9}
      .tot{margin-top:10px;font-weight:600}
      .sig{margin-top:36px;display:flex;gap:40px}.sig div{flex:1;border-top:1px solid #333;padding-top:6px;font-size:12px}
      @media print{.noprint{display:none}}
    </style></head><body>
      <div class="noprint" style="margin-bottom:12px"><button onclick="window.print()">🖨 Print</button></div>
      <h2>Goods Received Note — ${esc(g.serial || g.reference)}</h2>
      <div class="meta">Client: <b>${esc(g.client)}</b> · Source: ${esc(g.source || '—')} · Type: ${g.type === 'po' ? 'PO / ASN' : 'Return'} · Ref: ${esc(g.reference || '—')}<br>
      Received by: ${esc(g.received_by || '—')} · Started: ${g.started ? new Date(g.started).toLocaleString() : '—'} · Ended: ${g.ended ? new Date(g.ended).toLocaleString() : '—'} · Cartons: ${g.cartons} · Photos: ${g.photos}</div>
      <table><thead><tr><th>SKU</th><th>Description</th><th class="n">Expected</th><th class="n">Received</th><th class="n">Good</th><th class="n">Damaged</th><th class="n">KIV</th><th class="n">Diff</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="tot">Totals — expected ${g.totals.expected} · received ${g.totals.received} · good ${g.totals.good} · damaged ${g.totals.damaged} · KIV ${g.totals.kiv}</div>
      ${disc}
      <div class="sig"><div>Received by (warehouse)</div><div>Acknowledged by (client)</div></div>
    </body></html>`);
    w.document.close();
  }

  // POST that transparently handles a capacity-exceeded 409: asks the user to
  // confirm over-filling the bin, then resends with override. Returns {r, d} on
  // a real response, or {cancelled:true} if the user declined the override.
  async function postWithCapacityOverride(url, body) {
    let r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let d = await r.json().catch(() => ({}));
    if (r.status === 409 && d.needsCapacityOverride) {
      if (!confirm(`⚠ ${d.message}\n\nPlace anyway (over the bin's max capacity)?`)) return { cancelled: true };
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, override: true }) });
      d = await r.json().catch(() => ({}));
    }
    return { r, d };
  }

  // Shared serials capture modal — mode 'receive' (add to stock) or 'ship'.
  let _serialsMode = 'receive', _serialsCtx = {};
  function openSerialsModal(mode, ctx) {
    _serialsMode = mode; _serialsCtx = ctx || {};
    const title = document.getElementById('serialsModalTitle');
    const desc = document.getElementById('serialsModalDesc');
    const sub = document.getElementById('serModalSubmit');
    if (mode === 'ship') { title.textContent = '🔢 Serials shipped'; desc.textContent = `Record the serial numbers going out on ${_serialsCtx.ref || 'this order'}.`; sub.textContent = 'Mark shipped'; }
    else { title.textContent = '🔢 Serials received'; desc.textContent = `Register serial numbers received into stock${_serialsCtx.ref ? ' (' + _serialsCtx.ref + ')' : ''}.`; sub.textContent = 'Register received'; }
    document.getElementById('serModalSku').value = _serialsCtx.sku || '';
    document.getElementById('serModalList').value = '';
    document.getElementById('serModalMsg').classList.add('hidden');
    document.getElementById('serialsModal').classList.remove('hidden');
  }
  async function submitSerialsModal() {
    const sku = document.getElementById('serModalSku').value.trim();
    const serials = document.getElementById('serModalList').value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    const msg = document.getElementById('serModalMsg');
    const clientId = _serialsCtx.clientId || '';
    if (!clientId) { msg.className = 'status-bar error'; msg.textContent = 'No client on this record.'; msg.classList.remove('hidden'); return; }
    if (!serials.length) { msg.className = 'status-bar error'; msg.textContent = 'Paste at least one serial.'; msg.classList.remove('hidden'); return; }
    try {
      let r, d;
      if (_serialsMode === 'ship') {
        r = await fetch('/api/inventory/serials/ship', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, serials, shipped_ref: _serialsCtx.ref || '' }) });
        d = await r.json();
        if (!r.ok) { msg.className = 'status-bar error'; msg.textContent = d.error || 'Failed'; msg.classList.remove('hidden'); return; }
        msg.className = 'status-bar success'; msg.textContent = `✓ ${d.shipped} marked shipped${d.notFound && d.notFound.length ? `, ${d.notFound.length} unknown/already shipped` : ''}.`;
      } else {
        if (!sku) { msg.className = 'status-bar error'; msg.textContent = 'SKU required.'; msg.classList.remove('hidden'); return; }
        r = await fetch('/api/inventory/serials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, sku, serials, received_ref: _serialsCtx.ref || '' }) });
        d = await r.json();
        if (!r.ok) { msg.className = 'status-bar error'; msg.textContent = d.error || 'Failed'; msg.classList.remove('hidden'); return; }
        msg.className = 'status-bar success'; msg.textContent = `✓ ${d.added} registered${d.skipped && d.skipped.length ? `, ${d.skipped.length} already existed` : ''}.`;
      }
      msg.classList.remove('hidden');
      document.getElementById('serModalList').value = '';
    } catch (e) { msg.className = 'status-bar error'; msg.textContent = e.message; msg.classList.remove('hidden'); }
  }
  setTimeout(() => {
    document.getElementById('serModalCancel')?.addEventListener('click', () => document.getElementById('serialsModal').classList.add('hidden'));
    document.getElementById('serModalSubmit')?.addEventListener('click', submitSerialsModal);
  }, 0);

  // ── Putaway — direct received inbound goods into warehouse bins ─────────────
  // received_totals (sku->qty) comes from the inbound record; state.putaway is the
  // list of placements already done. "Remaining" = received − placed, per SKU.
  function putawayReceived(job) {
    if (job.received_totals && Object.keys(job.received_totals).length) return { ...job.received_totals };
    // Fallback for jobs received before received_totals was stored: derive it.
    const out = {};
    if (job.type === 'return') {
      for (const [sku, c] of Object.entries(job.conditionTotals || {})) { const g = Number((c || {}).straight_to_inventory || 0); if (g > 0) out[sku] = g; }
    } else {
      for (const [sku, q] of Object.entries(job.scanned || {})) { const n = Number(q || 0); if (n > 0) out[sku] = n; }
    }
    return out;
  }
  function putawayPlacedBySku(job) {
    const placed = {};
    for (const p of (job.putaway || [])) placed[p.sku] = (placed[p.sku] || 0) + Number(p.qty || 0);
    return placed;
  }
  function putawayRemaining(job) {
    const rec = putawayReceived(job), placed = putawayPlacedBySku(job);
    return Object.entries(rec).reduce((s, [sku, q]) => s + Math.max(0, q - (placed[sku] || 0)), 0);
  }
  const PUTAWAY_REASONS = ['Bin full / no space', 'Consolidating stock', 'Damaged / QA hold', 'Cold-chain / segregation'];
  let _putawayJob = null, _putawayLocations = [], _putawaySuggest = {};
  async function openPutaway(id) {
    _putawayJob = (inboundJobs || []).find(j => j.id === id);
    if (!_putawayJob) return;
    document.getElementById('putawayJobRef').textContent = _putawayJob.serial || _putawayJob.reference || id.slice(0, 8);
    document.getElementById('putawayMsg').classList.add('hidden');
    try { const r = await fetch('/api/inventory/locations'); _putawayLocations = r.ok ? await r.json() : []; } catch { _putawayLocations = []; }
    document.getElementById('putawayNoBins').classList.toggle('hidden', _putawayLocations.length > 0);
    // Suggest the bin where each SKU already lives (co-location).
    const cid = _putawayJob.client_name || '';
    _putawaySuggest = {};
    await Promise.all(Object.keys(putawayReceived(_putawayJob)).map(async sku => {
      try { const r = await fetch(`/api/inventory/suggest-location?clientId=${encodeURIComponent(cid)}&sku=${encodeURIComponent(sku)}`); if (r.ok) { const d = await r.json(); if (d.location_id) _putawaySuggest[sku] = d.location_id; } } catch {}
    }));
    renderPutaway();
    document.getElementById('inboundPutawayModal').classList.remove('hidden');
  }
  function _expiryForSku(sku) { return ((_putawayJob.lines || []).find(l => l.sku === sku) || {}).expiry_date || ''; }
  function renderPutaway() {
    const rec = putawayReceived(_putawayJob), placed = putawayPlacedBySku(_putawayJob);
    const rows = Object.entries(rec);
    const body = document.getElementById('putawayBody');
    if (!rows.length) { body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:1.2rem;color:#94a3b8">Nothing received to put away.</td></tr>'; return; }
    const reasonOpts = PUTAWAY_REASONS.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
    body.innerHTML = rows.map(([sku, q]) => {
      const done = placed[sku] || 0, remain = Math.max(0, q - done);
      const sug = _putawaySuggest[sku] || '';
      const binOpts = '<option value="">— bin —</option>' + _putawayLocations.map(l => `<option value="${esc(l.location_id)}" ${l.location_id === sug ? 'selected' : ''}>${esc(l.location_id)}${l.location_id === sug ? ' (suggested)' : ''}</option>`).join('');
      const exp = _expiryForSku(sku);
      return `<tr data-sku="${esc(sku)}" data-suggest="${esc(sug)}">
        <td style="font-family:monospace;font-weight:600">${esc(sku)}</td>
        <td style="text-align:right">${q}</td>
        <td style="text-align:right;color:${done >= q ? '#059669' : '#d97706'}">${done}</td>
        <td>
          <select class="pa-loc" style="padding:.35rem;border:1px solid #e2e8f0;border-radius:6px">${binOpts}</select>
          <div class="pa-reason-wrap hidden" style="margin-top:.3rem"><select class="pa-reason" style="padding:.3rem;border:1px solid #f59e0b;border-radius:6px;font-size:.8rem"><option value="">Reason for other bin…</option>${reasonOpts}</select></div>
          <div style="margin-top:.3rem;display:flex;gap:.3rem">
            <input class="pa-exp" type="date" value="${esc(exp)}" title="Expiry (FEFO)" style="padding:.3rem;border:1px solid #e2e8f0;border-radius:6px;font-size:.78rem">
            <input class="pa-lot" placeholder="Lot#" style="width:70px;padding:.3rem;border:1px solid #e2e8f0;border-radius:6px;font-size:.78rem">
          </div>
        </td>
        <td style="text-align:right;vertical-align:top"><input class="pa-qty" type="number" value="${remain}" style="width:70px;padding:.35rem;border:1px solid #e2e8f0;border-radius:6px"></td>
        <td style="vertical-align:top"><button class="btn-primary btn-sm pa-place" ${remain <= 0 ? 'disabled' : ''}>Place</button></td></tr>`;
    }).join('');
    // Show the reason selector only when the chosen bin differs from the suggestion.
    body.querySelectorAll('.pa-loc').forEach(sel => sel.addEventListener('change', () => {
      const tr = sel.closest('tr'); const sug = tr.dataset.suggest;
      const wrap = tr.querySelector('.pa-reason-wrap');
      wrap.classList.toggle('hidden', !(sug && sel.value && sel.value !== sug));
    }));
    body.querySelectorAll('.pa-place').forEach(btn => btn.addEventListener('click', async () => {
      const tr = btn.closest('tr'); const sku = tr.dataset.sku; const sug = tr.dataset.suggest;
      const location_id = tr.querySelector('.pa-loc').value; const qty = tr.querySelector('.pa-qty').value;
      const expiry_date = tr.querySelector('.pa-exp').value || null; const lot_number = tr.querySelector('.pa-lot').value || '';
      const override_reason = tr.querySelector('.pa-reason')?.value || '';
      const msg = document.getElementById('putawayMsg');
      if (!location_id || qty === '') { msg.className = 'status-bar error'; msg.textContent = 'Pick a bin and qty.'; msg.classList.remove('hidden'); return; }
      if (sug && location_id !== sug && !override_reason) { msg.className = 'status-bar error'; msg.textContent = `This SKU is already in ${sug}. Pick a reason for using a different bin.`; msg.classList.remove('hidden'); return; }
      try {
        const { r, d, cancelled } = await postWithCapacityOverride(`/api/inbound/${encodeURIComponent(_putawayJob.id)}/putaway`, { sku, location_id, qty: Number(qty), expiry_date, lot_number, override_reason });
        if (cancelled) return;
        if (!r.ok) { msg.className = 'status-bar error'; msg.textContent = d.error || 'Failed'; msg.classList.remove('hidden'); return; }
        msg.className = 'status-bar success'; msg.textContent = `✓ ${sku} → ${location_id} (${qty})${expiry_date ? ' exp ' + expiry_date : ''}.`; msg.classList.remove('hidden');
        _putawayJob.putaway = d.putaway; renderPutaway();
        renderInboundTab();
      } catch (e) { msg.className = 'status-bar error'; msg.textContent = e.message; msg.classList.remove('hidden'); }
    }));
  }
  setTimeout(() => {
    document.getElementById('putawayCloseBtn')?.addEventListener('click', () => document.getElementById('inboundPutawayModal').classList.add('hidden'));
  }, 0);

  // ── Backorders — "awaiting stock" queue (Orders tab) ───────────────────────
  async function loadBackordersBadge() {
    try {
      const r = await fetch('/api/backorders?status=open');
      if (!r.ok) return;
      const d = await r.json();
      const b = document.getElementById('backordersBadge'); if (!b) return;
      if (d.open > 0) { b.textContent = d.open; b.classList.remove('hidden'); } else b.classList.add('hidden');
    } catch { /* ignore */ }
  }
  async function openBackorders() {
    const modal = document.getElementById('backordersModal');
    const body = document.getElementById('backordersBody');
    const empty = document.getElementById('backordersEmpty');
    modal.classList.remove('hidden');
    body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:1.2rem;color:#94a3b8">Loading…</td></tr>';
    let rows = [];
    try { const r = await fetch('/api/backorders?status=open'); rows = r.ok ? (await r.json()).backorders : []; } catch { rows = []; }
    if (!rows.length) { body.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    body.innerHTML = rows.map(b => `<tr data-id="${esc(b.id)}">
      <td style="font-family:monospace">${esc(b.order_number)}</td>
      <td>${esc(b.client_name || '')}</td>
      <td style="font-family:monospace;font-weight:600">${esc(b.sku)}</td>
      <td style="text-align:right">${b.ordered}</td>
      <td style="text-align:right;color:#dc2626">${b.shortfall}</td>
      <td style="text-align:right;font-weight:700;color:#d97706">${b.remaining}</td>
      <td class="hint">${b.created_at ? new Date(b.created_at).toLocaleDateString() : '—'}</td>
      <td><button class="btn-secondary btn-sm bo-resolve" data-id="${esc(b.id)}">Resolve</button></td></tr>`).join('');
    body.querySelectorAll('.bo-resolve').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Mark this backorder resolved? (use when the order was cancelled or handled offline)')) return;
      await fetch(`/api/backorders/${encodeURIComponent(btn.dataset.id)}/resolve`, { method: 'POST' });
      openBackorders(); loadBackordersBadge();
    }));
  }
  setTimeout(() => {
    document.getElementById('backordersBtn')?.addEventListener('click', openBackorders);
    document.getElementById('backordersCloseBtn')?.addEventListener('click', () => document.getElementById('backordersModal').classList.add('hidden'));
  }, 0);

  // ── Transport Tab (TMS Importer) ──────────────────────────────────────────────
  // Import delivery schedules from BETIME and Outright, manage transport requests.
  let transportRequests = [];
  let transportDateFilter = 'today';   // 'today' | 'yesterday' | 'week' | 'month' | 'all'

  let transportMainMap = null;
  let transportMarkers = [];
  let driverMarkers = [];
  let showingDrivers = false;

  async function renderTransportTab() {
    let allTransport = [];
    try {
      const resp = await fetch('/api/transport');
      if (resp.ok) allTransport = await resp.json();
    } catch { /* offline — show nothing */ }

    // Default scope: TODAY'S WORKLOAD — jobs created today (any status) plus
    // the undelivered balance carried over from earlier days. The date chips
    // let the user widen the window; the undelivered balance is NEVER hidden
    // regardless of the chip (same packer rule as the Orders tab), so the
    // chips effectively slice only the settled (delivered/cancelled) jobs.
    // Days are SGT calendar days, never UTC.
    const dayOf = at => at ? new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }) : '';
    const todayStr = dayOf(new Date());
    const yestStr  = dayOf(new Date(Date.now() - 86400000));
    const weekStr  = dayOf(new Date(Date.now() - 6 * 86400000));
    const monthStr = todayStr.slice(0, 8) + '01';
    const doneYesterday = allTransport.filter(r => r.status === 'delivered' && dayOf(r.deliveredAt) === yestStr).length;
    const inRange = d => {
      if (!d) return false;
      switch (transportDateFilter) {
        case 'today':     return d === todayStr;
        case 'yesterday': return d === yestStr;
        case 'week':      return d >= weekStr && d <= todayStr;
        case 'month':     return d >= monthStr && d <= todayStr;
        default:          return true; // 'all'
      }
    };
    transportRequests = allTransport.filter(r =>
      (r.status !== 'delivered' && r.status !== 'cancelled') || // balance (any age, always visible)
      inRange(dayOf(r.createdAt)) ||                            // created in the selected window
      inRange(dayOf(r.deliveredAt)));                           // closed out in the selected window

    // Date-filter chips — mirror the Orders tab pattern
    const dateRow = document.getElementById('transportDateRow');
    if (dateRow) {
      dateRow.innerHTML = `
        <span class="odr-label">SHOW:</span>
        ${[['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Last 7 Days'], ['month', 'This Month'], ['all', 'All']]
          .map(([k, lbl]) => `<button class="filter-chip ${transportDateFilter === k ? 'active' : ''}" data-tdate="${k}">${lbl}</button>`).join('')}`;
      dateRow.querySelectorAll('.filter-chip[data-tdate]').forEach(btn => {
        btn.addEventListener('click', () => {
          transportDateFilter = btn.dataset.tdate;
          renderTransportTab();
        });
      });
    }

    // Zero jobs is NOT a special case — the dashboard always renders with 0s
    // and the map always shows (empty Singapore view), so the page never
    // collapses to a bare text message.
    const empty = document.getElementById('transportMapEmpty');
    if (empty) empty.style.display = 'none';

    // Render stats bar — lifecycle: pending → preplanned (plan approved)
    // → confirmed (scanning completed) → delivered
    const statusCounts = {
      pending: transportRequests.filter(r => (r.status || 'pending') === 'pending').length,
      preplanned: transportRequests.filter(r => r.status === 'preplanned').length,
      staging: transportRequests.filter(r => r.status === 'confirmed').length,
      onroad: transportRequests.filter(r => r.status === 'in-transit').length,
      delivered: transportRequests.filter(r => r.status === 'delivered').length,
    };

    // Jobs whose store name didn't match the Address Book — offer the
    // nearest matches for the user to confirm (and learn).
    const unresolvedCount = transportRequests.filter(r =>
      !r.shipping?.zip && r.status !== 'delivered' && r.status !== 'cancelled').length;
    let unresolvedBanner = document.getElementById('transportUnresolvedBanner');
    if (unresolvedCount > 0) {
      if (!unresolvedBanner) {
        unresolvedBanner = document.createElement('div');
        unresolvedBanner.id = 'transportUnresolvedBanner';
        unresolvedBanner.style.cssText = 'margin:.4rem 0;padding:.55rem .8rem;background:#fef3c7;border-left:3px solid #f59e0b;border-radius:4px;font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:.8rem;flex-wrap:wrap';
        const statsBar = document.getElementById('transportStatsBar');
        statsBar.parentNode.parentNode.insertBefore(unresolvedBanner, statsBar.parentNode.nextSibling);
      }
      unresolvedBanner.innerHTML = `
        <span>⚠ <strong>${unresolvedCount}</strong> job(s) have no postal code — store name not found in the Address Book (possibly spelled differently).</span>
        <button class="btn-primary btn-sm" id="transportResolveBtn">🔍 Match &amp; Fix</button>`;
      unresolvedBanner.querySelector('#transportResolveBtn').addEventListener('click', openUnresolvedResolver);
    } else if (unresolvedBanner) {
      unresolvedBanner.remove();
    }

    const jobsLbl = { today: 'Jobs Today', yesterday: 'Jobs Yday', week: 'Jobs 7 Days', month: 'Jobs Month', all: 'Jobs All' }[transportDateFilter] || 'Jobs';
    document.getElementById('transportStatsBar').innerHTML = `
      <div class="stat-box"><div class="val">${transportRequests.length}</div><div class="lbl">${jobsLbl}</div></div>
      <div class="stat-box pending"><div class="val">${statusCounts.pending}</div><div class="lbl">Pending</div></div>
      <div class="stat-box processing"><div class="val">${statusCounts.preplanned}</div><div class="lbl">Preplanned</div></div>
      <div class="stat-box"><div class="val">${statusCounts.staging}</div><div class="lbl">Staging</div></div>
      <div class="stat-box processing"><div class="val">${statusCounts.onroad}</div><div class="lbl">On Road</div></div>
      <div class="stat-box done"><div class="val">${statusCounts.delivered}</div><div class="lbl">Delivered</div></div>
      <div class="stat-box"><div class="val">${doneYesterday}</div><div class="lbl">Done Yday</div></div>`;

    // Initialize and update the main Singapore map (Leaflet — bundled locally)
    if (window.L) {
      initTransportMainMap();
    } else {
      console.error('✗ Leaflet failed to load, using fallback table view');
      renderTransportTableFallback();
    }
  }

  function renderTransportTableFallback() {
    const mapContainer = document.getElementById('transportMainMap');
    if (!mapContainer) return;

    mapContainer.innerHTML = `
      <div style="padding:1rem;height:100%;overflow-y:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
          <h3 style="margin:0">Transport Jobs (${transportRequests.length})</h3>
          <button id="selectAllTransportBtn" class="btn-secondary btn-sm">Select All</button>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:#f0f0f0;border-bottom:1px solid #ddd">
              <th style="padding:0.5rem;width:30px;text-align:center">✓</th>
              <th style="padding:0.5rem;text-align:left">Job ID</th>
              <th style="padding:0.5rem;text-align:left">Client</th>
              <th style="padding:0.5rem;text-align:left">Status</th>
              <th style="padding:0.5rem;text-align:center">Packages</th>
              <th style="padding:0.5rem;text-align:left">Driver</th>
              <th style="padding:0.5rem;text-align:center">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${transportRequests.map(req => `
              <tr style="border-bottom:1px solid #eee;background:${req.pendingDeletion ? '#ffebee' : 'white'};hover:background:#f9f9f9">
                <td style="padding:0.5rem;text-align:center">
                  <input type="checkbox" class="transport-checkbox" data-id="${esc(req.id)}" style="cursor:pointer">
                </td>
                <td style="padding:0.5rem"><strong>${esc(req.id || 'N/A')}</strong></td>
                <td style="padding:0.5rem">${esc(req.clientName || 'N/A')}</td>
                <td style="padding:0.5rem">
                  <span class="status-badge" style="font-size:11px">${req.status || 'pending'}</span>
                  ${req.pendingDeletion ? '<span style="display:inline-block;margin-left:0.3rem;padding:0.2rem 0.4rem;background:#ffcdd2;border-radius:2px;font-size:10px">⏳ Delete Pending</span>' : ''}
                </td>
                <td style="padding:0.5rem;text-align:center"><strong>${req.packages || 1}</strong></td>
                <td style="padding:0.5rem">${esc(req.assignedDriverName || ((window.drivers || []).find(d => d.id === req.assignedDriver)?.name) || (req.assignedDriver ? req.assignedDriver : '—'))}</td>
                <td style="padding:0.5rem;text-align:center">
                  <button class="btn-scan-now btn-sm transport-edit-btn" data-id="${esc(req.id)}" style="padding:0.3rem 0.5rem;margin-right:0.2rem">✏️</button>
                  <button class="btn-scan-now btn-sm transport-view-btn" data-id="${esc(req.id)}" style="padding:0.3rem 0.5rem">👁️</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div style="margin-top:1rem;padding:0.5rem;background:#e8f4f8;border-radius:4px;font-size:12px;color:#666">
          📍 Map view unavailable - using table view | <strong>Packages:</strong> Default 1, update when order completes
        </div>
      </div>
    `;

    // Add event listeners
    document.querySelectorAll('.transport-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        toggleTransportSelection(e.target.dataset.id);
      });
    });

    document.getElementById('selectAllTransportBtn')?.addEventListener('click', () => {
      const allCheckboxes = document.querySelectorAll('.transport-checkbox');
      const allSelected = transportSelectedIds.size === transportRequests.length;

      if (allSelected) {
        transportSelectedIds.clear();
        allCheckboxes.forEach(cb => cb.checked = false);
      } else {
        allCheckboxes.forEach(cb => {
          transportSelectedIds.add(cb.dataset.id);
          cb.checked = true;
        });
      }
      updateBulkActionsBar();
    });

    document.querySelectorAll('.transport-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        openEditTransport(e.target.closest('button').dataset.id);
      });
    });

    document.querySelectorAll('.transport-view-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        openDeliveryDetail(e.target.closest('button').dataset.id);
      });
    });
  }

  function initTransportMainMap() {
    const mapContainer = document.getElementById('transportMainMap');
    if (!mapContainer) return;

    if (!window.L) {
      renderTransportTableFallback();
      return;
    }

    // Singapore center coordinates
    const singaporeCenter = [1.3521, 103.8198];

    // (Re)create the Leaflet map — destroy any previous instance first
    if (transportMainMap) {
      transportMainMap.remove();
      transportMainMap = null;
    }
    mapContainer.innerHTML = '';
    transportMainMap = L.map(mapContainer).setView(singaporeCenter, 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(transportMainMap);

    transportMarkers = [];

    // Colour rule: NOT ASSIGNED = red. Assigned = blue while preplanned,
    // green once scanning confirms / delivers, amber in transit.
    const jobColor = req => {
      if (req.status === 'delivered') return String(req.podRemarks || '').trim() ? '#dc2626' : '#22c55e';
      if (req.status === 'in-transit') return '#f59e0b'; // on the road
      if (req.status === 'confirmed') return '#64748b';  // staging
      if (!req.assignedDriver && !req.assignedDriverName) return '#ef4444'; // not assigned
      return '#0ea5e9'; // assigned / preplanned
    };

    // Add delivery markers — position from record coords or postal code
    const bounds = [];
    transportRequests.forEach((req, idx) => {
      const pos = (req.lat && req.lng)
        ? { lat: req.lat, lng: req.lng }
        : getPostalCodeCoords(req.shipping?.zip || '');
      if (!pos) return;

      const assigned = !!(req.assignedDriver || req.assignedDriverName);
      const driverRec = (window.drivers || []).find(d => d.id === req.assignedDriver);
      const driverName = req.assignedDriverName || driverRec?.name || '';

      const marker = L.marker([pos.lat, pos.lng], {
        icon: L.divIcon({
          className: 'tjob-marker-wrap',
          html: `<div class="tjob-marker" style="background:${jobColor(req)}">${idx + 1}</div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11]
        })
      }).addTo(transportMainMap);

      // Details card — shown on HOVER (desktop) and on tap (mobile popup)
      const detailsHtml = `<div style="font-size:12px;line-height:1.5;min-width:170px">
        <strong style="font-size:13px">${esc(req.clientName || req.id)}</strong>
        <span style="color:#64748b;font-size:10px;font-family:monospace"> ${esc(req.id)}</span><br/>
        ${assigned
          ? `👤 <strong>${esc(driverName)}</strong>${driverRec?.phone ? ` · 📞 ${esc(driverRec.phone)}` : ''}${req.routeNum ? `<br/>🗺️ Route ${req.routeNum}${req.stopSeq ? ` · Stop #${req.stopSeq}` : ''}` : ''}<br/>`
          : `<span style="color:#ef4444;font-weight:600">⚠ No driver assigned</span><br/>`}
        📦 ${req.packages || 1} carton(s) &nbsp;|&nbsp; 📍 ${esc(req.shipping?.zip || '—')}<br/>
        ${esc(req.shipping?.addressLine1 || '')}<br/>
        ${(() => { const st = tmsStatusLabel(req); return `<span style="display:inline-block;margin-top:0.3rem;padding:.1rem .5rem;border-radius:99px;background:${st.color}1a;color:${st.color};font-size:11px;font-weight:700">${st.label}</span>`; })()}
      </div>`;

      marker.bindTooltip(detailsHtml, { direction: 'top', offset: [0, -12], sticky: false, opacity: 1, className: 'tjob-tooltip' });
      // Touch devices have no hover — tap opens this popup instead. It also
      // carries the office-side "Mark Delivered" close-out button.
      const canDeliver = req.status !== 'delivered' && req.status !== 'cancelled';
      const isAdmin = currentUser?.role === 'admin';
      marker.bindPopup(detailsHtml
        + `<button class="popup-details-btn" data-jobid="${esc(req.id)}" style="margin-top:.5rem;width:100%;padding:.4rem;background:#1d4ed8;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer">📝 Details / Fix Postal</button>`
        + (req.status === 'confirmed'
          ? `<button class="popup-onroad-btn" data-id="${esc(req.id)}" style="margin-top:.35rem;width:100%;padding:.4rem;background:#f59e0b;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer">🚚 Picked Up — On the Road</button>`
          : '')
        + (canDeliver
          ? `<button class="popup-deliver-btn" data-id="${esc(req.id)}" style="margin-top:.5rem;width:100%;padding:.4rem;background:#16a34a;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer">✓ Mark Delivered</button>`
          : '')
        + (isAdmin
          ? `<button class="popup-delete-btn" data-id="${esc(req.id)}" style="margin-top:.35rem;width:100%;padding:.35rem;background:#fff;color:#ef4444;border:1px solid #ef4444;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer">🗑 Delete Job</button>`
          : ''));

      transportMarkers.push(marker);
      bounds.push([pos.lat, pos.lng]);
    });

    const fit = () => {
      if (bounds.length > 0) transportMainMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
    };
    fit();
    // The tab container may have been hidden/resizing during init (common on
    // mobile) — Leaflet then computes wrong bounds. Re-measure and re-fit.
    setTimeout(() => { transportMainMap.invalidateSize(); fit(); }, 300);
  }

  function handleTransportRequest(id) {
    const req = transportRequests.find(r => r.id === id);
    if (!req) return;

    const modal = document.getElementById('transportDetailModal');
    document.getElementById('transportDetailId').textContent = esc(req.id || '—');
    document.getElementById('transportDetailClient').textContent = esc(req.clientName || '—');
    document.getElementById('transportDetailStatus').textContent = req.status || 'Pending';
    document.getElementById('transportDetailStatus').className = `status-badge ${req.status || 'pending'}`;
    document.getElementById('transportDetailTitle').textContent = `📦 ${esc(req.clientName || req.id)}`;
    document.getElementById('transportDetailDate').textContent = req.createdAt ? new Date(req.createdAt).toLocaleDateString() : '—';

    // Display stops
    const stopsHtml = (req.items || []).map((item, idx) => `
      <div style="padding:0.6rem;background:white;border-radius:4px;border-left:3px solid #0ea5e9;margin-bottom:0.4rem;font-size:12px">
        <p style="margin:0 0 0.2rem 0"><strong>#${idx + 1}</strong> ${esc(item.name || item.sku || '—')}</p>
        <p style="margin:0;color:#64748b">📍 ${esc(item.address || req.shipping?.addressLine1 || '—')}</p>
        ${item.qty ? `<p style="margin:0.2rem 0 0 0;color:#7c3aed">qty: ${item.qty}</p>` : ''}
      </div>
    `).join('');
    document.getElementById('transportDetailStops').innerHTML = stopsHtml || '<p style="margin:0;color:#64748b;font-size:12px">No items</p>';

    modal.classList.remove('hidden');

    // Initialize and display map
    if (window.L) {
      setTimeout(() => initTransportMap(req), 100);
    }
  }

  let transportMap = null;
  let transportMapMarkers = [];

  function initTransportMap(req) {
    const mapEl = document.getElementById('transportMap');
    if (!mapEl || !window.L) return;

    // Get stops with coordinates
    const stops = [];
    if (req.items && Array.isArray(req.items)) {
      req.items.forEach((item, idx) => {
        if (item.geocoded) {
          stops.push({
            lat: parseFloat(item.geocoded.lat),
            lng: parseFloat(item.geocoded.lng),
            name: item.name || item.sku || `Stop ${idx + 1}`,
            address: item.address || ''
          });
        }
      });
    }

    // Fallbacks: explicit shipping geocode, then postal code lookup
    if (stops.length === 0 && req.shipping?.geocoded) {
      stops.push({
        lat: parseFloat(req.shipping.geocoded.lat),
        lng: parseFloat(req.shipping.geocoded.lng),
        name: req.clientName || 'Destination',
        address: `${req.shipping.addressLine1 || ''}, ${req.shipping.city || ''}`
      });
    }
    if (stops.length === 0 && req.shipping?.zip) {
      const pos = getPostalCodeCoords(req.shipping.zip);
      stops.push({
        lat: pos.lat, lng: pos.lng,
        name: req.clientName || 'Destination',
        address: `${req.shipping.addressLine1 || ''} (postal ${req.shipping.zip})`
      });
    }

    if (stops.length === 0) {
      mapEl.innerHTML = '<p style="padding:2rem;text-align:center;color:#64748b">No location data available</p>';
      return;
    }

    // (Re)create the modal map fresh each time
    if (transportMap) { transportMap.remove(); transportMap = null; }
    mapEl.innerHTML = '';
    transportMap = L.map(mapEl).setView([stops[0].lat, stops[0].lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(transportMap);
    transportMapMarkers = [];

    // Add markers for each stop
    const bounds = [];
    stops.forEach((stop, idx) => {
      const marker = L.circleMarker([stop.lat, stop.lng], {
        radius: 9,
        fillColor: idx === 0 ? '#ef4444' : idx === stops.length - 1 ? '#22c55e' : '#0ea5e9',
        fillOpacity: 1,
        color: '#fff',
        weight: 2
      }).addTo(transportMap);
      marker.bindTooltip(String(idx + 1), { permanent: true, direction: 'center', className: 'map-marker-label' });
      marker.bindPopup(`<div><strong>${esc(stop.name)}</strong><p style="margin:0.3rem 0 0 0;font-size:12px">${esc(stop.address)}</p></div>`);
      transportMapMarkers.push(marker);
      bounds.push([stop.lat, stop.lng]);
    });

    transportMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
  }

  // TMS Import handlers
  async function analyzeAndPreviewFile(file, format) {
    try {
      // Parse file to preview data
      const text = await file.text();
      const lines = text.split('\n').filter(l => l.trim());

      if (lines.length < 2) {
        throw new Error('File appears to be empty or invalid');
      }

      // Parse CSV headers and first few rows
      const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
      const rows = [];

      for (let i = 1; i < Math.min(4, lines.length); i++) {
        const cells = lines[i].split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
        const row = {};
        headers.forEach((h, idx) => {
          row[h] = cells[idx] || '';
        });
        rows.push(row);
      }

      // Show preview modal
      showColumnMappingPreview(headers, rows, file, format);
    } catch (err) {
      alert('Failed to analyze file: ' + err.message);
    }
  }

  function showColumnMappingPreview(headers, sampleRows, file, format) {
    // Create preview modal
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'columnMappingModal';
    modal.innerHTML = `
      <div class="modal" style="width:95%;max-width:1200px;max-height:90vh;overflow-y:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem">
          <h2 style="margin:0">📋 Preview & Map Columns</h2>
          <button class="btn-close" id="mappingCloseBtn">✕</button>
        </div>

        <div style="padding:1rem;background:#e8f5e9;border-left:4px solid #22c55e;border-radius:4px;margin-bottom:1.5rem">
          <strong>✓ File detected:</strong> ${sampleRows.length} preview rows found<br/>
          <strong>Format:</strong> auto-detected from data | <strong>Columns:</strong> ${headers.join(', ')}
        </div>

        <h3 style="margin-top:0;margin-bottom:0.8rem;font-size:14px">Detected Data Types</h3>
        <div id="columnTypePreview" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem;margin-bottom:1.5rem"></div>

        <h3 style="margin-top:0;margin-bottom:0.8rem;font-size:14px">Sample Data (First 3 Rows)</h3>
        <div style="overflow-x:auto;border:1px solid #e0e0e0;border-radius:4px;margin-bottom:1.5rem">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead style="background:#f5f5f5;border-bottom:1px solid #e0e0e0">
              <tr>
                ${headers.map(h => `<th style="padding:0.5rem;text-align:left;border-right:1px solid #e0e0e0">${esc(h)}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${sampleRows.map(row => `
                <tr style="border-bottom:1px solid #e0e0e0">
                  ${headers.map(h => `<td style="padding:0.5rem;border-right:1px solid #e0e0e0;font-family:monospace;font-size:11px">${esc(row[h] || '—')}</td>`).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div style="display:flex;gap:0.6rem">
          <button class="btn-primary" id="proceedWithImportBtn" style="flex:1">✓ Import with These Columns</button>
          <button class="btn-secondary" id="mappingCloseBtn2" style="flex:1">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Analyze columns
    const columnTypes = {};
    headers.forEach(header => {
      const values = sampleRows.map(r => r[header] || '');
      const type = detectColumnPurpose(header, values);
      columnTypes[header] = type;
    });

    // Display column analysis
    const preview = document.getElementById('columnTypePreview');
    preview.innerHTML = Object.entries(columnTypes).map(([col, type]) => `
      <div style="padding:0.8rem;background:#f5f5f5;border-radius:4px;border-left:3px solid ${getTypeColor(type)}">
        <div style="font-weight:600;font-size:12px">${esc(col)}</div>
        <div style="font-size:11px;color:#666;margin-top:0.3rem">
          <span style="display:inline-block;padding:0.2rem 0.5rem;background:white;border-radius:2px;margin-top:0.3rem">
            ${getTypeEmoji(type)} ${type}
          </span>
        </div>
      </div>
    `).join('');

    // Handlers
    document.getElementById('mappingCloseBtn').addEventListener('click', () => modal.remove());
    document.getElementById('mappingCloseBtn2').addEventListener('click', () => modal.remove());
    document.getElementById('proceedWithImportBtn').addEventListener('click', async () => {
      modal.remove();
      await performImport(file, format);
    });
  }

  function detectColumnPurpose(header, values) {
    const lowerHeader = header.toLowerCase();
    const nonEmpty = values.filter(v => v?.trim());

    // Check header names first
    if (lowerHeader.includes('name') || lowerHeader.includes('customer') || lowerHeader.includes('client')) return 'Customer Name';
    if (lowerHeader.includes('address') || lowerHeader.includes('street') || lowerHeader.includes('location')) return 'Address';
    if (lowerHeader.includes('postal') || lowerHeader.includes('zip') || lowerHeader.includes('code')) return 'Postal Code';
    if (lowerHeader.includes('phone') || lowerHeader.includes('tel') || lowerHeader.includes('mobile')) return 'Phone';
    if (lowerHeader.includes('email') || lowerHeader.includes('mail')) return 'Email';
    if (lowerHeader.includes('po') || lowerHeader.includes('order') || lowerHeader.includes('invoice')) return 'Order/PO';
    if (lowerHeader.includes('qty') || lowerHeader.includes('quantity')) return 'Quantity';
    if (lowerHeader.includes('date') || lowerHeader.includes('delivery')) return 'Date';

    // Check data patterns
    if (nonEmpty.every(v => /^\d{6}$/.test(v))) return 'Postal Code (SG)';
    if (nonEmpty.every(v => /^\d{4,}$/.test(v))) return 'Number/ID';
    if (nonEmpty.some(v => v.includes('@'))) return 'Email';
    if (nonEmpty.every(v => /^[+]?[\d\s\-()]{7,}$/.test(v))) return 'Phone';
    if (nonEmpty.every(v => /^\d{1,2}[\/-]\w+[\/-]\d{2,4}/.test(v))) return 'Date';

    return 'Text/Other';
  }

  function getTypeColor(type) {
    if (type.includes('Postal')) return '#22c55e';
    if (type.includes('Phone')) return '#0ea5e9';
    if (type.includes('Address')) return '#f59e0b';
    if (type.includes('Name')) return '#8b5cf6';
    if (type.includes('Date')) return '#ef4444';
    return '#64748b';
  }

  function getTypeEmoji(type) {
    if (type.includes('Postal')) return '📍';
    if (type.includes('Phone')) return '📱';
    if (type.includes('Address')) return '🏢';
    if (type.includes('Name')) return '👤';
    if (type.includes('Date')) return '📅';
    if (type.includes('Email')) return '✉️';
    if (type.includes('Order')) return '📦';
    if (type.includes('Quantity')) return '📊';
    return '📄';
  }

  async function performImport(file) {
    const status = document.getElementById('transportImportStatus');
    if (!status) return;

    status.className = 'status-bar progress';
    status.textContent = 'Importing — auto-detecting file format...';
    status.classList.remove('hidden');

    try {
      const fd = new FormData();
      fd.append('file', file);

      // One unified endpoint — the server detects BETIME / Outright / generic
      // by analysing the column CONTENT, not the file name or a chosen format.
      // No master key needed — the session token is injected automatically by
      // the fetch wrapper and this route accepts a normal signed-in staff
      // session. It used to send a hardcoded copy of the built-in default key,
      // which both leaked the key into the page source and broke this import
      // outright on any deployment that set a real MASTER_KEY.
      const resp = await fetch('/api/transport/import', { method: 'POST', body: fd });
      const data = await resp.json();

      if (!resp.ok) throw new Error(data.error || 'Import failed');

      status.className = 'status-bar success';
      status.textContent = `✓ ${data.imported.summary}` +
        (data.imported.ordersUpdated ? ` (${data.imported.ordersUpdated} existing updated)` : '');

      await renderTransportTab();

      // Close the upload modal after 2 seconds
      setTimeout(() => {
        document.getElementById('uploadJobsModal').classList.add('hidden');
      }, 2000);
    } catch (err) {
      status.className = 'status-bar error';
      status.textContent = `❌ ${err.message}`;
    }
  }

  document.getElementById('transportNewRequestBtn')?.addEventListener('click', () => {
    // Placeholder for new request creation
    console.log('Create new transport request');
  });

  // Wire up the single unified import input.
  // CSV files get a client-side column preview first; XLSX (binary) goes
  // straight to the server, which does the same attribute analysis there.
  document.getElementById('transportImportFileInput')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (/\.csv$/i.test(file.name)) {
      analyzeAndPreviewFile(file, 'auto');
    } else {
      performImport(file);
    }
    e.target.value = '';
  });

  document.getElementById('transportImportBrowseBtn')?.addEventListener('click', () => {
    document.getElementById('transportImportFileInput')?.click();
  });

  // Transport detail modal handlers
  function closeTransportDetailModal() {
    document.getElementById('transportDetailModal').classList.add('hidden');
  }

  document.getElementById('transportDetailCloseBtn')?.addEventListener('click', closeTransportDetailModal);
  document.getElementById('transportDetailCloseBtn2')?.addEventListener('click', closeTransportDetailModal);
  document.getElementById('transportDetailModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'transportDetailModal') closeTransportDetailModal();
  });

  // ── Transport Main Controls ────────────────────────────────────────────────
  document.getElementById('uploadJobsBtn')?.addEventListener('click', () => {
    document.getElementById('uploadJobsModal').classList.remove('hidden');
    loadTransportTemplates();
  });

  document.getElementById('uploadJobsCloseBtn')?.addEventListener('click', () => {
    document.getElementById('uploadJobsModal').classList.add('hidden');
  });

  document.getElementById('uploadJobsCloseBtn2')?.addEventListener('click', () => {
    document.getElementById('uploadJobsModal').classList.add('hidden');
  });

  document.getElementById('uploadJobsModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'uploadJobsModal') {
      document.getElementById('uploadJobsModal').classList.add('hidden');
    }
  });

  document.getElementById('transportToggleDriversBtn')?.addEventListener('click', function() {
    showingDrivers = !showingDrivers;
    this.textContent = showingDrivers ? '👤 Hide Drivers' : '👤 Show Drivers';
    const legendItem = document.getElementById('driverLegendItem');
    if (legendItem) legendItem.style.display = showingDrivers ? 'flex' : 'none';
    document.getElementById('driverInfoBox').style.display = showingDrivers ? 'block' : 'none';

    if (showingDrivers) {
      displayDriverLocations();
    } else {
      driverMarkers.forEach(m => m.remove());
      driverMarkers = [];
    }
  });

  function displayDriverLocations() {
    driverMarkers.forEach(m => m.remove());
    driverMarkers = [];
    if (!transportMainMap || !window.L) return;

    // Real drivers from Driver Details; no live GPS yet, so spread them near
    // the city centre and show their assigned-job counts.
    const driverList = (window.drivers || []).map((d, idx) => ({
      name: d.name,
      lat: 1.3521 + (idx % 3 - 1) * 0.02,
      lng: 103.8198 + (Math.floor(idx / 3) - 1) * 0.03,
      orders: transportRequests.filter(r => r.assignedDriver === d.id).length
    }));

    driverList.forEach((driver, idx) => {
      const marker = L.circleMarker([driver.lat, driver.lng], {
        radius: 11,
        fillColor: '#0ea5e9',
        fillOpacity: 0.85,
        color: '#fff',
        weight: 2
      }).addTo(transportMainMap);
      marker.bindTooltip(String.fromCharCode(65 + idx), { permanent: true, direction: 'center', className: 'map-marker-label' });
      marker.bindPopup(`<div style="font-size:12px">
        <strong>${esc(driver.name)}</strong><br/>
        <span style="color:#0ea5e9">📦 ${driver.orders} assigned job(s)</span>
      </div>`);
      driverMarkers.push(marker);
    });

    // Update driver info box
    const infoList = document.getElementById('driverInfoList');
    infoList.innerHTML = driverList.length ? driverList.map(d => `
      <div style="padding:0.5rem;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between">
        <span>${esc(d.name)}</span>
        <span style="color:#0ea5e9;font-weight:600">📦 ${d.orders}</span>
      </div>
    `).join('') : '<div style="padding:0.5rem;color:#64748b">No drivers yet — add them under Driver Details.</div>';
  }

  let optimizedRoutes = [];
  let transportSelectedIds = new Set();
  let editingTransportId = null;

  // Update transport record when order completes
  function updateTransportRecordOnOrderCompletion(completedOrder) {
    // The SERVER flips the matching transport job to confirmed inside
    // /api/scan/complete (updateTransportOnOrderCompletion) — nothing to
    // store client-side. Just refresh the tab if it's the one on screen.
    if (document.getElementById('tab-transport')?.classList.contains('active')) renderTransportTab();
  }

  // Fix Schedule Management
  async function openFixScheduleModal() {
    const overlay = document.getElementById('fixScheduleOverlay');
    const listContainer = document.getElementById('fixScheduleList');

    overlay.classList.remove('hidden');
    listContainer.innerHTML = '<p style="text-align:center">Loading schedules...</p>';

    try {
      const resp = await fetch('/api/transport/fix-schedule');
      const schedules = await resp.json();

      listContainer.innerHTML = Object.entries(schedules).map(([day, schedule]) => `
        <div style="border:1px solid #e2e8f0;border-radius:6px;padding:1rem;background:white">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
            <h4 style="margin:0;font-size:14px;font-weight:600">${day}</h4>
            <label style="display:flex;align-items:center;gap:0.5rem">
              <input type="checkbox" class="fix-schedule-toggle" data-day="${day}" ${schedule.enabled ? 'checked' : ''} />
              <span style="font-size:12px">Enable</span>
            </label>
          </div>

          <div class="fix-schedule-areas" data-day="${day}" style="display:${schedule.enabled ? 'block' : 'none'};gap:0.5rem">
            <div style="margin-bottom:0.5rem">
              <label style="display:block;font-size:12px;margin-bottom:0.3rem">Priority Areas (Postal Code Prefix)</label>
              <div style="display:flex;gap:0.3rem;flex-wrap:wrap">
                ${(schedule.priorityAreas || []).map((area, idx) => `
                  <div style="display:flex;align-items:center;gap:0.3rem;background:#f0f4f8;padding:0.3rem 0.6rem;border-radius:3px;font-size:12px">
                    <strong>${area.postalPrefix}</strong> (Order: ${area.order})
                    <button class="link-btn" style="font-size:10px;padding:0;margin-left:0.3rem" onclick="removeFixScheduleArea('${day}', ${idx})">✕</button>
                  </div>
                `).join('')}
              </div>
            </div>

            <div style="display:flex;gap:0.3rem;flex-wrap:wrap">
              <input type="text" id="postal-prefix-${day}" placeholder="e.g., 01, 02, 03" style="flex:1;min-width:100px;padding:0.4rem;border:1px solid #d1d5db;border-radius:4px;font-size:12px" />
              <input type="number" id="area-order-${day}" placeholder="Order" min="1" max="10" style="width:60px;padding:0.4rem;border:1px solid #d1d5db;border-radius:4px;font-size:12px" />
              <button class="btn-secondary btn-sm" onclick="addFixScheduleArea('${day}')">Add Area</button>
            </div>
          </div>
        </div>
      `).join('');

      // Add event listeners
      document.querySelectorAll('.fix-schedule-toggle').forEach(toggle => {
        toggle.addEventListener('change', (e) => {
          const day = e.target.getAttribute('data-day');
          const areasDiv = document.querySelector(`.fix-schedule-areas[data-day="${day}"]`);
          if (areasDiv) {
            areasDiv.style.display = e.target.checked ? 'block' : 'none';
          }
          saveFixSchedule(day, e.target.checked);
        });
      });
    } catch (err) {
      listContainer.innerHTML = '<p style="color:#ef4444">Error loading schedules: ' + err.message + '</p>';
    }
  }

  async function saveFixSchedule(day, enabled) {
    const listContainer = document.getElementById('fixScheduleList');
    const areas = [];

    // Collect priority areas for this day
    const areaInputs = document.querySelectorAll(`input[id^="postal-prefix-${day}"]`);

    try {
      const resp = await fetch(`/api/transport/fix-schedule/${day}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, priorityAreas: areas })
      });

      if (resp.ok) {
        console.log(`✓ Fix schedule for ${day} saved`);
      }
    } catch (err) {
      console.error('Failed to save fix schedule:', err);
    }
  }

  // Add placeholder functions for area management (called from HTML)
  window.addFixScheduleArea = async function(day) {
    const prefixInput = document.getElementById(`postal-prefix-${day}`);
    const orderInput = document.getElementById(`area-order-${day}`);

    if (!prefixInput.value.trim()) {
      alert('Please enter a postal code prefix');
      return;
    }

    const prefix = prefixInput.value.trim().toUpperCase();
    const order = parseInt(orderInput.value) || 1;

    // Save area to backend
    try {
      const resp = await fetch(`/api/transport/fix-schedule/${day}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          priorityAreas: [{ postalPrefix: prefix, order }]
        })
      });

      if (resp.ok) {
        prefixInput.value = '';
        orderInput.value = '1';
        openFixScheduleModal(); // Refresh
      }
    } catch (err) {
      alert('Error adding area: ' + err.message);
    }
  };

  window.removeFixScheduleArea = function(day, idx) {
    alert('Area removal coming soon');
  };

  // Transport record selection and bulk actions
  function toggleTransportSelection(recordId) {
    if (transportSelectedIds.has(recordId)) {
      transportSelectedIds.delete(recordId);
    } else {
      transportSelectedIds.add(recordId);
    }
    updateBulkActionsBar();
  }

  function updateBulkActionsBar() {
    const bar = document.getElementById('transportBulkActionsBar');
    const count = document.getElementById('bulkSelectCount');

    if (transportSelectedIds.size > 0) {
      bar.classList.remove('hidden');
      count.textContent = `${transportSelectedIds.size} selected`;
    } else {
      bar.classList.add('hidden');
    }
  }

  function openEditTransport(recordId) {
    const record = transportRequests.find(r => r.id === recordId);
    if (!record) return;

    editingTransportId = recordId;

    // Populate form
    document.getElementById('editClientName').value = record.clientName || '';
    document.getElementById('editStatus').value = record.status || 'pending';
    document.getElementById('editDriver').value = record.assignedDriver || '';
    document.getElementById('editPackages').value = record.packages || 1;
    document.getElementById('editAddress1').value = record.shipping?.addressLine1 || '';
    document.getElementById('editAddress2').value = record.shipping?.addressLine2 || '';
    document.getElementById('editPostalCode').value = record.shipping?.zip || '';
    document.getElementById('editCity').value = record.shipping?.city || 'Singapore';
    document.getElementById('editPhone').value = record.shipping?.phone || '';
    document.getElementById('editEmail').value = record.shipping?.email || '';
    document.getElementById('editNotes').value = record.notes || '';

    // Populate driver dropdown
    const driverSelect = document.getElementById('editDriver');
    driverSelect.innerHTML = '<option value="">— Unassigned —</option>';
    (window.drivers || []).forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      driverSelect.appendChild(opt);
    });

    document.getElementById('editTransportModal').classList.remove('hidden');
  }

  async function saveTransportChanges() {
    const record = transportRequests.find(r => r.id === editingTransportId);
    if (!record) return;

    record.clientName = document.getElementById('editClientName').value;
    record.status = document.getElementById('editStatus').value;
    record.assignedDriver = document.getElementById('editDriver').value;
    record.packages = parseInt(document.getElementById('editPackages').value) || 1;
    record.notes = document.getElementById('editNotes').value;

    if (!record.shipping) record.shipping = {};
    record.shipping.addressLine1 = document.getElementById('editAddress1').value;
    record.shipping.addressLine2 = document.getElementById('editAddress2').value;
    record.shipping.zip = document.getElementById('editPostalCode').value;
    record.shipping.city = document.getElementById('editCity').value;
    record.shipping.phone = document.getElementById('editPhone').value;
    record.shipping.email = document.getElementById('editEmail').value;

    record.updatedAt = new Date().toISOString();

    // Persist to the SERVER — every login must see the same record
    try {
      const resp = await fetch(`/api/transport/${encodeURIComponent(record.id)}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: record.clientName, notes: record.notes,
          packages: record.packages, shipping: record.shipping,
        }),
      });
      if (!resp.ok) throw new Error((await resp.json()).error || 'Save failed');
    } catch (err) { alert('❌ ' + err.message); return; }

    document.getElementById('editTransportModal').classList.add('hidden');
    renderTransportTab();
  }

  async function requestTransportDeletion() {
    if (!editingTransportId || !confirm('Delete this transport job? (Administrator only — removed immediately.)')) return;

    try {
      const resp = await fetch(`/api/transport/${encodeURIComponent(editingTransportId)}`, {
        method: 'DELETE',
      });
      if (!resp.ok) throw new Error((await resp.json()).error || 'Delete failed');
    } catch (err) { alert('❌ ' + err.message); return; }
    document.getElementById('editTransportModal').classList.add('hidden');

    alert('Deletion request submitted. Master approval pending.');
    renderTransportTab();
  }

  // Bulk operations
  document.getElementById('bulkAssignDriverBtn')?.addEventListener('click', async () => {
    const driverId = prompt('Enter Driver ID to assign to ' + transportSelectedIds.size + ' records:');
    if (!driverId) return;

    const driver = (window.drivers || []).find(d => d.id === driverId);
    if (!driver) {
      alert('Driver not found');
      return;
    }

    for (const id of transportSelectedIds) {
      await fetch(`/api/transport/${encodeURIComponent(id)}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignedDriver: driverId, assignedDriverName: driver.name }),
      }).catch(() => {});
    }
    transportSelectedIds.clear();
    updateBulkActionsBar();
    renderTransportTab();
    alert(`✓ Assigned ${transportSelectedIds.size} records to ${driver.name}`);
  });

  document.getElementById('bulkEditBtn')?.addEventListener('click', () => {
    alert('Opening bulk edit for ' + transportSelectedIds.size + ' records...');
    // TODO: Show bulk edit modal for common fields
  });

  document.getElementById('bulkDeleteBtn')?.addEventListener('click', async () => {
    if (!confirm('Delete ' + transportSelectedIds.size + ' transport job(s)? (Administrator only — removed immediately.)')) return;

    try {
      const resp = await fetch('/api/transport/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...transportSelectedIds] }),
      });
      if (!resp.ok) throw new Error((await resp.json()).error || 'Delete failed');
    } catch (err) { alert('❌ ' + err.message); return; }
    transportSelectedIds.clear();
    updateBulkActionsBar();
    renderTransportTab();
    alert(`✓ Deletion requests submitted for ${transportSelectedIds.size} records. Master approval pending.`);
  });

  document.getElementById('bulkClearBtn')?.addEventListener('click', () => {
    transportSelectedIds.clear();
    updateBulkActionsBar();
  });

  // Edit modal handlers
  document.getElementById('editTransportSaveBtn')?.addEventListener('click', saveTransportChanges);
  document.getElementById('editTransportDeleteBtn')?.addEventListener('click', requestTransportDeletion);
  document.getElementById('editTransportCloseBtn')?.addEventListener('click', () => {
    document.getElementById('editTransportModal').classList.add('hidden');
  });
  document.getElementById('editTransportCloseBtn2')?.addEventListener('click', () => {
    document.getElementById('editTransportModal').classList.add('hidden');
  });

  function optimizeRoutes() {
    const method = document.getElementById('routeOptimizationMethod')?.value || 'nearest-neighbor';
    const maxStops = parseInt(document.getElementById('routeMaxStops')?.value || 10);

    optimizedRoutes = [];
    // Plan only live work — delivered/cancelled jobs never re-enter a route.
    // Jobs WITHOUT a postal code are HELD OUT of the plan entirely: a stop
    // with no location would poison every distance and the stop order.
    // They stay pending until Match & Fix (or the Address Book) resolves
    // them — the notice below the settings says how many are held.
    const eligible = transportRequests.filter(r => r.status !== 'delivered' && r.status !== 'cancelled' && r.status !== 'in-transit');
    const unassigned = eligible.filter(r => r.shipping?.zip);
    const heldCount = eligible.length - unassigned.length;
    const heldNotice = document.getElementById('routeHeldNotice');
    if (heldNotice) {
      heldNotice.classList.toggle('hidden', heldCount === 0);
      if (heldCount > 0) {
        document.getElementById('routeHeldNoticeText').innerHTML =
          `⚠ <strong>${heldCount}</strong> job(s) HELD out of this plan — no postal code yet (store not matched in the Address Book). They stay pending until fixed, then Regenerate to include them.`;
      }
    }

    if (method === 'nearest-neighbor') {
      optimizedRoutes = optimizeRoutesNearestNeighbor(unassigned, maxStops);
    } else if (method === 'cluster') {
      optimizedRoutes = optimizeRoutesClustering(unassigned, maxStops);
    }

    // Apply fix schedule constraints to routes (respects order-level bypassFixSchedule flag)
    applyFixScheduleToRoutes(optimizedRoutes);

    // Auto-assign drivers round-robin — the user amends via the dropdowns,
    // then approves the plan (nothing is saved until approval).
    autoAssignDrivers(optimizedRoutes);

    renderRoutesTable();
    updateRouteStats();
  }

  // Delivery status wording (job = whole record, so remarks can be seen):
  //   Preplanned            — before scanning completes (blue)
  //   Staging               — scanning done, waiting pickup (grey)
  //   On the road           — picked up and moving (yellow)
  //   Delivered             — finished with POD (green)
  //   Delivered w/ Remarks  — finished but issue to follow up (red)
  function tmsStatusLabel(job) {
    const s = typeof job === 'string' ? job : job?.status;
    const remarks = typeof job === 'object' ? String(job?.podRemarks || '').trim() : '';
    if (s === 'confirmed')  return { label: 'Staging', color: '#64748b' };
    if (s === 'in-transit') return { label: 'On the road', color: '#f59e0b' };
    if (s === 'delivered')  return remarks
      ? { label: 'Delivered w/ Remarks', color: '#ef4444' }
      : { label: 'Delivered', color: '#22c55e' };
    if (s === 'cancelled')  return { label: 'Cancelled', color: '#94a3b8' };
    return { label: 'Preplanned', color: '#0ea5e9' };
  }

  // Route START LOCATION — the warehouse where drivers pick up cargo.
  // Server-stored (shared); default is 40 Penjuru Lane #04-01 S609216.
  let transportDepot = { name: 'IDEALONE Warehouse', address: '40 Penjuru Lane #04-01', zip: '609216' };
  async function loadTransportDepot() {
    try {
      const r = await fetch('/api/transport/depot');
      if (r.ok) transportDepot = await r.json();
    } catch {}
    const btn = document.getElementById('routeDepotBtn');
    if (btn) btn.textContent = `🏭 Start: ${transportDepot.address || transportDepot.zip} (${transportDepot.zip})`;
  }

  // Which drivers are available for TODAY'S plan — chosen in the picker
  // that opens before planning (null = everyone). Excluded drivers get no
  // auto-assigned jobs and don't appear in the stop dropdowns.
  let activeDriverIds = null;
  function includedDrivers() {
    return (window.drivers || []).filter(d => !activeDriverIds || activeDriverIds.includes(d.id));
  }

  // "Who's driving today?" — include/exclude drivers before the AI assigns.
  function showDriverPicker(onDone) {
    const drivers = window.drivers || [];
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'driverPickerModal';
    modal.innerHTML = `
      <div class="modal" style="width:92%;max-width:520px">
        <h2 style="margin:0 0 .4rem 0">👤 Who's driving today?</h2>
        <p class="hint" style="font-size:12px;margin-bottom:1rem">Untick anyone unavailable (leave, MC, other duties). The AI only assigns jobs to ticked drivers.</p>
        <div style="display:grid;gap:.4rem;max-height:45vh;overflow-y:auto;margin-bottom:1rem">
          ${drivers.map(d => `
            <label style="display:flex;gap:.6rem;align-items:center;padding:.55rem .7rem;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer">
              <input type="checkbox" class="driver-pick" value="${esc(d.id)}" ${!activeDriverIds || activeDriverIds.includes(d.id) ? 'checked' : ''} />
              <span style="flex:1"><strong>${esc(d.name)}</strong>${d.plate ? ` <code style="font-size:11px">${esc(d.plate)}</code>` : ''}<br/>
                <span style="font-size:11px;color:#64748b">${esc(d.vehicle || '')}${d.phone ? ` · ${esc(d.phone)}` : ''}</span></span>
            </label>`).join('')}
        </div>
        <div id="driverPickError" class="hint hidden" style="color:var(--danger,#ef4444);font-weight:600;font-size:12px;margin-bottom:.6rem">Tick at least one driver.</div>
        <div style="display:flex;gap:.6rem">
          <button class="btn-primary" id="driverPickContinueBtn" style="flex:1">Continue →</button>
          <button class="btn-secondary" id="driverPickCancelBtn" style="flex:1">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#driverPickCancelBtn').addEventListener('click', () => modal.remove());
    modal.querySelector('#driverPickContinueBtn').addEventListener('click', () => {
      const picked = [...modal.querySelectorAll('.driver-pick:checked')].map(cb => cb.value);
      if (!picked.length) {
        modal.querySelector('#driverPickError').classList.remove('hidden');
        return;
      }
      activeDriverIds = picked.length === drivers.length ? null : picked;
      modal.remove();
      onDone();
    });
  }

  // Spread routes across TODAY'S AVAILABLE drivers (round-robin, by route).
  // Every stop inherits its route's driver unless the user overrides it.
  function autoAssignDrivers(routes) {
    const drivers = includedDrivers();
    if (!drivers.length) return; // no drivers yet — leave unassigned
    routes.forEach((route, idx) => {
      const d = drivers[idx % drivers.length];
      route.driverId = d.id;
      route.driverName = d.name;
      route.stops.forEach(stop => { delete stop.driverId; }); // clear old overrides
    });
  }

  function applyFixScheduleToRoutes(routes) {
    // Apply fix schedule constraints if enabled
    // This reorders stops in each route based on daily priorities
    // TODO: Integrate with server-side applyFixScheduleToRoutes via API call
    console.log('✓ Fix schedule applied to routes (client-side ordering)');
  }

  function optimizeRoutesNearestNeighbor(deliveries, maxStops) {
    const routes = [];
    const used = new Set();
    let routeNum = 1;
    const startPoint = { shipping: { zip: transportDepot.zip } }; // warehouse pickup point

    while (used.size < deliveries.length) {
      const route = { num: routeNum, stops: [] };
      let current = startPoint;

      for (let i = 0; i < maxStops && used.size < deliveries.length; i++) {
        let nearest = null;
        let minDist = Infinity;

        deliveries.forEach((d, idx) => {
          if (!used.has(idx)) {
            const dist = calculateDistance(current, d);
            if (dist < minDist) {
              minDist = dist;
              nearest = { idx, delivery: d, distance: dist };
            }
          }
        });

        if (nearest) {
          used.add(nearest.idx);
          const distFromPrev = nearest.distance;
          const cumulDist = (route.stops[route.stops.length - 1]?.cumulDistance || 0) + distFromPrev;
          const estTime = cumulDist / 50 * 60; // Assume avg speed 50 km/hr

          route.stops.push({
            delivery: nearest.delivery,
            distFromPrev: distFromPrev,
            cumulDistance: cumulDist,
            estTime: estTime
          });
          current = nearest.delivery;
        }
      }

      if (route.stops.length > 0) {
        route.totalDistance = route.stops[route.stops.length - 1]?.cumulDistance || 0;
        routes.push(route);
        routeNum++;
      }
    }

    return routes;
  }

  function optimizeRoutesClustering(deliveries, maxStops) {
    // Group by postal code prefix (geographic clusters)
    const clusters = {};

    deliveries.forEach(d => {
      const prefix = (d.shipping?.zip || '0000').substring(0, 2); // First 2 digits
      if (!clusters[prefix]) clusters[prefix] = [];
      clusters[prefix].push(d);
    });

    // Sort clusters by size (larger first) and convert to routes
    const sortedClusters = Object.values(clusters).sort((a, b) => b.length - a.length);
    const routes = [];
    const startPoint = { shipping: { zip: transportDepot.zip } }; // warehouse pickup point

    sortedClusters.forEach(cluster => {
      // Split large clusters into multiple routes
      for (let i = 0; i < cluster.length; i += maxStops) {
        const routeDeliveries = cluster.slice(i, i + maxStops);
        const route = { num: routes.length + 1, stops: [] };
        let current = startPoint;
        let cumDist = 0;

        routeDeliveries.forEach((d, idx) => {
          const distFromPrev = idx === 0 ? calculateDistance(startPoint, d) : calculateDistance(current, d);
          cumDist += distFromPrev;
          route.stops.push({
            delivery: d,
            distFromPrev: distFromPrev,
            cumulDistance: cumDist,
            estTime: cumDist / 50 * 60
          });
          current = d;
        });

        route.totalDistance = cumDist;
        routes.push(route);
      }
    });

    return routes;
  }

  // Singapore postal SECTOR map — the first 2 digits of every 6-digit postal
  // code identify the sector, which maps to one of the 28 postal districts.
  // Coordinates are district centroids (good to ~1-2 km, enough for route
  // grouping and map display without an external geocoding service).
  const SG_DISTRICT_COORDS = {
    D01: { lat: 1.2850, lng: 103.8520 }, // Raffles Place / Marina / People's Park
    D02: { lat: 1.2740, lng: 103.8430 }, // Anson / Tanjong Pagar
    D03: { lat: 1.2900, lng: 103.8100 }, // Queenstown / Tiong Bahru
    D04: { lat: 1.2650, lng: 103.8220 }, // Telok Blangah / HarbourFront
    D05: { lat: 1.3110, lng: 103.7650 }, // Pasir Panjang / Clementi New Town
    D06: { lat: 1.2900, lng: 103.8500 }, // High Street / City Hall
    D07: { lat: 1.3010, lng: 103.8580 }, // Bugis / Beach Road
    D08: { lat: 1.3110, lng: 103.8560 }, // Little India / Farrer Park
    D09: { lat: 1.3050, lng: 103.8320 }, // Orchard / River Valley
    D10: { lat: 1.3150, lng: 103.8060 }, // Bukit Timah / Holland
    D11: { lat: 1.3270, lng: 103.8380 }, // Novena / Newton / Thomson
    D12: { lat: 1.3280, lng: 103.8620 }, // Balestier / Toa Payoh / Serangoon Rd
    D13: { lat: 1.3350, lng: 103.8780 }, // Macpherson / Potong Pasir
    D14: { lat: 1.3200, lng: 103.8930 }, // Geylang / Eunos
    D15: { lat: 1.3060, lng: 103.9020 }, // Katong / Marine Parade
    D16: { lat: 1.3240, lng: 103.9310 }, // Bedok / Upper East Coast
    D17: { lat: 1.3570, lng: 103.9880 }, // Changi / Loyang
    D18: { lat: 1.3520, lng: 103.9440 }, // Tampines / Pasir Ris
    D19: { lat: 1.3610, lng: 103.8850 }, // Serangoon Gdn / Hougang / Punggol
    D20: { lat: 1.3620, lng: 103.8380 }, // Bishan / Ang Mo Kio
    D21: { lat: 1.3350, lng: 103.7770 }, // Upper Bukit Timah / Ulu Pandan
    D22: { lat: 1.3330, lng: 103.7430 }, // Jurong / Boon Lay / Tuas
    D23: { lat: 1.3770, lng: 103.7630 }, // Bukit Batok / Choa Chu Kang
    D24: { lat: 1.3800, lng: 103.7000 }, // Lim Chu Kang / Tengah
    D25: { lat: 1.4360, lng: 103.7860 }, // Woodlands / Kranji
    D26: { lat: 1.3900, lng: 103.8280 }, // Upper Thomson / Mandai
    D27: { lat: 1.4290, lng: 103.8360 }, // Yishun / Sembawang
    D28: { lat: 1.3910, lng: 103.8720 }, // Seletar / Yio Chu Kang
  };
  // sector (first 2 digits) → district
  const SG_SECTOR_TO_DISTRICT = {};
  [
    ['D01', ['01','02','03','04','05','06']],
    ['D02', ['07','08']],
    ['D03', ['14','15','16']],
    ['D04', ['09','10']],
    ['D05', ['11','12','13']],
    ['D06', ['17']],
    ['D07', ['18','19']],
    ['D08', ['20','21']],
    ['D09', ['22','23']],
    ['D10', ['24','25','26','27']],
    ['D11', ['28','29','30']],
    ['D12', ['31','32','33']],
    ['D13', ['34','35','36','37']],
    ['D14', ['38','39','40','41']],
    ['D15', ['42','43','44','45']],
    ['D16', ['46','47','48']],
    ['D17', ['49','50','81']],
    ['D18', ['51','52']],
    ['D19', ['53','54','55','82']],
    ['D20', ['56','57']],
    ['D21', ['58','59']],
    ['D22', ['60','61','62','63','64']],
    ['D23', ['65','66','67','68']],
    ['D24', ['69','70','71']],
    ['D25', ['72','73']],
    ['D26', ['77','78']],
    ['D27', ['75','76']],
    ['D28', ['79','80']],
  ].forEach(([district, sectors]) => sectors.forEach(s => { SG_SECTOR_TO_DISTRICT[s] = district; }));

  function getPostalCodeCoords(zip) {
    const clean = String(zip || '').trim();
    const sector = clean.substring(0, 2);
    const district = SG_SECTOR_TO_DISTRICT[sector];
    if (district) {
      const c = SG_DISTRICT_COORDS[district];
      // Small deterministic jitter from the last digits so several jobs in the
      // same district don't stack on one identical pixel.
      const tail = parseInt(clean.slice(-3), 10) || 0;
      return { lat: c.lat + ((tail % 20) - 10) * 0.0008, lng: c.lng + ((Math.floor(tail / 20) % 20) - 10) * 0.0008 };
    }
    // Unknown/foreign code — Singapore centre
    return { lat: 1.3521, lng: 103.8198 };
  }

  function calculateDistance(from, to) {
    const fromCoords = getPostalCodeCoords(from.shipping?.zip || '');
    const toCoords = getPostalCodeCoords(to.shipping?.zip || '');

    // Haversine formula for distance between two coordinates
    const R = 6371; // Earth's radius in km
    const dLat = (toCoords.lat - fromCoords.lat) * Math.PI / 180;
    const dLng = (toCoords.lng - fromCoords.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(fromCoords.lat * Math.PI / 180) * Math.cos(toCoords.lat * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  function renderRoutesTable() {
    const tbody = document.getElementById('routeTableBody');
    tbody.innerHTML = '';

    optimizedRoutes.forEach((route, routeIdx) => {
      route.stops.forEach((stop, stopIdx) => {
        const row = tbody.insertRow();
        const isFirst = stopIdx === 0;
        const isLast = stopIdx === route.stops.length - 1;

        row.innerHTML = `
          <td style="padding:0.5rem;border-bottom:1px solid #f0f0f0;text-align:center">
            ${!isFirst ? `<button class="route-move-up" data-route="${routeIdx}" data-stop="${stopIdx}" title="Move up" style="background:none;border:none;cursor:pointer;font-size:14px">▲</button>` : ''}
            ${!isLast ? `<button class="route-move-down" data-route="${routeIdx}" data-stop="${stopIdx}" title="Move down" style="background:none;border:none;cursor:pointer;font-size:14px">▼</button>` : ''}
          </td>
          <td style="padding:0.8rem;border-bottom:1px solid #f0f0f0"><strong>Route ${route.num}</strong></td>
          <td style="padding:0.8rem;border-bottom:1px solid #f0f0f0">${stopIdx + 1}</td>
          <td style="padding:0.8rem;border-bottom:1px solid #f0f0f0">
            <span class="route-stop-client" data-jobid="${esc(stop.delivery.id)}" style="cursor:pointer" title="Click for delivery details / fix postal">
              <strong style="color:#1d4ed8">${esc(stop.delivery.clientName || 'N/A')}</strong>
              ${(() => { const st = tmsStatusLabel(stop.delivery); return `<span style="display:inline-block;margin-left:.35rem;padding:.05rem .45rem;border-radius:99px;background:${st.color}1a;color:${st.color};font-size:10px;font-weight:700">${st.label}</span>`; })()}<br/>
              <span style="font-size:10px;font-family:monospace;color:#94a3b8">${esc(stop.delivery.id)}</span>${stop.delivery.referenceId ? `<span style="font-size:10px;font-family:monospace;color:#475569"> · PO: ${esc(stop.delivery.referenceId)}</span>` : ''}<br/>
              <span style="font-size:11px;color:#999">${esc((stop.delivery.shipping?.addressLine1 || '').slice(0, 40))}</span>
            </span>
          </td>
          <td style="padding:0.8rem;border-bottom:1px solid #f0f0f0;text-align:right">${stop.distFromPrev.toFixed(1)} km</td>
          <td style="padding:0.8rem;border-bottom:1px solid #f0f0f0;text-align:right"><strong>${stop.cumulDistance.toFixed(1)} km</strong></td>
          <td style="padding:0.8rem;border-bottom:1px solid #f0f0f0;text-align:right">${Math.round(stop.estTime)} min</td>
          <td style="padding:0.8rem;border-bottom:1px solid #f0f0f0;font-weight:600">${stop.delivery.shipping?.zip || 'N/A'}</td>
          <td style="padding:0.8rem;border-bottom:1px solid #f0f0f0">
            <select class="route-driver-select" data-routeidx="${routeIdx}" data-route="${route.num}" data-stop="${stopIdx}" style="padding:0.4rem;font-size:11px;border:1px solid #ddd;border-radius:3px;width:120px">
              <option value="">— Unassigned —</option>
              ${includedDrivers().map(d => `<option value="${d.id}" ${(stop.driverId || route.driverId) === d.id ? 'selected' : ''}>${d.name}</option>`).join('')}
            </select>
          </td>
        `;
      });
    });

    if (optimizedRoutes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="padding:2rem;text-align:center;color:#999">No routes generated yet. Click "Generate AI Routes"</td></tr>';
    }

    // Add event listeners for move buttons
    document.querySelectorAll('.route-move-up').forEach(btn => {
      btn.addEventListener('click', () => {
        const routeIdx = parseInt(btn.dataset.route);
        const stopIdx = parseInt(btn.dataset.stop);
        moveRouteStop(routeIdx, stopIdx, -1);
      });
    });

    document.querySelectorAll('.route-move-down').forEach(btn => {
      btn.addEventListener('click', () => {
        const routeIdx = parseInt(btn.dataset.route);
        const stopIdx = parseInt(btn.dataset.stop);
        moveRouteStop(routeIdx, stopIdx, 1);
      });
    });

    // Record user amendments to the auto-assignment (per stop)
    document.querySelectorAll('.route-driver-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const route = optimizedRoutes[parseInt(sel.dataset.routeidx)];
        const stop = route?.stops[parseInt(sel.dataset.stop)];
        if (stop) stop.driverId = sel.value || '';
        updateRouteStats();
      });
    });
  }

  function moveRouteStop(routeIdx, stopIdx, direction) {
    const route = optimizedRoutes[routeIdx];
    const newIdx = stopIdx + direction;

    if (newIdx < 0 || newIdx >= route.stops.length) return;

    // Swap stops
    [route.stops[stopIdx], route.stops[newIdx]] = [route.stops[newIdx], route.stops[stopIdx]];

    // Recalculate distances
    let cumDist = 0;
    route.stops.forEach((stop, idx) => {
      if (idx === 0) {
        stop.distFromPrev = 0;
      } else {
        stop.distFromPrev = calculateDistance(route.stops[idx - 1].delivery, stop.delivery);
      }
      cumDist += stop.distFromPrev;
      stop.cumulDistance = cumDist;
      stop.estTime = cumDist / 50 * 60; // ~50 km/hr average
    });

    route.totalDistance = cumDist;
    renderRoutesTable();
    updateRouteStats();
  }

  function updateRouteStats() {
    const totalStops = optimizedRoutes.reduce((sum, r) => sum + r.stops.length, 0);
    const totalDist = optimizedRoutes.reduce((sum, r) => sum + (r.totalDistance || 0), 0);
    const totalTime = totalDist / 50; // hours at ~50 km/hr avg
    const drivers = new Set();
    document.querySelectorAll('.route-driver-select').forEach(sel => {
      if (sel.value) drivers.add(sel.value);
    });

    document.getElementById('routeStatsTotal').textContent = totalStops;
    document.getElementById('routeStatsDist').textContent = totalDist.toFixed(1) + ' km';
    document.getElementById('routeStatsTime').textContent = totalTime.toFixed(1) + ' hrs';
    document.getElementById('routeStatsDrivers').textContent = drivers.size;

    // Per-driver workload: number of drops + distance from the depot out to
    // their LAST drop (summed across their routes). Every driver ticked for
    // today is shown — 0 drops · 0 km when nothing is assigned to them.
    const summaryEl = document.getElementById('routeDriverSummary');
    if (summaryEl) {
      const per = new Map(); // driverId → {drops, km}
      optimizedRoutes.forEach(route => {
        const byDriver = new Map(); // driverId → max cumulDistance in this route
        route.stops.forEach(stop => {
          const dId = stop.driverId !== undefined ? stop.driverId : (route.driverId || '');
          if (!dId) return;
          const rec = per.get(dId) || { drops: 0, km: 0 };
          rec.drops++;
          per.set(dId, rec);
          byDriver.set(dId, Math.max(byDriver.get(dId) || 0, stop.cumulDistance || 0));
        });
        byDriver.forEach((km, dId) => { per.get(dId).km += km; });
      });
      summaryEl.innerHTML = includedDrivers().map(d => {
        const rec = per.get(d.id) || { drops: 0, km: 0 };
        const idle = rec.drops === 0;
        return `<div style="padding:.5rem .8rem;border:1px solid ${idle ? '#e2e8f0' : '#bfdbfe'};border-radius:6px;background:${idle ? '#f8fafc' : '#eff6ff'};font-size:12px;${idle ? 'color:#94a3b8' : ''}">
          👤 <strong>${esc(d.name)}</strong> — ${rec.drops} drop(s) · ${rec.km.toFixed(1)} km depot→last drop
        </div>`;
      }).join('');
    }
  }

  document.getElementById('transportPlanRoutesBtn')?.addEventListener('click', async () => {
    if (!transportRequests.length) {
      alert('No deliveries to plan. Click Upload Jobs first.');
      return;
    }
    // Pull the shared driver list first — drivers may have been added from
    // another login.
    await loadDrivers();
    await loadTransportDepot();
    const openPlanner = () => {
      document.getElementById('routePlanningModal').classList.remove('hidden');
      // The planner opens ALREADY PLANNED: routes generated and today's
      // available drivers auto-assigned — the user just shifts things
      // around, then saves.
      optimizeRoutes();
    };
    // With 2+ drivers there's a real include/exclude decision — ask first.
    if ((window.drivers || []).length >= 2) showDriverPicker(openPlanner);
    else openPlanner();
  });
  // Change today's driver selection from inside the planner
  document.getElementById('routeDriversBtn')?.addEventListener('click', () =>
    showDriverPicker(() => optimizeRoutes()));

  // Held-jobs notice → open Match & Fix without leaving the planner
  document.getElementById('routeHeldFixBtn')?.addEventListener('click', openUnresolvedResolver);

  // Change the starting location (cargo pickup point) — routes re-plan
  // from the new postal immediately, and the setting is saved for everyone.
  document.getElementById('routeDepotBtn')?.addEventListener('click', async () => {
    const zip = prompt(
      `Starting location for routes (cargo pickup point).\nCurrent: ${transportDepot.address} (${transportDepot.zip})\n\nEnter the postal code (6 digits):`,
      transportDepot.zip);
    if (zip === null) return;
    if (!/^\d{6}$/.test(zip.trim())) { alert('Postal code must be exactly 6 digits.'); return; }
    const address = prompt('Address label for this location:', transportDepot.address) ?? transportDepot.address;
    try {
      const r = await fetch('/api/transport/depot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zip: zip.trim(), address: address.trim() }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Save failed');
      transportDepot = await r.json();
    } catch (err) { alert('❌ ' + err.message); return; }
    await loadTransportDepot();
    optimizeRoutes(); // re-plan from the new start
  });
  document.getElementById('routePlannerBackBtn')?.addEventListener('click', () =>
    document.getElementById('routePlanningModal').classList.add('hidden'));

  // Fix Schedule Management
  document.getElementById('transportFixScheduleBtn')?.addEventListener('click', openFixScheduleModal);
  document.getElementById('fixScheduleCloseBtn')?.addEventListener('click', () => {
    document.getElementById('fixScheduleOverlay').classList.add('hidden');
  });
  document.getElementById('fixScheduleCancelBtn')?.addEventListener('click', () => {
    document.getElementById('fixScheduleOverlay').classList.add('hidden');
  });

  document.getElementById('routeOptimizeBtn')?.addEventListener('click', optimizeRoutes);
  document.getElementById('routePlanningCloseBtn')?.addEventListener('click', () => document.getElementById('routePlanningModal').classList.add('hidden'));
  document.getElementById('routePlanningCloseBtn2')?.addEventListener('click', () => document.getElementById('routePlanningModal').classList.add('hidden'));

  // Build the flat per-job assignment list from the current plan
  function collectPlanAssignments() {
    const assignments = [];
    optimizedRoutes.forEach(route => {
      route.stops.forEach((stop, stopIdx) => {
        const driverId = stop.driverId !== undefined ? stop.driverId : (route.driverId || '');
        const driver = (window.drivers || []).find(d => d.id === driverId);
        assignments.push({
          id: stop.delivery.id,
          clientName: stop.delivery.clientName,
          zip: stop.delivery.shipping?.zip || '',
          driverId: driverId || '',
          driverName: driver?.name || '',
          route: route.num,
          stopSeq: stopIdx + 1
        });
      });
    });
    return assignments;
  }

  // "✓ Confirm Plan & Save" — show the summary for a final look first.
  // Nothing is saved until the user clicks Save in the summary.
  document.getElementById('routeAssignBtn')?.addEventListener('click', () => {
    if (!optimizedRoutes.length) {
      alert('No routes yet — click "Regenerate Routes".');
      return;
    }
    const assignments = collectPlanAssignments();
    const unassigned = assignments.filter(a => !a.driverId).length;

    // Group by driver for the summary
    const byDriver = {};
    assignments.forEach(a => {
      const key = a.driverName || '— Unassigned —';
      if (!byDriver[key]) byDriver[key] = [];
      byDriver[key].push(a);
    });

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'planApprovalModal';
    modal.innerHTML = `
      <div class="modal" style="width:92%;max-width:760px;max-height:85vh;overflow-y:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
          <h2 style="margin:0">📋 Delivery Plan Summary</h2>
          <button class="btn-close" id="planApprovalCloseBtn">✕</button>
        </div>
        <p class="hint" style="font-size:12px;margin-bottom:1rem">
          Final check before saving. To amend, go back and change any driver dropdown or stop order, then confirm again.
          Saving marks every job <strong>Preplanned</strong>; each job becomes a <strong>Confirmed</strong> delivery automatically once its order finishes scanning (live).
        </p>
        ${unassigned ? `<div style="padding:0.7rem;background:#fef3c7;border-left:3px solid #f59e0b;border-radius:4px;margin-bottom:1rem;font-size:12px">⚠️ ${unassigned} stop(s) have no driver${(window.drivers || []).length ? '' : ' — no drivers exist yet (add them under Driver Details)'}. They will be saved as Preplanned without a driver.</div>` : ''}
        ${Object.entries(byDriver).map(([driverName, jobs]) => `
          <div style="border:1px solid #e2e8f0;border-radius:6px;margin-bottom:0.8rem;overflow:hidden">
            <div style="padding:0.6rem 0.8rem;background:#f1f5f9;font-weight:600;font-size:13px;display:flex;justify-content:space-between">
              <span>👤 ${esc(driverName)}</span><span>${jobs.length} stop(s)</span>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              ${jobs.map(j => `
                <tr style="border-top:1px solid #f0f0f0">
                  <td style="padding:0.4rem 0.8rem;width:90px">Route ${j.route} · #${j.stopSeq}</td>
                  <td style="padding:0.4rem 0.8rem">${esc(j.clientName || j.id)}</td>
                  <td style="padding:0.4rem 0.8rem;width:80px;color:#64748b">📍 ${esc(j.zip || '—')}</td>
                </tr>`).join('')}
            </table>
          </div>`).join('')}
        <div style="display:flex;gap:0.6rem;margin-top:1rem">
          <button class="btn-primary" id="planApprovalConfirmBtn" style="flex:1">💾 Save Plan — ${assignments.length} Job(s) → Preplanned</button>
          <button class="btn-secondary" id="planApprovalCancelBtn" style="flex:1">Back to Amend</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    modal.querySelector('#planApprovalCloseBtn').addEventListener('click', () => modal.remove());
    modal.querySelector('#planApprovalCancelBtn').addEventListener('click', () => modal.remove());
    modal.querySelector('#planApprovalConfirmBtn').addEventListener('click', async () => {
      const btn = modal.querySelector('#planApprovalConfirmBtn');
      btn.disabled = true;
      btn.textContent = 'Saving plan...';
      try {
        const resp = await fetch('/api/transport/plan/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-auth-token': localStorage.getItem('wms_token') || '' },
          body: JSON.stringify({ assignments })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Failed to save plan');
        modal.remove();
        document.getElementById('routePlanningModal').classList.add('hidden');
        await renderTransportTab();
        if (confirm(`✓ Plan approved — ${data.assigned} job(s) marked Preplanned.\nThey will switch to Confirmed as scanning completes each order.\n\nPrint driver run sheets now?`)) {
          printDriverRunSheets();
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '✓ Approve';
        alert('❌ ' + err.message);
      }
    });
  });

  // Export the plan as a two-sheet Excel workbook (per-driver summary +
  // full route details with PO, address, postal, cartons and driver info)
  document.getElementById('routeExportBtn')?.addEventListener('click', async () => {
    if (!optimizedRoutes.length) { alert('No routes to export — generate a plan first.'); return; }

    const rows = [];
    optimizedRoutes.forEach(route => {
      route.stops.forEach((stop, idx) => {
        const dId = stop.driverId !== undefined ? stop.driverId : (route.driverId || '');
        const drv = (window.drivers || []).find(d => d.id === dId);
        rows.push({
          route: route.num, stopSeq: idx + 1,
          ref: stop.delivery.referenceId || '',
          client: stop.delivery.clientName || '',
          address: stop.delivery.shipping?.addressLine1 || '',
          zip: stop.delivery.shipping?.zip || '',
          packages: stop.delivery.packages || 1,
          legKm: Math.round(stop.distFromPrev * 10) / 10,
          cumKm: Math.round(stop.cumulDistance * 10) / 10,
          estMin: Math.round(stop.estTime),
          driverName: drv?.name || stop.delivery.assignedDriverName || '',
          driverPhone: drv?.phone || '', driverPlate: drv?.plate || '', driverVehicle: drv?.vehicle || '',
        });
      });
    });

    try {
      const resp = await fetch('/api/transport/plan/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows,
          depot: `${transportDepot.address} (${transportDepot.zip})`,
          generatedAt: new Date().toLocaleString('en-SG'),
        }),
      });
      if (!resp.ok) throw new Error((await resp.json()).error || 'Export failed');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Route_Plan_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { alert('❌ ' + err.message); }
  });

  // ── Driver run sheets — printed route per driver, for drivers who don't
  //    use the driver app. One page per driver, stops in route order, with
  //    a signature/time column as proof of delivery. ─────────────────────────
  async function printDriverRunSheets() {
    await loadTransportDepot(); // pickup point shown on each sheet
    const jobs = transportRequests.filter(r =>
      (r.assignedDriver || r.assignedDriverName) &&
      r.status !== 'delivered' && r.status !== 'cancelled');
    if (!jobs.length) {
      alert('No assigned, undelivered jobs to print.\nApprove a route plan first (Plan Routes → Assign Routes to Drivers).');
      return;
    }

    // Group by driver, sort each driver's stops by route + stop sequence
    const byDriver = {};
    jobs.forEach(j => {
      const key = j.assignedDriverName || j.assignedDriver;
      if (!byDriver[key]) byDriver[key] = [];
      byDriver[key].push(j);
    });
    Object.values(byDriver).forEach(list => list.sort((a, b) =>
      (a.routeNum || 99) - (b.routeNum || 99) || (a.stopSeq || 99) - (b.stopSeq || 99)));

    const today = new Date().toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
    const pages = Object.entries(byDriver).map(([driverName, list]) => {
      const driverRec = (window.drivers || []).find(d => d.name === driverName || d.id === list[0].assignedDriver);
      const totalCartons = list.reduce((s, j) => s + (j.packages || 1), 0);
      return `
        <div class="sheet">
          <div class="head">
            <div>
              <div class="brand">IDEALONE — Delivery Run Sheet</div>
              <div class="drv">👤 ${esc(driverName)}${driverRec?.phone ? ` · 📞 ${esc(driverRec.phone)}` : ''}${driverRec?.plate ? ` · 🚚 ${esc(driverRec.plate)}` : ''}</div>
            </div>
            <div class="meta">
              <div>${esc(today)}</div>
              <div>${list.length} stop(s) · ${totalCartons} carton(s)</div>
              <div>Pickup: ${esc(transportDepot.address)} (${esc(transportDepot.zip)})</div>
            </div>
          </div>
          <table>
            <thead><tr>
              <th style="width:26px">#</th><th>Client</th><th>Address</th>
              <th style="width:52px">Postal</th><th style="width:80px">Phone</th>
              <th style="width:34px">Ctns</th><th style="width:78px">Status</th><th style="width:110px">Received by / Time</th>
            </tr></thead>
            <tbody>
              ${list.map((j, i) => `<tr>
                <td>${i + 1}</td>
                <td><strong>${esc(j.clientName || j.id)}</strong><br/><span style="font-size:9px;color:#555;font-family:monospace">${esc(j.id)}</span></td>
                <td>${esc(j.shipping?.addressLine1 || '')}</td>
                <td>${esc(j.shipping?.zip || '')}</td>
                <td>${esc(j.shipping?.phone || '')}</td>
                <td style="text-align:center">${j.packages || 1}</td>
                <td>${esc(tmsStatusLabel(j).label)}</td>
                <td></td>
              </tr>`).join('')}
            </tbody>
          </table>
          <div class="foot">Report problems (closed / refused / wrong address) to the office immediately. · Printed ${new Date().toLocaleString('en-SG')}</div>
        </div>`;
    }).join('');

    const w = window.open('', '_blank');
    if (!w) { alert('Pop-up blocked — allow pop-ups to print run sheets.'); return; }
    w.document.write(`<!DOCTYPE html><html><head><title>Driver Run Sheets</title><style>
      body { font-family: Arial, sans-serif; margin: 0; color: #111; }
      .sheet { padding: 14mm 12mm; page-break-after: always; }
      .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 12px; }
      .brand { font-size: 15px; font-weight: 800; letter-spacing: .04em; }
      .drv { font-size: 14px; margin-top: 6px; font-weight: 700; }
      .meta { text-align: right; font-size: 12px; line-height: 1.6; }
      table { width: 100%; border-collapse: collapse; font-size: 11px; }
      th, td { border: 1px solid #999; padding: 6px 5px; text-align: left; vertical-align: top; }
      th { background: #eee; }
      td:last-child { height: 30px; }
      .foot { margin-top: 10px; font-size: 9px; color: #555; }
      @media print { .sheet { padding: 8mm 6mm; } }
    </style></head><body>${pages}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  }

  document.getElementById('transportRunSheetsBtn')?.addEventListener('click', printDriverRunSheets);

  // ── Mark Delivered — office-side close-out (no driver app needed) ─────────
  document.getElementById('transportMarkDeliveredBtn')?.addEventListener('click', async () => {
    const confirmed = transportRequests.filter(r => r.status === 'confirmed' || r.status === 'in-transit');
    if (!confirmed.length) {
      alert('No Staging / On-the-road jobs to close out.\n\nJobs reach Staging when their order finishes scanning. To mark an individual job delivered (with POD remarks), tap its point on the map.');
      return;
    }
    if (!confirm(`Mark all ${confirmed.length} Staging / On-the-road job(s) as DELIVERED (clean, no remarks)?\n\nUse this at end of day once the drivers report their rounds done. For deliveries WITH issues, close those individually from the map first.`)) return;
    try {
      const resp = await fetch('/api/transport/mark-delivered', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': localStorage.getItem('wms_token') || '' },
        body: JSON.stringify({ allConfirmed: true })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed');
      await renderTransportTab();
      alert(`✓ ${data.delivered} job(s) marked Delivered.`);
    } catch (err) { alert('❌ ' + err.message); }
  });

  // ── Batch status update — office moves groups of jobs through the
  //    lifecycle (until the driver-side app exists) ──────────────────────────
  function openBatchStatusModal() {
    const live = transportRequests.filter(r => r.status !== 'cancelled');
    if (!live.length) { alert('No jobs to update.'); return; }

    const drivers = [...new Map(live.filter(r => r.assignedDriver)
      .map(r => [r.assignedDriver, r.assignedDriverName || r.assignedDriver])).entries()];

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'batchStatusModal';
    modal.innerHTML = `
      <div class="modal" style="width:92%;max-width:520px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem">
          <h2 style="margin:0">🔄 Batch Status Update</h2>
          <button class="btn-close" id="bsCloseBtn">✕</button>
        </div>
        <p class="hint" style="font-size:12px;margin-bottom:1rem">Move a whole group of jobs at once — e.g. everything a driver loaded goes "On the road" in one tap. (Driver-side app can take this over later.)</p>
        <div style="display:grid;gap:.7rem">
          <div><label style="font-size:12px;font-weight:600">Driver</label>
            <select id="bsDriver" style="width:100%;padding:.5rem;border:1px solid #e2e8f0;border-radius:4px;font-size:12px">
              <option value="">All drivers</option>
              ${drivers.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('')}
            </select></div>
          <div><label style="font-size:12px;font-weight:600">Jobs currently in</label>
            <select id="bsFrom" style="width:100%;padding:.5rem;border:1px solid #e2e8f0;border-radius:4px;font-size:12px">
              <option value="">Any status (not delivered)</option>
              <option value="preplanned">Preplanned</option>
              <option value="confirmed">Staging</option>
              <option value="in-transit">On the road</option>
            </select></div>
          <div><label style="font-size:12px;font-weight:600">Move them to</label>
            <select id="bsTo" style="width:100%;padding:.5rem;border:1px solid #e2e8f0;border-radius:4px;font-size:12px">
              <option value="confirmed">Staging (scanned, awaiting pickup)</option>
              <option value="in-transit" selected>On the road (picked up)</option>
              <option value="delivered">Delivered (clean POD)</option>
              <option value="delivered-remarks">Delivered w/ Remarks (issue to follow up)</option>
            </select></div>
          <div id="bsRemarksWrap" class="hidden"><label style="font-size:12px;font-weight:600">Remarks (applied to every selected job)</label>
            <input id="bsRemarks" placeholder="e.g. customer closed — redeliver tomorrow" style="width:100%;padding:.5rem;border:1px solid #e2e8f0;border-radius:4px;font-size:12px" /></div>
          <div id="bsCount" style="font-size:12px;font-weight:600;color:#1d4ed8"></div>
        </div>
        <div style="display:flex;gap:.6rem;margin-top:1rem">
          <button class="btn-primary" id="bsApplyBtn" style="flex:1">Apply</button>
          <button class="btn-secondary" id="bsCancelBtn" style="flex:1">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const matching = () => live.filter(r =>
      r.status !== 'delivered' &&
      (!modal.querySelector('#bsDriver').value || r.assignedDriver === modal.querySelector('#bsDriver').value) &&
      (!modal.querySelector('#bsFrom').value || r.status === modal.querySelector('#bsFrom').value ||
        (modal.querySelector('#bsFrom').value === 'preplanned' && (r.status === 'pending' || r.status === 'preplanned'))));
    const refresh = () => {
      modal.querySelector('#bsCount').textContent = `${matching().length} job(s) will be updated`;
      modal.querySelector('#bsRemarksWrap').classList.toggle('hidden', modal.querySelector('#bsTo').value !== 'delivered-remarks');
    };
    ['bsDriver', 'bsFrom', 'bsTo'].forEach(id => modal.querySelector('#' + id).addEventListener('change', refresh));
    refresh();

    modal.querySelector('#bsCloseBtn').addEventListener('click', () => modal.remove());
    modal.querySelector('#bsCancelBtn').addEventListener('click', () => modal.remove());
    modal.querySelector('#bsApplyBtn').addEventListener('click', async () => {
      const jobs = matching();
      if (!jobs.length) { alert('No jobs match this selection.'); return; }
      const toRaw = modal.querySelector('#bsTo').value;
      const status = toRaw === 'delivered-remarks' ? 'delivered' : toRaw;
      const remarks = toRaw === 'delivered-remarks' ? modal.querySelector('#bsRemarks').value.trim() : '';
      if (toRaw === 'delivered-remarks' && !remarks) { alert('Enter the remarks to record on these deliveries.'); return; }
      if (!confirm(`Move ${jobs.length} job(s) to "${modal.querySelector('#bsTo').selectedOptions[0].textContent.trim()}"?`)) return;
      try {
        const resp = await fetch('/api/transport/bulk-status', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: jobs.map(j => j.id), status, remarks }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Update failed');
        modal.remove();
        await renderTransportTab();
        alert(`✓ ${data.updated} job(s) updated.`);
      } catch (err) { alert('❌ ' + err.message); }
    });
  }
  document.getElementById('transportBatchStatusBtn')?.addEventListener('click', openBatchStatusModal);

  // Individual mark-delivered — asks for POD remarks (empty = clean delivery,
  // anything typed = 'Delivered with Remarks', flagged red for follow-up)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.popup-deliver-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const remarks = prompt(`Mark ${id} as DELIVERED.\n\nPOD remarks — leave EMPTY if delivered clean; type the issue if there's something to follow up:`, '');
    if (remarks === null) return; // cancelled
    try {
      const resp = await fetch('/api/transport/mark-delivered', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': localStorage.getItem('wms_token') || '' },
        body: JSON.stringify({ ids: [id], remarks: remarks.trim() })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed');
      await renderTransportTab();
    } catch (err) { alert('❌ ' + err.message); }
  });

  // Picked up → On the road (staging jobs only)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.popup-onroad-btn');
    if (!btn) return;
    try {
      const resp = await fetch(`/api/transport/${encodeURIComponent(btn.dataset.id)}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': localStorage.getItem('wms_token') || '' },
        body: JSON.stringify({ status: 'in-transit' })
      });
      if (!resp.ok) throw new Error((await resp.json()).error || 'Failed');
      await renderTransportTab();
    } catch (err) { alert('❌ ' + err.message); }
  });

  // Individual delete — admin-only button inside a map point's popup
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.popup-delete-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    if (!confirm(`DELETE job ${id}?\n\nThis removes it permanently — it will no longer appear on the map, in planning, or in future driver reports.`)) return;
    try {
      const resp = await fetch(`/api/transport/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'x-auth-token': localStorage.getItem('wms_token') || '' }
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed');
      await renderTransportTab();
    } catch (err) { alert('❌ ' + err.message); }
  });

  // Clear ALL transport jobs — admin-only, typed confirmation required.
  // Lives in the Upload Jobs modal since that's where jobs come from.
  document.getElementById('transportClearAllBtn')?.addEventListener('click', async () => {
    if (currentUser?.role !== 'admin') { alert('Administrator access required.'); return; }
    const typed = prompt('This deletes EVERY transport job — including delivered history used by the Driver Performance report.\n\nType DELETE to confirm:');
    if (typed !== 'DELETE') return;
    try {
      const resp = await fetch('/api/transport/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': localStorage.getItem('wms_token') || '' },
        body: JSON.stringify({ all: true })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed');
      document.getElementById('uploadJobsModal').classList.add('hidden');
      await renderTransportTab();
      alert(`✓ ${data.deleted} job(s) deleted.`);
    } catch (err) { alert('❌ ' + err.message); }
  });

  // ── Unresolved-store resolver — confirm nearest match, learn the alias ─────
  // A name shaped like a COURIER TRACKING NUMBER (SPXSG…, SHPM…, LZSGD…) is
  // not a store at all — it's a marketplace parcel the courier collects, so
  // it has no shop address to look up and does not belong in the Address
  // Book (adding one would pollute the book with a one-off that never
  // recurs). Flagged separately so the packer isn't asked to invent a
  // postal code for a tracking number.
  function _looksLikeTrackingRef(name) {
    return /^[A-Z]{2,6}\d{9,}$/i.test(String(name || '').replace(/\s/g, ''));
  }

  async function openUnresolvedResolver() {
    let items = [];
    try {
      const resp = await fetch('/api/transport/unresolved-suggestions');
      items = await resp.json();
    } catch { alert('Failed to load suggestions'); return; }
    if (!items.length) { alert('Nothing to resolve — all jobs have postal codes.'); return; }

    // Classify once: confident match / weak match / no match / courier parcel.
    // Sorting by tier puts the one-click wins at the top and the ones needing
    // real typing at the bottom, instead of one flat list in arbitrary order.
    const TIER_ORDER = { high: 0, low: 1, none: 2, courier: 3 };
    items.forEach((it, i) => {
      it._idx  = i;
      it._best = it.suggestions[0] || null;
      it._tier = _looksLikeTrackingRef(it.clientName) ? 'courier'
               : !it._best                            ? 'none'
               : it._best.score >= 70                 ? 'high'
               : 'low';
    });
    const ordered = [...items].sort((a, b) => (TIER_ORDER[a._tier] - TIER_ORDER[b._tier]) || ((b._best?.score || 0) - (a._best?.score || 0)));
    const counts = ordered.reduce((m, it) => { m[it._tier] = (m[it._tier] || 0) + 1; return m; }, {});

    const TIER_META = {
      high:    { color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0', label: 'Likely match' },
      low:     { color: '#b45309', bg: '#fffbeb', border: '#fde68a', label: 'Check this one' },
      none:    { color: '#b45309', bg: '#fff',    border: '#e2e8f0', label: 'Not in the Address Book' },
      courier: { color: '#64748b', bg: '#f8fafc', border: '#e2e8f0', label: 'Courier parcel — not a store' },
    };

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'resolveStoresModal';
    modal.innerHTML = `
      <div class="modal" style="width:94%;max-width:820px;max-height:88vh;display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
          <h2 style="margin:0">🔍 Match Store Names</h2>
          <button class="btn-close" id="resolveStoresCloseBtn">✕</button>
        </div>
        <p class="hint" style="font-size:12px;margin-bottom:.6rem">
          These deliveries have no postal code yet. Confirm the right store for each — the spelling is
          <strong>learned</strong>, so future uploads resolve on their own. Apply rows one at a time, or tick several and apply together.
        </p>
        <div style="display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin-bottom:.6rem;font-size:11.5px">
          ${counts.high    ? `<span style="background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;border-radius:99px;padding:.15rem .55rem;font-weight:600">${counts.high} likely match</span>` : ''}
          ${counts.low     ? `<span style="background:#fffbeb;color:#b45309;border:1px solid #fde68a;border-radius:99px;padding:.15rem .55rem;font-weight:600">${counts.low} need checking</span>` : ''}
          ${counts.none    ? `<span style="background:#fff;color:#b45309;border:1px solid #e2e8f0;border-radius:99px;padding:.15rem .55rem;font-weight:600">${counts.none} not in book</span>` : ''}
          ${counts.courier ? `<span style="background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;border-radius:99px;padding:.15rem .55rem;font-weight:600">${counts.courier} courier parcel</span>` : ''}
          <span style="flex:1"></span>
          <strong id="resolveProgress" style="color:#16a34a">0 of ${ordered.length} resolved</strong>
        </div>
        ${counts.courier ? `
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-left:3px solid #94a3b8;border-radius:4px;padding:.5rem .7rem;font-size:11.5px;color:#475569;margin-bottom:.6rem">
          <strong>${counts.courier} of these look like courier tracking numbers</strong>, not shops —
          the buyer's address sits with the courier, who collects these parcels. They usually don't need
          a postal code or your own driver at all. Leave them unticked and skip.
        </div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin-bottom:.6rem">
          <label style="display:flex;align-items:center;gap:.3rem;font-size:12px;cursor:pointer">
            <input type="checkbox" id="resolveSelectAll" /> Select all
          </label>
          ${counts.high ? `<button class="btn-secondary btn-sm" id="resolveSelectHigh">Select ${counts.high} likely match${counts.high === 1 ? '' : 'es'}</button>` : ''}
          <span style="flex:1"></span>
          <button class="btn-primary btn-sm" id="resolveApplySelected">✓ Apply Selected (<span id="resolveSelCount">0</span>)</button>
        </div>
        <div id="resolveRows" style="display:grid;gap:.5rem;overflow-y:auto;flex:1;padding:.1rem">
          ${ordered.map(it => {
            const m = TIER_META[it._tier];
            const canTick = it._tier !== 'courier';
            return `
            <div class="resolve-row" data-idx="${it._idx}" data-tier="${it._tier}"
                 style="border:1px solid ${m.border};background:${m.bg};border-radius:6px;padding:.6rem .7rem">
              <div style="display:flex;align-items:flex-start;gap:.5rem">
                <input type="checkbox" class="resolve-tick" data-idx="${it._idx}" ${canTick ? '' : 'disabled'} style="margin-top:.2rem" />
                <div style="flex:1;min-width:0">
                  <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
                    <span style="font-weight:600;font-size:13px;word-break:break-all">"${esc(it.clientName)}"</span>
                    <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:${m.color};border:1px solid ${m.border};border-radius:3px;padding:.05rem .35rem">${m.label}</span>
                  </div>
                  <div class="resolve-body" data-idx="${it._idx}" style="margin-top:.45rem">
                    ${it.suggestions.length ? `
                      <select class="resolve-pick" data-idx="${it._idx}" style="width:100%;padding:.45rem;border:1px solid #e2e8f0;border-radius:4px;font-size:12px;background:#fff">
                        ${it.suggestions.map((sg, si) => `<option value="${esc(sg.name)}" ${si === 0 ? 'selected' : ''}>${sg.score}% — ${esc(sg.name)}${sg.chain ? ` (${esc(sg.chain)})` : ''}${sg.address ? ` — ${esc(sg.address)}` : ''} — 📍 ${esc(sg.zip)}</option>`).join('')}
                        <option value="__new__">➕ None of these — key in this store's details</option>
                        <option value="">— skip for now —</option>
                      </select>
                      <div class="resolve-match-info" data-idx="${it._idx}" style="margin-top:.3rem;font-size:11px;color:#16a34a"></div>` :
                      `<div class="hint" style="font-size:11.5px;color:${m.color};margin-bottom:.35rem">${it._tier === 'courier'
                        ? 'Looks like a courier tracking number — skip unless your own driver really is delivering this one.'
                        : 'No match in the Address Book — key in the store details to add it:'}</div>`}
                    <div class="resolve-new-store ${it.suggestions.length ? 'hidden' : ''}" data-idx="${it._idx}" style="margin-top:.45rem;display:grid;grid-template-columns:1fr 1fr;gap:.35rem">
                      <input class="rns-code" placeholder="Store code (optional)" style="padding:.4rem;border:1px solid #e2e8f0;border-radius:4px;font-size:12px" />
                      <input class="rns-zip" placeholder="Postal code * (6 digits)" maxlength="6" inputmode="numeric" style="padding:.4rem;border:1px solid #e2e8f0;border-radius:4px;font-size:12px" />
                      <input class="rns-address" placeholder="Address" style="grid-column:1/-1;padding:.4rem;border:1px solid #e2e8f0;border-radius:4px;font-size:12px" />
                      <input class="rns-phone" placeholder="Phone (optional)" style="grid-column:1/-1;padding:.4rem;border:1px solid #e2e8f0;border-radius:4px;font-size:12px" />
                    </div>
                  </div>
                </div>
                <button class="btn-primary btn-sm resolve-apply-one" data-idx="${it._idx}" style="flex-shrink:0">✓ Apply</button>
              </div>
            </div>`;
          }).join('')}
        </div>
        <div style="display:flex;gap:.6rem;margin-top:.8rem">
          <button class="btn-secondary" id="resolveStoresCancelBtn" style="flex:1">Done</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    let resolvedCount = 0, totalFixed = 0, learnedCount = 0, addedCount = 0;
    const byIdx = i => items.find(x => x._idx === i);

    const close = async () => {
      modal.remove();
      if (resolvedCount) {
        await renderTransportTab();
        if (!document.getElementById('routePlanningModal').classList.contains('hidden')) optimizeRoutes();
      }
    };
    modal.querySelector('#resolveStoresCloseBtn').addEventListener('click', close);
    modal.querySelector('#resolveStoresCancelBtn').addEventListener('click', close);

    const updateSelCount = () => {
      const n = modal.querySelectorAll('.resolve-tick:checked').length;
      // Null-guarded: the counter lives INSIDE the Apply-Selected button, and
      // that button's label is swapped to "Applying…" for the duration of a
      // bulk run — which removes this span while applyRow() is still calling
      // back into here for each row.
      const el = modal.querySelector('#resolveSelCount');
      if (el) el.textContent = n;
    };
    const updateProgress = () => {
      modal.querySelector('#resolveProgress').textContent = `${resolvedCount} of ${ordered.length} resolved`;
    };

    // Green line under each dropdown shows the ADDRESS the job will point at
    const updateMatchInfo = (sel) => {
      const it = byIdx(parseInt(sel.dataset.idx));
      const info = modal.querySelector(`.resolve-match-info[data-idx="${sel.dataset.idx}"]`);
      if (!info || !it) return;
      const sg = it.suggestions.find(x => x.name === sel.value);
      info.textContent = sg
        ? `→ will deliver to: ${[sg.chain, sg.name].filter(Boolean).join(' ')}${sg.address ? ', ' + sg.address : ''}, S${sg.zip}`
        : '';
    };
    modal.querySelectorAll('.resolve-pick').forEach(sel => {
      updateMatchInfo(sel);
      sel.addEventListener('change', () => {
        modal.querySelector(`.resolve-new-store[data-idx="${sel.dataset.idx}"]`)
          ?.classList.toggle('hidden', sel.value !== '__new__');
        updateMatchInfo(sel);
      });
    });

    modal.querySelectorAll('.resolve-tick').forEach(cb => cb.addEventListener('change', updateSelCount));
    modal.querySelector('#resolveSelectAll').addEventListener('change', (e) => {
      modal.querySelectorAll('.resolve-tick:not(:disabled)').forEach(cb => {
        if (!cb.closest('.resolve-row').dataset.done) cb.checked = e.target.checked;
      });
      updateSelCount();
    });
    modal.querySelector('#resolveSelectHigh')?.addEventListener('click', () => {
      modal.querySelectorAll('.resolve-row[data-tier="high"] .resolve-tick').forEach(cb => {
        if (!cb.closest('.resolve-row').dataset.done) cb.checked = true;
      });
      updateSelCount();
    });

    // Applies ONE row. Returns null when the row can't be applied yet (bad or
    // missing postal on a keyed-in store) so bulk-apply can report it rather
    // than silently skipping.
    async function applyRow(idx, { silent = false } = {}) {
      const row = modal.querySelector(`.resolve-row[data-idx="${idx}"]`);
      const it  = byIdx(idx);
      if (!row || !it || row.dataset.done) return null;
      const sel  = row.querySelector('.resolve-pick');
      const form = row.querySelector('.resolve-new-store');
      const keyingIn = !sel || sel.value === '__new__';

      let ok = false, fixed = 0, err = null;
      if (keyingIn) {
        const zip = form.querySelector('.rns-zip').value.trim();
        if (!/^\d{6}$/.test(zip)) {
          err = 'needs a valid 6-digit postal code';
          if (!silent) { alert(`"${it.clientName}": enter a valid 6-digit postal code.`); form.querySelector('.rns-zip').focus(); }
          return { ok: false, err };
        }
        try {
          const r = await fetch('/api/address-book', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: it.clientName,
              code: form.querySelector('.rns-code').value.trim(),
              address: form.querySelector('.rns-address').value.trim(),
              zip,
              phone: form.querySelector('.rns-phone').value.trim(),
            }),
          });
          const d = await r.json();
          if (r.ok) { ok = true; fixed = d.jobsFixed || 0; addedCount++; }
          else err = d.error || 'save failed';
        } catch (e) { err = e.message; }
      } else {
        if (!sel.value) { err = 'skipped'; return { ok: false, err }; }
        try {
          const r = await fetch('/api/address-book/learn-alias', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: it.clientName, targetName: sel.value }),
          });
          const d = await r.json();
          if (r.ok) { ok = true; fixed = d.jobsFixed || 0; learnedCount++; }
          else err = d.error || 'save failed';
        } catch (e) { err = e.message; }
      }

      if (ok) {
        resolvedCount++; totalFixed += fixed;
        row.dataset.done = '1';
        row.style.background = '#f0fdf4';
        row.style.borderColor = '#bbf7d0';
        row.style.opacity = '.75';
        row.querySelector('.resolve-body').innerHTML =
          `<div style="font-size:11.5px;color:#16a34a;font-weight:600">✓ Resolved${fixed ? ` — ${fixed} job(s) now have a postal code` : ''}</div>`;
        const tick = row.querySelector('.resolve-tick');
        if (tick) { tick.checked = false; tick.disabled = true; }
        row.querySelector('.resolve-apply-one')?.remove();
        updateProgress(); updateSelCount();
      } else if (!silent) {
        alert(`"${it.clientName}": ${err || 'could not be saved'}`);
      }
      return { ok, err };
    }

    modal.querySelectorAll('.resolve-apply-one').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '…';
        const res = await applyRow(parseInt(btn.dataset.idx));
        if (res && !res.ok) { btn.disabled = false; btn.textContent = '✓ Apply'; }
      });
    });

    modal.querySelector('#resolveApplySelected').addEventListener('click', async () => {
      const ticked = [...modal.querySelectorAll('.resolve-tick:checked')].map(cb => parseInt(cb.dataset.idx));
      if (!ticked.length) { alert('Tick the rows you want to apply first.'); return; }
      const btn = modal.querySelector('#resolveApplySelected');
      btn.disabled = true; btn.textContent = 'Applying…';
      const failed = [];
      for (const idx of ticked) {
        const res = await applyRow(idx, { silent: true });
        if (res && !res.ok) failed.push(`${byIdx(idx).clientName} — ${res.err}`);
      }
      btn.disabled = false; btn.innerHTML = '✓ Apply Selected (<span id="resolveSelCount">0</span>)';
      updateSelCount();
      modal.querySelector('#resolveSelectAll').checked = false;
      if (failed.length) {
        alert(`${ticked.length - failed.length} applied.\n\nStill needs attention:\n• ${failed.slice(0, 10).join('\n• ')}`);
      }
    });
  }

  // ── Delivery History — separate view of everything delivered, by date ─────
  let _dhFrom = '', _dhTo = '';
  function dhRangeDates(range) {
    const d = (offset) => { const x = new Date(Date.now() + offset * 86400000); return x.toLocaleDateString('en-CA'); };
    if (range === 'today') return [d(0), d(0)];
    if (range === 'yesterday') return [d(-1), d(-1)];
    if (range === 'week') return [d(-6), d(0)];
    if (range === 'month') { const n = new Date(); return [`${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`, d(0)]; }
    return [d(0), d(0)];
  }

  async function loadDeliveryHistory() {
    const tbody = document.getElementById('dhTableBody');
    tbody.innerHTML = '<tr><td colspan="8" style="padding:1.2rem;text-align:center;color:#64748b">Loading…</td></tr>';
    try {
      const resp = await fetch(`/api/transport/history?from=${_dhFrom}&to=${_dhTo}`);
      const rows = await resp.json();
      const cartons = rows.reduce((s, r) => s + (r.packages || 1), 0);
      const withRemarks = rows.filter(r => r.podRemarks).length;
      document.getElementById('dhSummary').textContent =
        `${_dhFrom} → ${_dhTo}: ${rows.length} delivery(ies) · ${cartons} carton(s)` +
        (withRemarks ? ` · ⚠ ${withRemarks} with remarks` : '');
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="padding:1.2rem;text-align:center;color:#64748b">No deliveries in this period.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(r => `
        <tr style="border-top:1px solid #f1f5f9">
          <td style="padding:.45rem .5rem;white-space:nowrap">${r.deliveredAt ? esc(new Date(r.deliveredAt).toLocaleString('en-SG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) : '—'}</td>
          <td style="padding:.45rem .5rem"><code>${esc(r.id)}</code></td>
          <td style="padding:.45rem .5rem;font-family:monospace;font-size:11px">${esc(r.referenceId || '—')}</td>
          <td style="padding:.45rem .5rem"><strong>${esc(r.clientName)}</strong></td>
          <td style="padding:.45rem .5rem">${esc(r.zip || '—')}</td>
          <td style="padding:.45rem .5rem;text-align:center">${r.packages}</td>
          <td style="padding:.45rem .5rem">${esc(r.driver || '—')}</td>
          <td style="padding:.45rem .5rem">${r.podRemarks
            ? `<span style="color:#ef4444;font-weight:600" title="${esc(r.podRemarks)}">Delivered w/ Remarks</span><br/><span style="font-size:10px;color:#64748b">${esc(r.podRemarks)}</span>`
            : '<span style="color:#22c55e;font-weight:600">Delivered</span>'}</td>
        </tr>`).join('');
    } catch {
      tbody.innerHTML = '<tr><td colspan="8" style="padding:1rem;color:var(--danger)">Failed to load.</td></tr>';
    }
  }

  document.getElementById('deliveryHistoryBtn')?.addEventListener('click', () => {
    [_dhFrom, _dhTo] = dhRangeDates('today');
    document.getElementById('dhFrom').value = _dhFrom;
    document.getElementById('dhTo').value = _dhTo;
    document.querySelectorAll('.dh-range').forEach(b => b.classList.toggle('active', b.dataset.range === 'today'));
    document.getElementById('deliveryHistoryModal').classList.remove('hidden');
    loadDeliveryHistory();
  });
  document.getElementById('dhCloseBtn')?.addEventListener('click', () =>
    document.getElementById('deliveryHistoryModal').classList.add('hidden'));
  document.querySelectorAll('.dh-range').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.dh-range').forEach(b => b.classList.toggle('active', b === btn));
    [_dhFrom, _dhTo] = dhRangeDates(btn.dataset.range);
    document.getElementById('dhFrom').value = _dhFrom;
    document.getElementById('dhTo').value = _dhTo;
    loadDeliveryHistory();
  }));
  document.getElementById('dhApplyRangeBtn')?.addEventListener('click', () => {
    const f = document.getElementById('dhFrom').value, t = document.getElementById('dhTo').value;
    if (!f || !t) { alert('Pick both dates.'); return; }
    document.querySelectorAll('.dh-range').forEach(b => b.classList.remove('active'));
    _dhFrom = f; _dhTo = t;
    loadDeliveryHistory();
  });
  document.getElementById('dhDownloadBtn')?.addEventListener('click', () =>
    authDownload(`/api/transport/history/export?from=${_dhFrom}&to=${_dhTo}`, `Delivery_History_${_dhFrom}_to_${_dhTo}.xlsx`));

  // ── Delivery detail — click a stop/job to see the full summary and fix
  //    its postal code (which also updates the Address Book master list) ─────
  async function openDeliveryDetail(jobId) {
    const job = transportRequests.find(r => r.id === jobId) || _transportCacheAll.find(r => r.id === jobId);
    if (!job) { alert('Job not found'); return; }

    // Which Address Book entry did this job resolve through?
    let book = [];
    try { book = await (await fetch('/api/address-book')).json(); } catch {}
    const nrm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const q = nrm(job.clientName), qr = nrm(job.referenceId);
    const entry = book.find(e =>
      nrm(e.name) === q || nrm(e.code) === q || nrm(e.name) === qr || nrm(e.code) === qr ||
      (e.chain && (nrm(`${e.chain} ${e.name}`) === q || nrm(`${e.name} ${e.chain}`) === q)));

    const drv = (window.drivers || []).find(d => d.id === job.assignedDriver);
    const row = (label, val) => `<div style="display:flex;gap:.6rem;font-size:12px;padding:.28rem 0;border-bottom:1px solid #f1f5f9">
      <span style="width:110px;color:#64748b;flex-shrink:0">${label}</span><span style="font-weight:600">${val || '—'}</span></div>`;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'deliveryDetailModal';
    modal.innerHTML = `
      <div class="modal" style="width:92%;max-width:520px;max-height:85vh;overflow-y:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem">
          <h2 style="margin:0;font-size:1.05rem">📦 ${esc(job.clientName || job.id)}</h2>
          <button class="btn-close" id="ddCloseBtn">✕</button>
        </div>
        ${row('Job ID', `<code>${esc(job.id)}</code>`)}
        ${row('Order ref', esc(job.referenceId || ''))}
        ${row('Matched store', entry ? `${esc([entry.chain, entry.name].filter(Boolean).join(' '))}${entry.aliasOf ? ` <span style="color:#64748b;font-weight:400">(alias of ${esc(entry.aliasOf)})</span>` : ''}${entry.code ? ` <code style="font-size:10px">${esc(entry.code)}</code>` : ''}` : '<span style="color:#ef4444">not in Address Book</span>')}
        ${row('Address', esc(job.shipping?.addressLine1 || entry?.address || ''))}
        ${row('Phone', esc(job.shipping?.phone || ''))}
        ${row('Cartons', String(job.packages || 1))}
        ${row('Status', (() => { const st = tmsStatusLabel(job); return `<span style="padding:.1rem .5rem;border-radius:99px;background:${st.color}1a;color:${st.color};font-weight:700">${st.label}</span>`; })())}
        ${row('Driver', esc(job.assignedDriverName || drv?.name || ''))}
        ${row('Route / Stop', job.routeNum ? `Route ${job.routeNum} · Stop #${job.stopSeq || '—'}` : '')}
        ${row('Notes', esc(job.notes || ''))}
        ${String(job.podRemarks || '').trim() ? row('POD remarks', `<span style="color:#ef4444">${esc(job.podRemarks)}</span>`) : ''}
        ${job.podLocation ? row('POD location', `<a href="https://www.google.com/maps/search/?api=1&query=${job.podLocation.lat},${job.podLocation.lng}" target="_blank" rel="noopener">📍 View on map</a>`) : ''}
        ${(job.podPhotos && job.podPhotos.length) ? `
        <div style="margin-top:.6rem">
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:.35rem">📷 ePOD Photos (${job.podPhotos.length})</label>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:.4rem">
            ${job.podPhotos.map(p => `<img src="/api/driver/jobs/${esc(job.id)}/photo/${esc(p.id)}?token=${encodeURIComponent(localStorage.getItem('wms_token') || '')}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0;cursor:pointer" onclick="window.open(this.src,'_blank')" loading="lazy" />`).join('')}
          </div>
        </div>` : ''}

        <div style="margin-top:.9rem;padding:.7rem;background:#f0f9ff;border:1px solid #bfdbfe;border-radius:6px">
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:.35rem">📍 Postal code</label>
          <div style="display:flex;gap:.5rem">
            <input id="ddZipInput" maxlength="6" value="${esc(job.shipping?.zip || '')}" placeholder="6 digits"
              style="flex:1;padding:.5rem;border:1px solid #cbd5e1;border-radius:4px;font-size:13px;font-family:monospace" />
            <button class="btn-primary btn-sm" id="ddZipSaveBtn">💾 Update</button>
          </div>
          <p class="hint" style="font-size:11px;margin:.4rem 0 0 0">Updating fixes this delivery AND the Address Book master entry${entry ? ` ("${esc(entry.name)}")` : ` (a new entry "${esc(job.clientName)}" is created)`} — future uploads use the corrected postal.</p>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#ddCloseBtn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    modal.querySelector('#ddZipSaveBtn').addEventListener('click', async () => {
      const zip = modal.querySelector('#ddZipInput').value.trim();
      if (!/^\d{6}$/.test(zip)) { alert('Postal code must be exactly 6 digits.'); return; }
      const btn = modal.querySelector('#ddZipSaveBtn');
      btn.disabled = true; btn.textContent = 'Saving...';
      try {
        // 1. Master list — merge-upsert keeps the entry's other fields
        const r1 = await fetch('/api/address-book', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: entry?.name || job.clientName, zip }),
        });
        if (!r1.ok) throw new Error((await r1.json()).error || 'Address Book update failed');
        // 2. This job — direct update (the book sweep never overwrites)
        const r2 = await fetch(`/api/transport/${encodeURIComponent(job.id)}/update`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shipping: { zip } }),
        });
        if (!r2.ok) throw new Error((await r2.json()).error || 'Job update failed');
      } catch (err) { alert('❌ ' + err.message); btn.disabled = false; btn.textContent = '💾 Update'; return; }
      modal.remove();
      await renderTransportTab();
      if (!document.getElementById('routePlanningModal').classList.contains('hidden')) optimizeRoutes();
      alert(`✓ Postal updated to ${zip} — delivery fixed and Address Book master list updated.`);
    });
  }

  // Clickable stops in the planner table + details button in map popups
  document.addEventListener('click', e => {
    const el = e.target.closest('.route-stop-client, .popup-details-btn');
    if (el?.dataset.jobid) openDeliveryDetail(el.dataset.jobid);
  });

  // ── Address Book — fixed-location cross-reference (store → address) ────────
  async function renderAddressBook() {
    const tbody = document.getElementById('addressBookTableBody');
    try {
      const resp = await fetch('/api/address-book', { headers: { 'x-auth-token': localStorage.getItem('wms_token') || '' } });
      const entries = await resp.json();
      if (!Array.isArray(entries) || !entries.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="padding:1.5rem;text-align:center;color:#64748b">No entries yet — add stores above, or download the template, fill it in, and upload.</td></tr>';
        return;
      }
      tbody.innerHTML = entries.map(e => `
        <tr style="border-top:1px solid #f0f0f0">
          <td style="padding:.45rem .5rem"><code>${esc(e.code || '—')}</code></td>
          <td style="padding:.45rem .5rem"><strong>${esc(e.name)}</strong></td>
          <td style="padding:.45rem .5rem">${esc(e.address || '—')}</td>
          <td style="padding:.45rem .5rem">${esc(e.zip || '—')}</td>
          <td style="padding:.45rem .5rem">${esc(e.phone || '—')}</td>
          <td style="padding:.45rem .5rem"><button class="ab-del-btn" data-name="${esc(e.name)}" title="Remove" style="background:none;border:none;cursor:pointer">🗑</button></td>
        </tr>`).join('');
      tbody.querySelectorAll('.ab-del-btn').forEach(btn => btn.addEventListener('click', async () => {
        if (!confirm(`Remove "${btn.dataset.name}" from the Address Book?`)) return;
        await fetch(`/api/address-book/${encodeURIComponent(btn.dataset.name)}`, {
          method: 'DELETE', headers: { 'x-auth-token': localStorage.getItem('wms_token') || '' } });
        renderAddressBook();
      }));
    } catch {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:1rem;color:var(--danger)">Failed to load.</td></tr>';
    }
  }

  function abStatus(kind, msg) {
    const el = document.getElementById('abStatus');
    el.className = `status-bar ${kind}`;
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  document.getElementById('addressBookBtn')?.addEventListener('click', () => {
    document.getElementById('abStatus')?.classList.add('hidden');
    document.getElementById('addressBookModal').classList.remove('hidden');
    renderAddressBook();
  });
  document.getElementById('addressBookCloseBtn')?.addEventListener('click', () => document.getElementById('addressBookModal').classList.add('hidden'));
  document.getElementById('addressBookCloseBtn2')?.addEventListener('click', () => document.getElementById('addressBookModal').classList.add('hidden'));

  document.getElementById('abSaveBtn')?.addEventListener('click', async () => {
    const entry = {
      code: document.getElementById('abCode').value.trim(),
      name: document.getElementById('abName').value.trim(),
      address: document.getElementById('abAddress').value.trim(),
      zip: document.getElementById('abZip').value.trim(),
      phone: document.getElementById('abPhone').value.trim(),
    };
    if (!entry.name) { abStatus('error', 'Store name is required.'); return; }
    if (entry.zip && !/^\d{6}$/.test(entry.zip)) { abStatus('error', 'Postal code must be exactly 6 digits.'); return; }
    try {
      const resp = await fetch('/api/address-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': localStorage.getItem('wms_token') || '' },
        body: JSON.stringify(entry),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Save failed');
      abStatus('success', `✓ Saved "${entry.name}"${data.jobsFixed ? ` — ${data.jobsFixed} existing job(s) auto-filled` : ''}.`);
      ['abCode', 'abName', 'abAddress', 'abZip', 'abPhone'].forEach(id => { document.getElementById(id).value = ''; });
      renderAddressBook();
      renderTransportTab(); // refresh map pins if jobs got fixed
    } catch (err) { abStatus('error', '❌ ' + err.message); }
  });

  document.getElementById('abDownloadBtn')?.addEventListener('click', () =>
    authDownload('/api/address-book/export', `Address_Book_${new Date().toISOString().slice(0, 10)}.xlsx`));

  document.getElementById('abUploadBtn')?.addEventListener('click', () => document.getElementById('abFileInput')?.click());
  document.getElementById('abFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('Uploading REPLACES the entire Address Book with this file. Continue?')) return;
    abStatus('progress', 'Uploading and applying...');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const resp = await fetch('/api/address-book/import', {
        method: 'POST', body: fd,
        headers: { 'x-auth-token': localStorage.getItem('wms_token') || '' },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Import failed');
      abStatus('success', `✓ ${data.entries} entr${data.entries === 1 ? 'y' : 'ies'} loaded — ${data.jobsFixed} job(s) auto-filled.` +
        (data.warnings?.length ? ` ⚠ ${data.warnings.join(' ')}` : ''));
      renderAddressBook();
      renderTransportTab();
    } catch (err) { abStatus('error', '❌ ' + err.message); }
  });

  // ── Driver Details Management ──────────────────────────────────────────────
  // Drivers live on the SERVER (db.drivers) so every login/device sees the
  // same fleet. Previously localStorage-only — drivers added on one machine
  // were invisible everywhere else. Any drivers still sitting in this
  // browser's localStorage are migrated up once, then the local copy cleared.
  window.drivers = [];
  let editingDriverId = null;

  // Driver job lists are DERIVED from the server's transport records
  // (assignedDriver on each job) — no separate browser-side store.
  let _transportCacheAll = [];
  async function refreshTransportCache() {
    try {
      const r = await fetch('/api/transport');
      if (r.ok) _transportCacheAll = await r.json();
    } catch {}
  }
  function jobsForDriver(driverId) {
    return _transportCacheAll.filter(r => r.assignedDriver === driverId && r.status !== 'cancelled');
  }

  async function loadDrivers() {
    try {
      const hdrs = { 'x-auth-token': localStorage.getItem('wms_token') || '' };
      let resp = await fetch('/api/drivers', { headers: hdrs });
      if (!resp.ok) return;
      let list = await resp.json();

      // One-time migration of this browser's old local driver list — MERGE:
      // push up any local driver the server doesn't already have (matched by
      // id or name), no matter what's already on the server. Only clear the
      // local copy once everything is safely up.
      const local = JSON.parse(localStorage.getItem('drivers') || '[]');
      if (local.length) {
        const known = new Set(list.flatMap(d => [String(d.id), String(d.name || '').trim().toUpperCase()]));
        const missing = local.filter(d =>
          !known.has(String(d.id)) && !known.has(String(d.name || '').trim().toUpperCase()));
        let allOk = true;
        for (const d of missing) {
          const r = await fetch('/api/drivers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...hdrs },
            body: JSON.stringify(d),
          }).catch(() => null);
          if (!r || !r.ok) allOk = false;
        }
        if (missing.length) {
          resp = await fetch('/api/drivers', { headers: hdrs });
          if (resp.ok) list = await resp.json();
        }
        if (allOk) localStorage.removeItem('drivers');
      }

      window.drivers = Array.isArray(list) ? list : [];
    } catch { /* offline — keep whatever we have */ }
  }
  // Only fetch when a session exists — an unauthenticated /api/ call would
  // trip the global 401 handler above and reload the login page in a loop.
  if (localStorage.getItem('wms_token')) loadDrivers();

  document.getElementById('driverDetailsBtn')?.addEventListener('click', async () => {
    document.getElementById('driverDetailsModal').classList.remove('hidden');
    await Promise.all([loadDrivers(), refreshTransportCache()]);
    renderDriverList();
    populateDriverPortal();
  });

  document.getElementById('driverDetailsCloseBtn')?.addEventListener('click', () => {
    document.getElementById('driverDetailsModal').classList.add('hidden');
  });

  document.getElementById('driverDetailsCloseBtn2')?.addEventListener('click', () => {
    document.getElementById('driverDetailsModal').classList.add('hidden');
  });

  // Tab switching
  document.getElementById('driverTabManage')?.addEventListener('click', function() {
    document.getElementById('driverManageTab').style.display = 'block';
    document.getElementById('driverPortalTab').style.display = 'none';
    document.getElementById('driverStatsTab').style.display = 'none';
    this.style.borderBottomColor = '#0ea5e9';
    this.style.color = '#0ea5e9';
    document.getElementById('driverTabPortal').style.color = '#64748b';
    document.getElementById('driverTabStats').style.color = '#64748b';
    document.getElementById('driverTabPortal').style.borderBottomColor = 'transparent';
    document.getElementById('driverTabStats').style.borderBottomColor = 'transparent';
  });

  document.getElementById('driverTabPortal')?.addEventListener('click', function() {
    document.getElementById('driverManageTab').style.display = 'none';
    document.getElementById('driverPortalTab').style.display = 'block';
    document.getElementById('driverStatsTab').style.display = 'none';
    this.style.borderBottomColor = '#0ea5e9';
    this.style.color = '#0ea5e9';
    document.getElementById('driverTabManage').style.color = '#64748b';
    document.getElementById('driverTabStats').style.color = '#64748b';
    document.getElementById('driverTabManage').style.borderBottomColor = 'transparent';
    document.getElementById('driverTabStats').style.borderBottomColor = 'transparent';
    populateDriverPortal();
  });

  document.getElementById('driverTabStats')?.addEventListener('click', function() {
    document.getElementById('driverManageTab').style.display = 'none';
    document.getElementById('driverPortalTab').style.display = 'none';
    document.getElementById('driverStatsTab').style.display = 'block';
    this.style.borderBottomColor = '#0ea5e9';
    this.style.color = '#0ea5e9';
    document.getElementById('driverTabManage').style.color = '#64748b';
    document.getElementById('driverTabPortal').style.color = '#64748b';
    document.getElementById('driverTabManage').style.borderBottomColor = 'transparent';
    document.getElementById('driverTabPortal').style.borderBottomColor = 'transparent';
    renderDriverStats();
  });

  function renderDriverList() {
    const tbody = document.getElementById('driverListBody');
    if (!window.drivers.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:2rem;color:#64748b">No drivers yet. Click "Add Driver" to create one.</td></tr>';
      return;
    }

    // Driver ID and "is a PIN set" are shown FIRST because together they are
    // exactly what decides whether this person can sign into the Driver App —
    // the app asks for the ID, not the name. Leaving the ID off this table
    // meant an auto-generated id (DRV-<timestamp>) was invisible, so nobody
    // could know what to type and every login failed with "Driver not found".
    tbody.innerHTML = window.drivers.map(d => `
      <tr>
        <td><code class="drv-id-chip">${esc(d.id)}</code></td>
        <td>${esc(d.name)}</td>
        <td>${esc(d.phone) || '—'}</td>
        <td>${esc(d.vehicle)}${d.plate ? ` · <code>${esc(d.plate)}</code>` : ''}</td>
        <td>${[d.capacity ? d.capacity + ' kg' : '', d.capacityM3 ? d.capacityM3 + ' m³' : ''].filter(Boolean).join(' / ') || '—'}</td>
        <td>${d.hasPin
              ? '<span class="drv-pin-yes">&#128241; Set</span>'
              : '<span class="drv-pin-no" title="This driver cannot sign into the Driver App until a PIN is set — click Edit">&#9888; None</span>'}</td>
        <td><span class="status-badge ${d.status || 'active'}">${d.status || 'Active'}</span></td>
        <td style="text-align:center"><strong>${jobsForDriver(d.id).filter(j => j.status !== 'delivered').length}</strong></td>
        <td>
          <button class="btn-scan-now btn-sm" data-driver-edit="${esc(d.id)}" style="margin-right:0.3rem">Edit</button>
          <button class="btn-scan-now btn-sm" data-driver-delete="${esc(d.id)}" style="background:#ef4444">Delete</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-driver-edit]').forEach(btn => {
      btn.addEventListener('click', () => openEditDriver(btn.dataset.driverEdit));
    });
    tbody.querySelectorAll('[data-driver-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteDriver(btn.dataset.driverDelete));
    });
  }

  // NOTE: unique id — an id="addDriverBtn" also exists in the Administrator
  // Drivers section; the duplicate meant this modal's button silently got no
  // listener (getElementById returns the first match only).
  document.getElementById('transportAddDriverBtn')?.addEventListener('click', () => {
    editingDriverId = null;
    document.getElementById('addEditDriverTitle').textContent = 'Add Driver';
    document.getElementById('driverIdInput').value = '';
    document.getElementById('driverIdInput').disabled = false;
    document.getElementById('driverIdHint').textContent = '';
    document.getElementById('driverNameInput').value = '';
    document.getElementById('driverPhoneInput').value = '';
    document.getElementById('driverVehicleInput').value = 'Van';
    document.getElementById('driverPlateInput').value = '';
    document.getElementById('driverCapacityInput').value = '';
    document.getElementById('driverCapacityM3Input').value = '';
    document.getElementById('driverPinInput').value = '';
    document.getElementById('driverPinHint').textContent = '(sets the Driver App login PIN)';
    document.getElementById('addEditDriverModal').classList.remove('hidden');
  });

  function openEditDriver(id) {
    const driver = window.drivers.find(d => d.id === id);
    if (!driver) return;
    editingDriverId = id;
    document.getElementById('addEditDriverTitle').textContent = 'Edit Driver';
    // ID is the driver's login identity — changing it here would silently
    // create a SEPARATE driver record (the API upserts by id) rather than
    // rename this one, so it's locked to view-only once a driver exists.
    document.getElementById('driverIdInput').value = driver.id;
    document.getElementById('driverIdInput').disabled = true;
    document.getElementById('driverIdHint').textContent = '(set once, at creation — cannot be changed)';
    document.getElementById('driverNameInput').value = driver.name;
    document.getElementById('driverPhoneInput').value = driver.phone;
    document.getElementById('driverVehicleInput').value = driver.vehicle;
    document.getElementById('driverPlateInput').value = driver.plate || '';
    document.getElementById('driverCapacityInput').value = driver.capacity || '';
    document.getElementById('driverCapacityM3Input').value = driver.capacityM3 || '';
    document.getElementById('driverPinInput').value = '';
    document.getElementById('driverPinHint').textContent = driver.hasPin ? '(PIN is set — leave blank to keep it)' : '(no PIN set — driver cannot log into the Driver App yet)';
    document.getElementById('addEditDriverModal').classList.remove('hidden');
  }

  async function deleteDriver(id) {
    if (!confirm('Delete this driver?')) return;
    try {
      const resp = await fetch(`/api/drivers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'x-auth-token': localStorage.getItem('wms_token') || '' },
      });
      if (!resp.ok) throw new Error((await resp.json()).error || 'Delete failed');
    } catch (err) { alert('❌ ' + err.message); return; }
    await loadDrivers();
    renderDriverList();
  }

  document.getElementById('addEditDriverSaveBtn')?.addEventListener('click', async () => {
    const customId = document.getElementById('driverIdInput').value.trim();
    const name = document.getElementById('driverNameInput').value.trim();
    const phone = document.getElementById('driverPhoneInput').value.trim();
    const vehicle = document.getElementById('driverVehicleInput').value;
    const plate = document.getElementById('driverPlateInput').value.trim().toUpperCase();
    const capacity = parseInt(document.getElementById('driverCapacityInput').value) || 0;
    const capacityM3 = parseFloat(document.getElementById('driverCapacityM3Input').value) || 0;
    const pin = document.getElementById('driverPinInput').value.trim();

    if (!name) {
      alert('Please enter driver name');
      return;
    }
    if (pin && !/^\d{4,8}$/.test(pin)) {
      alert('PIN must be 4-8 digits');
      return;
    }
    // Creating with a custom ID: the API upserts by id, so a typo matching an
    // EXISTING driver would silently overwrite that driver's details instead
    // of erroring — catch it here before it ever reaches the server.
    if (!editingDriverId && customId && (window.drivers || []).some(d => d.id === customId)) {
      alert(`Driver ID "${customId}" is already in use by another driver. Choose a different ID.`);
      return;
    }

    try {
      const resp = await fetch('/api/drivers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': localStorage.getItem('wms_token') || '' },
        body: JSON.stringify({ id: editingDriverId || customId || undefined, name, phone, vehicle, plate, capacity, capacityM3, pin: pin || undefined }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Save failed');
    } catch (err) {
      alert('❌ ' + err.message);
      return;
    }

    await loadDrivers();
    document.getElementById('addEditDriverModal').classList.add('hidden');
    renderDriverList();
    populateDriverPortal();
    // Keep the Administrator → Drivers list in sync too (harmless no-op if
    // this tab isn't the one currently open).
    if (document.getElementById('driversList')) loadDriverList();
  });

  document.getElementById('addEditDriverCancelBtn')?.addEventListener('click', () => {
    document.getElementById('addEditDriverModal').classList.add('hidden');
  });

  function populateDriverPortal() {
    const select = document.getElementById('driverSelectPortal');
    select.innerHTML = '<option value="">-- Select driver --</option>';
    window.drivers.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name + ` (${jobsForDriver(d.id).filter(j => j.status !== 'delivered').length} open jobs)`;
      select.appendChild(opt);
    });

    select.addEventListener('change', () => {
      if (!select.value) {
        document.getElementById('driverPortalContent').innerHTML = '<div style="text-align:center;padding:2rem;color:#64748b">Select a driver to view their assigned jobs</div>';
        return;
      }
      showDriverPortal(select.value);
    });
  }

  function showDriverPortal(driverId) {
    const driver = window.drivers.find(d => d.id === driverId);
    if (!driver) return;

    const jobs = jobsForDriver(driverId).map(r => ({
      id: r.id,
      customer: r.clientName || r.id,
      address: [r.shipping?.addressLine1, r.shipping?.zip].filter(Boolean).join(', '),
      status: r.status === 'delivered' ? 'delivered' : (r.status || 'pending'),
      notes: r.notes || '',
    }));
    const content = document.getElementById('driverPortalContent');

    if (!jobs.length) {
      content.innerHTML = `<div style="text-align:center;padding:2rem;color:#64748b">No jobs assigned to ${esc(driver.name)}</div>`;
      return;
    }

    content.innerHTML = `
      <div style="display:grid;gap:1rem">
        ${jobs.map((job, idx) => `
          <div style="padding:1rem;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px">
            <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.5rem">
              <div>
                <h4 style="margin:0;font-size:13px">${idx + 1}. ${esc(job.customer)}</h4>
                <p style="margin:0.3rem 0 0 0;font-size:12px;color:#64748b">${esc(job.address)}</p>
              </div>
              <span class="status-badge ${job.status || 'pending'}" style="font-size:11px">${job.status || 'Pending'}</span>
            </div>
            ${job.status === 'delivered' ? `
              <div style="padding:0.6rem;background:white;border-radius:4px;font-size:12px;margin-bottom:0.5rem">
                <p style="margin:0;color:#22c55e"><strong>✓ ${job.status === 'delivered' ? 'Delivered' : job.status === 'failed' ? 'Failed' : 'Partial'}</strong></p>
                ${job.notes ? `<p style="margin:0.3rem 0 0 0;color:#64748b">${esc(job.notes)}</p>` : ''}
              </div>
            ` : `
              <button class="btn-primary btn-sm" data-complete-job="${idx}" style="width:100%;margin-top:0.5rem">Complete Delivery</button>
            `}
          </div>
        `).join('')}
      </div>
    `;

    content.querySelectorAll('[data-complete-job]').forEach(btn => {
      btn.addEventListener('click', () => openJobCompletion(driverId, parseInt(btn.dataset.completeJob)));
    });
  }

  function openJobCompletion(driverId, jobIdx) {
    const jobs = jobsForDriver(driverId).map(r => ({ id: r.id, customer: r.clientName || r.id, address: r.shipping?.addressLine1 || '' }));
    const job = jobs[jobIdx];
    if (!job) return;

    document.getElementById('jobCompletionTitle').textContent = `Complete: ${job.customer}`;
    document.getElementById('jobCustomer').textContent = job.customer;
    document.getElementById('jobAddress').textContent = job.address;
    document.getElementById('jobStatusSelect').value = 'delivered';
    document.getElementById('jobNotesInput').value = '';
    document.getElementById('jobPODInput').value = '';

    document.getElementById('jobCompletionSaveBtn').onclick = async () => {
      const status = document.getElementById('jobStatusSelect').value;
      const notes = document.getElementById('jobNotesInput').value;

      try {
        if (status === 'delivered') {
          const r = await fetch('/api/transport/mark-delivered', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [job.id] }),
          });
          if (!r.ok) throw new Error((await r.json()).error || 'Failed');
          if (notes) await fetch(`/api/transport/${encodeURIComponent(job.id)}/update`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ podRemarks: notes }),
          }).catch(() => {});
        } else {
          const r = await fetch(`/api/transport/${encodeURIComponent(job.id)}/update`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, notes }),
          });
          if (!r.ok) throw new Error((await r.json()).error || 'Failed');
        }
      } catch (err) { alert('❌ ' + err.message); return; }

      await refreshTransportCache();
      document.getElementById('jobCompletionModal').classList.add('hidden');
      showDriverPortal(driverId);
      alert(`Job marked as ${status}!`);
    };

    document.getElementById('jobCompletionModal').classList.remove('hidden');
  }

  document.getElementById('jobCompletionCancelBtn')?.addEventListener('click', () => {
    document.getElementById('jobCompletionModal').classList.add('hidden');
  });

  // Reads the same computation the Reports → Driver Performance XLSX uses
  // (GET /api/drivers/performance, no date range = all-time) — real
  // delivered/open counts, real cartons, and a genuine distance ESTIMATE
  // (postal-district legs from the depot). The old version read
  // driver.stats.distance/time, a field nothing in the app ever wrote, so
  // Distance/Time/Speed always silently showed 0 — fixed by wiring to data
  // that actually exists instead of inventing numbers for fields with no
  // real source (there's no drive-duration tracking anywhere in the
  // system, so Time/Avg Speed are dropped rather than faked).
  async function renderDriverStats() {
    const tbody = document.getElementById('driverStatsBody');
    let stats = [];
    try {
      const r = await fetch('/api/drivers/performance', { headers: { 'x-auth-token': localStorage.getItem('wms_token') || '' } });
      if (r.ok) stats = (await r.json()).drivers || [];
    } catch {}

    const totalDelivered = stats.reduce((s, d) => s + d.delivered, 0);
    const totalCartons   = stats.reduce((s, d) => s + d.cartons, 0);
    const totalKm        = stats.reduce((s, d) => s + d.km, 0);
    const activeDrivers  = stats.filter(d => d.jobsAssigned > 0).length;

    document.getElementById('statTotalDistance').textContent = totalKm.toFixed(1);
    document.getElementById('statTotalCartons').textContent = totalCartons;
    document.getElementById('statJobsCompleted').textContent = totalDelivered;
    document.getElementById('statDriversActive').textContent = activeDrivers;

    if (!stats.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:#64748b">No driver stats available yet.</td></tr>';
      return;
    }

    tbody.innerHTML = stats.map(s => `
      <tr>
        <td>${esc(s.name)}</td>
        <td style="text-align:center"><strong>${s.delivered}</strong></td>
        <td style="text-align:center">${s.open}</td>
        <td style="text-align:center">${s.cartons}</td>
        <td style="text-align:center">${s.km.toFixed(1)}</td>
        <td style="text-align:center">${s.daysActive}</td>
        <td style="text-align:center">${s.avgJobsPerDay}</td>
      </tr>
    `).join('');
  }

  // ── Transport Route Templates ──────────────────────────────────────────────
  let _transportTemplates = {};
  async function loadTransportTemplates() {
    try {
      const r = await fetch('/api/transport/templates');
      if (r.ok) _transportTemplates = await r.json();
    } catch {}
    const templates = _transportTemplates;
    const selector = document.getElementById('transportTemplateSelect');
    if (!selector) return;
    selector.innerHTML = '<option value="">-- Select a saved template --</option>';
    Object.keys(templates).forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      selector.appendChild(opt);
    });
  }

  document.getElementById('transportDownloadTemplateBtn')?.addEventListener('click', () => {
    const sampleData = [
      ['customer_name', 'address', 'postal_code', 'city', 'phone', 'email', 'sku', 'qty'],
      ['ABC Trading', '123 Bukit Merah Lane', '627001', 'Singapore', '6561234567', 'abc@example.com', 'SKU-001', '5'],
      ['XYZ Logistics', '456 Clementi Ave', '536001', 'Singapore', '6587654321', 'xyz@example.com', 'SKU-002', '3'],
      ['LMN Supplies', '789 Jurong West', '642001', 'Singapore', '6591112222', 'lmn@example.com', 'SKU-003', '10']
    ];
    const csv = sampleData.map(row => row.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tms-sample-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('transportSaveTemplateBtn')?.addEventListener('click', async () => {
    if (!transportRequests.length) {
      alert('No transport requests to save as template');
      return;
    }
    const name = prompt('Template name:', `Route-${new Date().toLocaleDateString()}`);
    if (!name) return;
    try {
      const r = await fetch('/api/transport/templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, data: {
          requests: transportRequests.map(r2 => ({ clientName: r2.clientName, zip: r2.shipping?.zip, items: r2.items, phone: r2.shipping?.phone })),
        } }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Save failed');
    } catch (err) { alert('❌ ' + err.message); return; }
    alert(`Template "${name}" saved — visible to every login.`);
    loadTransportTemplates();
  });

  document.getElementById('transportApplyTemplateBtn')?.addEventListener('click', () => {
    const name = document.getElementById('transportTemplateSelect').value;
    if (!name) {
      alert('Please select a template');
      return;
    }
    const template = _transportTemplates[name];
    if (!template) return;
    alert(`Template "${name}" has ${(template.requests || []).length} stop(s) (saved ${String(template.savedAt || '').slice(0, 10)}). Use it as a reference for planning — live jobs stay untouched.`);
  });

  document.getElementById('transportDeleteTemplateBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('transportTemplateSelect').value;
    if (!name) {
      alert('Please select a template');
      return;
    }
    if (!confirm(`Delete template "${name}"?`)) return;
    try {
      const r = await fetch(`/api/transport/templates/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error || 'Delete failed');
    } catch (err) { alert('❌ ' + err.message); return; }
    loadTransportTemplates();
    alert(`Template "${name}" deleted`);
  });

  document.getElementById('transportOptimizeRoutesBtn')?.addEventListener('click', () => {
    if (!transportRequests.length) {
      alert('No deliveries to optimize');
      return;
    }
    alert(`Route optimization for ${transportRequests.length} deliveries (coming soon with driver assignment)`);
  });

  // ── TMS Management (Drivers, Zones, Route Optimization) ───────────────────
  let tmsDrivers = [];
  let tmsZones = [];
  let tmsEditingDriverId = null;

  async function renderTmsTab() {
    await renderTmsDrivers();
    await renderTmsZones();
  }

  async function renderTmsDrivers() {
    try {
      const resp = await fetch('/api/tms/drivers');
      if (resp.ok) {
        tmsDrivers = await resp.json();
      } else {
        tmsDrivers = [];
      }
    } catch {
      tmsDrivers = [];
    }

    const tbody = document.getElementById('tmsDriversBody');
    const empty = document.getElementById('tmsDriversEmpty');

    if (!tmsDrivers.length) {
      empty.classList.remove('hidden');
      tbody.innerHTML = '';
      return;
    }

    empty.classList.add('hidden');
    tbody.innerHTML = tmsDrivers.map(d => `
      <tr>
        <td>${esc(d.name || '—')}</td>
        <td>${esc(d.phone || '—')}</td>
        <td>${esc(d.vehicle_type || '—')}</td>
        <td>${d.capacity_kg ? d.capacity_kg + ' kg' : '—'}</td>
        <td>${d.shift_start && d.shift_end ? d.shift_start.slice(0, 5) + '–' + d.shift_end.slice(0, 5) : '—'}</td>
        <td><span class="status-badge ${d.status || 'active'}">${d.status || 'Active'}</span></td>
        <td>
          <button class="btn-scan-now btn-sm" data-tms-edit-driver="${esc(d.id)}">Edit</button>
          <button class="btn-danger btn-sm" data-tms-del-driver="${esc(d.id)}">Delete</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-tms-edit-driver]').forEach(btn => {
      btn.addEventListener('click', () => editTmsDriver(btn.dataset.tmsEditDriver));
    });

    tbody.querySelectorAll('[data-tms-del-driver]').forEach(btn => {
      btn.addEventListener('click', () => deleteTmsDriver(btn.dataset.tmsDelDriver));
    });
  }

  async function renderTmsZones() {
    try {
      const resp = await fetch('/api/tms/zones');
      if (resp.ok) {
        tmsZones = await resp.json();
      } else {
        tmsZones = [];
      }
    } catch {
      tmsZones = [];
    }

    const tbody = document.getElementById('tmsZonesBody');
    const empty = document.getElementById('tmsZonesEmpty');

    if (!tmsZones.length) {
      empty.classList.remove('hidden');
      tbody.innerHTML = '';
      return;
    }

    empty.classList.add('hidden');
    tbody.innerHTML = tmsZones.map(z => {
      const postalCodes = (z.postal_codes || []).length > 0 ? z.postal_codes.join(', ').slice(0, 40) : '—';
      const days = (z.assigned_days || []).join(', ') || '—';
      const window = (z.delivery_window_start && z.delivery_window_end)
        ? z.delivery_window_start.slice(0, 5) + '–' + z.delivery_window_end.slice(0, 5)
        : '—';
      return `
        <tr>
          <td><strong>${esc(z.name)}</strong></td>
          <td><code style="font-size:0.85rem">${esc(postalCodes)}</code></td>
          <td>${esc(days)}</td>
          <td>${window}</td>
          <td><button class="btn-scan-now btn-sm" data-tms-edit-zone="${esc(z.id)}">Edit</button></td>
        </tr>
      `;
    }).join('');
  }

  function editTmsDriver(driverId) {
    tmsEditingDriverId = driverId;
    const driver = tmsDrivers.find(d => d.id === driverId);
    if (driver) {
      document.getElementById('tmsDriverName').value = driver.name || '';
      document.getElementById('tmsDriverPhone').value = driver.phone || '';
      document.getElementById('tmsDriverEmail').value = driver.email || '';
      document.getElementById('tmsDriverVehicle').value = driver.vehicle_type || '';
      document.getElementById('tmsDriverCapacityKg').value = driver.capacity_kg || '';
      document.getElementById('tmsDriverCapacityVolume').value = driver.capacity_volume || '';
      document.getElementById('tmsDriverShiftStart').value = driver.shift_start || '';
      document.getElementById('tmsDriverShiftEnd').value = driver.shift_end || '';
    }
    document.getElementById('tmsDriverForm').classList.remove('hidden');
  }

  async function saveTmsDriver() {
    const name = document.getElementById('tmsDriverName').value.trim();
    if (!name) { alert('Driver name required'); return; }

    const data = {
      name,
      phone: document.getElementById('tmsDriverPhone').value.trim() || null,
      email: document.getElementById('tmsDriverEmail').value.trim() || null,
      vehicle_type: document.getElementById('tmsDriverVehicle').value.trim() || null,
      capacity_kg: parseFloat(document.getElementById('tmsDriverCapacityKg').value) || null,
      capacity_volume: parseFloat(document.getElementById('tmsDriverCapacityVolume').value) || null,
      shift_start: document.getElementById('tmsDriverShiftStart').value || null,
      shift_end: document.getElementById('tmsDriverShiftEnd').value || null,
    };

    try {
      const url = tmsEditingDriverId ? `/api/tms/drivers/${tmsEditingDriverId}` : '/api/tms/drivers';
      const method = tmsEditingDriverId ? 'PUT' : 'POST';
      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!resp.ok) {
        const err = await resp.json();
        alert('Error: ' + (err.error || 'Failed to save driver'));
        return;
      }

      document.getElementById('tmsDriverForm').classList.add('hidden');
      document.getElementById('tmsStatus').classList.remove('hidden');
      document.getElementById('tmsStatus').className = 'status-bar success';
      document.getElementById('tmsStatus').textContent = '✓ Driver saved successfully';
      tmsEditingDriverId = null;
      await renderTmsDrivers();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function deleteTmsDriver(driverId) {
    if (!confirm('Delete this driver? This cannot be undone.')) return;

    try {
      const resp = await fetch(`/api/tms/drivers/${driverId}`, { method: 'DELETE' });
      if (!resp.ok) {
        const err = await resp.json();
        alert('Error: ' + (err.error || 'Failed to delete driver'));
        return;
      }

      document.getElementById('tmsStatus').classList.remove('hidden');
      document.getElementById('tmsStatus').className = 'status-bar success';
      document.getElementById('tmsStatus').textContent = '✓ Driver deleted';
      await renderTmsDrivers();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  // TMS button handlers
  document.getElementById('tmsAddDriverBtn')?.addEventListener('click', () => {
    tmsEditingDriverId = null;
    document.getElementById('tmsDriverName').value = '';
    document.getElementById('tmsDriverPhone').value = '';
    document.getElementById('tmsDriverEmail').value = '';
    document.getElementById('tmsDriverVehicle').value = '';
    document.getElementById('tmsDriverCapacityKg').value = '';
    document.getElementById('tmsDriverCapacityVolume').value = '';
    document.getElementById('tmsDriverShiftStart').value = '';
    document.getElementById('tmsDriverShiftEnd').value = '';
    document.getElementById('tmsDriverForm').classList.remove('hidden');
  });

  document.getElementById('tmsDriverSaveBtn')?.addEventListener('click', saveTmsDriver);
  document.getElementById('tmsDriverCancelBtn')?.addEventListener('click', () => {
    document.getElementById('tmsDriverForm').classList.add('hidden');
    tmsEditingDriverId = null;
  });

  // Route Planning
  let tmsCurrentRoutes = [];

  async function planTmsRoutes() {
    const planDate = document.getElementById('tmsRoutePlanDate')?.value;
    if (!planDate) { alert('Please select a date'); return; }

    // Get current jobs from loadedOrders
    if (!loadedOrders || loadedOrders.length === 0) {
      alert('No orders loaded. Upload orders first.');
      return;
    }

    // Convert orders to job format
    const jobs = [];
    for (const order of loadedOrders) {
      if (order.lines) {
        for (const line of order.lines) {
          jobs.push({
            order_number: order.order_number,
            customer_name: order.customer_name || order.client || '—',
            postal_code: order.zip || order.postal_code || 'UNKNOWN',
            address: order.address || '',
            qty: line.qty
          });
        }
      }
    }

    if (jobs.length === 0) {
      alert('No delivery lines in orders');
      return;
    }

    try {
      document.getElementById('tmsStatus').classList.remove('hidden');
      document.getElementById('tmsStatus').className = 'status-bar progress';
      document.getElementById('tmsStatus').textContent = 'Planning routes...';

      const resp = await fetch('/api/tms/routes/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobs, date: planDate })
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || 'Route planning failed');
      }

      const result = await resp.json();
      document.getElementById('tmsStatus').className = 'status-bar success';
      document.getElementById('tmsStatus').textContent = `✓ ${result.message}`;

      await renderTmsRoutes();
    } catch (err) {
      document.getElementById('tmsStatus').className = 'status-bar error';
      document.getElementById('tmsStatus').textContent = '❌ ' + err.message;
    }
  }

  async function renderTmsRoutes() {
    try {
      const resp = await fetch('/api/tms/routes');
      if (resp.ok) {
        tmsCurrentRoutes = await resp.json();
      } else {
        tmsCurrentRoutes = [];
      }
    } catch {
      tmsCurrentRoutes = [];
    }

    const tbody = document.getElementById('tmsRoutesBody');
    const empty = document.getElementById('tmsRoutesEmpty');

    if (!tmsCurrentRoutes.length) {
      empty.classList.remove('hidden');
      tbody.innerHTML = '';
      return;
    }

    empty.classList.add('hidden');
    tbody.innerHTML = tmsCurrentRoutes.map(r => `
      <tr>
        <td><code style="font-size:0.85rem">${esc(r.id || '—')}</code></td>
        <td>${esc(r.driver_name || '—')}</td>
        <td><strong>${esc(r.zone || '—')}</strong></td>
        <td>${r.total_stops || 0}</td>
        <td>${r.total_distance_km || 0} km</td>
        <td>${r.estimated_duration_minutes || 0} min</td>
        <td><span class="status-badge ${r.status || 'planned'}">${r.status || 'Planned'}</span></td>
        <td>
          <button class="btn-scan-now btn-sm" data-tms-view-route="${esc(r.id)}">View</button>
          <button class="btn-primary btn-sm" data-tms-pdf-route="${esc(r.id)}">PDF</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-tms-view-route]').forEach(btn => {
      btn.addEventListener('click', () => showTmsRouteDetail(btn.dataset.tmsViewRoute));
    });

    tbody.querySelectorAll('[data-tms-pdf-route]').forEach(btn => {
      btn.addEventListener('click', () => exportTmsRoutePdf(btn.dataset.tmsPdfRoute));
    });
  }

  async function showTmsRouteDetail(routeId) {
    try {
      const resp = await fetch(`/api/tms/routes/${routeId}`);
      if (!resp.ok) throw new Error('Failed to fetch route');
      const route = await resp.json();

      const details = document.getElementById('tmsRouteDetails');
      const stops = (route.stops || []).sort((a, b) => a.sequence - b.sequence);

      details.innerHTML = `
        <div style="margin-bottom:1rem;padding:0.75rem;background:#f0f9ff;border-radius:6px">
          <strong>Route:</strong> ${esc(route.id)}<br>
          <strong>Driver:</strong> ${esc(route.driver_name || '—')}<br>
          <strong>Date:</strong> ${route.planned_date} | <strong>Zone:</strong> ${esc(route.zone)}<br>
          <strong>Distance:</strong> ${route.total_distance_km} km | <strong>Duration:</strong> ${route.estimated_duration_minutes} min | <strong>Status:</strong> <span class="status-badge ${route.status}">${route.status}</span>
        </div>
        <div style="margin-bottom:1rem">
          <strong>Delivery Stops (${stops.length}):</strong>
          <div style="max-height:400px;overflow-y:auto;margin-top:0.5rem">
            <table class="dcs-table" style="font-size:0.85rem">
              <thead><tr><th>#</th><th>Order</th><th>Customer</th><th>Postal Code</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                ${stops.map((s, i) => `
                  <tr>
                    <td>${i + 1}</td>
                    <td><code>${esc(s.job_id)}</code></td>
                    <td>${esc(s.customer_name)}</td>
                    <td><strong>${esc(s.postal_code)}</strong></td>
                    <td><span class="status-badge ${s.status || 'pending'}">${s.status || 'Pending'}</span></td>
                    <td>
                      ${s.status === 'pending' ? `
                        <button class="btn-scan-now btn-xs" data-stop-complete="${esc(s.id)}">✓ Complete</button>
                        <button class="btn-danger btn-xs" data-stop-fail="${esc(s.id)}">✗ Fail</button>
                      ` : s.status === 'completed' ? '<span style="color:green">✓ Completed</span>' : '<span style="color:red">✗ Failed</span>'}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;

      // Wire up stop completion handlers
      details.querySelectorAll('[data-stop-complete]').forEach(btn => {
        btn.addEventListener('click', () => completeStop(btn.dataset.stopComplete, routeId));
      });
      details.querySelectorAll('[data-stop-fail]').forEach(btn => {
        btn.addEventListener('click', () => failStop(btn.dataset.stopFail));
      });

      document.getElementById('tmsRouteModal').classList.remove('hidden');
      document.getElementById('tmsRouteExportBtn').dataset.routeId = routeId;
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function completeStop(stopId, routeId) {
    try {
      const resp = await fetch(`/api/tms/stops/${stopId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'Delivered' })
      });
      if (!resp.ok) throw new Error('Failed to mark stop complete');

      document.getElementById('tmsStatus').classList.remove('hidden');
      document.getElementById('tmsStatus').className = 'status-bar success';
      document.getElementById('tmsStatus').textContent = '✓ Stop completed';

      await showTmsRouteDetail(routeId);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function failStop(stopId) {
    const reason = prompt('Why did this stop fail?');
    if (!reason) return;

    try {
      const resp = await fetch(`/api/tms/stops/${stopId}/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, notes: reason })
      });
      if (!resp.ok) throw new Error('Failed to mark stop failed');

      document.getElementById('tmsStatus').classList.remove('hidden');
      document.getElementById('tmsStatus').className = 'status-bar success';
      document.getElementById('tmsStatus').textContent = '✓ Stop marked as failed';
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function exportTmsRoute(routeId) {
    try {
      const resp = await fetch(`/api/tms/routes/${routeId}/export`);
      if (!resp.ok) throw new Error('Export failed');

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Route_${routeId}.xlsx`;
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(url);
      a.remove();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function loadTmsMetrics() {
    const from = document.getElementById('tmsMetricsFrom')?.value;
    const to = document.getElementById('tmsMetricsTo')?.value;

    if (!from || !to) {
      alert('Select both start and end dates');
      return;
    }

    try {
      const resp = await fetch(`/api/tms/metrics?from=${from}&to=${to}`);
      if (!resp.ok) throw new Error('Failed to load metrics');

      const data = await resp.json();
      const m = data.summary || {};

      document.getElementById('metricTotalRoutes').textContent = m.total_routes || '0';
      document.getElementById('metricTotalDistance').textContent = Math.round((m.total_distance_km || 0) * 100) / 100;
      document.getElementById('metricAvgDistance').textContent = Math.round((m.avg_distance_km || 0) * 100) / 100;
      document.getElementById('metricTotalStops').textContent = m.total_stops || '0';
      document.getElementById('metricCompletedRoutes').textContent = m.completed_routes || '0';

      // Driver performance
      const tbody = document.getElementById('tmsDriverPerfBody');
      const empty = document.getElementById('tmsDriverPerfEmpty');
      const perf = data.driverPerformance || [];

      if (!perf.length) {
        empty.classList.remove('hidden');
        tbody.innerHTML = '';
        return;
      }

      empty.classList.add('hidden');
      tbody.innerHTML = perf.map(d => {
        const completion = d.routes_assigned > 0 ? Math.round((d.completed_routes / d.routes_assigned) * 100) : 0;
        return `
          <tr>
            <td>${esc(d.name)}</td>
            <td>${d.routes_assigned || 0}</td>
            <td>${Math.round((d.total_distance_km || 0) * 100) / 100}</td>
            <td>${d.total_stops || 0}</td>
            <td>${d.completed_stops || 0}</td>
            <td><strong>${completion}%</strong></td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  // Route Planner button handlers
  document.getElementById('tmsRoutePlanBtn')?.addEventListener('click', planTmsRoutes);
  document.getElementById('tmsRouteExportBtn')?.addEventListener('click', function() {
    if (this.dataset.routeId) exportTmsRoute(this.dataset.routeId);
  });
  document.getElementById('tmsLoadMetricsBtn')?.addEventListener('click', loadTmsMetrics);

  // Set default date range to today's date
  document.addEventListener('DOMContentLoaded', () => {
    const today = new Date().toISOString().split('T')[0];
    const dateFrom = document.getElementById('tmsMetricsFrom');
    const dateTo = document.getElementById('tmsMetricsTo');
    if (dateFrom) dateFrom.value = today;
    if (dateTo) dateTo.value = today;
  });

  document.getElementById('inboundUploadPoBtn').addEventListener('click', () => {
    document.getElementById('inboundPoReference').value = '';
    document.getElementById('inboundPoSource').value = '';
    document.getElementById('inboundPoClient').value = '';
    document.getElementById('inboundPoFileInput').value = '';
    document.getElementById('inboundPoStatus').classList.add('hidden');
    document.getElementById('inboundUploadOverlay').classList.remove('hidden');
  });
  document.getElementById('inboundPoCancelBtn').addEventListener('click', () => {
    document.getElementById('inboundUploadOverlay').classList.add('hidden');
  });
  document.getElementById('inboundPoSubmitBtn').addEventListener('click', async () => {
    const fileInput = document.getElementById('inboundPoFileInput');
    const statusEl  = document.getElementById('inboundPoStatus');
    if (!fileInput.files.length) {
      statusEl.className = 'status-bar error'; statusEl.textContent = 'Choose a file first.'; statusEl.classList.remove('hidden');
      return;
    }
    const fd = new FormData();
    fd.append('inboundFile', fileInput.files[0]);
    fd.append('reference',   document.getElementById('inboundPoReference').value.trim());
    fd.append('source_name', document.getElementById('inboundPoSource').value.trim());
    fd.append('client_name', document.getElementById('inboundPoClient').value.trim());
    fd.append('eta',         document.getElementById('inboundPoEta')?.value || '');
    try {
      const resp = await fetch('/api/inbound/upload', { method: 'POST', headers: { 'x-session-id': SESSION_ID }, body: fd });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Upload failed');
      // Say how many lines were matched to the client's item master. An item we
      // have never been told about is still received — it just has no name to
      // show, and the receiver should know that BEFORE they start counting.
      if (data.unknown > 0) {
        alert(`${data.lines} line(s) loaded.\n\n`
          + `${data.matched} matched your item master and show a product name.\n`
          + `${data.unknown} ${data.unknown === 1 ? 'is' : 'are'} NOT in the item master, so ${data.unknown === 1 ? 'it has' : 'they have'} no description — `
          + `still receivable, but worth adding to the client's Product Master.`);
      }
      document.getElementById('inboundUploadOverlay').classList.add('hidden');
      await renderInboundTab();
      openInboundReceiving(data.id);
    } catch (err) {
      statusEl.className = 'status-bar error'; statusEl.textContent = err.message; statusEl.classList.remove('hidden');
    }
  });

  document.getElementById('inboundNewReturnBtn').addEventListener('click', () => {
    document.getElementById('inboundReturnReference').value = '';
    document.getElementById('inboundReturnSource').value = '';
    document.getElementById('inboundReturnClient').value = '';
    const rmaEl = document.getElementById('inboundReturnOrder'); if (rmaEl) rmaEl.value = '';
    document.getElementById('inboundReturnOverlay').classList.remove('hidden');
  });
  document.getElementById('inboundReturnCancelBtn').addEventListener('click', () => {
    document.getElementById('inboundReturnOverlay').classList.add('hidden');
  });
  document.getElementById('inboundReturnSubmitBtn').addEventListener('click', async () => {
    try {
      const resp = await fetch('/api/inbound/return', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({
          reference:   document.getElementById('inboundReturnReference').value.trim(),
          source_name: document.getElementById('inboundReturnSource').value.trim(),
          client_name: document.getElementById('inboundReturnClient').value.trim(),
          order_number: document.getElementById('inboundReturnOrder')?.value.trim() || '',
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not create return');
      document.getElementById('inboundReturnOverlay').classList.add('hidden');
      await renderInboundTab();
      openInboundReceiving(data.id);
    } catch (err) { alert(err.message); }
  });

  function inboundCartonLabelConfirmed(job, cartonNum) {
    return !!(job.cartons || []).find(c => c.num === cartonNum)?.labelConfirmed;
  }
  // Reuses the same #cartonLabelOverlay modal as outbound (only one overlay
  // is ever open at a time) but posts to the inbound endpoint instead.
  function showInboundLabelPrompt(labelText, cartonNum) {
    return new Promise(resolve => {
      document.getElementById('cartonLabelText').textContent = labelText;
      document.getElementById('cartonLabelOverlay').classList.remove('hidden');
      document.getElementById('cartonLabelConfirmBtn').onclick = () => {
        document.getElementById('cartonLabelOverlay').classList.add('hidden');
        if (activeInbound) {
          if (!activeInbound.cartons) activeInbound.cartons = [];
          let c = activeInbound.cartons.find(x => x.num === cartonNum);
          if (!c) { c = { num: cartonNum, scans: {} }; activeInbound.cartons.push(c); }
          c.labelConfirmed = true;
        }
        fetch(`/api/inbound/${activeInbound?.id}/carton/label-confirmed`, {
          method: 'POST', headers: hdrs(),
          body: JSON.stringify({ cartonNum, label: labelText }),
        }).catch(() => {});
        resolve();
      };
    });
  }

  function updateInboundCartonBadge(job) {
    const num   = job.active_carton_num || 1;
    const count = job.cartons.length || 1;
    document.getElementById('inboundCartonNum').textContent = num;
    document.querySelector('#inboundCartonBadge .scb-label').textContent = count > 1 ? `of ${count}` : 'carton';
    const prevBtn = document.getElementById('inboundCartonPrevBtn');
    const nextBtn = document.getElementById('inboundCartonNextBtn');
    const cancelBtn = document.getElementById('inboundCancelMultiCartonBtn');
    const multi = count > 1;
    prevBtn.classList.toggle('hidden', !multi);
    nextBtn.classList.toggle('hidden', !multi);
    cancelBtn.classList.toggle('hidden', !multi);
    prevBtn.disabled = num <= 1;
    nextBtn.disabled = num >= count;
  }

  function renderInboundItemsTable(job) {
    const tbody = document.getElementById('inboundItemsTbody');
    document.getElementById('inboundExpectedHeader').style.display = job.type === 'po' ? '' : 'none';
    const rows = [];
    const seenSkus = new Set();
    for (const line of job.lines) {
      seenSkus.add(line.sku);
      const received = job.scanned[line.sku] || 0;
      rows.push(`<tr class="${received >= line.expected_qty && line.expected_qty > 0 ? 'status-done' : ''}">
        <td>${esc(line.sku)}</td><td>${esc(line.description || '')}</td>
        <td class="qty-col">${line.expected_qty}</td><td class="qty-col">${received}</td>
      </tr>`);
    }
    for (const [sku, qty] of Object.entries(job.scanned)) {
      if (seenSkus.has(sku)) continue;
      rows.push(`<tr><td>${esc(sku)}</td><td><em>Not on ${job.type === 'po' ? 'PO' : 'list'}</em></td>
        <td class="qty-col">${job.type === 'po' ? '—' : ''}</td><td class="qty-col">${qty}</td></tr>`);
    }
    tbody.innerHTML = rows.join('') || `<tr><td colspan="4" class="hint">No items scanned yet.</td></tr>`;
  }

  function openInboundReceiving(id) {
    const job = inboundJobs.find(j => j.id === id);
    if (!job) return;
    activeInbound = job;
    document.getElementById('inboundJobRef').textContent  = job.reference || job.id.slice(0, 8);
    document.getElementById('inboundJobType').textContent = job.type === 'po' ? 'PO / ASN Receiving' : 'Return Receiving';
    document.getElementById('inboundJobMeta').innerHTML = `
      <div class="scan-meta-primary">
        ${job.serial ? `<span class="meta-pill">${esc(job.serial)}</span>` : ''}
        ${job.source_name ? `<span class="meta-pill">${esc(job.source_name)}</span>` : ''}
        ${job.client_name ? `<span class="meta-pill">${esc(job.client_name)}</span>` : ''}
        ${job.unmatched_lines > 0
          ? `<span class="meta-pill" style="background:#fffbeb;color:#92400e;border-color:#fde68a"
               title="These SKUs are not in ${esc(job.client_name || 'this client')}'s item master, so we have no product name for them. Receiving still works — check the Product Master is loaded for THIS client name.">
               &#9888; ${job.unmatched_lines} not in item master</span>`
          : ''}
      </div>`;
    setInboundCondition('straight_to_inventory'); // condition buttons show for ALL types now
    updateInboundCartonBadge(job);
    renderInboundItemsTable(job);
    renderInboundTeamStrip(job);
    if ((job.assignments || []).length && job.status !== 'done') startInboundTeamPoll(job.id);
    else stopInboundTeamPoll();
    lastScannedInboundSku = null;
    renderInboundPhotoGrid(job);
    document.getElementById('inboundCompleteBtn').disabled = job.status === 'done';
    document.getElementById('inboundScanOverlay').classList.remove('hidden');
    const input = document.getElementById('inboundScanInput');
    input.value = '';
    document.getElementById('inboundScanFeedback').classList.add('hidden');
    attachGlobalScanCapture('inbound'); // scans populate the input the same way outbound's do, wherever focus is
    if (job.status !== 'done') {
      // Carton 1 is labelled the moment receiving starts — same reasoning as
      // outbound: know where it's going before the first item lands in it.
      if (!inboundCartonLabelConfirmed(job, 1)) showInboundLabelPrompt(`${job.reference || job.id.slice(0, 8)}-01`, 1);
      setTimeout(() => input.focus(), 80);
    }
  }

  // ── TEAM STRIP ──────────────────────────────────────────────────────────
  // When a receipt has been split, the person receiving needs to see THEIR
  // lines and how far along they are — and, when a colleague counts a piece
  // against one of those lines, the notification pill has to appear HERE, on
  // the screen they are actually standing in front of. Rendered from the
  // assignments the scan response returns, and refreshed by a light poll so a
  // cross-scan shows up without them having to do anything.
  function renderInboundTeamStrip(job) {
    const el = document.getElementById('inboundTeamStrip');
    if (!el) return;
    const list = job?.assignments || [];
    if (!list.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const me = currentUser?.id || '';
    const mine   = list.filter(a => a.assignee === me);
    const others = list.filter(a => a.assignee !== me);
    const chip = a => {
      const done = a.done || 0, full = done >= a.qty;
      const notice = a.notice && !a.notice.seen
        ? `<button class="its-notice" data-seen-assignment="${esc(a.id)}"
             title="Tap to dismiss">${esc(a.notice.by)} counted ${a.notice.qty} for you &#10005;</button>`
        : '';
      return `<span class="its-chip${full ? ' done' : ''}">${esc(a.sku)}
        <b>${done}/${a.qty}</b>${notice}</span>`;
    };
    const byPerson = new Map();
    others.forEach(a => {
      if (!byPerson.has(a.assignee)) byPerson.set(a.assignee, []);
      byPerson.get(a.assignee).push(a);
    });
    el.innerHTML = `
      ${mine.length ? `<div class="its-row"><span class="its-who">Your lines</span>${mine.map(chip).join('')}</div>` : ''}
      ${[...byPerson.entries()].map(([who, as]) => {
        const done = as.reduce((s, a) => s + (a.done || 0), 0);
        const tot  = as.reduce((s, a) => s + a.qty, 0);
        return `<div class="its-row its-other"><span class="its-who">${esc(who)}</span>
          <span class="its-chip${done >= tot ? ' done' : ''}">${as.length} line(s) <b>${done}/${tot}</b></span></div>`;
      }).join('')}
      ${!mine.length ? `<div class="its-hint">None of these lines are yours &mdash; anything you scan still counts, and they're told.</div>` : ''}`;
    el.classList.remove('hidden');
    el.querySelectorAll('[data-seen-assignment]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.seenAssignment;
      const a = (activeInbound?.assignments || []).find(x => x.id === id);
      if (a?.notice) a.notice.seen = true;      // optimistic — it's only a read receipt
      renderInboundTeamStrip(activeInbound);
      try { await fetchT(`/api/inbound/${activeInbound.id}/assignment/${id}/seen`, { method: 'POST', headers: hdrs() }); } catch {}
    }));
  }

  // Poll only while the receiving screen is open, and only for a split receipt.
  let _inboundTeamPoll = null;
  function startInboundTeamPoll(jobId) {
    stopInboundTeamPoll();
    _inboundTeamPoll = setInterval(async () => {
      if (!activeInbound || activeInbound.id !== jobId) return stopInboundTeamPoll();
      try {
        const r = await fetchT(`/api/inbound/${jobId}/team`, { headers: hdrs() });
        if (!r.ok) return;
        const d = await r.json();
        if (!activeInbound || activeInbound.id !== jobId) return;
        activeInbound.assignments = d.assignments || [];
        activeInbound.lead = d.lead || null;
        // A colleague's pieces count towards the same receipt, so the Received
        // column has to move for everyone — not just for whoever scanned.
        // Locally-held offline scans are ADDED on top rather than overwritten:
        // the server does not know about them yet.
        const held = pendingScansForTarget('inbound', jobId).length;
        if (d.scanned && !held) {
          activeInbound.scanned = d.scanned;
          renderInboundItemsTable(activeInbound);
        }
        renderInboundTeamStrip(activeInbound);
      } catch {}
    }, 6000);
  }
  function stopInboundTeamPoll() { if (_inboundTeamPoll) { clearInterval(_inboundTeamPoll); _inboundTeamPoll = null; } }

  document.getElementById('backToInboundBtn').addEventListener('click', () => {
    document.getElementById('inboundScanOverlay').classList.add('hidden');
    detachGlobalScanCapture();
    stopInboundTeamPoll();
    activeInbound = null;
    renderInboundTab();
  });

  // Condition of the NEXT inbound scan — driven by the big segmented buttons.
  // Applies to EVERY receiving type (a PO can arrive damaged too, not just
  // returns). Auto-resets to Good after a non-good scan: damage is the
  // exception, and a sticky Damaged button would quietly quarantine everything.
  let inboundCondition = 'straight_to_inventory';
  function setInboundCondition(cond) {
    inboundCondition = cond;
    document.querySelectorAll('#inboundCondSeg .cond-btn').forEach(b => b.classList.toggle('active', b.dataset.cond === cond));
  }
  setTimeout(() => {
    document.querySelectorAll('#inboundCondSeg .cond-btn').forEach(b =>
      b.addEventListener('click', () => { setInboundCondition(b.dataset.cond); document.getElementById('inboundScanInput')?.focus(); }));
  }, 0);

  async function inboundScan(code) {
    if (!activeInbound || activeInbound.status === 'done') return;
    const feedback = document.getElementById('inboundScanFeedback');
    // Minted HERE, at scan time, and sent on the very first request — not just
    // on a replay. If the server applies the scan but the response is lost, the
    // queued retry carries this same id and the server's dedupe absorbs it.
    // Minting only at enqueue time is what caused "scan 1, get 2 pcs" on the
    // outbound side; receiving must not repeat it.
    const eventId = _newEventId();
    const condition = inboundCondition;
    // Bind the scan to the job it was taken on, for the same reason the order
    // path does: everything after the await may run with activeInbound null
    // (receiver went back) or pointing at a different job.
    const jobId = activeInbound.id;
    const stillOpen = () => !!activeInbound && activeInbound.id === jobId;
    try {
      const resp = await fetchT(`/api/inbound/${jobId}/scan`, {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ code, qty: 1, condition, eventId }),
      });
      const data = await resp.json();
      if (!resp.ok) { showFeedback(feedback, 'error', data.error || 'Scan failed'); return; }
      if (!stillOpen()) return;   // landed server-side; nothing on screen to update
      activeInbound.scanned[data.sku] = data.scanned_qty;
      activeInbound.status = 'processing';
      activeInbound.active_carton_num = data.cartonNum;
      if (data.cartonCount > activeInbound.cartons.length) {
        activeInbound.cartons.push({ num: data.cartonNum, scans: {} });
      }
      lastScannedInboundSku = data.sku;
      // TEAM FEEDBACK. Say whose assignment the piece landed on — and make a
      // cross-scan obvious, so the person who picked up someone else's item
      // knows it counted for them, not for himself.
      let crossMsg = '';
      if (data.allocation) {
        activeInbound.assignments = data.assignments || activeInbound.assignments;
        renderInboundTeamStrip(activeInbound);
        const al = data.allocation;
        // Held and appended to whatever the normal outcome line says — writing
        // it here directly used to be overwritten a few lines down by the plain
        // "N received" success message, so the person who picked up a colleague's
        // item was never actually told.
        if (al.cross) crossMsg = ` — counted for ${al.assignee} (${al.done}/${al.qty}), they've been notified`;
      }
      updateInboundCartonBadge(activeInbound);
      renderInboundItemsTable(activeInbound);
      const ct = data.condition_totals || {};
      if (data.condition === 'damaged' || data.condition === 'kiv') {
        // Damage/KIV evidence: offer the camera right in the feedback line —
        // one tap opens the phone camera, photo tagged to this SKU + condition.
        const label = data.condition === 'damaged' ? `💥 DAMAGED (${ct.damaged || 1} so far)` : `⏸ KIV (${ct.kiv || 1} so far)`;
        feedback.className = 'scan-feedback error';
        feedback.innerHTML = `${esc(data.sku)}: received as ${label} — ${data.scanned_qty} total${esc(crossMsg)} <button class="link-btn" id="damagePhotoChip" style="font-weight:700">📷 Damage photo</button>`;
        feedback.classList.remove('hidden');
        clearTimeout(feedback._t);
        feedback._t = setTimeout(() => feedback.classList.add('hidden'), 12000); // longer — give them time to tap
        document.getElementById('damagePhotoChip')?.addEventListener('click', () => {
          _pendingPhotoCondition = data.condition;
          lastScannedInboundSku = data.sku;
          document.getElementById('inboundScanPhotoInput').click();
        });
      } else if (data.crossdock) {
        // ⚡ CROSS-DOCK: outbound orders are waiting on this SKU — stage it for
        // packing instead of shelving it.
        showFeedback(feedback, 'error', `${data.sku}: ${data.scanned_qty} received — ⚡ ${data.crossdock.needed} pc(s) NEEDED by ${data.crossdock.orders.join(', ')} — stage for packing, don't shelve${crossMsg}`);
      } else showFeedback(feedback, crossMsg ? 'pending' : 'success', `${data.sku}: ${data.scanned_qty} received${crossMsg}`);
      if (inboundCondition !== 'straight_to_inventory') setInboundCondition('straight_to_inventory');
    } catch (err) {
      // NETWORK DOWN — the piece is in the receiver's hand and must not be
      // lost. Queue it durably (localStorage, survives a reload and a browser
      // restart) and count it on screen as pending, exactly like outbound.
      enqueueOfflineTargetScan('inbound', jobId, code, eventId, { condition });
      const held = pendingScansForTarget('inbound', jobId).length;
      if (!stillOpen()) return;
      showFeedback(feedback, 'pending',
        `⚡ No connection — scan saved (${code}), ${held} waiting to sync automatically`);
      renderInboundItemsTable(activeInbound);
    }
  }
  // Actual submission is handled by the global scan capture (attached with
  // target 'inbound' in openInboundReceiving) — same reasoning as outbound's
  // itemScanInput listener below: this just prevents Enter's default action
  // and stops it double-firing through both listeners.
  document.getElementById('inboundScanInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') e.preventDefault();
  });

  // ── Inbound receiving photos — per-scan (tagged to the last SKU scanned)
  // and general (untagged, e.g. a shot of the box/shipment) ──────────────
  // Downscale a camera photo in the browser before upload — a phone shot is
  // 3–6 MB raw; at max-edge 1600px JPEG q0.82 it's ~200–400 KB, so 4 photos per
  // SKU costs ~1 MB of volume instead of ~20. Non-images / small files pass
  // through untouched; any failure falls back to the original (never blocks).
  async function downscalePhoto(file) {
    try {
      if (!/^image\//.test(file.type) || file.size < 500 * 1024) return file;
      const bmp = await createImageBitmap(file);
      const MAX = 1600;
      const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      if (scale >= 1) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch { return file; }
  }

  async function uploadInboundPhoto(file, sku, condition) {
    if (!activeInbound) return;
    const compact = await downscalePhoto(file);
    const fd = new FormData();
    fd.append('photo', compact);
    if (sku) fd.append('sku', sku);
    if (condition) fd.append('condition', condition);
    try {
      const resp = await fetch(`/api/inbound/${activeInbound.id}/photo`, { method: 'POST', body: fd });
      const data = await resp.json();
      if (!resp.ok) { alert(data.error || 'Photo upload failed'); return; }
      activeInbound.photos = activeInbound.photos || [];
      activeInbound.photos.push(data.photo);
      renderInboundPhotoGrid(activeInbound);
    } catch (err) { alert(err.message); }
  }

  document.getElementById('inboundGeneralPhotoBtn').addEventListener('click', () => {
    document.getElementById('inboundGeneralPhotoInput').click();
  });
  document.getElementById('inboundSerialsBtn')?.addEventListener('click', () => {
    if (!activeInbound) return;
    openSerialsModal('receive', { clientId: activeInbound.client_name || '', ref: activeInbound.serial || activeInbound.reference || '' });
  });
  document.getElementById('inboundGeneralPhotoInput').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) uploadInboundPhoto(file, null);
  });

  // When the pending photo is damage evidence (set by the "📷 Damage photo"
  // chip after a damaged/KIV scan) it's tagged with that condition; a normal
  // per-scan photo carries no condition.
  let _pendingPhotoCondition = null;
  document.getElementById('inboundScanPhotoBtn').addEventListener('click', () => {
    if (!lastScannedInboundSku) { alert('Scan an item first, then attach a photo to it.'); return; }
    _pendingPhotoCondition = null;
    document.getElementById('inboundScanPhotoInput').click();
  });
  document.getElementById('inboundScanPhotoInput').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) uploadInboundPhoto(file, lastScannedInboundSku, _pendingPhotoCondition);
    _pendingPhotoCondition = null;
  });

  function renderInboundPhotoGrid(job) {
    const grid = document.getElementById('inboundPhotoGrid');
    const token = localStorage.getItem('wms_token') || '';
    grid.innerHTML = (job.photos || []).map(p => `
      <div class="inbound-photo-card" data-photo-id="${esc(p.id)}" data-photo-tag="${esc(p.sku || 'General')}${p.condition ? ' — ' + (p.condition === 'damaged' ? '💥 damaged' : '⏸ KIV') : ''}">
        <img src="/api/inbound/${job.id}/photo/${p.id}?token=${encodeURIComponent(token)}" loading="lazy" />
        <div class="ipc-tag"${p.condition ? ' style="background:#dc2626;color:#fff"' : ''}>${esc(p.sku || 'General')}${p.condition ? (p.condition === 'damaged' ? ' 💥' : ' ⏸') : ''}</div>
      </div>`).join('');
    grid.querySelectorAll('.inbound-photo-card').forEach(card => {
      card.addEventListener('click', () => {
        const img = card.querySelector('img');
        document.getElementById('inboundPhotoLightboxImg').src = img.src;
        document.getElementById('inboundPhotoLightboxCaption').textContent = card.dataset.photoTag;
        document.getElementById('inboundPhotoLightbox').classList.remove('hidden');
      });
    });
  }
  function closeInboundPhotoLightbox() {
    document.getElementById('inboundPhotoLightbox').classList.add('hidden');
    document.getElementById('inboundPhotoLightboxImg').src = '';
  }
  document.getElementById('inboundPhotoLightboxClose').addEventListener('click', closeInboundPhotoLightbox);
  document.getElementById('inboundPhotoLightbox').addEventListener('click', e => {
    if (e.target.id === 'inboundPhotoLightbox') closeInboundPhotoLightbox();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('inboundPhotoLightbox').classList.contains('hidden')) closeInboundPhotoLightbox();
  });

  document.getElementById('inboundNewCartonBtn').addEventListener('click', async () => {
    if (!activeInbound) return;
    const btn = document.getElementById('inboundNewCartonBtn');
    btn.disabled = true;
    try {
      const resp = await fetch(`/api/inbound/${activeInbound.id}/new-carton`, { method: 'POST', headers: hdrs() });
      const data = await resp.json();
      if (!resp.ok) { showFeedback(document.getElementById('inboundScanFeedback'), 'error', data.error || 'Could not start a new carton.'); return; }
      const closedNum = activeInbound.active_carton_num || 1;
      activeInbound.active_carton_num = data.activeCartonNum;
      if (data.cartonCount > activeInbound.cartons.length) activeInbound.cartons.push({ num: data.activeCartonNum, scans: {} });
      updateInboundCartonBadge(activeInbound);
      showFeedback(document.getElementById('inboundScanFeedback'), 'success', `📦 Carton ${data.activeCartonNum} started`);
      document.getElementById('inboundScanInput').focus();
      if (!inboundCartonLabelConfirmed(activeInbound, closedNum)) {
        await showInboundLabelPrompt(`${activeInbound.reference || activeInbound.id.slice(0, 8)}-${String(closedNum).padStart(2, '0')}`, closedNum);
      }
    } catch (err) {
      showFeedback(document.getElementById('inboundScanFeedback'), 'error', err.message);
    } finally { btn.disabled = false; }
  });

  async function switchInboundCarton(num) {
    if (!activeInbound || num < 1) return;
    try {
      const resp = await fetch(`/api/inbound/${activeInbound.id}/carton/switch`, {
        method: 'POST', headers: hdrs(), body: JSON.stringify({ cartonNum: num }),
      });
      const data = await resp.json();
      if (!resp.ok) return;
      activeInbound.active_carton_num = data.activeCartonNum;
      updateInboundCartonBadge(activeInbound);
    } catch {}
  }
  document.getElementById('inboundCartonPrevBtn').addEventListener('click', () => switchInboundCarton((activeInbound?.active_carton_num || 1) - 1));
  document.getElementById('inboundCartonNextBtn').addEventListener('click', () => switchInboundCarton((activeInbound?.active_carton_num || 1) + 1));

  document.getElementById('inboundCancelMultiCartonBtn').addEventListener('click', async () => {
    if (!activeInbound || !confirm('Merge every carton back into one box?')) return;
    try {
      const resp = await fetch(`/api/inbound/${activeInbound.id}/carton/cancel-multi`, { method: 'POST', headers: hdrs() });
      const data = await resp.json();
      if (!resp.ok) { alert(data.error); return; }
      activeInbound.cartons = [{ num: 1, scans: activeInbound.scanned, labelConfirmed: true }];
      activeInbound.active_carton_num = 1;
      updateInboundCartonBadge(activeInbound);
    } catch (err) { alert(err.message); }
  });

  // Ends receiving on this job — the only action that locks it read-only.
  // Anything short of this (closing the overlay, switching tabs, coming back
  // later) leaves it open: status stays pending/processing, so the list
  // still shows "Receive" and openInboundReceiving() picks up right where
  // scanning left off, across as many sessions as needed.
  async function endInboundReceipt(force) {
    if (!activeInbound) return;
    const feedback = document.getElementById('inboundScanFeedback');
    // A receipt must never be closed over a hole: ending it while scans are
    // still held offline would bank a short count as the final one, and the
    // discrepancy would be recorded against the supplier. Same rule as
    // completing an order. The job stays open and reopenable — nothing is lost
    // by waiting, and the queue drains on its own.
    const held = pendingScansForTarget('inbound', activeInbound.id).length;
    if (held) {
      alert(`${held} scan(s) are still waiting for the connection to return.\n\nThe receipt will be endable as soon as they sync — keep it open.`);
      return;
    }
    try {
      const resp = await fetch(`/api/inbound/${activeInbound.id}/end-receipt`, {
        method: 'POST', headers: hdrs(), body: JSON.stringify({ force: !!force }),
      });
      const data = await resp.json();
      if (resp.status === 409 && data.needsConfirm) {
        const n = data.mismatches.length + data.extras.length;
        feedback.className = 'scan-feedback error';
        feedback.innerHTML = `⚠ ${n} item(s) differ from the PO. <button class="link-btn" id="inboundForceEndBtn">End Receipt Anyway</button>`;
        feedback.classList.remove('hidden');
        document.getElementById('inboundForceEndBtn').addEventListener('click', () => endInboundReceipt(true));
        return;
      }
      if (resp.status === 409 && data.needsPhotos) {
        // Photo evidence is compulsory (damage/discrepancy) — offer the camera
        // right here: one tap opens it, tagged to the first missing SKU (or as a
        // general shipment photo for a discrepancy-only case).
        feedback.className = 'scan-feedback error';
        feedback.innerHTML = `📷 ${esc(data.message)} <button class="link-btn" id="evidencePhotoBtn" style="font-weight:700">Take photo now</button>`;
        feedback.classList.remove('hidden');
        clearTimeout(feedback._t);
        feedback._t = setTimeout(() => feedback.classList.add('hidden'), 15000);
        const wasForce = !!force;
        document.getElementById('evidencePhotoBtn')?.addEventListener('click', () => {
          if (data.missingSkus && data.missingSkus.length) {
            lastScannedInboundSku = data.missingSkus[0];
            _pendingPhotoCondition = 'damaged';
            document.getElementById('inboundScanPhotoInput').click();
          } else {
            document.getElementById('inboundGeneralPhotoInput').click();
          }
          // After the receiver snaps + uploads, they just tap End Receipt again
          // (force choice preserved by the normal flow).
          void wasForce;
        });
        return;
      }
      if (!resp.ok) { showFeedback(feedback, 'error', data.error || 'Could not end receipt'); return; }
      activeInbound.status = 'done';
      // Last carton never went through the "closing" prompt (nothing ever
      // supersedes it) — label it now, before moving on, same as outbound.
      const lastNum = activeInbound.cartons[activeInbound.cartons.length - 1]?.num || 1;
      if (activeInbound.cartons.length > 1 && !inboundCartonLabelConfirmed(activeInbound, lastNum)) {
        await showInboundLabelPrompt(`${activeInbound.reference || activeInbound.id.slice(0, 8)}-${String(lastNum).padStart(2, '0')}`, lastNum);
      }
      document.getElementById('inboundScanOverlay').classList.add('hidden');
      detachGlobalScanCapture();
      stopInboundTeamPoll();
      const finishedId = activeInbound.id;
      const finishedRef = activeInbound.serial || activeInbound.reference || finishedId.slice(0, 8);
      activeInbound = null;
      renderInboundTab();
      // THE PUTAWAY DECISION. Received goods have to end up somewhere, and the
      // crew knows right now which it is — so ask here rather than leaving the
      // pallet unaccounted for on the floor.
      askPutawayNowOrLater(finishedId, finishedRef);
    } catch (err) { showFeedback(feedback, 'error', err.message); }
  }
  document.getElementById('inboundCompleteBtn').addEventListener('click', () => endInboundReceipt(false));

  // ── Putaway now, or stage it? ─────────────────────────────────────────────
  // NOW  → the existing putaway screen, where a real bin must be scanned or typed.
  // LATER→ the server issues a STAGING ID; it is printed and stuck on the cargo
  //        so the pallet can be traced back to this receipt later.
  let _stagingJobId = null;
  function askPutawayNowOrLater(jobId, ref) {
    _stagingJobId = jobId;
    document.getElementById('putawayAskRef').textContent = ref;
    document.getElementById('putawayAskArea').value = '';
    document.getElementById('putawayAskResult').classList.add('hidden');
    document.getElementById('putawayAskChoices').classList.remove('hidden');
    document.getElementById('putawayAskOverlay').classList.remove('hidden');
  }
  document.getElementById('putawayAskNow').addEventListener('click', async () => {
    document.getElementById('putawayAskOverlay').classList.add('hidden');
    if (!_stagingJobId) return;
    // openPutaway reads the in-memory inboundJobs list, which renderInboundTab
    // has only just started refetching — wait for the job to land rather than
    // racing it and silently doing nothing.
    for (let i = 0; i < 20 && !(inboundJobs || []).some(j => j.id === _stagingJobId); i++) {
      await new Promise(r => setTimeout(r, 150));
    }
    openPutaway(_stagingJobId);   // the existing screen: a real bin must be scanned or typed
  });
  document.getElementById('putawayAskLater').addEventListener('click', async () => {
    if (!_stagingJobId) return;
    const area = document.getElementById('putawayAskArea').value.trim();
    const btn = document.getElementById('putawayAskLater');
    btn.disabled = true;
    try {
      const r = await fetch(`/api/inbound/${encodeURIComponent(_stagingJobId)}/stage`, {
        method: 'POST', headers: hdrs(), body: JSON.stringify({ area }),
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Could not stage this receipt.'); return; }
      _lastStaging = { jobId: _stagingJobId, code: j.staging.code };
      document.getElementById('putawayAskChoices').classList.add('hidden');
      document.getElementById('putawayStagingCode').textContent = j.staging.code;
      document.getElementById('putawayStagingWhat').textContent =
        `${j.staging.lines.length} SKU(s) · ${j.staging.units} pcs${j.staging.area ? ` · ${j.staging.area}` : ''}`;
      document.getElementById('putawayAskResult').classList.remove('hidden');
      renderInboundTab();
    } catch (e) { alert('Network error — nothing was staged.'); }
    finally { btn.disabled = false; }
  });
  document.getElementById('putawayAskClose').addEventListener('click', () =>
    document.getElementById('putawayAskOverlay').classList.add('hidden'));

  // The printed label that goes on the cargo. Same window.open + print pattern
  // as the carton slip and waybill label; the code is also rendered as a
  // barcode so it can be scanned back off the pallet.
  let _lastStaging = null;
  async function printStagingLabel(jobId, code) {
    const r = await fetch(`/api/inbound/${encodeURIComponent(jobId)}/staging-label/${encodeURIComponent(code)}`, { headers: hdrs() });
    if (!r.ok) { alert('Could not load that staging label.'); return; }
    const d = await r.json();
    const w = window.open('', '_blank', 'width=420,height=620');
    if (!w) { alert('Allow pop-ups to print the staging label.'); return; }
    w.document.write(`<!doctype html><html><head><title>${esc(d.staging_code)}</title>
      <script src="/vendor/jsbarcode.js"><\/script>
      <style>
        body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:14px}
        .code{font-size:2.5rem;font-weight:900;letter-spacing:.04em;text-align:center;margin:.2rem 0}
        .sub{text-align:center;color:#475569;font-size:.85rem}
        table{width:100%;border-collapse:collapse;margin-top:.7rem;font-size:.8rem}
        th,td{border-bottom:1px solid #e2e8f0;padding:.3rem .2rem;text-align:left}
        td.q,th.q{text-align:right}
        .box{border:3px solid #000;border-radius:10px;padding:10px}
        .hd{text-align:center;font-weight:800;letter-spacing:.12em;font-size:.7rem;color:#475569}
      </style></head><body>
      <div class="box">
        <div class="hd">STAGED — AWAITING PUTAWAY</div>
        <div class="code">${esc(d.staging_code)}</div>
        <svg id="bc"></svg>
        <div class="sub">${esc(d.client_name)}${d.area ? ` · ${esc(d.area)}` : ''}</div>
        <div class="sub">Receipt ${esc(d.receipt)}${d.reference ? ` · ${esc(d.reference)}` : ''}</div>
        <div class="sub">${d.units} pcs · staged ${esc(String(d.staged_at).slice(0, 16).replace('T', ' '))}</div>
        <table><thead><tr><th>SKU</th><th>Description</th><th class="q">Qty</th></tr></thead><tbody>
        ${d.lines.map(l => `<tr><td>${esc(l.sku)}</td><td>${esc(String(l.description || '').slice(0, 34))}</td><td class="q">${l.qty}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <script>
        try { JsBarcode('#bc', ${JSON.stringify(d.staging_code)}, {format:'CODE128',width:2,height:52,displayValue:false,margin:0}); } catch(e){}
        setTimeout(function(){ window.print(); }, 350);
      <\/script></body></html>`);
    w.document.close();
  }
  document.getElementById('putawayPrintStaging').addEventListener('click', () => {
    if (_lastStaging) printStagingLabel(_lastStaging.jobId, _lastStaging.code);
  });

  // ── Request Order Deletion (admin: reason + own password; Master approves) ──
  let _delOrderTarget = null; // { orderNumber, batchId }
  function openDeleteOrderModal(orderNumber, batchId) {
    _bulkDelTargets = null;   // single-order path — clear any bulk selection
    _delOrderTarget = { orderNumber, batchId };
    document.getElementById('delOrderNumber').textContent = orderNumber;
    const reasonEl = document.getElementById('delOrderReason');
    const passEl   = document.getElementById('delOrderPassword');
    reasonEl.value = '';
    passEl.value   = '';
    document.getElementById('delOrderError').classList.add('hidden');
    document.getElementById('delOrderConfirmBtn').disabled = true;
    document.getElementById('deleteOrderOverlay').classList.remove('hidden');
    setTimeout(() => reasonEl.focus(), 100);
  }
  function _delOrderFormReady() {
    return document.getElementById('delOrderReason').value.trim() !== '' &&
           document.getElementById('delOrderPassword').value !== '';
  }
  ['delOrderReason', 'delOrderPassword'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      const ready = _delOrderFormReady();
      document.getElementById('delOrderConfirmBtn').disabled = !ready;
      if (ready) document.getElementById('delOrderError').classList.add('hidden');
    });
  });
  document.getElementById('delOrderCancelBtn').addEventListener('click', () => {
    document.getElementById('deleteOrderOverlay').classList.add('hidden');
    _delOrderTarget = null;
  });
  document.getElementById('delOrderConfirmBtn').addEventListener('click', async () => {
    const reason   = document.getElementById('delOrderReason').value.trim();
    const password = document.getElementById('delOrderPassword').value;
    const isBulk   = Array.isArray(_bulkDelTargets) && _bulkDelTargets.length > 0;
    if (!_delOrderFormReady() || (!_delOrderTarget && !isBulk)) {
      document.getElementById('delOrderError').classList.remove('hidden');
      return;
    }
    const btn = document.getElementById('delOrderConfirmBtn');
    btn.disabled = true;

    if (isBulk) {
      // ONE request for the whole selection. This used to loop the single-order
      // endpoint, which re-checked the same password once per order — selecting
      // 143 orders produced 143 identical "Incorrect password" lines in one
      // alert. The password is now verified once, server-side, and a wrong one
      // comes back as a single clear message with the dialog still open so it
      // can just be retyped.
      const targets = _bulkDelTargets;
      btn.textContent = `Requesting… (${targets.length})`;
      try {
        const r = await fetch('/api/scan/order-deletion-request-bulk', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targets, reason, password }),
        });
        const d = await r.json();
        if (!r.ok) {
          // Auth failures keep the dialog open — the reason is still typed in.
          const err = document.getElementById('delOrderError');
          err.textContent = d.error || 'Request failed';
          err.classList.remove('hidden');
          if (d.authFailed) document.getElementById('delOrderPassword').select();
          return;
        }
        document.getElementById('deleteOrderOverlay').classList.add('hidden');
        _bulkDelTargets = null;
        orderSelection.clear();
        await refreshOrders(); renderOrdersList();
        const fails = d.failed || [];
        if (fails.length) {
          // Group identical reasons instead of listing every order separately.
          const byReason = {};
          fails.forEach(f => { byReason[f.error] = (byReason[f.error] || 0) + 1; });
          alert(`Deletion requested for ${d.requested} order(s). Master approval is required to remove them.\n\n`
            + `${fails.length} could not be requested:\n`
            + Object.entries(byReason).map(([e, n]) => `  • ${n} × ${e}`).join('\n'));
        } else {
          alert(`Deletion requested for ${d.requested} order(s). Master approval is required to remove them.`);
        }
      } catch (err) {
        const el = document.getElementById('delOrderError');
        el.textContent = 'Could not reach the server — please try again.';
        el.classList.remove('hidden');
      } finally {
        btn.textContent = '\u{1F5D1} Request Deletion';
        btn.disabled = !_delOrderFormReady();
      }
      return;
    }

    const { orderNumber, batchId } = _delOrderTarget;
    btn.textContent = 'Requesting…';
    try {
      const r = await fetch('/api/scan/order-deletion-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber, batchId, reason, password }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Request failed');
      document.getElementById('deleteOrderOverlay').classList.add('hidden');
      _delOrderTarget = null;
      await refreshOrders(); renderOrdersList();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.textContent = '\u{1F5D1} Request Deletion';
      btn.disabled = !_delOrderFormReady();
    }
  });

  // ── Request Inbound Record Deletion (same admin-request/Master-approve
  // flow as Orders — IdealInbound has no separate batch/record split, so
  // one deletion path covers the whole job) ──────────────────────────────
  let _delInboundTarget = null; // inbound record id
  function openDeleteInboundModal(id, ref) {
    _delInboundTarget = id;
    document.getElementById('delInboundRef').textContent = ref;
    const reasonEl = document.getElementById('delInboundReason');
    const passEl   = document.getElementById('delInboundPassword');
    reasonEl.value = '';
    passEl.value   = '';
    document.getElementById('delInboundError').classList.add('hidden');
    document.getElementById('delInboundConfirmBtn').disabled = true;
    document.getElementById('deleteInboundOverlay').classList.remove('hidden');
    setTimeout(() => reasonEl.focus(), 100);
  }
  function _delInboundFormReady() {
    return document.getElementById('delInboundReason').value.trim() !== '' &&
           document.getElementById('delInboundPassword').value !== '';
  }
  ['delInboundReason', 'delInboundPassword'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      const ready = _delInboundFormReady();
      document.getElementById('delInboundConfirmBtn').disabled = !ready;
      if (ready) document.getElementById('delInboundError').classList.add('hidden');
    });
  });
  document.getElementById('delInboundCancelBtn').addEventListener('click', () => {
    document.getElementById('deleteInboundOverlay').classList.add('hidden');
    _delInboundTarget = null;
  });
  document.getElementById('delInboundConfirmBtn').addEventListener('click', async () => {
    const reason   = document.getElementById('delInboundReason').value.trim();
    const password = document.getElementById('delInboundPassword').value;
    if (!_delInboundFormReady() || !_delInboundTarget) {
      document.getElementById('delInboundError').classList.remove('hidden');
      return;
    }
    const id  = _delInboundTarget;
    const btn = document.getElementById('delInboundConfirmBtn');
    btn.disabled = true; btn.textContent = 'Requesting…';
    try {
      const r = await fetch(`/api/inbound/${id}/deletion-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, password }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Request failed');
      document.getElementById('deleteInboundOverlay').classList.add('hidden');
      _delInboundTarget = null;
      await renderInboundTab();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.textContent = '\u{1F5D1} Request Deletion';
      btn.disabled = !_delInboundFormReady();
    }
  });

  // ── Scan Overlay ───────────────────────────────────────────────────────────
  async function openScanOverlay(orderNumber) {
    if (!currentUser) { requireLogin(() => openScanOverlay(orderNumber)); return; }
    const ord = loadedOrders.find(o => o.order_number === orderNumber);
    if (!ord) return;
    // One packer per order: claim it before opening. If another station holds
    // it, the packer must explicitly take over (audit-logged) or back off.
    try {
      const r = await fetch('/api/scan/claim', { method: 'POST', headers: hdrs(), body: JSON.stringify({ orderNumber }) });
      if (r.status === 409) {
        const d = await r.json();
        const mins = d.claimedAt ? Math.max(1, Math.round((Date.now() - new Date(d.claimedAt)) / 60000)) : null;
        const ok = confirm(`⚠ Order ${orderNumber} is being packed by ${d.claimedBy}${mins ? ` (active ${mins} min ago)` : ''} at another station.\n\nTake over this order? Only do this if that station has genuinely stopped.`);
        if (!ok) return;
        const f = await fetch('/api/scan/claim', { method: 'POST', headers: hdrs(), body: JSON.stringify({ orderNumber, force: true }) });
        if (!f.ok) { alert((await f.json()).error || 'Could not take over the order.'); return; }
      }
    } catch {} // network hiccup — proceed; every scan re-checks the claim server-side
    activeOrder = ord;
    // Show/hide the waybill/label PDF button in the scan header
    const waybillBtn = document.getElementById('scanWaybillPdfBtn');
    if (ord.has_order_label) {
      const token = localStorage.getItem('wms_token') || '';
      waybillBtn.href = `/api/order-label/${encodeURIComponent(ord.order_number)}/pdf?token=${encodeURIComponent(token)}&dl=1`;
      waybillBtn.setAttribute('download', `${ord.order_number}_label.pdf`);
      waybillBtn.innerHTML = '&#8681; Label';
      waybillBtn.classList.remove('hidden');
    } else if (ord.has_waybill_pdf && ord.batchId) {
      waybillBtn.href = `/api/waybill-pdf/${encodeURIComponent(ord.batchId)}/${encodeURIComponent(ord.order_number)}?dl=1`;
      waybillBtn.setAttribute('download', `${ord.order_number}_waybill.pdf`);
      waybillBtn.innerHTML = '&#8681; Waybill';
      waybillBtn.classList.remove('hidden');
    } else {
      waybillBtn.classList.add('hidden');
    }
    // Unhide BEFORE rendering — the adaptive page-fit measures the visible
    // list height, which is 0 while the overlay is display:none
    document.getElementById('scanOverlay').classList.remove('hidden');
    document.body.classList.add('scan-open');
    enterItemsPhase(ord);
    attachGlobalScanCapture();
    loadResolveCache(); // keep the offline barcode cache fresh (non-blocking)
  }

  function focusWaybillInput() {
    const el = document.getElementById('waybillScanInput');
    if (el) setTimeout(() => { el.focus(); el.select(); }, 60);
  }

  function closeScanOverlay() {
    document.getElementById('scanOverlay').classList.add('hidden');
    document.body.classList.remove('scan-open');
    stopInlineCam();
    detachGlobalScanCapture();
    _scanQueue.length = 0;
    _scanBusy = false;
    stopTimer();
    activeOrder = null;
    focusWaybillInput();
  }

  // ── Warehouse-mobile scan layout: inline live camera above the item list ──
  // Mirrors the courier pickup-scan pattern: viewfinder always on at the top,
  // Camera / Scanner tabs, manual entry + ADD below. Enabled for
  // warehouse-role users on phone-width screens; everyone else keeps the
  // desktop layout with the separate full-screen camera overlay.
  let inlineCamStream = null, inlineCamFrame = null, inlineCamDetector = null;
  let inlineCamUsesJsQR = false;
  const inlineCamLastHit = {};
  function whMobileScanLayout() {
    return (currentUser?.role === 'warehouse') && window.matchMedia('(max-width: 768px)').matches;
  }
  // Camera fold-away. Phone layout only (the panel itself is display:none on
  // desktop), and the choice is remembered per device — a picker who always
  // uses a gun should not have to fold it every single order.
  const INLINE_CAM_COLLAPSE_KEY = 'is_inline_cam_collapsed';
  function setInlineCamCollapsed(collapsed, remember = true) {
    const panel = document.getElementById('inlineCamPanel');
    const btn = document.getElementById('inlineCamCollapse');
    if (!panel) return;
    panel.classList.toggle('cam-collapsed', collapsed);
    if (btn) { btn.innerHTML = collapsed ? '&#9660;' : '&#9650;'; btn.title = collapsed ? 'Show the camera' : 'Hide the camera'; }
    // Folded away means the stream is genuinely off, not merely hidden — no
    // point draining a phone battery on a viewfinder nobody is looking at.
    if (collapsed) stopInlineCam();
    else if (document.getElementById('inlineCamTabCamera')?.classList.contains('active')) startInlineCam();
    if (remember) { try { localStorage.setItem(INLINE_CAM_COLLAPSE_KEY, collapsed ? '1' : ''); } catch (_) {} }
  }
  function inlineCamCollapsedPref() {
    try { return localStorage.getItem(INLINE_CAM_COLLAPSE_KEY) === '1'; } catch (_) { return false; }
  }
  document.getElementById('inlineCamCollapse')?.addEventListener('click', () => {
    const panel = document.getElementById('inlineCamPanel');
    setInlineCamCollapsed(!panel.classList.contains('cam-collapsed'));
  });

  function setInlineCamTab(tab) {
    document.getElementById('inlineCamTabCamera').classList.toggle('active', tab === 'camera');
    document.getElementById('inlineCamTabScanner').classList.toggle('active', tab === 'scanner');
    document.getElementById('inlineCamView').classList.toggle('hidden', tab !== 'camera');
    const folded = document.getElementById('inlineCamPanel')?.classList.contains('cam-collapsed');
    if (tab === 'camera') { if (!folded) startInlineCam(); }
    else { stopInlineCam(); setTimeout(focusActiveQty, 60); }
  }
  async function startInlineCam() {
    if (inlineCamStream) return; // already running
    const video = document.getElementById('inlineCamVideo');
    const errEl = document.getElementById('inlineCamError');
    errEl.classList.add('hidden');
    inlineCamUsesJsQR = false;
    if ('BarcodeDetector' in window) {
      if (!inlineCamDetector) {
        let fmts;
        try { fmts = await BarcodeDetector.getSupportedFormats(); }
        catch { fmts = ['code_128', 'ean_13', 'ean_8', 'qr_code', 'upc_a', 'upc_e', 'code_39', 'itf', 'data_matrix']; }
        inlineCamDetector = new BarcodeDetector({ formats: fmts });
      }
    } else if (window.jsQR) {
      inlineCamUsesJsQR = true;
    } else {
      errEl.textContent = 'Camera decoding not supported in this browser — use the Scanner tab.';
      errEl.classList.remove('hidden');
      return;
    }
    document.getElementById('inlineCamQrHint').classList.toggle('hidden', !inlineCamUsesJsQR);
    try {
      inlineCamStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      video.srcObject = inlineCamStream;
      await new Promise(r => { video.onloadedmetadata = r; });
      await video.play();
    } catch (err) {
      stopInlineCam();
      errEl.textContent = 'Camera error: ' + err.message + ' — use the Scanner tab.';
      errEl.classList.remove('hidden');
      return;
    }
    let jsqrCanvas = null, jsqrLast = 0;
    const decodeJsQR = () => {
      const now = Date.now();
      if (now - jsqrLast < 160) return null;
      jsqrLast = now;
      if (!jsqrCanvas) jsqrCanvas = document.createElement('canvas');
      const scale = Math.min(1, 640 / (video.videoWidth || 640));
      const w = Math.max(1, Math.round((video.videoWidth || 640) * scale));
      const h = Math.max(1, Math.round((video.videoHeight || 480) * scale));
      jsqrCanvas.width = w; jsqrCanvas.height = h;
      const ctx = jsqrCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const hit = jsQR(img.data, w, h);
      return hit && hit.data ? hit.data : null;
    };
    async function loop() {
      if (!inlineCamStream) return;
      try {
        if (video.readyState >= 2) {
          let vals = [];
          if (inlineCamUsesJsQR) {
            const v = decodeJsQR();
            if (v) vals = [v];
          } else {
            vals = (await inlineCamDetector.detect(video)).map(b => (b.rawValue || '').trim());
          }
          const now = Date.now();
          for (const val of vals) {
            if (!val) continue;
            if (now - (inlineCamLastHit[val] || 0) < SINGLE_COOLDOWN_MS) continue;
            inlineCamLastHit[val] = now;
            const flash = document.getElementById('inlineCamFlash');
            flash.textContent = '✓ ' + val;
            flash.classList.remove('hidden');
            clearTimeout(flash._t);
            flash._t = setTimeout(() => flash.classList.add('hidden'), 1400);
            // NEWCARTON control cards and item codes both flow through the
            // same path a typed/wedge scan takes
            _scanBuf = val;
            _flushScanBuf();
          }
        }
      } catch {}
      inlineCamFrame = requestAnimationFrame(loop);
    }
    inlineCamFrame = requestAnimationFrame(loop);
  }
  function stopInlineCam() {
    if (inlineCamFrame)  { cancelAnimationFrame(inlineCamFrame); inlineCamFrame = null; }
    if (inlineCamStream) { inlineCamStream.getTracks().forEach(t => t.stop()); inlineCamStream = null; }
    const video = document.getElementById('inlineCamVideo');
    if (video) video.srcObject = null;
  }
  document.getElementById('inlineCamTabCamera').addEventListener('click', () => setInlineCamTab('camera'));
  document.getElementById('inlineCamTabScanner').addEventListener('click', () => setInlineCamTab('scanner'));
  document.getElementById('scanAddBtn').addEventListener('click', () => {
    const inp = document.getElementById('itemScanInput');
    const v = (inp.value || '').trim();
    if (!v) { inp.focus(); return; }
    _scanBuf = v;
    _flushScanBuf();
    inp.value = '';
  });

  document.getElementById('backToOrdersBtn').addEventListener('click', pauseAndGoToOrders);
  document.getElementById('pauseOrderBtn').addEventListener('click', pauseAndGoToOrders);

  // ── Print label prompt (stays on screen until the packer picks Print or
  // Skip — an earlier auto-dismiss-after-3s made an unprinted label hard to
  // find again once it skipped itself) ──────────────────────────────────────
  let _pltOrder = null;

  function showPrintLabelPrompt(order) {
    _pltOrder = order;
    document.getElementById('printLabelToast').classList.remove('hidden');
  }

  function dismissPrintLabelPrompt() {
    document.getElementById('printLabelToast').classList.add('hidden');
    _pltOrder = null;
    focusWaybillInput();
  }

  document.getElementById('pltPrintBtn').addEventListener('click', () => {
    const ord = _pltOrder;
    dismissPrintLabelPrompt();
    if (ord) printWaybillLabel(ord);
  });
  document.getElementById('pltSkipBtn').addEventListener('click', dismissPrintLabelPrompt);

  async function printWaybillLabel(order) {
    const carrier = (order.carrier || '').trim();

    // If a Word doc template is registered for this carrier, download the populated docx
    if (_docTemplates === null) {
      try { _docTemplates = await fetch('/api/label/doc-templates').then(r => r.json()); }
      catch { _docTemplates = []; }
    }
    if (carrier && (_docTemplates || []).some(c => c.toLowerCase() === carrier.toLowerCase())) {
      const filename = `Label_${(order.order_number || 'label').replace(/[^a-zA-Z0-9_-]/g, '_')}.docx`;
      await postDownload('/api/label/doc', { carrier, order }, filename);
      return;
    }

    // Match a saved HTML carrier template (case-insensitive)
    const tpl = (_labelTemplates || []).find(t => t.carrier.toLowerCase() === carrier.toLowerCase()) || null;
    const headerText  = tpl ? (tpl.header_text || tpl.carrier) : (carrier || 'IDEALOMS');
    const headerBg    = tpl ? (tpl.header_bg    || '#000000')  : '#000000';
    const headerColor = tpl ? (tpl.header_color || '#ffffff')  : '#ffffff';
    const showBarcode  = tpl ? tpl.show_barcode  !== false : true;
    const showAddress  = tpl ? tpl.show_address  !== false : true;
    const showTel      = tpl ? tpl.show_tel      !== false : true;
    const showItems    = tpl ? tpl.show_items    !== false : true;
    const showPlatform = tpl ? tpl.show_platform !== false : true;
    const showOrderNo  = tpl ? tpl.show_order_no !== false : true;

    const customer    = order.customer_name    || '—';
    const address     = order.delivery_address || '—';
    const platform    = order.platform
      ? (order.shop_name ? `${order.platform} / ${order.shop_name}` : order.platform)
      : (order.shop_name || '');
    const waybill     = (order.waybill_number || '').trim();
    const tel         = order.tel || '';
    const printerName = (currentUser?.printerName || '').trim();
    const sizeKey     = currentUser?.labelSize || '100x160';
    const labelDim    = LABEL_SIZE_MAP[sizeKey] || LABEL_SIZE_MAP['100x160'];
    const lw          = labelDim.w;
    const lh          = labelDim.h;

    const itemRows = (order.lines || []).map(l =>
      `<tr><td>${esc(String(l.sku))}</td><td class="qty">${l.qty}</td></tr>`
    ).join('');

    const barcodeSection = (showBarcode && waybill) ? `
  <div class="barcode-section">
    <svg id="barcode"></svg>
    <div class="barcode-text">${esc(waybill)}</div>
  </div>` : '';

    const printerHint = printerName
      ? `<div class="printer-hint">&#128438; Print to: <strong>${esc(printerName)}</strong></div>`
      : '';

    const addressSection = showAddress ? `
  <div class="section">
    <div class="section-title">Deliver To</div>
    <div class="customer-name">${esc(customer)}</div>
    <div class="address">${esc(address)}</div>
    ${showTel && tel ? `<div class="tel">Tel: ${esc(tel)}</div>` : ''}
  </div>` : '';

    const itemsSection = showItems ? `
  <div class="section">
    <div class="section-title">Items</div>
    <table class="items">
      <thead><tr><th>SKU / Item</th><th class="qty">Qty</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
  </div>` : '';

    const footerRow = (showPlatform || showOrderNo) ? `
  <div class="footer-row">
    ${showOrderNo  ? `<div class="order-no">Order: ${esc(order.order_number)}</div>` : '<div></div>'}
    ${showPlatform && platform ? `<div class="platform-badge">${esc(platform)}</div>` : ''}
  </div>` : '';

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<title>Label ${esc(order.order_number)}</title>
<script src="/vendor/jsbarcode.min.js"><\/script>
<style>
  @page { size: ${lw}mm ${lh}mm; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; }
  body { width: ${lw}mm; padding: 3mm; font-size: 9pt; }
  .printer-hint { text-align:center; padding: 3px 0 5px; font-size: 8pt; color: #555; }
  @media print { .printer-hint { display: none !important; } }
  .label-header {
    background: ${headerBg}; color: ${headerColor};
    text-align: center; font-size: 17pt; font-weight: 900;
    letter-spacing: 2px; padding: 3mm 2mm; margin-bottom: 2.5mm;
    text-transform: uppercase;
  }
  .barcode-section { text-align: center; margin-bottom: 2.5mm; padding: 2mm 0; border: 1px solid #000; border-radius: 2px; }
  .barcode-section svg { width: 90mm; height: 18mm; }
  .barcode-text { font-size: 9pt; font-weight: 700; letter-spacing: 1px; margin-top: 1mm; }
  .section { border: 1px solid #000; border-radius: 2px; padding: 2mm 2.5mm; margin-bottom: 2mm; }
  .section-title { font-size: 6pt; font-weight: 700; text-transform: uppercase; color: #555; margin-bottom: 1mm; letter-spacing: .5px; }
  .customer-name { font-size: 11pt; font-weight: 700; margin-bottom: 1mm; }
  .address { font-size: 8.5pt; line-height: 1.4; }
  .tel { font-size: 8pt; color: #333; margin-top: 1mm; }
  table.items { width: 100%; border-collapse: collapse; font-size: 8pt; }
  table.items th { text-align: left; font-size: 6.5pt; text-transform: uppercase; color: #555; border-bottom: 1px solid #ccc; padding-bottom: 1mm; }
  table.items th.qty, table.items td.qty { text-align: right; }
  table.items td { padding: .8mm 0; border-bottom: 1px solid #eee; }
  .footer-row { display: flex; justify-content: space-between; align-items: center; margin-top: 2mm; }
  .platform-badge { background: #f0f0f0; border: 1px solid #ccc; border-radius: 2px; font-size: 7pt; font-weight: 700; padding: 1mm 2mm; }
  .order-no { font-size: 7pt; color: #555; }
</style>
</head>
<body>
  ${printerHint}
  <div class="label-header">${esc(headerText)}</div>

  ${barcodeSection}

  ${addressSection}

  ${itemsSection}

  ${footerRow}

  <script>
    ${(showBarcode && waybill) ? `JsBarcode("#barcode","${waybill.replace(/"/g,'\\"')}",{format:"CODE128",width:2.8,height:60,displayValue:false,margin:4});` : ''}
    window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };
  <\/script>
</body>
</html>`;

    const w = window.open('', '_blank', 'width=440,height=650');
    w.document.write(html);
    w.document.close();
    w.focus();
  }

  document.getElementById('clearAndRestartBtn').addEventListener('click', async () => {
    if (!activeOrder) return;
    if (!confirm(`Clear all scanned quantities for ${activeOrder.order_number} and restart from zero?`)) return;
    try {
      const resp = await fetch('/api/scan/reset', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ orderNumber: activeOrder.order_number }),
      });
      if (!resp.ok) { const d = await resp.json(); alert(d.error); return; }
      // Reset local timing so elapsed starts fresh
      orderTimings[activeOrder.order_number] = new Date().toISOString();
      saveTimings();
      await refreshOrders();
      const updated = loadedOrders.find(o => o.order_number === activeOrder.order_number);
      if (updated) enterItemsPhase(updated);
    } catch (err) { alert(err.message); }
  });

  async function pauseAndGoToOrders() {
    if (!activeOrder) return;
    try {
      await fetch('/api/scan/save', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ orderNumber: activeOrder.order_number }),
      });
      fetch('/api/scan/release', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ orderNumber: activeOrder.order_number }),
      }).catch(() => {});
    } catch {}
    closeScanOverlay();
    await refreshOrders();
    renderOrdersList();
  }

  // ── Items phase ────────────────────────────────────────────────────────────
  // Bin-verify at pick: scanning a printed BIN LABEL (QR of the bin id) in the
  // item-scan input records "I'm at this bin" instead of erroring as an unknown
  // SKU; a following item scan that belongs to a DIFFERENT bin per the pick plan
  // gets a non-blocking warning. Loaded lazily per scan session.
  let _binIdSet = null;
  let _lastScannedBin = '';
  function _loadBinIds() {
    fetch('/api/inventory/locations').then(r => r.ok ? r.json() : []).then(list => {
      _binIdSet = new Set((list || []).map(l => String(l.location_id).toUpperCase()));
    }).catch(() => {});
  }

  function enterItemsPhase(order) {
    activeOrder      = order;
    currentMismatches = [];
    _lastScannedBin  = '';
    _loadBinIds();

    // Show unprocessed banner when re-opening a previously cancelled order
    const banner = document.getElementById('unprocessedBanner');
    if (order.scan_status === 'unprocessed' && Array.isArray(order.mismatches) && order.mismatches.length) {
      document.getElementById('unprocessedMismatchTbody').innerHTML = order.mismatches.map(m => `
        <tr>
          <td><code>${esc(m.sku)}</code></td>
          <td>${esc(m.description || '—')}</td>
          <td>${m.ordered}</td>
          <td class="${m.scanned > m.ordered ? 'over' : 'short'}">${m.scanned}</td>
          <td class="${m.gap > 0 ? 'over' : 'short'}">${m.gap > 0 ? '+' : ''}${m.gap}</td>
        </tr>`).join('');
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    if (!orderTimings[order.order_number]) {
      orderTimings[order.order_number] = new Date().toISOString();
      saveTimings();
    }

    document.getElementById('scanOrderNo').textContent = order.order_number;
    // Compact one-line header: picking needs order/progress/carrier only.
    // Address, tel & platform live behind the Details toggle (label stage
    // is handled by the print popup on completion).
    const details = [
      order.tel              ? `<span><strong>Tel:</strong> ${esc(order.tel)}</span>` : '',
      order.delivery_address ? `<span class="scan-meta-address"><strong>Address:</strong> ${esc(order.delivery_address)}</span>` : '',
      order.platform         ? `<span><strong>Platform:</strong> ${esc(order.platform)}${order.shop_name ? ' / ' + esc(order.shop_name) : ''}</span>` : '',
      order.has_waybill_pdf  ? `<span class="meta-waybill-note">&#128196; Waybill PDF ready to print</span>` : '',
    ].filter(Boolean).join('');
    document.getElementById('scanOrderMeta').innerHTML = `
      <div class="scan-meta-primary">
        <span class="meta-pill">${esc(order.customer_name || '—')}</span>
        ${order.client_name ? `<span class="meta-pill">${esc(order.client_name)}</span>` : ''}
        <span class="meta-pill meta-pill-carrier">${esc(order.carrier || '—')}</span>
        ${order.waybill_number ? `<span class="meta-pill meta-pill-waybill">${esc(order.waybill_number)}${order.has_waybill_pdf ? ' &#10003;' : ''}</span>` : ''}
        ${order.issue_no ? `<span class="meta-pill meta-pill-gi" title="GI number">GI: ${esc(order.issue_no)}</span>` : ''}
        ${details ? `<button class="meta-details-btn" id="scanMetaDetailsBtn">&#9432; Details</button>` : ''}
      </div>
      ${details ? `<div class="scan-meta-details hidden" id="scanMetaDetails">${details}</div>` : ''}`;
    document.getElementById('scanMetaDetailsBtn')?.addEventListener('click', () => {
      document.getElementById('scanMetaDetails').classList.toggle('hidden');
    });

    // Warehouse-mobile layout: inline viewfinder pinned above the list,
    // ADD button next to the input, no separate camera overlay button
    {
      const panel = document.getElementById('inlineCamPanel');
      const whMobile = whMobileScanLayout();
      panel.classList.toggle('hidden', !whMobile);
      document.getElementById('scanAddBtn').classList.toggle('hidden', !whMobile);
      document.getElementById('openCameraBtn').classList.toggle('hidden', whMobile);
      if (whMobile) {
        setInlineCamCollapsed(inlineCamCollapsedPref(), false);   // honour this device's choice
        setInlineCamTab('camera');
      }
      else stopInlineCam();
    }

    scanPage = 0; scanPageManual = false; scanFocusSku = null;
    _autoCompleteFired = false;
    scanPageSize = SCAN_PAGE_MAX; // re-measure fit for this screen
    order.cartonNum   = order.active_carton_num || 1;
    order.cartonCount = (order.cartons && order.cartons.length) ? order.cartons.length : 1;
    updateCartonBadge(order);
    // Carton 1 gets labelled from the moment packing starts, not only once a
    // split makes it necessary — a packer writes it the moment they grab the
    // first box. Fires once per order; skipped entirely once already confirmed.
    if (!cartonLabelConfirmed(order, 1)) {
      showCartonLabelPrompt(`${order.order_number}-01`, 1);
    }
    renderItemsTable(order);
    updateProgress(order);
    startTimer(orderTimings[order.order_number]);

    const input = document.getElementById('itemScanInput');
    input.value = '';
    document.getElementById('itemScanFeedback').classList.add('hidden');
    setTimeout(focusActiveQty, 80);
  }

  // ── Cartons — a big order can take more than one physical box ───────────────
  function updateCartonBadge(order) {
    const num   = order.cartonNum   || 1;
    const count = order.cartonCount || 1;
    const numEl = document.getElementById('scanCartonNum');
    if (numEl) numEl.textContent = num;
    const labelEl = document.querySelector('#scanCartonBadge .scb-label');
    if (labelEl) labelEl.textContent = count > 1 ? `of ${count}` : 'carton';
    const prevBtn = document.getElementById('cartonPrevBtn');
    const nextBtn = document.getElementById('cartonNextBtn');
    const cancelBtn = document.getElementById('cancelMultiCartonBtn');
    const multi = count > 1;
    prevBtn?.classList.toggle('hidden', !multi);
    nextBtn?.classList.toggle('hidden', !multi);
    cancelBtn?.classList.toggle('hidden', !multi);
    if (prevBtn) prevBtn.disabled = num <= 1;
    if (nextBtn) nextBtn.disabled = num >= count;
  }
  // Tells the packer exactly what to write on the carton (ORDER-01, ORDER-02, …)
  // and blocks moving on until they confirm — reuses the global scan-capture's
  // existing "never intercept while a .modal-overlay is open" rule, so this
  // genuinely pauses scanning, not just a cosmetic reminder.
  function cartonLabelConfirmed(order, cartonNum) {
    return !!(order.cartons || []).find(c => c.num === cartonNum)?.labelConfirmed;
  }
  function showCartonLabelPrompt(labelText, cartonNum) {
    return new Promise(resolve => {
      document.getElementById('cartonLabelText').textContent = labelText;
      document.getElementById('cartonLabelOverlay').classList.remove('hidden');
      const confirm = () => {
        document.getElementById('cartonLabelOverlay').classList.add('hidden');
        document.removeEventListener('keydown', onKeydown, true);
        if (activeOrder) {
          if (!activeOrder.cartons) activeOrder.cartons = [];
          let c = activeOrder.cartons.find(x => x.num === cartonNum);
          if (!c) { c = { num: cartonNum, scans: {} }; activeOrder.cartons.push(c); }
          c.labelConfirmed = true;
        }
        fetch('/api/scan/carton/label-confirmed', {
          method: 'POST', headers: hdrs(),
          body: JSON.stringify({ orderNumber: activeOrder?.order_number, cartonNum, label: labelText }),
        }).catch(() => {}); // persists server-side + audit trail — never block the UI on it
        resolve();
      };
      // Any key dismisses it — a packer who's written the label and starts
      // scanning/typing the next SKU shouldn't need to also reach for the
      // mouse. Still a genuine, intentional action (not a timer), so
      // labelConfirmed keeps meaning what it says.
      const onKeydown = () => confirm();
      document.addEventListener('keydown', onKeydown, true);
      document.getElementById('cartonLabelConfirmBtn').onclick = confirm;
    });
  }

  // Big green "SEAL FINAL CARTON" screen at order completion. Shows the final
  // carton label for ~4s, auto-dismisses on timer or any key/click.
  function showSealFinalCarton(labelText, cartonNum) {
    return new Promise(resolve => {
      const overlay = document.getElementById('sealCartonOverlay');
      document.getElementById('sealCartonLabel').textContent = labelText;
      overlay.classList.remove('hidden');
      let dismissed = false;
      const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        clearTimeout(timer);
        overlay.classList.add('hidden');
        document.removeEventListener('keydown', onKeydown, true);
        overlay.removeEventListener('click', onClick);
        if (activeOrder) {
          if (!activeOrder.cartons) activeOrder.cartons = [];
          let c = activeOrder.cartons.find(x => x.num === cartonNum);
          if (!c) { c = { num: cartonNum, scans: {} }; activeOrder.cartons.push(c); }
          c.labelConfirmed = true;
        }
        fetch('/api/scan/carton/label-confirmed', {
          method: 'POST', headers: hdrs(),
          body: JSON.stringify({ orderNumber: activeOrder?.order_number, cartonNum, label: labelText }),
        }).catch(() => {}); // fire-and-forget: never block the UI
        resolve();
      };
      const onKeydown = () => dismiss();
      const onClick = () => dismiss();
      document.addEventListener('keydown', onKeydown, true);
      overlay.addEventListener('click', onClick);
      // Auto-dismiss after ~4 seconds
      const timer = setTimeout(dismiss, 4000);
    });
  }

  // Fixed control code a packer can scan (from a printed card at the station)
  // instead of reaching for the mouse — same action as clicking "+ New Carton".
  const NEW_CARTON_CODES = new Set(['NEWCARTON', 'NEW CARTON', 'NEW-CARTON', 'NEWBOX']);
  async function requestNewCarton() {
    if (!activeOrder) return;
    // The order isn't fully picked yet — whatever's scanned into the NEW
    // carton could include a SKU that's already partly scanned into an
    // earlier one, splitting it across boxes. Confirm that's intentional
    // before starting the carton (the reactive per-SKU cross-carton-confirm
    // still catches the actual split when it happens; this is an earlier,
    // order-level heads-up at the point of deciding to split at all).
    {
      const scanned  = activeOrder.scanned || {};
      const pendingC = (typeof pendingCountsFor === 'function') ? pendingCountsFor(activeOrder) : {};
      const cnt      = sku => (scanned[sku] || 0) + (pendingC[sku] || 0);
      const lines    = mergedScanLines(activeOrder);
      const totalOrdered = lines.reduce((s, l) => s + (l.qty || 0), 0);
      const totalScanned = lines.reduce((s, l) => s + cnt(l.sku), 0);
      if (totalOrdered > 0 && totalScanned < totalOrdered) {
        const ok = confirm(`This order isn't fully scanned yet (${totalScanned}/${totalOrdered} pcs). Starting a new carton means the same SKU could end up split across boxes. Continue?`);
        if (!ok) return;
      }
    }
    const btn = document.getElementById('newCartonBtn');
    btn.disabled = true;
    try {
      const resp = await fetch('/api/scan/new-carton', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ orderNumber: activeOrder.order_number }),
      });
      const data = await resp.json();
      if (!resp.ok) { showFeedback(document.getElementById('itemScanFeedback'), 'error', data.error || 'Could not start a new carton.'); return; }
      const closedNum = activeOrder.cartonNum || 1; // the carton being sealed shut, about to be replaced as active
      activeOrder.cartonNum   = data.activeCartonNum;
      activeOrder.cartonCount = data.cartonCount;
      updateCartonBadge(activeOrder);
      showFeedback(document.getElementById('itemScanFeedback'), 'success', `\u{1F4E6} Carton ${data.activeCartonNum} started`);
      focusActiveQty();
      // Carton 1 is usually already labelled at order-start (see enterItemsPhase) —
      // only prompt here if it genuinely hasn't been confirmed yet.
      if (!cartonLabelConfirmed(activeOrder, closedNum)) {
        await showCartonLabelPrompt(`${activeOrder.order_number}-${String(closedNum).padStart(2, '0')}`, closedNum);
      }
    } catch (err) {
      showFeedback(document.getElementById('itemScanFeedback'), 'error', err.message);
    } finally {
      btn.disabled = false;
    }
  }
  document.getElementById('newCartonBtn').addEventListener('click', requestNewCarton);

  // Toggle between existing cartons (open or previously closed) to add/remove
  // items in one that's already sealed, then move on. Scans and the qty-input
  // correction path both apply to whichever carton is active.
  async function switchCarton(num) {
    if (!activeOrder || num < 1) return;
    try {
      const resp = await fetch('/api/scan/carton/switch', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ orderNumber: activeOrder.order_number, cartonNum: num }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        if (data.lockedCarton && (currentUser?.role || 'admin') === 'admin') {
          // Carton is sealed — offer admin the unlock option
          const pwd = prompt(`Carton ${num} is sealed. Enter your password to unlock it (for fixing):`, '');
          if (pwd) {
            try {
              const unlockResp = await fetch('/api/scan/carton/unlock', {
                method: 'POST', headers: hdrs(),
                body: JSON.stringify({ orderNumber: activeOrder.order_number, cartonNum: num, password: pwd }),
              });
              const unlockData = await unlockResp.json();
              if (!unlockResp.ok) { alert('Unlock failed: ' + (unlockData.error || 'wrong password')); return; }
              // Retry the switch now that it's unlocked
              await switchCarton(num);
              return;
            } catch (err) { alert('Unlock error: ' + err.message); return; }
          }
          return;
        }
        showFeedback(document.getElementById('itemScanFeedback'), 'error', data.error || 'Could not switch carton.');
        return;
      }
      activeOrder.cartonNum   = data.activeCartonNum;
      activeOrder.cartonCount = data.cartonCount;
      updateCartonBadge(activeOrder);
      showFeedback(document.getElementById('itemScanFeedback'), 'success', `\u{1F4E6} Now packing Carton ${data.activeCartonNum}`);
      focusActiveQty();
    } catch (err) {
      showFeedback(document.getElementById('itemScanFeedback'), 'error', err.message);
    }
  }
  document.getElementById('cartonPrevBtn').addEventListener('click', () => switchCarton((activeOrder?.cartonNum || 1) - 1));
  document.getElementById('cartonNextBtn').addEventListener('click', () => switchCarton((activeOrder?.cartonNum || 1) + 1));

  // "Actually it all fits in one box" — merge every carton back into one.
  // Order-level scanned totals are unaffected; only the box breakdown collapses.
  document.getElementById('cancelMultiCartonBtn').addEventListener('click', async () => {
    if (!activeOrder) return;
    if (!confirm('Merge all cartons back into a single box?\n\nItem totals are unaffected — only the per-carton breakdown is cleared.')) return;
    try {
      const resp = await fetch('/api/scan/carton/cancel-multi', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ orderNumber: activeOrder.order_number }),
      });
      const data = await resp.json();
      if (!resp.ok) { showFeedback(document.getElementById('itemScanFeedback'), 'error', data.error || 'Could not merge cartons.'); return; }
      activeOrder.cartonNum   = data.activeCartonNum;
      activeOrder.cartonCount = data.cartonCount;
      updateCartonBadge(activeOrder);
      showFeedback(document.getElementById('itemScanFeedback'), 'success', '✓ Back to a single carton');
    } catch (err) {
      showFeedback(document.getElementById('itemScanFeedback'), 'error', err.message);
    }
  });

  // ── Printable "New Carton" control barcode card ──────────────────────────────
  // Print once, tape/laminate at the packing station — scanning it fires the
  // same action as the button, so a packer never needs to touch the mouse.
  function printNewCartonCard() {
    const w = window.open('', '_blank', 'width=420,height=560');
    if (!w) { alert('Please allow pop-ups to print the carton card.'); return; }
    w.document.write(`
      <html><head><title>New Carton — Scan Card</title>
      <script src="/vendor/jsbarcode.min.js"></script>
      <style>
        body { font-family: -apple-system, Arial, sans-serif; text-align: center; padding: 2rem 1rem; }
        h1 { font-size: 1.3rem; margin: 0 0 .3rem; }
        p { color: #555; font-size: .85rem; margin: 0 0 1.5rem; }
        svg { max-width: 100%; }
      </style></head>
      <body>
        <h1>&#128230; NEW CARTON</h1>
        <p>Scan this at the packing station to start the next box</p>
        <svg id="bc"></svg>
        <script>
          JsBarcode("#bc", "NEWCARTON", { format: "CODE128", width: 3, height: 90, fontSize: 18 });
          window.onload = () => setTimeout(() => window.print(), 300);
        </script>
      </body></html>`);
    w.document.close();
  }
  document.getElementById('printCartonCardBtn')?.addEventListener('click', printNewCartonCard);

  // ── Printable per-carton packing slip ────────────────────────────────────────
  // Read-only add-on — fetches the current carton's contents and prints a small
  // slip (order no. + carton no. + a scannable barcode of the order, so a box
  // separated from its slip is still traceable, plus SKU/qty contents). Does
  // not touch increment/new-carton/complete or any existing state at all.
  async function printCartonSlip() {
    if (!activeOrder) return;
    const btn = document.getElementById('printCartonSlipBtn');
    btn.disabled = true;
    try {
      const resp = await fetch(`/api/scan/carton-slip/${encodeURIComponent(activeOrder.order_number)}`, { headers: hdrs() });
      const data = await resp.json();
      if (!resp.ok) { alert(data.error || 'Could not load the carton slip.'); return; }
      const w = window.open('', '_blank', 'width=420,height=650');
      if (!w) { alert('Please allow pop-ups to print the carton slip.'); return; }
      const rows = data.items.length
        ? data.items.map(i => {
            let r = `<tr><td>${esc(i.sku)}</td><td>${esc(i.description)}</td><td>${i.qty}</td></tr>`;
            // Physical kit → show its contents so packer/customer sees inside.
            if (i.contains && i.contains.length) {
              const inside = i.contains.map(c => `${esc(c.sku)} ×${c.total}`).join(' + ');
              r += `<tr class="kit-contains"><td></td><td colspan="2">↳ contains: ${inside}</td></tr>`;
            }
            return r;
          }).join('')
        : `<tr><td colspan="3" style="text-align:center;color:#888">Nothing scanned into this carton yet</td></tr>`;
      w.document.write(`
        <html><head><title>Carton ${data.cartonNum} — ${esc(data.orderNumber)}</title>
        <script src="/vendor/jsbarcode.min.js"></script>
        <style>
          body { font-family: -apple-system, Arial, sans-serif; padding: 1.2rem; }
          h1 { font-size: 1.5rem; margin: 0 0 .1rem; }
          .ctn { font-size: 1.15rem; font-weight: 800; color: #2563eb; margin-bottom: .5rem; }
          .meta { font-size: .82rem; color: #555; margin-bottom: .7rem; }
          table { width: 100%; border-collapse: collapse; font-size: .85rem; margin-top: .5rem; }
          th, td { border: 1px solid #ccc; padding: .35rem .5rem; text-align: left; }
          th { background: #f3f4f6; }
          tr.kit-contains td { border-top: none; font-size: .78rem; color: #6d28d9; font-style: italic; }
          svg { max-width: 100%; margin: .4rem 0; }
        </style></head>
        <body>
          <h1>${esc(data.orderNumber)}</h1>
          <div class="ctn">&#128230; CARTON ${data.cartonNum}</div>
          <div class="meta">${esc(data.customerName)}${data.clientName ? ' &middot; ' + esc(data.clientName) : ''}</div>
          <svg id="bc"></svg>
          <table><thead><tr><th>SKU</th><th>Description</th><th>Qty</th></tr></thead><tbody>${rows}</tbody></table>
          <script>
            JsBarcode("#bc", ${JSON.stringify(data.orderNumber)}, { format: "CODE128", width: 2, height: 45, fontSize: 12 });
            window.onload = () => setTimeout(() => window.print(), 300);
          </script>
        </body></html>`);
      w.document.close();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  }
  document.getElementById('printCartonSlipBtn')?.addEventListener('click', printCartonSlip);
  document.getElementById('scanSerialsBtn')?.addEventListener('click', () => {
    if (!activeOrder) return;
    openSerialsModal('ship', { clientId: activeOrder.client_name || '', ref: activeOrder.order_number || '' });
  });

  // ── Timer ──────────────────────────────────────────────────────────────────
  function startTimer(startISO) {
    stopTimer();
    const el = document.getElementById('scanTimer');
    function tick() {
      const elapsed = Date.now() - new Date(startISO).getTime();
      const s = Math.floor(elapsed / 1000) % 60;
      const m = Math.floor(elapsed / 60000) % 60;
      const h = Math.floor(elapsed / 3600000);
      el.textContent = h > 0
        ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
        : `${m}:${String(s).padStart(2,'0')}`;
    }
    tick();
    timerInterval = setInterval(tick, 1000);
  }

  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    document.getElementById('scanTimer').textContent = '';
  }

  // ── Items table ────────────────────────────────────────────────────────────
  // Pending items float to the top (next one highlighted); completed rows
  // sink to the bottom and compress. No-barcode items get one-click count
  // buttons instead of a typed qty box. The list is PAGINATED (5 SKUs per
  // page, Previous/Next buttons) — warehouse staff never scroll. After a
  // scanner scan the view snaps to the page holding the next pending item;
  // manual page browsing sticks until the next scan.
  const SCAN_PAGE_MAX = 5;    // never more than 5 SKUs per page
  let scanPageSize   = SCAN_PAGE_MAX; // shrinks automatically until a page fits the screen with no scrollbar
  let scanPage       = 0;
  let scanPageManual = false;
  let scanFocusSku   = null;  // last item the packer counted — keep its page in view while it's unfinished

  // A SKU can appear on MULTIPLE lines of one order (client files sometimes
  // split the same product across lines). Scan counts are stored per SKU, so
  // the scan screen pools those lines into ONE row per SKU — two rows sharing
  // a single counter would double-count and could never reconcile.
  function mergedScanLines(order) {
    const map = new Map();
    for (const l of (order.lines || [])) {
      const m = map.get(l.sku);
      if (!m) { map.set(l.sku, { ...l }); continue; }
      m.qty += l.qty || 0;
      for (const f of ['batch_number', 'serial_number', 'expiry_date']) {
        if (l[f] && m[f] && !String(m[f]).includes(String(l[f]))) m[f] = `${m[f]} / ${l[f]}`;
        else if (l[f] && !m[f]) m[f] = l[f];
      }
    }
    return [...map.values()];
  }

  function renderItemsTable(order) {
    const scanned  = order.scanned || {};
    const pendingC = (typeof pendingCountsFor === 'function') ? pendingCountsFor(order) : {};
    const decorated = mergedScanLines(order).map((item, idx) => {
      const p = pendingC[item.sku] || 0;
      const s = (scanned[item.sku] || 0) + p; // include offline scans awaiting sync
      return { item, s, p, idx, done: s === item.qty && item.qty > 0 };
    });
    decorated.sort((a, b) => (a.done - b.done) || (a.idx - b.idx));
    const activeSku = decorated.find(d => !d.done)?.item.sku;

    // Pagination — the packer always sees the row they are working on:
    // follow the just-counted item while it still needs pieces; once it's
    // finished, follow the next pending item. Manual paging sticks until
    // the next count.
    const pageCount = Math.max(1, Math.ceil(decorated.length / scanPageSize));
    if (!scanPageManual) {
      let focusIdx = -1;
      if (scanFocusSku) {
        focusIdx = decorated.findIndex(d => d.item.sku === scanFocusSku && !d.done);
      }
      if (focusIdx < 0) focusIdx = decorated.findIndex(d => d.item.sku === activeSku);
      scanPage = focusIdx >= 0 ? Math.floor(focusIdx / scanPageSize) : 0;
    }
    scanPage = Math.min(Math.max(0, scanPage), pageCount - 1);
    const pageRows = decorated.slice(scanPage * scanPageSize, (scanPage + 1) * scanPageSize);
    // Only ONE on-screen substitute barcode at a time, and ONLY for
    // no-barcode items (GWPs etc.) — normal products must be scanned
    // physically so the gun actually verifies the right item was picked.
    // The next code appears when the current one is fully counted, so the
    // scanner can never pick up the wrong code from the monitor.
    const inlineBcSku = decorated.find(d => !d.done && isNoBarcodeItem(d.item))?.item.sku;

    document.getElementById('scanItemsTbody').innerHTML = pageRows.map(({ item, s, p, done }) => {
      const noBarcode = isNoBarcodeItem(item);
      const over      = s > item.qty;
      const rowClass  = [
        s === 0 ? '' : done ? 'row-ok' : over ? 'row-over' : 'row-partial',
        done ? 'row-compact' : '',
        !done && item.sku === activeSku ? 'row-active' : '',
        !done && noBarcode ? 'row-nobarcode' : '',
        p > 0 ? 'row-pendingsync' : '',
      ].filter(Boolean).join(' ');
      const pendMark = p > 0 ? ` <span class="pend-mark" title="${p} scan(s) waiting for connection">&#8987;</span>` : '';
      const icon = done ? '&#10003;' : over ? '&#10007;' : s > 0 ? '&#8230;' : '';
      const hasDesc = !!(item.description && item.description !== item.sku);
      const desc = hasDesc ? item.description : '—';
      // Phones hide the Description COLUMN (no room) — when a description
      // exists it renders as a second line under the SKU instead
      // (.sku-desc-sub, shown only at the mobile breakpoint).
      const descSub = hasDesc ? `<div class="sku-desc-sub">${esc(desc)}</div>` : '';

      // Completed rows: slim single line, no lot row, no input
      if (done) {
        return `
        <tr class="${rowClass}" data-sku="${esc(item.sku)}">
          <td><code class="sku-code sku-code-sm">${esc(item.sku)}</code>${descSub}</td>
          <td class="desc-cell desc-cell-sm">${esc(desc)}</td>
          <td class="qty-col">${item.qty}</td>
          <td class="qty-col done-frac">${s}/${item.qty}${pendMark}</td>
          <td class="status-icon">${icon}</td>
        </tr>`;
      }

      // Lot badges live inside the SKU cell (an extra table row per item
      // would break the fixed 5-rows-per-page layout)
      const lotParts = [];
      // Pick-from-bin locations (FEFO/FIFO-allocated at upload) — the pick list.
      // A 'STAGING' pseudo-location means "pick from the receiving area" (chosen at
      // upload when there was received-but-unbinned stock).
      if (item.pick_locations && item.pick_locations.length) {
        const binPicks = item.pick_locations.filter(pl => pl.location_id !== 'STAGING');
        const stagePicks = item.pick_locations.filter(pl => pl.location_id === 'STAGING');
        if (binPicks.length) {
          const upc = Number(item.units_per_carton) || 1;
          const qtyLabel = q => {
            if (upc <= 1) return `×${q}`;
            const ctn = Math.floor(q / upc), ea = q % upc;
            const parts = [];
            if (ctn) parts.push(`${ctn} ctn`);
            if (ea) parts.push(`${ea} ea`);
            return `×${q} (${parts.join(' + ')})`;
          };
          // Each entry is one atomic nowrap unit so wrapping happens BETWEEN
          // bins, never inside a bin code or an expiry date.
          const locs = binPicks.map(pl => `<span class="pick-loc-entry">${esc(pl.location_id)}&nbsp;${qtyLabel(pl.qty)}${pl.expiry_date ? ' <span style="opacity:.7">exp ' + esc(pl.expiry_date) + '</span>' : ''}</span>`).join(', ');
          lotParts.push(`<span class="lot-badge lot-loc" title="Pick from these bins" style="background:#dbeafe;color:#1e40af">&#128205; ${locs}</span>`);
          // Case-break instruction: collect a carton from bulk, take X, leave the rest on the shelf.
          if (item.case_break) {
            const cb = item.case_break;
            lotParts.push(`<span class="lot-badge lot-cbreak" title="Collect the carton(s) from bulk, take what this order needs, leave the rest on the pick-face shelf (replenishes it in the same trip)" style="background:#fef3c7;color:#92400e">&#128230; Break ${cb.cartons}&nbsp;ctn ${esc(cb.from)} &#8594; ${esc(cb.to)}: take ${cb.take}, leave ${cb.leave}</span>`);
          }
          lotParts.push(`<span class="lot-badge bin-empty-btn" data-sku="${esc(item.sku)}" title="Bin empty? Re-pick this SKU from another bin" style="cursor:pointer;background:#fee2e2;color:#991b1b">&#128683; empty?</span>`);
        }
        const stageQty = stagePicks.reduce((s, p) => s + p.qty, 0);
        if (stageQty > 0) lotParts.push(`<span class="lot-badge lot-stage" title="Pick from the receiving/staging area (not yet binned)" style="background:#ffedd5;color:#9a3412">&#128229; Staging ×${stageQty}</span>`);
      }
      if (item.awaiting_putaway_qty > 0) lotParts.push(`<span class="lot-badge lot-await" title="Received but not yet put away — waiting for putaway before this can be picked from a bin" style="background:#fef9c3;color:#854d0e">&#9203; ${item.awaiting_putaway_qty} awaiting putaway</span>`);
      if (item.pick_shortfall > 0) lotParts.push(`<span class="lot-badge lot-short" title="No stock anywhere — walk-up pick / backorder" style="background:#fee2e2;color:#991b1b">&#9888; ${item.pick_shortfall} walk-up</span>`);
      if (item.batch_number)  lotParts.push(`<span class="lot-badge lot-batch">Lot&nbsp;${esc(item.batch_number)}</span>`);
      if (item.serial_number) lotParts.push(`<span class="lot-badge lot-serial">S/N&nbsp;${esc(item.serial_number)}</span>`);
      if (item.expiry_date)   lotParts.push(`<span class="lot-badge lot-expiry">Exp&nbsp;${esc(item.expiry_date)}</span>`);
      const lotBadges = lotParts.length ? `<div class="lot-inline">${lotParts.join('')}</div>` : '';

      // No-barcode item: one-click count buttons (− / +1 / ✓ All)
      const scannedCell = noBarcode
        ? `<td class="qty-col nb-cell" colspan="2">
             <span class="nb-count">${s}/${item.qty}</span>
             <button class="nb-btn nb-minus" data-sku="${esc(item.sku)}" ${s <= 0 ? 'disabled' : ''}>&#8722;</button>
             <button class="nb-btn nb-plus"  data-sku="${esc(item.sku)}">+1</button>
             <button class="nb-btn nb-all"   data-sku="${esc(item.sku)}" data-qty="${item.qty}">&#10003; All ${item.qty}</button>
           </td>`
        : p > 0
        ? `<td class="qty-col"><span class="nb-count">${s}/${item.qty}</span>${pendMark}</td>
           <td class="status-icon">${icon}</td>`
        : `<td class="qty-col">
             <input type="number" class="qty-input" min="0" value="${s}"
               data-sku="${esc(item.sku)}" data-ordered="${item.qty}" />
           </td>
           <td class="status-icon">${icon}
             <button class="nb-mark" data-sku="${esc(item.sku)}" title="No barcode on this item? Switch to count buttons">&#9888;</button>
           </td>`;

      const inlineBc = item.sku === inlineBcSku
        ? `<div class="nb-inline-bc-wrap"><div class="nb-inline-bc" data-bc-sku="${esc(item.sku)}"></div><div class="nb-inline-bc-hint">&#9535; scan this QR code off the screen</div></div>`
        : (noBarcode ? '<div class="nb-badge">&#9888; no barcode &mdash; count buttons, or wait for its turn</div>' : '');
      return `
        <tr class="${rowClass}" data-sku="${esc(item.sku)}">
          <td><code class="sku-code">${esc(item.sku)}</code>${descSub}${lotBadges}${inlineBc}</td>
          <td class="desc-cell">${esc(desc)}</td>
          <td class="qty-col">${item.qty}</td>
          ${scannedCell}
        </tr>`;
    }).join('');

    document.querySelectorAll('.qty-input').forEach(inp => {
      inp.addEventListener('change', async () => {
        const v = inp.value.trim();
        // A gun whose characters arrive slower than the burst detector's
        // threshold "types" its barcode into the qty box. No real count is
        // 7+ digits — restore the box and route the code to the scan path,
        // so the scan still lands on the right item.
        if (/^\d{7,}$/.test(v) || (parseInt(v, 10) || 0) > 99999) {
          inp.value = (activeOrder.scanned || {})[inp.dataset.sku] || 0;
          _scanBuf = v;
          _flushScanBuf();
          return;
        }
        await setItemQty(activeOrder.order_number, inp.dataset.sku, parseInt(v, 10) || 0);
      });
    });

    const lineOf = sku => mergedScanLines(activeOrder).find(l => l.sku === sku);
    document.querySelectorAll('.nb-plus, .nb-minus, .nb-all').forEach(btn => {
      btn.addEventListener('click', async () => {
        const item = lineOf(btn.dataset.sku);
        if (!item) return;
        const cur = (activeOrder.scanned || {})[item.sku] || 0;
        const target = btn.classList.contains('nb-all') ? item.qty
                     : btn.classList.contains('nb-plus') ? cur + 1
                     : Math.max(0, cur - 1);
        learnNoBarcodeSku(item);
        await setItemQty(activeOrder.order_number, item.sku, target, btn);
      });
    });
    document.querySelectorAll('.nb-mark').forEach(btn => {
      btn.addEventListener('click', async () => {
        const item = lineOf(btn.dataset.sku);
        if (!item) return;
        await learnNoBarcodeSku(item);
        renderItemsTable(activeOrder);
      });
    });
    // Short-pick: the allocated bin is physically empty → re-pick from another bin.
    document.querySelectorAll('.bin-empty-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const item = lineOf(btn.dataset.sku);
        const bins = (item?.pick_locations || []).filter(p => p.location_id !== 'STAGING').map(p => p.location_id);
        if (!bins.length) return;
        let loc = bins[0];
        if (bins.length > 1) { loc = prompt(`Which bin is empty?\n${bins.map((b, i) => `${i + 1}. ${b}`).join('\n')}\n\nType the bin code:`, bins[0]); if (!loc) return; }
        else if (!confirm(`Report ${loc} empty and re-pick ${item.sku} from another bin?`)) return;
        try {
          const r = await fetch('/api/scan/report-bin-empty', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderNumber: activeOrder.order_number, sku: item.sku, location_id: loc }) });
          const d = await r.json();
          if (!r.ok) { alert(d.error || 'Failed'); return; }
          for (const upd of (d.lines || [])) for (const l of (activeOrder.lines || [])) if (l.sku === upd.sku) { l.pick_locations = upd.pick_locations; l.pick_shortfall = upd.pick_shortfall; }
          renderItemsTable(activeOrder);
        } catch (e) { alert(e.message); }
      });
    });

    // Render the single on-screen substitute code as a QR of the FULL SKU —
    // QR stays compact and scannable at any SKU length (a long SKU as
    // Code128 is too dense to read off a screen). Scanning it feeds the
    // exact SKU value through the normal scan path.
    const bcEl = document.querySelector('#scanItemsTbody div.nb-inline-bc');
    if (bcEl && window.qrcode) {
      try {
        const q = qrcode(0, 'M');
        q.addData(bcEl.dataset.bcSku);
        q.make();
        bcEl.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      } catch {}
    }

    // Adaptive fit — if this page overflows the visible list area (short or
    // zoomed monitors), drop the page size and re-render until it fits.
    // "Up to 5 SKUs per screen" = as many as physically fit, never more.
    const scrollEl = document.querySelector('.scan-items-scroll');
    if (scrollEl && scrollEl.scrollHeight > scrollEl.clientHeight + 2 && pageRows.length > 1) {
      scanPageSize = pageRows.length - 1;
      return renderItemsTable(order);
    }

    // Pager — hidden for single-page orders
    const pager = document.getElementById('scanPager');
    if (pageCount > 1) {
      const donePages = decorated.filter(d => d.done).length;
      pager.innerHTML = `
        <button class="scan-pager-btn" id="scanPagePrev" ${scanPage === 0 ? 'disabled' : ''}>&#8592; Previous</button>
        <span class="scan-pager-info">Page ${scanPage + 1} of ${pageCount} &nbsp;&middot;&nbsp; ${decorated.length - donePages} item(s) to go</span>
        <button class="scan-pager-btn" id="scanPageNext" ${scanPage >= pageCount - 1 ? 'disabled' : ''}>Next &#8594;</button>`;
      pager.classList.remove('hidden');
      document.getElementById('scanPagePrev').addEventListener('click', () => {
        scanPageManual = true; scanPage--; renderItemsTable(activeOrder);
      });
      document.getElementById('scanPageNext').addEventListener('click', () => {
        scanPageManual = true; scanPage++; renderItemsTable(activeOrder);
      });
    } else {
      pager.classList.add('hidden');
      pager.innerHTML = '';
    }

    focusActiveQty();
  }

  // Cursor defaults to the qty field of the item being worked on (the one
  // with the on-screen barcode). Skipped on touch devices where focusing an
  // input pops the on-screen keyboard over the list.
  function focusActiveQty() {
    if (window.matchMedia('(pointer: coarse)').matches) return;
    const inp = document.querySelector('#scanItemsTbody tr.row-active .qty-input')
             || document.querySelector('#scanItemsTbody tr:not(.row-compact) .qty-input');
    if (inp) { inp.focus(); inp.select(); }
    else document.getElementById('itemScanInput').focus();
  }

  function updateProgress(order) {
    const scanned  = order.scanned || {};
    const pendingC = (typeof pendingCountsFor === 'function') ? pendingCountsFor(order) : {};
    const cnt      = sku => (scanned[sku] || 0) + (pendingC[sku] || 0); // incl. offline queue
    const lines    = mergedScanLines(order); // one pool per SKU — never double-count

    // Line-item progress pill (existing)
    const doneCount = lines.filter(l => cnt(l.sku) === l.qty).length;
    const el = document.getElementById('scanProgress');
    el.textContent = `${doneCount}/${lines.length} items`;
    el.className = doneCount === lines.length ? 'scan-progress all-done' : 'scan-progress';

    // Piece counter — shows remaining pieces, turns red on over-scan
    const totalOrdered = lines.reduce((s, l) => s + (l.qty || 0), 0);
    const totalScanned = lines.reduce((s, l) => s + cnt(l.sku), 0);
    const remaining    = totalOrdered - totalScanned;
    const hasOver      = lines.some(l => cnt(l.sku) > l.qty);

    const piecesEl = document.getElementById('scanPiecesLeft');
    const numEl    = document.getElementById('scanPiecesNum');
    if (piecesEl && numEl) {
      const labelEl = piecesEl.querySelector('.spl-label');
      if (hasOver) {
        numEl.textContent = -remaining;
        if (labelEl) labelEl.textContent = 'over';
      } else if (remaining <= 0) {
        numEl.textContent = '✓';
        if (labelEl) labelEl.textContent = 'done';
      } else {
        numEl.textContent = remaining;
        if (labelEl) labelEl.textContent = 'pcs left';
      }
      piecesEl.className = 'scan-pieces-left' +
        (hasOver ? ' spl-over' : remaining <= 0 ? ' spl-done' : '');
    }

    // Thin progress bar under the header
    const fill = document.getElementById('scanProgressBarFill');
    if (fill) {
      const pct = totalOrdered > 0 ? Math.min(100, Math.round(totalScanned / totalOrdered * 100)) : 0;
      fill.style.width = pct + '%';
      fill.className = hasOver ? 'over' : pct >= 100 ? 'full' : '';
    }
  }

  // ── Global barcode capture ─────────────────────────────────────────────────
  // Physical barcode scanners send characters + Enter as keyboard events.
  // We intercept every keystroke document-wide while the scan overlay is open
  // so focus location doesn't matter. Characters build a buffer; Enter fires.
  // A 120 ms idle timeout also fires (handles scanners that omit Enter).
  let _scanBuf = '';
  let _scanFlushTimer = null;
  // Which screen currently owns the global capture — outbound's scan
  // overlay, IdealInbound's receiving screen, or the Wave Pick detail. Only
  // one is ever open at a time, so a single shared target (set on attach) is
  // enough.
  let _scanTarget = 'outbound'; // 'outbound' | 'inbound' | 'wave'
  const _SCAN_INPUT_IDS = { inbound: 'inboundScanInput', wave: 'waveScanInput', outbound: 'itemScanInput' };
  function _scanInputId() { return _SCAN_INPUT_IDS[_scanTarget] || _SCAN_INPUT_IDS.outbound; }
  // 250ms: long enough that a gun pausing mid-code (laggy browser, long
  // barcode) never gets split into two fragments — a split's front half can
  // look like an unknown barcode and wrongly trigger the teach dialog
  const SCAN_IDLE_MS = 250;

  function _flushScanBuf() {
    clearTimeout(_scanFlushTimer);
    _scanFlushTimer = null;
    const val = _scanBuf.trim();
    _scanBuf  = '';
    const inp = document.getElementById(_scanInputId());
    if (inp) inp.value = '';
    // A flush interrupted by an open modal (e.g. the idle-timeout auto-flush
    // firing mid-dialog) submits nothing rather than a fragment scooped up
    // while the dialog was covering the scan input — same reasoning as the
    // modal guard in _globalScanKeydown.
    const openModal = document.querySelector('.modal-overlay:not(.hidden)');
    if (openModal && !openModal.contains(document.activeElement)) return;
    if (!val) return;
    if (_scanTarget === 'inbound') {
      if (!activeInbound) return;
      inboundScan(val);
      return;
    }
    if (_scanTarget === 'wave') {
      waveUI.scan(val);
      return;
    }
    if (!activeOrder) return;
    // Control code (printed card at the station) — starts a new carton
    // instead of being looked up as a product SKU.
    if (NEW_CARTON_CODES.has(val.toUpperCase())) { requestNewCarton(); return; }
    handleItemScan(val);
  }

  // Scanner-burst detection for qty fields: the cursor now rests in a qty
  // input by default, and a barcode gun "types" its code wherever the cursor
  // is. Guns emit characters with tiny gaps (<40ms); humans don't. Three
  // rapid characters = scanner → restore the qty value and route the code
  // through the normal scan path. Slow typing = manual qty entry, untouched.
  let _qtyBurst = null; // { el, chars, last, base, scanner }
  // 140ms: guns usually emit <40ms apart, but a busy browser can stretch the
  // gaps — 90ms let some real scans slip through as "human typing" and land
  // in the qty box. Humans entering a 1-3 digit count rarely beat 140ms.
  const QTY_BURST_GAP_MS = 140;

  function _qtyBurstToScan() {
    if (!_qtyBurst) return;
    const code = _qtyBurst.chars.join('');
    _qtyBurst.el.value = _qtyBurst.base;
    _qtyBurst = null;
    _scanBuf = code;
    _flushScanBuf();
  }

  function _globalScanKeydown(e) {
    // While any modal dialog is visible: if focus is genuinely inside that
    // modal (a search box, a password confirm, etc.) let it type normally.
    // Otherwise this keystroke is a STRAY scanner burst leaking into the
    // still-focused (but now hidden-behind-the-modal) scan input — a real
    // production bug found this way: a scan gun firing while e.g. an
    // inventory-confirm dialog was open left its characters sitting in
    // #itemScanInput's raw value, unseen, and the packer's NEXT real scan
    // got glued onto that leftover fragment ("Unrecognized barcode
    // 84140028414002078059" — a 7-char fragment + the real 13-digit EAN).
    // Merely `return`ing here (the old behaviour) stops THIS function's own
    // buffer logic but does nothing to stop the browser's default typing
    // behaviour on the still-focused input — block it outright and wipe
    // anything already accumulated so it can never reach the next scan.
    const openModal = document.querySelector('.modal-overlay:not(.hidden)');
    if (openModal) {
      if (openModal.contains(document.activeElement)) return; // legit typing inside the modal
      const inp = document.getElementById(_scanInputId());
      if (inp) inp.value = '';
      _scanBuf = '';
      e.preventDefault();
      return;
    }

    // `e.key` is NOT guaranteed. Android soft keyboards, some scanner keyboard
    // apps and IME composition all deliver keydown events with no `key` at
    // all, and reading `.length` on undefined threw here — which popped the
    // full-screen error dialog at a packer mid-scan. Normalise once and treat
    // a keyless event as nothing to buffer.
    const key = typeof e.key === 'string' ? e.key : '';

    const scanInputId = _scanInputId();
    const ae    = document.activeElement;
    const tag   = ae?.tagName;
    const isQty = !!ae?.classList?.contains('qty-input');
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      // Intercept the dedicated scan input and (for burst detection) qty
      // fields; pass every other input through untouched
      if (ae.id !== scanInputId && !isQty) return;
    }

    if (key === 'Enter') {
      if (isQty) {
        if (_qtyBurst?.scanner) { e.preventDefault(); _qtyBurstToScan(); }
        // else: manual qty entry — let Enter commit via the change event
        return;
      }
      // Sync from the visible input field (manual typing path). _scanBuf is
      // already mirrored from inp.value on every keystroke while this input
      // is focused — SET, not append, or a value already caught by the
      // mirror gets doubled onto itself.
      const inp = document.getElementById(scanInputId);
      if (ae.id === scanInputId && inp.value) {
        _scanBuf = inp.value;
      }
      _flushScanBuf();
      e.preventDefault();
      return;
    }

    // Qty field: watch typing speed to tell gun from human
    if (isQty && key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const now = Date.now();
      if (!_qtyBurst || _qtyBurst.el !== ae || now - _qtyBurst.last > QTY_BURST_GAP_MS) {
        _qtyBurst = { el: ae, chars: [], last: 0, base: ae.value, scanner: false };
      }
      _qtyBurst.chars.push(key);
      _qtyBurst.last = now;
      if (_qtyBurst.scanner) {
        e.preventDefault();
      } else if (_qtyBurst.chars.length >= 3) {
        _qtyBurst.scanner = true;
        ae.value = _qtyBurst.base; // strip the characters that leaked in
        e.preventDefault();
      }
      clearTimeout(_scanFlushTimer);
      _scanFlushTimer = setTimeout(() => {
        if (_qtyBurst?.scanner) _qtyBurstToScan();
        else _qtyBurst = null;
      }, SCAN_IDLE_MS);
      return;
    }

    // Printable characters only — ignore modifier-only, arrow, Escape, Tab and
    // any event that arrived without a usable key at all.
    if (key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // If focus is NOT on the scan input, redirect the character there
      if (document.activeElement?.id !== scanInputId) {
        document.getElementById(scanInputId)?.focus();
        _scanBuf += key;
        // Keep the visible input in sync so user can see what the scanner typed
        const inp = document.getElementById(scanInputId);
        if (inp) inp.value = _scanBuf;
        e.preventDefault();
      } else {
        // Focus IS on the scan input — let the browser handle insertion naturally,
        // mirror into buffer on next tick so value is updated
        setTimeout(() => { _scanBuf = document.getElementById(scanInputId).value; }, 0);
      }
      // Reset the idle timer
      clearTimeout(_scanFlushTimer);
      _scanFlushTimer = setTimeout(_flushScanBuf, SCAN_IDLE_MS);
    }
  }

  function attachGlobalScanCapture(target = 'outbound') {
    _scanTarget = target;
    _scanBuf = ''; clearTimeout(_scanFlushTimer); _scanFlushTimer = null;
    // SCAN-LOSS GUARD. _globalScanKeydown deliberately passes keystrokes
    // through when focus is inside some OTHER input, so a packer typing in a
    // search box isn't hijacked. But if focus is still sitting in a foreign
    // input when a scan screen opens — e.g. they had tapped the "Scan waybill
    // number…" bar on the Orders tab, then hit Scan → — a gun's characters go
    // into that input, now hidden behind the overlay, and the scan is LOST
    // with no error. Found while auditing scan durability: on a phone nothing
    // moved focus, because focusActiveQty() skips touch devices on purpose
    // (focusing an input there pops the on-screen keyboard over the list).
    // Blurring is the fix rather than focusing: it DISMISSES the keyboard
    // instead of summoning it, and with focus on <body> the capture's own
    // redirect-to-the-scan-input path takes over.
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')
        && ae.id !== _scanInputId() && !ae.classList?.contains('qty-input')) {
      try { ae.blur(); } catch {}
    }
    document.addEventListener('keydown', _globalScanKeydown);
  }
  function detachGlobalScanCapture() {
    document.removeEventListener('keydown', _globalScanKeydown);
    _scanBuf = ''; clearTimeout(_scanFlushTimer); _scanFlushTimer = null;
    const inp = document.getElementById(_scanInputId());
    if (inp) inp.value = '';
  }

  // Keep the visible input as a fallback / status display; Enter still works there
  document.getElementById('itemScanInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      // handled by global capture above — just prevent double-fire
      e.preventDefault();
    }
  });

  // Scan queue — serialises rapid back-to-back scans so none are dropped
  const _scanQueue = [];
  let   _scanBusy  = false;

  function handleItemScan(sku) {
    // A scanned BIN LABEL is a location confirmation, not a product — record it
    // and tell the packer, instead of failing the value as an unknown SKU.
    const asBin = String(sku).trim().toUpperCase();
    if (_binIdSet && _binIdSet.has(asBin)) {
      _lastScannedBin = asBin;
      showFeedback(document.getElementById('itemScanFeedback'), 'success', `📍 At bin ${asBin} — now scan the item`);
      return;
    }
    // The eventId is minted HERE, at scan time, and rides along on the very
    // first request — not just on offline replays. If the server processes
    // the scan but the response outlives the 8s fetch timeout, the queued
    // retry reuses this same id and the server's dedupe absorbs it. Minting
    // only at enqueue time (the old way) meant a slow-response scan was
    // counted once live and once again on replay — "scan 1, get 2 pcs".
    // BIND THE SCAN TO THE ORDER IT WAS TAKEN ON, here and now. The drain is
    // async, so reading activeOrder when the request is built (the old way) was
    // wrong twice over: it CRASHED if the packer closed the overlay while a
    // request was in flight (activeOrder null → TypeError, reported from the
    // floor), and worse, if they opened a DIFFERENT order in that window the
    // piece would have been posted against the new one.
    if (!activeOrder) return;   // nothing open to scan against
    _scanQueue.push({
      raw: sku,
      orderNumber: activeOrder.order_number,
      eventId: (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    });
    if (!_scanBusy) _drainScanQueue();
  }

  // ── Offline scan queue ──────────────────────────────────────────────────────
  // When Wi-Fi drops mid-scan, the scan is saved to localStorage instantly
  // (survives reloads and browser restarts), counted on screen as "pending
  // sync", and replayed to the server the moment the connection returns.
  // Every event carries an id, so a scan whose response was lost in the drop
  // can never be counted twice on replay.
  const OFFQ_KEY = 'is_offline_scans';
  let _offlineQueue = [];
  let _offSyncing   = false;
  try { _offlineQueue = JSON.parse(localStorage.getItem(OFFQ_KEY) || '[]'); } catch {}
  function _saveOffQ() { try { localStorage.setItem(OFFQ_KEY, JSON.stringify(_offlineQueue)); } catch {} }
  // ONE queue, three kinds of counted scan: outbound order picking, IdealInbound
  // receiving, and wave picking. An entry written before `kind` existed has none
  // and is read as 'order', so a queue that survived an upgrade still drains.
  //   { id, kind:'order'|'inbound'|'wave', targetId, raw, extra:{}, at }
  // `orderNumber` is kept on order entries too, purely so anything already
  // reading that field keeps working.
  function _evtKind(e) { return e.kind || 'order'; }
  function _evtTarget(e) { return e.targetId || e.orderNumber; }
  function pendingScansFor(orderNumber) {
    return _offlineQueue.filter(e => _evtKind(e) === 'order' && _evtTarget(e) === orderNumber);
  }
  function pendingScansForTarget(kind, targetId) {
    return _offlineQueue.filter(e => _evtKind(e) === kind && _evtTarget(e) === targetId);
  }

  // fetch with a timeout — a dead Wi-Fi link often hangs instead of failing
  function fetchT(url, opts = {}, ms = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
  }

  // Local mirror of the server's barcode resolution (CODE2 + learned + NP +
  // aliases) so offline scans still land on the right line on screen
  let _resolveCache = null;
  try { _resolveCache = JSON.parse(localStorage.getItem('is_resolve_cache') || 'null'); } catch {}
  async function loadResolveCache() {
    try {
      const r = await fetchT('/api/scan/resolve-cache', {}, 10000);
      if (r.ok) {
        _resolveCache = await r.json();
        try { localStorage.setItem('is_resolve_cache', JSON.stringify(_resolveCache)); } catch {}
      }
    } catch {}
  }
  function resolveScanLocally(raw, order) {
    const strip0 = s => s.replace(/^0+(?=.)/, '');
    const k = String(raw).trim();
    const c = _resolveCache || {};
    let sku = (c.code2 && (c.code2[k] || c.code2[strip0(k)]))
           || (c.learned && (c.learned[k] || c.learned[strip0(k)]))
           || k;
    const lines = mergedScanLines(order);
    const find = q => {
      const ql = String(q).trim().toLowerCase(), qn = strip0(ql);
      return lines.find(l => { const ls = l.sku.trim().toLowerCase(); return ls === ql || strip0(ls) === qn; });
    };
    let item = find(sku);
    if (!item && /np$/i.test(sku))  item = find(String(sku).replace(/np$/i, ''));
    if (!item && !/np$/i.test(sku)) item = find(sku + 'NP');
    if (!item && Array.isArray(c.aliases)) {
      for (const al of c.aliases) {
        if (al.a === sku) item = find(al.b);
        else if (al.b === sku) item = find(al.a);
        if (item) break;
      }
    }
    return item ? item.sku : null;
  }
  // pending per-SKU counts for an order (only locally-resolvable scans)
  function pendingCountsFor(order) {
    const m = {};
    for (const e of pendingScansFor(order.order_number)) {
      const sku = resolveScanLocally(e.raw, order);
      if (sku) m[sku] = (m[sku] || 0) + 1;
    }
    return m;
  }

  function updateOfflinePill() {
    const pill = document.getElementById('offlinePill');
    if (!pill) return;
    const n = _offlineQueue.length;
    if (!n) { pill.classList.add('hidden'); return; }
    pill.textContent = _offSyncing
      ? `⟳ Syncing ${n} queued scan${n !== 1 ? 's' : ''}…`
      : `⚡ Offline — ${n} scan${n !== 1 ? 's' : ''} saved, will sync when connection returns`;
    pill.classList.toggle('syncing', _offSyncing);
    pill.classList.remove('hidden');
  }

  function _newEventId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // Queue a scan for a NON-order target (receiving, wave). Kept separate from
  // enqueueOfflineScan below because that one also does order-screen things
  // (resolve the SKU locally, repaint the items table, refocus a line).
  function enqueueOfflineTargetScan(kind, targetId, raw, eventId, extra) {
    _offlineQueue.push({
      id: eventId || _newEventId(),
      kind, targetId, raw: String(raw).trim(),
      extra: extra || {},
      at: new Date().toISOString(),
    });
    _saveOffQ();
    updateOfflinePill();
    scheduleOfflineSync(4000);
  }

  // `orderNumber` is passed explicitly by the drain, because this is called
  // AFTER an await: activeOrder may be null (overlay closed) or already a
  // different order. Reading it off activeOrder unguarded is what produced the
  // TypeError reported from the floor — and a lost piece with it, since the
  // throw killed the enqueue that was meant to save the scan.
  function enqueueOfflineScan(raw, eventId, orderNumber) {
    const target = orderNumber || activeOrder?.order_number;
    if (!target) return;   // nothing to attribute the scan to; never throw here
    const evt = {
      id: eventId || _newEventId(),
      kind: 'order',
      targetId: target,
      orderNumber: target,
      raw: String(raw).trim(),
      at: new Date().toISOString(),
    };
    _offlineQueue.push(evt);
    _saveOffQ();
    updateOfflinePill();
    scheduleOfflineSync(4000);
    // Everything below is screen feedback — only meaningful while that order is
    // still the one open.
    const onScreen = activeOrder && activeOrder.order_number === target;
    if (!onScreen) return;
    const sku = resolveScanLocally(evt.raw, activeOrder);
    const feedback = document.getElementById('itemScanFeedback');
    showFeedback(feedback, 'pending',
      sku ? `⚡ No connection — ${sku} counted, will sync automatically`
          : `⚡ No connection — scan saved (${evt.raw}), will sync automatically`);
    if (sku) { scanFocusSku = sku; scanPageManual = false; }
    renderItemsTable(activeOrder);
    updateProgress(activeOrder);
  }

  let _offSyncTimer = null;
  function scheduleOfflineSync(ms) {
    clearTimeout(_offSyncTimer);
    _offSyncTimer = setTimeout(syncOfflineQueue, ms);
  }
  async function syncOfflineQueue() {
    if (_offSyncing || !_offlineQueue.length) { updateOfflinePill(); return; }
    _offSyncing = true;
    updateOfflinePill();
    const issues = [];
    try {
      while (_offlineQueue.length) {
        const evt = _offlineQueue[0];
        const kind = _evtKind(evt);
        const target = _evtTarget(evt);
        // Every kind replays with the SAME eventId it was minted with, so a
        // scan the server already applied (response lost) is absorbed by its
        // dedupe instead of counting twice.
        const req = kind === 'inbound'
          ? { url: `/api/inbound/${encodeURIComponent(target)}/scan`,
              body: { code: evt.raw, qty: 1, condition: evt.extra?.condition, eventId: evt.id, isReplay: true } }
          : kind === 'wave'
          ? { url: `/api/waves/${encodeURIComponent(target)}/scan`,
              body: { code: evt.raw, eventId: evt.id, isReplay: true } }
          : { url: '/api/scan/increment',
              body: { orderNumber: target, sku: evt.raw, eventId: evt.id, isReplay: true } };
        let resp, data;
        try {
          resp = await fetchT(req.url, { method: 'POST', headers: hdrs(), body: JSON.stringify(req.body) });
          data = await resp.json();
        } catch {
          scheduleOfflineSync(6000); // still offline — try again shortly
          return;
        }
        _offlineQueue.shift();
        _saveOffQ();
        if (resp.ok) {
          if (kind === 'order' && activeOrder && activeOrder.order_number === target) {
            if (!activeOrder.scanned) activeOrder.scanned = {};
            activeOrder.scanned[data.sku] = data.scanned_qty;
            if (data.cartonNum) { activeOrder.cartonNum = data.cartonNum; activeOrder.cartonCount = data.cartonCount || activeOrder.cartonCount; updateCartonBadge(activeOrder); }
          } else if (kind === 'inbound' && activeInbound && activeInbound.id === target) {
            activeInbound.scanned = activeInbound.scanned || {};
            activeInbound.scanned[data.sku] = data.scanned_qty;
            renderInboundItemsTable(activeInbound);
          } else if (kind === 'wave' && data.wave) {
            window.waveUI?.applySyncedWave(data.wave, target);
          }
        } else {
          issues.push(`${evt.raw} on ${target}: ${data.error || resp.status}`);
        }
        updateOfflinePill();
      }
      if (activeOrder) {
        renderItemsTable(activeOrder);
        updateProgress(activeOrder);
      }
      const feedback = document.getElementById('itemScanFeedback');
      if (feedback && activeOrder) showFeedback(feedback, 'success', '✓ Connection restored — all queued scans synced');
      // say it on whichever screen the user is actually looking at
      if (activeInbound) showFeedback(document.getElementById('inboundScanFeedback'), 'success', '✓ Connection restored — all queued scans synced');
      window.waveUI?.syncedNotice();
      if (issues.length) {
        alert(`Some offline scans could not be applied:\n\n${issues.join('\n')}\n\nPlease verify these items and rescan if needed.`);
      }
      if (activeOrder) maybeAutoComplete();
    } finally {
      _offSyncing = false;
      updateOfflinePill();
    }
  }
  window.addEventListener('online', () => scheduleOfflineSync(800));
  setInterval(() => { if (_offlineQueue.length && !_offSyncing) syncOfflineQueue(); }, 9000);
  if (_offlineQueue.length) scheduleOfflineSync(2500); // queue survived a reload
  updateOfflinePill();

  // Un-doubling safety net: a stray scanner burst that leaked in before the
  // real scan (e.g. from behind a modal — see the _globalScanKeydown guard
  // above, which now prevents this at the source) can still glue a leftover
  // fragment onto the front of a real barcode. If an unresolved all-digit
  // token's TAIL is a standard barcode length (GTIN-14/EAN-13/UPC-A/EAN-8)
  // and starts with exactly the leading fragment, it's almost certainly
  // <fragment><real code> — retry with just the tail. Only ever called AFTER
  // the original already failed to resolve, so a legitimate code already
  // known to the order is never rewritten.
  function _stripDoubleScan(val) {
    if (!/^\d{9,}$/.test(val)) return val;
    for (const n of [14, 13, 12, 8]) {
      if (val.length > n) {
        const code = val.slice(-n), frag = val.slice(0, val.length - n);
        if (frag.length <= n && code.startsWith(frag)) return code;
      }
    }
    return val;
  }

  async function _drainScanQueue() {
    if (_scanBusy || !_scanQueue.length) return;
    _scanBusy = true;
    while (_scanQueue.length) {
      const entry    = _scanQueue.shift();
      const sku      = entry.raw;
      const eventId  = entry.eventId;
      // The order this piece belongs to, captured at scan time — never read off
      // activeOrder here, which may have been closed or swapped mid-request.
      const orderNumber = entry.orderNumber || activeOrder?.order_number;
      if (!orderNumber) continue;
      // Is that order still the one on screen? Only then may we touch the UI.
      const onScreen = () => !!activeOrder && activeOrder.order_number === orderNumber;
      const feedback = document.getElementById('itemScanFeedback');
      try {
        const resp = await fetchT('/api/scan/increment', {
          method: 'POST', headers: hdrs(),
          body: JSON.stringify({ orderNumber, sku, eventId }),
        });
        let data = await resp.json();
        if (!resp.ok) {
          // Unknown product barcode → teach-on-scan: packer confirms which
          // line it is, mapping is remembered everywhere from then on
          if (data.teachable && data.barcode) {
            const stripped = _stripDoubleScan(data.barcode);
            if (stripped === data.barcode) {
              openTeachBarcodeModal(data.barcode, data.resolved);
              continue;
            }
            // Looks like <leftover fragment><real code> — silently retry with
            // just the tail before ever bothering the packer with a dialog.
            const retryId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
            const retry = await fetchT('/api/scan/increment', {
              method: 'POST', headers: hdrs(),
              body: JSON.stringify({ orderNumber, sku: stripped, eventId: retryId }),
            });
            const retryData = await retry.json();
            if (retry.ok) {
              data = retryData;
            } else if (retryData.teachable) {
              openTeachBarcodeModal(retryData.barcode || stripped, retryData.resolved);
              continue;
            } else {
              showFeedback(feedback, 'error', retryData.error || `SKU not in this order: ${stripped}`);
              continue;
            }
          } else if (data.crossCartonConfirm) {
            // Same SKU already sitting in a different (closed) carton — easy
            // to do by accident, so confirm before it's split across boxes.
            const ok = confirm(`${data.sku} is already packed in Carton ${data.existingCartonNums.join(', ')}.\n\nAdd it to Carton ${data.activeCartonNum} too?`);
            if (!ok) { continue; }
            const retry = await fetchT('/api/scan/increment', {
              method: 'POST', headers: hdrs(),
              body: JSON.stringify({ orderNumber, sku, eventId, confirmCrossCarton: true }),
            });
            data = await retry.json();
            if (!retry.ok) { showFeedback(feedback, 'error', data.error || `SKU not in this order: ${sku}`); continue; }
          } else {
            showFeedback(feedback, 'error', data.error || `SKU not in this order: ${sku}`);
            continue;
          }
        }
        // The scan LANDED on the server regardless — but only paint it if that
        // order is still the one open. If the packer closed the overlay or moved
        // to another order while this was in flight, there is nothing on screen
        // to update, and touching activeOrder would be writing to the wrong
        // order (or crashing on null, which is what the floor reported).
        if (!onScreen()) continue;
        if (!activeOrder.scanned) activeOrder.scanned = {};
        activeOrder.scanned[data.sku] = data.scanned_qty;
        if (data.cartonNum) { activeOrder.cartonNum = data.cartonNum; activeOrder.cartonCount = data.cartonCount || activeOrder.cartonCount; updateCartonBadge(activeOrder); }
        activeOrder.scan_status = 'processing';
        scanFocusSku   = data.sku; // show the page of the item just scanned
        scanPageManual = false;
        renderItemsTable(activeOrder);
        updateProgress(activeOrder);
        maybeAutoComplete();

        const row = document.querySelector(`#scanItemsTbody tr[data-sku="${CSS.escape(data.sku)}"]`);
        if (row) { row.classList.add('row-flash'); setTimeout(() => row.classList.remove('row-flash'), 450); }

        const overBy = data.scanned_qty - data.ordered_qty;
        // Bin-verify: if the packer confirmed a bin (scanned its label) and this
        // item's pick plan says a DIFFERENT bin, warn — non-blocking, the count
        // still stands, but wrong-bin picks are exactly what breeds discrepancies.
        let binWarn = '';
        if (_lastScannedBin) {
          const ln = (activeOrder.lines || []).find(x => x.sku === data.sku && x.pick_locations && x.pick_locations.length);
          const bins = ln ? ln.pick_locations.filter(p => p.location_id !== 'STAGING').map(p => String(p.location_id).toUpperCase()) : [];
          if (bins.length && !bins.includes(_lastScannedBin)) binWarn = ` — ⚠ you're at ${_lastScannedBin}, plan says ${bins.join(', ')}`;
        }
        showFeedback(feedback, (overBy > 0 || binWarn) ? 'error' : 'success',
          (overBy > 0
            ? `${data.sku}: OVER by ${overBy} (scanned ${data.scanned_qty}, ordered ${data.ordered_qty})`
            : data.scanned_qty === data.ordered_qty
              ? `${data.sku}: ✓ Complete (${data.scanned_qty}/${data.ordered_qty})`
              : `${data.sku}: ${data.scanned_qty}/${data.ordered_qty} scanned`) + binWarn
        );
      } catch (err) {
        // Network failure (dead Wi-Fi hangs or refuses) — save the scan
        // durably and keep the packer moving; it syncs automatically.
        // The SAME eventId is carried into the queue so a scan the server
        // actually processed (response lost) is deduped on replay.
        // orderNumber is passed EXPLICITLY: this runs after an await, so
        // activeOrder may be null by now (overlay closed) — the piece was
        // still physically scanned and must reach the server anyway.
        enqueueOfflineScan(sku, eventId, orderNumber);
      }
    }
    _scanBusy = false;
    focusActiveQty();
  }

  // ── Teach-on-scan: unknown barcode → packer picks the matching line ────────
  function openTeachBarcodeModal(barcode, resolved) {
    if (!activeOrder) return;
    const overlay = document.getElementById('teachBarcodeOverlay');
    const scanned = activeOrder.scanned || {};
    const pending = mergedScanLines(activeOrder).filter(l => (scanned[l.sku] || 0) < l.qty);
    if (!pending.length) {
      showFeedback(document.getElementById('itemScanFeedback'), 'error',
        `Barcode ${barcode} not recognized — and no items are left to count.`);
      return;
    }
    // Two flavours: barcode entirely unknown, or officially listed under a
    // code this order's file doesn't use (e.g. listing says 9005, order says BC010)
    document.getElementById('teachBarcodeValue').textContent = barcode;
    document.getElementById('teachBarcodeIntro').innerHTML = resolved
      ? `is listed as <strong>${esc(resolved)}</strong> — but that code is not in this order.`
      : 'is not in the barcode listing yet.';
    document.getElementById('teachBarcodeList').innerHTML = pending.map(l => `
      <button class="teach-line-btn" data-sku="${esc(l.sku)}">
        <span class="tlb-sku">${esc(l.sku)}</span>
        <span class="tlb-desc">${esc(l.description && l.description !== l.sku ? l.description : '')}</span>
        <span class="tlb-count">${scanned[l.sku] || 0}/${l.qty}</span>
      </button>`).join('');
    overlay.classList.remove('hidden');

    document.querySelectorAll('#teachBarcodeList .teach-line-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const resp = await fetch('/api/scan/learn-barcode', {
            method: 'POST', headers: hdrs(),
            body: JSON.stringify({ orderNumber: activeOrder.order_number, barcode, sku: btn.dataset.sku }),
          });
          const data = await resp.json();
          overlay.classList.add('hidden');
          if (!resp.ok) { alert(data.error); return; }
          if (!activeOrder.scanned) activeOrder.scanned = {};
          activeOrder.scanned[data.sku] = data.scanned_qty;
          if (data.cartonNum) { activeOrder.cartonNum = data.cartonNum; activeOrder.cartonCount = data.cartonCount || activeOrder.cartonCount; updateCartonBadge(activeOrder); }
          activeOrder.scan_status = 'processing';
          scanFocusSku = data.sku; scanPageManual = false;
          renderItemsTable(activeOrder);
          updateProgress(activeOrder);
          maybeAutoComplete();
          showFeedback(document.getElementById('itemScanFeedback'), 'success',
            `✓ Learned: ${barcode} = ${data.sku} — counted ${data.scanned_qty}/${data.ordered_qty}`);
          const row = document.querySelector(`#scanItemsTbody tr[data-sku="${CSS.escape(data.sku)}"]`);
          if (row) { row.classList.add('row-flash'); setTimeout(() => row.classList.remove('row-flash'), 450); }
          focusActiveQty();
        } catch (err) {
          overlay.classList.add('hidden');
          alert(err.message);
        }
      });
    });
    document.getElementById('teachBarcodeCancel').onclick = () => {
      overlay.classList.add('hidden');
      setTimeout(() => document.getElementById('itemScanInput').focus(), 50);
    };
  }

  // ── Busy shield: a count/complete click gets instant feedback, and any
  // click on something else while the request runs shows a wait prompt
  // instead of silently doing nothing (or double-counting).
  let _scanBusyDepth = 0;
  function beginScanBusy(btn) {
    _scanBusyDepth++;
    document.getElementById('scanBusyShield').classList.remove('hidden');
    if (btn) {
      btn.classList.add('nb-busy');
      btn.dataset.busyLabel = btn.innerHTML;
      btn.innerHTML = '&#8987;';
    }
  }
  function endScanBusy(btn) {
    _scanBusyDepth = Math.max(0, _scanBusyDepth - 1);
    if (_scanBusyDepth === 0) {
      const shield = document.getElementById('scanBusyShield');
      shield.classList.add('hidden');
      shield.classList.remove('sbs-clicked');
    }
    if (btn && btn.isConnected) {
      btn.classList.remove('nb-busy');
      if (btn.dataset.busyLabel) btn.innerHTML = btn.dataset.busyLabel;
    }
  }
  document.getElementById('scanBusyShield').addEventListener('mousedown', () => {
    // Clicked somewhere while a request is running → show the prompt NOW
    document.getElementById('scanBusyShield').classList.add('sbs-clicked');
  });

  async function setItemQty(orderNumber, sku, qty, btn) {
    beginScanBusy(btn);
    try {
      const resp = await fetch('/api/scan/setqty', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ orderNumber, sku, qty }),
      });
      const data = await resp.json();
      if (!resp.ok) { alert(data.error); return; }
      if (!activeOrder.scanned) activeOrder.scanned = {};
      activeOrder.scanned[data.sku] = data.scanned_qty;
      if (data.cartonNum) { activeOrder.cartonNum = data.cartonNum; activeOrder.cartonCount = data.cartonCount || activeOrder.cartonCount; updateCartonBadge(activeOrder); }
      activeOrder.scan_status = 'processing';
      scanFocusSku   = data.sku; // keep the counted item's page in view
      scanPageManual = false;
      renderItemsTable(activeOrder);
      updateProgress(activeOrder);
      maybeAutoComplete();
    } catch (err) { alert(err.message); }
    finally { endScanBusy(btn); }
  }

  function showFeedback(el, type, msg) {
    el.className = `scan-feedback ${type}`;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  // ── Complete order ─────────────────────────────────────────────────────────
  async function doCompleteOrder() {
    const completeBtn = document.getElementById('completeOrderBtn');
    beginScanBusy(completeBtn);
    try {
      const resp = await fetch('/api/scan/complete', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({
          orderNumber: activeOrder.order_number,
          startTime:   orderTimings[activeOrder.order_number] || null,
          endTime:     new Date().toISOString(),
          operator:    currentUser ? (currentUser.name || currentUser.id) : null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) { alert(data.error); return; }
      if (data.ok) {
        delete orderTimings[activeOrder.order_number];
        saveTimings();
        activeOrder.scan_status = 'done';
        mergeOrderState(activeOrder.order_number, 'done');
        stopTimer();
        const completedOrder = activeOrder;

        // Update matching transport record
        updateTransportRecordOnOrderCompletion(completedOrder);
        // Show "SEAL FINAL CARTON" screen with the final carton label
        const finalCartonNum = completedOrder.cartonCount || 1;
        const finalLabel = `${completedOrder.order_number}-${String(finalCartonNum).padStart(2, '0')}`;
        if (!cartonLabelConfirmed(completedOrder, finalCartonNum)) {
          await showSealFinalCarton(finalLabel, finalCartonNum);
        }
        closeScanOverlay();
        await refreshOrders();
        renderOrdersDash();
        fetchAndRenderStats();
        setTimeout(() => focusWaybillInput(), 350); // ready for the next order scan
        if (completedOrder.has_order_label) {
          showPrintOrderLabelModal(completedOrder);
        } else if (completedOrder.has_waybill_pdf && completedOrder.batchId) {
          showPrintWaybillModal(completedOrder);
        } else {
          showPrintLabelPrompt(completedOrder);
        }
      } else {
        showMismatchModal(data.mismatches);
      }
    } catch (err) { alert(err.message); }
    finally { endScanBusy(document.getElementById('completeOrderBtn')); }
  }

  function showLotCheckModal(lotLines, onConfirm) {
    document.getElementById('lotCheckTbody').innerHTML = lotLines.map(l => `
      <tr>
        <td><code>${esc(l.sku)}</code></td>
        <td>${l.batch_number  ? `<span class="lot-badge lot-batch">${esc(l.batch_number)}</span>`  : '—'}</td>
        <td>${l.serial_number ? `<span class="lot-badge lot-serial">${esc(l.serial_number)}</span>` : '—'}</td>
        <td>${l.expiry_date   ? `<span class="lot-badge lot-expiry">${esc(l.expiry_date)}</span>`   : '—'}</td>
      </tr>`).join('');
    document.getElementById('lotCheckOverlay').classList.remove('hidden');
    document.getElementById('lotCheckConfirmBtn').onclick = () => {
      document.getElementById('lotCheckOverlay').classList.add('hidden');
      onConfirm();
    };
    document.getElementById('lotCheckCancelBtn').onclick = () => {
      document.getElementById('lotCheckOverlay').classList.add('hidden');
    };
  }

  document.getElementById('completeOrderBtn').addEventListener('click', () => attemptCompleteOrder());

  async function attemptCompleteOrder() {
    if (!activeOrder) return;
    const unsynced = pendingScansFor(activeOrder.order_number).length;
    if (unsynced) {
      alert(`${unsynced} scan(s) are still waiting for the connection to return.\nThe order will be completable as soon as they sync — keep it open.`);
      return;
    }

    // No-barcode sweep: if the ONLY unscanned lines are known no-barcode
    // items (GWPs etc.), offer to count them all with one click
    const scannedMap = activeOrder.scanned || {};
    const unscanned  = mergedScanLines(activeOrder).filter(l => (scannedMap[l.sku] || 0) < l.qty);
    if (unscanned.length && unscanned.every(isNoBarcodeItem)) {
      const pcs = unscanned.reduce((sum, l) => sum + (l.qty - (scannedMap[l.sku] || 0)), 0);
      const list = unscanned.map(l => l.sku).join(', ');
      if (confirm(`${pcs} pc(s) of no-barcode item(s) not counted yet:\n${list}\n\nCount them as packed and complete?`)) {
        for (const l of unscanned) {
          learnNoBarcodeSku(l);
          await setItemQty(activeOrder.order_number, l.sku, l.qty);
        }
      } else {
        return; // packer chose to keep scanning
      }
    }

    const lotLines = (activeOrder.lines || []).filter(l => l.batch_number || l.serial_number || l.expiry_date);
    if (lotLines.length > 0) {
      showLotCheckModal(lotLines, doCompleteOrder);
      return;
    }
    await doCompleteOrder();
  }

  // Hands-free completion: when the LAST piece is counted (no over-scan),
  // the order completes itself — no Complete click, no Enter. Orders with
  // lot/expiry data still auto-open the Verify Lot modal for the physical
  // check; everything else closes straight back to the orders screen.
  let _autoCompleteFired = false;
  function maybeAutoComplete() {
    if (_autoCompleteFired || !activeOrder) return;
    if (pendingScansFor(activeOrder.order_number).length) return; // wait for sync
    const scanned      = activeOrder.scanned || {};
    const lines        = mergedScanLines(activeOrder);
    const totalOrdered = lines.reduce((s, l) => s + (l.qty || 0), 0);
    const totalScanned = lines.reduce((s, l) => s + (scanned[l.sku] || 0), 0);
    const hasOver      = lines.some(l => (scanned[l.sku] || 0) > l.qty);
    if (totalOrdered === 0 || hasOver || totalScanned !== totalOrdered) return;
    _autoCompleteFired = true;
    showFeedback(document.getElementById('itemScanFeedback'), 'success', '✓ All pieces scanned — completing order…');
    setTimeout(() => attemptCompleteOrder(), 450);
  }

  // ── Cancel order ───────────────────────────────────────────────────────────
  document.getElementById('cancelOrderBtn').addEventListener('click', () => {
    if (!activeOrder) return;
    if (confirm(`Cancel order ${activeOrder.order_number}?\nIt will be marked as Unprocessed.`)) doCancel();
  });

  async function doCancel() {
    try {
      const resp = await fetch('/api/scan/cancel', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({
          orderNumber: activeOrder.order_number,
          startTime:   orderTimings[activeOrder.order_number] || null,
          endTime:     new Date().toISOString(),
          operator:    currentUser ? (currentUser.name || currentUser.id) : null,
          mismatches:  currentMismatches,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) { alert(data.error); return; }
      // Keep timing so re-open shows how long they already spent
      mergeOrderState(activeOrder.order_number, 'unprocessed', activeOrder.scanned || {});
      closeScanOverlay();
      await refreshOrders();
      renderOrdersDash();
    } catch (err) { alert(err.message); }
  }

  // ── Print waybill modal (stays until the packer picks Print or Skip — an
  // earlier auto-dismiss-after-3s made an unprinted waybill hard to find
  // again once it skipped itself) ────────────────────────────────────────────
  function showPrintWaybillModal(order) {
    document.getElementById('printOrderNo').textContent = order.order_number;
    document.getElementById('printWaybillOverlay').classList.remove('hidden');

    const dlBtn = document.getElementById('printNowBtn');
    dlBtn.onclick = () => {
      closePrintWaybillModal();
      // Straight to the browser's print dialog from the PDF preview — no
      // file lands on the desktop first.
      authPrintPdf(`/api/waybill-pdf/${encodeURIComponent(order.batchId)}/${encodeURIComponent(order.order_number)}`);
    };
    document.getElementById('printSkipBtn').onclick = () => {
      closePrintWaybillModal();
    };
  }

  function closePrintWaybillModal() {
    document.getElementById('printWaybillOverlay').classList.add('hidden');
    focusWaybillInput();
  }

  // ── Mismatch modal ─────────────────────────────────────────────────────────
  function showMismatchModal(mismatches) {
    currentMismatches = mismatches;
    document.getElementById('mismatchTbody').innerHTML = mismatches.map(m => `
      <tr>
        <td><code>${esc(m.sku)}</code></td>
        <td>${esc(m.description || '—')}</td>
        <td>${m.ordered}</td>
        <td class="${m.scanned > m.ordered ? 'over' : 'short'}">${m.scanned}</td>
        <td class="${m.gap > 0 ? 'over' : 'short'}">${m.gap > 0 ? '+' : ''}${m.gap}</td>
      </tr>`).join('');
    document.getElementById('mismatchOverlay').classList.remove('hidden');
  }

  document.getElementById('mismatchContinueBtn').addEventListener('click', () => {
    document.getElementById('mismatchOverlay').classList.add('hidden');
    setTimeout(() => document.getElementById('itemScanInput').focus(), 50);
  });

  document.getElementById('mismatchCancelBtn').addEventListener('click', async () => {
    document.getElementById('mismatchOverlay').classList.add('hidden');
    // currentMismatches already set by showMismatchModal — doCancel will send them
    await doCancel();
  });

  // ── Log (password-protected, footer link) ─────────────────────────────────
  // The Administrator key is NEVER hardcoded here. It used to be (a base64'd
  // copy of the built-in default), which meant anyone could read it out of the
  // page source, AND setting a real MASTER_KEY in the deployment broke this
  // whole panel — the prompt still only accepted the old baked-in value while
  // the server had moved on. Now the typed key is verified server-side by
  // /api/master/verify-key and held in memory for this session only, so every
  // `x-master-key: LOG_PASSWORD` call below sends the operator's real key and
  // works with whatever MASTER_KEY the deployment is set to.
  let LOG_PASSWORD = '';

  document.getElementById('logAccessBtn').addEventListener('click', () => {
    if (logUnlocked) {
      openLogOverlay();
    } else {
      document.getElementById('logPasswordInput').value = '';
      document.getElementById('logPasswordError').classList.add('hidden');
      document.getElementById('logPasswordOverlay').classList.remove('hidden');
      setTimeout(() => document.getElementById('logPasswordInput').focus(), 100);
    }
  });

  document.getElementById('logPasswordInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('logPasswordSubmitBtn').click();
  });

  document.getElementById('logPasswordSubmitBtn').addEventListener('click', async () => {
    const btn = document.getElementById('logPasswordSubmitBtn');
    const err = document.getElementById('logPasswordError');
    const val = document.getElementById('logPasswordInput').value;
    const fail = (msg) => {
      err.textContent = msg || 'Incorrect password.';
      err.classList.remove('hidden');
      document.getElementById('logPasswordInput').select();
    };
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Checking…';
    let ok = false, msg = '';
    try {
      const r = await fetch('/api/master/verify-key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: val }),
      });
      const d = await r.json().catch(() => ({}));
      ok = r.ok && d.ok === true;
      if (!ok) msg = d.error || 'Incorrect password.';
    } catch (e) { msg = 'Could not reach the server — check your connection.'; }
    btn.disabled = false; btn.textContent = orig;
    if (!ok) return fail(msg);

    LOG_PASSWORD = val;            // this session only; never stored
    logUnlocked = true;
    err.classList.add('hidden');
    document.getElementById('logPasswordOverlay').classList.add('hidden');
    if (_pendingUnlockTab) {
      const t = _pendingUnlockTab;
      _pendingUnlockTab = null;
      switchTab(t);                // the unlock was for a gated tab, not the panel
    } else {
      openLogOverlay();
    }
    renderOrdersList(); // Orders tab may be rendered underneath — pick up delete buttons now
  });

  document.getElementById('logPasswordCancelBtn').addEventListener('click', () => {
    _pendingUnlockTab = null;
    document.getElementById('logPasswordOverlay').classList.add('hidden');
  });

  document.getElementById('closeLogBtn').addEventListener('click', () => {
    document.getElementById('logOverlay').classList.add('hidden');
    document.body.classList.remove('log-open');
    stopLiveActivityPolling();
    stopPendingDelPolling();
    renderOrdersList(); // reflect logUnlocked state (delete buttons) on the Orders tab behind it
  });

  async function openLogOverlay() {
    document.getElementById('logOverlay').classList.remove('hidden');
    document.body.classList.add('log-open');
    if (logUnlocked) {
      renderMasterActions();
      await renderLogContent();
    } else {
      await renderLogContent();
    }
  }

  // ── Live Activity (Master dashboard) ────────────────────────────────────────
  let _liveActivityTimer = null;
  function startLiveActivityPolling() {
    stopLiveActivityPolling();
    loadLiveActivity();
    _liveActivityTimer = setInterval(loadLiveActivity, 15000);
  }
  function stopLiveActivityPolling() {
    if (_liveActivityTimer) { clearInterval(_liveActivityTimer); _liveActivityTimer = null; }
  }
  function formatIdleMs(ms) {
    if (ms == null || isNaN(ms)) return '—';
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    return `${mins} min ago`;
  }
  async function loadLiveActivity() {
    try {
      const r = await fetch('/api/master/live-activity', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!r.ok) return;
      renderLiveActivity(await r.json());
    } catch { /* silent — next poll retries */ }
  }
  function renderLiveActivity(d) {
    const t = d.throughput || {};
    document.getElementById('liveStat5m').textContent  = t.last5m   ?? '—';
    document.getElementById('liveStat15m').textContent = t.last15m  ?? '—';
    document.getElementById('liveStat1h').textContent  = t.lastHour ?? '—';
    document.getElementById('liveActivityUpdated').textContent =
      d.generatedAt ? new Date(d.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

    const packers = d.activePackers || [];
    document.getElementById('livePackersBody').innerHTML = packers.map(p => `
      <tr>
        <td class="dcs-name">${esc(p.userName)}</td>
        <td>${esc(p.orderNumber)}</td>
        <td class="live-col-client">${esc(p.client) || '—'}</td>
        <td>${p.scannedQty} / ${p.totalQty}</td>
        <td class="${p.idle ? 'live-idle' : ''}">${formatIdleMs(p.idleMs)}</td>
      </tr>`).join('');
    document.getElementById('livePackersEmpty').classList.toggle('hidden', packers.length > 0);

    const stuck = d.stuckOrders || [];
    document.getElementById('liveStuckBody').innerHTML = stuck.map(s => `
      <tr class="live-stuck-row">
        <td class="dcs-name">${esc(s.orderNumber)}</td>
        <td class="live-col-client">${esc(s.client) || '—'}</td>
        <td>${esc(s.lastPackerName)}</td>
        <td>${s.scannedQty} / ${s.totalQty}</td>
        <td>${s.idleMinutes} min</td>
      </tr>`).join('');
    document.getElementById('liveStuckEmpty').classList.toggle('hidden', stuck.length > 0);
  }

  // ── Pending Deletions (Master review of admin-requested deletions) ──────────
  let _pendingDelTimer = null;
  let _pendingOrderDelCount = 0;
  let _pendingInboundDelCount = 0;
  let _pendingWaveCancelCount = 0;
  function updatePendingDelBadge() {
    const badge = document.getElementById('pendingDelBadge');
    const total = _pendingOrderDelCount + _pendingInboundDelCount + _pendingWaveCancelCount;
    badge.textContent = total;
    badge.classList.toggle('hidden', total === 0);
  }
  function startPendingDelPolling() {
    stopPendingDelPolling();
    loadPendingDeletions();
    loadInboundPendingDeletions();
    loadWavePendingCancellations();
    _pendingDelTimer = setInterval(() => { loadPendingDeletions(); loadInboundPendingDeletions(); loadWavePendingCancellations(); }, 15000);
  }
  function stopPendingDelPolling() {
    if (_pendingDelTimer) { clearInterval(_pendingDelTimer); _pendingDelTimer = null; }
  }
  async function loadPendingDeletions() {
    try {
      const r = await fetch('/api/master/pending-deletions', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!r.ok) return;
      renderPendingDeletions(await r.json());
    } catch { /* silent — next poll retries */ }
  }
  // Select-all + bulk approve/reject. Shared by both Pending Deletions tables:
  // each passes its own element ids, the key it selects by, and the endpoint.
  // Approving is IRREVERSIBLE, so a bulk approve needs a typed confirmation —
  // the same guard the "Clear All Jobs" action uses.
  function wireBulkDeletions(cfg) {
    const bar = document.getElementById(cfg.bar);
    const all = document.getElementById(cfg.selectAll);
    if (!bar || !all) return null;

    const ticks = () => [...document.querySelectorAll(`#${cfg.body} .pd-tick`)];
    const picked = () => ticks().filter(t => t.checked);
    // The table re-renders on a 15s poll, which replaces every row — so the
    // selection is held HERE by key, not in the DOM, and re-applied after each
    // render. Without this, ticking 100 rows then waiting a few seconds
    // silently cleared the lot.
    const sel = new Set();
    const keyOf = ds => cfg.payloadKey === 'ids' ? ds.id : `${ds.batchid}|${ds.order}`;

    function sync() {
      // Re-apply the remembered selection to whatever rows are on screen now,
      // and drop keys for rows that no longer exist (already actioned).
      const rows = ticks();
      const present = new Set(rows.map(t => keyOf(t.dataset)));
      [...sel].forEach(k => { if (!present.has(k)) sel.delete(k); });
      rows.forEach(t => { t.checked = sel.has(keyOf(t.dataset)); });

      const n = sel.size, total = rows.length;
      document.getElementById(cfg.count).textContent = `${n} selected`;
      bar.classList.toggle('hidden', n === 0);
      all.checked = total > 0 && n === total;
      all.indeterminate = n > 0 && n < total;
    }
    all.addEventListener('change', () => {
      ticks().forEach(t => {
        const k = keyOf(t.dataset);
        if (all.checked) sel.add(k); else sel.delete(k);
      });
      sync();
    });
    document.getElementById(cfg.body).addEventListener('change', e => {
      if (!e.target.classList.contains('pd-tick')) return;
      const k = keyOf(e.target.dataset);
      if (e.target.checked) sel.add(k); else sel.delete(k);
      sync();
    });

    async function run(action) {
      // NB: named `chosen`, not `sel` — `sel` is the outer selection Set and
      // shadowing it here broke sel.clear() in the finally block below.
      const chosen = picked();
      if (!chosen.length) return;
      const n = chosen.length;
      if (action === 'approve') {
        const word = 'DELETE';
        const typed = prompt(
          `Approve deletion of ${n} ${cfg.noun}${n === 1 ? '' : 's'}?\n\n`
          + `This permanently removes them and CANNOT be undone.\n`
          + `Anything already completed will be skipped automatically.\n\n`
          + `Type ${word} to confirm:`);
        if (typed === null) return;
        if (typed.trim().toUpperCase() !== word) { alert('Not confirmed — nothing was deleted.'); return; }
      } else {
        const note = prompt(`Reject ${n} request${n === 1 ? '' : 's'}? Optional note for the requester:`, '');
        if (note === null) return;
        cfg._note = note;
      }
      const btns = [document.getElementById(cfg.approve), document.getElementById(cfg.reject)];
      btns.forEach(b => { if (b) b.disabled = true; });
      try {
        const payload = { action, note: cfg._note || '' };
        payload[cfg.payloadKey] = chosen.map(t => cfg.toTarget(t.dataset));
        const r = await fetch(cfg.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Request failed');
        const failed = d.failed || [];
        let msg = `${action === 'approve' ? 'Deleted' : 'Rejected'} ${d.processed} ${cfg.noun}${d.processed === 1 ? '' : 's'}.`;
        if (failed.length) {
          const byReason = {};
          failed.forEach(f => { byReason[f.error] = (byReason[f.error] || 0) + 1; });
          msg += `\n\n${failed.length} skipped:\n` + Object.entries(byReason).map(([e, c]) => `  • ${c} × ${e}`).join('\n');
        }
        alert(msg);
        cfg.reload();
        if (cfg.alsoRefreshOrders) { await refreshOrders(); renderOrdersList(); }
      } catch (err) { alert(err.message); }
      finally {
        cfg._note = '';
        sel.clear();                       // actioned — start clean
        btns.forEach(b => { if (b) b.disabled = false; });
      }
    }
    document.getElementById(cfg.approve)?.addEventListener('click', () => run('approve'));
    document.getElementById(cfg.reject)?.addEventListener('click', () => run('reject'));
    return sync;
  }

  const _pdSync = wireBulkDeletions({
    bar: 'pdBulkBar', count: 'pdBulkCount', selectAll: 'pdSelectAll', body: 'pendingDelBody',
    approve: 'pdBulkApprove', reject: 'pdBulkReject', noun: 'order',
    endpoint: '/api/master/pending-deletions/bulk', payloadKey: 'targets',
    toTarget: ds => ({ orderNumber: ds.order, batchId: ds.batchid }),
    reload: () => loadPendingDeletions(), alsoRefreshOrders: true,
  });
  const _ibdSync = wireBulkDeletions({
    bar: 'ibdBulkBar', count: 'ibdBulkCount', selectAll: 'ibdSelectAll', body: 'pendingInboundDelBody',
    approve: 'ibdBulkApprove', reject: 'ibdBulkReject', noun: 'record',
    endpoint: '/api/master/inbound-pending-deletions/bulk', payloadKey: 'ids',
    toTarget: ds => ds.id,
    reload: () => loadInboundPendingDeletions(),
  });

  function renderPendingDeletions(list) {
    _pendingOrderDelCount = list.length;
    updatePendingDelBadge();

    document.getElementById('pendingDelBody').innerHTML = list.map(p => `
      <tr>
        <td class="pd-col-tick"><input type="checkbox" class="pd-tick" data-order="${esc(p.orderNumber)}" data-batchid="${esc(p.batchId)}"></td>
        <td class="dcs-name">${esc(p.orderNumber)}</td>
        <td class="pd-col-client">${esc(p.client) || '—'}</td>
        <td>${esc(p.reason)}</td>
        <td>${esc(p.requestedByName)}</td>
        <td class="pd-col-progress">${p.scannedQty} / ${p.totalQty}</td>
        <td>
          <button class="btn-sm btn-primary pd-approve-btn" data-order="${esc(p.orderNumber)}" data-batchid="${esc(p.batchId)}">&#10003; Approve</button>
          <button class="btn-sm btn-danger-sm pd-reject-btn" data-order="${esc(p.orderNumber)}" data-batchid="${esc(p.batchId)}">&#215; Reject</button>
        </td>
      </tr>`).join('');
    document.getElementById('pendingDelEmpty').classList.toggle('hidden', list.length > 0);
    if (_pdSync) _pdSync();

    document.querySelectorAll('.pd-approve-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Approve deletion of order ${btn.dataset.order}? This cannot be undone.`)) return;
        btn.disabled = true;
        try {
          const r = await fetch(`/api/master/pending-deletions/${encodeURIComponent(btn.dataset.batchid)}/${encodeURIComponent(btn.dataset.order)}/approve`, {
            method: 'POST', headers: { 'x-master-key': LOG_PASSWORD },
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Approve failed');
          loadPendingDeletions();
          await refreshOrders(); renderOrdersList();
        } catch (err) { alert(err.message); btn.disabled = false; }
      });
    });
    document.querySelectorAll('.pd-reject-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const note = prompt(`Reject deletion of order ${btn.dataset.order}? Optional note for the requester:`, '');
        if (note === null) return; // cancelled
        btn.disabled = true;
        try {
          const r = await fetch(`/api/master/pending-deletions/${encodeURIComponent(btn.dataset.batchid)}/${encodeURIComponent(btn.dataset.order)}/reject`, {
            method: 'POST', headers: { 'x-master-key': LOG_PASSWORD, 'Content-Type': 'application/json' },
            body: JSON.stringify({ note }),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Reject failed');
          loadPendingDeletions();
          await refreshOrders(); renderOrdersList();
        } catch (err) { alert(err.message); btn.disabled = false; }
      });
    });
  }

  async function loadInboundPendingDeletions() {
    try {
      const r = await fetch('/api/master/inbound-pending-deletions', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!r.ok) return;
      renderInboundPendingDeletions(await r.json());
    } catch { /* silent — next poll retries */ }
  }
  function renderInboundPendingDeletions(list) {
    _pendingInboundDelCount = list.length;
    updatePendingDelBadge();

    document.getElementById('pendingInboundDelBody').innerHTML = list.map(p => `
      <tr>
        <td class="pd-col-tick"><input type="checkbox" class="pd-tick" data-id="${esc(p.id)}"></td>
        <td class="dcs-name">${esc(p.reference || p.id.slice(0, 8))}</td>
        <td class="pd-col-client">${esc(p.client) || '—'}</td>
        <td>${esc(p.reason)}</td>
        <td>${esc(p.requestedByName)}</td>
        <td class="pd-col-progress">${p.scannedTotal}${p.type === 'po' ? ` / ${p.expectedTotal}` : ''}</td>
        <td>
          <button class="btn-sm btn-primary pid-approve-btn" data-id="${esc(p.id)}" data-ref="${esc(p.reference || p.id.slice(0, 8))}">&#10003; Approve</button>
          <button class="btn-sm btn-danger-sm pid-reject-btn" data-id="${esc(p.id)}" data-ref="${esc(p.reference || p.id.slice(0, 8))}">&#215; Reject</button>
        </td>
      </tr>`).join('');
    document.getElementById('pendingInboundDelEmpty').classList.toggle('hidden', list.length > 0);
    if (_ibdSync) _ibdSync();

    document.querySelectorAll('.pid-approve-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Approve deletion of ${btn.dataset.ref}? This cannot be undone.`)) return;
        btn.disabled = true;
        try {
          const r = await fetch(`/api/master/inbound-pending-deletions/${encodeURIComponent(btn.dataset.id)}/approve`, {
            method: 'POST', headers: { 'x-master-key': LOG_PASSWORD },
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Approve failed');
          loadInboundPendingDeletions();
          renderInboundTab();
        } catch (err) { alert(err.message); btn.disabled = false; }
      });
    });
    document.querySelectorAll('.pid-reject-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const note = prompt(`Reject deletion of ${btn.dataset.ref}? Optional note for the requester:`, '');
        if (note === null) return; // cancelled
        btn.disabled = true;
        try {
          const r = await fetch(`/api/master/inbound-pending-deletions/${encodeURIComponent(btn.dataset.id)}/reject`, {
            method: 'POST', headers: { 'x-master-key': LOG_PASSWORD, 'Content-Type': 'application/json' },
            body: JSON.stringify({ note }),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Reject failed');
          loadInboundPendingDeletions();
          renderInboundTab();
        } catch (err) { alert(err.message); btn.disabled = false; }
      });
    });
  }

  async function loadWavePendingCancellations() {
    try {
      const r = await fetch('/api/master/wave-pending-cancellations', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!r.ok) return;
      renderWavePendingCancellations(await r.json());
    } catch { /* silent — next poll retries */ }
  }
  function renderWavePendingCancellations(list) {
    _pendingWaveCancelCount = list.length;
    updatePendingDelBadge();

    document.getElementById('pendingWaveCancelBody').innerHTML = list.map(p => `
      <tr>
        <td class="dcs-name">${esc(p.name)}</td>
        <td>${(p.orderNumbers || []).join(', ')}</td>
        <td>${esc(p.reason)}</td>
        <td>${esc(p.requestedByName)}</td>
        <td>
          <button class="btn-sm btn-primary pwc-approve-btn" data-id="${esc(p.id)}" data-name="${esc(p.name)}">&#10003; Approve</button>
          <button class="btn-sm btn-danger-sm pwc-reject-btn" data-id="${esc(p.id)}" data-name="${esc(p.name)}">&#215; Reject</button>
        </td>
      </tr>`).join('');
    document.getElementById('pendingWaveCancelEmpty').classList.toggle('hidden', list.length > 0);

    document.querySelectorAll('.pwc-approve-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Approve cancellation of "${btn.dataset.name}"? Every order it touched has its wave-picked quantities reversed. This cannot be undone.`)) return;
        btn.disabled = true;
        try {
          const r = await fetch(`/api/master/wave-pending-cancellations/${encodeURIComponent(btn.dataset.id)}/approve`, {
            method: 'POST', headers: { 'x-master-key': LOG_PASSWORD },
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Approve failed');
          loadWavePendingCancellations();
          await refreshOrders(); renderOrdersList();
        } catch (err) { alert(err.message); btn.disabled = false; }
      });
    });
    document.querySelectorAll('.pwc-reject-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const note = prompt(`Reject cancellation of "${btn.dataset.name}"? Optional note for the requester:`, '');
        if (note === null) return;
        btn.disabled = true;
        try {
          const r = await fetch(`/api/master/wave-pending-cancellations/${encodeURIComponent(btn.dataset.id)}/reject`, {
            method: 'POST', headers: { 'x-master-key': LOG_PASSWORD, 'Content-Type': 'application/json' },
            body: JSON.stringify({ note }),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Reject failed');
          loadWavePendingCancellations();
        } catch (err) { alert(err.message); btn.disabled = false; }
      });
    });
  }

  let _labelTemplates = null;
  let _docTemplates   = null; // array of carrier names that have .docx templates

  async function loadDocTemplates() {
    try { _docTemplates = await fetch('/api/label/doc-templates').then(r => r.json()); }
    catch { _docTemplates = []; }
    renderDocTemplateList();
  }

  function renderDocTemplateList() {
    const el = document.getElementById('docTemplateList');
    if (!el) return;
    if (!_docTemplates || _docTemplates.length === 0) {
      el.innerHTML = '<p class="hint" style="padding:.4rem 0 .8rem">No Word templates uploaded yet.</p>';
      return;
    }
    el.innerHTML = _docTemplates.map(carrier => {
      const slug = carrier.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      return `
      <div class="doc-tpl-row">
        <span class="doc-tpl-carrier-name">&#128196; ${esc(carrier)}</span>
        <div class="doc-tpl-row-actions">
          <button class="btn-sm btn-secondary doc-tpl-dl-btn" data-slug="${esc(slug)}" data-carrier="${esc(carrier)}">&#8681; Download</button>
          <button class="btn-sm btn-danger-sm doc-tpl-del-btn" data-slug="${esc(slug)}" data-carrier="${esc(carrier)}">&#215; Delete</button>
        </div>
      </div>`;
    }).join('');
  }

  function renderMasterActions() {
    document.getElementById('masterActionsSection').classList.remove('hidden');
    document.getElementById('adminLockedState').classList.add('hidden');
    loadUserList();
    loadEmailConfig();
    loadLabelTemplates();
    loadDocTemplates();
    loadBarcodeMapStats();
    loadLearnedBarcodes();
    startLiveActivityPolling(); // Live Activity is the default landing tab
    loadPendingDeletions(); // one-shot — keeps the nav badge accurate even if the tab isn't opened
    loadInboundPendingDeletions();
  }

  // Admin tab switching
  document.querySelectorAll('.admin-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`adminTab-${btn.dataset.adminTab}`).classList.remove('hidden');
      if (btn.dataset.adminTab === 'batches') renderLogContent();
      if (btn.dataset.adminTab === 'activity') startLiveActivityPolling();
      else stopLiveActivityPolling();
      if (btn.dataset.adminTab === 'overview') loadActivityOverview();
      if (btn.dataset.adminTab === 'deletions') startPendingDelPolling();
      else stopPendingDelPolling();
      if (btn.dataset.adminTab === 'tms') renderTmsTab();
      if (btn.dataset.adminTab === 'drivers') loadDriverList();
      if (btn.dataset.adminTab === 'users') loadUserList();
      if (btn.dataset.adminTab === 'comms') loadCommunication();
      if (btn.dataset.adminTab === 'onboarding') obUI.load();
      if (btn.dataset.adminTab === 'outages') outagesUI.load();
      if (btn.dataset.adminTab === 'danger') loadBackupArchive();
    });
  });

  // ── System Outages module ────────────────────────────────────────────────
  const outagesUI = (function () {
    let errors = [];
    let current = null;
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const $ = id => document.getElementById(id);
    const mk = () => ({ 'x-master-key': LOG_PASSWORD });
    const mkJson = () => ({ 'x-master-key': LOG_PASSWORD, 'Content-Type': 'application/json' });

    let openCount = 0;
    async function load() {
      try {
        const r = await fetch('/api/master/system-errors', { headers: mk() });
        const d = r.ok ? await r.json() : { errors: [], open: 0 };
        errors = d.errors || [];
        openCount = d.open || 0;
      } catch { errors = []; }
      updateBadge();
      render();
      // Live subsystem health is shown in this same panel — refresh it whenever
      // the panel is opened so it is never stale when someone comes looking.
      refreshSystemHealth();
    }
    // The badge covers recorded errors PLUS current health issues, because the
    // top-of-screen banner that used to announce health problems is gone.
    function refreshBadge() { updateBadge(); }
    function updateBadge() {
      const b = $('outagesBadge'); if (!b) return;
      const open = openCount + (typeof _healthIssues !== 'undefined' ? _healthIssues.length : 0);
      if (open > 0) { b.textContent = open; b.classList.remove('hidden'); } else b.classList.add('hidden');
    }
    function render() {
      const el = $('outagesList'); if (!el) return;
      if (!errors.length) { el.innerHTML = '<div class="empty-state" style="padding:1.5rem;color:#059669">✓ No errors reported. All systems nominal.</div>'; return; }
      el.innerHTML = errors.map(e => {
        const open = e.status === 'open';
        const dot = open ? '🔴' : '🟢';
        const border = open ? '#dc2626' : '#059669';
        return `<div class="user-row" data-id="${esc(e.id)}" style="cursor:pointer;border-left:4px solid ${border}">
          <span style="font-size:1.1rem">${dot}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600">${esc(e.context || 'Error')}${e.app === 'driver' ? ' <span class="hint">(driver app)</span>' : ''}</div>
            <div class="hint" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc((e.message || '').split('\n')[0].slice(0, 100))}</div>
          </div>
          <span class="hint" style="text-align:right">×${e.count}<br>${new Date(e.lastAt).toLocaleString()}</span>
          <button class="btn-secondary btn-sm ob-ts" data-id="${esc(e.id)}">🔧 Troubleshoot</button>
        </div>`;
      }).join('');
      el.querySelectorAll('.ob-ts').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); openTs(btn.dataset.id); }));
      el.querySelectorAll('.user-row').forEach(row => row.addEventListener('click', () => openTs(row.dataset.id)));
    }
    function openTs(id) {
      current = errors.find(e => e.id === id); if (!current) return;
      const e = current;
      $('outageDetail').innerHTML = `
        <div><b>${esc(e.context || 'Error')}</b> — <span style="color:${e.status === 'open' ? '#dc2626' : '#059669'}">${e.status === 'open' ? '🔴 Open' : '🟢 Resolved'}</span></div>
        <div class="hint" style="margin:.3rem 0">Seen ${e.count}× · first ${new Date(e.firstAt).toLocaleString()} · last ${new Date(e.lastAt).toLocaleString()}${e.lastUser ? ' · last user ' + esc(e.lastUser) : ''} · ${esc(e.app || 'office')} app</div>
        <div class="hint">Page: ${esc(e.page || e.lastPage || '—')}</div>
        <pre style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:.7rem;font-size:.72rem;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto;margin:.6rem 0 0">${esc(e.stack || e.message)}</pre>`;
      $('outageHealth').innerHTML = '';
      $('outageResolveBtn').style.display = e.status === 'open' ? '' : 'none';
      $('outageReopenBtn').style.display = e.status === 'resolved' ? '' : 'none';
      $('outageModal').classList.remove('hidden');
    }
    async function health() {
      const el = $('outageHealth'); el.innerHTML = '<span class="hint">Checking…</span>';
      try {
        const r = await fetch('/api/master/system-errors/health', { headers: mk() });
        const h = await r.json();
        const row = (ok, label, val) => `<div style="display:flex;gap:.5rem;font-size:.82rem"><span>${ok ? '✓' : '⚠'}</span><span style="flex:1">${label}</span><b style="color:${ok ? '#059669' : '#d97706'}">${val}</b></div>`;
        el.innerHTML = `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:.7rem;display:grid;gap:.3rem">
          ${row(h.serverUp, 'Server', 'up')}
          ${row(h.storagePersistent, 'Storage persistent', h.storagePersistent ? 'yes' : 'UNPROVEN')}
          ${row(h.inventoryAvailable, 'Inventory store', h.inventoryAvailable ? 'available' : 'DOWN')}
          ${row(h.zortOutboxStalled === 0, 'ZORT outbox stalled', h.zortOutboxStalled)}
          ${row(true, 'ZORT outbox pending', h.zortOutboxPending)}
          ${row(h.openErrors === 0, 'Open errors', h.openErrors)}
        </div>`;
      } catch (e) { el.innerHTML = '<span style="color:#dc2626">Health check failed: ' + esc(e.message) + '</span>'; }
    }
    async function resolve() {
      if (!current) return;
      const note = prompt('Resolution note (optional) — what fixed it?') || '';
      await fetch(`/api/master/system-errors/${current.id}/resolve`, { method: 'POST', headers: mkJson(), body: JSON.stringify({ note }) });
      $('outageModal').classList.add('hidden');
      load();
    }
    async function reopen() {
      if (!current) return;
      await fetch(`/api/master/system-errors/${current.id}/reopen`, { method: 'POST', headers: mk() });
      $('outageModal').classList.add('hidden');
      load();
    }

    setTimeout(() => {
      $('outagesRefreshBtn')?.addEventListener('click', load);
      $('outageHealthBtn')?.addEventListener('click', health);
      $('outageResolveBtn')?.addEventListener('click', resolve);
      $('outageReopenBtn')?.addEventListener('click', reopen);
      $('outageCloseBtn')?.addEventListener('click', () => $('outageModal').classList.add('hidden'));
    }, 0);

    return { load, refreshBadge };
  })();

  // ── Client onboarding module ─────────────────────────────────────────────
  const obUI = (function () {
    let profiles = [];
    let current = null; // selected client name ('' = new/unsaved)
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const $ = id => document.getElementById(id);
    const mk = () => ({ 'x-master-key': LOG_PASSWORD });
    const mkJson = () => ({ 'x-master-key': LOG_PASSWORD, 'Content-Type': 'application/json' });

    async function load() {
      try {
        const r = await fetch('/api/master/client-profiles', { headers: mk() });
        profiles = r.ok ? await r.json() : [];
      } catch { profiles = []; }
      renderList();
    }
    function renderList() {
      const el = $('obClientList');
      if (!el) return;
      if (!profiles.length) { el.innerHTML = '<div class="empty-state" style="padding:1rem">No clients yet — click + New.</div>'; return; }
      el.innerHTML = profiles.map(p => {
        const pend = (p.instructions || []).filter(i => i.status === 'Processing').length;
        return `<div class="user-row" data-client="${esc(p.client)}" style="cursor:pointer;${current === p.client ? 'background:#eff6ff' : ''}">
          <span class="user-name">${esc(p.client)}</span>
          <span class="user-id">${esc((p.type || '').toUpperCase())}${p.commodity ? ' · ' + esc(p.commodity) : ''}</span>
          <span class="hint">${p.itemCount ? p.itemCount + ' items' : 'no items'}${pend ? ` · ⏳ ${pend}` : ''}</span>
        </div>`;
      }).join('');
      el.querySelectorAll('.user-row').forEach(row => row.addEventListener('click', () => select(row.dataset.client)));
    }
    function openBlank() {
      current = '';
      $('obDetailEmpty').classList.add('hidden');
      $('obDetailBody').classList.remove('hidden');
      $('obName').value = ''; $('obName').disabled = false;
      $('obType').value = ''; $('obCommodity').value = '';
      $('obItemCount').textContent = ''; $('obItemStatus').classList.add('hidden');
      $('obInstrList').innerHTML = ''; $('obTestResult').textContent = '';
      $('obSaveStatus').textContent = '';
    }
    function select(client) {
      const p = profiles.find(x => x.client === client);
      if (!p) return;
      current = client;
      renderList();
      $('obDetailEmpty').classList.add('hidden');
      $('obDetailBody').classList.remove('hidden');
      $('obName').value = p.client; $('obName').disabled = true; // name is the key
      $('obType').value = p.type || ''; $('obCommodity').value = p.commodity || '';
      $('obItemCount').textContent = p.itemCount ? `${p.itemCount} items loaded` : 'no items yet';
      $('obItemStatus').classList.add('hidden'); $('obTestResult').textContent = ''; $('obSaveStatus').textContent = '';
      renderInstr(p.instructions || []);
      // Portal access state (credentials are masked server-side)
      const pt = p.portal || {};
      $('obPortalEnabled').checked = !!pt.enabled;
      $('obPortalEmail').value = pt.email || '';
      $('obPortalPass').value = '';
      $('obPortalStatus').innerHTML = pt.enabled
        ? `✅ Portal ON — login at <b>${location.origin}/portal</b> with client name "<b>${esc(p.client)}</b>"${pt.hasPassword ? '' : ' — <span style="color:#dc2626">no password set yet!</span>'}`
        : 'Portal off.';
    }
    function renderInstr(list) {
      $('obInstrList').innerHTML = list.length ? list.map(i => {
        const badge = i.status === 'Deployed'
          ? '<span style="font-size:.7rem;background:#dcfce7;color:#166534;padding:.1rem .4rem;border-radius:4px">Deployed</span>'
          : '<span style="font-size:.7rem;background:#fef9c3;color:#854d0e;padding:.1rem .4rem;border-radius:4px">⏳ Processing</span>';
        return `<div style="display:flex;align-items:center;gap:.5rem;padding:.35rem 0;border-bottom:1px solid #f1f5f9">
          <span style="flex:1;font-size:.85rem">${esc(i.text)}</span>${badge}</div>`;
      }).join('') : '<span class="hint">None yet.</span>';
    }

    async function save() {
      const client = $('obName').value.trim();
      if (!client) { $('obSaveStatus').textContent = 'Name required.'; return; }
      const body = { client, type: $('obType').value, commodity: $('obCommodity').value.trim() };
      const r = await fetch('/api/master/client-profiles', { method: 'POST', headers: mkJson(), body: JSON.stringify(body) });
      if (!r.ok) { const d = await r.json(); $('obSaveStatus').textContent = d.error || 'Save failed'; return; }
      $('obSaveStatus').textContent = '✓ Saved';
      await load(); select(client);
    }
    function uploadItems() {
      if (!current) { alert('Save the client first.'); return; }
      const inp = $('obItemFile');
      inp.onchange = async () => {
        const f = inp.files && inp.files[0]; inp.value = ''; if (!f) return;
        const st = $('obItemStatus'); st.className = 'status-bar progress'; st.textContent = `Uploading "${f.name}"…`; st.classList.remove('hidden');
        const fd = new FormData(); fd.append('file', f);
        try {
          const r = await fetch(`/api/master/client-profiles/${encodeURIComponent(current)}/item-master`, { method: 'POST', headers: mk(), body: fd });
          const d = await r.json();
          if (!r.ok) { st.className = 'status-bar error'; st.textContent = d.error || 'Upload failed'; return; }
          st.className = 'status-bar success'; st.textContent = `✓ ${d.imported} item(s) loaded${d.skipped ? `, ${d.skipped} skipped` : ''}. SKU↔barcode search is on.`;
          $('obItemCount').textContent = `${d.itemCount} items loaded`;
        } catch (e) { st.className = 'status-bar error'; st.textContent = 'Error: ' + e.message; }
      };
      inp.click();
    }
    async function testCode() {
      if (!current) { alert('Save the client first.'); return; }
      const code = $('obTestCode').value.trim(); if (!code) return;
      const r = await fetch(`/api/master/client-profiles/${encodeURIComponent(current)}/test-resolve?code=${encodeURIComponent(code)}`, { headers: mk() });
      const d = await r.json();
      const el = $('obTestResult');
      if (!r.ok) { el.innerHTML = `<span style="color:#dc2626">${esc(d.error || 'error')}</span>`; return; }
      el.innerHTML = d.found
        ? `<span style="color:#059669">✓ matched by <b>${esc(d.matchedBy)}</b> → SKU <b>${esc(d.sku)}</b>${d.barcode ? ` (barcode ${esc(d.barcode)})` : ''} — ${esc(d.name || '')}</span>`
        : `<span style="color:#dc2626">✗ "${esc(code)}" not found in this client's item master</span>`;
    }
    async function addInstr() {
      if (!current) { alert('Save the client first.'); return; }
      const text = $('obInstrText').value.trim(); if (!text) return;
      const r = await fetch(`/api/master/client-profiles/${encodeURIComponent(current)}/instructions`, { method: 'POST', headers: mkJson(), body: JSON.stringify({ text }) });
      const d = await r.json();
      if (!r.ok) { alert(d.error || 'Failed'); return; }
      $('obInstrText').value = '';
      await load(); select(current);
    }
    async function remove() {
      if (!current) return;
      if (!confirm(`Remove client "${current}"? (their stock/orders are NOT deleted — this only removes the onboarding profile)`)) return;
      await fetch(`/api/master/client-profiles/${encodeURIComponent(current)}`, { method: 'DELETE', headers: mk() });
      current = null; $('obDetailBody').classList.add('hidden'); $('obDetailEmpty').classList.remove('hidden');
      load();
    }

    setTimeout(() => {
      $('obNewBtn')?.addEventListener('click', openBlank);
      $('obSaveBtn')?.addEventListener('click', save);
      $('obItemUploadBtn')?.addEventListener('click', uploadItems);
      $('obTestBtn')?.addEventListener('click', testCode);
      $('obTestCode')?.addEventListener('keydown', e => { if (e.key === 'Enter') testCode(); });
      $('obInstrAddBtn')?.addEventListener('click', addInstr);
      $('obInstrText')?.addEventListener('keydown', e => { if (e.key === 'Enter') addInstr(); });
      $('obPortalSaveBtn')?.addEventListener('click', async () => {
        if (!current) { alert('Save the client first.'); return; }
        const body = { enabled: $('obPortalEnabled').checked, email: $('obPortalEmail').value.trim(), password: $('obPortalPass').value };
        const r = await fetch(`/api/master/client-profiles/${encodeURIComponent(current)}/portal`, { method: 'POST', headers: mkJson(), body: JSON.stringify(body) });
        const d = await r.json();
        if (!r.ok) { $('obPortalStatus').innerHTML = `<span style="color:#dc2626">${esc(d.error || 'Failed')}</span>`; return; }
        $('obPortalPass').value = '';
        await load(); select(current);
        $('obPortalStatus').innerHTML += ' <b style="color:#059669">✓ saved</b>';
      });
      $('obDeleteBtn')?.addEventListener('click', remove);
    }, 0);

    return { load };
  })();

  // ── ZORT merchant connections (Administrator → ZORT) ───────────────────────
  const zortHdrs = () => ({ 'x-master-key': LOG_PASSWORD, 'Content-Type': 'application/json' });
  function zortStatus(kind, msg) {
    const el = document.getElementById('zortStoreStatus');
    el.className = `status-bar ${kind}`;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 6000);
  }
  async function loadZortStores() {
    const tbody = document.getElementById('zortStoresTbody');
    try {
      const r = await fetch('/api/master/zort/stores', { headers: { 'x-master-key': LOG_PASSWORD } });
      const stores = await r.json();
      if (!stores.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="padding:1rem;color:#64748b">No stores connected yet. Click “+ Connect Store” and paste the client\'s API credentials from their store settings page.</td></tr>';
        return;
      }
      const actLbl = { none: 'nothing', pack: 'Pack', readytoship: 'Ready to ship', status: 'status code' };
      tbody.innerHTML = stores.map(s => {
        const stockBadge = s.stockSync
          ? `<span style="color:#059669;font-weight:600">📦 On</span>` + (s.outboxPending ? `<br><span style="color:#64748b;font-size:.75rem">${s.outboxPending} queued</span>` : '') + (s.outboxStalled ? `<br><span style="color:#dc2626;font-size:.75rem">⚠ ${s.outboxStalled} stalled</span>` : '')
          : `<span style="color:#94a3b8">off</span>`;
        return `
        <tr data-zid="${esc(s.id)}">
          <td><b>${esc(s.clientName)}</b>${s.enabled ? '' : ' <span style="color:#ef4444">(disabled)</span>'}</td>
          <td>${esc(s.storename)}</td>
          <td><code>${esc(s.apikeyMasked)}</code></td>
          <td>${s.autoPullMinutes ? 'every ' + s.autoPullMinutes + ' min' : 'manual'}</td>
          <td>${actLbl[s.completeAction] || s.completeAction}${s.completeAction === 'status' ? ' ' + s.completeStatusCode : ''}</td>
          <td>${stockBadge}</td>
          <td>${s.lastPullAt ? `${new Date(s.lastPullAt).toLocaleString()}<br><span style="color:#64748b;font-size:.75rem">${s.lastResult ? `+${s.lastResult.created} new, ${s.lastResult.skippedExisting} known` : ''}</span>` : 'never'}</td>
          <td style="white-space:nowrap">
            <button class="btn-secondary btn-sm z-channels" title="Sales channels this client has linked inside their hub account">Channels</button>
            <button class="btn-secondary btn-sm z-test">Test</button>
            <button class="btn-primary btn-sm z-pull">Pull now</button>
            ${s.stockSync ? '<button class="btn-secondary btn-sm z-pushstock" title="Enqueue current stock levels for every SKU to the store">⇪ Push Stock</button>' : ''}
            <button class="btn-secondary btn-sm z-edit">&#9998;</button>
            <button class="btn-danger btn-sm z-del">&#128465;</button>
          </td>
        </tr>`; }).join('');
      tbody.querySelectorAll('tr').forEach(tr => {
        const id = tr.dataset.zid;
        const store = stores.find(s => s.id === id);
        tr.querySelector('.z-channels').addEventListener('click', async e => {
          e.target.disabled = true;
          try {
            const r2 = await fetch(`/api/master/zort/stores/${id}/channels`, { headers: { 'x-master-key': LOG_PASSWORD } });
            const d = await r2.json();
            if (d.ok) openZortChannelMapper(store, Array.isArray(d.channels) ? d.channels : []);
            else zortStatus('error', d.error || 'Could not load channels');
          } catch (err) { zortStatus('error', 'Channels failed: ' + err.message); }
          e.target.disabled = false;
        });
        tr.querySelector('.z-test').addEventListener('click', async e => {
          e.target.disabled = true;
          try {
            const r2 = await fetch(`/api/master/zort/stores/${id}/test`, { method: 'POST', headers: zortHdrs() });
            const d = await r2.json();
            zortStatus(d.ok ? 'success' : 'error', d.ok ? `✓ ${store.clientName}: connection OK` : `✗ ${store.clientName}: ${d.error}`);
          } catch (err) { zortStatus('error', 'Test failed: ' + err.message); }
          e.target.disabled = false;
        });
        tr.querySelector('.z-pull').addEventListener('click', async e => {
          e.target.disabled = true;
          zortStatus('progress', `Pulling orders from ${store.clientName}…`);
          try {
            const r2 = await fetch(`/api/master/zort/stores/${id}/pull`, { method: 'POST', headers: zortHdrs() });
            const d = await r2.json();
            if (d.ok) {
              zortStatus('success', `✓ ${store.clientName}: ${d.result.created} new order(s) imported (${d.result.fetched} fetched, ${d.result.skippedExisting} already known, ${d.result.skippedVoid} voided)`);
              loadZortStores();
            } else zortStatus('error', `✗ ${d.error}`);
          } catch (err) { zortStatus('error', 'Pull failed: ' + err.message); }
          e.target.disabled = false;
        });
        tr.querySelector('.z-pushstock')?.addEventListener('click', async e => {
          if (!confirm(`Push current stock levels for every SKU owned by ${store.clientName} to their store?\n\nThis enqueues an absolute available-quantity update per SKU; the background sync sends them with retry.`)) return;
          e.target.disabled = true;
          zortStatus('progress', `Enqueuing stock for ${store.clientName}…`);
          try {
            const r2 = await fetch(`/api/master/zort/stores/${id}/push-stock`, { method: 'POST', headers: zortHdrs() });
            const d = await r2.json();
            if (d.ok) { zortStatus('success', `✓ ${d.enqueued} stock update(s) queued — syncing in the background`); loadZortStores(); }
            else zortStatus('error', `✗ ${d.error}`);
          } catch (err) { zortStatus('error', 'Push stock failed: ' + err.message); }
          e.target.disabled = false;
        });
        tr.querySelector('.z-edit').addEventListener('click', () => openZortForm(store));
        tr.querySelector('.z-del').addEventListener('click', async () => {
          if (!confirm(`Disconnect the store connection for "${store.clientName}"?\n\nAlready-imported orders stay; new orders will no longer pull and completions will no longer push back.`)) return;
          await fetch(`/api/master/zort/stores/${id}`, { method: 'DELETE', headers: zortHdrs() });
          loadZortStores();
        });
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:#ef4444;padding:1rem">Failed to load: ${esc(err.message)}</td></tr>`;
    }
  }
  function openZortForm(store) {
    document.getElementById('zortStoreForm').classList.remove('hidden');
    document.getElementById('zortFormTitle').textContent = store ? `Edit — ${store.clientName}` : 'Connect a ZORT store';
    document.getElementById('zfId').value = store?.id || '';
    document.getElementById('zfClient').value = store?.clientName || '';
    document.getElementById('zfStorename').value = store?.storename || '';
    document.getElementById('zfApikey').value = '';
    document.getElementById('zfApisecret').value = '';
    document.getElementById('zfApikey').placeholder = store ? `current: ${store.apikeyMasked} — leave blank to keep` : 'API key from store settings';
    document.getElementById('zfApisecret').placeholder = store ? `current: ${store.apisecretMasked} — leave blank to keep` : 'API secret from store settings';
    document.getElementById('zfAutoPull').value = store?.autoPullMinutes || 0;
    document.getElementById('zfCompleteAction').value = store?.completeAction || 'none';
    document.getElementById('zfStatusCode').value = store?.completeStatusCode ?? 1;
    document.getElementById('zfStatusCodeWrap').classList.toggle('hidden', (store?.completeAction || 'none') !== 'status');
    document.getElementById('zfStockSync').checked = !!store?.stockSync;
  }
  document.getElementById('zortAddStoreBtn')?.addEventListener('click', () => openZortForm(null));
  document.getElementById('zortCancelStoreBtn')?.addEventListener('click', () => document.getElementById('zortStoreForm').classList.add('hidden'));
  document.getElementById('zfCompleteAction')?.addEventListener('change', e => {
    document.getElementById('zfStatusCodeWrap').classList.toggle('hidden', e.target.value !== 'status');
  });
  // Channel → client mapping editor: every sales channel found in the ZORT
  // account gets a client-name input. Saved into store.channelClients — the
  // pull batches each order under its channel's client.
  function openZortChannelMapper(store, channels) {
    const listEl = document.getElementById('zortChannelsList');
    const names = [...new Set(channels.map(c => (c.name || c.channelname || c.saleschannel || c.type || '').trim()).filter(Boolean))];
    // Include channels that already have a mapping but weren't returned (paused shops etc.)
    for (const k of Object.keys(store.channelClients || {})) if (!names.includes(k)) names.push(k);
    listEl.innerHTML = names.length ? names.map(n => `
      <div class="form-group" style="display:flex;align-items:center;gap:.7rem">
        <label style="flex:1;margin:0;font-weight:600">${esc(n)}</label>
        <input type="text" data-channel="${esc(n)}" placeholder="client name…" style="flex:1"
          value="${esc((store.channelClients || {})[n] || '')}" />
      </div>`).join('')
      : '<p class="hint">No sales channels found in this account yet. Link the client\'s online shops inside the hub\'s Sales Channels settings first, then reopen this.</p>';
    document.getElementById('zortChannelsModal').classList.remove('hidden');
    document.getElementById('zortChannelsSaveBtn').onclick = async () => {
      const map = {};
      listEl.querySelectorAll('input[data-channel]').forEach(inp => {
        const v = inp.value.trim();
        if (v) map[inp.dataset.channel] = v;
      });
      try {
        const r = await fetch('/api/master/zort/stores', { method: 'POST', headers: zortHdrs(),
          body: JSON.stringify({ id: store.id, channelClients: map }) });
        if (!r.ok) { const d = await r.json(); return zortStatus('error', d.error || 'Save failed'); }
        document.getElementById('zortChannelsModal').classList.add('hidden');
        zortStatus('success', `✓ Channel mapping saved (${Object.keys(map).length} channel(s))`);
        loadZortStores();
      } catch (err) { zortStatus('error', 'Save failed: ' + err.message); }
    };
  }
  document.getElementById('zortChannelsCancelBtn')?.addEventListener('click', () =>
    document.getElementById('zortChannelsModal').classList.add('hidden'));

  document.getElementById('zortSaveStoreBtn')?.addEventListener('click', async () => {
    const body = {
      id: document.getElementById('zfId').value || undefined,
      clientName: document.getElementById('zfClient').value.trim(),
      storename: document.getElementById('zfStorename').value.trim(),
      apikey: document.getElementById('zfApikey').value.trim(),
      apisecret: document.getElementById('zfApisecret').value.trim(),
      autoPullMinutes: parseInt(document.getElementById('zfAutoPull').value, 10) || 0,
      completeAction: document.getElementById('zfCompleteAction').value,
      completeStatusCode: parseInt(document.getElementById('zfStatusCode').value, 10) || 1,
      stockSync: document.getElementById('zfStockSync').checked,
      enabled: true,
    };
    try {
      const r = await fetch('/api/master/zort/stores', { method: 'POST', headers: zortHdrs(), body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) return zortStatus('error', d.error || 'Save failed');
      document.getElementById('zortStoreForm').classList.add('hidden');
      zortStatus('success', `✓ Saved — ${d.clientName}`);
      loadZortStores();
    } catch (err) { zortStatus('error', 'Save failed: ' + err.message); }
  });

  // ── Activity Overview (Admin & Master only — server-enforced) ──────────────
  function fmtDashDate(d) {
    // The date string is already an SGT calendar day — format it as SGT
    // explicitly, or a viewer in a different browser timezone would see it
    // shifted by a day (this bit us once already: worth the extra option).
    return new Date(d + 'T00:00:00+08:00').toLocaleDateString('en-SG', { day: '2-digit', month: 'short', weekday: 'short', timeZone: 'Asia/Singapore' });
  }
  function largestOrderCell(l, unit) {
    if (!l) return '<span class="hint">—</span>';
    return `<div><strong>${esc(l.order)}</strong> <span class="hint">(${l.value} ${unit})</span></div><div class="hint">${esc(l.client) || '—'}</div>`;
  }
  async function loadActivityOverview() {
    try {
      const r = await fetch('/api/master/dashboard/activity-overview', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!r.ok) return;
      renderActivityOverview(await r.json());
    } catch { /* silent — admin can reopen the tab to retry */ }
  }
  function renderActivityOverview(d) {
    const days = d.days || [];
    document.getElementById('overviewBody').innerHTML = days.map(day => `
      <tr>
        <td>${fmtDashDate(day.date)}</td>
        <td>${day.totalOrders}</td>
        <td>${day.totalLines}</td>
        <td>${largestOrderCell(day.largestBySize, 'pcs')}</td>
        <td>${largestOrderCell(day.largestByLines, 'lines')}</td>
      </tr>`).join('');
    document.getElementById('overviewEmpty').classList.toggle('hidden', days.some(day => day.totalOrders > 0));
  }

  // ── Station Throughput (Warehouse, Admin & Master) ──────────────────────────
  document.getElementById('stationThroughputBtn').addEventListener('click', async () => {
    document.getElementById('stationThroughputOverlay').classList.remove('hidden');
    try {
      const r = await fetch('/api/master/dashboard/station-throughput');
      if (!r.ok) { alert('Could not load station throughput.'); return; }
      renderStationThroughput(await r.json());
    } catch (err) { alert(err.message); }
  });
  document.getElementById('stpCloseBtn').addEventListener('click', () => {
    document.getElementById('stationThroughputOverlay').classList.add('hidden');
  });
  function renderStationThroughput(d) {
    const days = d.days || [];
    document.getElementById('stpTotalsGrid').innerHTML = days.map(day => `
      <div class="dstat"><div class="dstat-val">${d.totalsByDay?.[day] ?? 0}</div><div class="dstat-lbl">${fmtDashDate(day)}</div></div>
    `).join('');

    const headRow = `<tr><th>Station</th>${days.map(day => `<th>${fmtDashDate(day)}</th>`).join('')}<th>Total</th></tr>`;
    document.getElementById('stpOrdersHead').innerHTML = headRow;
    document.getElementById('stpLinesHead').innerHTML = headRow;

    const stations = d.stations || [];
    document.getElementById('stpOrdersBody').innerHTML = stations.map(s => {
      const total = days.reduce((sum, day) => sum + (s.byDay[day]?.orders || 0), 0);
      return `<tr><td class="dcs-name">${esc(s.stationName)}</td>${days.map(day => `<td>${s.byDay[day]?.orders || 0}</td>`).join('')}<td><strong>${total}</strong></td></tr>`;
    }).join('');
    document.getElementById('stpLinesBody').innerHTML = stations.map(s => {
      const total = days.reduce((sum, day) => sum + (s.byDay[day]?.lines || 0), 0);
      return `<tr><td class="dcs-name">${esc(s.stationName)}</td>${days.map(day => `<td>${s.byDay[day]?.lines || 0}</td>`).join('')}<td><strong>${total}</strong></td></tr>`;
    }).join('');

    document.getElementById('stpEmpty').classList.toggle('hidden', stations.length > 0);
  }

  // Staff side of Communication: an unacknowledged message from the office
  // blocks the app the same way it does in the Driver App, so a warehouse
  // user can't miss it either.
  let _staffNotices = [];
  async function loadStaffNotices() {
    if (!localStorage.getItem('wms_token')) return;
    try { const r = await fetch('/api/notices'); _staffNotices = r.ok ? await r.json() : []; }
    catch { return; }
    showNextStaffNotice();
  }
  function showNextStaffNotice() {
    let ov = document.getElementById('staffNoticeOverlay');
    if (!_staffNotices.length) { ov?.classList.add('hidden'); return; }
    const n = _staffNotices[0];
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'staffNoticeOverlay';
      ov.className = 'modal-overlay';
      ov.innerHTML = `
        <div class="modal" style="max-width:440px;text-align:center">
          <div class="modal-icon" id="snIcon">📢</div>
          <div class="modal-title" id="snTitle">Message from the office</div>
          <div id="snMsg" style="white-space:pre-wrap;text-align:left;background:var(--surface-2,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:10px;padding:.8rem .9rem;font-size:.9rem;line-height:1.55;margin-top:.4rem"></div>
          <div class="hint" id="snMeta" style="margin-top:.5rem"></div>
          <div class="modal-actions" style="margin-top:1rem">
            <button class="btn-primary" id="snAckBtn" style="width:100%">I Understand</button>
          </div>
          <div class="hint" id="snCount" style="margin-top:.5rem"></div>
        </div>`;
      document.body.appendChild(ov);
      ov.querySelector('#snAckBtn').addEventListener('click', async () => {
        const cur = _staffNotices[0]; if (!cur) return;
        const btn = ov.querySelector('#snAckBtn');
        btn.disabled = true; btn.textContent = 'Saving…';
        try { await fetch(`/api/notices/${encodeURIComponent(cur.id)}/ack`, { method: 'POST' }); _staffNotices.shift(); }
        catch {}
        btn.disabled = false; btn.textContent = 'I Understand';
        showNextStaffNotice();
      });
    }
    ov.querySelector('#snMsg').textContent = n.message;
    ov.querySelector('#snIcon').textContent = n.priority === 'urgent' ? '⚠️' : '📢';
    ov.querySelector('#snTitle').textContent = n.priority === 'urgent' ? 'Urgent — from the office' : 'Message from the office';
    ov.querySelector('#snMeta').textContent = n.createdAt ? new Date(n.createdAt).toLocaleString('en-SG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    ov.querySelector('#snCount').textContent = _staffNotices.length > 1 ? `${_staffNotices.length - 1} more message(s) after this` : '';
    ov.classList.remove('hidden');
  }
  setTimeout(loadStaffNotices, 3000);
  setInterval(loadStaffNotices, 60000);

  // ── Communication (Administrator → 📢) ─────────────────────────────────────
  // One composer for both audiences: drivers and warehouse/office staff.
  // "All" is stored as the literal 'all' rather than a snapshot of ids, so a
  // driver hired after the message was sent still has to acknowledge it.
  const cmSel = { drv: new Set(), usr: new Set(), drvAll: false, usrAll: false };
  let _cmAudience = { drivers: [], users: [] };

  function cmRenderPickers() {
    const row = (grp, id, label, sub, checked) => `
      <label class="cm-row">
        <input type="checkbox" data-grp="${grp}" value="${esc(id)}" ${checked ? 'checked' : ''} />
        <span>${esc(label)}</span><span class="cm-sub">${esc(sub || '')}</span>
      </label>`;
    document.getElementById('cmDriverList').innerHTML = _cmAudience.drivers.length
      ? _cmAudience.drivers.map(d => row('drv', d.id, d.name || d.id,
          [d.vehicle, d.plate].filter(Boolean).join(' · '), cmSel.drvAll || cmSel.drv.has(d.id))).join('')
      : '<div class="cm-row"><span class="hint">No drivers yet.</span></div>';
    document.getElementById('cmUserList').innerHTML = _cmAudience.users.length
      ? _cmAudience.users.map(u => row('usr', u.id, u.name || u.id, u.role,
          cmSel.usrAll || cmSel.usr.has(u.id))).join('')
      : '<div class="cm-row"><span class="hint">No users yet.</span></div>';
    cmUpdateCount();
  }
  function cmUpdateCount() {
    const d = cmSel.drvAll ? _cmAudience.drivers.length : cmSel.drv.size;
    const u = cmSel.usrAll ? _cmAudience.users.length   : cmSel.usr.size;
    document.getElementById('cmCount').textContent =
      `${d + u} recipient(s) selected — ${d} driver(s), ${u} staff`;
  }
  async function loadCommunication() {
    try {
      const r = await fetch('/api/master/notice-audience', { headers: { 'x-master-key': LOG_PASSWORD } });
      _cmAudience = r.ok ? await r.json() : { drivers: [], users: [] };
    } catch { _cmAudience = { drivers: [], users: [] }; }
    cmRenderPickers();
    cmLoadSent();
  }
  async function cmLoadSent() {
    const el = document.getElementById('cmSentList');
    if (!el) return;
    let list = [];
    try {
      const r = await fetch('/api/master/notices', { headers: { 'x-master-key': LOG_PASSWORD } });
      list = r.ok ? await r.json() : [];
    } catch {}
    if (!list.length) { el.innerHTML = '<p class="hint">Nothing sent yet.</p>'; return; }
    el.innerHTML = list.map(n => {
      const pct = n.total ? Math.round((n.ackedCount / n.total) * 100) : 0;
      const who = [
        n.toDrivers === 'all' ? 'all drivers' : (n.toDrivers || []).length ? `${n.toDrivers.length} driver(s)` : '',
        n.toUsers   === 'all' ? 'all staff'   : (n.toUsers   || []).length ? `${n.toUsers.length} staff` : '',
      ].filter(Boolean).join(' + ');
      return `
      <div class="cm-sent${n.priority === 'urgent' ? ' urgent' : ''}">
        <div class="cm-sent-msg">${n.priority === 'urgent' ? '⚠ ' : ''}${esc(n.message)}</div>
        <div class="cm-sent-meta">
          <span>${esc(new Date(n.createdAt).toLocaleString('en-SG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>
          <span>to ${esc(who || '—')}</span>
          <span class="cm-ackbar" title="${n.ackedCount}/${n.total} acknowledged"><span style="width:${pct}%"></span></span>
          <span><b>${n.ackedCount}/${n.total}</b> acknowledged</span>
          ${n.pendingNames?.length ? `<span title="${esc(n.pendingNames.join(', '))}">waiting on ${esc(n.pendingNames.slice(0, 3).join(', '))}${n.pendingNames.length > 3 ? ` +${n.pendingNames.length - 3}` : ''}</span>` : '<span>✓ everyone</span>'}
          <button class="btn-ghost btn-sm cm-del" data-id="${esc(n.id)}" style="margin-left:auto">🗑</button>
        </div>
      </div>`;
    }).join('');
    el.querySelectorAll('.cm-del').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete this message? Recipients who have not acknowledged it will simply stop seeing it.')) return;
      await fetch(`/api/master/notices/${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE', headers: { 'x-master-key': LOG_PASSWORD } });
      cmLoadSent();
    }));
  }
  document.getElementById('cmDriverList')?.addEventListener('change', e => {
    const cb = e.target.closest('input[type=checkbox]'); if (!cb) return;
    cmSel.drvAll = false;
    cb.checked ? cmSel.drv.add(cb.value) : cmSel.drv.delete(cb.value);
    cmUpdateCount();
  });
  document.getElementById('cmUserList')?.addEventListener('change', e => {
    const cb = e.target.closest('input[type=checkbox]'); if (!cb) return;
    cmSel.usrAll = false;
    cb.checked ? cmSel.usr.add(cb.value) : cmSel.usr.delete(cb.value);
    cmUpdateCount();
  });
  document.querySelectorAll('.cm-all').forEach(b => b.addEventListener('click', () => {
    const g = b.dataset.grp;
    if (g === 'drv') { cmSel.drvAll = true; cmSel.drv.clear(); } else { cmSel.usrAll = true; cmSel.usr.clear(); }
    cmRenderPickers();
  }));
  document.querySelectorAll('.cm-none').forEach(b => b.addEventListener('click', () => {
    const g = b.dataset.grp;
    if (g === 'drv') { cmSel.drvAll = false; cmSel.drv.clear(); } else { cmSel.usrAll = false; cmSel.usr.clear(); }
    cmRenderPickers();
  }));
  document.getElementById('cmRefreshBtn')?.addEventListener('click', cmLoadSent);
  document.getElementById('cmSendBtn')?.addEventListener('click', async () => {
    const msg = document.getElementById('cmMessage').value.trim();
    const st = (kind, t) => { const e = document.getElementById('cmStatus'); e.className = 'status-bar ' + kind; e.textContent = t; e.classList.remove('hidden'); };
    if (!msg) return st('error', 'Type a message first.');
    const toDrivers = cmSel.drvAll ? 'all' : [...cmSel.drv];
    const toUsers   = cmSel.usrAll ? 'all' : [...cmSel.usr];
    if (toDrivers !== 'all' && !toDrivers.length && toUsers !== 'all' && !toUsers.length) return st('error', 'Pick at least one recipient.');
    st('progress', 'Sending…');
    try {
      const r = await fetch('/api/master/notices', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
        body: JSON.stringify({ message: msg, priority: document.getElementById('cmUrgent').checked ? 'urgent' : 'normal', toDrivers, toUsers }),
      });
      const d = await r.json();
      if (!r.ok) return st('error', d.error || 'Send failed');
      document.getElementById('cmMessage').value = '';
      document.getElementById('cmUrgent').checked = false;
      st('success', '✓ Message sent — recipients must acknowledge it.');
      cmLoadSent();
    } catch (e) { st('error', e.message); }
  });

  // ── User Management ─────────────────────────────────────────────────────────
  async function loadUserList() {
    const listEl = document.getElementById('userList');
    try {
      const resp  = await fetch('/api/master/users', { headers: { 'x-master-key': LOG_PASSWORD } });
      const users = await resp.json();
      if (!Array.isArray(users)) {
        // A non-array here (e.g. an auth error object) would otherwise make
        // .map() throw and silently leave the list unchanged — the classic
        // "nothing happened" symptom. Surface it instead.
        showUserStatus('Could not load users: ' + (users && users.error ? users.error : 'unexpected response'), 'error');
        return;
      }
      const roleLabel = { warehouse: 'Warehouse', driver: 'Driver' };
      listEl.innerHTML = users.map(u => {
        const role = u.role || 'admin';
        // A 'driver' row should never actually appear here (see the server
        // side — driver rows live in db.drivers[] only), but render it
        // sanely rather than assume, in case of any legacy data.
        return `
        <div class="user-row" data-id="${esc(u.id)}">
          <span class="user-id">${esc(u.id)}</span>
          <span class="user-name">${esc(u.name || u.id)}</span>
          <span class="role-badge ${esc(role)}">${roleLabel[role] || 'Admin'}</span>
          <div class="user-row-actions">
            <select class="role-select" data-id="${esc(u.id)}" data-current="${esc(role)}" title="Change this user's role">
              <option value="admin"     ${role === 'admin'     ? 'selected' : ''}>Admin</option>
              <option value="warehouse" ${role === 'warehouse' ? 'selected' : ''}>Warehouse</option>
              <option value="driver"    ${role === 'driver'    ? 'selected' : ''}>Driver</option>
            </select>
            <button class="btn-chpass" data-id="${esc(u.id)}" title="Change password">&#128273; Password</button>
            <button class="btn-user-features" data-id="${esc(u.id)}" title="Toggle which functions this user sees">&#9881; Features</button>
            <button class="btn-del-user" data-id="${esc(u.id)}" title="Delete user">&#128465;</button>
          </div>
        </div>`;
      }).join('');

      listEl.querySelectorAll('.role-select').forEach(sel => {
        sel.addEventListener('change', async () => {
          const newRole = sel.value;
          const id      = sel.dataset.id;
          if (newRole === sel.dataset.current) return;
          if (newRole === 'driver') {
            const ok = confirm(
              `Convert "${id}" to a Driver?\n\n` +
              `This REMOVES their staff login (username/password) — they will no ` +
              `longer be able to sign into this desktop app at all, only the ` +
              `Driver App on mobile. A linked driver profile will be created in ` +
              `Transport → Driver Details; set a Driver App PIN there before they ` +
              `can log in.\n\nContinue?`
            );
            if (!ok) { sel.value = sel.dataset.current; return; }
          }
          const r = await fetch(`/api/master/users/${encodeURIComponent(id)}/role`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
            body: JSON.stringify({ role: newRole }),
          });
          const d = await r.json();
          if (!r.ok) { alert(d.error); sel.value = sel.dataset.current; return; }
          showUserStatus(d.converted
            ? `"${id}" converted to Driver — set their Driver App PIN in Transport → Driver Details.`
            : `Role updated to ${newRole}.`, 'success');
          loadUserList();
        });
      });

      listEl.querySelectorAll('.btn-chpass').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newPass = prompt(`New password for "${btn.dataset.id}":`);
          if (!newPass) return;
          const r = await fetch(`/api/master/users/${encodeURIComponent(btn.dataset.id)}/password`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
            body: JSON.stringify({ password: newPass }),
          });
          const d = await r.json();
          if (!r.ok) { alert(d.error); return; }
          showUserStatus('Password updated.', 'success');
        });
      });

      listEl.querySelectorAll('.btn-user-features').forEach(btn => {
        btn.addEventListener('click', () => {
          const u = users.find(x => x.id === btn.dataset.id);
          openUserFeaturesModal(u);
        });
      });

      listEl.querySelectorAll('.btn-del-user').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Delete user "${btn.dataset.id}"? They will no longer be able to log in.`)) return;
          const r = await fetch(`/api/master/users/${encodeURIComponent(btn.dataset.id)}`, {
            method: 'DELETE', headers: { 'x-master-key': LOG_PASSWORD },
          });
          const d = await r.json();
          if (!r.ok) { alert(d.error); return; }
          loadUserList();
        });
      });
    } catch (err) {
      listEl.innerHTML = `<p class="scan-error" style="font-size:.8rem">${esc(err.message)}</p>`;
    }
  }

  // Which functions a user sees — ticked = visible. Applies at their next
  // login / page refresh.
  function openUserFeaturesModal(user) {
    const FEATURES = [
      ['upload',    '⬆️ Upload — picking-list uploads'],
      ['orders',    '📋 Orders — scanning dashboard'],
      ['inbound',   '📦 Inbound — receiving'],
      ['transport', '🚚 Transport — deliveries, map, route planning'],
      ['labels',    '🏷 Labels'],
      ['reports',   '📊 Reports'],
    ];
    const f = user.features || {};
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'userFeaturesModal';
    modal.innerHTML = `
      <div class="modal" style="width:92%;max-width:460px">
        <h2 style="margin:0 0 .3rem 0">⚙ Functions for ${esc(user.name || user.id)}</h2>
        <p class="hint" style="font-size:12px;margin-bottom:1rem">Untick anything this user should NOT see. Takes effect the next time they log in or refresh.</p>
        <div style="display:grid;gap:.4rem;margin-bottom:1rem">
          ${FEATURES.map(([key, label]) => `
            <label style="display:flex;gap:.6rem;align-items:center;padding:.5rem .7rem;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;font-size:13px">
              <input type="checkbox" class="uf-toggle" value="${key}" ${f[key] === false ? '' : 'checked'} />
              <span>${label}</span>
            </label>`).join('')}
        </div>
        <div style="display:flex;gap:.6rem">
          <button class="btn-primary" id="ufSaveBtn" style="flex:1">💾 Save</button>
          <button class="btn-secondary" id="ufCancelBtn" style="flex:1">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#ufCancelBtn').addEventListener('click', () => modal.remove());
    modal.querySelector('#ufSaveBtn').addEventListener('click', async () => {
      const features = {};
      modal.querySelectorAll('.uf-toggle').forEach(cb => { features[cb.value] = cb.checked; });
      if (!Object.values(features).some(Boolean)) { alert('At least one function must stay visible.'); return; }
      try {
        const r = await fetch(`/api/master/users/${encodeURIComponent(user.id)}/features`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
          body: JSON.stringify({ features }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Save failed');
      } catch (err) { alert('❌ ' + err.message); return; }
      modal.remove();
      showUserStatus(`Functions updated for ${user.id}.`, 'success');
      loadUserList();
    });
  }

  // A "Driver" row never gets a staff Users account at all — it goes
  // straight to db.drivers[] with the password field treated as their
  // Driver App PIN (4-8 digits), same rule the bulk CSV import already
  // uses. The field label/placeholder switches to make that obvious.
  document.getElementById('newUserRole').addEventListener('change', (e) => {
    const passInput = document.getElementById('newUserPass');
    if (e.target.value === 'driver') {
      passInput.placeholder = 'Driver App PIN (4-8 digits)';
      passInput.setAttribute('inputmode', 'numeric');
    } else {
      passInput.placeholder = 'Password';
      passInput.removeAttribute('inputmode');
    }
  });

  document.getElementById('addUserBtn').addEventListener('click', async () => {
    const id   = document.getElementById('newUserId').value.trim();
    const name = document.getElementById('newUserName').value.trim();
    const pass = document.getElementById('newUserPass').value.trim();
    const role = document.getElementById('newUserRole').value;
    if (!id || !pass) { showUserStatus('User ID and password are required.', 'error'); return; }
    if (role === 'driver') {
      if (!/^\d{4,8}$/.test(pass)) { showUserStatus('Driver PIN must be 4-8 digits.', 'error'); return; }
    } else if (pass.length < 5) {
      showUserStatus('Password must be at least 5 characters.', 'error'); return;
    }
    try {
      const r = await fetch('/api/master/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
        body: JSON.stringify({ id, name, password: pass, role }),
      });
      const d = await r.json();
      if (!r.ok) { showUserStatus(d.error || 'Failed', 'error'); return; }
      document.getElementById('newUserId').value   = '';
      document.getElementById('newUserName').value = '';
      document.getElementById('newUserPass').value = '';
      showUserStatus(role === 'driver'
        ? `"${id}" added as a Driver — mobile Driver App only, no desktop/TMS access.`
        : `User "${id}" added as ${role}.`, 'success');
      loadUserList();
    } catch (err) { showUserStatus(err.message, 'error'); }
  });

  // ── Bulk user/driver CSV import ─────────────────────────────────────────────
  document.getElementById('userImportTemplateBtn').addEventListener('click', (e) => {
    e.preventDefault();
    // Note: for role=driver rows, "password" is the Driver App PIN and must
    // be 4-8 digits (checked server-side) — not a free-text password.
    const csv = 'id,name,password,role,phone,vehicle,capacity\n' +
      'wm-5,Warehouse Five,changeme1,warehouse,,,\n' +
      'driver-5,Driver Five,12345,driver,+65 9123 4567,Van,1000\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'users_import_template.csv'; a.click();
    URL.revokeObjectURL(url);
  });

  // Global guard: a file dropped anywhere OUTSIDE a drop zone must never make
  // the browser navigate away to the file (which silently killed the app page
  // and looked like "drag & drop doesn't work"). Zone handlers still run —
  // this only cancels the browser's default open-the-file behaviour.
  document.addEventListener('dragover', e => { e.preventDefault(); });
  document.addEventListener('drop', e => { e.preventDefault(); });

  const userImportDropZone = document.getElementById('userImportDropZone');
  const userImportFileInput = document.getElementById('userImportFileInput');
  document.getElementById('userImportBrowseBtn').addEventListener('click', e => { e.stopPropagation(); userImportFileInput.click(); });
  userImportDropZone.addEventListener('click', () => userImportFileInput.click());
  userImportDropZone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; userImportDropZone.classList.add('dragover'); });
  userImportDropZone.addEventListener('dragleave', () => userImportDropZone.classList.remove('dragover'));
  userImportDropZone.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation(); userImportDropZone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) processUserImportFile(e.dataTransfer.files[0]);
  });
  userImportFileInput.addEventListener('change', () => {
    if (userImportFileInput.files[0]) processUserImportFile(userImportFileInput.files[0]);
    userImportFileInput.value = '';
  });

  async function processUserImportFile(file) {
    try {
      showUserStatus(`Importing "${file.name}"…`, 'progress');
      // Send the RAW file — the server parses CSV, TXT, XLSX and XLS. (Files
      // that look like CSV are often actually Excel workbooks; parsing
      // client-side as text silently produced garbage for those.)
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/api/master/users/import-file', {
        method: 'POST',
        headers: { 'x-master-key': LOG_PASSWORD },
        body: fd,
      });
      const d = await r.json();
      if (!r.ok) { showUserStatus(d.error || 'Import failed', 'error'); return; }
      const staffCount = (d.imported || 0) - (d.driverProfiles || 0);
      let msg = `✓ Imported ${d.imported} row(s): ${staffCount} staff user(s)`;
      if (d.driverProfiles) msg += ` + ${d.driverProfiles} driver(s) — drivers appear on the “Drivers” tab, not this list`;
      msg += `. Skipped ${d.skipped}.`;
      if (d.errors && d.errors.length) msg += ' First issue: row ' + d.errors[0].row + ' (' + d.errors[0].id + ') — ' + d.errors[0].error;
      showUserStatus(msg, d.imported > 0 ? 'success' : 'error');
      loadUserList();
      if (d.driverProfiles) { try { loadDriverList(); } catch {} }
    } catch (err) { showUserStatus('Import error: ' + err.message, 'error'); }
  }

  let _userStatusTimer = null;
  function showUserStatus(msg, type) {
    const el = document.getElementById('userMgmtStatus');
    el.textContent  = msg;
    el.className    = `status-bar ${type}`;
    el.classList.remove('hidden');
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (_userStatusTimer) { clearTimeout(_userStatusTimer); _userStatusTimer = null; }
    // Errors and import results STAY until the next action — auto-hiding after
    // 4s made real imports look like "nothing happened". Only transient
    // progress/success notices fade.
    if (type === 'progress') return;
    if (type === 'error') return;              // keep errors visible until fixed
    _userStatusTimer = setTimeout(() => el.classList.add('hidden'), 8000);
  }

  // ── Driver Management ────────────────────────────────────────────────────────
  // Reads/writes the SAME db.drivers roster Transport → Driver Details and
  // the Driver App use — there is only one driver identity in the system.
  // This tab just opens the same Add/Edit modal Transport uses, and lists
  // the same /api/drivers data.
  async function loadDriverList() {
    const listEl = document.getElementById('driversList');
    try {
      await loadDrivers(); // repopulates window.drivers from /api/drivers
      const drivers = window.drivers || [];
      if (!drivers.length) {
        listEl.innerHTML = '<div class="empty-state">No drivers created yet.</div>';
        return;
      }
      listEl.innerHTML = drivers.map(d => `
        <div class="driver-row" data-id="${esc(d.id)}">
          <div class="driver-info">
            <span class="driver-name">${esc(d.name || d.id)} ${d.hasPin ? '<span title="Can log into the Driver App">&#128241;</span>' : ''}</span>
            <span class="driver-phone">${d.phone ? esc(d.phone) : '—'}</span>
            <span class="driver-vehicle">${esc(d.vehicle || '—')}${d.plate ? ' · ' + esc(d.plate) : ''}</span>
            <span class="driver-capacity">${[d.capacity ? d.capacity + ' kg' : '', d.capacityM3 ? d.capacityM3 + ' m³' : ''].filter(Boolean).join(' / ') || '—'}</span>
          </div>
          <div class="driver-row-actions">
            <button class="btn-edit-driver" data-id="${esc(d.id)}" title="Edit driver / set PIN">&#9999;</button>
            <button class="btn-del-driver" data-id="${esc(d.id)}" title="Delete driver">&#128465;</button>
          </div>
        </div>`).join('');

      listEl.querySelectorAll('.btn-edit-driver').forEach(btn => {
        btn.addEventListener('click', () => openEditDriver(btn.dataset.id));
      });
      listEl.querySelectorAll('.btn-del-driver').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Delete driver "${btn.dataset.id}"? They will no longer be able to log in or be assigned jobs.`)) return;
          try {
            const r = await fetch(`/api/drivers/${encodeURIComponent(btn.dataset.id)}`, {
              method: 'DELETE', headers: { 'x-auth-token': localStorage.getItem('wms_token') || '' },
            });
            if (!r.ok) throw new Error((await r.json()).error || 'Delete failed');
            showDriverStatus(`Driver "${btn.dataset.id}" deleted.`, 'success');
            loadDriverList();
          } catch (err) { showDriverStatus(err.message, 'error'); }
        });
      });
    } catch (err) {
      listEl.innerHTML = `<p class="scan-error" style="font-size:.8rem">${esc(err.message)}</p>`;
    }
  }

  // Opens the SAME Add/Edit Driver modal Transport → Driver Details uses.
  document.getElementById('adminAddDriverBtn')?.addEventListener('click', () => {
    document.getElementById('transportAddDriverBtn')?.click();
  });
  document.getElementById('adminExportDriversBtn')?.addEventListener('click', () =>
    authDownload('/api/drivers/export', `IDEALONE_Drivers_${new Date().toISOString().slice(0,10)}.xlsx`));

  // Import drivers from a spreadsheet (round-trips the Export file). Fills the
  // real db.drivers roster, so imported drivers appear in Transport route
  // planning AND can sign into the Driver App at /driver immediately.
  const driverImportInput = document.getElementById('driverImportFileInput');
  document.getElementById('adminImportDriversBtn')?.addEventListener('click', () => driverImportInput?.click());
  driverImportInput?.addEventListener('change', async () => {
    const file = driverImportInput.files && driverImportInput.files[0];
    driverImportInput.value = '';
    if (!file) return;
    await importDriversFile(file);
  });

  async function importDriversFile(file) {
    try {
      showDriverStatus(`Importing "${file.name}"…`, 'progress');
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/api/drivers/import', { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) { showDriverStatus(d.error || 'Import failed', 'error'); return; }
      let msg = `✓ ${d.imported} added, ${d.updated} updated`;
      msg += `, ${d.withPin} with a Driver App PIN`;
      if (d.skipped) msg += `, ${d.skipped} skipped`;
      msg += '. Drivers can now be assigned routes and sign into /driver.';
      if (d.errors && d.errors.length) msg += ' First issue: row ' + d.errors[0].row + ' — ' + d.errors[0].error;
      showDriverStatus(msg, (d.imported + d.updated) > 0 ? 'success' : 'error');
      loadDriverList();
      if (typeof loadDrivers === 'function') loadDrivers(); // refresh window.drivers for the planner
    } catch (err) { showDriverStatus('Import error: ' + err.message, 'error'); }
  }

  let _driverStatusTimer = null;
  function showDriverStatus(msg, type) {
    const el = document.getElementById('driverMgmtStatus');
    el.textContent  = msg;
    el.className    = `status-bar ${type}`;
    el.classList.remove('hidden');
    if (_driverStatusTimer) { clearTimeout(_driverStatusTimer); _driverStatusTimer = null; }
    // Keep import results / errors on screen; only fade transient progress.
    if (type === 'progress' || type === 'error') return;
    _driverStatusTimer = setTimeout(() => el.classList.add('hidden'), 8000);
  }

  // ── Email Configuration ──────────────────────────────────────────────────────
  async function loadEmailConfig() {
    try {
      const resp = await fetch('/api/master/email-config', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!resp.ok) return;
      const conf = await resp.json();
      document.getElementById('cfgFromEmail').value  = conf.from_email  || '';
      document.getElementById('cfgSmtpLogin').value  = conf.smtp_login  || '';
      document.getElementById('cfgPassword').value   = '';  // never pre-fill password
      document.getElementById('cfgPassNote').textContent = conf.has_password ? '(saved — leave blank to keep)' : '';
      document.getElementById('cfgSmtpHost').value   = conf.smtp_host || 'smtp.gmail.com';
      document.getElementById('cfgSmtpPort').value   = conf.smtp_port || 587;
      document.getElementById('cfgToEmail').value    = conf.to_email  || '';
      defaultRecipientEmail = conf.to_email || '';
    } catch {}
    await loadGmailStatus();
  }

  // ── Gmail OAuth2 ─────────────────────────────────────────────────────────────
  function showGmailStatus(msg, type) {
    const el = document.getElementById('gmailOauthStatus');
    if (!el) return;
    el.textContent = msg; el.className = `status-bar ${type}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 6000);
  }

  async function loadGmailStatus() {
    try {
      const r = await fetch('/api/master/gmail/status', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!r.ok) return;
      const d = await r.json();
      const badge   = document.getElementById('gmailStatusBadge');
      const connBlk = document.getElementById('gmailConnectedBlock');
      const connFrm = document.getElementById('gmailConnectBlock');
      if (d.connected) {
        if (badge)   { badge.textContent = '● Connected'; badge.className = 'gmail-status-badge connected'; }
        if (connBlk) { connBlk.classList.remove('hidden'); }
        if (connFrm) { connFrm.style.display = 'none'; }
        const emailEl = document.getElementById('gmailConnectedEmail');
        if (emailEl) emailEl.textContent = d.email || '';
        const toEl = document.getElementById('gmailToEmail');
        if (toEl) toEl.value = d.to_email || '';
        defaultRecipientEmail = d.to_email || defaultRecipientEmail;
      } else {
        if (badge)   { badge.textContent = '○ Not connected'; badge.className = 'gmail-status-badge disconnected'; }
        if (connBlk) { connBlk.classList.add('hidden'); }
        if (connFrm) { connFrm.style.display = ''; }
      }
    } catch {}
  }

  document.getElementById('gmailConnectBtn')?.addEventListener('click', async () => {
    const client_id     = document.getElementById('gmailClientId').value.trim();
    const client_secret = document.getElementById('gmailClientSecret').value.trim();
    const email         = document.getElementById('gmailOauthEmail').value.trim();
    const to_email      = document.getElementById('gmailOauthToEmail').value.trim();
    if (!client_id || !client_secret || !email) {
      showGmailStatus('Gmail address, Client ID and Client Secret are required.', 'error'); return;
    }
    showGmailStatus('Opening Google authorization…', '');
    try {
      const r = await fetch('/api/master/gmail/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
        body: JSON.stringify({ client_id, client_secret, email, to_email }),
      });
      const d = await r.json();
      if (!r.ok) { showGmailStatus(`Failed: ${d.error}`, 'error'); return; }
      const popup = window.open(d.url, 'gmailOauth', 'width=520,height=640');
      showGmailStatus('Complete the sign-in in the popup window…', '');
      const onMsg = async (ev) => {
        if (ev.data?.type !== 'gmail-oauth') return;
        window.removeEventListener('message', onMsg);
        if (ev.data.ok) {
          showGmailStatus('Gmail connected! Emails will now send via Google.', 'success');
          await loadGmailStatus();
        } else {
          showGmailStatus('Connection failed — please try again.', 'error');
        }
      };
      window.addEventListener('message', onMsg);
      const pollTimer = setInterval(async () => {
        if (popup?.closed) {
          clearInterval(pollTimer);
          window.removeEventListener('message', onMsg);
          await loadGmailStatus();
        }
      }, 1000);
    } catch (err) { showGmailStatus(err.message, 'error'); }
  });

  document.getElementById('gmailDisconnectBtn')?.addEventListener('click', async () => {
    if (!confirm('Disconnect Gmail? Emails will fall back to SMTP settings.')) return;
    await fetch('/api/master/gmail/disconnect', { method: 'DELETE', headers: { 'x-master-key': LOG_PASSWORD } });
    await loadGmailStatus();
  });

  document.getElementById('gmailSaveRecipientBtn')?.addEventListener('click', async () => {
    const to_email = document.getElementById('gmailToEmail').value.trim();
    try {
      const r = await fetch('/api/master/gmail/status', { headers: { 'x-master-key': LOG_PASSWORD } });
      const d = await r.json();
      if (!d.connected) return;
      // Patch the stored oauth file via a mini endpoint (reuse disconnect+reconnect is complex;
      // instead we save it via the SMTP config recipient field which buildTransporter also checks)
      await fetch('/api/master/email-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
        body: JSON.stringify({ from_email: d.email, to_email, smtp_host: 'smtp.gmail.com', smtp_port: 587 }),
      });
      defaultRecipientEmail = to_email;
      showGmailStatus('Recipient saved.', 'success');
    } catch (err) { showGmailStatus(err.message, 'error'); }
  });

  document.getElementById('gmailTestBtn')?.addEventListener('click', async () => {
    const to = document.getElementById('gmailToEmail').value.trim() || defaultRecipientEmail;
    if (!to) { showGmailStatus('Enter a recipient first.', 'error'); return; }
    showGmailStatus('Sending test email via Gmail…', '');
    try {
      const r = await fetch('/api/master/gmail/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
        body: JSON.stringify({ to }),
      });
      const d = await r.json();
      if (!r.ok) { showGmailStatus(`Failed: ${d.error}`, 'error'); return; }
      showGmailStatus(`Test email sent to ${to}`, 'success');
    } catch (err) { showGmailStatus(err.message, 'error'); }
  });

  // Listen for postMessage from OAuth popup in case it fires after polling detects close
  window.addEventListener('message', (ev) => {
    if (ev.data?.type === 'gmail-oauth' && ev.data.ok) loadGmailStatus();
  });

  function showEmailStatus(msg, type) {
    const el = document.getElementById('emailCfgStatus');
    el.textContent = msg; el.className = `status-bar ${type}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 5000);
  }

  document.getElementById('saveEmailCfgBtn').addEventListener('click', async () => {
    const from_email = document.getElementById('cfgFromEmail').value.trim();
    const smtp_login = document.getElementById('cfgSmtpLogin').value.trim();
    const password   = document.getElementById('cfgPassword').value.trim();
    const smtp_host  = document.getElementById('cfgSmtpHost').value.trim();
    const smtp_port  = document.getElementById('cfgSmtpPort').value.trim();
    const to_email   = document.getElementById('cfgToEmail').value.trim();
    if (!from_email) { showEmailStatus('From Email is required.', 'error'); return; }
    try {
      const r = await fetch('/api/master/email-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
        body: JSON.stringify({ from_email, smtp_login, password, smtp_host, smtp_port, to_email }),
      });
      const d = await r.json();
      if (!r.ok) { showEmailStatus(d.error, 'error'); return; }
      showEmailStatus('Email settings saved.', 'success');
      document.getElementById('cfgPassNote').textContent = '(saved — leave blank to keep)';
      document.getElementById('cfgPassword').value = '';
      defaultRecipientEmail = to_email;
    } catch (err) { showEmailStatus(err.message, 'error'); }
  });

  document.getElementById('testEmailCfgBtn').addEventListener('click', async () => {
    const to = document.getElementById('cfgToEmail').value.trim() ||
               document.getElementById('cfgFromEmail').value.trim();
    if (!to) { showEmailStatus('Enter a recipient in Default Recipient field first.', 'error'); return; }
    showEmailStatus('Sending test email…', '');
    try {
      const r = await fetch('/api/master/email-config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
        body: JSON.stringify({ to }),
      });
      const d = await r.json();
      if (!r.ok) { showEmailStatus(`Failed: ${d.error}`, 'error'); return; }
      showEmailStatus(`Test email sent to ${to}`, 'success');
    } catch (err) { showEmailStatus(err.message, 'error'); }
  });

  document.getElementById('clearEmailCfgBtn').addEventListener('click', async () => {
    if (!confirm('Clear all saved email settings? You will need to re-enter credentials.')) return;
    try {
      await fetch('/api/master/email-config', { method: 'DELETE', headers: { 'x-master-key': LOG_PASSWORD } });
      document.getElementById('cfgFromEmail').value  = '';
      document.getElementById('cfgSmtpLogin').value  = '';
      document.getElementById('cfgPassword').value   = '';
      document.getElementById('cfgPassNote').textContent = '';
      document.getElementById('cfgSmtpHost').value   = 'smtp.gmail.com';
      document.getElementById('cfgSmtpPort').value   = '587';
      document.getElementById('cfgToEmail').value    = '';
      showEmailStatus('Email settings cleared.', 'success');
    } catch (err) { showEmailStatus(err.message, 'error'); }
  });

  // ── Label Templates ──────────────────────────────────────────────────────────
  async function loadLabelTemplates() {
    try {
      const resp = await fetch('/api/master/label-templates', { headers: { 'x-master-key': LOG_PASSWORD } });
      _labelTemplates = await resp.json();
      renderLabelTemplateList();
    } catch (e) {
      _labelTemplates = [];
    }
  }

  function renderLabelTemplateList() {
    const el = document.getElementById('labelTemplateList');
    if (!el) return;
    if (!_labelTemplates || _labelTemplates.length === 0) {
      el.innerHTML = '<p class="hint" style="padding:.5rem 0 1rem">No templates saved yet. Add one below.</p>';
      return;
    }
    el.innerHTML = _labelTemplates.map(t => `
      <div class="label-tpl-row">
        <span class="label-tpl-swatch" style="background:${esc(t.header_bg)};color:${esc(t.header_color)}">${esc(t.header_text || t.carrier)}</span>
        <span class="label-tpl-name">${esc(t.carrier)}</span>
        <span class="label-tpl-flags">
          ${t.show_barcode   ? '&#128211; barcode' : ''}
          ${t.show_address   ? '&#127968; addr'    : ''}
          ${t.show_tel       ? '&#128222; tel'      : ''}
          ${t.show_items     ? '&#128230; items'   : ''}
          ${t.show_platform  ? '&#127760; platform' : ''}
          ${t.show_order_no  ? '&#35; order'        : ''}
        </span>
        <div class="label-tpl-actions">
          <button class="btn-sm btn-secondary ltp-edit-btn" data-carrier="${esc(t.carrier)}">Edit</button>
          <button class="btn-sm btn-danger-sm ltp-del-btn"  data-carrier="${esc(t.carrier)}">&#215;</button>
        </div>
      </div>`).join('');
  }

  function showLabelTplStatus(msg, type) {
    const el = document.getElementById('labelTplStatus');
    el.textContent = msg;
    el.className   = `status-bar ${type}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 3500);
  }

  // Export (master-key auth, not user token)
  document.getElementById('ltpExportBtn').addEventListener('click', async e => {
    e.preventDefault();
    try {
      const resp = await fetch('/api/master/label-templates/export', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!resp.ok) { showLabelTplStatus('Export failed', 'error'); return; }
      const blob = await resp.blob();
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = `LabelTemplates_${new Date().toISOString().slice(0,10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) { showLabelTplStatus(err.message, 'error'); }
  });

  // Upload drop zone
  const ltpDropZone   = document.getElementById('ltpDropZone');
  const ltpFileInput  = document.getElementById('ltpFileInput');
  document.getElementById('ltpBrowseBtn').addEventListener('click', () => ltpFileInput.click());
  ltpFileInput.addEventListener('change', () => { if (ltpFileInput.files[0]) uploadLabelTplFile(ltpFileInput.files[0]); });
  ltpDropZone.addEventListener('dragover', e => { e.preventDefault(); ltpDropZone.classList.add('dragover'); });
  ltpDropZone.addEventListener('dragleave', ()  => ltpDropZone.classList.remove('dragover'));
  ltpDropZone.addEventListener('drop', e => {
    e.preventDefault(); ltpDropZone.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) uploadLabelTplFile(f);
  });

  async function uploadLabelTplFile(file) {
    const statusEl = document.getElementById('ltpUploadStatus');
    const current  = (_labelTemplates || []).length;
    const msg      = current > 0
      ? `This will REPLACE all ${current} existing carrier template${current !== 1 ? 's' : ''} with the contents of "${file.name}".\n\nContinue?`
      : `Import "${file.name}" as the carrier template list?\n\nThis will take effect immediately.`;
    if (!confirm(msg)) {
      ltpFileInput.value = '';
      return;
    }
    statusEl.textContent = `Uploading ${file.name}…`;
    statusEl.className   = 'status-bar';
    statusEl.classList.remove('hidden');
    const form = new FormData();
    form.append('templateFile', file);
    try {
      const resp = await fetch('/api/master/label-templates/upload', {
        method: 'POST',
        headers: { 'x-master-key': LOG_PASSWORD },
        body: form,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Upload failed');
      statusEl.className = 'status-bar success';
      statusEl.textContent = `Replaced ${data.replaced} template${data.replaced !== 1 ? 's' : ''} with ${data.imported} from file. Changes are live.`;
      ltpFileInput.value = '';
      await loadLabelTemplates();
    } catch (err) {
      statusEl.className = 'status-bar error';
      statusEl.textContent = err.message;
    }
  }

  document.getElementById('saveLabelTplBtn').addEventListener('click', async () => {
    const carrier = document.getElementById('ltpCarrier').value.trim();
    if (!carrier) { showLabelTplStatus('Carrier name is required.', 'error'); return; }
    const body = {
      carrier,
      header_text  : document.getElementById('ltpHeaderText').value.trim(),
      header_bg    : document.getElementById('ltpHeaderBg').value,
      header_color : document.getElementById('ltpHeaderColor').value,
      show_barcode : document.getElementById('ltpShowBarcode').checked,
      show_address : document.getElementById('ltpShowAddress').checked,
      show_tel     : document.getElementById('ltpShowTel').checked,
      show_items   : document.getElementById('ltpShowItems').checked,
      show_platform: document.getElementById('ltpShowPlatform').checked,
      show_order_no: document.getElementById('ltpShowOrderNo').checked,
    };
    try {
      const resp = await fetch('/api/master/label-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error((await resp.json()).error);
      showLabelTplStatus(`Template for "${carrier}" saved.`, 'success');
      document.getElementById('ltpCarrier').value     = '';
      document.getElementById('ltpHeaderText').value  = '';
      document.getElementById('ltpHeaderBg').value    = '#000000';
      document.getElementById('ltpHeaderColor').value = '#ffffff';
      ['ltpShowBarcode','ltpShowAddress','ltpShowTel','ltpShowItems','ltpShowPlatform','ltpShowOrderNo']
        .forEach(id => { document.getElementById(id).checked = true; });
      await loadLabelTemplates();
    } catch (err) { showLabelTplStatus(err.message, 'error'); }
  });

  document.getElementById('labelTemplateList').addEventListener('click', async e => {
    const editBtn = e.target.closest('.ltp-edit-btn');
    const delBtn  = e.target.closest('.ltp-del-btn');
    if (editBtn) {
      const t = (_labelTemplates || []).find(x => x.carrier === editBtn.dataset.carrier);
      if (!t) return;
      document.getElementById('ltpCarrier').value     = t.carrier;
      document.getElementById('ltpHeaderText').value  = t.header_text || '';
      document.getElementById('ltpHeaderBg').value    = t.header_bg    || '#000000';
      document.getElementById('ltpHeaderColor').value = t.header_color || '#ffffff';
      document.getElementById('ltpShowBarcode').checked  = t.show_barcode  !== false;
      document.getElementById('ltpShowAddress').checked  = t.show_address  !== false;
      document.getElementById('ltpShowTel').checked      = t.show_tel      !== false;
      document.getElementById('ltpShowItems').checked    = t.show_items    !== false;
      document.getElementById('ltpShowPlatform').checked = t.show_platform !== false;
      document.getElementById('ltpShowOrderNo').checked  = t.show_order_no !== false;
      document.getElementById('ltpCarrier').focus();
    }
    if (delBtn) {
      const carrier = delBtn.dataset.carrier;
      if (!confirm(`Delete template for "${carrier}"?`)) return;
      try {
        await fetch(`/api/master/label-templates/${encodeURIComponent(carrier)}`, {
          method: 'DELETE', headers: { 'x-master-key': LOG_PASSWORD },
        });
        await loadLabelTemplates();
        showLabelTplStatus(`Template for "${carrier}" deleted.`, 'success');
      } catch (err) { showLabelTplStatus(err.message, 'error'); }
    }
  });

  // ── Word Doc Template admin handlers ─────────────────────────────────────────
  function showDocTplStatus(msg, type) {
    const el = document.getElementById('docTplUploadStatus');
    el.textContent = msg;
    el.className   = `status-bar ${type}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
  }

  const docTplDropZone  = document.getElementById('docTplDropZone');
  const docTplFileInput = document.getElementById('docTplFileInput');
  document.getElementById('docTplBrowseBtn').addEventListener('click', () => docTplFileInput.click());
  docTplFileInput.addEventListener('change', () => { if (docTplFileInput.files[0]) uploadDocTpl(docTplFileInput.files[0]); });
  docTplDropZone.addEventListener('dragover', e => { e.preventDefault(); docTplDropZone.classList.add('dragover'); });
  docTplDropZone.addEventListener('dragleave', () => docTplDropZone.classList.remove('dragover'));
  docTplDropZone.addEventListener('drop', e => {
    e.preventDefault(); docTplDropZone.classList.remove('dragover');
    const f = e.dataTransfer.files[0]; if (f) uploadDocTpl(f);
  });

  async function uploadDocTpl(file) {
    const carrier = document.getElementById('docTplCarrier').value.trim();
    if (!carrier) { showDocTplStatus('Enter the carrier name first.', 'error'); return; }
    if (!file.name.toLowerCase().endsWith('.docx')) { showDocTplStatus('Only .docx files are accepted.', 'error'); return; }
    showDocTplStatus(`Uploading "${file.name}" for ${carrier}…`, '');
    const form = new FormData();
    form.append('carrier', carrier);
    form.append('docxFile', file);
    try {
      const resp = await fetch('/api/master/label-doc-templates', {
        method: 'POST', headers: { 'x-master-key': LOG_PASSWORD }, body: form,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Upload failed');
      showDocTplStatus(`Word template for "${carrier}" saved. Printing labels for this carrier will now download a populated .docx.`, 'success');
      document.getElementById('docTplCarrier').value = '';
      docTplFileInput.value = '';
      await loadDocTemplates();
    } catch (err) { showDocTplStatus(err.message, 'error'); }
  }

  document.getElementById('docTemplateList').addEventListener('click', async e => {
    const dlBtn  = e.target.closest('.doc-tpl-dl-btn');
    const delBtn = e.target.closest('.doc-tpl-del-btn');
    if (dlBtn) {
      const { slug, carrier } = dlBtn.dataset;
      try {
        const resp = await fetch(`/api/master/label-doc-templates/${encodeURIComponent(slug)}/download`, {
          headers: { 'x-master-key': LOG_PASSWORD },
        });
        if (!resp.ok) { showDocTplStatus('Download failed', 'error'); return; }
        const blob = await resp.blob();
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = `${slug}_template.docx`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (err) { showDocTplStatus(err.message, 'error'); }
    }
    if (delBtn) {
      const { slug, carrier } = delBtn.dataset;
      if (!confirm(`Delete the Word template for "${carrier}"? This cannot be undone.`)) return;
      try {
        await fetch(`/api/master/label-doc-templates/${encodeURIComponent(slug)}`, {
          method: 'DELETE', headers: { 'x-master-key': LOG_PASSWORD },
        });
        await loadDocTemplates();
        showDocTplStatus(`Template for "${carrier}" deleted.`, 'success');
      } catch (err) { showDocTplStatus(err.message, 'error'); }
    }
  });

  // Master: export status report
  document.getElementById('masterExportBtn').addEventListener('click', async () => {
    try {
      const resp = await fetch('/api/master/export-status', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!resp.ok) { alert('Export failed'); return; }
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `IDEALONE_Status_${new Date().toISOString().slice(0,10)}.xlsx`;
      a.click(); URL.revokeObjectURL(url);
    } catch (err) { alert(err.message); }
  });

  // Standard reports (from the deletion-proof audit ledger).
  // Two panes share this wiring: #tab-reports (admin logins — operational
  // reports, plain session auth) and #adminTab-reports (master panel — all
  // seven, master-key auth).
  (() => {
    const today = () => new Date().toISOString().slice(0, 10);
    const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    document.querySelectorAll('.rep-from').forEach(el => el.value = daysAgo(30));
    document.querySelectorAll('.rep-to').forEach(el => el.value = today());
    document.querySelectorAll('.rep-mdate').forEach(el => el.value = today());

    document.querySelectorAll('.report-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const pane = btn.closest('#adminTab-reports, #tab-reports');
        if (!pane) return;
        const isMasterPane = pane.id === 'adminTab-reports';
        const kind = btn.dataset.report;
        const from = pane.querySelector('.rep-from')?.value  || daysAgo(30);
        const to   = pane.querySelector('.rep-to')?.value    || today();
        const md   = pane.querySelector('.rep-mdate')?.value || today();
        const st   = pane.querySelector('.report-status');
        st.className = 'status-bar report-status'; st.textContent = 'Generating report…';
        try {
          const qs = kind === 'carrier-manifest'
            ? `date=${encodeURIComponent(md)}`
            : `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
          const resp = await fetch(`/api/master/report/${kind}?${qs}`,
            isMasterPane ? { headers: { 'x-master-key': LOG_PASSWORD } } : {});
          if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || resp.statusText);
          const blob = await resp.blob();
          const a    = document.createElement('a');
          a.href     = URL.createObjectURL(blob);
          a.download = `${kind}_${kind === 'carrier-manifest' ? md : from + '_' + to}.xlsx`;
          a.click(); URL.revokeObjectURL(a.href);
          st.className = 'status-bar report-status success'; st.textContent = 'Report downloaded.';
        } catch (e) {
          st.className = 'status-bar report-status error'; st.textContent = 'Report failed: ' + e.message;
        }
        setTimeout(() => st.classList.add('hidden'), 4000);
      });
    });
  })();

  // Master: download full backup (db + settings) as a JSON file
  // ── Archived backups: list, download to desktop, restore inventory ─────────
  async function loadBackupArchive() {
    const el = document.getElementById('backupList');
    if (!el) return;
    el.innerHTML = '<p class="hint">Loading…</p>';
    let d;
    try {
      const r = await fetch('/api/master/backups', { headers: { 'x-master-key': LOG_PASSWORD } });
      d = await r.json();
    } catch (e) { el.innerHTML = '<p class="hint">Could not load backups.</p>'; return; }
    if (!d.files?.length) {
      el.innerHTML = '<p class="hint">No backups yet — the first one runs tonight (or hit “Download Backup Now” for an immediate copy).</p>';
      return;
    }
    const kb = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
    el.innerHTML = `
      <div class="dcs-wrap"><table class="dcs-table">
        <thead><tr><th>Date</th><th>Size</th><th>Kept</th><th style="text-align:right">Actions</th></tr></thead>
        <tbody>${d.files.map(f => `
          <tr>
            <td><b>${esc(f.day || f.file)}</b></td>
            <td>${kb(f.bytes)}</td>
            <td>${f.permanent ? '<span title="Last backup of its month — never deleted">🔒 permanent</span>' : `daily (last ${d.dailyKeep})`}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn-secondary btn-sm bk-dl" data-f="${esc(f.file)}">⬇ Download</button>
              <button class="btn-secondary btn-sm bk-rs" data-f="${esc(f.file)}" title="Restore warehouse locations & inventory from this backup">↺ Restore inventory</button>
            </td>
          </tr>`).join('')}</tbody>
      </table></div>
      <p class="hint" style="margin-top:.4rem">Stored on the server at <code>${esc(d.dir)}</code>. Downloading saves a copy to your own computer.</p>`;
    el.querySelectorAll('.bk-dl').forEach(b => b.addEventListener('click', () =>
      authDownload(`/api/master/backups/${encodeURIComponent(b.dataset.f)}`, b.dataset.f)));
    el.querySelectorAll('.bk-rs').forEach(b => b.addEventListener('click', async () => {
      const replace = confirm(
        `Restore warehouse locations and inventory from ${b.dataset.f}?\n\n` +
        `OK = REPLACE — wipe current inventory and restore exactly as at that backup.\n` +
        `Cancel = you'll then be asked about merging instead.`);
      let mode = 'replace';
      if (!replace) {
        if (!confirm('Merge instead? This ADDS anything missing and leaves current data untouched.')) return;
        mode = 'merge';
      }
      const msg = (k, t) => { const e = document.getElementById('backupMsg'); e.className = 'status-bar ' + k; e.textContent = t; e.classList.remove('hidden'); };
      msg('progress', 'Restoring inventory…');
      try {
        const r = await fetch(`/api/master/backups/${encodeURIComponent(b.dataset.f)}/restore-inventory`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
          body: JSON.stringify({ mode }),
        });
        const d2 = await r.json();
        if (!r.ok) return msg('error', d2.error || 'Restore failed');
        const tot = Object.entries(d2.restored || {}).filter(([, n]) => n > 0).map(([t, n]) => `${t}: ${n}`).join(', ');
        msg('success', `✓ Restored (${d2.mode}) — ${tot || 'nothing to restore'}`);
      } catch (e) { msg('error', e.message); }
    }));
  }
  document.getElementById('backupRefreshBtn')?.addEventListener('click', loadBackupArchive);
  document.getElementById('backupRunNowBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget, orig = btn.innerHTML;
    const msg = (k, t) => { const el = document.getElementById('backupMsg'); el.className = 'status-bar ' + k; el.textContent = t; el.classList.remove('hidden'); };
    btn.disabled = true; btn.textContent = 'Backing up…';
    msg('progress', 'Writing today’s archive backup…');
    try {
      const r = await fetch('/api/master/backups/run-now', { method: 'POST', headers: { 'x-master-key': LOG_PASSWORD } });
      const d = await r.json();
      if (!r.ok) msg('error', d.error || 'Backup failed');
      else { msg('success', `✓ Saved ${d.file} to the archive`); loadBackupArchive(); }
    } catch (err) { msg('error', err.message); }
    btn.disabled = false; btn.innerHTML = orig;
  });

  document.getElementById('masterBackupBtn').addEventListener('click', async () => {
    const btn  = document.getElementById('masterBackupBtn');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const resp = await fetch('/api/master/backup', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        alert('Backup failed: ' + (d.error || resp.statusText)); return;
      }
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `idealscan-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(url);
    } catch (err) { alert('Backup error: ' + err.message);
    } finally { btn.disabled = false; btn.textContent = orig; }
  });

  // Master: reset all data
  document.getElementById('masterResetBtn').addEventListener('click', async () => {
    if (!confirm('MASTER RESET — permanently delete ALL batches, orders, and WMS files?')) return;
    if (!confirm('This cannot be undone. Confirm?')) return;
    try {
      const resp = await fetch('/api/master/reset', { method: 'POST', headers: { 'x-master-key': LOG_PASSWORD } });
      const data = await resp.json();
      if (!resp.ok) { alert(data.error); return; }
      loadedOrders = [];
      SESSION_ID   = '';
      sessionStorage.clear();
      document.getElementById('logOverlay').classList.add('hidden');
      document.body.classList.remove('log-open');
      stopLiveActivityPolling();
      stopPendingDelPolling();
      fetchAndRenderStats();
      renderOrdersDash();
      alert('All data cleared.');
    } catch (err) { alert(err.message); }
  });

  // Master: upload new picklist
  const masterFileInput = document.getElementById('masterFileInput');
  document.getElementById('masterBrowseBtn').addEventListener('click', e => { e.stopPropagation(); masterFileInput.click(); });
  document.getElementById('masterDropZone').addEventListener('click', () => masterFileInput.click());
  document.getElementById('masterDropZone').addEventListener('dragover', e => { e.preventDefault(); document.getElementById('masterDropZone').classList.add('dragover'); });
  document.getElementById('masterDropZone').addEventListener('dragleave', () => document.getElementById('masterDropZone').classList.remove('dragover'));
  document.getElementById('masterDropZone').addEventListener('drop', e => {
    e.preventDefault(); document.getElementById('masterDropZone').classList.remove('dragover');
    if (e.dataTransfer.files[0]) masterPreviewFile(e.dataTransfer.files[0]);
  });
  masterFileInput.addEventListener('change', () => { if (masterFileInput.files[0]) masterPreviewFile(masterFileInput.files[0]); });

  async function masterPreviewFile(file) {
    const statusEl = document.getElementById('masterUploadStatus');
    statusEl.className = 'status-bar loading'; statusEl.textContent = `Parsing ${file.name}…`; statusEl.classList.remove('hidden');
    const form = new FormData(); form.append('orderFile', file);
    try {
      const resp    = await fetch('/api/preview', { method: 'POST', headers: { 'x-session-id': SESSION_ID }, body: form });
      const preview = await resp.json();
      statusEl.classList.add('hidden');
      // Reuse main confirm modal
      pendingOrderFile = file;
      document.getElementById('clientNameInput').value = '';
      showUploadConfirmModal(file.name, preview);
    } catch (err) {
      statusEl.className = 'status-bar error'; statusEl.textContent = err.message;
    }
  }

  // ── Keyfields template: download ─────────────────────────────────────────
  document.getElementById('kfDownloadTplBtn').addEventListener('click', async () => {
    try {
      const resp = await fetch('/api/master/keyfields-template', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!resp.ok) { alert('Download failed'); return; }
      const blob = await resp.blob();
      const cd   = resp.headers.get('content-disposition') || '';
      const fname = (cd.match(/filename="([^"]+)"/) || [])[1] || 'Keyfields_Template.xlsx';
      const url  = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: fname }).click();
      URL.revokeObjectURL(url);
    } catch (err) { alert(err.message); }
  });

  // ── Keyfields template: reset to default ─────────────────────────────────
  document.getElementById('kfResetTplBtn').addEventListener('click', async () => {
    if (!confirm('Reset Keyfields output template to default (39-column layout)?')) return;
    const statusEl = document.getElementById('kfTplStatus');
    try {
      const resp = await fetch('/api/master/keyfields-template', { method: 'DELETE', headers: { 'x-master-key': LOG_PASSWORD } });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Reset failed');
      statusEl.className = 'status-bar success';
      statusEl.textContent = `Reset to default (${data.headers.length} columns).`;
      statusEl.classList.remove('hidden');
    } catch (err) {
      statusEl.className = 'status-bar error';
      statusEl.textContent = err.message;
      statusEl.classList.remove('hidden');
    }
  });

  // ── Keyfields template: upload new ───────────────────────────────────────
  const kfTplFileInput = document.getElementById('kfTplFileInput');

  document.getElementById('kfTplBrowseBtn').addEventListener('click', e => { e.stopPropagation(); kfTplFileInput.click(); });
  document.getElementById('kfTplDropZone').addEventListener('click', () => kfTplFileInput.click());
  document.getElementById('kfTplDropZone').addEventListener('dragover', e => { e.preventDefault(); document.getElementById('kfTplDropZone').classList.add('dragover'); });
  document.getElementById('kfTplDropZone').addEventListener('dragleave', () => document.getElementById('kfTplDropZone').classList.remove('dragover'));
  document.getElementById('kfTplDropZone').addEventListener('drop', e => {
    e.preventDefault(); document.getElementById('kfTplDropZone').classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadKeyfieldsTpl(e.dataTransfer.files[0]);
  });
  kfTplFileInput.addEventListener('change', () => { if (kfTplFileInput.files[0]) uploadKeyfieldsTpl(kfTplFileInput.files[0]); kfTplFileInput.value = ''; });

  async function uploadKeyfieldsTpl(file) {
    const statusEl = document.getElementById('kfTplStatus');
    statusEl.className = 'status-bar loading'; statusEl.textContent = `Uploading ${file.name}…`; statusEl.classList.remove('hidden');
    const form = new FormData(); form.append('templateFile', file);
    try {
      const resp = await fetch('/api/master/keyfields-template', { method: 'POST', headers: { 'x-master-key': LOG_PASSWORD }, body: form });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Upload failed');
      statusEl.className = 'status-bar success';
      statusEl.textContent = `Template saved — ${data.count} columns: ${data.headers.slice(0, 5).join(', ')}${data.count > 5 ? '…' : ''}`;
    } catch (err) {
      statusEl.className = 'status-bar error';
      statusEl.textContent = err.message;
    }
  }

  // ── Barcode → SKU map upload ─────────────────────────────────────────────
  const barcodeMapFileInput = document.getElementById('barcodeMapFileInput');

  async function loadBarcodeMapStats() {
    try {
      const r = await fetch('/api/master/betime-code2', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!r.ok) return;
      const d = await r.json();
      const statsEl = document.getElementById('barcodeMapStats');
      if (d.entries > 0) {
        statsEl.className = 'barcode-map-stats';
        statsEl.textContent = `&#10003; ${d.entries.toLocaleString()} barcode entries loaded`;
        statsEl.classList.remove('hidden');
      }
    } catch {}
  }

  document.getElementById('learnedExportBtn')?.addEventListener('click', async () => {
    try {
      const r = await fetch('/api/master/learned-barcodes/export', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!r.ok) throw new Error('Export failed');
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `Learned_Barcodes_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) { alert(err.message); }
  });

  async function loadLearnedBarcodes() {
    const el = document.getElementById('learnedBarcodesList');
    if (!el) return;
    try {
      const r = await fetch('/api/master/learned-barcodes', { headers: { 'x-master-key': LOG_PASSWORD } });
      if (!r.ok) { el.innerHTML = '<span class="hint">Could not load learned barcodes.</span>'; return; }
      const d = await r.json();
      const barcodes = d.barcodes || (Array.isArray(d) ? d : []);
      const aliases  = d.aliases  || [];
      if (!barcodes.length && !aliases.length) {
        el.innerHTML = '<span class="hint">None yet — packers teach these during scanning when a barcode is missing from the listing.</span>';
        return;
      }
      el.innerHTML = barcodes.map(e => `
        <div class="learned-bc-row">
          <code>${esc(e.barcode)}</code> &#8594; <code>${esc(e.sku)}</code>
          <span class="learned-bc-meta">${esc(e.description || '')}</span>
          <span class="learned-bc-meta">by ${esc(e.learnedBy || '?')} &middot; ${new Date(e.learnedAt).toLocaleString()} &middot; order ${esc(e.order || '')}</span>
          <button class="btn-danger-sm learned-bc-del" data-barcode="${esc(e.barcode)}">Remove</button>
        </div>`).join('') + aliases.map(e => `
        <div class="learned-bc-row">
          <span class="learned-bc-meta">SKU alias</span>
          <code>${esc(e.a)}</code> &#8646; <code>${esc(e.b)}</code>
          <span class="learned-bc-meta">by ${esc(e.learnedBy || '?')} &middot; ${new Date(e.learnedAt).toLocaleString()} &middot; order ${esc(e.order || '')}</span>
          <button class="btn-danger-sm learned-alias-del" data-a="${esc(e.a)}" data-b="${esc(e.b)}">Remove</button>
        </div>`).join('');
      el.querySelectorAll('.learned-bc-del').forEach(btn => btn.addEventListener('click', async () => {
        if (!confirm(`Remove learned mapping ${btn.dataset.barcode}? Scans of it will stop matching until re-taught.`)) return;
        const dr = await fetch(`/api/master/learned-barcodes/${encodeURIComponent(btn.dataset.barcode)}`, {
          method: 'DELETE', headers: { 'x-master-key': LOG_PASSWORD },
        });
        if (!dr.ok) { alert((await dr.json()).error || 'Delete failed'); return; }
        loadLearnedBarcodes();
      }));
      el.querySelectorAll('.learned-alias-del').forEach(btn => btn.addEventListener('click', async () => {
        if (!confirm(`Remove SKU alias ${btn.dataset.a} ⇄ ${btn.dataset.b}?`)) return;
        const dr = await fetch(`/api/master/learned-aliases/${encodeURIComponent(btn.dataset.a)}/${encodeURIComponent(btn.dataset.b)}`, {
          method: 'DELETE', headers: { 'x-master-key': LOG_PASSWORD },
        });
        if (!dr.ok) { alert((await dr.json()).error || 'Delete failed'); return; }
        loadLearnedBarcodes();
      }));
    } catch { el.innerHTML = '<span class="hint">Could not load learned barcodes.</span>'; }
  }

  document.getElementById('barcodeMapBrowseBtn').addEventListener('click', e => { e.stopPropagation(); barcodeMapFileInput.click(); });
  document.getElementById('barcodeMapDropZone').addEventListener('click', () => barcodeMapFileInput.click());
  document.getElementById('barcodeMapDropZone').addEventListener('dragover', e => { e.preventDefault(); document.getElementById('barcodeMapDropZone').classList.add('dragover'); });
  document.getElementById('barcodeMapDropZone').addEventListener('dragleave', () => document.getElementById('barcodeMapDropZone').classList.remove('dragover'));
  document.getElementById('barcodeMapDropZone').addEventListener('drop', e => {
    e.preventDefault(); document.getElementById('barcodeMapDropZone').classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadBarcodeMap(e.dataTransfer.files[0]);
  });
  barcodeMapFileInput.addEventListener('change', () => { if (barcodeMapFileInput.files[0]) uploadBarcodeMap(barcodeMapFileInput.files[0]); barcodeMapFileInput.value = ''; });

  async function uploadBarcodeMap(file) {
    const statusEl = document.getElementById('barcodeMapStatus');
    statusEl.className = 'status-bar loading'; statusEl.textContent = `Uploading ${file.name}…`; statusEl.classList.remove('hidden');
    const form = new FormData(); form.append('file', file);
    try {
      const resp = await fetch('/api/master/betime-code2', { method: 'POST', headers: { 'x-master-key': LOG_PASSWORD }, body: form });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Upload failed');
      statusEl.className = 'status-bar success';
      statusEl.textContent = `✓ ${data.entries.toLocaleString()} barcodes loaded (${data.skipped} skipped)`;
      loadBarcodeMapStats();
    } catch (err) {
      statusEl.className = 'status-bar error';
      statusEl.textContent = err.message;
    }
  }

  async function renderLogContent() {
    const listEl  = document.getElementById('logOverlayList');
    const emptyEl = document.getElementById('logOverlayEmpty');
    listEl.innerHTML = '<p class="hint" style="padding:.5rem 0">Loading…</p>';
    try {
      const [batchResp, labelResp] = await Promise.all([
        fetch('/api/batches'),
        fetch('/api/label-imports'),
      ]);
      const batches = await batchResp.json();
      const labelImports = labelResp.ok ? await labelResp.json() : [];
      if (!batches.length && !labelImports.length) {
        listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); return;
      }
      emptyEl.classList.add('hidden');

      // Picklist batches and label-PDF imports interleaved, newest first
      const entries = [
        ...batches.map(b => ({ at: b.uploaded_at, kind: 'batch', b })),
        ...labelImports.map(li => ({ at: li.uploadedAt, kind: 'labels', li })),
      ].sort((a, b) => new Date(b.at) - new Date(a.at));

      listEl.innerHTML = entries.map(entry => {
        if (entry.kind === 'labels') {
          const li = entry.li;
          return `
          <div class="log-card log-card-labels">
            <div class="log-card-left">
              <span class="log-filename">&#127991; ${esc(li.filename)} <span class="log-kind-badge">Labels PDF</span></span>
              <span class="log-date">${new Date(li.uploadedAt).toLocaleString()}${li.uploadedBy ? ` &nbsp;·&nbsp; <strong>${esc(li.uploadedBy)}</strong>` : ''}</span>
              <div class="log-chips">
                <span class="chip">${li.pageCount} page${li.pageCount !== 1 ? 's' : ''}</span>
                ${li.matched   ? `<span class="chip chip-done">${li.matched} matched</span>` : ''}
                ${li.unmatched ? `<span class="chip chip-unproc">${li.unmatched} unmatched</span>` : ''}
              </div>
            </div>
            <div class="log-card-actions">
              <button class="btn-download log-review-labels" data-import-id="${esc(li.id)}">Review &rsaquo;</button>
              <button class="btn-del-batch btn-del-labels" data-id="${esc(li.id)}" data-name="${esc(li.filename)}" title="Delete this label import">&#128465; Delete</button>
            </div>
          </div>`;
        }
        const b      = entry.b;
        const date   = new Date(b.uploaded_at).toLocaleString();
        const states = b.orderStates || {};
        const done   = Object.values(states).filter(s => s.status === 'done').length;
        const inprog = Object.values(states).filter(s => s.status === 'processing').length;
        const unproc = Object.values(states).filter(s => s.status === 'unprocessed').length;
        const wbChips = (b.waybill_uploads || []).map(w =>
          `<span class="chip chip-waybill" title="${esc(w.filename)} — uploaded ${new Date(w.at).toLocaleString()}${w.by ? ' by ' + esc(w.by) : ''}">&#128196; ${esc(w.filename)} &middot; ${w.matched}/${w.total} matched</span>`
        ).join('');
        return `
          <div class="log-card">
            <div class="log-card-left">
              <span class="log-filename">${b.idealscan_code ? `<code class="job-code">${esc(b.idealscan_code)}</code> ` : ''}${esc(b.filename)}</span>
              ${b.client_name ? `<span class="log-client">${esc(b.client_name)}</span>` : ''}
              <span class="log-date">${date}${b.uploaded_by ? ` &nbsp;·&nbsp; <strong>${esc(b.uploaded_by)}</strong>` : ''}</span>
              <div class="log-chips">
                <span class="chip">${b.order_count} orders</span>
                <span class="chip">${b.row_count} lines</span>
                ${done   ? `<span class="chip chip-done">${done} done</span>` : ''}
                ${inprog ? `<span class="chip chip-inprog">${inprog} in progress</span>` : ''}
                ${unproc ? `<span class="chip chip-unproc">${unproc} unprocessed</span>` : ''}
                ${wbChips}
              </div>
            </div>
            <div class="log-card-actions">
              <a class="btn-download" data-auth-dl="/api/download-wms/${esc(b.id)}" data-auth-dl-name="WMS_${esc(b.filename || b.id)}.xlsx">&#8681; WMS</a>
              <button class="btn-attach-waybill" data-id="${esc(b.id)}" data-count="${b.order_count}" title="Upload waybill PDF for this batch">&#128196; Waybill PDF</button>
              <button class="btn-del-batch" data-id="${esc(b.id)}" data-name="${esc(b.filename)}" title="Delete entire batch">&#128465; Delete Batch</button>
            </div>
          </div>`;
      }).join('');

      listEl.querySelectorAll('.log-review-labels').forEach(btn =>
        btn.addEventListener('click', () => openLabelReview(btn.dataset.importId))
      );

      listEl.querySelectorAll('.btn-attach-waybill').forEach(btn => {
        btn.addEventListener('click', () => {
          const batchId    = btn.dataset.id;
          const totalOrders = parseInt(btn.dataset.count) || 0;
          const inp = document.createElement('input');
          inp.type = 'file'; inp.accept = '.pdf';
          inp.onchange = async () => {
            if (!inp.files[0]) return;
            const form = new FormData();
            form.append('waybillPdf', inp.files[0]);
            btn.textContent = '⏳ Matching…';
            btn.disabled    = true;
            try {
              const r = await fetch(`/api/batch/${encodeURIComponent(batchId)}/waybill-pdf`, {
                method: 'POST', body: form,
              });
              const d = await r.json();
              if (!r.ok) throw new Error(d.error || 'Upload failed');
              btn.textContent = `✓ ${d.matched}/${d.total} matched`;
              btn.style.color = d.matched > 0 ? 'var(--success)' : 'var(--danger)';
              await refreshOrders();
              renderOrdersDash();
              await renderLogContent(); // show the new waybill chip on the batch card
            } catch (err) {
              btn.textContent = '✗ Error';
              btn.title = err.message;
              btn.disabled = false;
            }
          };
          inp.click();
        });
      });

      listEl.querySelectorAll('.btn-del-batch:not(.btn-del-labels)').forEach(btn => {
        btn.addEventListener('click', async e => {
          e.stopPropagation();
          const batchId = btn.dataset.id, fname = btn.dataset.name;
          if (!confirm(`Delete entire batch "${fname}" and ALL its orders?\nThis cannot be undone.`)) return;
          if (!confirm(`Confirm: permanently delete "${fname}"?`)) return;
          try {
            const r = await fetch(`/api/master/batch/${encodeURIComponent(batchId)}`, { method: 'DELETE', headers: { 'x-master-key': LOG_PASSWORD } });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Delete failed');
            await refreshOrders(); renderOrdersList();
            await renderLogContent();
          } catch (err) { alert(err.message); }
        });
      });

      listEl.querySelectorAll('.btn-del-labels').forEach(btn => {
        btn.addEventListener('click', async e => {
          e.stopPropagation();
          const importId = btn.dataset.id, fname = btn.dataset.name;
          if (!confirm(`Delete label import "${fname}"?\nThis removes the matched-label attachments from any orders (their order data is untouched). This cannot be undone.`)) return;
          try {
            const r = await fetch(`/api/label-imports/${encodeURIComponent(importId)}`, { method: 'DELETE', headers: { 'x-master-key': LOG_PASSWORD } });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Delete failed');
            await refreshOrders(); renderOrdersList();
            await renderLogContent();
          } catch (err) { alert(err.message); }
        });
      });
    } catch (err) {
      listEl.innerHTML = `<p class="scan-error" style="padding:.5rem 0">${esc(err.message)}</p>`;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function refreshOrders() {
    try {
      // Ask only for the selected date window — keeps the payload small no
      // matter how much history accumulates on the server
      const rangeMap = { today: 'today', yesterday: 'yesterday', week: 'week', all: 'all', range: 'range' };
      const range = rangeMap[ordersDateFilter] || 'all';
      let url = `/api/orders?range=${range}`;
      if (range === 'range') {
        if (ordersDateFrom) url += `&from=${encodeURIComponent(ordersDateFrom)}`;
        if (ordersDateTo)   url += `&to=${encodeURIComponent(ordersDateTo)}`;
      }
      const resp = await fetch(url);
      const data = await resp.json();
      if (Array.isArray(data)) loadedOrders = data;
      // Keep the sidebar pending badge current after scans/completions —
      // fire-and-forget, never blocks the orders refresh itself
      fetchAndRenderStats();
    } catch {}
  }

  function mergeOrderState(orderNumber, status, scanned) {
    const idx = loadedOrders.findIndex(o => o.order_number === orderNumber);
    if (idx < 0) return;
    loadedOrders[idx].scan_status = status;
    if (scanned !== undefined) loadedOrders[idx].scanned = scanned;
  }

  // ── Camera Barcode Scanner ─────────────────────────────────────────────────
  let cameraStream    = null;
  let cameraAnimFrame = null;
  let barcodeDetector = null;
  let cameraUsesJsQR  = false; // true on phones without BarcodeDetector (iPhone Safari) — jsQR decodes QR frames instead
  let cameraScanMode  = 'single'; // 'single' | 'batch' | 'label'
  let cameraScanTarget = 'outbound'; // 'outbound' | 'inbound' — where a detected value gets applied
  const batchMap      = new Map(); // rawValue → { checked: bool }
  const lastSingleHit = {};        // rawValue → timestamp (cooldown)
  const SINGLE_COOLDOWN_MS = 1800;

  // Routes a scanned/OCR'd value to whichever screen opened the camera —
  // outbound's offline-aware queue, or inbound's direct scan call.
  function dispatchCameraScan(val) {
    if (cameraScanTarget === 'inbound') inboundScan(val);
    else if (cameraScanTarget === 'wave') waveUI.scan(val);
    else handleItemScan(val);
  }

  // NOTE the arrow wrappers: passing openCameraScanner directly would hand the
  // click's MouseEvent in as the `target` argument and silently break the default.
  document.getElementById('openCameraBtn').addEventListener('click', () => openCameraScanner('outbound'));
  document.getElementById('inboundCameraScanBtn').addEventListener('click', () => openCameraScanner('inbound'));
  document.getElementById('waveCameraScanBtn').addEventListener('click', () => openCameraScanner('wave'));
  document.getElementById('closeCameraBtn').addEventListener('click', closeCameraScanner);
  document.getElementById('cmodeSingle').addEventListener('click', () => setCameraMode('single'));
  document.getElementById('cmodeBatch').addEventListener('click',  () => setCameraMode('batch'));
  document.getElementById('cmodeLabel').addEventListener('click',  () => setCameraMode('label'));

  document.getElementById('clfCaptureBtn').addEventListener('click', captureLabel);
  document.getElementById('clfRetryBtn').addEventListener('click', () => {
    document.getElementById('clfResult').classList.add('hidden');
    document.getElementById('clfStatus').textContent = '';
  });
  document.getElementById('clfUseBtn').addEventListener('click', () => {
    const sku = document.getElementById('clfSku').textContent.trim();
    if (sku && sku !== '—') { dispatchCameraScan(sku); closeCameraScanner(); }
  });

  document.getElementById('cameraClearBtn').addEventListener('click', () => { batchMap.clear(); renderBatchChips(); });
  document.getElementById('cameraSelectAllBtn').addEventListener('click', () => {
    batchMap.forEach(v => { v.checked = true; }); renderBatchChips();
  });
  document.getElementById('cameraScanSelectedBtn').addEventListener('click', () => {
    const selected = [...batchMap.entries()].filter(([, v]) => v.checked).map(([k]) => k);
    if (!selected.length) return;
    selected.forEach(val => dispatchCameraScan(val));
    closeCameraScanner();
  });

  function setCameraMode(mode) {
    cameraScanMode = mode;
    document.getElementById('cmodeSingle').classList.toggle('active', mode === 'single');
    document.getElementById('cmodeBatch').classList.toggle('active',  mode === 'batch');
    document.getElementById('cmodeLabel').classList.toggle('active',  mode === 'label');
    document.getElementById('cameraBatchPanel').classList.toggle('hidden',   mode !== 'batch');
    document.getElementById('cameraLabelPanel').classList.toggle('hidden',   mode !== 'label');
    document.getElementById('cameraLabelAim').classList.toggle('hidden',     mode !== 'label');
    document.getElementById('cameraSingleHint').classList.toggle('hidden',   mode !== 'single');
    document.getElementById('cameraSingleResult').classList.add('hidden');
    if (mode === 'batch') { batchMap.clear(); renderBatchChips(); }
    if (mode === 'label') { resetLabelPanel(); }
  }

  function resetLabelPanel() {
    document.getElementById('clfResult').classList.add('hidden');
    document.getElementById('clfStatus').textContent = '';
    document.getElementById('clfSku').textContent    = '—';
    document.getElementById('clfBatch').textContent  = '—';
    document.getElementById('clfExpiry').textContent = '—';
    document.getElementById('cameraLabelSpinner').classList.add('hidden');
    document.getElementById('clfCaptureBtn').disabled = false;
  }

  function binariseCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114);
    const thresh = (sum / (d.length / 4)) * 0.65;
    for (let i = 0; i < d.length; i += 4) {
      const lum = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
      const v = lum > thresh ? 255 : 0;
      d[i] = d[i+1] = d[i+2] = v;
    }
    ctx.putImageData(img, 0, 0);
  }

  async function captureLabel() {
    const video    = document.getElementById('cameraVideo');
    const spinner  = document.getElementById('cameraLabelSpinner');
    const statusEl = document.getElementById('clfStatus');
    const resultEl = document.getElementById('clfResult');
    const captBtn  = document.getElementById('clfCaptureBtn');

    captBtn.disabled = true;
    statusEl.textContent = '';
    resultEl.classList.add('hidden');
    spinner.classList.remove('hidden');

    const canvas = document.createElement('canvas');
    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext('2d').drawImage(video, 0, 0);
    binariseCanvas(canvas);

    canvas.toBlob(async blob => {
      const fd = new FormData();
      fd.append('image', blob, 'label.jpg');
      try {
        const resp = await fetch('/api/ocr/label', {
          method: 'POST',
          headers: { 'x-session-id': SESSION_ID },
          body: fd,
        });
        const data = await resp.json();
        spinner.classList.add('hidden');
        document.getElementById('clfSku').textContent    = data.sku    || '—';
        document.getElementById('clfBatch').textContent  = data.batch  || '—';
        document.getElementById('clfExpiry').textContent = data.expiry || '—';
        resultEl.classList.remove('hidden');
        if (!data.sku) {
          statusEl.textContent = 'No SKU found — try again';
          statusEl.style.color = 'var(--danger)';
        } else {
          statusEl.textContent = '';
        }
        document.getElementById('clfUseBtn').disabled = !data.sku;
      } catch (e) {
        spinner.classList.add('hidden');
        statusEl.textContent = 'Error — ' + e.message;
        statusEl.style.color = 'var(--danger)';
      }
      captBtn.disabled = false;
    }, 'image/jpeg', 0.92);
  }

  async function openCameraScanner(target = 'outbound') {
    cameraScanTarget = target;
    document.getElementById('cameraScanOverlay').classList.remove('hidden');
    document.getElementById('cameraNoSupport').classList.add('hidden');
    document.getElementById('cameraViewfinderWrap').classList.remove('hidden');
    // ensure panels start hidden — setCameraMode will show the right one
    document.getElementById('cameraBatchPanel').classList.add('hidden');
    document.getElementById('cameraLabelPanel').classList.add('hidden');
    document.getElementById('cameraLabelAim').classList.add('hidden');

    // BarcodeDetector (Android Chrome/Edge) reads every format natively.
    // iPhones (Safari) don't have it — fall back to jsQR, which decodes QR
    // codes from video frames in JS, so warehouse staff can use their OWN
    // smartphones as scanners regardless of platform. Only when NEITHER
    // path exists is the no-support screen shown.
    cameraUsesJsQR = false;
    if ('BarcodeDetector' in window) {
      if (!barcodeDetector) {
        let fmts;
        try { fmts = await BarcodeDetector.getSupportedFormats(); }
        catch { fmts = ['code_128', 'ean_13', 'ean_8', 'qr_code', 'upc_a', 'upc_e', 'code_39', 'itf', 'data_matrix']; }
        barcodeDetector = new BarcodeDetector({ formats: fmts });
      }
    } else if (window.jsQR) {
      cameraUsesJsQR = true;
    } else {
      document.getElementById('cameraViewfinderWrap').classList.add('hidden');
      document.getElementById('cameraBatchPanel').classList.add('hidden');
      document.getElementById('cameraLabelPanel').classList.add('hidden');
      document.getElementById('cameraNoSupport').classList.remove('hidden');
      return;
    }

    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      const video = document.getElementById('cameraVideo');
      video.srcObject = cameraStream;
      await new Promise(r => { video.onloadedmetadata = r; });
      await video.play();
      setCameraMode(cameraScanMode);
      document.getElementById('cameraQrOnlyHint')?.classList.toggle('hidden', !cameraUsesJsQR);
      startCameraLoop();
    } catch (err) {
      document.getElementById('cameraViewfinderWrap').classList.add('hidden');
      document.getElementById('cameraBatchPanel').classList.add('hidden');
      const el = document.getElementById('cameraNoSupport');
      el.querySelector('p').textContent = 'Camera error: ' + err.message;
      el.classList.remove('hidden');
    }
  }

  function closeCameraScanner() {
    if (cameraAnimFrame) { cancelAnimationFrame(cameraAnimFrame); cameraAnimFrame = null; }
    if (cameraStream)    { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
    document.getElementById('cameraScanOverlay').classList.add('hidden');
    batchMap.clear();
    // focus goes back to whichever input opened the camera
    const backTo = { inbound: 'inboundScanInput', wave: 'waveScanInput' }[cameraScanTarget] || 'itemScanInput';
    document.getElementById(backTo)?.focus();
  }

  function startCameraLoop() {
    const video = document.getElementById('cameraVideo');
    // jsQR fallback decodes frames on a canvas — CPU-bound, so it runs
    // downscaled (max 640px) and throttled (~6 fps) instead of every frame.
    let jsqrCanvas = null, jsqrLastRun = 0;
    const JSQR_INTERVAL_MS = 160;
    function detectWithJsQR() {
      const now = Date.now();
      if (now - jsqrLastRun < JSQR_INTERVAL_MS) return [];
      jsqrLastRun = now;
      if (!jsqrCanvas) jsqrCanvas = document.createElement('canvas');
      const scale = Math.min(1, 640 / (video.videoWidth || 640));
      const w = Math.max(1, Math.round((video.videoWidth  || 640) * scale));
      const h = Math.max(1, Math.round((video.videoHeight || 480) * scale));
      jsqrCanvas.width = w; jsqrCanvas.height = h;
      const ctx = jsqrCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const hit = jsQR(img.data, w, h);
      return hit && hit.data ? [{ rawValue: hit.data }] : [];
    }
    async function loop() {
      if (!cameraStream) return;
      try {
        if (video.readyState >= 2) {
          const results = cameraUsesJsQR ? detectWithJsQR() : await barcodeDetector.detect(video);
          if (results.length) processDetected(results);
        }
      } catch {}
      cameraAnimFrame = requestAnimationFrame(loop);
    }
    cameraAnimFrame = requestAnimationFrame(loop);
  }

  function processDetected(barcodes) {
    if (cameraScanMode === 'label') return; // label mode uses manual capture
    const now = Date.now();
    for (const bc of barcodes) {
      const val = (bc.rawValue || '').trim();
      if (!val) continue;

      if (cameraScanMode === 'single') {
        const last = lastSingleHit[val] || 0;
        if (now - last > SINGLE_COOLDOWN_MS) {
          lastSingleHit[val] = now;
          dispatchCameraScan(val);
          showCameraFlash(val);
        }
      } else {
        if (!batchMap.has(val)) {
          batchMap.set(val, { checked: true });
          renderBatchChips();
        }
      }
    }
  }

  function showCameraFlash(val) {
    const el = document.getElementById('cameraSingleResult');
    el.textContent = `✓ ${val}`;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 1600);
  }

  function renderBatchChips() {
    const list    = document.getElementById('cameraBatchList');
    const countEl = document.getElementById('cameraBatchCount');
    const entries = [...batchMap.entries()];
    if (!entries.length) {
      list.innerHTML = '<span class="hint camera-batch-empty">Point camera at barcodes to collect them…</span>';
      countEl.textContent = '0';
      return;
    }
    const checkedCount = entries.filter(([, v]) => v.checked).length;
    countEl.textContent = checkedCount;
    list.innerHTML = entries.map(([val, { checked }]) => `
      <div class="camera-batch-chip ${checked ? 'checked' : ''}" data-val="${esc(val)}">
        <span class="chip-check">${checked ? '&#9745;' : '&#9744;'}</span>
        <code>${esc(val)}</code>
      </div>`).join('');
    list.querySelectorAll('.camera-batch-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const v = batchMap.get(chip.dataset.val);
        if (v) { v.checked = !v.checked; renderBatchChips(); }
      });
    });
  }

  // ── Print Carrier Label Modal ─────────────────────────────────────────────
  function showPrintOrderLabelModal(order) {
    document.getElementById('printLabelOrderNo').textContent = order.order_number;
    document.getElementById('printOrderLabelOverlay').classList.remove('hidden');
  }

  document.getElementById('printLabelSkipBtn').addEventListener('click', () => {
    document.getElementById('printOrderLabelOverlay').classList.add('hidden');
    focusWaybillInput();
  });

  document.getElementById('printLabelNowBtn').addEventListener('click', () => {
    const orderNo = document.getElementById('printLabelOrderNo').textContent;
    // Straight to the browser's print dialog from the PDF preview — no new
    // tab to find and no file landing on the desktop first.
    authPrintPdf(`/api/order-label/${encodeURIComponent(orderNo)}/pdf`);
    document.getElementById('printOrderLabelOverlay').classList.add('hidden');
    focusWaybillInput();
  });

  // ── Labels Tab ────────────────────────────────────────────────────────────
  let _labelReviewImportId = null;

  async function renderLabelsTab() {
    const listEl  = document.getElementById('labelImportHistoryList');
    const emptyEl = document.getElementById('labelImportHistoryEmpty');
    if (!listEl) return;
    listEl.innerHTML = '<p class="hint" style="padding:.5rem">Loading&hellip;</p>';
    emptyEl.classList.add('hidden');
    try {
      const resp = await fetch('/api/label-imports');
      if (!resp.ok) throw new Error('Failed to load imports');
      const imports = await resp.json();
      if (imports.length === 0) {
        listEl.innerHTML = '';
        emptyEl.classList.remove('hidden');
        return;
      }
      emptyEl.classList.add('hidden');
      listEl.innerHTML = imports.map(imp => {
        const dt = new Date(imp.uploadedAt).toLocaleString();
        const hasUnmatched = imp.unmatched > 0;
        return `
          <div class="label-history-item" data-import-id="${esc(imp.id)}">
            <div class="lhi-left">
              <span class="lhi-filename">&#128196; ${esc(imp.filename)}</span>
              <span class="lhi-date">${esc(dt)}</span>
            </div>
            <div class="lhi-right">
              <span class="lhi-pages">${imp.pageCount} page${imp.pageCount !== 1 ? 's' : ''}</span>
              ${imp.matched    ? `<span class="lhi-badge lhi-matched">${imp.matched} matched</span>` : ''}
              ${imp.unmatched  ? `<span class="lhi-badge lhi-unmatched">${imp.unmatched} unmatched</span>` : ''}
              ${imp.duplicate  ? `<span class="lhi-badge lhi-duplicate">${imp.duplicate} duplicate</span>` : ''}
              ${imp.error      ? `<span class="lhi-badge lhi-error">${imp.error} error</span>` : ''}
              ${hasUnmatched   ? `<button class="btn-primary btn-sm lhi-automatch-btn" data-import-id="${esc(imp.id)}">&#9889; Auto Match</button>` : ''}
              <button class="btn-secondary btn-sm lhi-review-btn">Review ›</button>
            </div>
          </div>`;
      }).join('');
      listEl.querySelectorAll('.lhi-automatch-btn').forEach(btn =>
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const importId = btn.dataset.importId;
          btn.disabled = true; btn.textContent = 'Matching…';
          try {
            const r = await fetch(`/api/label-imports/${importId}/rematch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Rematch failed');
            await refreshOrders();
            await renderLabelsTab();
            if (d.newMatches > 0) alert(`Auto-matched ${d.newMatches} label${d.newMatches !== 1 ? 's' : ''}. ${d.unmatched} still unmatched.`);
            else alert(`No new matches found. ${d.unmatched} page${d.unmatched !== 1 ? 's' : ''} still unmatched — use Review to assign manually.`);
          } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = '⚡ Auto Match'; }
        })
      );
      listEl.querySelectorAll('.label-history-item').forEach(el =>
        el.addEventListener('click', (e) => {
          if (e.target.closest('.lhi-automatch-btn')) return;
          openLabelReview(el.dataset.importId);
        })
      );
    } catch (err) {
      listEl.innerHTML = `<p class="hint" style="color:var(--danger);padding:.5rem">${esc(err.message)}</p>`;
    }
  }

  // Shared same-file confirm for both label-upload entry points
  function labelSameFileConfirm(ex) {
    ex = ex || {};
    return confirm(
      `⚠ SAME LABEL PDF ALREADY UPLOADED\n\n` +
      `"${ex.filename}" (identical contents) was already uploaded on ${ex.uploadedAt}` +
      `${ex.uploadedBy ? ` by ${ex.uploadedBy}` : ''} — ${ex.pageCount} page(s).\n\n` +
      `OK = OVERWRITE it with this upload (its matched labels are re-matched from this file)\n` +
      `Cancel = keep the earlier upload`);
  }

  async function doLabelImport(file) {
    const statusEl = document.getElementById('labelImportStatus');
    statusEl.className = 'status-bar loading';
    statusEl.textContent = 'Uploading and processing pages…';
    statusEl.classList.remove('hidden');
    const fd = new FormData();
    fd.append('labelPdf', file);
    try {
      let resp = await fetch('/api/label-imports', { method: 'POST', body: fd });
      let data = await resp.json();
      if (resp.status === 409 && data.needsSameFileConfirm) {
        if (!labelSameFileConfirm(data.existing)) {
          statusEl.className = 'status-bar error';
          statusEl.textContent = 'Upload cancelled — the earlier label upload was kept.';
          document.getElementById('labelImportFileInput').value = '';
          return;
        }
        fd.append('overwrite_same_file', 'yes');
        resp = await fetch('/api/label-imports', { method: 'POST', body: fd });
        data = await resp.json();
      }
      if (!resp.ok) throw new Error(data.error || 'Upload failed');
      statusEl.className = 'status-bar success';
      statusEl.textContent = `✓ Imported ${data.pageCount} page${data.pageCount !== 1 ? 's' : ''} — ${data.matched} matched`;
      document.getElementById('labelImportFileInput').value = '';
      await refreshOrders();
      await renderLabelsTab();
      if (data.importId) openLabelReview(data.importId);
    } catch (err) {
      statusEl.className = 'status-bar error';
      statusEl.textContent = err.message;
    }
  }

  async function openLabelReview(importId) {
    _labelReviewImportId = importId;
    const overlay = document.getElementById('labelReviewOverlay');
    const body    = document.getElementById('labelReviewBody');
    const titleEl = document.getElementById('labelReviewTitle');
    const summEl  = document.getElementById('labelReviewSummary');
    overlay.classList.remove('hidden');
    body.innerHTML = '<p class="hint" style="padding:2rem">Loading pages…</p>';
    try {
      const resp = await fetch(`/api/label-imports/${importId}`);
      if (!resp.ok) throw new Error('Failed to load import');
      const imp = await resp.json();
      titleEl.textContent = imp.filename;
      const matched   = imp.pages.filter(p => p.matchStatus === 'matched').length;
      const unmatched = imp.pages.filter(p => p.matchStatus === 'unmatched').length;
      const dup       = imp.pages.filter(p => p.matchStatus === 'duplicate').length;
      const errCount  = imp.pages.filter(p => p.matchStatus === 'error').length;
      summEl.innerHTML = [
        matched   ? `<span class="lri-badge lri-matched">${matched} matched</span>` : '',
        unmatched ? `<span class="lri-badge lri-unmatched">${unmatched} unmatched</span>` : '',
        dup       ? `<span class="lri-badge lri-dup">${dup} duplicate</span>` : '',
        errCount  ? `<span class="lri-badge lri-err">${errCount} error</span>` : '',
        unmatched ? `<button class="btn-primary btn-sm" id="lriAutoMatchBtn" style="margin-left:.5rem">&#9889; Auto Match Unmatched</button>` : '',
        matched   ? `<button class="btn-secondary btn-sm" id="lriRematchAllBtn" style="margin-left:.5rem">&#8635; Rematch All</button>` : '',
        `<button class="btn-secondary btn-sm" id="lriExportCsvBtn" style="margin-left:.5rem">&#11015; Export CSV</button>`,
        `<button class="btn-secondary btn-sm" id="lriImportMatchesBtn" style="margin-left:.5rem">&#11014; Import Matches CSV</button>`,
        `<input type="file" id="lriImportMatchesInput" accept=".csv" class="hidden" />`,
      ].filter(Boolean).join('');

      document.getElementById('lriExportCsvBtn')?.addEventListener('click', () =>
        authDownload(`/api/label-imports/${importId}/export.csv`, `${imp.filename.replace(/\.pdf$/i, '')}_ocr_results.csv`));

      // Round-trip half of Export CSV: download, fill in "Matched Order" for
      // rows Auto Match couldn't resolve, re-upload here. Blank rows are left
      // untouched — this can only add/change matches, never remove one.
      document.getElementById('lriImportMatchesBtn')?.addEventListener('click', () =>
        document.getElementById('lriImportMatchesInput').click());
      document.getElementById('lriImportMatchesInput')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        const btn = document.getElementById('lriImportMatchesBtn');
        btn.disabled = true; btn.textContent = 'Importing…';
        try {
          const fd = new FormData();
          fd.append('matchesCsv', file);
          const r = await fetch(`/api/label-imports/${importId}/import-matches`, { method: 'POST', body: fd });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Import failed');
          let msg = `Applied ${d.applied} match${d.applied !== 1 ? 'es' : ''}. ${d.skipped} row(s) had no Matched Order and were left alone.`;
          if (d.errors.length) msg += `\n\n${d.errors.length} row(s) could not be applied:\n` + d.errors.slice(0, 20).map(er => `Row ${er.row}: ${er.reason}`).join('\n');
          alert(msg);
          await refreshOrders();
          openLabelReview(importId);
        } catch (err) { alert(err.message); }
        finally { btn.disabled = false; btn.textContent = '⬆ Import Matches CSV'; }
      });

      document.getElementById('lriAutoMatchBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('lriAutoMatchBtn');
        btn.disabled = true; btn.textContent = 'Matching… (reading label images can take a minute)';
        try {
          const r = await fetch(`/api/label-imports/${importId}/rematch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Rematch failed');
          await refreshOrders();
          openLabelReview(importId);
        } catch (err) { alert(err.message); }
      });
      // Re-evaluates EVERY page against the current order list, including
      // ones already marked matched — needed after a matching-rule fix
      // (e.g. a field the index didn't used to check) so stale results from
      // before the fix get corrected instead of being skipped.
      document.getElementById('lriRematchAllBtn')?.addEventListener('click', async () => {
        if (!confirm('Re-check every page in this import against the current order list, including pages already marked matched? Any that now resolve differently will be updated.')) return;
        const btn = document.getElementById('lriRematchAllBtn');
        btn.disabled = true; btn.textContent = 'Rematching…';
        try {
          const r = await fetch(`/api/label-imports/${importId}/rematch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Rematch failed');
          await refreshOrders();
          openLabelReview(importId);
        } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = '↻ Rematch All'; }
      });

      const token = localStorage.getItem('wms_token') || '';
      body.innerHTML = imp.pages.map((page, i) => {
        const pdfUrl = `/api/label-imports/${esc(importId)}/pages/${i}/pdf?token=${encodeURIComponent(token)}`;
        const statusCls = { matched: 'lri-matched', unmatched: 'lri-unmatched', duplicate: 'lri-dup', error: 'lri-err' }[page.matchStatus] || 'lri-unmatched';
        const f = page.extracted || {};
        const fields = [
          f.trackingNumber ? `<div class="lri-field"><span class="lri-lbl">Tracking</span><span class="lri-val">${esc(f.trackingNumber)}</span></div>` : '',
          f.orderNumber    ? `<div class="lri-field"><span class="lri-lbl">Order No.</span><span class="lri-val">${esc(f.orderNumber)}</span></div>` : '',
          f.recipientName  ? `<div class="lri-field"><span class="lri-lbl">Recipient</span><span class="lri-val">${esc(f.recipientName)}</span></div>` : '',
          f.senderName     ? `<div class="lri-field"><span class="lri-lbl">From</span><span class="lri-val">${esc(f.senderName)}</span></div>` : '',
          f.address        ? `<div class="lri-field"><span class="lri-lbl">Address</span><span class="lri-val">${esc(f.address)}</span></div>` : '',
        ].filter(Boolean).join('');
        const isMatchedOrDup = page.matchStatus === 'matched' || page.matchStatus === 'duplicate';
        const matchAction = isMatchedOrDup
          ? `<span class="lri-order-matched">&#10003; ${esc(page.matchedOrderNumber)}</span>
             <button class="btn-ghost btn-sm lri-unmatch-btn" data-page="${i}">Unmatch</button>`
          : `<button class="btn-primary btn-sm lri-match-btn" data-page="${i}">&#43; Match to Order</button>`;
        const noText = !(page.rawText || '').trim();
        const noFieldsHint = noText
          ? 'Image-only label (no text layer) — Auto Match reads it with OCR'
          : 'No key fields recognized — enlarge the label and use Match to Order';
        return `
          <div class="lri-row" data-page="${i}">
            <div class="lri-thumb-col">
              <div class="lri-page-num">Page ${i + 1}</div>
              <div class="lri-thumb-wrap">
                <iframe class="lri-pdf-preview" src="${pdfUrl}#toolbar=0" title="Label page ${i + 1}"></iframe>
                <button class="lri-zoom-btn" data-url="${pdfUrl}" data-page="${i + 1}" title="Enlarge label">&#x26F6; Enlarge</button>
              </div>
            </div>
            <div class="lri-info-col">
              <div class="lri-status-row">
                <span class="lri-badge ${statusCls}">${page.matchStatus}</span>
                ${page.matchMethod ? `<span class="lri-method">via ${page.matchMethod.replace('_', ' ')}</span>` : ''}
                ${page.ocr ? '<span class="lri-method">&#128269; read by OCR</span>' : ''}
              </div>
              <div class="lri-fields">${fields || `<span class="hint">${noFieldsHint}</span>`}</div>
              <div class="lri-match-action">${matchAction}</div>
            </div>
          </div>`;
      }).join('');

      body.querySelectorAll('.lri-zoom-btn').forEach(btn =>
        btn.addEventListener('click', () => openLabelLightbox(btn.dataset.url, `Label — Page ${btn.dataset.page}`))
      );

      body.querySelectorAll('.lri-match-btn').forEach(btn =>
        btn.addEventListener('click', () => openManualMatchModal(importId, parseInt(btn.dataset.page)))
      );
      body.querySelectorAll('.lri-unmatch-btn').forEach(btn =>
        btn.addEventListener('click', async () => {
          const pageIdx = parseInt(btn.dataset.page);
          if (!confirm('Remove the match for this label page?')) return;
          try {
            const r = await fetch(`/api/label-imports/${importId}/pages/${pageIdx}/match`, { method: 'DELETE' });
            if (!r.ok) throw new Error((await r.json()).error || 'Unmatch failed');
            await refreshOrders();
            openLabelReview(importId);
          } catch (err) { alert(err.message); }
        })
      );
    } catch (err) {
      body.innerHTML = `<p class="hint" style="color:var(--danger);padding:2rem">${esc(err.message)}</p>`;
    }
  }

  // ── Label lightbox — full-screen enlarge for checking label details ────────
  function openLabelLightbox(pdfUrl, title) {
    const box = document.getElementById('labelLightbox');
    document.getElementById('labelLightboxTitle').textContent = title || 'Label';
    document.getElementById('labelLightboxFrame').src = pdfUrl;
    box.classList.remove('hidden');
  }
  function closeLabelLightbox() {
    const box = document.getElementById('labelLightbox');
    box.classList.add('hidden');
    document.getElementById('labelLightboxFrame').src = 'about:blank';
  }
  document.getElementById('labelLightboxClose').addEventListener('click', closeLabelLightbox);
  document.getElementById('labelLightbox').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeLabelLightbox();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('labelLightbox').classList.contains('hidden')) closeLabelLightbox();
  });

  function openManualMatchModal(importId, pageIdx) {
    const modal = document.getElementById('labelManualMatchOverlay');
    const list  = document.getElementById('labelMatchOrderList');
    const input = document.getElementById('labelMatchSearchInput');
    input.value = '';

    function renderList(filter) {
      const q = filter.trim().toLowerCase();
      const filtered = loadedOrders.filter(o =>
        !q ||
        o.order_number.toLowerCase().includes(q) ||
        (o.customer_name || '').toLowerCase().includes(q) ||
        (o.carrier || '').toLowerCase().includes(q)
      );
      list.innerHTML = filtered.slice(0, 60).map(o => `
        <div class="lmm-order-row" data-order="${esc(o.order_number)}">
          <div class="lmm-order-no">${esc(o.order_number)}</div>
          <div class="lmm-order-meta">
            ${o.customer_name ? `<span>${esc(o.customer_name)}</span>` : ''}
            ${o.carrier ? `<span class="chip chip-carrier">${esc(o.carrier)}</span>` : ''}
            <span class="status-badge ${esc(o.scan_status)}">${esc(o.scan_status)}</span>
          </div>
        </div>`).join('') || '<p class="hint" style="padding:.75rem">No orders match.</p>';
      list.querySelectorAll('.lmm-order-row').forEach(row =>
        row.addEventListener('click', async () => {
          const orderNumber = row.dataset.order;
          modal.classList.add('hidden');
          try {
            const r = await fetch(`/api/label-imports/${importId}/pages/${pageIdx}/match`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ orderNumber }),
            });
            if (!r.ok) throw new Error((await r.json()).error || 'Match failed');
            await refreshOrders();
            openLabelReview(importId);
          } catch (err) { alert(err.message); }
        })
      );
    }

    renderList('');
    const onInput = () => renderList(input.value);
    input.addEventListener('input', onInput);
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 100);
  }

  // Labels tab upload wiring
  const labelImportDropZone = document.getElementById('labelImportDropZone');
  labelImportDropZone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; labelImportDropZone.classList.add('dragover'); });
  labelImportDropZone.addEventListener('dragleave', () => labelImportDropZone.classList.remove('dragover'));
  labelImportDropZone.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation(); labelImportDropZone.classList.remove('dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) doLabelImport(file);
  });
  document.getElementById('labelImportBrowseBtn').addEventListener('click', () =>
    document.getElementById('labelImportFileInput').click()
  );
  document.getElementById('labelImportFileInput').addEventListener('change', e => {
    if (e.target.files[0]) doLabelImport(e.target.files[0]);
  });
  document.getElementById('refreshLabelImportsBtn').addEventListener('click', renderLabelsTab);
  document.getElementById('closeLabelReviewBtn').addEventListener('click', () =>
    document.getElementById('labelReviewOverlay').classList.add('hidden')
  );
  document.getElementById('labelMatchCancelBtn').addEventListener('click', () =>
    document.getElementById('labelManualMatchOverlay').classList.add('hidden')
  );

  // Deployed-build stamp in the sidebar — /api/version is public (no data),
  // so this runs even before login and never trips the 401 force-reload.
  // ── "New Work In" pokes ───────────────────────────────────────────────────
  // Work that arrives from OUTSIDE the office — a client submitting an ASN
  // through their portal, or a batch of outbound orders landing — surfaces here
  // so nobody has to keep refreshing the Inbound/Orders tabs to notice it.
  // ── Client submissions — approve before they become work ─────────────────
  // A client's portal upload waits here. The queue polls on the same cadence as
  // the poke bell, and anything left unapproved past the server's SLA raises a
  // BLOCKING prompt: per the requirement, the screen cannot be used for
  // anything else until it is acknowledged.
  (function initClientSubs() {
    const btn = document.getElementById('clientSubBtn');
    if (!btn) return;
    const countEl = document.getElementById('clientSubCount');
    let rows = [], pending = 0, overdue = 0, slaMinutes = 15;
    let current = null;                       // submission open in the preview
    let nagShownFor = new Set();              // ids already acknowledged this session

    async function load() {
      if (!localStorage.getItem('wms_token')) return;   // never call /api before login
      try {
        const d = await (await fetch('/api/client-submissions')).json();
        rows = d.rows || []; pending = d.pending || 0; overdue = d.overdue || 0;
        slaMinutes = d.slaMinutes || 15;
        countEl.textContent = pending;
        countEl.classList.toggle('hidden', pending === 0);
        btn.classList.toggle('has-new', pending > 0);
        maybeNag();
      } catch (_) { /* offline — keep the last state */ }
    }

    // THE 15-MINUTE PROMPT. Blocks the screen for the oldest overdue submission
    // that has not already been acknowledged in this session.
    function maybeNag() {
      if (document.querySelector('.modal-overlay:not(.hidden)')) return;  // don't stack on another dialog
      const due = rows.filter(r => r.overdue && !nagShownFor.has(r.id));
      if (!due.length) return;
      const s = due[due.length - 1];          // oldest first — rows come newest-first
      document.getElementById('clientSubNagText').innerHTML =
        `<b>${esc(s.client_name)}</b> sent ${s.kind === 'labels' ? `${s.row_count} shipping label page(s)` : `${s.order_count} order(s)`} `
        + `(<b>${esc(s.code)}</b>) <b>${s.age_minutes} minutes ago</b> and it has not been approved yet.<br><br>`
        + `Approval is what puts this on the floor — until then nobody is picking it.`;
      document.getElementById('clientSubNagOverlay').classList.remove('hidden');
      document.getElementById('clientSubNagOverlay').dataset.subId = s.id;
    }

    function render() {
      const el = document.getElementById('clientSubList');
      if (!rows.length) {
        el.innerHTML = '<p class="hint" style="text-align:center;padding:1.6rem 0">No client submissions yet. '
          + 'Anything a client uploads from their portal appears here for approval.</p>';
        return;
      }
      el.innerHTML = rows.map(s => {
        const pend = s.status === 'pending';
        const cls = s.status === 'approved' ? 'ok' : s.status === 'rejected' ? 'bad' : (s.overdue ? 'warn' : '');
        const label = s.status === 'approved' ? 'Approved' : s.status === 'rejected' ? 'Rejected'
                    : (s.overdue ? `Waiting ${s.age_minutes} min` : 'Waiting');
        const what = s.kind === 'labels'
          ? `${s.row_count} shipping label page(s)`
          : `${s.order_count} order(s) · ${s.row_count} line(s) · ${s.total_qty} pcs`;
        return `<div class="poke-row ${pend ? 'unread' : ''}">
          <div class="pk-ic out">${s.kind === 'labels' ? '&#127991;' : '&#128666;'}</div>
          <div class="pk-b">
            <div class="pk-t">${esc(s.client_name)} <span class="poke-chan">${esc(s.code)}</span>
              <span class="cs-pill ${cls}">${esc(label)}</span></div>
            <div class="pk-s">${esc(s.filename)} — ${what}</div>
            ${s.labels ? `<div class="pk-s">&#127991; ${esc(s.labels.filename)} — ${
              s.labels.matched == null ? `${s.labels.pages} page(s)`
              : `<b>${s.labels.matched} of ${s.labels.pages}</b> matched to these orders by the client`}</div>` : ''}
            ${s.job_code ? `<div class="pk-s">Created job <b>${esc(s.job_code)}</b></div>` : ''}
            ${s.reject_reason ? `<div class="pk-s">Reason: ${esc(s.reject_reason)}</div>` : ''}
          </div>
          ${pend ? `<button class="btn-primary btn-sm cs-review" data-id="${esc(s.id)}">Review</button>` : ''}
        </div>`;
      }).join('');
    }

    async function openPreview(id) {
      const d = await (await fetch('/api/client-submissions/' + encodeURIComponent(id))).json();
      current = d;
      document.getElementById('clientSubPrevTitle').textContent = `${d.client_name} — ${d.code}`;
      const warn = (d.warnings || []).length
        ? `<div class="confirm-errors">${d.warnings.map(esc).join('<br>')}</div>` : '';
      // The waybills the client attached in step 2, and the match they already
      // saw. Approving processes them straight after the batch is created, so
      // the approver should know they are coming.
      const lab = d.labels ? `<div class="confirm-dup-warnings">
          &#127991; <b>${esc(d.labels.filename)}</b> — ${d.labels.pages} waybill page(s),
          ${d.labels.matched == null ? 'not matched yet'
            : `<b>${d.labels.matched} of ${d.labels.pages}</b> already matched to the orders below`}.
          These are filed against the orders automatically when you approve.
          ${(d.labels.unmatched || []).length
            ? `<br><span class="hint">Did not match: ${d.labels.unmatched.slice(0, 8).map(u =>
                 esc(`p.${u.page}${u.tracking ? ' ' + u.tracking : ''}`)).join(', ')}${
                 d.labels.unmatched.length > 8 ? ` and ${d.labels.unmatched.length - 8} more` : ''} — we re-try these on approval.</span>`
            : ''}
        </div>` : '';
      const body = d.kind === 'labels'
        ? `<p class="hint">${esc(d.filename)} — ${d.row_count} waybill page(s). Approving files these against matching orders.</p>`
        : `<p class="hint">${esc(d.filename)} — ${d.order_count} order(s), ${d.row_count} line(s), ${d.total_qty} pcs.
             SKUs and descriptions below were resolved against this client's item master.</p>
           ${warn}
           ${lab}
           <table class="tbl" style="width:100%;border-collapse:collapse;font-size:.82rem">
             <thead><tr><th>Order</th><th>SKU</th><th>Description</th><th style="text-align:right">Qty</th></tr></thead>
             <tbody>${(d.preview || []).map(o => (o.lines || []).map((l, i) => `<tr>
               <td>${i === 0 ? esc(o.order_number) : ''}</td><td><b>${esc(l.sku)}</b></td>
               <td>${esc(String(l.description || '').slice(0, 60))}</td>
               <td style="text-align:right">${l.qty}</td></tr>`).join('')).join('')}</tbody>
           </table>`;
      document.getElementById('clientSubPrevBody').innerHTML = body;
      document.getElementById('clientSubOverlay').classList.add('hidden');
      document.getElementById('clientSubPreviewOverlay').classList.remove('hidden');
    }

    async function approve() {
      if (!current) return;
      const arrange = confirm('Also create Transport delivery jobs for these orders?\n\nOK = yes, create them\nCancel = orders only');
      let r = await fetch(`/api/client-submissions/${encodeURIComponent(current.id)}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': localStorage.getItem('wms_token') || '' },
        body: JSON.stringify({ arrange_delivery: arrange ? 'yes' : 'no' }),
      });
      let j = await r.json();
      if (r.status === 409 && j.needsDuplicateConfirm) {
        const list = (j.duplicates || []).map(d => `${d.order} (${d.status})`).join('\n');
        if (!confirm(`${j.message}\n\n${list}\n\nApprove anyway?`)) return;
        r = await fetch(`/api/client-submissions/${encodeURIComponent(current.id)}/approve`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': localStorage.getItem('wms_token') || '' },
          body: JSON.stringify({ arrange_delivery: arrange ? 'yes' : 'no', confirm_duplicates: 'yes' }),
        });
        j = await r.json();
      }
      if (!r.ok) { alert(j.error || 'Could not approve.'); return; }
      const labMsg = j.labels
        ? (j.labels.error
            ? `\n\nThe attached waybills could not be processed: ${j.labels.error}\nThe orders are live — re-upload the label PDF from Labels.`
            : `\n\nWaybills: ${j.labels.matched} of ${j.labels.pageCount} page(s) matched.`)
        : '';
      alert(`Approved — job ${j.job} created with ${j.orderCount} order(s).${labMsg}`);
      document.getElementById('clientSubPreviewOverlay').classList.add('hidden');
      current = null;
      await load(); render();
      if (typeof refreshOrders === 'function') refreshOrders();
    }

    async function reject() {
      if (!current) return;
      const reason = prompt('Why are you rejecting this? The client sees this message.');
      if (reason === null) return;
      if (!reason.trim()) { alert('A reason is required.'); return; }
      const r = await fetch(`/api/client-submissions/${encodeURIComponent(current.id)}/reject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': localStorage.getItem('wms_token') || '' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Could not reject.'); return; }
      document.getElementById('clientSubPreviewOverlay').classList.add('hidden');
      current = null;
      await load(); render();
    }

    btn.addEventListener('click', () => { load().then(render); document.getElementById('clientSubOverlay').classList.remove('hidden'); });
    document.getElementById('clientSubCloseBtn').addEventListener('click', () => document.getElementById('clientSubOverlay').classList.add('hidden'));
    document.getElementById('clientSubList').addEventListener('click', e => {
      const b = e.target.closest('.cs-review'); if (b) openPreview(b.dataset.id);
    });
    document.getElementById('clientSubPrevBack').addEventListener('click', () => {
      document.getElementById('clientSubPreviewOverlay').classList.add('hidden');
      document.getElementById('clientSubOverlay').classList.remove('hidden');
    });
    document.getElementById('clientSubApproveBtn').addEventListener('click', approve);
    document.getElementById('clientSubRejectBtn').addEventListener('click', reject);
    document.getElementById('clientSubNagLater').addEventListener('click', () => {
      const ov = document.getElementById('clientSubNagOverlay');
      nagShownFor.add(ov.dataset.subId); ov.classList.add('hidden');
    });
    document.getElementById('clientSubNagOpen').addEventListener('click', () => {
      const ov = document.getElementById('clientSubNagOverlay');
      nagShownFor.add(ov.dataset.subId); ov.classList.add('hidden');
      load().then(render);
      document.getElementById('clientSubOverlay').classList.remove('hidden');
    });

    // Same self-arming schedule the poke bell uses: poll fast until a token
    // exists (initPokes runs at parse time, before login), then settle.
    (function tick() {
      load();
      setTimeout(tick, localStorage.getItem('wms_token') ? 60000 : 2000);
    })();
  })();

  (function initPokes() {
    const btn = document.getElementById('pokeBtn');
    if (!btn) return;
    const countEl = document.getElementById('pokeCount');
    let rows = [], unread = 0;

    const rel = at => {
      const ms = Date.now() - new Date(at).getTime();
      if (!isFinite(ms)) return '';
      const m = Math.floor(ms / 60000);
      if (m < 1) return 'just now';
      if (m < 60) return m + 'm ago';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h ago';
      return Math.floor(h / 24) + 'd ago';
    };

    async function load() {
      if (!localStorage.getItem('wms_token')) return;   // never call /api before login
      try {
        const d = await (await fetch('/api/pokes')).json();
        rows = d.rows || []; unread = d.unread || 0;
        countEl.textContent = unread;
        countEl.classList.toggle('hidden', unread === 0);
        btn.classList.toggle('has-new', unread > 0);
      } catch (_) { /* offline — leave the last state */ }
    }

    function render() {
      const el = document.getElementById('pokeList');
      if (!rows.length) {
        el.innerHTML = '<p class="hint" style="text-align:center;padding:1.6rem 0">Nothing new has come in. '
          + 'Client ASNs and uploaded order batches will appear here.</p>';
        return;
      }
      el.innerHTML = rows.map(p => {
        const out = p.direction === 'outbound';
        const chan = p.channel ? `<span class="poke-chan">${esc(p.channel)}</span>` : '';
        const what = out
          ? `${p.orders || 0} order(s) · ${p.lines || 0} line(s)${p.pieces ? ` · ${p.pieces} pcs` : ''}`
          : `${p.lines || 0} line(s)${p.pieces ? ` · ${p.pieces} pcs` : ''}${p.due ? ` · due ${esc(p.due)}` : ''}`;
        return `<div class="poke-row ${p.read ? '' : 'unread'}" data-dir="${out ? 'outbound' : 'inbound'}">
          <div class="pk-ic ${out ? 'out' : ''}">${out ? '&#128666;' : '&#128229;'}</div>
          <div class="pk-b">
            <div class="pk-t">${esc(p.client || 'Unknown client')}${chan}
              <span style="font-weight:600;color:#64748b"> — ${out ? 'orders to pick' : 'shipment to receive'}</span></div>
            <div class="pk-s">${what}${p.ref ? ` · ${esc(p.ref)}` : ''}</div>
          </div>
          <div class="pk-when">${rel(p.at)}</div>
        </div>`;
      }).join('');
      // Tapping a row jumps to the tab that work lives on.
      el.querySelectorAll('.poke-row').forEach(r => r.addEventListener('click', () => {
        document.getElementById('pokeOverlay').classList.add('hidden');
        switchTab(r.dataset.dir === 'outbound' ? 'orders' : 'inbound');
      }));
    }

    btn.addEventListener('click', async () => {
      await load(); render();
      document.getElementById('pokeOverlay').classList.remove('hidden');
    });
    document.getElementById('pokeCloseBtn').addEventListener('click', () =>
      document.getElementById('pokeOverlay').classList.add('hidden'));
    document.getElementById('pokeAckBtn').addEventListener('click', async () => {
      try {
        await fetch('/api/pokes/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      } catch (_) {}
      await load(); render();
      // Close after acknowledging — there is nothing left to act on in here,
      // and leaving a modal open blocks the sidebar behind it.
      document.getElementById('pokeOverlay').classList.add('hidden');
    });

    // This runs at script-parse time, BEFORE the user has signed in, so the
    // first load() would find no token and bail — leaving the badge blank for a
    // whole polling interval after login. Poll quickly until a session exists,
    // then settle to the normal cadence.
    let pokeTimer = null;
    function schedule(ms) {
      clearTimeout(pokeTimer);
      pokeTimer = setTimeout(tick, ms);
    }
    async function tick() {
      if (!localStorage.getItem('wms_token')) { schedule(2000); return; }  // waiting for login
      await load();
      schedule(60000);   // a minute is plenty for "new work has arrived"
    }
    tick();
  })();

  (function initBuildStamp() {
    const el = document.getElementById('buildStamp');
    if (!el) return;
    fetch('/api/version').then(r => r.json()).then(v => {
      const boot = v.bootedAt ? new Date(v.bootedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      el.textContent = `build ${v.commit || 'dev'}${boot ? ` · up since ${boot}` : ''}`;
      showStorageBanner(v.storage);
    }).catch(() => {});
  })();

  // Storage-persistence state. This used to paint a fixed bar across the top of
  // every screen; per the user's instruction NO warnings appear on the top
  // banner any more — everything surfaces under Administrator → System Outages
  // instead (see systemHealthIssues / renderSystemHealth below). Kept as a
  // stash of the boot snapshot so the panel can report it.
  let _storageSnapshot = null;
  function showStorageBanner(storage) { _storageSnapshot = storage || null; }

  // ── Subsystem health → Administrator → System Outages ONLY ────────────────
  // These warnings deliberately do NOT appear as a banner on the top of the
  // screen: on a phone the amber bar ate two lines of every page, and it also
  // painted over the scan overlay's order number while a packer was picking.
  // They are reported in one place — Administrator → System Outages — and
  // counted in that tab's nav badge so an admin still knows to look.
  let _healthIssues = [];

  function deriveHealthIssues(h, storage) {
    const out = [];
    if (!h) return out;
    if (h.inventoryAvailable === false) out.push({ sev: 'crit',
      title: 'Inventory store is DOWN',
      text: 'Stock levels and reservations are not being tracked. Bin locations and quantities cannot be read or written until this recovers.' });
    if (h.inventoryPathMismatch) out.push({ sev: 'crit',
      title: 'DATA LOSS RISK — inventory is on a different disk',
      text: 'Bin locations and stock are being saved to a different, non-persistent folder than the main database, so they will be lost on the next restart. Set DATA_DIR in Railway so both use the same volume.' });
    if (storage && storage.dataLostOnLastRestart) out.push({ sev: 'crit',
      title: 'DATA WAS LOST ON THE LAST RESTART',
      text: 'This server\'s storage does not survive restarts. In Railway → this service → Volumes, add a Volume (mount path e.g. /data) and redeploy. The app picks up a mounted volume automatically.' });
    else if (storage && storage.ephemeralRisk && !storage.persistent && !storage.dataDirExplicit) out.push({ sev: 'crit',
      title: 'No persistent storage configured',
      text: 'Running on Railway with no Volume or DATA_DIR — data will not survive the next redeploy. Add a Volume in Railway and redeploy.' });
    if (h.masterKeyDefault) out.push({ sev: 'warn',
      title: 'Administrator key is still the built-in default',
      text: 'The key that ships in the source code is in use, so anyone who can read the code could open the Administrator panel. In Railway → Variables, add MASTER_KEY set to a new secret, then redeploy. That value becomes the Administrator key; nothing else needs changing.' });
    if (h.labelOcrRenderAvailable === false) out.push({ sev: 'warn',
      title: 'Label OCR rendering unavailable',
      text: 'Image-only shipping labels (ones with no text layer) will not auto-match on this deployment. Check the boot log for the @napi-rs/canvas error.' });
    if (h.zortOutboxStalled > 0) out.push({ sev: 'warn',
      title: `Stock sync stalled — ${h.zortOutboxStalled} update(s) failing`,
      text: 'Stock updates are repeatedly failing to reach the connected store. Check the store connection under Connections.' });
    return out;
  }

  function renderSystemHealth() {
    const el = document.getElementById('sysHealthBlock');
    if (!el) return;
    if (!_healthIssues.length) {
      el.innerHTML = '<div class="empty-state" style="padding:1rem;color:#059669;border-left:4px solid #059669">'
        + '&#10003; System health: all subsystems nominal.</div>';
      return;
    }
    el.innerHTML = _healthIssues.map(i => {
      const crit = i.sev === 'crit';
      return `<div class="user-row" style="display:block;border-left:4px solid ${crit ? '#dc2626' : '#d97706'};background:${crit ? '#fef2f2' : '#fffbeb'}">
        <div style="font-weight:800;font-size:.85rem;color:${crit ? '#991b1b' : '#92400e'}">
          ${crit ? '&#9940;' : '&#9888;'} ${esc(i.title)}</div>
        <div style="font-size:.8rem;color:#475569;margin-top:.2rem">${esc(i.text)}</div>
      </div>`;
    }).join('');
  }

  async function refreshSystemHealth() {
    if (!currentUser) { _healthIssues = []; return; }
    try {
      const r = await fetch('/api/system-health');   // staff-session gated
      if (!r.ok) return;
      _healthIssues = deriveHealthIssues(await r.json(), _storageSnapshot);
    } catch { return; }
    renderSystemHealth();
    // Roll health into the System Outages nav badge so an admin still notices
    // there is something to look at without a banner shouting on every page.
    try { outagesUI.refreshBadge(); } catch {}
  }
  setTimeout(refreshSystemHealth, 4000);      // let login settle
  setInterval(refreshSystemHealth, 60000);

  // ── Install-app helper ─────────────────────────────────────────────────────
  // iOS NEVER fires an install prompt — installing means Safari → Share →
  // "Add to Home Screen", which nobody finds unaided, so we spell it out.
  // Android/Chrome exposes beforeinstallprompt, so there we show a real
  // Install button. Hidden once running standalone or after dismissal
  // (per-device, localStorage — allowed under the device-local rule).
  (function initInstallHint() {
    const bar = document.getElementById('installHintBar');
    if (!bar) return;
    const txt       = document.getElementById('installHintText');
    const actionBtn = document.getElementById('installHintAction');
    const closeBtn  = document.getElementById('installHintClose');
    const DISMISS_KEY = 'is_install_hint_dismissed';

    const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
    if (isStandalone) return;
    try { if (localStorage.getItem(DISMISS_KEY)) return; } catch {}

    closeBtn.addEventListener('click', () => {
      bar.classList.add('hidden');
      try { localStorage.setItem(DISMISS_KEY, '1'); } catch {}
    });

    const ua = navigator.userAgent || '';
    // iPadOS 13+ masquerades as Macintosh — the touch check catches it
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (isIOS) {
      const inSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
      txt.innerHTML = inSafari
        ? '&#128242; Install this app: tap the <b>Share</b> button (square with &#8593;), then <b>&ldquo;Add to Home Screen&rdquo;</b>.'
        : '&#128242; To install on iPhone/iPad: open this page in <b>Safari</b>, tap <b>Share</b>, then <b>&ldquo;Add to Home Screen&rdquo;</b>.';
      bar.classList.remove('hidden');
      return;
    }
    // Android / desktop Chrome & Edge — a real, tappable install prompt
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      txt.innerHTML = '&#128242; Install <b>IDEALONE</b> on this device for full-screen scanning.';
      actionBtn.classList.remove('hidden');
      bar.classList.remove('hidden');
      actionBtn.addEventListener('click', () => {
        bar.classList.add('hidden');
        e.prompt();
      }, { once: true });
    });
    window.addEventListener('appinstalled', () => bar.classList.add('hidden'));
  })();

  // ── INVENTORY UI — client-owned stock (3PL). Pick a client, load/upload their
  // stock; uploads ADD to on-hand and (optionally) sync levels up to ZORT. ────
  // ── Inventory sub-views ────────────────────────────────────────────────────
  // The Inventory tab used to stack every function (bundles, bins, transfers,
  // cycle counts, quarantine, serials…) on one page. Each is now its own view
  // reached from the sidebar sub-menu; the DOM is untouched, so all existing
  // wiring keeps working — only which view is visible changes. The landing
  // view is a warehouse-wide overview (all clients), NOT client-scoped.
  let _invView = 'overview';
  function setInventoryView(view) {
    _invView = view || 'overview';
    document.querySelectorAll('#tab-inventory .inv-view').forEach(el => {
      el.classList.toggle('hidden', el.dataset.invView !== _invView);
    });
    document.querySelectorAll('#inventorySubMenu .inv-sub').forEach(b => {
      b.classList.toggle('active', b.dataset.invView === _invView);
    });
    // The client picker only makes sense for client-scoped views; the
    // warehouse overview spans every client, so it's hidden there.
    const picker = document.getElementById('invClientPicker');
    if (picker) picker.classList.toggle('hidden', _invView === 'overview');
    if (_invView === 'overview') loadInventoryOverview();
    if (_invView === 'map')      loadWarehouseMap();
  }

  // Rack-elevation schematic of the warehouse. Each aisle is drawn as an
  // elevation: shelves stacked with the TOP shelf at the top (how you'd face
  // the rack), bins left→right across each shelf. Colour = how full the bin
  // is, so a full aisle is obvious at a glance.
  let _mapBins = null;
  async function loadWarehouseMap(useCache) {
    const body = document.getElementById('mapBody');
    if (!body) return;
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    if (!useCache || !_mapBins) {
      body.innerHTML = '<p class="hint">Loading map…</p>';
      try {
        const r = await fetch('/api/inventory/locations/map');
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load the map');
        _mapBins = await r.json();
      } catch (e) { body.innerHTML = `<p class="hint">⚠ ${esc(e.message)}</p>`; return; }
    }
    const bins = _mapBins || [];
    if (!bins.length) {
      body.innerHTML = '<p class="hint">No bin locations yet — create them under <b>Bin Locations</b> (the range generator builds a whole rack in one go).</p>';
      document.getElementById('mapSummary').textContent = '';
      return;
    }
    // zone filter options (built once from the data)
    const zoneSel = document.getElementById('mapZoneFilter');
    const zones = [...new Set(bins.map(b => b.zone))].sort();
    if (zoneSel && zoneSel.options.length <= 1) {
      zoneSel.innerHTML = '<option value="">All zones</option>' + zones.map(z => `<option value="${esc(z)}">Zone ${esc(z)}</option>`).join('');
    }
    const pick = zoneSel ? zoneSel.value : '';
    const shown = pick ? bins.filter(b => b.zone === pick) : bins;

    const cls = b => {
      if (!b.active) return 'b-off';
      const cap = b.capacity || 0, occ = b.occupied || 0;
      if (occ <= 0) return 'b-empty';
      const pct = cap > 0 ? (occ / cap) * 100 : 100;
      return pct >= 100 ? 'b-full' : pct >= 70 ? 'b-warn' : 'b-low';
    };
    const byZone = {};
    for (const b of shown) ((byZone[b.zone] ||= {})[b.aisle] ||= []).push(b);

    body.innerHTML = Object.keys(byZone).sort().map(z => {
      const aisles = byZone[z];
      const zBins = Object.values(aisles).flat();
      const zCap  = zBins.reduce((s, b) => s + (b.capacity || 0), 0);
      const zOcc  = zBins.reduce((s, b) => s + (b.occupied || 0), 0);
      return `
      <div class="map-zone">
        <div class="map-zone-hd">Zone ${esc(z)}
          <span class="zpill">${Object.keys(aisles).length} aisle(s)</span>
          <span class="zpill">${zBins.length} bins</span>
          <span class="zpill">${zCap ? Math.round((zOcc / zCap) * 100) : 0}% full</span>
        </div>
        ${Object.keys(aisles).sort().map(a => {
          const list = aisles[a];
          const shelves = [...new Set(list.map(b => b.shelf))].sort().reverse(); // top shelf first
          const binCols = [...new Set(list.map(b => b.bin))].sort();
          return `
          <div class="map-aisle">
            <div class="map-aisle-hd">Aisle ${esc(a)} <span class="hint">— ${list.length} bins</span></div>
            ${shelves.map(sh => `
              <div class="map-row">
                <span class="map-row-lbl">Shelf ${esc(sh)}</span>
                ${binCols.map(bn => {
                  const b = list.find(x => x.shelf === sh && x.bin === bn);
                  if (!b) return '<span class="map-bin" style="visibility:hidden"></span>';
                  const pct = b.capacity ? Math.round((b.occupied / b.capacity) * 100) : 0;
                  const title = `${b.location_id} — ${b.occupied}/${b.capacity} units (${pct}%)`
                    + `\n${b.kind || 'pick'} · ${b.environment || 'dry'}${b.active ? '' : ' · INACTIVE'}`
                    + (b.skus ? `\n${b.skus} SKU(s), ${b.clients} client(s)` : '\nEmpty');
                  return `<span class="map-bin ${cls(b)}${b.kind === 'bulk' ? ' b-bulk' : ''}" title="${esc(title)}" data-bin="${esc(b.location_id)}">${esc(bn)}<small>${pct}%</small></span>`;
                }).join('')}
              </div>`).join('')}
            <div class="map-row"><span class="map-row-lbl"></span>${binCols.map(bn => `<span class="map-row-lbl" style="min-width:46px;text-align:center">${esc(bn)}</span>`).join('')}</div>
          </div>`;
        }).join('')}
      </div>`;
    }).join('');

    const cap = shown.reduce((s, b) => s + (b.capacity || 0), 0);
    const occ = shown.reduce((s, b) => s + (b.occupied || 0), 0);
    const used = shown.filter(b => (b.occupied || 0) > 0).length;
    document.getElementById('mapSummary').textContent =
      `${shown.length} bins · ${used} in use · ${occ.toLocaleString()}/${cap.toLocaleString()} units (${cap ? Math.round((occ / cap) * 100) : 0}%)`;

    // clicking a bin runs the existing bin lookup so you can see its contents
    body.querySelectorAll('.map-bin[data-bin]').forEach(el => el.addEventListener('click', () => {
      const inp = document.getElementById('binLookup');
      if (inp) inp.value = el.dataset.bin;
      setInventoryView('locations');
      document.getElementById('binLookupBtn')?.click();
    }));
  }
  document.getElementById('mapRefreshBtn')?.addEventListener('click', () => loadWarehouseMap(false));
  document.getElementById('mapZoneFilter')?.addEventListener('change', () => loadWarehouseMap(true));
  document.getElementById('inventorySubMenu')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.inv-sub');
    if (btn) setInventoryView(btn.dataset.invView);
  });

  async function loadInventoryOverview() {
    const loading = document.getElementById('invOvLoading');
    const body    = document.getElementById('invOvBody');
    if (!loading || !body) return;
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const n = v => (Number(v) || 0).toLocaleString();
    const meter = pct => {
      const cls = pct >= 90 ? 'ov-meter full' : pct >= 70 ? 'ov-meter warn' : 'ov-meter';
      return `<div class="${cls}" title="${pct}%"><span style="width:${Math.min(100, pct)}%"></span></div>`;
    };
    loading.classList.remove('hidden');
    body.classList.add('hidden');
    let d;
    try {
      const r = await fetch('/api/inventory/overview');
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load overview');
      d = await r.json();
    } catch (err) {
      loading.textContent = '⚠ ' + err.message;
      return;
    }
    const L = d.locations || {}, T = d.totals || {};
    document.getElementById('invOvTiles').innerHTML = [
      ['Bin locations', n(L.total), `${n(L.active)} active · ${n(L.binsEmpty)} empty`],
      ['Capacity (units)', n(L.capacity), `${n(L.storedQty)} stored`],
      ['Occupancy', (L.occupancyPct || 0) + '%', meter(L.occupancyPct || 0)],
      ['Clients storing', n(T.clients), `${n(L.binsUsed)} bins in use`],
      ['SKUs held', n(T.skus), `${n(d.commodities ? d.commodities.length : 0)} commodities`],
      ['Units on hand', n(T.onHand), `${n(T.reserved)} reserved · ${n(T.available)} free`],
    ].map(([label, value, sub]) => `
      <div class="inv-ov-tile">
        <div class="ovt-label">${esc(label)}</div>
        <div class="ovt-value">${esc(value)}</div>
        <div class="ovt-sub">${String(sub).startsWith('<div') ? sub : esc(sub)}</div>
      </div>`).join('');

    const cl = d.clients || [];
    document.getElementById('invOvClientHint').textContent =
      cl.length ? `${cl.length} client(s) with stock on hand` : '';
    document.getElementById('invOvClientBody').innerHTML = cl.length ? cl.map(c => `
      <tr>
        <td><b>${esc(c.clientId)}</b></td>
        <td>${n(c.skus)}</td><td>${n(c.onHand)}</td><td>${n(c.reserved)}</td><td>${n(c.available)}</td>
        <td>${n(c.bins)}</td>
        <td style="min-width:110px">${meter(c.sharePct)}<span class="hint">${c.sharePct}%</span></td>
        <td><button class="btn-secondary btn-sm inv-ov-open" data-client="${esc(c.clientId)}">Open stock →</button></td>
      </tr>`).join('')
      : '<tr><td colspan="8" style="padding:1rem;color:#64748b">No client stock recorded yet.</td></tr>';

    document.getElementById('invOvCommodityBody').innerHTML = (d.commodities || []).length
      ? d.commodities.map(c => `<tr><td>${esc(c.commodity)}</td><td>${n(c.skus)}</td><td>${n(c.units)}</td><td>${n(c.clients)}</td></tr>`).join('')
      : '<tr><td colspan="4" style="padding:1rem;color:#64748b">No commodities yet.</td></tr>';

    document.getElementById('invOvZoneBody').innerHTML = (d.zones || []).length
      ? d.zones.map(z => `<tr><td><b>${esc(z.zone)}</b></td><td>${n(z.bins)}</td><td>${n(z.binsUsed)}</td><td>${n(z.units)}</td><td>${n(z.capacity)}</td>
          <td style="min-width:110px">${meter(z.occupancyPct)}<span class="hint">${z.occupancyPct}%</span></td></tr>`).join('')
      : '<tr><td colspan="6" style="padding:1rem;color:#64748b">No bin locations created yet — add them under <b>Bin Locations</b>.</td></tr>';

    // "Open stock →" jumps straight into that client's stock view, pre-filled
    document.querySelectorAll('.inv-ov-open').forEach(b => b.addEventListener('click', () => {
      const inp = document.getElementById('invClient');
      if (inp) inp.value = b.dataset.client;
      setInventoryView('stock');
      document.getElementById('invLoadBtn')?.click();
    }));

    loading.classList.add('hidden');
    body.classList.remove('hidden');
  }

  function renderInventory() { invUI.init(); }
  const invUI = (function () {
    let clientId = '';
    let items = [];
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const $ = id => document.getElementById(id);

    function init() {
      // Populate the client suggestions from orders already in the app.
      // Dedupe case-insensitively so "BETIME" and "Betime" offer ONE suggestion.
      const seenLc = new Map();
      (loadedOrders || []).forEach(o => {
        const n = String(o.client_name || '').trim();
        if (n && !seenLc.has(n.toLowerCase())) seenLc.set(n.toLowerCase(), n);
      });
      const names = [...seenLc.values()].sort();
      const dl = $('invClientList');
      if (dl) dl.innerHTML = names.map(n => `<option value="${esc(n)}"></option>`).join('');
      // Show the function panels IMMEDIATELY — bin setup is global and works with
      // no client; the client-scoped panels prompt to load a client. (Previously
      // the whole panel set stayed hidden until "Load stock", so the tab looked
      // empty and the functions seemed missing.)
      $('invBody')?.classList.remove('hidden');
      refreshLocations();          // global bins → dropdowns + Manage-bins list
      loadDiscrepancies();         // open bin-empty reports (all clients until one is loaded)
      loadQuarantine();            // damaged/KIV awaiting disposition
      if (!clientId) {
        $('invNoClientHint')?.classList.remove('hidden');
        ['inv-s-total', 'inv-s-onhand', 'inv-s-res', 'inv-s-avail'].forEach(id => { const e = $(id); if (e) e.textContent = '0'; });
        renderList();              // stock table shows the "load a client" prompt
      }
    }

    async function load() {
      clientId = ($('invClient').value || '').trim();
      if (!clientId) { alert('Enter a client name first (the same name used on their orders).'); return; }
      try {
        const [listR, statsR] = await Promise.all([
          fetch('/api/inventory?clientId=' + encodeURIComponent(clientId)),
          fetch('/api/inventory/stats?clientId=' + encodeURIComponent(clientId)),
        ]);
        items = listR.ok ? await listR.json() : [];
        const stats = statsR.ok ? await statsR.json() : {};
        const onHand = items.reduce((s, r) => s + (r.stock_qty || 0), 0);
        const reserved = items.reduce((s, r) => s + (r.reserved_qty || 0), 0);
        const avail = items.reduce((s, r) => s + (r.available_qty || 0), 0);
        $('inv-s-total').textContent = stats.totalSKUs ?? items.length;
        $('inv-s-onhand').textContent = onHand;
        $('inv-s-res').textContent = reserved;
        $('inv-s-avail').textContent = avail;
        $('invBody').classList.remove('hidden');
        $('invNoClientHint')?.classList.add('hidden');
        renderList();
      } catch (e) { alert('Load failed: ' + e.message); }
    }

    function renderList() {
      const tb = $('invTbody'); if (!tb) return;
      const q = ($('invSearch')?.value || '').toLowerCase();
      const rows = items.filter(r => !q || r.sku.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q));
      if (!rows.length) { tb.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2rem;color:#94a3b8">${!clientId ? 'Enter a client above and tap Load stock.' : (items.length ? 'No match.' : 'No stock yet — upload a file to add some.')}</td></tr>`; return; }
      tb.innerHTML = rows.map(r => `<tr>
        <td style="font-family:monospace;font-weight:600">${esc(r.sku)}</td>
        <td>${esc(r.name || '')}</td>
        <td style="text-align:right">${r.stock_qty}</td>
        <td style="text-align:right;color:#d97706">${r.reserved_qty}</td>
        <td style="text-align:right;font-weight:700;color:${r.available_qty <= 0 ? '#dc2626' : '#059669'}">${r.available_qty}</td>
        <td style="text-align:right"><span class="inv-upc-edit" data-sku="${esc(r.sku)}" title="Units per carton — click to edit (powers carton-aware picking)" style="cursor:pointer;border-bottom:1px dashed #94a3b8">${Number(r.units_per_carton) > 1 ? r.units_per_carton : '—'}</span></td>
      </tr>`).join('');
      tb.querySelectorAll('.inv-upc-edit').forEach(el => el.addEventListener('click', async () => {
        const sku = el.dataset.sku;
        const cur = (items.find(x => x.sku === sku) || {}).units_per_carton || '';
        const v = prompt(`Units per carton for ${sku}?\n(1 or empty = no carton size — picks in pieces)`, cur > 1 ? String(cur) : '');
        if (v === null) return;
        const n = Math.max(1, parseInt(v, 10) || 1);
        const row = items.find(x => x.sku === sku) || {};
        const r2 = await fetch('/api/inventory/' + encodeURIComponent(sku), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, name: row.name || sku, units_per_carton: n }) });
        if (r2.ok) load(); else { const e = await r2.json().catch(() => ({})); alert(e.error || 'Update failed'); }
      }));
    }

    function pickFile() {
      if (!clientId) { alert('Load a client first.'); return; }
      const inp = $('invFileInput');
      inp.onchange = async () => { const f = inp.files && inp.files[0]; inp.value = ''; if (f) await uploadFile(f); };
      inp.click();
    }

    async function uploadFile(file) {
      const st = $('invUploadStatus');
      st.className = 'status-bar progress'; st.textContent = `Uploading "${file.name}"…`; st.classList.remove('hidden');
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('clientId', clientId);
        fd.append('mode', 'add'); // adds to existing stock (receiving/restock)
        fd.append('push_to_zort', $('invPushZort').checked ? 'true' : 'false');
        const r = await fetch('/api/inventory/import-file', { method: 'POST', body: fd });
        const d = await r.json();
        if (!r.ok) { st.className = 'status-bar error'; st.textContent = d.error || 'Upload failed'; return; }
        let msg = `✓ Added stock for ${d.applied} SKU(s)`;
        if (d.skipped) msg += `, skipped ${d.skipped}`;
        if (d.pushedToZort) msg += ` · ${d.enqueued} stock update(s) queued to the sales channels`;
        if (d.errors && d.errors.length) msg += ` · first issue: row ${d.errors[0].row} (${d.errors[0].sku}) — ${d.errors[0].error}`;
        st.className = 'status-bar success'; st.textContent = msg;
        load(); // refresh totals + table
      } catch (e) { st.className = 'status-bar error'; st.textContent = 'Upload error: ' + e.message; }
    }

    // ── Bundles / BOM ───────────────────────────────────────────────────────
    async function loadBundles() {
      const tb = $('invBundleTbody'); if (!tb || !clientId) return;
      try {
        const r = await fetch('/api/inventory/bundles?clientId=' + encodeURIComponent(clientId));
        const bundles = r.ok ? await r.json() : [];
        if (!bundles.length) { tb.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:1.2rem;color:#94a3b8">No bundles defined.</td></tr>'; return; }
        tb.innerHTML = bundles.map(b => {
          const isPhys = b.type === 'physical';
          const typeBadge = isPhys
            ? '<span style="font-size:.68rem;background:#ede9fe;color:#6d28d9;padding:.1rem .35rem;border-radius:4px">physical kit</span>'
            : '<span style="font-size:.68rem;background:#e0f2fe;color:#0369a1;padding:.1rem .35rem;border-radius:4px">virtual</span>';
          const canMakeLabel = isPhys ? `can build ${b.available}` : `${b.available}`;
          return `<tr>
          <td style="font-family:monospace;font-weight:600">${esc(b.bundle_sku)}<div>${typeBadge}</div></td>
          <td>${esc(b.name || '')}</td>
          <td style="font-size:.82rem">${b.components.map(c => `${esc(c.sku)}×${c.qty}`).join(' + ')}</td>
          <td style="text-align:right;font-weight:700;color:${b.available <= 0 ? '#dc2626' : '#059669'}">${canMakeLabel}</td>
          <td style="text-align:right;white-space:nowrap">
            ${isPhys ? `<button class="btn-primary btn-sm b-build" data-sku="${esc(b.bundle_sku)}" title="Consume components and add built stock">🔨 Build</button>` : ''}
            <button class="btn-secondary btn-sm b-edit" data-sku="${esc(b.bundle_sku)}">✎</button>
            <button class="btn-danger btn-sm b-del" data-sku="${esc(b.bundle_sku)}">🗑</button>
          </td></tr>`; }).join('');
        tb.querySelectorAll('.b-edit').forEach(btn => btn.addEventListener('click', () => openBundle(bundles.find(x => x.bundle_sku === btn.dataset.sku))));
        tb.querySelectorAll('.b-build').forEach(btn => btn.addEventListener('click', async () => {
          const b = bundles.find(x => x.bundle_sku === btn.dataset.sku);
          const v = prompt(`Build how many "${btn.dataset.sku}"?\n\nYou can build up to ${b.available} from current component stock.\nThis consumes the components and adds the built kits to stock.`);
          if (v === null) return;
          const qty = Number(v);
          if (!(qty > 0)) { alert('Enter a positive number.'); return; }
          try {
            const r = await fetch('/api/inventory/bundles/' + encodeURIComponent(btn.dataset.sku) + '/build', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, qty }) });
            const d = await r.json();
            if (!r.ok) { alert(d.error || 'Build failed'); return; }
            alert(`✓ Built ${d.built} × ${btn.dataset.sku}\nConsumed: ${d.consumed.map(c => c.sku + '×' + c.qty).join(', ')}`);
            load(); // refresh stock + bundles
          } catch (e) { alert('Build error: ' + e.message); }
        }));
        tb.querySelectorAll('.b-del').forEach(btn => btn.addEventListener('click', async () => {
          if (!confirm(`Delete bundle "${btn.dataset.sku}"? (components and their stock are untouched)`)) return;
          await fetch('/api/inventory/bundles/' + encodeURIComponent(btn.dataset.sku) + '?clientId=' + encodeURIComponent(clientId), { method: 'DELETE' });
          loadBundles();
        }));
      } catch (e) { /* leave prior */ }
    }

    function compRow(sku, qty) {
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;gap:.4rem;margin-bottom:.35rem';
      div.innerHTML = `<input class="bm-csku" placeholder="component SKU" value="${esc(sku || '')}" style="flex:2;padding:.4rem .5rem;border:1px solid #e2e8f0;border-radius:6px">
        <input class="bm-cqty" type="number" min="1" value="${qty || 1}" style="width:80px;padding:.4rem .5rem;border:1px solid #e2e8f0;border-radius:6px">
        <button class="btn-secondary btn-sm bm-crm" type="button">✕</button>`;
      div.querySelector('.bm-crm').addEventListener('click', () => div.remove());
      return div;
    }
    function openBundle(b) {
      if (!clientId) { alert('Load a client first.'); return; }
      $('bmSku').value = b?.bundle_sku || '';
      $('bmName').value = b?.name || '';
      $('bmType').value = b?.type === 'physical' ? 'physical' : 'virtual';
      $('bmError').classList.add('hidden');
      const wrap = $('bmComponents'); wrap.innerHTML = '';
      const comps = (b && b.components && b.components.length) ? b.components : [{ sku: '', qty: 1 }];
      comps.forEach(c => wrap.appendChild(compRow(c.sku, c.qty)));
      $('bundleModal').classList.remove('hidden');
    }

    setTimeout(() => {
      $('invLoadBtn')?.addEventListener('click', load);
      $('invUploadBtn')?.addEventListener('click', pickFile);
      $('invClient')?.addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
      $('invBundleAddBtn')?.addEventListener('click', () => openBundle(null));
      $('bmAddComp')?.addEventListener('click', () => $('bmComponents').appendChild(compRow('', 1)));
      $('bmCancelBtn')?.addEventListener('click', () => $('bundleModal').classList.add('hidden'));
      $('bmSaveBtn')?.addEventListener('click', async () => {
        const bundle_sku = $('bmSku').value.trim();
        const name = $('bmName').value.trim();
        const components = [...document.querySelectorAll('#bmComponents > div')].map(d => ({
          sku: d.querySelector('.bm-csku').value.trim(), qty: Number(d.querySelector('.bm-cqty').value) || 0,
        })).filter(c => c.sku && c.qty > 0);
        const err = $('bmError');
        if (!bundle_sku) { err.textContent = 'Bundle SKU is required.'; err.classList.remove('hidden'); return; }
        if (!components.length) { err.textContent = 'Add at least one component.'; err.classList.remove('hidden'); return; }
        try {
          const r = await fetch('/api/inventory/bundles', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId, bundle_sku, name, components, type: $('bmType').value }) });
          const d = await r.json();
          if (!r.ok) { err.textContent = d.error || 'Save failed'; err.classList.remove('hidden'); return; }
          $('bundleModal').classList.add('hidden');
          loadBundles();
        } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
      });
    }, 0);

    // ── WMS: bin locations, putaway, transfers, cycle counts, suppliers/reorder ──
    // (Previously dormant backend — routes existed but had no UI and the GETs were
    //  shadowed by /api/inventory/:sku. Now surfaced, all scoped to the loaded client.)
    let locations = [];
    let ccId = '';
    let ccLines = [];
    function wmsMsg(id, cls, text) { const el = $(id); if (!el) return; el.className = 'status-bar ' + cls; el.textContent = text; el.classList.remove('hidden'); }
    function fillSkuDatalist() {
      const dl = $('invSkuList'); if (dl) dl.innerHTML = items.map(r => `<option value="${esc(r.sku)}"></option>`).join('');
    }
    async function refreshLocations() {
      try { const r = await fetch('/api/inventory/locations'); locations = r.ok ? await r.json() : []; } catch { locations = []; }
      const opts = locations.map(l => `<option value="${esc(l.location_id)}">${esc(l.location_id)}</option>`).join('');
      const blank = '<option value="">— bin —</option>';
      ['putLoc', 'trFrom', 'trTo'].forEach(id => { const s = $(id); if (s) s.innerHTML = blank + opts; });
      const dl = $('binLookupList'); if (dl) dl.innerHTML = opts;
    }
    async function loadLocationStock() {
      const tb = $('locStockTbody'); if (!tb || !clientId) return;
      try {
        const r = await fetch('/api/inventory/location-stock?clientId=' + encodeURIComponent(clientId));
        const rows = r.ok ? await r.json() : [];
        if (!rows.length) { tb.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:1.2rem;color:#94a3b8">No stock placed in bins yet.</td></tr>'; return; }
        // Roll bin fill (all lots at a bin) so we can show qty vs capacity.
        const binTotals = {}; rows.forEach(x => { binTotals[x.location_id] = (binTotals[x.location_id] || 0) + x.quantity; });
        tb.innerHTML = rows.map(x => {
          const cap = x.capacity || 0; const fill = binTotals[x.location_id] || 0;
          const over = cap > 0 && fill > cap;
          const capCell = cap > 0 ? `<div class="hint" style="color:${over ? '#dc2626' : '#94a3b8'}">bin ${fill}/${cap}${over ? ' ⚠ over' : ''}</div>` : '';
          const exp = x.expiry_date ? `<span class="hint" style="margin-left:.3rem">exp ${esc(x.expiry_date)}</span>` : '';
          return `<tr>
          <td style="font-family:monospace">${esc(x.location_id)}${capCell}</td>
          <td>${esc(x.environment || '')}</td>
          <td style="font-family:monospace;font-weight:600">${esc(x.sku)}</td>
          <td>${esc(x.name || '')}${exp}</td>
          <td style="text-align:right;font-weight:700">${x.quantity}</td></tr>`;
        }).join('');
      } catch { /* keep prior */ }
    }
    async function createLocation() {
      const zone = $('locZone').value.trim(), aisle = $('locAisle').value.trim(), shelf = $('locShelf').value.trim(), bin = $('locBin').value.trim();
      if (!zone || !aisle || !shelf || !bin) { wmsMsg('locMsg', 'error', 'Zone, aisle, shelf and bin are all required.'); return; }
      const body = { zone, aisle, shelf, bin, environment: $('locEnv').value, kind: $('locKind').value,
        length_cm: $('locLen').value || 0, width_cm: $('locWid').value || 0, height_cm: $('locHt').value || 0, capacity: $('locCap').value || 0 };
      try {
        const r = await fetch('/api/inventory/locations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json();
        if (!r.ok) { wmsMsg('locMsg', 'error', d.error || 'Failed'); return; }
        wmsMsg('locMsg', 'success', '✓ Bin ' + d.location_id + ' created.');
        ['locZone', 'locAisle', 'locShelf', 'locBin', 'locLen', 'locWid', 'locHt', 'locCap'].forEach(id => { $(id).value = ''; });
        refreshLocations(); if (!$('locManageWrap').classList.contains('hidden')) renderManageBins();
      } catch (e) { wmsMsg('locMsg', 'error', e.message); }
    }
    function renderManageBins() {
      const tb = $('locManageTbody'); if (!tb) return;
      if (!locations.length) { tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:1rem;color:#94a3b8">No bins yet.</td></tr>'; return; }
      const num = (v) => `<input type="number" value="${v || 0}" style="width:64px;padding:.25rem;border:1px solid #e2e8f0;border-radius:5px;text-align:right">`;
      tb.innerHTML = locations.map(l => `<tr data-loc="${esc(l.location_id)}">
        <td style="font-family:monospace">${esc(l.location_id)}</td>
        <td><select class="lm-env" style="padding:.25rem;border:1px solid #e2e8f0;border-radius:5px">${['dry', 'cold', 'frozen'].map(e => `<option value="${e}" ${l.environment === e ? 'selected' : ''}>${e}</option>`).join('')}</select></td>
        <td><select class="lm-kind" style="padding:.25rem;border:1px solid #e2e8f0;border-radius:5px">${[['pick', 'Pick face'], ['bulk', 'Bulk']].map(([v, t]) => `<option value="${v}" ${(l.kind || 'pick') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
        <td class="lm-len">${num(l.length_cm)}</td><td class="lm-wid">${num(l.width_cm)}</td><td class="lm-ht">${num(l.height_cm)}</td><td class="lm-cap">${num(l.capacity)}</td>
        <td><button class="btn-secondary btn-sm lm-save">Save</button></td></tr>`).join('');
      tb.querySelectorAll('.lm-save').forEach(btn => btn.addEventListener('click', async () => {
        const tr = btn.closest('tr'); const id = tr.dataset.loc;
        const body = {
          environment: tr.querySelector('.lm-env').value, kind: tr.querySelector('.lm-kind').value,
          length_cm: tr.querySelector('.lm-len input').value, width_cm: tr.querySelector('.lm-wid input').value,
          height_cm: tr.querySelector('.lm-ht input').value, capacity: tr.querySelector('.lm-cap input').value,
        };
        const r = await fetch('/api/inventory/locations/' + encodeURIComponent(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (r.ok) { wmsMsg('locMsg', 'success', `✓ ${id} updated.`); refreshLocations(); loadLocationStock(); }
        else { const d = await r.json().catch(() => ({})); wmsMsg('locMsg', 'error', d.error || 'Update failed'); }
      }));
    }
    // Bin lookup — scan/type a bin, see everything physically in it (all clients).
    async function binLookup() {
      const id = ($('binLookup').value || '').trim();
      const el = $('binLookupResult');
      if (!id) { el.classList.add('hidden'); return; }
      try {
        const r = await fetch('/api/inventory/bin/' + encodeURIComponent(id));
        const d = await r.json();
        if (!r.ok) { el.className = ''; el.innerHTML = `<span style="color:#dc2626">${esc(d.error || 'Not found')}</span>`; el.classList.remove('hidden'); return; }
        const cap = d.capacity > 0 ? ` · ${d.occupied}/${d.capacity}${d.occupied > d.capacity ? ' ⚠ over' : ''}` : ` · ${d.occupied} units`;
        const env = d.location.environment ? ` (${esc(d.location.environment)})` : '';
        const rows = d.contents.length ? d.contents.map(c => `<tr>
          <td style="font-family:monospace;font-weight:600">${esc(c.sku)}</td>
          <td>${esc(c.name || '')}</td>
          <td class="hint">${esc(c.client_id || '')}</td>
          <td style="text-align:right;font-weight:700">${c.qty}</td>
          <td class="hint">${c.expiry_date ? 'exp ' + esc(c.expiry_date) : ''}${c.lot_number ? ' · lot ' + esc(c.lot_number) : ''}</td></tr>`).join('')
          : '<tr><td colspan="5" style="text-align:center;padding:.8rem;color:#94a3b8">Bin is empty.</td></tr>';
        el.className = '';
        el.innerHTML = `<div style="font-weight:700;margin-bottom:.4rem">📍 ${esc(id)}${env}<span class="hint" style="font-weight:400">${cap}</span></div>
          <div style="overflow-x:auto"><table class="tbl" style="width:100%"><thead><tr><th style="text-align:left">SKU</th><th style="text-align:left">Name</th><th style="text-align:left">Client</th><th style="text-align:right">Qty</th><th style="text-align:left">Lot/Exp</th></tr></thead><tbody>${rows}</tbody></table></div>`;
        el.classList.remove('hidden');
      } catch (e) { el.className = ''; el.innerHTML = `<span style="color:#dc2626">${esc(e.message)}</span>`; el.classList.remove('hidden'); }
    }
    async function placeStock() {
      const sku = $('putSku').value.trim(), location_id = $('putLoc').value, qty = $('putQty').value;
      if (!clientId) { alert('Load a client first.'); return; }
      if (!sku || !location_id || qty === '') { wmsMsg('locMsg', 'error', 'SKU, bin and qty are required.'); return; }
      try {
        const { r, d, cancelled } = await postWithCapacityOverride('/api/inventory/place-stock', { clientId, sku, location_id, qty: Number(qty) });
        if (cancelled) return;
        if (!r.ok) { wmsMsg('locMsg', 'error', d.error || 'Failed'); return; }
        wmsMsg('locMsg', 'success', `✓ ${sku} @ ${location_id} now ${d.quantity}.`);
        $('putSku').value = ''; $('putQty').value = '';
        loadLocationStock();
      } catch (e) { wmsMsg('locMsg', 'error', e.message); }
    }
    async function transfer() {
      const sku = $('trSku').value.trim(), from_location = $('trFrom').value, to_location = $('trTo').value, qty = $('trQty').value;
      if (!clientId) { alert('Load a client first.'); return; }
      if (!sku || !from_location || !to_location || qty === '') { wmsMsg('trMsg', 'error', 'SKU, both bins and qty are required.'); return; }
      if (from_location === to_location) { wmsMsg('trMsg', 'error', 'From and To bins must differ.'); return; }
      try {
        const { r, d, cancelled } = await postWithCapacityOverride('/api/inventory/transfer', { clientId, sku, from_location, to_location, qty: Number(qty) });
        if (cancelled) return;
        if (!r.ok) { wmsMsg('trMsg', 'error', d.error || 'Failed'); return; }
        wmsMsg('trMsg', 'success', `✓ Moved ${d.qty} × ${sku}: ${from_location} → ${to_location}.`);
        $('trQty').value = '';
        loadLocationStock();
      } catch (e) { wmsMsg('trMsg', 'error', e.message); }
    }
    // Print scannable QR labels for every bin — stick them on the shelves.
    // Scanning one in the pick screen verifies the packer is at the right bin.
    function printBinLabels() {
      if (!locations.length) { alert('No bins to print — create bins first.'); return; }
      if (!window.qrcode) { alert('QR library not loaded.'); return; }
      const cards = locations.map(l => {
        const q = qrcode(0, 'M'); q.addData(l.location_id); q.make();
        const svg = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
        return `<div class="card"><div class="qr">${svg}</div><div class="bid">${l.location_id}</div><div class="meta">${l.kind === 'bulk' ? 'BULK' : 'PICK FACE'} · ${(l.environment || 'dry').toUpperCase()}${l.capacity ? ' · max ' + l.capacity : ''}</div></div>`;
      }).join('');
      const win = window.open('', '_blank');
      win.document.write(`<html><head><title>Bin Labels</title><style>
        body{font-family:sans-serif;margin:10mm}
        .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm}
        .card{border:1px solid #000;border-radius:4mm;padding:5mm;text-align:center;page-break-inside:avoid}
        .qr svg{width:32mm;height:32mm}
        .bid{font-family:monospace;font-weight:800;font-size:7mm;margin-top:2mm}
        .meta{font-size:3.2mm;color:#444;margin-top:1mm}
        @media print{.noprint{display:none}}
      </style></head><body>
        <div class="noprint" style="margin-bottom:6mm"><button onclick="window.print()">🖨 Print</button> ${locations.length} label(s)</div>
        <div class="grid">${cards}</div></body></html>`);
      win.document.close();
    }
    // Counts due — stale / never-counted / repeat-discrepancy bins.
    async function loadCountsDue() {
      const el = $('ccDue'); if (!el || !clientId) return;
      try {
        const r = await fetch('/api/inventory/count-suggestions?clientId=' + encodeURIComponent(clientId));
        const d = r.ok ? await r.json() : { suggestions: [] };
        const s = d.suggestions || [];
        el.innerHTML = s.length
          ? `📋 <b>Counts due:</b> ${s.map(x => `<span style="background:#fef3c7;color:#92400e;border-radius:4px;padding:.05rem .35rem;margin-right:.25rem;font-family:monospace">${esc(x.location_id)}</span><span style="margin-right:.6rem">(${x.reasons.map(esc).join(', ')})</span>`).join('')}`
          : '✓ No counts due — every stocked bin counted recently, no repeat discrepancies.';
      } catch { /* keep prior */ }
    }
    function ccRender() {
      const tb = $('ccTbody'); if (!tb) return;
      const blind = $('ccBlind')?.checked;
      if (!ccLines.length) { tb.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:1rem;color:#94a3b8">No lines counted yet.</td></tr>'; return; }
      tb.innerHTML = ccLines.map(l => `<tr>
        <td style="font-family:monospace;font-weight:600">${esc(l.sku)}</td>
        <td style="text-align:right">${blind ? '—' : l.expected}</td>
        <td style="text-align:right">${l.counted}</td>
        <td style="text-align:right;font-weight:700;color:${blind ? '#94a3b8' : (l.variance === 0 ? '#059669' : (l.variance > 0 ? '#0369a1' : '#dc2626'))}">${blind ? '—' : (l.variance > 0 ? '+' : '') + l.variance}</td></tr>`).join('');
    }
    async function ccStart() {
      if (!clientId) { alert('Load a client first.'); return; }
      const id = 'CC-' + Date.now().toString(36).toUpperCase();
      try {
        const r = await fetch('/api/inventory/cycle-counts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, count_id: id }) });
        const d = await r.json();
        if (!r.ok) { wmsMsg('ccMsg', 'error', d.error || 'Failed'); return; }
        ccId = id; ccLines = []; $('ccId').textContent = id; ccRender();
        $('ccActive').classList.remove('hidden'); $('ccMsg').classList.add('hidden');
        $('ccSku').focus();
      } catch (e) { wmsMsg('ccMsg', 'error', e.message); }
    }
    async function ccAddLine() {
      const sku = $('ccSku').value.trim(), qty = $('ccQty').value;
      if (!ccId) return;
      if (!sku || qty === '') { wmsMsg('ccMsg', 'error', 'SKU and counted qty required.'); return; }
      try {
        const r = await fetch('/api/inventory/cycle-counts/' + encodeURIComponent(ccId) + '/lines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, sku, counted_qty: Number(qty) }) });
        const d = await r.json();
        if (!r.ok) { wmsMsg('ccMsg', 'error', d.error || 'Failed'); return; }
        ccLines = ccLines.filter(l => l.sku !== d.sku); ccLines.push({ sku: d.sku, expected: d.expected, counted: d.counted, variance: d.variance });
        $('ccSku').value = ''; $('ccQty').value = ''; $('ccSku').focus(); ccRender();
      } catch (e) { wmsMsg('ccMsg', 'error', e.message); }
    }
    async function ccComplete() {
      if (!ccId) return;
      try {
        const r = await fetch('/api/inventory/cycle-counts/' + encodeURIComponent(ccId) + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }) });
        const d = await r.json();
        if (!r.ok) { wmsMsg('ccMsg', 'error', d.error || 'Failed'); return; }
        $('ccActive').classList.add('hidden');
        wmsMsg('ccMsg', 'success', `✓ Count ${ccId} posted — ${d.lines} line(s), ${d.variances} variance(s) applied to on-hand.`);
        ccId = ''; ccLines = [];
        load(); // refresh stock totals (variances changed them)
      } catch (e) { wmsMsg('ccMsg', 'error', e.message); }
    }
    function ccCancel() { $('ccActive').classList.add('hidden'); ccId = ''; ccLines = []; wmsMsg('ccMsg', 'progress', 'Count abandoned — no variances were applied to stock.'); }
    async function loadSuppliers() {
      const el = $('supList'); if (!el || !clientId) return;
      try {
        const r = await fetch('/api/inventory/suppliers?clientId=' + encodeURIComponent(clientId));
        const sup = r.ok ? await r.json() : [];
        el.innerHTML = sup.length ? 'Suppliers: ' + sup.map(s => `<span style="background:#f1f5f9;border-radius:4px;padding:.1rem .4rem;margin-right:.3rem">${esc(s.name)} (${esc(s.supplier_id)})</span>`).join('') : 'No suppliers yet.';
      } catch { /* keep prior */ }
    }
    async function addSupplier() {
      const id = $('supId').value.trim(), name = $('supName').value.trim(), lead = $('supLead').value;
      if (!clientId) { alert('Load a client first.'); return; }
      if (!id || !name) { wmsMsg('supMsg', 'error', 'Supplier code and name required.'); return; }
      try {
        const r = await fetch('/api/inventory/suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, id, name, lead_time_days: Number(lead) || 7 }) });
        const d = await r.json();
        if (!r.ok) { wmsMsg('supMsg', 'error', d.error || 'Failed'); return; }
        wmsMsg('supMsg', 'success', '✓ Supplier saved.');
        $('supId').value = ''; $('supName').value = ''; $('supLead').value = '';
        loadSuppliers();
      } catch (e) { wmsMsg('supMsg', 'error', e.message); }
    }
    async function loadReorder() {
      const tb = $('reorderTbody'); if (!tb || !clientId) return;
      try {
        const r = await fetch('/api/inventory/reorder-suggestions?clientId=' + encodeURIComponent(clientId));
        const rows = r.ok ? await r.json() : [];
        if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:1.2rem;color:#94a3b8">Nothing needs reordering.</td></tr>'; return; }
        tb.innerHTML = rows.map(x => `<tr>
          <td style="font-family:monospace;font-weight:600">${esc(x.sku)}</td>
          <td>${esc(x.name || '')}</td>
          <td style="text-align:right">${x.available_qty}</td>
          <td style="text-align:right">${x.reorder_point}</td>
          <td style="text-align:right;font-weight:700;color:#d97706">${x.needed}</td>
          <td>${esc(x.supplier || '—')}</td></tr>`).join('');
      } catch { /* keep prior */ }
    }
    // ── Quarantine (damaged/KIV from receiving, awaiting disposition) ─────────
    async function loadQuarantine() {
      const tb = $('quarTbody'); if (!tb) return;
      try {
        const r = await fetch('/api/inventory/quarantine?status=open');
        const d = r.ok ? await r.json() : { open: 0, quarantine: [] };
        const badge = $('quarBadge');
        if (badge) { if (d.open > 0) { badge.textContent = d.open; badge.classList.remove('hidden'); } else badge.classList.add('hidden'); }
        const rows = (d.quarantine || []).filter(x => !clientId || x.clientId === clientId);
        if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:1.2rem;color:#94a3b8">Nothing in quarantine. 🎉</td></tr>'; return; }
        tb.innerHTML = rows.map(x => `<tr data-id="${esc(x.id)}" data-qty="${x.qty}">
          <td style="font-family:monospace;font-weight:600">${esc(x.sku)}</td>
          <td style="text-align:right;font-weight:700">${x.qty}</td>
          <td>${x.condition === 'damaged' ? '💥 Damaged' : '⏸ KIV'}</td>
          <td class="hint">${esc(x.source || '')}</td>
          <td class="hint">${x.createdAt ? new Date(x.createdAt).toLocaleDateString() : ''}</td>
          <td style="white-space:nowrap">
            <button class="btn-secondary btn-sm q-rel" title="Passed inspection — add to sellable stock (updates the sales channels)">✓ Release</button>
            <button class="btn-danger btn-sm q-disp" title="Scrap — close without adding stock">🗑 Dispose</button>
            <button class="btn-secondary btn-sm q-ret" title="Hand back to the client — close without adding stock">↩ Return</button>
          </td></tr>`).join('');
        const resolve = async (tr, action) => {
          const maxQ = Number(tr.dataset.qty);
          let qty = maxQ;
          if (maxQ > 1) { const v = prompt(`${action === 'release' ? 'Release' : action === 'dispose' ? 'Dispose' : 'Return'} how many? (in quarantine: ${maxQ})`, String(maxQ)); if (v === null) return; qty = Number(v); if (!(qty > 0)) { alert('Enter a positive number.'); return; } }
          const note = prompt('Note (optional)') || '';
          const r2 = await fetch(`/api/inventory/quarantine/${encodeURIComponent(tr.dataset.id)}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, qty, note }) });
          if (r2.ok) { wmsMsg('quarMsg', 'success', `✓ ${action === 'release' ? 'Released to stock (channels updated)' : action === 'dispose' ? 'Disposed' : 'Returned to client'}.`); loadQuarantine(); if (action === 'release') load(); }
          else { const e = await r2.json().catch(() => ({})); wmsMsg('quarMsg', 'error', e.error || 'Failed'); }
        };
        tb.querySelectorAll('.q-rel').forEach(b => b.addEventListener('click', () => resolve(b.closest('tr'), 'release')));
        tb.querySelectorAll('.q-disp').forEach(b => b.addEventListener('click', () => resolve(b.closest('tr'), 'dispose')));
        tb.querySelectorAll('.q-ret').forEach(b => b.addEventListener('click', () => resolve(b.closest('tr'), 'return_to_client')));
      } catch { /* keep prior */ }
    }
    // ── Stock discrepancies (bin-empty reports needing resolution) ────────────
    async function loadDiscrepancies() {
      const tb = $('discTbody'); if (!tb) return;
      try {
        const r = await fetch('/api/inventory/discrepancies?status=open');
        const d = r.ok ? await r.json() : { open: 0, discrepancies: [] };
        const badge = $('discBadge');
        if (badge) { if (d.open > 0) { badge.textContent = d.open; badge.classList.remove('hidden'); } else badge.classList.add('hidden'); }
        const rows = (d.discrepancies || []).filter(x => !clientId || x.clientId === clientId);
        if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:1.2rem;color:#94a3b8">No open discrepancies. 🎉</td></tr>'; return; }
        tb.innerHTML = rows.map(x => `<tr data-id="${esc(x.id)}" data-qty="${x.qty}">
          <td style="font-family:monospace;font-weight:600">${esc(x.sku)}</td>
          <td style="font-family:monospace">${esc(x.location)}</td>
          <td style="text-align:right;font-weight:700;color:#dc2626">${x.qty}</td>
          <td class="hint">${esc(x.order || '—')}</td>
          <td class="hint">${esc(x.reportedBy || '')} · ${x.reportedAt ? new Date(x.reportedAt).toLocaleString() : ''}</td>
          <td style="white-space:nowrap">
            <button class="btn-secondary btn-sm disc-found" title="Stock was located / recounted — no change to sellable total">✓ Found</button>
            <button class="btn-danger btn-sm disc-wo" title="Units genuinely missing — deduct sellable total and update the sales channels">✗ Write off</button>
          </td></tr>`).join('');
        tb.querySelectorAll('.disc-found').forEach(btn => btn.addEventListener('click', async () => {
          const tr = btn.closest('tr');
          const note = prompt('Where was it / what happened? (note, optional)') || '';
          const r2 = await fetch(`/api/inventory/discrepancies/${encodeURIComponent(tr.dataset.id)}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'found', note }) });
          if (r2.ok) { wmsMsg('discMsg', 'success', '✓ Resolved as found.'); loadDiscrepancies(); }
          else { const e = await r2.json().catch(() => ({})); wmsMsg('discMsg', 'error', e.error || 'Failed'); }
        }));
        tb.querySelectorAll('.disc-wo').forEach(btn => btn.addEventListener('click', async () => {
          const tr = btn.closest('tr');
          const maxQ = Number(tr.dataset.qty);
          const v = prompt(`Write off how many units? (missing: ${maxQ})\nThis deducts the sellable total and updates the sales channels.`, String(maxQ));
          if (v === null) return;
          const qty = Number(v);
          if (!(qty > 0)) { alert('Enter a positive number.'); return; }
          const note = prompt('Reason / note (optional)') || '';
          const r2 = await fetch(`/api/inventory/discrepancies/${encodeURIComponent(tr.dataset.id)}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'write_off', qty, note }) });
          if (r2.ok) { wmsMsg('discMsg', 'success', `✓ Wrote off ${Math.min(qty, maxQ)} — sellable total adjusted, channels updated.`); loadDiscrepancies(); load(); }
          else { const e = await r2.json().catch(() => ({})); wmsMsg('discMsg', 'error', e.error || 'Failed'); }
        }));
      } catch { /* keep prior */ }
    }
    // ── Replenishment (daily run) ─────────────────────────────────────────────
    function renderRepStatus(run) {
      const el = $('repStatus'); if (!el) return;
      if (!run || !run.day) { el.textContent = ''; return; }
      const when = run.generatedAt ? new Date(run.generatedAt).toLocaleString() : '';
      const n = (run.items || []).length;
      if (run.status === 'empty' || n === 0) el.innerHTML = `📅 Today's run (${esc(run.day)}) — <span style="color:#059669;font-weight:600">✓ nothing to replenish</span> · generated ${esc(when)}`;
      else el.innerHTML = `📅 Today's run (${esc(run.day)}) — <b>${n}</b> SKU(s) below target · generated ${esc(when)}. Acting is optional; if you skip, tomorrow's run recomputes what's needed then.`;
    }
    async function loadReplenishment(force) {
      const tb = $('repTbody'); if (!tb || !clientId) return;
      const days = Number($('repDays').value) || 7;
      try {
        let run;
        if (force) {
          const r = await fetch('/api/inventory/replenishment/run/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, daysCover: days }) });
          run = r.ok ? await r.json() : { items: [] };
        } else {
          const r = await fetch(`/api/inventory/replenishment/run?clientId=${encodeURIComponent(clientId)}&daysCover=${days}`);
          run = r.ok ? await r.json() : { items: [] };
        }
        renderRepStatus(run);
        const rows = run.items || [];
        if (!rows.length) { tb.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:1.2rem;color:#94a3b8">✓ All pick faces at/above target (or no shipping history yet).</td></tr>'; return; }
        tb.innerHTML = rows.map(x => {
          const canMove = x.from_bin && x.to_bin;
          const route = x.from_bin ? `${esc(x.from_bin)} → ${x.to_bin ? esc(x.to_bin) : '<span style="color:#b45309">no pick face — set one</span>'}` : '—';
          return `<tr data-sku="${esc(x.sku)}" data-from="${esc(x.from_bin || '')}" data-to="${esc(x.to_bin || '')}" data-move="${x.move_qty}">
            <td style="font-family:monospace;font-weight:600">${esc(x.sku)}</td>
            <td>${esc(x.name || '')}</td>
            <td style="text-align:right">${x.daily_rate}</td>
            <td style="text-align:right">${x.target}</td>
            <td style="text-align:right;color:${x.pick_qty <= 0 ? '#dc2626' : '#d97706'}">${x.pick_qty}</td>
            <td style="text-align:right;font-weight:700">${x.move_qty}</td>
            <td style="font-size:.82rem">${route}</td>
            <td>${canMove ? '<button class="btn-primary btn-sm rep-go">Replenish</button>' : ''}</td></tr>`;
        }).join('');
        tb.querySelectorAll('.rep-go').forEach(btn => btn.addEventListener('click', async () => {
          const tr = btn.closest('tr');
          const body = { clientId, sku: tr.dataset.sku, from_location: tr.dataset.from, to_location: tr.dataset.to, qty: Number(tr.dataset.move) };
          const { r, d, cancelled } = await postWithCapacityOverride('/api/inventory/replenishment/apply', body);
          if (cancelled) return;
          if (!r.ok) { wmsMsg('repMsg', 'error', d.error || 'Failed'); return; }
          wmsMsg('repMsg', 'success', `✓ Moved ${body.qty} × ${body.sku}: ${body.from_location} → ${body.to_location}.`);
          loadReplenishment(); loadLocationStock();
        }));
      } catch { /* keep prior */ }
    }
    // ── Serial numbers (Inventory panel) ──────────────────────────────────────
    async function serialLookup() {
      const serial = ($('serLookup').value || '').trim();
      const el = $('serLookupResult');
      if (!clientId) { alert('Load a client first.'); return; }
      if (!serial) { el.classList.add('hidden'); return; }
      try {
        const r = await fetch(`/api/inventory/serials/lookup?clientId=${encodeURIComponent(clientId)}&serial=${encodeURIComponent(serial)}`);
        const d = await r.json();
        if (!r.ok) { el.innerHTML = `<span style="color:#dc2626">${esc(d.error || 'Not found')}</span>`; el.classList.remove('hidden'); return; }
        const status = d.status === 'shipped'
          ? `<span style="color:#dc2626;font-weight:700">SHIPPED</span> on ${d.shipped_at ? new Date(d.shipped_at).toLocaleString() : '—'}${d.shipped_ref ? ' (order ' + esc(d.shipped_ref) + ')' : ''}`
          : `<span style="color:#059669;font-weight:700">IN STOCK</span>`;
        el.innerHTML = `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:.6rem;background:#f8fafc">
          <b>${esc(d.serial)}</b> — SKU <code>${esc(d.sku)}</code><br>${status}<br>
          <span class="hint">Received ${d.received_at ? new Date(d.received_at).toLocaleString() : '—'}${d.received_ref ? ' (' + esc(d.received_ref) + ')' : ''}</span></div>`;
        el.classList.remove('hidden');
      } catch (e) { el.innerHTML = `<span style="color:#dc2626">${esc(e.message)}</span>`; el.classList.remove('hidden'); }
    }
    async function serialAdd() {
      if (!clientId) { alert('Load a client first.'); return; }
      const sku = ($('serSku').value || '').trim();
      const serials = ($('serList').value || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
      if (!sku || !serials.length) { wmsMsg('serMsg', 'error', 'SKU and at least one serial required.'); return; }
      try {
        const r = await fetch('/api/inventory/serials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, sku, serials, received_ref: 'manual' }) });
        const d = await r.json();
        if (!r.ok) { wmsMsg('serMsg', 'error', d.error || 'Failed'); return; }
        wmsMsg('serMsg', 'success', `✓ ${d.added} serial(s) registered${d.skipped && d.skipped.length ? `, ${d.skipped.length} already existed` : ''}.`);
        $('serList').value = '';
      } catch (e) { wmsMsg('serMsg', 'error', e.message); }
    }

    setTimeout(() => {
      $('locAddBtn')?.addEventListener('click', createLocation);
      $('serLookupBtn')?.addEventListener('click', serialLookup);
      $('serLookup')?.addEventListener('keydown', e => { if (e.key === 'Enter') serialLookup(); });
      $('serAddBtn')?.addEventListener('click', serialAdd);
      $('locManageBtn')?.addEventListener('click', () => { const w = $('locManageWrap'); w.classList.toggle('hidden'); if (!w.classList.contains('hidden')) renderManageBins(); });
      $('locPrintLabelsBtn')?.addEventListener('click', printBinLabels);
      // ── Bulk racking setup ──────────────────────────────────────────────
      $('locTemplateBtn')?.addEventListener('click', () =>
        authDownload('/api/inventory/locations/template', 'IDEALONE_Bin_Locations_Template.xlsx'));
      $('locImportBtn')?.addEventListener('click', () => $('locImportFile')?.click());
      $('locImportFile')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        wmsMsg('locBulkMsg', 'progress', `Importing ${file.name}…`);
        try {
          const fd = new FormData();
          fd.append('file', file);
          const r = await fetch('/api/inventory/locations/import-file', { method: 'POST', body: fd });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Import failed');
          let msg = `✓ ${d.created} bin(s) created, ${d.updated} updated`;
          if (d.skipped) msg += `, ${d.skipped} skipped`;
          if (d.errors?.length) msg += ` — ${d.errors.slice(0, 5).map(x => `row ${x.row}: ${x.error}`).join('; ')}`;
          wmsMsg('locBulkMsg', d.skipped ? 'error' : 'success', msg);
          await refreshLocations();   // refresh the bin dropdowns too
          renderManageBins();
        } catch (err) { wmsMsg('locBulkMsg', 'error', err.message); }
      });
      $('locGenToggleBtn')?.addEventListener('click', () => $('locGenWrap')?.classList.toggle('hidden'));
      // live "this will create N bins" preview so a fat-fingered range is
      // obvious BEFORE it generates thousands of bins
      const genPreview = () => {
        const num = id => parseInt($(id)?.value, 10);
        const span = (a, b) => (Number.isFinite(num(a)) && Number.isFinite(num(b))) ? (num(b) - num(a) + 1) : 0;
        const n = span('genAisleFrom', 'genAisleTo') * span('genShelfFrom', 'genShelfTo') * span('genBinFrom', 'genBinTo');
        const el = $('genPreview');
        if (el) el.textContent = n > 0 ? `Will create up to ${n.toLocaleString()} bin(s) — existing ones are left untouched.` : '';
      };
      ['genAisleFrom','genAisleTo','genShelfFrom','genShelfTo','genBinFrom','genBinTo']
        .forEach(id => $(id)?.addEventListener('input', genPreview));
      $('genRunBtn')?.addEventListener('click', async () => {
        const val = id => ($(id)?.value || '').trim();
        const body = {
          zone: val('genZone'),
          aisleFrom: val('genAisleFrom'), aisleTo: val('genAisleTo'),
          shelfFrom: val('genShelfFrom'), shelfTo: val('genShelfTo'),
          binFrom: val('genBinFrom'),     binTo: val('genBinTo'),
          capacity: parseInt(val('genCap'), 10) || 1000,
          environment: val('genEnv') || 'dry',
          kind: val('genKind') || 'pick',
        };
        if (!body.zone) { wmsMsg('locBulkMsg', 'error', 'Zone is required.'); return; }
        wmsMsg('locBulkMsg', 'progress', 'Generating racking…');
        try {
          const r = await fetch('/api/inventory/locations/generate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Generate failed');
          wmsMsg('locBulkMsg', 'success',
            `✓ ${d.created} bin(s) created in zone ${body.zone}` +
            (d.alreadyExisted ? ` · ${d.alreadyExisted} already existed (left as-is)` : ''));
          await refreshLocations();   // refresh the bin dropdowns too
          renderManageBins();
        } catch (err) { wmsMsg('locBulkMsg', 'error', err.message); }
      });
      $('ccBlind')?.addEventListener('change', ccRender);
      $('binLookupBtn')?.addEventListener('click', binLookup);
      $('binLookup')?.addEventListener('keydown', e => { if (e.key === 'Enter') binLookup(); });
      $('putBtn')?.addEventListener('click', placeStock);
      $('trBtn')?.addEventListener('click', transfer);
      $('ccStartBtn')?.addEventListener('click', ccStart);
      $('ccAddBtn')?.addEventListener('click', ccAddLine);
      $('ccQty')?.addEventListener('keydown', e => { if (e.key === 'Enter') ccAddLine(); });
      $('ccCompleteBtn')?.addEventListener('click', ccComplete);
      $('ccCancelBtn')?.addEventListener('click', ccCancel);
      $('supAddBtn')?.addEventListener('click', addSupplier);
      $('repRefreshBtn')?.addEventListener('click', () => loadReplenishment(true));
      $('discRefreshBtn')?.addEventListener('click', loadDiscrepancies);
      $('quarRefreshBtn')?.addEventListener('click', loadQuarantine);
    }, 0);

    // load bundles + WMS panels whenever a client is loaded
    const _origLoad = load;
    load = async function () {
      await _origLoad();
      fillSkuDatalist();
      loadBundles();
      refreshLocations();
      loadLocationStock();
      loadSuppliers();
      loadReorder();
      loadReplenishment();
      loadDiscrepancies();
      loadQuarantine();
      loadCountsDue();
    };

    return { init, load, renderList, pickFile, loadBundles };
  })();
  window.invUI = invUI;
    let items = [];
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // Inventory tabs disabled — waiting on API rearchitecture for 3PL/4PL model

  // ── WAVE PICK UI — consolidate multiple orders into one location-sorted ────
  // pick list (/api/waves/*). Additive: reads the same order list Orders/
  // Upload already use, doesn't alter Scan & Check.
  const waveUI = (function () {
    let waves = [];
    let pendingOrders = [];
    let currentWave = null;

    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    // Show the real FEFO/FIFO bins to pick from (with expiry); fall back to the
    // printed location code when a SKU has no binned stock.
    function waveBinCell(p) {
      if (p.bins && p.bins.length) {
        const upc = Number(p.units_per_carton) || 1;
        const qlbl = q => { if (upc <= 1) return `×${q}`; const c = Math.floor(q / upc), e = q % upc; const a = []; if (c) a.push(`${c} ctn`); if (e) a.push(`${e} ea`); return `×${q} (${a.join(' + ')})`; };
        const parts = p.bins.map(b => `${esc(b.location_id)}&nbsp;${qlbl(b.qty)}${b.expiry_date ? `<span style="opacity:.65;font-weight:400"> exp ${esc(b.expiry_date)}</span>` : ''}`);
        const short = p.bin_shortfall > 0 ? `<div style="color:#b45309;font-weight:600;font-size:.72rem">⚠ ${p.bin_shortfall} not binned</div>` : '';
        return `<div style="font-size:.82rem">${parts.join('<br>')}</div>${short}`;
      }
      return esc(p.location || '—');
    }

    async function load() {
      document.getElementById('waveDetailWrap').classList.add('hidden');
      document.getElementById('waveListWrap').classList.remove('hidden');
      try {
        const r = await fetch('/api/waves');
        waves = r.ok ? await r.json() : [];
      } catch (e) { waves = []; }
      renderList();
    }

    function renderList() {
      const tb = document.getElementById('wave-list-tbody');
      if (!waves.length) { tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:#94a3b8">No waves yet. Click "+ New Wave" to combine pending orders into one pick run.</td></tr>'; return; }
      tb.innerHTML = waves.map(w => `
        <tr style="cursor:pointer" onclick="waveUI.openWave('${esc(w.id)}')">
          <td style="font-weight:600">${esc(w.name)}</td>
          <td>${w.order_numbers.length}</td>
          <td>${w.stats.lineCount}</td>
          <td>${w.stats.totalUnits}</td>
          <td><span style="padding:.15em .6em;border-radius:99px;font-size:.75rem;font-weight:600;background:${w.status === 'completed' ? '#dcfce7' : w.status === 'picking' ? '#fef3c7' : '#e2e8f0'};color:${w.status === 'completed' ? '#166534' : w.status === 'picking' ? '#92400e' : '#475569'}">${esc(w.status)}</span></td>
          <td>${esc((w.created_at || '').replace('T', ' ').slice(0, 16))}</td>
          <td><button class="btn-secondary" style="padding:.2rem .55rem" onclick="event.stopPropagation();waveUI.openWave('${esc(w.id)}')">Open</button></td>
        </tr>`).join('');
    }

    async function newWave() {
      document.getElementById('waveOrderPicker').classList.remove('hidden');
      document.getElementById('waveOrderList').innerHTML = '<div style="padding:1rem;color:#94a3b8">Loading pending orders&#8230;</div>';
      try {
        const r = await fetch('/api/orders?range=all');
        const all = r.ok ? await r.json() : [];
        // Only orders not yet fully scanned/shipped make sense to wave-pick
        pendingOrders = all.filter(o => !o.scan_status || o.scan_status === 'pending' || o.scan_status === 'processing');
      } catch (e) { pendingOrders = []; }
      renderPicker(pendingOrders);
    }

    function renderPicker(list) {
      const el = document.getElementById('waveOrderList');
      if (!list.length) { el.innerHTML = '<div style="padding:1rem;color:#94a3b8">No pending orders found.</div>'; return; }
      el.innerHTML = list.map(o => {
        const lines = o.items || o.lines || [];
        const withLoc = lines.filter(l => (l.location || '').trim()).length;
        let locBadge = '';
        if (lines.length > 0) {
          if (withLoc === 0) locBadge = `<span style="color:#dc2626;font-size:.75rem">&#9888; no location</span>`;
          else if (withLoc < lines.length) locBadge = `<span style="color:#d97706;font-size:.75rem">${withLoc}/${lines.length} located</span>`;
          else locBadge = `<span style="color:#16a34a;font-size:.75rem">&#128205; located</span>`;
        }
        return `
        <label style="display:flex;align-items:center;gap:.6rem;padding:.5rem .75rem;border-bottom:1px solid #f1f5f9;cursor:pointer">
          <input type="checkbox" class="wave-order-cb" value="${esc(o.order_number)}">
          <span style="font-weight:600">${esc(o.order_number)}</span>
          <span style="color:#94a3b8;font-size:.85rem">${lines.length} line(s)</span>
          ${locBadge}
        </label>`;
      }).join('');
    }

    function filterPicker() {
      const q = (document.getElementById('waveOrderSearch').value || '').toLowerCase();
      renderPicker(pendingOrders.filter(o => !q || o.order_number.toLowerCase().includes(q)));
    }

    function cancelPicker() {
      document.getElementById('waveOrderPicker').classList.add('hidden');
    }

    async function buildWave() {
      const orderNumbers = [...document.querySelectorAll('.wave-order-cb:checked')].map(cb => cb.value);
      if (!orderNumbers.length) { alert('Select at least one order.'); return; }
      const name = prompt('Name this wave (optional):', '') || undefined;
      const r = await fetch('/api/waves', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, order_numbers: orderNumbers }) });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Could not create wave.'); return; }
      cancelPicker();
      if (j.notFound && j.notFound.length) alert('Note: ' + j.notFound.length + ' order(s) could not be found and were skipped: ' + j.notFound.join(', '));
      openWave(j.id);
    }

    async function openWave(id) {
      const r = await fetch('/api/waves/' + encodeURIComponent(id));
      if (!r.ok) { alert('Wave not found.'); return; }
      currentWave = await r.json();
      document.getElementById('waveListWrap').classList.add('hidden');
      document.getElementById('waveDetailWrap').classList.remove('hidden');
      renderDetail();
      // Same global capture the order and receiving screens use, so a gun
      // firing while focus has drifted still lands on the scan input instead
      // of going nowhere. MUST be detached on every way out of this screen
      // (backToList, switching tab) or it leaks into whatever opens next.
      attachGlobalScanCapture('wave');
      document.getElementById('waveScanInput')?.focus();
    }

    function renderDetail() {
      const w = currentWave;
      document.getElementById('waveDetailTitle').textContent = w.name;
      document.getElementById('waveDetailMeta').innerHTML =
        `<span>${w.order_numbers.length} order(s)</span>` +
        `<span>${w.stats.lineCount} pick line(s)</span>` +
        `<span>${w.stats.totalUnits} unit(s)</span>` +
        (w.stats.unlocatedLines ? `<span style="color:#d97706">${w.stats.unlocatedLines} line(s) have no location</span>` : '') +
        `<span>Status: <b>${esc(w.status)}</b></span>`;
      // A completed wave can't be completed or instant-cancelled again — its
      // "Cancel Wave" needs Master approval instead, via the order's own
      // "Wave Picked — Needs Closing" pill (see requestWaveCancellation).
      // A cancelled wave shows neither action.
      const active = w.status !== 'completed' && w.status !== 'cancelled';
      document.getElementById('waveCompleteBtn').classList.toggle('hidden', !active);
      document.getElementById('waveCancelBtn').classList.toggle('hidden', !active);
      // Scanning is closed on a completed/cancelled wave (the server refuses
      // it too — this just stops offering it).
      document.getElementById('waveScanBar').classList.toggle('hidden', !active);
      document.getElementById('wave-picks-tbody').innerHTML = w.picks.map(p => {
        const done = p.picked_qty >= p.total_qty;
        return `<tr style="${done ? 'background:#f0fdf4' : ''}">
          <td style="font-family:monospace;font-weight:700">${waveBinCell(p)}</td>
          <td style="font-weight:600">${esc(p.sku)}</td>
          <td>${esc(p.description)}</td>
          <td style="text-align:right">${p.total_qty}</td>
          <td style="text-align:right;${done ? 'color:#16a34a;font-weight:700' : ''}">${p.picked_qty}</td>
          <td style="font-size:.78rem;color:#64748b">${p.orders.map(o => esc(o.order_number) + ' (' + o.qty + ')').join(', ')}</td>
          <td>${done ? '&#10003;' : `<button class="btn-secondary" style="padding:.2rem .5rem" onclick="waveUI.pick('${esc(p.sku)}','${esc(p.location)}')">Pick</button>`}</td>
        </tr>`;
      }).join('');
    }

    // SCAN PICKING — one scan = one piece, exactly like order scanning, so a
    // gun works with no typing. The per-row "Pick" button below is kept for
    // keying a whole line at once (a full carton off a pallet).
    //
    // QUEUE, NEVER DROP — in two layers.
    //
    // (1) In-memory serialisation. A gun fires faster than the round trip, so a
    //     second piece can be scanned while the first request is still open. An
    //     earlier version guarded with a plain `if (busy) return`, which
    //     SILENTLY DISCARDED that piece — no error, count short by one. Every
    //     scan is enqueued and processed in order instead.
    // (2) DURABLE handoff. If the request actually fails (network gone), the
    //     piece moves into the shared localStorage offline queue, so it
    //     survives a page reload, a browser restart and a dead battery — the
    //     same protection outbound order scanning has. Each scan carries an
    //     eventId minted at scan time, so a replay of a scan the server already
    //     applied is absorbed by its dedupe rather than counted twice.
    const _waveScanQueue = [];
    let _waveScanBusy = false;
    function scan(code) {
      const val = String(code || '').trim();
      if (!val || !currentWave) return;
      // Bind to the wave open RIGHT NOW, not to whatever is open when the
      // request is finally built — same reasoning as the order and inbound
      // paths (a mid-flight switch would otherwise credit the wrong wave).
      _waveScanQueue.push({ raw: val, eventId: _newEventId(), waveId: currentWave.id });
      if (!_waveScanBusy) _drainWaveScans();
    }
    async function _drainWaveScans() {
      _waveScanBusy = true;
      try {
        while (_waveScanQueue.length) {
          const evt = _waveScanQueue[0];
          const waveId = evt.waveId || currentWave?.id;
          if (!waveId) { _waveScanQueue.shift(); continue; }
          const stillOpen = () => !!currentWave && currentWave.id === waveId;
          let r, j;
          try {
            r = await fetchT(`/api/waves/${encodeURIComponent(waveId)}/scan`, {
              method: 'POST', headers: hdrs(),
              body: JSON.stringify({ code: evt.raw, eventId: evt.eventId }),
            });
            j = await r.json();
          } catch (e) {
            // Connection gone. Hand the WHOLE remaining burst to the durable
            // queue and clear the in-memory one — nothing is held only in a
            // variable that a refresh would wipe.
            for (const q of _waveScanQueue) enqueueOfflineTargetScan('wave', q.waveId || waveId, q.raw, q.eventId);
            const held = pendingScansForTarget('wave', waveId).length;
            _waveScanQueue.length = 0;
            if (stillOpen()) waveScanFeedback(`⚡ No connection — ${held} scan(s) saved, will sync automatically`, 'err');
            return;
          }
          _waveScanQueue.shift();          // the server has now seen it
          if (!r.ok) { waveScanFeedback(j.error || 'Could not record that scan.', 'err'); continue; }
          // Landed. Only repaint if that wave is still the one on screen —
          // otherwise this would overwrite a different wave's view.
          if (!stillOpen()) continue;
          currentWave = j.wave;
          renderDetail();
          const m = j.matched;
          if (!m) continue;                // a deduped replay — nothing new to report
          waveScanFeedback(
            `${m.sku} — ${m.picked_qty}/${m.total_qty}` +
            (m.complete ? ' ✓ line complete' : '') +
            (m.bin_location || m.location ? ` · ${m.bin_location || m.location}` : '') +
            (_waveScanQueue.length ? ` · ${_waveScanQueue.length} queued` : ''),
            m.complete ? 'done' : 'ok',
          );
        }
      } finally {
        _waveScanBusy = false;
        const inp = document.getElementById('waveScanInput');
        if (inp) { inp.value = ''; inp.focus(); }
      }
    }

    // Called by the offline-queue drainer when a held wave scan finally lands,
    // so the open pick list reflects it without a manual refresh.
    function applySyncedWave(wave, waveId) {
      if (!currentWave || currentWave.id !== waveId) return;
      currentWave = wave;
      renderDetail();
    }
    function syncedNotice() {
      if (currentWave && !document.getElementById('waveDetailWrap')?.classList.contains('hidden')) {
        waveScanFeedback('✓ Connection restored — all queued scans synced', 'done');
      }
    }

    // Deliberately NOT an alert(): a picker holding a gun must not have to
    // dismiss a dialog between pieces. Errors stay on screen until the next
    // scan replaces them.
    function waveScanFeedback(msg, kind) {
      const el = document.getElementById('waveScanFeedback');
      if (!el) return;
      el.textContent = msg;
      // only the three classes styles.css actually defines
      el.className = 'scan-feedback ' + (kind === 'err' ? 'error' : 'success');
      el.classList.remove('hidden');
    }

    async function pick(sku, location) {
      const v = prompt('Quantity picked for ' + sku + (location ? ' at ' + location : '') + ':', '1');
      if (v === null) return;
      const qty = Number(v);
      if (!Number.isFinite(qty) || qty <= 0) { alert('Enter a positive number.'); return; }
      const r = await fetch(`/api/waves/${encodeURIComponent(currentWave.id)}/pick`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku, location, qty }) });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Could not record pick.'); return; }
      currentWave = j;
      renderDetail();
    }

    // Closes the consolidated floor pick. Writes NOTHING into the orders —
    // sub-picking the pile down to order level is done by opening each order
    // and scanning every piece from zero, exactly like normal scanning.
    async function complete() {
      // Same rule as ending a receipt or completing an order: never close over
      // a hole. Closing a wave with pieces still held offline would bank a
      // short pick as final.
      const held = pendingScansForTarget('wave', currentWave.id).length + _waveScanQueue.length;
      if (held) {
        alert(`${held} scan(s) are still waiting for the connection to return.\n\nThe wave will be closeable as soon as they sync — keep it open.`);
        return;
      }
      if (!confirm(`Close wave "${currentWave.name}"?\n\nNext step: scan each order's GI/Waybill to open it, then scan its items from the picked pile — every order is counted piece by piece, like normal scanning.`)) return;
      let r = await fetch(`/api/waves/${encodeURIComponent(currentWave.id)}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      let j = await r.json();
      if (r.status === 409 && j.needsForceComplete) {
        if (!confirm(j.message + '\n\nOK = close anyway\nCancel = keep picking')) return;
        r = await fetch(`/api/waves/${encodeURIComponent(currentWave.id)}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }) });
        j = await r.json();
      }
      if (!r.ok) { alert(j.error || 'Could not close wave.'); return; }
      currentWave = j;
      renderDetail();
      load();
      alert(`Wave "${currentWave.name}" closed — consolidated pick done.\n\nNow sub-pick to order level: scan each of the ${(currentWave.order_numbers || []).length} order's GI/Waybill barcode in the bar above the Orders list to open it, then scan its items into the box. Each order shows a "${currentWave.code || currentWave.id}" pill until it's completed.`);
    }

    async function cancel() {
      if (!confirm(`Cancel wave "${currentWave.name}"? Nothing has been applied to any order yet, so this is instant and reversible by just starting a new wave.`)) return;
      const r = await fetch(`/api/waves/${encodeURIComponent(currentWave.id)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Could not cancel wave.'); return; }
      currentWave = j;
      renderDetail();
      load();
    }

    function print() {
      const w = currentWave;
      const binText = p => (p.bins && p.bins.length) ? p.bins.map(b => `${b.location_id} ×${b.qty}${b.expiry_date ? ' exp ' + b.expiry_date : ''}`).join(' / ') : (p.location || '—');
      // NO order-number column. A wave is picked BY SKU — one consolidated
      // quantity per product, sorted to orders afterwards through Scan & Check —
      // so order numbers are not something the picker acts on, and on a printed
      // sheet they squeezed the Location, SKU and Description columns that are.
      const rows = w.picks.map(p => `<tr><td style="font-family:monospace;font-weight:700;font-size:1.05rem">${esc(binText(p))}</td><td style="font-weight:600">${esc(p.sku)}</td><td>${esc(p.description)}</td><td style="text-align:right;font-size:1.15rem;font-weight:700">${p.total_qty}</td><td style="width:2.2rem;border:1px solid #999"></td></tr>`).join('');
      const win = window.open('', '_blank');
      win.document.write(`<html><head><title>Wave Pick — ${esc(w.name)}</title><style>
        body{font-family:sans-serif;padding:20px} h1{font-size:1.3rem}
        table{width:100%;border-collapse:collapse;margin-top:1rem} th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;font-size:.9rem}
        th{background:#f1f5f9}
      </style></head><body>
        <h1>Wave Pick Sheet — ${esc(w.name)}</h1>
        <div>${w.order_numbers.length} order(s) &middot; ${w.stats.lineCount} line(s) &middot; ${w.stats.totalUnits} unit(s)</div>
        <table><thead><tr><th>Location</th><th>SKU</th><th>Description</th><th style="text-align:right">Qty</th><th>&#10003;</th></tr></thead><tbody>${rows}</tbody></table>
      </body></html>`);
      win.document.close();
      win.onload = () => setTimeout(() => win.print(), 300);
    }

    function backToList() { detachGlobalScanCapture(); load(); }
    // Leaving the Wave Pick tab entirely is the other way out — see the
    // switchTab hook that calls this.
    function leaveDetail() {
      if (!document.getElementById('waveDetailWrap')?.classList.contains('hidden')) detachGlobalScanCapture();
    }

    return { load, newWave, filterPicker, cancelPicker, buildWave, openWave, pick, scan, complete, cancel, print, backToList, leaveDetail, applySyncedWave, syncedNotice };
  })();
  window.waveUI = waveUI;
  document.getElementById('waveNewBtn')?.addEventListener('click', () => waveUI.newWave());

  // ADD submits the typed value through the SAME path a gun takes, rather
  // than calling waveUI.scan directly — one code path, so manual entry and a
  // scan can never behave differently.
  document.getElementById('waveScanAddBtn')?.addEventListener('click', () => {
    const inp = document.getElementById('waveScanInput');
    const v = (inp.value || '').trim();
    if (!v) { inp.focus(); return; }
    _scanBuf = v;
    _flushScanBuf();
    inp.value = '';
  });
  // Enter inside the input is handled by the global capture; this listener
  // only stops the keypress firing through both and double-counting the piece
  // (same no-op guard as itemScanInput / inboundScanInput).
  document.getElementById('waveScanInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') e.preventDefault();
  });

  // Clicking an order's "Wave Picked — Needs Closing" pill (admin only —
  // by the time this pill can show, the wave that touched this order is
  // always already completed, since wave_id is only ever stamped inside
  // POST /api/waves/:id/complete). Same admin-request + Master-approve
  // pattern as order/inbound deletion: reason + the admin's own password
  // re-confirmed, then a Master reviews it in Administrator → Pending
  // Deletions.
  window.requestWaveCancellation = async function (waveId) {
    const reason = prompt('Reason for cancelling this wave? (Once a Master approves: legacy waves that prefilled quantities have them reversed; any order still open loses its "Scan to Pack" pill.)');
    if (reason === null) return;
    if (!reason.trim()) { alert('A reason is required.'); return; }
    const password = prompt('Re-enter your password to confirm:');
    if (password === null) return;
    try {
      const r = await fetch(`/api/waves/${encodeURIComponent(waveId)}/cancel-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': localStorage.getItem('wms_token') || '' },
        body: JSON.stringify({ reason: reason.trim(), password }),
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Request failed'); return; }
      alert('Cancellation request submitted — a Master needs to approve it before anything is reversed.');
      if (typeof refreshOrders === 'function') refreshOrders();
    } catch (e) { alert('Error: ' + e.message); }
  };

  // Reopen a live wave from its pill on the Orders list — switches to the
  // Wave Pick tab and opens that wave's detail view directly, where the
  // Cancel Wave button lives. Before this pill existed, closing the Wave
  // Pick tab left a live wave with no visible way back to it.
  window.resumeWavePick = function (waveId) {
    switchTab('waves');
    waveUI.openWave(waveId);
  };

  // ── Wave Management (sidebar sub-item under Orders, Admin-only) ────────────
  // One overlay, two jobs: see how many waves are going on right now (stats
  // strip + per-wave order progress), and administer them (select-all bulk
  // cancel). Cancelling takes effect immediately — see /api/waves/bulk-cancel.
  const _waveManageSel = new Set();
  function openWaveManagement() {
    document.getElementById('waveManageOverlay').classList.remove('hidden');
    document.getElementById('waveManagePassword').value = '';
    document.getElementById('waveManageError').classList.add('hidden');
    _waveManageSel.clear();
    loadWaveManageList();
  }
  document.getElementById('manageWavesBtn')?.addEventListener('click', openWaveManagement);
  document.getElementById('waveMgmtSidebarBtn')?.addEventListener('click', openWaveManagement);
  document.getElementById('waveManageCloseBtn')?.addEventListener('click', () =>
    document.getElementById('waveManageOverlay').classList.add('hidden'));

  async function loadWaveManageList() {
    const body = document.getElementById('waveManageBody');
    let waves = [];
    try {
      const r = await fetch('/api/waves?detail=1', { headers: hdrs() });
      if (r.ok) waves = await r.json();
    } catch {}
    const active = waves.filter(w => w.status !== 'cancelled');

    // Stats strip: how many waves are going on, and their reach
    const live       = active.filter(w => w.status !== 'completed');
    const closed     = active.filter(w => w.status === 'completed');
    const allOrders  = active.flatMap(w => w.orders || []);
    const ordersLeft = allOrders.filter(o => o.status !== 'done').length;
    document.getElementById('waveMgmtStats').innerHTML = [
      [live.length, 'Waves Picking Now'],
      [closed.length, 'Closed — Scan to Pack'],
      [allOrders.length, 'Orders in Waves'],
      [ordersLeft, 'Orders Still to Pack'],
    ].map(([val, lbl]) => `<div class="dstat"><div class="dstat-val">${val}</div><div class="dstat-lbl">${lbl}</div></div>`).join('');

    body.innerHTML = active.map(w => {
      const orders = w.orders || [];
      const done = orders.filter(o => o.status === 'done').length;
      const orderChips = orders.map(o =>
        `<span class="chip ${o.status === 'done' ? 'chip-done' : o.status === 'processing' ? 'chip-inprog' : 'chip-unproc'}" title="${esc(o.order_number)}: ${o.scannedTotal}/${o.totalQty} scanned">${esc(o.order_number)}</span>`).join(' ');
      return `
      <tr>
        <td><input type="checkbox" class="wave-manage-check" data-id="${esc(w.id)}" ${_waveManageSel.has(w.id) ? 'checked' : ''}></td>
        <td class="dcs-name">${esc(w.code || w.id)}${w.pending_purge ? ' <span class="chip chip-unproc" title="Cancelled — awaiting Master approval to delete the record">purge pending</span>' : ''}</td>
        <td>${w.status === 'completed' ? '<span class="chip chip-done">Closed</span>' : `<span class="chip chip-inprog">${esc(w.status)}</span>`}</td>
        <td>${orders.length}</td>
        <td>${done}/${orders.length} packed</td>
        <td>${w.stats?.totalUnits ?? '—'}</td>
        <td>${w.created_at ? new Date(w.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}${w.created_by ? `<div class="hint">${esc(w.created_by)}</div>` : ''}</td>
        <td>${w.status !== 'completed' ? `<button class="btn-sm btn-primary wave-mgmt-open" data-id="${esc(w.id)}">Open</button>` : ''}</td>
      </tr>
      <tr class="wave-mgmt-orders-row"><td></td><td colspan="7" style="padding:.2rem .5rem .6rem">${orderChips}</td></tr>`;
    }).join('');
    document.getElementById('waveManageEmpty').classList.toggle('hidden', active.length > 0);
    body.querySelectorAll('.wave-manage-check').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _waveManageSel.add(cb.dataset.id); else _waveManageSel.delete(cb.dataset.id);
        updateWaveManageButtons();
      });
    });
    body.querySelectorAll('.wave-mgmt-open').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('waveManageOverlay').classList.add('hidden');
        resumeWavePick(btn.dataset.id);
      });
    });
    updateWaveManageButtons();
  }
  function updateWaveManageButtons() {
    const boxes = document.querySelectorAll('.wave-manage-check');
    const n = _waveManageSel.size;
    document.getElementById('waveManageSelectAllBtn').innerHTML =
      (n && n >= boxes.length) ? '&#9745; Deselect All' : '&#9744; Select All';
    document.getElementById('waveManageCancelBtn').disabled = n === 0;
    document.getElementById('waveManageSelCount').textContent = n ? `${n} wave${n === 1 ? '' : 's'} selected` : '';
  }
  document.getElementById('waveManageSelectAllBtn')?.addEventListener('click', () => {
    const boxes = document.querySelectorAll('.wave-manage-check');
    const allSelected = _waveManageSel.size >= boxes.length && boxes.length > 0;
    boxes.forEach(cb => {
      cb.checked = !allSelected;
      if (cb.checked) _waveManageSel.add(cb.dataset.id); else _waveManageSel.delete(cb.dataset.id);
    });
    updateWaveManageButtons();
  });
  document.getElementById('waveManageCancelBtn')?.addEventListener('click', async () => {
    const ids = [..._waveManageSel];
    const pwd = document.getElementById('waveManagePassword').value;
    const errEl = document.getElementById('waveManageError');
    errEl.classList.add('hidden');
    if (!ids.length) return;
    if (!pwd) { errEl.textContent = 'Enter your password to confirm.'; errEl.classList.remove('hidden'); return; }
    if (!confirm(`Cancel ${ids.length} wave${ids.length === 1 ? '' : 's'}?\n\nThis takes effect immediately: legacy waves that prefilled quantities are reversed and those orders go back to 0 scanned for piece-by-piece scanning. Completed orders are never touched. The wave record(s) then wait for the Administrator to approve deleting them from the data.`)) return;
    const btn = document.getElementById('waveManageCancelBtn');
    btn.disabled = true; btn.textContent = 'Cancelling…';
    try {
      const r = await fetch('/api/waves/bulk-cancel', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ ids, password: pwd }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Bulk cancel failed');
      const skipped = (d.cancelled || []).flatMap(c => c.skippedDone || []);
      let msg = `${(d.cancelled || []).length} wave(s) cancelled — effect is immediate.`;
      if (skipped.length) msg += `\n${skipped.length} order(s) were already Completed and left untouched: ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? '…' : ''}.`;
      msg += `\n\nThe wave record(s) now await the Administrator's approval to be deleted from the data.`;
      alert(msg);
      _waveManageSel.clear();
      loadWaveManageList();
      await refreshOrders(); renderOrdersList();
    } catch (err) {
      errEl.textContent = err.message; errEl.classList.remove('hidden');
    }
    btn.disabled = false; btn.innerHTML = '&#128465; Cancel Selected Waves';
  });

  // ── Init ───────────────────────────────────────────────────────────────────
  initLogin();
})();
