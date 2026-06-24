(() => {
  // ── Session persistence ──
  let SESSION_ID = sessionStorage.getItem('wms_session') || '';
  let loadedOrders = [];

  function sessionHeaders() {
    return { 'x-session-id': SESSION_ID, 'Content-Type': 'application/json' };
  }

  // ── Tab switching ──
  document.querySelectorAll('.tab-btn, [data-tab-link]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab || btn.dataset.tabLink;
      switchTab(target);
    });
  });

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${name}`).classList.add('active');
    document.querySelector(`.tab-btn[data-tab="${name}"]`).classList.add('active');
    if (name === 'wms') renderWmsTab();
    if (name === 'scan') renderScanTab();
  }

  // ── Upload tab ──
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  const uploadStatus = document.getElementById('uploadStatus');

  browseBtn.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) uploadFile(fileInput.files[0]);
  });

  document.getElementById('goWmsBtn').addEventListener('click', () => switchTab('wms'));
  document.getElementById('goScanBtn').addEventListener('click', () => switchTab('scan'));
  document.getElementById('downloadSampleBtn').addEventListener('click', downloadSample);

  async function uploadFile(file) {
    setStatus('loading', `Uploading ${file.name}...`);
    const form = new FormData();
    form.append('orderFile', file);

    try {
      const resp = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-session-id': SESSION_ID },
        body: form,
      });
      const data = await resp.json();
      if (!resp.ok) { setStatus('error', data.error || 'Upload failed'); return; }

      SESSION_ID = data.sessionId;
      sessionStorage.setItem('wms_session', SESSION_ID);
      loadedOrders = data.orders;

      setStatus('success', `Loaded ${data.rowCount} line(s) across ${data.orders.length} order(s) from ${file.name}`);
      renderOrdersTable(data.orders);
    } catch (err) {
      setStatus('error', err.message);
    }
  }

  function setStatus(type, msg) {
    uploadStatus.className = `status-bar ${type}`;
    uploadStatus.textContent = msg;
    uploadStatus.classList.remove('hidden');
  }

  function renderOrdersTable(orders) {
    const section = document.getElementById('ordersSection');
    section.classList.remove('hidden');
    document.getElementById('orderCount').textContent = orders.length;

    const container = document.getElementById('ordersTable');
    container.innerHTML = orders.map(ord => `
      <div class="order-card">
        <div class="order-card-header">
          <span class="order-no">${esc(ord.order_number)}</span>
          <div class="order-meta-chips">
            ${ord.customer_name ? `<span class="chip">${esc(ord.customer_name)}</span>` : ''}
            ${ord.waybill_number ? `<span class="chip waybill">WB: ${esc(ord.waybill_number)}</span>` : ''}
            ${ord.carrier ? `<span class="chip">${esc(ord.carrier)}</span>` : ''}
            <span class="chip">${ord.total_qty} unit${ord.total_qty !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>SKU</th><th>Description</th><th>Qty</th><th>UOM</th></tr></thead>
            <tbody>
              ${ord.lines.map(l => `
                <tr>
                  <td><code>${esc(l.sku)}</code></td>
                  <td>${esc(l.description)}</td>
                  <td>${l.qty}</td>
                  <td>${esc(l.uom)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`).join('');
  }

  // ── WMS tab ──
  function renderWmsTab() {
    if (!loadedOrders.length) { refreshOrdersFromServer().then(renderWmsTab); return; }
    document.getElementById('wmsNoOrders').classList.add('hidden');
    const content = document.getElementById('wmsContent');
    content.classList.remove('hidden');

    const totalLines = loadedOrders.reduce((s, o) => s + o.lines.length, 0);
    const totalQty = loadedOrders.reduce((s, o) => s + o.total_qty, 0);
    document.getElementById('wmsSummary').innerHTML = `
      <div class="stat-box"><div class="val">${loadedOrders.length}</div><div class="lbl">Orders</div></div>
      <div class="stat-box"><div class="val">${totalLines}</div><div class="lbl">Lines</div></div>
      <div class="stat-box"><div class="val">${totalQty}</div><div class="lbl">Total Units</div></div>`;

    // Preview first 5 orders
    const preview = loadedOrders.slice(0, 5);
    let rows = '';
    let wmsCtr = 1;
    for (const ord of preview) {
      let lineNo = 1;
      const wmsNo = `WMS-${String(wmsCtr++).padStart(6, '0')}`;
      for (const item of ord.lines) {
        rows += `<tr>
          <td><code>${wmsNo}</code></td>
          <td>${esc(ord.order_number)}</td>
          <td>${esc(ord.required_date || '—')}</td>
          <td>${esc(ord.customer_name || '—')}</td>
          <td>${esc(ord.carrier || '—')}</td>
          <td>${esc(ord.waybill_number || '—')}</td>
          <td>${lineNo++}</td>
          <td><code>${esc(item.sku)}</code></td>
          <td>${esc(item.description)}</td>
          <td>${item.qty}</td>
          <td>${esc(item.uom)}</td>
          <td><span class="chip">PENDING</span></td>
        </tr>`;
      }
    }
    const more = loadedOrders.length > 5 ? `<tr><td colspan="12" style="text-align:center;color:var(--text-light);padding:.75rem">… and ${loadedOrders.length - 5} more orders</td></tr>` : '';

    document.getElementById('wmsPreviewTable').innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>WMS Order #</th><th>Client Order #</th><th>Req. Date</th>
            <th>Customer</th><th>Carrier</th><th>Waybill</th>
            <th>Line</th><th>SKU</th><th>Description</th><th>Qty</th><th>UOM</th><th>Status</th>
          </tr></thead>
          <tbody>${rows}${more}</tbody>
        </table>
      </div>`;
  }

  document.getElementById('downloadWmsBtn').addEventListener('click', async () => {
    if (!SESSION_ID) return;
    await downloadFile('/api/wms-export', 'wms_picklist.csv');
  });

  // ── Scan tab ──
  function renderScanTab() {
    if (!loadedOrders.length) { refreshOrdersFromServer().then(renderScanTab); return; }
    document.getElementById('scanNoOrders').classList.add('hidden');
    document.getElementById('scanContent').classList.remove('hidden');

    const sel = document.getElementById('orderSelect');
    sel.innerHTML = loadedOrders.map(o =>
      `<option value="${esc(o.order_number)}">${esc(o.order_number)} — ${esc(o.customer_name || '')} (${o.total_qty} units)</option>`
    ).join('');
    loadScanOrder(loadedOrders[0]);
  }

  document.getElementById('orderSelect').addEventListener('change', e => {
    const ord = loadedOrders.find(o => o.order_number === e.target.value);
    if (ord) loadScanOrder(ord);
  });

  function loadScanOrder(ord) {
    document.getElementById('scanOrderCard').classList.remove('hidden');
    document.getElementById('verifyResult').classList.add('hidden');

    document.getElementById('scanOrderMeta').innerHTML = `
      <dt>Order #</dt><dd>${esc(ord.order_number)}</dd>
      <dt>Customer</dt><dd>${esc(ord.customer_name || '—')}</dd>
      <dt>Ship To</dt><dd>${esc(ord.ship_to_address || '—')}</dd>
      <dt>Carrier</dt><dd>${esc(ord.carrier || '—')}</dd>
      <dt>Req. Date</dt><dd>${esc(ord.required_date || '—')}</dd>
      <dt>Waybill</dt><dd>${ord.waybill_number ? `<span class="badge-ok">${esc(ord.waybill_number)}</span>` : '<span class="badge-short">Not provided</span>'}</dd>`;

    document.getElementById('waybillInput').value = ord.waybill_number || '';

    const tbody = document.getElementById('scanTableBody');
    tbody.innerHTML = ord.lines.map(item => `
      <tr data-sku="${esc(item.sku)}">
        <td><code>${esc(item.sku)}</code></td>
        <td>${esc(item.description)}</td>
        <td>${item.qty}</td>
        <td><input type="number" class="picked-qty" min="0" value="${item.qty}" data-ordered="${item.qty}" /></td>
        <td class="line-status"><span class="badge-ok">OK</span></td>
      </tr>`).join('');

    // Live status update as user types
    tbody.querySelectorAll('.picked-qty').forEach(inp => {
      inp.addEventListener('input', updateLineStatus);
    });
  }

  function updateLineStatus(e) {
    const inp = e.target;
    const ordered = parseInt(inp.dataset.ordered, 10);
    const picked = parseInt(inp.value, 10) || 0;
    const cell = inp.closest('tr').querySelector('.line-status');
    if (picked === ordered) cell.innerHTML = '<span class="badge-ok">OK</span>';
    else if (picked < ordered) cell.innerHTML = `<span class="badge-short">SHORT (${ordered - picked})</span>`;
    else cell.innerHTML = `<span class="badge-over">OVER (+${picked - ordered})</span>`;
  }

  document.getElementById('verifyBtn').addEventListener('click', async () => {
    const orderNumber = document.getElementById('orderSelect').value;
    const waybill = document.getElementById('waybillInput').value.trim();

    const scannedItems = [];
    document.querySelectorAll('#scanTableBody tr').forEach(row => {
      const sku = row.dataset.sku;
      const qty = parseInt(row.querySelector('.picked-qty').value, 10) || 0;
      scannedItems.push({ sku, qty });
    });

    const body = { orderNumber, waybill, scannedItems };
    try {
      const resp = await fetch('/api/verify', {
        method: 'POST',
        headers: sessionHeaders(),
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) { alert(data.error); return; }
      renderVerifyResult(data, waybill);
    } catch (err) {
      alert(err.message);
    }
  });

  function renderVerifyResult(data, enteredWaybill) {
    const div = document.getElementById('verifyResult');
    const isReady = data.overall_status === 'READY_TO_SHIP';
    div.className = isReady ? 'ready' : 'review';

    const waybillOk = enteredWaybill && data.waybill_number &&
      enteredWaybill.trim().toLowerCase() === data.waybill_number.trim().toLowerCase();

    div.innerHTML = `
      <div class="result-title ${isReady ? 'badge-ready' : 'badge-review'}">
        ${isReady ? '&#10003; READY TO SHIP' : '&#9888; NEEDS REVIEW'}
      </div>
      <dl class="result-grid">
        <dt>Order #</dt><dd>${esc(data.order_number)}</dd>
        <dt>Customer</dt><dd>${esc(data.customer_name)}</dd>
        <dt>Expected Waybill</dt><dd>${esc(data.waybill_number || 'None')}</dd>
        <dt>Scanned Waybill</dt><dd class="${waybillOk ? 'badge-ok' : 'badge-short'}">${esc(enteredWaybill || 'Not entered')} ${waybillOk ? '&#10003;' : '&#10007;'}</dd>
      </dl>
      <div class="table-wrap">
        <table>
          <thead><tr><th>SKU</th><th>Description</th><th>Ordered</th><th>Picked</th><th>Result</th></tr></thead>
          <tbody>
            ${data.lines.map(l => `<tr>
              <td><code>${esc(l.sku)}</code></td>
              <td>${esc(l.description)}</td>
              <td>${l.qty_ordered}</td>
              <td>${l.qty_picked}</td>
              <td class="badge-${l.status.toLowerCase()}">${l.status}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    div.classList.remove('hidden');
  }

  document.getElementById('downloadScanBtn').addEventListener('click', async () => {
    if (!SESSION_ID) return;
    await downloadFile('/api/scan-sheet', 'order_scan_sheet.csv');
  });

  // ── Helpers ──
  async function refreshOrdersFromServer() {
    if (!SESSION_ID) return;
    try {
      const resp = await fetch('/api/orders', { headers: { 'x-session-id': SESSION_ID } });
      loadedOrders = await resp.json();
    } catch (_) {}
  }

  async function downloadFile(url, filename) {
    const resp = await fetch(url, { headers: { 'x-session-id': SESSION_ID } });
    if (!resp.ok) { const d = await resp.json(); alert(d.error || 'Error generating file'); return; }
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function downloadSample() {
    const csv = [
      'order_number,customer_name,sku,product_name,quantity,uom,ship_to_address,ship_to_city,ship_to_state,ship_to_zip,waybill_number,carrier,required_date',
      'ORD-001,John Smith,SKU-A123,Blue Widget,2,EA,123 Main St,New York,NY,10001,WB123456789,FedEx,2026-06-25',
      'ORD-001,John Smith,SKU-B456,Red Gadget,1,EA,123 Main St,New York,NY,10001,WB123456789,FedEx,2026-06-25',
      'ORD-002,Jane Doe,SKU-C789,Green Tool,3,EA,456 Oak Ave,Los Angeles,CA,90001,WB987654321,UPS,2026-06-26',
      'ORD-003,Acme Corp,SKU-D012,Widget Pro,5,EA,789 Elm Rd,Chicago,IL,60601,WB555000111,DHL,2026-06-26',
      'ORD-003,Acme Corp,SKU-E345,Adapter Kit,2,EA,789 Elm Rd,Chicago,IL,60601,WB555000111,DHL,2026-06-26',
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sample_orders.csv';
    a.click();
  }
})();
