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
  let printWaybillTimer   = null;
  let pendingOrderFile    = null;
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
    } catch {}
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
    const uploadTabBtn = document.querySelector('.tab-btn[data-tab="upload"]');
    if (uploadTabBtn) uploadTabBtn.classList.toggle('hidden', isWarehouse);

    // Upload Log footer button — hidden for warehouse
    const logBtn = document.getElementById('logAccessBtn');
    if (logBtn) logBtn.classList.toggle('hidden', isWarehouse);

    // If warehouse user lands on Upload tab, redirect to Orders
    if (isWarehouse && document.getElementById('tab-upload').classList.contains('active')) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('tab-orders').classList.add('active');
      const ordersBtn = document.querySelector('.tab-btn[data-tab="orders"]');
      if (ordersBtn) ordersBtn.classList.add('active');
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

  // ── Tab switching ──────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );
  document.querySelectorAll('[data-tab-link]').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tabLink))
  );

  function switchTab(name) {
    // Warehouse users cannot access the upload tab
    if (name === 'upload' && (currentUser?.role || 'admin') === 'warehouse') return;
    if (!document.getElementById(`tab-${name}`)) return;
    if (pendingDownload && name === 'orders') {
      const dlWrap = document.getElementById('uploadDownloadWrap');
      dlWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
      dlWrap.classList.remove('download-shake');
      void dlWrap.offsetWidth; // reflow to restart animation
      dlWrap.classList.add('download-shake');
      setTimeout(() => dlWrap.classList.remove('download-shake'), 400);
      return;
    }
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${name}`).classList.add('active');
    document.querySelector(`.tab-btn[data-tab="${name}"]`).classList.add('active');
    if (name === 'upload') { fetchAndRenderStats(); renderBreakdowns(loadedOrders); }
    if (name === 'orders') { renderOrdersDash(); setTimeout(() => focusWaybillInput(), 300); }
  }

  function lockTabsForDownload() {
    pendingDownload = true;
    document.querySelector('.tab-btn[data-tab="orders"]').classList.add('tab-locked');
  }

  function unlockTabsAfterDownload() {
    pendingDownload = false;
    document.querySelector('.tab-btn[data-tab="orders"]').classList.remove('tab-locked');
    const noteEl = document.getElementById('downloadLockNote');
    if (noteEl) noteEl.remove();
  }

  // ── Dashboard Stats ────────────────────────────────────────────────────────
  async function fetchAndRenderStats() {
    try {
      const resp = await fetch('/api/stats');
      if (!resp.ok) return;
      const s = await resp.json();
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
        </div>`;
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
  const waybillPdfInput = document.getElementById('waybillPdfInput');

  document.getElementById('browseBtn').addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
  document.getElementById('browsePdfBtn').addEventListener('click', () => waybillPdfInput.click());
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) previewOrderFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) previewOrderFile(fileInput.files[0]); });
  waybillPdfInput.addEventListener('change', () => {
    const f = waybillPdfInput.files[0];
    document.getElementById('waybillPdfName').textContent = f ? f.name : '';
  });

  document.getElementById('goOrdersBtn').addEventListener('click', () => switchTab('orders'));

  // ── Step 1: Preview (parse only) ───────────────────────────────────────────
  async function previewOrderFile(file) {
    pendingOrderFile = file;
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

  // ── Step 2: Confirm modal ──────────────────────────────────────────────────
  function showUploadConfirmModal(filename, preview) {
    const fromFile = (preview.clientName || '').trim();
    if (fromFile) document.getElementById('clientNameInput').value = fromFile;
    const clientName = fromFile || document.getElementById('clientNameInput').value.trim();
    document.getElementById('confirmFileName').textContent    = filename;
    document.getElementById('confirmClientName').textContent  = clientName || '(not specified)';
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

    document.getElementById('confirmEmailError').classList.add('hidden');
    document.getElementById('confirmApproveBtn').disabled    = false;
    document.getElementById('confirmApproveBtn').textContent = 'Approve & Upload →';
    document.getElementById('confirmEmail').value = defaultRecipientEmail;
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
    const email  = document.getElementById('confirmEmail').value.trim();
    const errEl  = document.getElementById('confirmEmailError');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errEl.textContent = 'Please enter a valid email address, or leave blank to skip.';
      errEl.classList.remove('hidden'); return;
    }
    errEl.classList.add('hidden');
    document.getElementById('confirmApproveBtn').disabled    = true;
    document.getElementById('confirmApproveBtn').textContent = 'Uploading…';
    await doUpload(email);
  });

  // ── Step 3: Actual upload ──────────────────────────────────────────────────
  async function doUpload(emailTo) {
    if (!pendingOrderFile) return;
    const file       = pendingOrderFile;
    const clientName = document.getElementById('clientNameInput').value.trim();
    const pdfFile    = waybillPdfInput.files[0];

    const form = new FormData();
    form.append('orderFile', file);
    if (pdfFile)     form.append('waybillPdf', pdfFile);
    if (clientName)  form.append('client_name', clientName);
    if (emailTo)     form.append('email_to', emailTo);
    form.append('direction', uploadDirection);

    try {
      const resp = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-session-id': SESSION_ID },
        body: form,
      });
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

      const pdfMsg   = pdfFile ? ' Waybill PDF is being split in the background.' : '';
      const emailMsg = data.emailSent ? ` Also emailed to ${data.emailTo}.` : '';
      setUploadStatus('success',
        `Converted ${data.rowCount} line(s) across ${data.orders.length} order(s) from "${file.name}".${emailMsg}${pdfMsg}`
      );

      // Show download button immediately and lock tabs until downloaded
      const dlBtn  = document.getElementById('uploadDownloadBtn');
      const dlWrap = document.getElementById('uploadDownloadWrap');
      dlBtn.href   = `/api/download-wms/${data.batchId}`;
      dlBtn.setAttribute('download', `WMS_${file.name.replace(/\.[^.]+$/, '')}_${new Date().toISOString().slice(0,10)}.xlsx`);
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
      dlBtn.addEventListener('click', unlockTabsAfterDownload, { once: true });

      renderUploadList(data.orders);
      renderBreakdowns(data.orders);
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

    // Build client filter
    const clients = [...new Set(loadedOrders.map(o => o.client_name || '').filter(Boolean))];
    const clientRow = document.getElementById('clientFilterRow');
    if (clients.length > 0) {
      clientRow.innerHTML = `
        <span class="filter-label">Client:</span>
        <button class="filter-chip ${activeClientFilter === 'all' ? 'active' : ''}" data-client="all">All</button>
        ${clients.map(c => `<button class="filter-chip ${activeClientFilter === c ? 'active' : ''}" data-client="${esc(c)}">${esc(c)}</button>`).join('')}`;
      clientRow.querySelectorAll('.filter-chip[data-client]').forEach(btn => {
        btn.addEventListener('click', () => {
          activeClientFilter = btn.dataset.client;
          renderOrdersList();
          clientRow.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
    } else {
      clientRow.innerHTML = '';
    }

    // Build carrier filter
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
    const val = e.target.value.trim();
    if (!val) return;
    e.target.value = '';
    setWaybillMsg('Searching...', false);
    try {
      const r = await fetch('/api/waybill-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waybill: val }),
      });
      const data = await r.json();
      if (!r.ok || !data.order_number) {
        setWaybillMsg('No order found for that waybill.', true);
        return;
      }
      const ord = loadedOrders.find(o => o.order_number === data.order_number);
      if (!ord) {
        setWaybillMsg('Order not in current batch.', true);
        return;
      }
      if (ord.scan_status === 'done') {
        setWaybillMsg('Order already completed.', true);
        return;
      }
      setWaybillMsg('', false);
      openScanOverlay(data.order_number);
    } catch (err) {
      setWaybillMsg('Lookup failed. Try again.', true);
    }
  });

  function renderOrdersList() {
    let orders = loadedOrders;
    if (activeClientFilter  !== 'all') orders = orders.filter(o => (o.client_name || '') === activeClientFilter);
    if (activeCarrierFilter !== 'all') orders = orders.filter(o => (o.carrier || '') === activeCarrierFilter);

    const sortPriority = { processing: 0, pending: 1, unprocessed: 2, done: 3 };
    orders = [...orders].sort((a, b) =>
      (sortPriority[a.scan_status] ?? 4) - (sortPriority[b.scan_status] ?? 4)
    );
    const labels = { pending: 'Pending', processing: 'In Progress', done: 'Done', unprocessed: 'Unprocessed' };
    const isAdminView = (currentUser?.role || 'admin') === 'admin';

    document.getElementById('ordersDashList').innerHTML = orders.length ? orders.map(ord => {
      const scannedTotal = Object.values(ord.scanned || {}).reduce((s, v) => s + v, 0);
      const canScan      = ord.scan_status !== 'done';
      const elapsed      = fmtElapsed(ord.startTime, ord.endTime);
      const isDone       = ord.scan_status === 'done';
      const slipUrl      = ord.batchId
        ? `/api/completion-slip/${encodeURIComponent(ord.batchId)}/${encodeURIComponent(ord.order_number)}`
        : null;
      const emailIndicator = isDone && isAdminView && ord.alert_email_sent !== null
        ? ord.alert_email_sent
          ? `<span class="alert-email-ok" title="Completion alert sent">&#128231; Sent</span>`
          : `<span class="alert-email-fail" title="${esc(ord.alert_email_error || 'Email failed')}">&#9888; Email failed</span>
             <button class="btn-resend-alert" data-order="${esc(ord.order_number)}" title="Resend completion alert">Resend</button>`
        : '';
      const kfBtn = isDone && isAdminView
        ? ord.keyfields_closed
          ? `<span class="kf-closed-badge">&#10003; Keyfields closed</span>`
          : `<button class="btn-kf-close" data-order="${esc(ord.order_number)}" title="Acknowledge closed in Keyfields WMS">Close in Keyfields</button>`
        : '';
      return `
        <div class="dash-order-card status-${ord.scan_status}${isDone && !ord.keyfields_closed && isAdminView ? ' kf-pending' : ''}" data-order="${esc(ord.order_number)}">
          <div class="dash-order-left">
            <span class="dash-order-no">${esc(ord.order_number)}</span>
            ${ord.client_name ? `<span class="dash-order-client">${esc(ord.client_name)}</span>` : ''}
            <span class="dash-order-customer">${esc(ord.customer_name || '')}</span>
            ${ord.waybill_number ? `<span class="dash-order-waybill">${esc(ord.waybill_number)}</span>` : ''}
            ${ord.has_waybill_pdf ? `<span class="chip chip-waybill">&#128196; with waybill</span>` : ''}
            ${isDone && ord.operator ? `<span class="done-meta">&#128100; ${esc(ord.operator)}</span>` : ''}
            ${isDone && elapsed ? `<span class="done-meta done-elapsed">&#8987; ${esc(elapsed)}</span>` : ''}
            ${isDone && ord.endTime ? `<span class="done-meta done-time">${fmtDateTime(ord.endTime)}</span>` : ''}
            ${emailIndicator}
          </div>
          <div class="dash-order-right">
            ${ord.carrier ? `<span class="chip chip-carrier">${esc(ord.carrier)}</span>` : ''}
            <span class="status-badge ${ord.scan_status}">${labels[ord.scan_status] || ord.scan_status}</span>
            <span class="dash-order-prog">${scannedTotal}/${ord.total_qty}</span>
            ${canScan ? `<button class="btn-scan-now" data-order="${esc(ord.order_number)}">Scan &#8594;</button>` : ''}
            ${isDone ? `<button class="btn-reprint-label" data-order="${esc(ord.order_number)}" title="Reprint waybill label">&#128438; Label</button>` : ''}
            ${isDone && slipUrl ? `<a class="btn-slip" href="${esc(slipUrl)}" download title="Download completion slip">&#128196; Slip</a>` : ''}
            ${ord.has_waybill_pdf && ord.batchId ? `<a class="btn-waybill-pdf" href="/api/waybill-pdf/${esc(ord.batchId)}/${esc(ord.order_number)}" target="_blank" title="Print waybill PDF">&#128438; Print</a>` : ''}
            ${kfBtn}
            ${logUnlocked ? `<button class="btn-del-order" data-order="${esc(ord.order_number)}" data-batchid="${esc(ord.batchId || '')}" title="Delete this order">&#128465;</button>` : ''}
          </div>
        </div>`;
    }).join('') : '<p class="empty-state" style="padding:1.5rem">No orders match the selected filters.</p>';

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
    document.querySelectorAll('.dash-order-card').forEach(card =>
      card.addEventListener('click', () => {
        const ord = loadedOrders.find(o => o.order_number === card.dataset.order);
        if (ord && ord.scan_status !== 'done') openScanOverlay(card.dataset.order);
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
  function openScanOverlay(orderNumber) {
    if (!currentUser) { requireLogin(() => openScanOverlay(orderNumber)); return; }
    const ord = loadedOrders.find(o => o.order_number === orderNumber);
    if (!ord) return;
    activeOrder = ord;
    enterItemsPhase(ord);
    document.getElementById('scanOverlay').classList.remove('hidden');
    document.body.classList.add('scan-open');
    attachGlobalScanCapture();
  }

  function closeScanOverlay() {
    document.getElementById('scanOverlay').classList.add('hidden');
    document.body.classList.remove('scan-open');
    detachGlobalScanCapture();
    _scanQueue.length = 0;
    _scanBusy = false;
    stopTimer();
    activeOrder = null;
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
  }

  document.getElementById('pltPrintBtn').addEventListener('click', () => {
    const ord = _pltOrder;
    dismissPrintLabelPrompt();
    if (ord) printWaybillLabel(ord);
  });
  document.getElementById('pltSkipBtn').addEventListener('click', dismissPrintLabelPrompt);

  function printWaybillLabel(order) {
    const carrier     = (order.carrier || '').trim();
    const header      = carrier || 'IDEALOMS';
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

    // Barcode section — only if there's a waybill number
    const barcodeSection = waybill ? `
  <div class="barcode-section">
    <svg id="barcode"></svg>
    <div class="barcode-text">${esc(waybill)}</div>
  </div>` : '';

    const printerHint = printerName
      ? `<div class="printer-hint">&#128438; Print to: <strong>${esc(printerName)}</strong></div>`
      : '';

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
    background: #000; color: #fff;
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
  <div class="label-header">${esc(header)}</div>

  ${barcodeSection}

  <div class="section">
    <div class="section-title">Deliver To</div>
    <div class="customer-name">${esc(customer)}</div>
    <div class="address">${esc(address)}</div>
    ${tel ? `<div class="tel">Tel: ${esc(tel)}</div>` : ''}
  </div>

  <div class="section">
    <div class="section-title">Items</div>
    <table class="items">
      <thead><tr><th>SKU / Item</th><th class="qty">Qty</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
  </div>

  <div class="footer-row">
    <div class="order-no">Order: ${esc(order.order_number)}</div>
    ${platform ? `<div class="platform-badge">${esc(platform)}</div>` : ''}
  </div>

  <script>
    ${waybill ? `JsBarcode("#barcode","${waybill.replace(/"/g,'\\"')}",{format:"CODE128",width:2.8,height:60,displayValue:false,margin:4});` : ''}
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
    document.getElementById('scanOrderMeta').innerHTML = `
      <span><strong>Customer:</strong> ${esc(order.customer_name || '—')}</span>
      ${order.client_name ? `<span><strong>Client:</strong> ${esc(order.client_name)}</span>` : ''}
      <span><strong>Carrier:</strong> ${esc(order.carrier || '—')}</span>
      <span class="${order.waybill_number ? 'waybill-ok' : ''}">
        <strong>Waybill:</strong>
        ${order.waybill_number ? `${esc(order.waybill_number)} &#10003;` : 'Not provided'}
      </span>
      ${order.tel ? `<span><strong>Tel:</strong> ${esc(order.tel)}</span>` : ''}
      ${order.delivery_address ? `<span class="scan-meta-address"><strong>Address:</strong> ${esc(order.delivery_address)}</span>` : ''}
      ${order.platform ? `<span><strong>Platform:</strong> ${esc(order.platform)}${order.shop_name ? ' / ' + esc(order.shop_name) : ''}</span>` : ''}
      ${order.has_waybill_pdf ? `<span class="meta-waybill-note">&#128196; Waybill PDF ready</span>` : ''}`;

    renderItemsTable(order);
    updateProgress(order);
    startTimer(orderTimings[order.order_number]);

    const input = document.getElementById('itemScanInput');
    input.value = '';
    document.getElementById('itemScanFeedback').classList.add('hidden');
    setTimeout(() => input.focus(), 80);
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
  function renderItemsTable(order) {
    const scanned = order.scanned || {};
    document.getElementById('scanItemsTbody').innerHTML = order.lines.map(item => {
      const s        = scanned[item.sku] || 0;
      const rowClass = s === 0 ? '' : s === item.qty ? 'row-ok' : s > item.qty ? 'row-over' : 'row-partial';
      const icon     = s === item.qty && s > 0 ? '&#10003;' : s > item.qty ? '&#10007;' : s > 0 ? '&#8230;' : '';
      return `
        <tr class="${rowClass}" data-sku="${esc(item.sku)}">
          <td><code>${esc(item.sku)}</code></td>
          <td>${esc(item.description || '—')}</td>
          <td class="qty-col">${item.qty}</td>
          <td class="qty-col">
            <input type="number" class="qty-input" min="0" value="${s}"
              data-sku="${esc(item.sku)}" data-ordered="${item.qty}" />
          </td>
          <td class="status-icon">${icon}</td>
        </tr>`;
    }).join('');

    document.querySelectorAll('.qty-input').forEach(inp => {
      inp.addEventListener('change', async () => {
        await setItemQty(activeOrder.order_number, inp.dataset.sku, parseInt(inp.value, 10) || 0);
        document.getElementById('itemScanInput').focus();
      });
    });
  }

  function updateProgress(order) {
    const scanned   = order.scanned || {};
    const doneCount = order.lines.filter(l => (scanned[l.sku] || 0) === l.qty).length;
    const el        = document.getElementById('scanProgress');
    el.textContent  = `${doneCount}/${order.lines.length} items`;
    el.className    = doneCount === order.lines.length ? 'scan-progress all-done' : 'scan-progress';
  }

  // ── Global barcode capture ─────────────────────────────────────────────────
  // Physical barcode scanners send characters + Enter as keyboard events.
  // We intercept every keystroke document-wide while the scan overlay is open
  // so focus location doesn't matter. Characters build a buffer; Enter fires.
  // A 120 ms idle timeout also fires (handles scanners that omit Enter).
  let _scanBuf = '';
  let _scanFlushTimer = null;
  const SCAN_IDLE_MS = 120;

  function _flushScanBuf() {
    clearTimeout(_scanFlushTimer);
    _scanFlushTimer = null;
    const val = _scanBuf.trim();
    _scanBuf  = '';
    const inp = document.getElementById('itemScanInput');
    inp.value = '';
    if (val && activeOrder) handleItemScan(val);
  }

  function _globalScanKeydown(e) {
    // Let normal input inside qty fields or modal inputs work uninterrupted
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      // Only intercept the dedicated scan input; pass everything else through
      if (document.activeElement.id !== 'itemScanInput') return;
    }

    if (e.key === 'Enter') {
      // Add whatever is in the visible input field too (manual typing path)
      const inp = document.getElementById('itemScanInput');
      if (document.activeElement.id === 'itemScanInput' && inp.value) {
        _scanBuf += inp.value;
      }
      _flushScanBuf();
      e.preventDefault();
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

  async function _drainScanQueue() {
    if (_scanBusy || !_scanQueue.length) return;
    _scanBusy = true;
    while (_scanQueue.length) {
      const sku      = _scanQueue.shift();
      const feedback = document.getElementById('itemScanFeedback');
      try {
        const resp = await fetch('/api/scan/increment', {
          method: 'POST', headers: hdrs(),
          body: JSON.stringify({ orderNumber: activeOrder.order_number, sku }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          showFeedback(feedback, 'error', data.error || `SKU not in this order: ${sku}`);
          continue;
        }
        if (!activeOrder.scanned) activeOrder.scanned = {};
        activeOrder.scanned[data.sku] = data.scanned_qty;
        activeOrder.scan_status = 'processing';
        renderItemsTable(activeOrder);
        updateProgress(activeOrder);

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
        showFeedback(document.getElementById('itemScanFeedback'), 'error', err.message);
      }
    }
    _scanBusy = false;
    document.getElementById('itemScanInput').focus();
  }

  async function setItemQty(orderNumber, sku, qty) {
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
      renderItemsTable(activeOrder);
      updateProgress(activeOrder);
    } catch (err) { alert(err.message); }
  }

  function showFeedback(el, type, msg) {
    el.className = `scan-feedback ${type}`;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  // ── Complete order ─────────────────────────────────────────────────────────
  document.getElementById('completeOrderBtn').addEventListener('click', async () => {
    if (!activeOrder) return;
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
        if (completedOrder.has_waybill_pdf && completedOrder.batchId) {
          showPrintWaybillModal(completedOrder);
        } else {
          showPrintLabelPrompt(completedOrder);
        }
      } else {
        showMismatchModal(data.mismatches);
      }
    } catch (err) { alert(err.message); }
  });

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

    document.getElementById('printNowBtn').onclick = () => {
      clearInterval(tick);
      window.open(`/api/waybill-pdf/${encodeURIComponent(order.batchId)}/${encodeURIComponent(order.order_number)}`, '_blank');
      closePrintWaybillModal();
    };
    document.getElementById('printSkipBtn').onclick = () => {
      clearInterval(tick);
      closePrintWaybillModal();
    };
  }

  function closePrintWaybillModal() {
    document.getElementById('printWaybillOverlay').classList.add('hidden');
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

  function renderMasterActions() {
    document.getElementById('masterActionsSection').classList.remove('hidden');
    document.getElementById('adminLockedState').classList.add('hidden');
    loadUserList();
    loadEmailConfig();
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
      document.getElementById('cfgFromEmail').value = conf.from_email || '';
      document.getElementById('cfgPassword').value  = '';  // never pre-fill password
      document.getElementById('cfgPassNote').textContent = conf.has_password ? '(saved — leave blank to keep)' : '';
      document.getElementById('cfgSmtpHost').value  = conf.smtp_host || 'smtp.gmail.com';
      document.getElementById('cfgSmtpPort').value  = conf.smtp_port || 587;
      document.getElementById('cfgToEmail').value   = conf.to_email  || '';
      defaultRecipientEmail = conf.to_email || '';
    } catch {}
  }

  function showEmailStatus(msg, type) {
    const el = document.getElementById('emailCfgStatus');
    el.textContent = msg; el.className = `status-bar ${type}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 5000);
  }

  document.getElementById('saveEmailCfgBtn').addEventListener('click', async () => {
    const from_email = document.getElementById('cfgFromEmail').value.trim();
    const password   = document.getElementById('cfgPassword').value.trim();
    const smtp_host  = document.getElementById('cfgSmtpHost').value.trim();
    const smtp_port  = document.getElementById('cfgSmtpPort').value.trim();
    const to_email   = document.getElementById('cfgToEmail').value.trim();
    if (!from_email) { showEmailStatus('From Email is required.', 'error'); return; }
    try {
      const r = await fetch('/api/master/email-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-master-key': LOG_PASSWORD },
        body: JSON.stringify({ from_email, password, smtp_host, smtp_port, to_email }),
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
      document.getElementById('cfgFromEmail').value = '';
      document.getElementById('cfgPassword').value  = '';
      document.getElementById('cfgPassNote').textContent = '';
      document.getElementById('cfgSmtpHost').value  = 'smtp.gmail.com';
      document.getElementById('cfgSmtpPort').value  = '587';
      document.getElementById('cfgToEmail').value   = '';
      showEmailStatus('Email settings cleared.', 'success');
    } catch (err) { showEmailStatus(err.message, 'error'); }
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

  async function renderLogContent() {
    const listEl  = document.getElementById('logOverlayList');
    const emptyEl = document.getElementById('logOverlayEmpty');
    listEl.innerHTML = '<p class="hint" style="padding:.5rem 0">Loading…</p>';
    try {
      const resp    = await fetch('/api/batches');
      const batches = await resp.json();
      if (!batches.length) {
        listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); return;
      }
      emptyEl.classList.add('hidden');
      listEl.innerHTML = batches.map(b => {
        const date   = new Date(b.uploaded_at).toLocaleString();
        const states = b.orderStates || {};
        const done   = Object.values(states).filter(s => s.status === 'done').length;
        const inprog = Object.values(states).filter(s => s.status === 'processing').length;
        const unproc = Object.values(states).filter(s => s.status === 'unprocessed').length;
        return `
          <div class="log-card">
            <div class="log-card-left">
              <span class="log-filename">${esc(b.filename)}</span>
              ${b.client_name ? `<span class="log-client">${esc(b.client_name)}</span>` : ''}
              <span class="log-date">${date}${b.uploaded_by ? ` &nbsp;·&nbsp; <strong>${esc(b.uploaded_by)}</strong>` : ''}</span>
              <div class="log-chips">
                <span class="chip">${b.order_count} orders</span>
                <span class="chip">${b.row_count} lines</span>
                ${done   ? `<span class="chip chip-done">${done} done</span>` : ''}
                ${inprog ? `<span class="chip chip-inprog">${inprog} in progress</span>` : ''}
                ${unproc ? `<span class="chip chip-unproc">${unproc} unprocessed</span>` : ''}
              </div>
            </div>
            <div class="log-card-actions">
              <a class="btn-download" href="/api/download-wms/${esc(b.id)}" download>&#8681; WMS</a>
              <button class="btn-del-batch" data-id="${esc(b.id)}" data-name="${esc(b.filename)}" title="Delete entire batch">&#128465; Delete Batch</button>
            </div>
          </div>`;
      }).join('');

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
      const resp = await fetch('/api/orders');
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
  let cameraScanMode  = 'single'; // 'single' | 'batch'
  const batchMap      = new Map(); // rawValue → { checked: bool }
  const lastSingleHit = {};        // rawValue → timestamp (cooldown)
  const SINGLE_COOLDOWN_MS = 1800;

  document.getElementById('openCameraBtn').addEventListener('click', openCameraScanner);
  document.getElementById('closeCameraBtn').addEventListener('click', closeCameraScanner);
  document.getElementById('cmodeSingle').addEventListener('click', () => setCameraMode('single'));
  document.getElementById('cmodeBatch').addEventListener('click',  () => setCameraMode('batch'));
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
    document.getElementById('cameraBatchPanel').classList.toggle('hidden', mode === 'single');
    document.getElementById('cameraSingleHint').classList.toggle('hidden', mode === 'batch');
    document.getElementById('cameraSingleResult').classList.add('hidden');
    if (mode === 'batch') { batchMap.clear(); renderBatchChips(); }
  }

  async function openCameraScanner() {
    document.getElementById('cameraScanOverlay').classList.remove('hidden');
    document.getElementById('cameraNoSupport').classList.add('hidden');
    document.getElementById('cameraViewfinderWrap').classList.remove('hidden');

    if (!('BarcodeDetector' in window)) {
      document.getElementById('cameraViewfinderWrap').classList.add('hidden');
      document.getElementById('cameraBatchPanel').classList.add('hidden');
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

  // ── Init ───────────────────────────────────────────────────────────────────
  initLogin();
})();
