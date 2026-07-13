(() => {
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
  let completedSearch     = '';
  let _archSearch         = { q: '', results: null }; // archive search cache
  let ordersDateFilter    = 'today';    // 'today' | 'yesterday' | 'week' | 'all' | 'range'
  let ordersDateFrom      = '';
  let ordersDateTo        = '';
  let printWaybillTimer   = null;
  let pendingOrderFile    = null;
  let pendingOcrRows      = null;   // parsed rows from photo OCR, bypasses file upload
  let uploadDirection     = 'Outbound';
  let logUnlocked         = false;
  let pendingDownload     = false;

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
      if (p.tablePrefs) tablePrefs = { widths: p.tablePrefs.widths || {}, hidden: p.tablePrefs.hidden || [] };
    } catch {}
    fetchNoBarcodeSkus();
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

    // Admin button — hidden for warehouse
    const logBtn = document.getElementById('logAccessBtn');
    if (logBtn) logBtn.classList.toggle('hidden', isWarehouse);

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
  const TAB_TITLES = { upload: 'Upload', orders: 'Orders', labels: 'Labels', reports: 'Reports', about: 'About' };
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => { switchTab(btn.dataset.tab); closeSidebar(); })
  );
  document.querySelectorAll('[data-tab-link]').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tabLink))
  );

  function switchTab(name) {
    // Warehouse users cannot access the upload tab
    if ((name === 'upload' || name === 'reports') && (currentUser?.role || 'admin') === 'warehouse') return;
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
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${name}`).classList.add('active');
    document.querySelector(`.tab-btn[data-tab="${name}"]`)?.classList.add('active');
    const ttEl = document.getElementById('ctTabTitle');
    if (ttEl) ttEl.textContent = TAB_TITLES[name] || name;
    if (name === 'upload') { fetchAndRenderStats(); renderBreakdowns(loadedOrders); }
    if (name === 'orders') { renderOrdersDash(); setTimeout(() => focusWaybillInput(), 300); }
    if (name === 'labels') { renderLabelsTab(); }
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
          <div class="dstat-val">${s.yesterdayDone}</div>
          <div class="dstat-lbl">Done Yesterday</div>
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
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) previewOrderFile(e.dataTransfer.files[0]);
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
      const resp = await fetch('/api/label-imports', { method: 'POST', body: fd });
      const data = await resp.json();
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
    });
  });


  document.getElementById('confirmApproveBtn').addEventListener('click', async () => {
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
          body: JSON.stringify({ rows: pendingOcrRows, client_name: clientName, direction: uploadDirection }),
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

    try {
      const _uploadAbort = new AbortController();
      const _uploadTimer = setTimeout(() => _uploadAbort.abort(), 90000);
      let resp;
      try {
        resp = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'x-session-id': SESSION_ID },
          body: form,
          signal: _uploadAbort.signal,
        });
      } finally {
        clearTimeout(_uploadTimer);
      }
      const data = await resp.json();
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

      setUploadStatus('success',
        `${data.idealscanCode ? `Job ${data.idealscanCode} — ` : ''}Converted ${data.rowCount} line(s) across ${data.orders.length} order(s) from "${file.name}".`
      );

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
  function renderSidebarClients(orders) {
    const clients = [...new Set(orders.map(o => o.client_name || '').filter(Boolean))];
    const lbl     = document.getElementById('sidebarClientsLabel');
    const list    = document.getElementById('sidebarClientList');
    if (!list) return;
    if (!clients.length) { if (lbl) lbl.style.display = 'none'; list.innerHTML = ''; return; }
    if (lbl) lbl.style.display = '';
    const counts = {};
    orders.forEach(o => { const c = o.client_name || ''; if (c) counts[c] = (counts[c] || 0) + 1; });
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
    // Also matches the pick-ticket number — PDF picking lists carry two
    // barcodes (GI number + pick ticket) and either should open the order.
    const valLower = val.toLowerCase();
    const strip0 = s => s.replace(/^0+(?=.)/, '');
    const directMatch = loadedOrders.find(o => {
      const on = o.order_number.trim().toLowerCase();
      const pt = (o.pick_ticket || '').trim().toLowerCase();
      return on === valLower || strip0(on) === strip0(valLower) ||
             (pt && (pt === valLower || strip0(pt) === strip0(valLower)));
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
    if (activeClientFilter  !== 'all') orders = orders.filter(o => (o.client_name || '') === activeClientFilter);
    if (activeCarrierFilter !== 'all') orders = orders.filter(o => (o.carrier || '') === activeCarrierFilter);

    // Date filter — default TODAY. Active orders filter on upload date,
    // completed orders on completion date.
    const dayOf = v => v ? new Date(v).toISOString().slice(0, 10) : '';
    const todayStr = new Date().toISOString().slice(0, 10);
    const yestStr  = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const weekStr  = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const orderDay = o => dayOf(o.scan_status === 'done' ? (o.endTime || o.uploadedAt) : o.uploadedAt);
    const inDateFilter = o => {
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
      const canScan  = ord.scan_status !== 'done';
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
      const chips = [
        ord.claimed_by       ? `<span class="chip chip-claimed" title="Currently open at ${esc(ord.claimed_by)}'s station">&#128100; ${esc(ord.claimed_by)}</span>` : '',
        ord.archived         ? `<span class="chip chip-unproc" title="Stored in the archive (older than 60 days)">&#128451; Archived</span>` : '',
        ord.has_order_label  ? `<span class="chip chip-label">&#127991; Label</span>` : '',
        ord.has_waybill_pdf  ? `<span class="chip chip-waybill">&#128196; Waybill</span>` : '',
      ].filter(Boolean).join('');

      // Date
      const dateStr = ord.uploadedAt ? new Date(ord.uploadedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';

      return `<tr class="orders-tr status-${ord.scan_status}${isDone && !ord.keyfields_closed && isAdminView ? ' kf-pending' : ''}" data-order="${esc(ord.order_number)}">
        <td class="ord-stripe-cell"></td>
        <td class="col-order">
          <span class="ord-no-link">${esc(ord.order_number)}</span>
          ${isAdminView && ord.idealscan_code ? `<div class="ord-jobcode"><code class="job-code">${esc(ord.idealscan_code)}</code></div>` : ''}
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
          ${logUnlocked && !ord.archived ? `<button class="btn-del-order" data-order="${esc(ord.order_number)}" data-batchid="${esc(ord.batchId || '')}" title="Delete">&#128465;</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    const rz = id => `<span class="col-resize" data-col="${id}"></span>`;
    document.getElementById('ordersDashList').innerHTML = `
      ${subTabsHTML}
      ${ordersColsToggleHTML()}
      <div class="orders-table-wrap">
        <table class="orders-table">
          <thead>
            <tr>
              <th style="width:4px;padding:0"></th>
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
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const orderNumber = btn.dataset.order, batchId = btn.dataset.batchid;
        if (!confirm(`Delete order ${orderNumber}?\nThis cannot be undone.`)) return;
        try {
          const r = await fetch(`/api/master/order/${encodeURIComponent(batchId)}/${encodeURIComponent(orderNumber)}`, { method: 'DELETE', headers: { 'x-master-key': LOG_PASSWORD } });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Delete failed');
          await refreshOrders(); renderOrdersList();
        } catch (err) { alert(err.message); }
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
    detachGlobalScanCapture();
    _scanQueue.length = 0;
    _scanBusy = false;
    stopTimer();
    activeOrder = null;
    focusWaybillInput();
  }

  document.getElementById('backToOrdersBtn').addEventListener('click', pauseAndGoToOrders);
  document.getElementById('pauseOrderBtn').addEventListener('click', pauseAndGoToOrders);

  // ── Print label prompt (auto-dismisses after 3 s) ─────────────────────────
  let _pltTimer = null;
  let _pltOrder = null;

  function showPrintLabelPrompt(order) {
    _pltOrder = order;
    clearTimeout(_pltTimer);
    const toast     = document.getElementById('printLabelToast');
    const countdown = document.getElementById('pltCountdown');
    let secs = 3;
    countdown.textContent = secs;
    toast.classList.remove('hidden');
    _pltTimer = setInterval(() => {
      secs--;
      countdown.textContent = secs;
      if (secs <= 0) dismissPrintLabelPrompt();
    }, 1000);
  }

  function dismissPrintLabelPrompt() {
    clearInterval(_pltTimer);
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
  function enterItemsPhase(order) {
    activeOrder      = order;
    currentMismatches = [];

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
        ${details ? `<button class="meta-details-btn" id="scanMetaDetailsBtn">&#9432; Details</button>` : ''}
      </div>
      ${details ? `<div class="scan-meta-details hidden" id="scanMetaDetails">${details}</div>` : ''}`;
    document.getElementById('scanMetaDetailsBtn')?.addEventListener('click', () => {
      document.getElementById('scanMetaDetails').classList.toggle('hidden');
    });

    scanPage = 0; scanPageManual = false; scanFocusSku = null;
    _autoCompleteFired = false;
    scanPageSize = SCAN_PAGE_MAX; // re-measure fit for this screen
    renderItemsTable(order);
    updateProgress(order);
    startTimer(orderTimings[order.order_number]);

    const input = document.getElementById('itemScanInput');
    input.value = '';
    document.getElementById('itemScanFeedback').classList.add('hidden');
    setTimeout(focusActiveQty, 80);
  }

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
      const desc = (item.description && item.description !== item.sku) ? item.description : '—';

      // Completed rows: slim single line, no lot row, no input
      if (done) {
        return `
        <tr class="${rowClass}" data-sku="${esc(item.sku)}">
          <td><code class="sku-code sku-code-sm">${esc(item.sku)}</code></td>
          <td class="desc-cell desc-cell-sm">${esc(desc)}</td>
          <td class="qty-col">${item.qty}</td>
          <td class="qty-col done-frac">${s}/${item.qty}${pendMark}</td>
          <td class="status-icon">${icon}</td>
        </tr>`;
      }

      // Lot badges live inside the SKU cell (an extra table row per item
      // would break the fixed 5-rows-per-page layout)
      const lotParts = [];
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
        ? `<div class="nb-inline-bc-wrap"><svg class="nb-inline-bc" data-bc-sku="${esc(item.sku)}"></svg><div class="nb-inline-bc-hint">&#9535; scan this barcode off the screen</div></div>`
        : (noBarcode ? '<div class="nb-badge">&#9888; no barcode &mdash; count buttons, or wait for its turn</div>' : '');
      return `
        <tr class="${rowClass}" data-sku="${esc(item.sku)}">
          <td><code class="sku-code">${esc(item.sku)}</code>${lotBadges}${inlineBc}</td>
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

    // Render the single on-screen substitute barcode (CODE128 of the SKU) —
    // scanning it off the monitor goes through the normal scan path
    const bcEl = document.querySelector('#scanItemsTbody svg.nb-inline-bc');
    if (bcEl && window.JsBarcode) {
      try {
        JsBarcode(bcEl, bcEl.dataset.bcSku, { format: 'CODE128', width: 2.4, height: 54, displayValue: false, margin: 6, background: '#ffffff' });
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
  // 250ms: long enough that a gun pausing mid-code (laggy browser, long
  // barcode) never gets split into two fragments — a split's front half can
  // look like an unknown barcode and wrongly trigger the teach dialog
  const SCAN_IDLE_MS = 250;

  function _flushScanBuf() {
    clearTimeout(_scanFlushTimer);
    _scanFlushTimer = null;
    const val = _scanBuf.trim();
    _scanBuf  = '';
    const inp = document.getElementById('itemScanInput');
    inp.value = '';
    if (val && activeOrder) handleItemScan(val);
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
    // Never intercept while any modal dialog is visible
    if (document.querySelector('.modal-overlay:not(.hidden)')) return;

    const ae    = document.activeElement;
    const tag   = ae?.tagName;
    const isQty = !!ae?.classList?.contains('qty-input');
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      // Intercept the dedicated scan input and (for burst detection) qty
      // fields; pass every other input through untouched
      if (ae.id !== 'itemScanInput' && !isQty) return;
    }

    if (e.key === 'Enter') {
      if (isQty) {
        if (_qtyBurst?.scanner) { e.preventDefault(); _qtyBurstToScan(); }
        // else: manual qty entry — let Enter commit via the change event
        return;
      }
      // Add whatever is in the visible input field too (manual typing path)
      const inp = document.getElementById('itemScanInput');
      if (ae.id === 'itemScanInput' && inp.value) {
        _scanBuf += inp.value;
      }
      _flushScanBuf();
      e.preventDefault();
      return;
    }

    // Qty field: watch typing speed to tell gun from human
    if (isQty && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const now = Date.now();
      if (!_qtyBurst || _qtyBurst.el !== ae || now - _qtyBurst.last > QTY_BURST_GAP_MS) {
        _qtyBurst = { el: ae, chars: [], last: 0, base: ae.value, scanner: false };
      }
      _qtyBurst.chars.push(e.key);
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

    // Printable characters only — ignore modifier-only, arrow, Escape, Tab, etc.
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // If focus is NOT on the scan input, redirect the character there
      if (document.activeElement?.id !== 'itemScanInput') {
        document.getElementById('itemScanInput').focus();
        _scanBuf += e.key;
        // Keep the visible input in sync so user can see what the scanner typed
        const inp = document.getElementById('itemScanInput');
        inp.value = _scanBuf;
        e.preventDefault();
      } else {
        // Focus IS on itemScanInput — let the browser handle insertion naturally,
        // mirror into buffer on next tick so value is updated
        setTimeout(() => { _scanBuf = document.getElementById('itemScanInput').value; }, 0);
      }
      // Reset the idle timer
      clearTimeout(_scanFlushTimer);
      _scanFlushTimer = setTimeout(_flushScanBuf, SCAN_IDLE_MS);
    }
  }

  function attachGlobalScanCapture() {
    _scanBuf = ''; clearTimeout(_scanFlushTimer); _scanFlushTimer = null;
    document.addEventListener('keydown', _globalScanKeydown);
  }
  function detachGlobalScanCapture() {
    document.removeEventListener('keydown', _globalScanKeydown);
    _scanBuf = ''; clearTimeout(_scanFlushTimer); _scanFlushTimer = null;
    document.getElementById('itemScanInput').value = '';
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
    _scanQueue.push(sku);
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
  function pendingScansFor(orderNumber) { return _offlineQueue.filter(e => e.orderNumber === orderNumber); }

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

  function enqueueOfflineScan(raw) {
    const evt = {
      id: (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
      orderNumber: activeOrder.order_number,
      raw: String(raw).trim(),
      at: new Date().toISOString(),
    };
    _offlineQueue.push(evt);
    _saveOffQ();
    const sku = resolveScanLocally(evt.raw, activeOrder);
    const feedback = document.getElementById('itemScanFeedback');
    showFeedback(feedback, 'pending',
      sku ? `⚡ No connection — ${sku} counted, will sync automatically`
          : `⚡ No connection — scan saved (${evt.raw}), will sync automatically`);
    if (sku) { scanFocusSku = sku; scanPageManual = false; }
    renderItemsTable(activeOrder);
    updateProgress(activeOrder);
    updateOfflinePill();
    scheduleOfflineSync(4000);
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
        let resp, data;
        try {
          resp = await fetchT('/api/scan/increment', {
            method: 'POST', headers: hdrs(),
            body: JSON.stringify({ orderNumber: evt.orderNumber, sku: evt.raw, eventId: evt.id }),
          });
          data = await resp.json();
        } catch {
          scheduleOfflineSync(6000); // still offline — try again shortly
          return;
        }
        _offlineQueue.shift();
        _saveOffQ();
        if (resp.ok) {
          if (activeOrder && activeOrder.order_number === evt.orderNumber) {
            if (!activeOrder.scanned) activeOrder.scanned = {};
            activeOrder.scanned[data.sku] = data.scanned_qty;
          }
        } else {
          issues.push(`${evt.raw} on ${evt.orderNumber}: ${data.error || resp.status}`);
        }
        updateOfflinePill();
      }
      if (activeOrder) {
        renderItemsTable(activeOrder);
        updateProgress(activeOrder);
      }
      const feedback = document.getElementById('itemScanFeedback');
      if (feedback && activeOrder) showFeedback(feedback, 'success', '✓ Connection restored — all queued scans synced');
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

  async function _drainScanQueue() {
    if (_scanBusy || !_scanQueue.length) return;
    _scanBusy = true;
    while (_scanQueue.length) {
      const sku      = _scanQueue.shift();
      const feedback = document.getElementById('itemScanFeedback');
      try {
        const resp = await fetchT('/api/scan/increment', {
          method: 'POST', headers: hdrs(),
          body: JSON.stringify({ orderNumber: activeOrder.order_number, sku }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          // Unknown product barcode → teach-on-scan: packer confirms which
          // line it is, mapping is remembered everywhere from then on
          if (data.teachable && data.barcode) {
            openTeachBarcodeModal(data.barcode, data.resolved);
          } else {
            showFeedback(feedback, 'error', data.error || `SKU not in this order: ${sku}`);
          }
          continue;
        }
        if (!activeOrder.scanned) activeOrder.scanned = {};
        activeOrder.scanned[data.sku] = data.scanned_qty;
        activeOrder.scan_status = 'processing';
        scanFocusSku   = data.sku; // show the page of the item just scanned
        scanPageManual = false;
        renderItemsTable(activeOrder);
        updateProgress(activeOrder);
        maybeAutoComplete();

        const row = document.querySelector(`#scanItemsTbody tr[data-sku="${CSS.escape(data.sku)}"]`);
        if (row) { row.classList.add('row-flash'); setTimeout(() => row.classList.remove('row-flash'), 450); }

        const overBy = data.scanned_qty - data.ordered_qty;
        showFeedback(feedback, overBy > 0 ? 'error' : 'success',
          overBy > 0
            ? `${data.sku}: OVER by ${overBy} (scanned ${data.scanned_qty}, ordered ${data.ordered_qty})`
            : data.scanned_qty === data.ordered_qty
              ? `${data.sku}: ✓ Complete (${data.scanned_qty}/${data.ordered_qty})`
              : `${data.sku}: ${data.scanned_qty}/${data.ordered_qty} scanned`
        );
      } catch (err) {
        // Network failure (dead Wi-Fi hangs or refuses) — save the scan
        // durably and keep the packer moving; it syncs automatically
        enqueueOfflineScan(sku);
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

  // ── Print waybill modal ────────────────────────────────────────────────────
  function showPrintWaybillModal(order) {
    clearTimeout(printWaybillTimer);
    document.getElementById('printOrderNo').textContent = order.order_number;
    document.getElementById('printCountdownNum').textContent = '3';
    document.getElementById('printWaybillOverlay').classList.remove('hidden');

    const bar = document.getElementById('printCountdownBar');
    bar.style.transition = 'none';
    bar.style.width = '100%';
    bar.getBoundingClientRect();
    bar.style.transition = 'width 3s linear';
    bar.style.width = '0%';

    let remaining = 3;
    const numEl = document.getElementById('printCountdownNum');
    const tick  = setInterval(() => {
      remaining--;
      numEl.textContent = remaining;
      if (remaining <= 0) { clearInterval(tick); closePrintWaybillModal(); }
    }, 1000);
    printWaybillTimer = tick;

    const dlBtn = document.getElementById('printNowBtn');
    dlBtn.onclick = () => {
      clearInterval(tick);
      closePrintWaybillModal();
      authDownload(
        `/api/waybill-pdf/${encodeURIComponent(order.batchId)}/${encodeURIComponent(order.order_number)}?dl=1`,
        `${order.order_number}_waybill.pdf`
      );
    };
    document.getElementById('printSkipBtn').onclick = () => {
      clearInterval(tick);
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
  const LOG_PASSWORD = atob('MjAxNDMyNTQ3RQ=='); // 201432547E

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

  document.getElementById('logPasswordSubmitBtn').addEventListener('click', () => {
    const val = document.getElementById('logPasswordInput').value;
    if (val === LOG_PASSWORD) {
      logUnlocked = true;
      document.getElementById('logPasswordOverlay').classList.add('hidden');
      openLogOverlay();
    } else {
      document.getElementById('logPasswordError').classList.remove('hidden');
      document.getElementById('logPasswordInput').select();
    }
  });

  document.getElementById('logPasswordCancelBtn').addEventListener('click', () => {
    document.getElementById('logPasswordOverlay').classList.add('hidden');
  });

  document.getElementById('closeLogBtn').addEventListener('click', () => {
    document.getElementById('logOverlay').classList.add('hidden');
    document.body.classList.remove('log-open');
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
  }

  // Admin tab switching
  document.querySelectorAll('.admin-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`adminTab-${btn.dataset.adminTab}`).classList.remove('hidden');
      if (btn.dataset.adminTab === 'batches') renderLogContent();
    });
  });

  // ── User Management ─────────────────────────────────────────────────────────
  async function loadUserList() {
    const listEl = document.getElementById('userList');
    try {
      const resp  = await fetch('/api/master/users', { headers: { 'x-master-key': LOG_PASSWORD } });
      const users = await resp.json();
      listEl.innerHTML = users.map(u => `
        <div class="user-row" data-id="${esc(u.id)}">
          <span class="user-id">${esc(u.id)}</span>
          <span class="user-name">${esc(u.name || u.id)}</span>
          <span class="role-badge ${esc(u.role || 'admin')}">${u.role === 'warehouse' ? 'Warehouse' : 'Admin'}</span>
          <div class="user-row-actions">
            <button class="btn-role-toggle" data-id="${esc(u.id)}" data-role="${esc(u.role || 'admin')}" title="Toggle role">
              ${u.role === 'warehouse' ? '&#8593; Make Admin' : '&#8595; Warehouse'}
            </button>
            <button class="btn-chpass" data-id="${esc(u.id)}" title="Change password">&#128273; Password</button>
            <button class="btn-del-user" data-id="${esc(u.id)}" title="Delete user">&#128465;</button>
          </div>
        </div>`).join('');

      listEl.querySelectorAll('.btn-role-toggle').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newRole = btn.dataset.role === 'warehouse' ? 'admin' : 'warehouse';
          const r = await fetch(`/api/master/users/${encodeURIComponent(btn.dataset.id)}/role`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
            body: JSON.stringify({ role: newRole }),
          });
          const d = await r.json();
          if (!r.ok) { alert(d.error); return; }
          showUserStatus(`Role updated to ${newRole}.`, 'success');
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

  document.getElementById('addUserBtn').addEventListener('click', async () => {
    const id   = document.getElementById('newUserId').value.trim();
    const name = document.getElementById('newUserName').value.trim();
    const pass = document.getElementById('newUserPass').value.trim();
    const role = document.getElementById('newUserRole').value;
    if (!id || !pass) { showUserStatus('User ID and password are required.', 'error'); return; }
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
      showUserStatus(`User "${id}" added as ${role}.`, 'success');
      loadUserList();
    } catch (err) { showUserStatus(err.message, 'error'); }
  });

  function showUserStatus(msg, type) {
    const el = document.getElementById('userMgmtStatus');
    el.textContent  = msg;
    el.className    = `status-bar ${type}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
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
      a.href = url; a.download = `IDEALSCAN_Status_${new Date().toISOString().slice(0,10)}.xlsx`;
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

      listEl.querySelectorAll('.btn-del-batch').forEach(btn => {
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
  let cameraScanMode  = 'single'; // 'single' | 'batch' | 'label'
  const batchMap      = new Map(); // rawValue → { checked: bool }
  const lastSingleHit = {};        // rawValue → timestamp (cooldown)
  const SINGLE_COOLDOWN_MS = 1800;

  document.getElementById('openCameraBtn').addEventListener('click', openCameraScanner);
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
    if (sku && sku !== '—') { handleItemScan(sku); closeCameraScanner(); }
  });

  document.getElementById('cameraClearBtn').addEventListener('click', () => { batchMap.clear(); renderBatchChips(); });
  document.getElementById('cameraSelectAllBtn').addEventListener('click', () => {
    batchMap.forEach(v => { v.checked = true; }); renderBatchChips();
  });
  document.getElementById('cameraScanSelectedBtn').addEventListener('click', () => {
    const selected = [...batchMap.entries()].filter(([, v]) => v.checked).map(([k]) => k);
    if (!selected.length) return;
    selected.forEach(val => handleItemScan(val));
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

  async function openCameraScanner() {
    document.getElementById('cameraScanOverlay').classList.remove('hidden');
    document.getElementById('cameraNoSupport').classList.add('hidden');
    document.getElementById('cameraViewfinderWrap').classList.remove('hidden');
    // ensure panels start hidden — setCameraMode will show the right one
    document.getElementById('cameraBatchPanel').classList.add('hidden');
    document.getElementById('cameraLabelPanel').classList.add('hidden');
    document.getElementById('cameraLabelAim').classList.add('hidden');

    if (!('BarcodeDetector' in window)) {
      document.getElementById('cameraViewfinderWrap').classList.add('hidden');
      document.getElementById('cameraBatchPanel').classList.add('hidden');
      document.getElementById('cameraLabelPanel').classList.add('hidden');
      document.getElementById('cameraNoSupport').classList.remove('hidden');
      return;
    }

    if (!barcodeDetector) {
      let fmts;
      try { fmts = await BarcodeDetector.getSupportedFormats(); }
      catch { fmts = ['code_128', 'ean_13', 'ean_8', 'qr_code', 'upc_a', 'upc_e', 'code_39', 'itf', 'data_matrix']; }
      barcodeDetector = new BarcodeDetector({ formats: fmts });
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
    document.getElementById('itemScanInput').focus();
  }

  function startCameraLoop() {
    const video = document.getElementById('cameraVideo');
    async function loop() {
      if (!cameraStream) return;
      try {
        if (video.readyState >= 2) {
          const results = await barcodeDetector.detect(video);
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
          handleItemScan(val);
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
    const token   = localStorage.getItem('wms_token') || '';
    window.open(`/api/order-label/${encodeURIComponent(orderNo)}/pdf?token=${encodeURIComponent(token)}`, '_blank');
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

  async function doLabelImport(file) {
    const statusEl = document.getElementById('labelImportStatus');
    statusEl.className = 'status-bar loading';
    statusEl.textContent = 'Uploading and processing pages…';
    statusEl.classList.remove('hidden');
    const fd = new FormData();
    fd.append('labelPdf', file);
    try {
      const resp = await fetch('/api/label-imports', { method: 'POST', body: fd });
      const data = await resp.json();
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
      ].filter(Boolean).join('');

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
  document.getElementById('labelImportDropZone').addEventListener('dragover', e => e.preventDefault());
  document.getElementById('labelImportDropZone').addEventListener('drop', e => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
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

  // ── Init ───────────────────────────────────────────────────────────────────
  initLogin();
})();
