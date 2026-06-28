(() => {
  // ── State ──────────────────────────────────────────────────────────────────
  let SESSION_ID   = sessionStorage.getItem('wms_session') || '';
  let loadedOrders = [];
  let activeOrder  = null;
  let currentUser  = null;
  let timerInterval = null;
  let activeClientFilter  = 'all';
  let activeCarrierFilter = 'all';
  let printWaybillTimer   = null;
  let pendingOrderFile    = null;
  let logUnlocked         = false;

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

  // ── Login ──────────────────────────────────────────────────────────────────
  function initLogin() {
    const stored = localStorage.getItem('wms_user');
    if (stored) {
      currentUser = JSON.parse(stored);
      showUserInHeader();
      fetchAndRenderStats();
    } else {
      document.getElementById('loginOverlay').classList.remove('hidden');
    }
  }

  function showUserInHeader() {
    document.getElementById('loginOverlay').classList.add('hidden');
    if (!currentUser) return;
    const chip = document.getElementById('userDisplay');
    chip.textContent = `${currentUser.name} ···${currentUser.icLast4}`;
    chip.classList.remove('hidden');
    document.getElementById('lockBtn').classList.remove('hidden');
  }

  document.getElementById('loginName').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('loginIC').focus();
  });
  document.getElementById('loginIC').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
  document.getElementById('loginBtn').addEventListener('click', doLogin);

  function doLogin() {
    const name  = document.getElementById('loginName').value.trim();
    const ic    = document.getElementById('loginIC').value.trim();
    const errEl = document.getElementById('loginError');
    if (!name) {
      errEl.textContent = 'Please enter your name.';
      errEl.classList.remove('hidden'); return;
    }
    if (!/^\d{4}$/.test(ic)) {
      errEl.textContent = 'Enter exactly 4 digits for IC / FIN.';
      errEl.classList.remove('hidden'); return;
    }
    errEl.classList.add('hidden');
    currentUser = { name, icLast4: ic };
    localStorage.setItem('wms_user', JSON.stringify(currentUser));
    showUserInHeader();
    fetchAndRenderStats();
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
      localStorage.removeItem('wms_user');
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
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${name}`).classList.add('active');
    document.querySelector(`.tab-btn[data-tab="${name}"]`).classList.add('active');
    if (name === 'upload') fetchAndRenderStats();
    if (name === 'orders') renderOrdersDash();
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
    } catch {}
  }

  document.getElementById('refreshStatsBtn').addEventListener('click', fetchAndRenderStats);

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
    const clientName = document.getElementById('clientNameInput').value.trim();
    document.getElementById('confirmFileName').textContent    = filename;
    document.getElementById('confirmClientName').textContent  = clientName || '(not specified)';
    document.getElementById('confirmOrderCount').textContent  = preview.orderCount;
    document.getElementById('confirmLineCount').textContent   = preview.rowCount;
    document.getElementById('confirmConverted').innerHTML     = preview.converted
      ? '<span style="color:var(--success)">&#10003; Converted to WMS format</span>'
      : '<span style="color:var(--danger)">&#10007; Conversion failed</span>';

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
    document.getElementById('confirmEmail').value = '';
    document.getElementById('uploadConfirmOverlay').classList.remove('hidden');
    setTimeout(() => document.getElementById('confirmEmail').focus(), 150);
  }

  document.getElementById('confirmCancelBtn').addEventListener('click', () => {
    document.getElementById('uploadConfirmOverlay').classList.add('hidden');
    pendingOrderFile = null;
    fileInput.value = '';
  });

  document.getElementById('confirmEmail').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('confirmApproveBtn').click();
  });

  document.getElementById('confirmApproveBtn').addEventListener('click', async () => {
    const email  = document.getElementById('confirmEmail').value.trim();
    const errEl  = document.getElementById('confirmEmailError');
    if (!email) {
      errEl.textContent = 'Please enter an email address.';
      errEl.classList.remove('hidden'); return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errEl.textContent = 'Please enter a valid email address.';
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

    try {
      const resp = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-session-id': SESSION_ID },
        body: form,
      });
      const data = await resp.json();
      document.getElementById('uploadConfirmOverlay').classList.add('hidden');

      if (!resp.ok) {
        setUploadStatus('error', data.error || 'Upload failed');
        return;
      }
      SESSION_ID = data.sessionId;
      sessionStorage.setItem('wms_session', SESSION_ID);
      loadedOrders = data.orders;
      activeOrder  = null;

      const pdfMsg = pdfFile ? ' Waybill PDF is being split in the background.' : '';
      setUploadStatus('success',
        `Loaded ${data.rowCount} line(s) across ${data.orders.length} order(s) from "${file.name}". WMS file emailed to ${emailTo}.${pdfMsg}`
      );
      renderUploadList(data.orders);
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

  function renderOrdersList() {
    let orders = loadedOrders;
    if (activeClientFilter  !== 'all') orders = orders.filter(o => (o.client_name || '') === activeClientFilter);
    if (activeCarrierFilter !== 'all') orders = orders.filter(o => (o.carrier || '') === activeCarrierFilter);

    const sortPriority = { processing: 0, pending: 1, unprocessed: 2, done: 3 };
    orders = [...orders].sort((a, b) =>
      (sortPriority[a.scan_status] ?? 4) - (sortPriority[b.scan_status] ?? 4)
    );
    const labels = { pending: 'Pending', processing: 'In Progress', done: 'Done', unprocessed: 'Unprocessed' };

    document.getElementById('ordersDashList').innerHTML = orders.length ? orders.map(ord => {
      const scannedTotal = Object.values(ord.scanned || {}).reduce((s, v) => s + v, 0);
      const canScan = ord.scan_status !== 'done';
      return `
        <div class="dash-order-card status-${ord.scan_status}" data-order="${esc(ord.order_number)}">
          <div class="dash-order-left">
            <span class="dash-order-no">${esc(ord.order_number)}</span>
            ${ord.client_name ? `<span class="dash-order-client">${esc(ord.client_name)}</span>` : ''}
            <span class="dash-order-customer">${esc(ord.customer_name || '')}</span>
            ${ord.waybill_number ? `<span class="dash-order-waybill">${esc(ord.waybill_number)}</span>` : ''}
          </div>
          <div class="dash-order-right">
            ${ord.carrier ? `<span class="chip chip-carrier">${esc(ord.carrier)}</span>` : ''}
            <span class="status-badge ${ord.scan_status}">${labels[ord.scan_status] || ord.scan_status}</span>
            <span class="dash-order-prog">${scannedTotal}/${ord.total_qty}</span>
            ${canScan ? `<button class="btn-scan-now" data-order="${esc(ord.order_number)}">Scan &#8594;</button>` : ''}
            ${ord.has_waybill_pdf && ord.batchId ? `<a class="btn-waybill-pdf" href="/api/waybill-pdf/${esc(ord.batchId)}/${esc(ord.order_number)}" target="_blank" title="Open waybill PDF">&#128196;</a>` : ''}
          </div>
        </div>`;
    }).join('') : '<p class="empty-state" style="padding:1.5rem">No orders match the selected filters.</p>';

    document.querySelectorAll('.btn-scan-now').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); openScanOverlay(btn.dataset.order); })
    );
    document.querySelectorAll('.dash-order-card').forEach(card =>
      card.addEventListener('click', () => {
        const ord = loadedOrders.find(o => o.order_number === card.dataset.order);
        if (ord && ord.scan_status !== 'done') openScanOverlay(card.dataset.order);
      })
    );
  }

  // ── Scan Overlay ───────────────────────────────────────────────────────────
  function openScanOverlay(orderNumber) {
    const ord = loadedOrders.find(o => o.order_number === orderNumber);
    if (!ord) return;
    activeOrder = ord;
    enterItemsPhase(ord);
    document.getElementById('scanOverlay').classList.remove('hidden');
    document.body.classList.add('scan-open');
  }

  function closeScanOverlay() {
    document.getElementById('scanOverlay').classList.add('hidden');
    document.body.classList.remove('scan-open');
    stopTimer();
    activeOrder = null;
  }

  document.getElementById('backToOrdersBtn').addEventListener('click', pauseAndGoToOrders);
  document.getElementById('pauseOrderBtn').addEventListener('click', pauseAndGoToOrders);

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
    activeOrder = order;
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
      </span>`;

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

  // ── Item barcode scan ──────────────────────────────────────────────────────
  document.getElementById('itemScanInput').addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    const val = e.target.value.trim();
    e.target.value = '';
    if (val && activeOrder) await handleItemScan(val);
  });

  async function handleItemScan(sku) {
    const feedback = document.getElementById('itemScanFeedback');
    try {
      const resp = await fetch('/api/scan/increment', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ orderNumber: activeOrder.order_number, sku }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        showFeedback(feedback, 'error', data.error || `SKU not in this order: ${sku}`);
        return;
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
      showFeedback(feedback, 'error', err.message);
    }
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
          operator:    currentUser ? `${currentUser.name} (···${currentUser.icLast4})` : null,
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
          operator:    currentUser ? `${currentUser.name} (···${currentUser.icLast4})` : null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) { alert(data.error); return; }
      delete orderTimings[activeOrder.order_number];
      saveTimings();
      mergeOrderState(activeOrder.order_number, 'unprocessed', {});
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
    await renderLogContent();
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
              <span class="log-date">${date}</span>
              <div class="log-chips">
                <span class="chip">${b.order_count} orders</span>
                <span class="chip">${b.row_count} lines</span>
                ${done   ? `<span class="chip chip-done">${done} done</span>` : ''}
                ${inprog ? `<span class="chip chip-inprog">${inprog} in progress</span>` : ''}
                ${unproc ? `<span class="chip chip-unproc">${unproc} unprocessed</span>` : ''}
              </div>
            </div>
            <a class="btn-download" href="/api/download-wms/${esc(b.id)}" download>&#8681; WMS</a>
          </div>`;
      }).join('');
    } catch (err) {
      listEl.innerHTML = `<p class="scan-error" style="padding:.5rem 0">${esc(err.message)}</p>`;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function refreshOrders() {
    if (!SESSION_ID) return;
    try {
      const resp = await fetch('/api/orders', { headers: { 'x-session-id': SESSION_ID } });
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

  // ── Init ───────────────────────────────────────────────────────────────────
  initLogin();
})();
