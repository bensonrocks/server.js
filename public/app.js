(() => {
  let SESSION_ID = sessionStorage.getItem('wms_session') || '';
  let loadedOrders = [];  // each has scan_status + scanned{}
  let activeOrder = null; // order currently being scanned

  function hdrs() {
    return { 'x-session-id': SESSION_ID, 'Content-Type': 'application/json' };
  }
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

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
    if (name === 'orders')  renderOrdersDash();
    if (name === 'scanner') renderScannerTab();
  }

  // ── Upload tab ─────────────────────────────────────────────────────────────

  const dropZone  = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');

  document.getElementById('browseBtn').addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); });
  document.getElementById('goScannerBtn').addEventListener('click', () => switchTab('scanner'));

  async function uploadFile(file) {
    setUploadStatus('loading', `Uploading ${file.name}…`);
    const form = new FormData();
    form.append('orderFile', file);
    try {
      const resp = await fetch('/api/upload', { method: 'POST', headers: { 'x-session-id': SESSION_ID }, body: form });
      const data = await resp.json();
      if (!resp.ok) { setUploadStatus('error', data.error || 'Upload failed'); return; }
      SESSION_ID = data.sessionId;
      sessionStorage.setItem('wms_session', SESSION_ID);
      loadedOrders = data.orders;
      activeOrder = null;
      setUploadStatus('success', `Loaded ${data.rowCount} line(s) across ${data.orders.length} order(s) from "${file.name}"`);
      renderUploadList(data.orders);
    } catch (err) {
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
            ${ord.customer_name ? `<span class="chip">${esc(ord.customer_name)}</span>` : ''}
            ${ord.waybill_number ? `<span class="chip waybill">${esc(ord.waybill_number)}</span>` : ''}
            ${ord.carrier ? `<span class="chip">${esc(ord.carrier)}</span>` : ''}
            <span class="chip">${ord.total_qty} unit${ord.total_qty !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>SKU</th><th>Description</th><th>Qty</th><th>UOM</th></tr></thead>
            <tbody>
              ${ord.lines.map(l => `<tr>
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
      <div class="stat-box">
        <div class="val">${loadedOrders.length}</div><div class="lbl">Total</div>
      </div>
      <div class="stat-box pending">
        <div class="val">${c.pending || 0}</div><div class="lbl">Pending</div>
      </div>
      <div class="stat-box processing">
        <div class="val">${c.processing || 0}</div><div class="lbl">In Progress</div>
      </div>
      <div class="stat-box done">
        <div class="val">${c.done || 0}</div><div class="lbl">Done</div>
      </div>
      <div class="stat-box unprocessed">
        <div class="val">${c.unprocessed || 0}</div><div class="lbl">Unprocessed</div>
      </div>`;

    const sortPriority = { processing: 0, pending: 1, unprocessed: 2, done: 3 };
    const sorted = [...loadedOrders].sort((a, b) =>
      (sortPriority[a.scan_status] ?? 4) - (sortPriority[b.scan_status] ?? 4)
    );

    const labels = { pending: 'Pending', processing: 'In Progress', done: 'Done', unprocessed: 'Unprocessed' };

    document.getElementById('ordersDashList').innerHTML = sorted.map(ord => {
      const scannedTotal = Object.values(ord.scanned || {}).reduce((s, v) => s + v, 0);
      const canScan = ord.scan_status !== 'done';
      return `
        <div class="dash-order-card status-${ord.scan_status}" data-order="${esc(ord.order_number)}">
          <div class="dash-order-left">
            <span class="dash-order-no">${esc(ord.order_number)}</span>
            <span class="dash-order-customer">${esc(ord.customer_name || '')}</span>
            ${ord.waybill_number ? `<span class="dash-order-waybill">${esc(ord.waybill_number)}</span>` : ''}
          </div>
          <div class="dash-order-right">
            <span class="status-badge ${ord.scan_status}">${labels[ord.scan_status] || ord.scan_status}</span>
            <span class="dash-order-prog">${scannedTotal}/${ord.total_qty} scanned</span>
            ${canScan ? `<button class="btn-scan-now" data-order="${esc(ord.order_number)}">Scan →</button>` : ''}
          </div>
        </div>`;
    }).join('');

    document.querySelectorAll('.btn-scan-now').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); goToScanner(btn.dataset.order); })
    );
    document.querySelectorAll('.dash-order-card').forEach(card =>
      card.addEventListener('click', () => goToScanner(card.dataset.order))
    );
  }

  function goToScanner(orderNumber) {
    const ord = loadedOrders.find(o => o.order_number === orderNumber);
    if (ord) activeOrder = ord;
    switchTab('scanner');
  }

  // ── Scanner tab ────────────────────────────────────────────────────────────

  async function renderScannerTab() {
    await refreshOrders();
    const hasOrders = loadedOrders.length > 0;
    document.getElementById('scannerEmpty').classList.toggle('hidden', hasOrders);
    if (!hasOrders) {
      document.getElementById('phaseWaybill').classList.add('hidden');
      document.getElementById('phaseItems').classList.add('hidden');
      return;
    }
    if (activeOrder) {
      // Re-sync this order's state from server
      const fresh = loadedOrders.find(o => o.order_number === activeOrder.order_number);
      if (fresh) activeOrder = fresh;
      enterItemsPhase(activeOrder);
    } else {
      enterWaybillPhase();
    }
  }

  // ── Phase A: Waybill ───────────────────────────────────────────────────────

  function enterWaybillPhase() {
    document.getElementById('phaseWaybill').classList.remove('hidden');
    document.getElementById('phaseItems').classList.add('hidden');
    activeOrder = null;

    const wbInput = document.getElementById('waybillScanInput');
    wbInput.value = '';
    document.getElementById('waybillError').classList.add('hidden');

    const pending = loadedOrders.filter(o => o.scan_status === 'pending' || o.scan_status === 'processing');
    document.getElementById('pendingCount').textContent = pending.length;

    document.getElementById('pendingOrdersList').innerHTML = pending.length
      ? pending.map(ord => `
          <div class="pending-order-btn" data-order="${esc(ord.order_number)}">
            <div class="pob-left">
              <span class="pob-no">${esc(ord.order_number)}</span>
              <span class="pob-customer">${esc(ord.customer_name || '')}</span>
            </div>
            <div class="pob-right">
              ${ord.waybill_number ? `<span class="pob-waybill">${esc(ord.waybill_number)}</span>` : ''}
              ${ord.scan_status === 'processing' ? '<span class="status-badge processing">In Progress</span>' : ''}
              <span class="pob-items">${ord.lines.length} SKU${ord.lines.length !== 1 ? 's' : ''} · ${ord.total_qty} units</span>
            </div>
          </div>`)
        .join('')
      : '<p class="empty-state" style="padding:1.5rem">All orders processed!</p>';

    document.querySelectorAll('.pending-order-btn').forEach(btn =>
      btn.addEventListener('click', () => startOrderScan(btn.dataset.order))
    );

    setTimeout(() => wbInput.focus(), 80);
  }

  document.getElementById('waybillScanInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const val = e.target.value.trim();
      if (val) handleWaybillScan(val);
    }
  });

  async function handleWaybillScan(waybill) {
    const errEl = document.getElementById('waybillError');
    try {
      const resp = await fetch('/api/waybill-lookup', {
        method: 'POST', headers: hdrs(), body: JSON.stringify({ waybill }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        errEl.textContent = data.error;
        errEl.classList.remove('hidden');
        document.getElementById('waybillScanInput').value = '';
        return;
      }
      errEl.classList.add('hidden');
      // Merge fresh state into loadedOrders
      const idx = loadedOrders.findIndex(o => o.order_number === data.order_number);
      if (idx >= 0) loadedOrders[idx] = data; else loadedOrders.push(data);
      enterItemsPhase(data);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  }

  async function startOrderScan(orderNumber) {
    const ord = loadedOrders.find(o => o.order_number === orderNumber);
    if (ord) enterItemsPhase(ord);
  }

  // ── Phase B: Items ─────────────────────────────────────────────────────────

  function enterItemsPhase(order) {
    activeOrder = order;
    document.getElementById('phaseWaybill').classList.add('hidden');
    document.getElementById('phaseItems').classList.remove('hidden');

    document.getElementById('scanOrderNo').textContent = order.order_number;

    document.getElementById('scanOrderMeta').innerHTML = `
      <span><strong>Customer:</strong> ${esc(order.customer_name || '—')}</span>
      <span><strong>Carrier:</strong> ${esc(order.carrier || '—')}</span>
      <span class="${order.waybill_number ? 'waybill-ok' : ''}">
        <strong>Waybill:</strong>
        ${order.waybill_number ? `${esc(order.waybill_number)} &#10003;` : 'Not provided'}
      </span>
      ${order.required_date ? `<span><strong>Req. Date:</strong> ${esc(order.required_date)}</span>` : ''}`;

    renderItemsTable(order);
    updateProgress(order);

    const input = document.getElementById('itemScanInput');
    input.value = '';
    document.getElementById('itemScanFeedback').classList.add('hidden');
    setTimeout(() => input.focus(), 80);
  }

  function renderItemsTable(order) {
    const scanned = order.scanned || {};
    document.getElementById('scanItemsTbody').innerHTML = order.lines.map(item => {
      const s = scanned[item.sku] || 0;
      const rowClass = s === 0 ? '' : s === item.qty ? 'row-ok' : s > item.qty ? 'row-over' : 'row-partial';
      const icon = s === item.qty && s > 0 ? '&#10003;' : s > item.qty ? '&#10007;' : s > 0 ? '&#8230;' : '';
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

    // Manual qty change
    document.querySelectorAll('.qty-input').forEach(inp => {
      inp.addEventListener('change', async () => {
        const qty = parseInt(inp.value, 10) || 0;
        await setItemQty(activeOrder.order_number, inp.dataset.sku, qty);
        // Refocus scan input after manual edit
        document.getElementById('itemScanInput').focus();
      });
    });
  }

  function updateProgress(order) {
    const scanned = order.scanned || {};
    const doneCount = order.lines.filter(l => (scanned[l.sku] || 0) === l.qty).length;
    const el = document.getElementById('scanProgress');
    el.textContent = `${doneCount}/${order.lines.length} items`;
    el.className = doneCount === order.lines.length ? 'scan-progress all-done' : 'scan-progress';
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
      // Update local state
      if (!activeOrder.scanned) activeOrder.scanned = {};
      activeOrder.scanned[data.sku] = data.scanned_qty;
      activeOrder.scan_status = 'processing';

      renderItemsTable(activeOrder);
      updateProgress(activeOrder);

      // Flash the updated row
      const row = document.querySelector(`#scanItemsTbody tr[data-sku="${CSS.escape(data.sku)}"]`);
      if (row) {
        row.classList.add('row-flash');
        setTimeout(() => row.classList.remove('row-flash'), 450);
      }

      const overBy = data.scanned_qty - data.ordered_qty;
      if (overBy > 0) {
        showFeedback(feedback, 'error', `${data.sku}: OVER by ${overBy} (scanned ${data.scanned_qty}, ordered ${data.ordered_qty})`);
      } else {
        showFeedback(feedback, 'success',
          data.scanned_qty === data.ordered_qty
            ? `${data.sku}: ✓ Complete (${data.scanned_qty}/${data.ordered_qty})`
            : `${data.sku}: ${data.scanned_qty}/${data.ordered_qty} scanned`
        );
      }
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
    } catch (err) {
      alert(err.message);
    }
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
        body: JSON.stringify({ orderNumber: activeOrder.order_number }),
      });
      const data = await resp.json();
      if (!resp.ok) { alert(data.error); return; }

      if (data.ok) {
        activeOrder.scan_status = 'done';
        mergeOrderState(activeOrder.order_number, 'done');
        flashCompleteBtn();
      } else {
        showMismatchModal(data.mismatches);
      }
    } catch (err) {
      alert(err.message);
    }
  });

  function flashCompleteBtn() {
    const btn = document.getElementById('completeOrderBtn');
    const orig = btn.textContent;
    btn.textContent = '✓ Done!';
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
      activeOrder = null;
      refreshOrders().then(enterWaybillPhase);
    }, 1400);
  }

  // ── Cancel / back ──────────────────────────────────────────────────────────

  document.getElementById('cancelOrderBtn').addEventListener('click', () => {
    if (!activeOrder) return;
    if (confirm(`Cancel order ${activeOrder.order_number}?\nIt will be marked as Unprocessed and you will move to the next order.`)) {
      doCancel();
    }
  });

  document.getElementById('backToQueueBtn').addEventListener('click', () => {
    activeOrder = null;
    enterWaybillPhase();
  });

  async function doCancel() {
    try {
      const resp = await fetch('/api/scan/cancel', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ orderNumber: activeOrder.order_number }),
      });
      const data = await resp.json();
      if (!resp.ok) { alert(data.error); return; }
      mergeOrderState(activeOrder.order_number, 'unprocessed', {});
      activeOrder = null;
      await refreshOrders();
      enterWaybillPhase();
    } catch (err) {
      alert(err.message);
    }
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

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function refreshOrders() {
    if (!SESSION_ID) return;
    try {
      const resp = await fetch('/api/orders', { headers: { 'x-session-id': SESSION_ID } });
      const data = await resp.json();
      if (Array.isArray(data)) loadedOrders = data;
    } catch (_) {}
  }

  function mergeOrderState(orderNumber, status, scanned) {
    const idx = loadedOrders.findIndex(o => o.order_number === orderNumber);
    if (idx < 0) return;
    loadedOrders[idx].scan_status = status;
    if (scanned !== undefined) loadedOrders[idx].scanned = scanned;
  }

})();
