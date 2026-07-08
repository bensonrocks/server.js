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
    document.querySelectorAll('.tab-btn[data-tab="upload"]').forEach(b => b.classList.toggle('hidden', isWarehouse));

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
      loadLabelMiniHistory();
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
  const TAB_TITLES = { upload: 'Upload', orders: 'Orders', labels: 'Labels', about: 'About' };
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => { switchTab(btn.dataset.tab); closeSidebar(); })
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
    if (name === 'upload') { fetchAndRenderStats(); renderBreakdowns(loadedOrders); loadLabelMiniHistory(); }
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
      const { matched, pageCount } = data;
      const unmatched = pageCount - matched;
      statusEl.className = 'status-bar success';
      statusEl.textContent = `${pageCount} pages imported — ${matched} matched${unmatched ? `, ${unmatched} unmatched` : ''}.`;
      document.getElementById('labelImportUploadName').textContent = '';
      labelImportInputUpload.value = '';
      await loadLabelMiniHistory();
      if (unmatched > 0 && data.importId) {
        if (confirm(`${unmatched} page(s) could not be auto-matched. Open Review to assign manually?`))
          openLabelReview(data.importId);
      }
    } catch (err) {
      statusEl.className = 'status-bar error';
      statusEl.textContent = err.message;
    }
  }

  async function loadLabelMiniHistory() {
    const wrap   = document.getElementById('labelMiniHistory');
    const listEl = document.getElementById('labelMiniHistoryList');
    if (!wrap || !listEl) return;
    try {
      const resp = await fetch('/api/label-imports');
      if (!resp.ok) return;
      const imports = await resp.json();
      if (!imports.length) { wrap.style.display = 'none'; return; }
      wrap.style.display = '';
      listEl.innerHTML = imports.slice(0, 5).map(imp => {
        const hasUnmatched = imp.unmatched > 0;
        return `<div class="label-mini-item">
          <span class="label-mini-item-name">&#127991; ${esc(imp.filename)}</span>
          <span class="label-mini-item-badges">
            ${imp.matched   ? `<span class="lhi-badge lhi-matched">${imp.matched} matched</span>` : ''}
            ${imp.unmatched ? `<span class="lhi-badge lhi-unmatched">${imp.unmatched} unmatched</span>` : ''}
            ${hasUnmatched  ? `<button class="btn-primary btn-sm lhi-automatch-btn" data-import-id="${esc(imp.id)}">&#9889; Auto Match</button>` : ''}
            <button class="btn-ghost btn-sm lmi-review-btn" data-import-id="${esc(imp.id)}">Review ›</button>
          </span>
        </div>`;
      }).join('');
      listEl.querySelectorAll('.lhi-automatch-btn').forEach(btn =>
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          btn.disabled = true; btn.textContent = 'Matching…';
          try {
            const r = await fetch(`/api/label-imports/${btn.dataset.importId}/rematch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error);
            await refreshOrders();
            await loadLabelMiniHistory();
          } catch (err) { alert(err.message); }
        })
      );
      listEl.querySelectorAll('.lmi-review-btn').forEach(btn =>
        btn.addEventListener('click', () => openLabelReview(btn.dataset.importId))
      );
    } catch {}
  }

  document.getElementById('labelMiniRefreshBtn')?.addEventListener('click', loadLabelMiniHistory);

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
      const _dlUrl  = `/api/download-wms/${data.batchId}`;
      const _dlName = `WMS_${file.name.replace(/\.[^.]+$/, '')}_${new Date().toISOString().slice(0,10)}.xlsx`;
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
    const val = e.target.value.trim();
    if (!val) return;
    e.target.value = '';

    // Priority 1: direct order number match (client-side, instant)
    const valLower = val.toLowerCase();
    const directMatch = loadedOrders.find(o => o.order_number.trim().toLowerCase() === valLower);
    if (directMatch) {
      if (directMatch.scan_status === 'done') { setWaybillMsg('Order already completed.', true); return; }
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
      const ord = loadedOrders.find(o => o.order_number === data.order_number);
      if (!ord) { setWaybillMsg('Order not in current batch.', true); return; }
      if (ord.scan_status === 'done') { setWaybillMsg('Order already completed.', true); return; }
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

    if (!orders.length) {
      document.getElementById('ordersDashList').innerHTML = '<p class="empty-state" style="padding:2rem">No orders match the selected filters.</p>';
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
        ord.has_order_label  ? `<span class="chip chip-label">&#127991; Label</span>` : '',
        ord.has_waybill_pdf  ? `<span class="chip chip-waybill">&#128196; Waybill</span>` : '',
      ].filter(Boolean).join('');

      // Date
      const dateStr = ord.uploadedAt ? new Date(ord.uploadedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';

      return `<tr class="orders-tr status-${ord.scan_status}${isDone && !ord.keyfields_closed && isAdminView ? ' kf-pending' : ''}" data-order="${esc(ord.order_number)}">
        <td class="ord-stripe-cell"></td>
        <td class="col-order">
          <span class="ord-no-link">${esc(ord.order_number)}</span>
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
          ${emailIndicator}
          ${kfBtn}
          ${logUnlocked ? `<button class="btn-del-order" data-order="${esc(ord.order_number)}" data-batchid="${esc(ord.batchId || '')}" title="Delete">&#128465;</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    document.getElementById('ordersDashList').innerHTML = `
      <div class="orders-table-wrap">
        <table class="orders-table">
          <thead>
            <tr>
              <th style="width:4px;padding:0"></th>
              <th>ORDER NO</th>
              <th class="col-client">CLIENT</th>
              <th class="col-customer">CUSTOMER</th>
              <th class="col-waybill">WAYBILL</th>
              <th>ITEMS</th>
              <th class="col-status">STATUS</th>
              <th class="col-date">DATE</th>
              <th class="col-actions">ACTIONS</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

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
  function openScanOverlay(orderNumber) {
    if (!currentUser) { requireLogin(() => openScanOverlay(orderNumber)); return; }
    const ord = loadedOrders.find(o => o.order_number === orderNumber);
    if (!ord) return;
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
      <span class="${order.has_waybill_pdf ? 'waybill-ok' : ''}">
        <strong>Waybill:</strong>
        ${order.waybill_number
          ? `${esc(order.waybill_number)}${order.has_waybill_pdf ? ' &#10003;' : ''}`
          : 'Not provided'}
      </span>
      ${order.tel ? `<span><strong>Tel:</strong> ${esc(order.tel)}</span>` : ''}
      ${order.delivery_address ? `<span class="scan-meta-address"><strong>Address:</strong> ${esc(order.delivery_address)}</span>` : ''}
      ${order.platform ? `<span><strong>Platform:</strong> ${esc(order.platform)}${order.shop_name ? ' / ' + esc(order.shop_name) : ''}</span>` : ''}
      ${order.has_waybill_pdf ? `<span class="meta-waybill-note">&#128196; Waybill PDF ready to print</span>` : ''}`;

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

      const lotParts = [];
      if (item.batch_number)  lotParts.push(`<span class="lot-badge lot-batch">Lot&nbsp;${esc(item.batch_number)}</span>`);
      if (item.serial_number) lotParts.push(`<span class="lot-badge lot-serial">S/N&nbsp;${esc(item.serial_number)}</span>`);
      if (item.expiry_date)   lotParts.push(`<span class="lot-badge lot-expiry">Exp&nbsp;${esc(item.expiry_date)}</span>`);
      const lotRow = lotParts.length
        ? `<tr class="lot-info-row"><td colspan="5" class="lot-info-cell">${lotParts.join('')}</td></tr>`
        : '';

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
        </tr>${lotRow}`;
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
    // Never intercept while any modal dialog is visible
    if (document.querySelector('.modal-overlay:not(.hidden)')) return;

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
  async function doCompleteOrder() {
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

  document.getElementById('completeOrderBtn').addEventListener('click', async () => {
    if (!activeOrder) return;
    const lotLines = (activeOrder.lines || []).filter(l => l.batch_number || l.serial_number || l.expiry_date);
    if (lotLines.length > 0) {
      showLotCheckModal(lotLines, doCompleteOrder);
      return;
    }
    await doCompleteOrder();
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
              <a class="btn-download" data-auth-dl="/api/download-wms/${esc(b.id)}" data-auth-dl-name="WMS_${esc(b.filename || b.id)}.xlsx">&#8681; WMS</a>
              <button class="btn-attach-waybill" data-id="${esc(b.id)}" data-count="${b.order_count}" title="Upload waybill PDF for this batch">&#128196; Waybill PDF</button>
              <button class="btn-del-batch" data-id="${esc(b.id)}" data-name="${esc(b.filename)}" title="Delete entire batch">&#128465; Delete Batch</button>
            </div>
          </div>`;
      }).join('');

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
  });

  document.getElementById('printLabelNowBtn').addEventListener('click', () => {
    const orderNo = document.getElementById('printLabelOrderNo').textContent;
    const token   = localStorage.getItem('wms_token') || '';
    window.open(`/api/order-label/${encodeURIComponent(orderNo)}/pdf?token=${encodeURIComponent(token)}`, '_blank');
    document.getElementById('printOrderLabelOverlay').classList.add('hidden');
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
        btn.disabled = true; btn.textContent = 'Matching…';
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
        return `
          <div class="lri-row" data-page="${i}">
            <div class="lri-thumb-col">
              <div class="lri-page-num">Page ${i + 1}</div>
              <iframe class="lri-pdf-preview" src="${pdfUrl}" title="Label page ${i + 1}"></iframe>
            </div>
            <div class="lri-info-col">
              <div class="lri-status-row">
                <span class="lri-badge ${statusCls}">${page.matchStatus}</span>
                ${page.matchMethod ? `<span class="lri-method">via ${page.matchMethod.replace('_', ' ')}</span>` : ''}
              </div>
              <div class="lri-fields">${fields || '<span class="hint">No fields extracted</span>'}</div>
              <div class="lri-match-action">${matchAction}</div>
            </div>
          </div>`;
      }).join('');

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
