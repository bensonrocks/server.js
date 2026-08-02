(function () {
  'use strict';

  const API = '/client-access/api';
  const SKU_CATALOG = [
    { sku: 'RAD-SER-30', name: 'Radiance Serum 30ml' },
    { sku: 'NGT-CRM-50', name: 'Renewal Night Cream 50ml' },
    { sku: 'BRT-TNR-150', name: 'Brightening Toner 150ml' },
    { sku: 'COL-ESS-30', name: 'Collagen Essence 30ml' },
    { sku: 'VTC-CLN-100', name: 'Vitamin C Cleanser 100ml' },
  ];
  const SG_HUB = { lat: 1.3521, lng: 103.8198 };

  let token = localStorage.getItem('nt-client-token') || '';
  let clientName = localStorage.getItem('nt-client-name') || '';
  let selectedCountry = new URLSearchParams(window.location.search).get('country') || '';
  let currentPage = 1;
  let inventoryLocations = [];
  let selectedInvLocation = null;

  const $ = (sel) => document.querySelector(sel);
  const loginScreen = $('#login-screen');
  const app = $('#app');

  function authHeaders() {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  // ---------- Theme (always light — no dark mode) ----------
  const root = document.documentElement;
  root.dataset.theme = 'light';

  async function api(path, opts = {}) {
    const res = await fetch(API + path, { ...opts, headers: authHeaders() });
    if (res.status === 401) { doLogout(); throw new Error('Session expired'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  // ---------- Auth ----------

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    const errEl = $('#login-error');
    errEl.hidden = true;
    try {
      const res = await fetch(API + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Login failed');
      token = body.token;
      clientName = body.name;
      localStorage.setItem('nt-client-token', token);
      localStorage.setItem('nt-client-name', clientName);
      showApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  function doLogout() {
    localStorage.removeItem('nt-client-token');
    localStorage.removeItem('nt-client-name');
    token = '';
    app.hidden = true;
    loginScreen.hidden = false;
  }

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST' }); } catch (_) {}
    doLogout();
  });

  function showApp() {
    loginScreen.hidden = true;
    app.hidden = false;
    $('#client-name').textContent = clientName;
    // Each page only has the DOM for its own panel — load only what's here.
    if ($('#stat-total') || $('#world-map')) loadDashboard();
    if ($('#orders-tbody')) loadOrders();
    if ($('#inventory-grid')) loadInventory();
    if ($('#rates-table-wrap')) loadRates();
    if ($('#reports-market-tbody')) loadReports();
  }

  // ---------- Dashboard (stats + map) ----------

  async function loadDashboard() {
    const data = await api('/dashboard');
    if ($('#stat-total')) {
      $('#stat-total').textContent = data.counts.total.toLocaleString();
      $('#stat-dropped').textContent = data.counts.dropped.toLocaleString();
      $('#stat-processing').textContent = data.counts.processing.toLocaleString();
      $('#stat-completed').textContent = data.counts.completed.toLocaleString();
      $('#stat-issue').textContent = data.counts.issue.toLocaleString();
      renderMonthlyBars(data.months);
    }
    if ($('#world-map')) renderMap(data.countries);
  }

  function monthLabel(yyyyMm) {
    const [y, m] = yyyyMm.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleString('en-US', { month: 'long' });
  }

  function renderMonthlyBars(months) {
    const wrap = $('#monthly-bars');
    if (!months || !months.length) {
      wrap.innerHTML = '<p class="table-loading">No order history yet.</p>';
      return;
    }
    const max = Math.max(...months.map((m) => m.total), 1);
    wrap.innerHTML = months.map((m) => {
      const pct = Math.max(2, Math.round((m.total / max) * 100));
      return `
        <div class="month-col">
          <div class="month-bar-track">
            <div class="month-bar-fill${m.live ? ' month-bar-live' : ''}" style="height:${pct}%"></div>
          </div>
          <div class="month-total">${m.total.toLocaleString()}</div>
          <div class="month-label${m.live ? ' is-live' : ''}">
            ${m.live ? '<span class="live-dot" title="Current month — live"></span>' : ''}
            ${escapeHtml(monthLabel(m.month))}${m.live ? ' · LIVE' : ''}
          </div>
        </div>`;
    }).join('');
  }

  function statusOf(c) {
    // Rate-based, not raw-count-based: a handful of exceptions across three
    // months of hundreds of orders per market is normal operations, not a
    // market in trouble — only flag markets meaningfully above that baseline.
    const issueRate = c.total > 0 ? c.issue / c.total : 0;
    if (issueRate > 0.035) return 'red';
    if (c.processing > 0 || c.dropped > 0) return 'amber';
    return 'green';
  }

  // Real OpenStreetMap tiles (via CARTO's free dark basemap — same OSM data,
  // dark style to match the rest of the site) instead of a hand-drawn map.
  // Pan/zoom/scroll are disabled so it reads as a static reference map;
  // markers stay fully interactive.
  let leafletMap = null;
  let markerLayer = null;
  let tileLayer = null;
  let lastCountries = [];
  let boundsSet = false;

  function tileUrlForTheme() {
    const variant = root.dataset.theme === 'light' ? 'light_all' : 'dark_all';
    return `https://{s}.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}{r}.png`;
  }

  function initMap() {
    leafletMap = L.map('world-map', {
      zoomControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
      attributionControl: true,
    });

    tileLayer = L.tileLayer(tileUrlForTheme(), {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(leafletMap);

    markerLayer = L.layerGroup().addTo(leafletMap);
  }

  function markerIcon(status, selected, size) {
    return L.divIcon({
      className: '',
      html: `<div class="nt-marker status-${status}${selected ? ' selected' : ''}" style="width:${size}px;height:${size}px;">
               <div class="nt-marker-ring"></div><div class="nt-marker-dot"></div>
             </div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  function renderMap(countries) {
    if (!leafletMap) initMap();
    lastCountries = countries;
    markerLayer.clearLayers();

    const hubIcon = L.divIcon({ className: '', html: '<div class="nt-hub-marker"></div>', iconSize: [9, 9], iconAnchor: [4.5, 4.5] });
    L.marker([SG_HUB.lat, SG_HUB.lng], { icon: hubIcon, interactive: false })
      .bindTooltip('SG · HUB', { permanent: true, direction: 'right', offset: [8, 0], className: '' })
      .addTo(markerLayer);

    const allPoints = [[SG_HUB.lat, SG_HUB.lng]];

    countries.forEach((c) => {
      allPoints.push([c.lat, c.lng]);
      L.polyline([[SG_HUB.lat, SG_HUB.lng], [c.lat, c.lng]], {
        color: '#dd8d6c', weight: 1.2, dashArray: '3 4', opacity: 0.5, interactive: false,
      }).addTo(markerLayer);
    });

    let selectedMarker = null;

    countries.forEach((c) => {
      const status = statusOf(c);
      const size = Math.max(20, Math.min(38, 16 + Math.sqrt(c.total) * 2));
      const selected = c.country === selectedCountry;
      const marker = L.marker([c.lat, c.lng], { icon: markerIcon(status, selected, size) });
      marker.bindPopup(`
        <span class="nt-popup-title">${c.countryName}</span>
        <div class="nt-popup-row"><span>Dropped</span><span>${c.dropped}</span></div>
        <div class="nt-popup-row"><span>Processing</span><span>${c.processing}</span></div>
        <div class="nt-popup-row"><span>Completed</span><span>${c.completed}</span></div>
        <div class="nt-popup-row"><span>Issues</span><span>${c.issue}</span></div>
      `, { className: 'nt-popup' });
      marker.on('click', () => selectMarket(c.country));
      if (selected) selectedMarker = marker;
      marker.addTo(markerLayer);
    });

    if (!boundsSet) {
      leafletMap.fitBounds(L.latLngBounds(allPoints), { padding: [30, 30] });
      boundsSet = true;
    }
    if (selectedMarker) selectedMarker.openPopup();
    renderMarketChips(countries);
  }

  function selectMarket(country) {
    // The orders table now lives on its own page — jump there, pre-filtered.
    window.location.href = `orders.html?country=${encodeURIComponent(country)}`;
  }

  function renderMarketChips(countries) {
    const wrap = $('#market-chips');
    wrap.innerHTML = countries.map((c) => {
      const status = statusOf(c);
      const selected = c.country === selectedCountry ? 'selected' : '';
      return `<button type="button" class="market-chip status-${status} ${selected}" data-country="${c.country}"><span class="dot"></span>${c.countryName} · ${c.total}</button>`;
    }).join('');
    wrap.querySelectorAll('.market-chip').forEach((chip) => {
      chip.addEventListener('click', () => selectMarket(chip.dataset.country));
    });
  }

  // ---------- Orders table ----------

  let searchDebounce;
  $('#order-search')?.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { currentPage = 1; loadOrders(); }, 250);
  });
  $('#status-filter')?.addEventListener('change', () => { currentPage = 1; loadOrders(); });
  $('#orders-clear-filter')?.addEventListener('click', () => {
    selectedCountry = '';
    currentPage = 1;
    history.replaceState(null, '', window.location.pathname);
    loadOrders();
  });

  async function loadOrders() {
    const tbody = $('#orders-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="table-loading">Loading…</td></tr>';

    const filterHint = $('#orders-filter-hint');
    if (filterHint) {
      if (selectedCountry) {
        filterHint.hidden = false;
        filterHint.querySelector('.filter-country').textContent = selectedCountry;
      } else {
        filterHint.hidden = true;
      }
    }

    const params = new URLSearchParams({ page: currentPage, pageSize: 25 });
    const search = $('#order-search').value.trim();
    const status = $('#status-filter').value;
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (selectedCountry) params.set('country', selectedCountry);

    const data = await api(`/orders?${params}`);

    if (!data.rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-loading">No orders match this filter.</td></tr>';
    } else {
      tbody.innerHTML = data.rows.map((o) => `
        <tr>
          <td><code>${o.order_ref}</code></td>
          <td>${o.country_name}</td>
          <td>${escapeHtml(o.customer_name)}</td>
          <td>${escapeHtml(o.product_name)} <span style="color:var(--fg-muted)">(${o.sku})</span></td>
          <td>${o.qty}</td>
          <td><span class="status-pill ${o.status}">${o.status}</span>${o.issue_note ? ` <span title="${escapeHtml(o.issue_note)}" style="cursor:help;color:var(--fg-muted)">ⓘ</span>` : ''}</td>
          <td>${o.order_date}</td>
          <td><button class="track-btn" data-track="${o.id}" data-ref="${o.order_ref}">Track</button></td>
        </tr>
      `).join('');
      tbody.querySelectorAll('button[data-track]').forEach((btn) => {
        btn.addEventListener('click', () => openTracking(btn.dataset.track, btn.dataset.ref));
      });
    }

    renderPagination(data.total, data.page, data.pageSize);
  }

  function renderPagination(total, page, pageSize) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const el = $('#pagination');
    if (pages <= 1) { el.innerHTML = `<span>${total} order${total === 1 ? '' : 's'}</span>`; return; }

    let html = `<button ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">‹ Prev</button>`;
    const start = Math.max(1, page - 2);
    const end = Math.min(pages, start + 4);
    for (let p = start; p <= end; p++) {
      html += `<button class="${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`;
    }
    html += `<button ${page >= pages ? 'disabled' : ''} data-page="${page + 1}">Next ›</button>`;
    html += `<span style="margin-left:10px;color:var(--fg-muted)">${total} total</span>`;
    el.innerHTML = html;
    el.querySelectorAll('button[data-page]').forEach((btn) => {
      btn.addEventListener('click', () => { currentPage = parseInt(btn.dataset.page); loadOrders(); });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Inventory ----------

  async function loadInventory() {
    inventoryLocations = await api('/inventory');
    if (!inventoryLocations.find((l) => l.id === selectedInvLocation)) {
      selectedInvLocation = inventoryLocations.length ? inventoryLocations[0].id : null;
    }
    renderInventory();
  }

  function renderInventory() {
    const grid = $('#inventory-grid');
    if (!inventoryLocations.length) {
      grid.innerHTML = '<p class="table-loading">No locations yet.</p>';
      return;
    }
    const active = inventoryLocations.find((l) => l.id === selectedInvLocation) || inventoryLocations[0];

    grid.innerHTML = `
      <div class="inv-location-tabs">
        ${inventoryLocations.map((loc) => `
          <button class="inv-location-tab${loc.id === active.id ? ' active' : ''}" data-loc="${loc.id}">
            ${loc.country_name}<span>${escapeHtml(loc.city)}</span>
          </button>
        `).join('')}
      </div>
      <div class="inv-location-panel">
        ${active.items.map((i) => `
          <div class="inv-item">
            <div class="inv-item-name">${escapeHtml(i.product_name)}<small>${i.sku}</small></div>
            <div class="inv-item-qty">${i.qty_on_hand}</div>
            ${i.lowStock ? '<span class="inv-low-badge">Low stock</span>' : ''}
            <div class="inv-threshold">
              <span>alert at</span>
              <input type="number" min="0" value="${i.replenish_threshold}" data-id="${i.id}" />
              <button data-save="${i.id}">Save</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    grid.querySelectorAll('.inv-location-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedInvLocation = btn.dataset.loc;
        renderInventory();
      });
    });

    grid.querySelectorAll('button[data-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.save;
        const input = grid.querySelector(`input[data-id="${id}"]`);
        const threshold = parseInt(input.value, 10);
        btn.textContent = '…';
        try {
          await api(`/inventory/${id}/threshold`, { method: 'PATCH', body: JSON.stringify({ threshold }) });
          loadInventory();
        } catch (e) {
          btn.textContent = 'Save';
          alert(e.message);
        }
      });
    });
  }

  // ---------- Drop new order ----------

  const dropOverlay = $('#drop-order-overlay');
  const skuSelect = $('#order-sku');
  if (skuSelect) {
    skuSelect.innerHTML = SKU_CATALOG.map((s) => `<option value="${s.sku}" data-name="${s.name}">${s.name} (${s.sku})</option>`).join('');
  }

  $('#open-drop-order')?.addEventListener('click', () => {
    $('#drop-order-error').hidden = true;
    $('#order-date').value = new Date().toISOString().slice(0, 10);
    $('#drop-order-form').reset();
    $('#order-date').value = new Date().toISOString().slice(0, 10);
    dropOverlay.hidden = false;
  });
  $('#cancel-drop-order')?.addEventListener('click', () => { dropOverlay.hidden = true; });
  dropOverlay?.addEventListener('click', (e) => { if (e.target === dropOverlay) dropOverlay.hidden = true; });

  $('#drop-order-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const countryEl = $('#order-country');
    const skuEl = $('#order-sku');
    const errEl = $('#drop-order-error');
    errEl.hidden = true;

    const payload = {
      customerName: $('#order-customer').value.trim(),
      country: countryEl.value,
      countryName: countryEl.selectedOptions[0].dataset.name,
      sku: skuEl.value,
      productName: skuEl.selectedOptions[0].dataset.name,
      qty: parseInt($('#order-qty').value, 10) || 1,
      orderDate: $('#order-date').value,
    };

    try {
      await api('/orders', { method: 'POST', body: JSON.stringify(payload) });
      dropOverlay.hidden = true;
      currentPage = 1;
      loadDashboard();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  // ---------- Tracking ----------

  const trackingOverlay = $('#tracking-overlay');

  async function openTracking(orderId, orderRef) {
    trackingOverlay.hidden = false;
    $('#tracking-order-ref').textContent = `Tracking — ${orderRef}`;
    $('#tracking-carrier-line').textContent = 'Loading…';
    $('#tracking-body').innerHTML = '<p class="table-loading">Loading…</p>';

    try {
      const data = await api(`/orders/${orderId}/tracking`);
      $('#tracking-carrier-line').textContent = data.carrier
        ? `${data.carrier} · Waybill ${data.waybillNumber}`
        : 'No carrier assigned yet — order has not shipped.';

      const timelineHtml = `<ul class="tracking-timeline">${data.timeline.map((ev) => `
        <li class="${ev.status === 'issue' ? 'issue' : 'done'}">
          <span class="tracking-dot"></span>
          <div>
            <div class="tracking-event-status">${ev.status}</div>
            ${ev.note ? `<div class="tracking-event-note">${escapeHtml(ev.note)}</div>` : ''}
            <div class="tracking-event-time">${ev.created_at}</div>
          </div>
        </li>
      `).join('')}</ul>`;

      let carrierHtml = '';
      if (data.carrier) {
        if (data.carrierTracking && data.carrierTracking.available) {
          const ct = data.carrierTracking;
          carrierHtml = `
            <div class="carrier-panel">
              <h4>Live carrier status (${data.carrier})</h4>
              <ul class="tracking-timeline">${(ct.checkpoints || []).map((c) => `
                <li class="done">
                  <span class="tracking-dot"></span>
                  <div>
                    <div class="tracking-event-status">${escapeHtml(c.message || ct.subtag || ct.tag)}</div>
                    ${c.location ? `<div class="tracking-event-note">${escapeHtml(c.location)}</div>` : ''}
                    <div class="tracking-event-time">${c.time || ''}</div>
                  </div>
                </li>
              `).join('') || '<li><div class="tracking-event-note">No checkpoints reported yet.</div></li>'}</ul>
            </div>`;
        } else {
          const reason = data.carrierTracking && data.carrierTracking.reason === 'not_configured'
            ? 'Live carrier tracking isn’t connected yet — this shows our own internal fulfillment status only.'
            : 'Live carrier status isn’t available right now.';
          carrierHtml = `<div class="carrier-panel"><p class="carrier-unavailable">${reason}</p></div>`;
        }
      }

      $('#tracking-body').innerHTML = timelineHtml + carrierHtml;
    } catch (err) {
      $('#tracking-body').innerHTML = `<p class="modal-error">${escapeHtml(err.message)}</p>`;
    }
  }

  $('#close-tracking')?.addEventListener('click', () => { trackingOverlay.hidden = true; });
  trackingOverlay?.addEventListener('click', (e) => { if (e.target === trackingOverlay) trackingOverlay.hidden = true; });

  // ---------- Upload orders (CSV) ----------

  const uploadOverlay = $('#upload-orders-overlay');
  let parsedUploadRows = [];

  function parseOrdersCsv(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const looksLikeHeader = /customer/i.test(lines[0]) && /country|market/i.test(lines[0]);
    const dataLines = looksLikeHeader ? lines.slice(1) : lines;

    return dataLines.map((line) => {
      const [customerName, country, sku, qty, orderDate] = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      return { customerName, country: (country || '').toUpperCase(), sku, qty: qty ? parseInt(qty, 10) : 1, orderDate: orderDate || undefined };
    });
  }

  $('#open-upload-orders')?.addEventListener('click', () => {
    parsedUploadRows = [];
    $('#upload-orders-file').value = '';
    $('#upload-orders-summary').hidden = true;
    $('#upload-orders-error').hidden = true;
    $('#submit-upload-orders').disabled = true;
    uploadOverlay.hidden = false;
  });
  $('#cancel-upload-orders')?.addEventListener('click', () => { uploadOverlay.hidden = true; });
  uploadOverlay?.addEventListener('click', (e) => { if (e.target === uploadOverlay) uploadOverlay.hidden = true; });

  $('#upload-orders-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const summaryEl = $('#upload-orders-summary');
    const errEl = $('#upload-orders-error');
    errEl.hidden = true;
    if (!file) return;
    try {
      const text = await file.text();
      parsedUploadRows = parseOrdersCsv(text);
      summaryEl.hidden = false;
      summaryEl.textContent = `${parsedUploadRows.length} row(s) ready to import.`;
      $('#submit-upload-orders').disabled = parsedUploadRows.length === 0;
    } catch (err) {
      errEl.textContent = 'Could not read that file.';
      errEl.hidden = false;
    }
  });

  $('#submit-upload-orders')?.addEventListener('click', async () => {
    const errEl = $('#upload-orders-error');
    const summaryEl = $('#upload-orders-summary');
    errEl.hidden = true;
    try {
      const result = await api('/orders/import', { method: 'POST', body: JSON.stringify({ rows: parsedUploadRows }) });
      summaryEl.hidden = false;
      summaryEl.textContent = `Imported ${result.created} order(s).` +
        (result.errors.length ? `\n${result.errors.length} row(s) failed:\n` + result.errors.map((e) => `Row ${e.row}: ${e.error}`).join('\n') : '');
      loadDashboard();
      loadOrders();
      if (!result.errors.length) setTimeout(() => { uploadOverlay.hidden = true; }, 1200);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  // ---------- Export CSV ----------

  $('#export-orders-btn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const params = new URLSearchParams();
    const search = $('#order-search').value.trim();
    const status = $('#status-filter').value;
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (selectedCountry) params.set('country', selectedCountry);

    const res = await fetch(`${API}/orders/export?${params}`, { headers: authHeaders() });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // ---------- Rates ----------

  function fmtUsd(n) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  let currentLiveIndicative = null;

  function liveIndicativeTable(li) {
    if (!li) return '';
    return `
      <div class="rate-section">
        <h4>Current month at actual volumes (live)</h4>
        <p class="panel-sub">Computed from your real ${escapeHtml(monthLabel(li.month))} order data — actual order counts and item quantities — run through the tiered schedule above. Domestic delivery assumes the standard (up to 2.00 kg) band, the same despatch-weight assumption the modelled table above uses. Click a row for the full billing breakdown.</p>
        <div class="table-wrap">
          <table class="rates-table">
            <thead>
              <tr><th>Market</th><th>Orders</th><th>Items (qty)</th><th>Avg items/order</th><th>Tier applied</th><th>Indicative fee (USD)</th></tr>
            </thead>
            <tbody>
              ${li.markets.map((m, i) => `
                <tr class="rate-row-clickable" data-market-idx="${i}" tabindex="0" title="Click for billing detail">
                  <td>${escapeHtml(m.countryName)}</td>
                  <td>${m.orders.toLocaleString()}</td>
                  <td>${m.qty.toLocaleString()}</td>
                  <td>${m.avgItemsPerOrder.toFixed(2)}</td>
                  <td>${escapeHtml(m.tierLabel)}</td>
                  <td>${fmtUsd(m.total)} <span class="rate-row-hint">▸</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="table-wrap rates-total-wrap">
          <table class="rates-table rates-total-row">
            <tbody><tr><td>Total</td><td>${li.totalOrders.toLocaleString()}</td><td colspan="3"></td><td>${fmtUsd(li.totalFee)}</td></tr></tbody>
          </table>
        </div>
      </div>`;
  }

  const billingDetailOverlay = $('#billing-detail-overlay');

  function openBillingDetail(m, month) {
    billingDetailOverlay.hidden = false;
    $('#billing-detail-title').textContent = `Billing detail — ${m.countryName}`;
    $('#billing-detail-sub').textContent = `${monthLabel(month)} · Tier ${m.tierLabel} orders/month`;

    const b = m.breakdown;
    const firstItemFee = m.orders * b.firstItemRate;
    $('#billing-detail-body').innerHTML = `
      <div class="billing-detail-grid">
        <div class="billing-stat"><span>Orders this month</span><strong>${m.orders.toLocaleString()}</strong></div>
        <div class="billing-stat"><span>Items ordered (qty)</span><strong>${m.qty.toLocaleString()}</strong></div>
        <div class="billing-stat"><span>Avg items / order</span><strong>${m.avgItemsPerOrder.toFixed(2)}</strong></div>
        <div class="billing-stat"><span>Despatched (non-dropped)</span><strong>${b.despatched.toLocaleString()}</strong></div>
      </div>

      <div class="billing-detail-tables">
        <table class="rates-table billing-breakdown-table">
          <thead><tr><th>Line item</th><th>Calculation</th><th>Amount (USD)</th></tr></thead>
          <tbody>
            <tr>
              <td>Order fulfilment — first item</td>
              <td>${m.orders.toLocaleString()} orders × ${fmtUsd(b.firstItemRate)}</td>
              <td>${fmtUsd(firstItemFee)}</td>
            </tr>
            <tr>
              <td>Additional item pick</td>
              <td>${b.additionalItems.toLocaleString()} items × ${fmtUsd(b.additionalItemRate)}</td>
              <td>${fmtUsd(b.additionalItems * b.additionalItemRate)}</td>
            </tr>
            <tr>
              <td>Domestic delivery — standard</td>
              <td>${b.despatched.toLocaleString()} despatched × ${fmtUsd(b.deliveryRate)}</td>
              <td>${fmtUsd(b.deliveryFee)}</td>
            </tr>
          </tbody>
        </table>
        <table class="rates-table rates-total-row billing-breakdown-total">
          <tbody><tr><td>Total estimated fee</td><td></td><td>${fmtUsd(m.total)}</td></tr></tbody>
        </table>
      </div>
      <p class="panel-sub">Tier is set by this market's actual order count this month (${m.orders.toLocaleString()} falls in the ${m.tierLabel} band). Domestic delivery assumes the standard (up to 2.00 kg) despatch-weight band, applied only to orders that have actually been despatched to a carrier.</p>
    `;
  }

  $('#close-billing-detail')?.addEventListener('click', () => { billingDetailOverlay.hidden = true; });
  billingDetailOverlay?.addEventListener('click', (e) => { if (e.target === billingDetailOverlay) billingDetailOverlay.hidden = true; });

  $('#rates-table-wrap')?.addEventListener('click', (e) => {
    const row = e.target.closest('.rate-row-clickable');
    if (!row || !currentLiveIndicative) return;
    const m = currentLiveIndicative.markets[parseInt(row.dataset.marketIdx, 10)];
    if (m) openBillingDetail(m, currentLiveIndicative.month);
  });
  $('#rates-table-wrap')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest && e.target.closest('.rate-row-clickable');
    if (!row || !currentLiveIndicative) return;
    e.preventDefault();
    const m = currentLiveIndicative.markets[parseInt(row.dataset.marketIdx, 10)];
    if (m) openBillingDetail(m, currentLiveIndicative.month);
  });

  function ratesTable(section) {
    return `
      <div class="rate-section">
        <h4>${escapeHtml(section.title)}</h4>
        ${section.note ? `<p class="panel-sub">${escapeHtml(section.note)}</p>` : ''}
        <div class="table-wrap">
          <table class="rates-table">
            <thead><tr>${section.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
            <tbody>
              ${section.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  async function loadRates() {
    const wrap = $('#rates-table-wrap');
    if (!wrap) return;
    try {
      const data = await api('/rates');
      if (!data.configured) {
        currentLiveIndicative = null;
        wrap.innerHTML = `
          <table class="rates-table">
            <thead><tr><th>DC / Market</th><th>Base handling fee</th><th>Per-unit fee</th><th>Storage fee</th><th>Notes</th></tr></thead>
            <tbody>
              ${data.perLocation.map((r) => `
                <tr>
                  <td>${escapeHtml(r.country_name)} <span style="color:var(--fg-muted)">(${escapeHtml(r.city)})</span></td>
                  ${r.configured ? `
                    <td>${r.currency} ${r.base_fee.toFixed(2)}</td>
                    <td>${r.currency} ${r.per_unit_fee.toFixed(2)}</td>
                    <td>${r.currency} ${r.storage_fee.toFixed(2)}</td>
                    <td>${escapeHtml(r.notes || '—')}</td>
                  ` : `
                    <td class="rate-not-set" colspan="4">Not yet configured — contact your NimbusTrade account manager</td>
                  `}
                </tr>
              `).join('')}
            </tbody>
          </table>`;
        return;
      }

      currentLiveIndicative = data.liveIndicative;
      const rc = data.rateCard;
      wrap.innerHTML = `
        <div class="rate-card-header">
          <p class="panel-sub">${escapeHtml(rc.scope)}</p>
          <p class="panel-sub">${escapeHtml(rc.billingNote)}</p>
        </div>

        ${rc.sections.map(ratesTable).join('')}
        ${ratesTable(rc.indicative)}
        <div class="table-wrap rates-total-wrap">
          <table class="rates-table rates-total-row">
            <tbody><tr>${rc.indicative.total.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr></tbody>
          </table>
        </div>
        <p class="panel-sub">${escapeHtml(rc.indicative.footnote)}</p>

        ${liveIndicativeTable(data.liveIndicative)}

        <div class="rate-section">
          <h4>Commercial terms</h4>
          <ul class="rate-terms">
            ${rc.terms.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}
          </ul>
        </div>

        <p class="rate-card-footer">
          Prepared by ${escapeHtml(rc.preparedBy)} · ${escapeHtml(rc.preparedTitle)}<br/>
          Issued ${escapeHtml(rc.issuedDate)}
        </p>
      `;
    } catch (err) {
      currentLiveIndicative = null;
      wrap.innerHTML = `<p class="table-loading">${escapeHtml(err.message)}</p>`;
    }
  }

  // ---------- Reports ----------

  const INBOUND_STATUS_LABEL = { booked: 'Booked', in_transit: 'In Transit', arrived: 'Arrived', delayed: 'Delayed', partial: 'Partial' };
  const INBOUND_MODE_LABEL = { air: 'Air', sea: 'Sea', road: 'Road' };

  async function loadReports() {
    const marketTbody = $('#reports-market-tbody');
    const inboundTbody = $('#reports-inbound-tbody');
    if (!marketTbody || !inboundTbody) return;
    $('#reports-generated-at').textContent = `Generated ${new Date().toLocaleString()}`;

    try {
      const [dashboard, inbound] = await Promise.all([api('/dashboard'), api('/inbound')]);
      const markets = dashboard.countries;

      $('#reports-stat-outbound').textContent = dashboard.counts.total.toLocaleString();
      $('#reports-stat-delivered').textContent = dashboard.counts.completed.toLocaleString();
      $('#reports-stat-issues').textContent = dashboard.counts.issue.toLocaleString();
      $('#reports-stat-inbound').textContent = inbound.length.toLocaleString();
      $('#reports-stat-delayed').textContent = inbound.filter((s) => s.status === 'delayed').length.toLocaleString();

      marketTbody.innerHTML = markets.length ? markets.map((m) => `
        <tr>
          <td>${escapeHtml(m.countryName)}</td>
          <td>${m.dropped}</td>
          <td>${m.processing}</td>
          <td>${m.completed}</td>
          <td>${m.issue}</td>
          <td>${m.total}</td>
        </tr>
      `).join('') : '<tr><td colspan="6" class="table-loading">No orders yet.</td></tr>';

      inboundTbody.innerHTML = inbound.length ? inbound.map((s) => `
        <tr>
          <td style="font-family:var(--font-mono);font-size:12px">${escapeHtml(s.reference)}</td>
          <td>${escapeHtml(s.country_name)} <span style="color:var(--fg-muted)">(${escapeHtml(s.city)})</span></td>
          <td>${escapeHtml(s.origin || '—')}</td>
          <td>${INBOUND_MODE_LABEL[s.mode] || s.mode || '—'}</td>
          <td>${escapeHtml(s.carrier || '—')}${s.waybill_number ? `<br><span style="font-family:var(--font-mono);font-size:11.5px;color:var(--fg-muted)">${escapeHtml(s.waybill_number)}</span>` : ''}</td>
          <td>${escapeHtml(s.contents || '—')}</td>
          <td>${s.expected_qty}</td>
          <td>${s.received_qty}</td>
          <td><span class="status-pill ${s.status}">${INBOUND_STATUS_LABEL[s.status] || s.status}</span></td>
          <td>${escapeHtml(s.expected_date || '—')}</td>
          <td>${escapeHtml(s.arrived_date || '—')}</td>
          <td><button class="track-btn" data-track-shipment="${s.id}" data-ref="${escapeHtml(s.reference)}">Track</button></td>
        </tr>
      `).join('') : '<tr><td colspan="12" class="table-loading">No inbound shipments yet.</td></tr>';

      inboundTbody.querySelectorAll('[data-track-shipment]').forEach((btn) => {
        btn.addEventListener('click', () => openShipmentTracking(btn.dataset.trackShipment, btn.dataset.ref));
      });
    } catch (err) {
      marketTbody.innerHTML = `<tr><td colspan="6" class="table-loading">${escapeHtml(err.message)}</td></tr>`;
      inboundTbody.innerHTML = `<tr><td colspan="12" class="table-loading">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  // ---------- Shipment tracking (inbound to DC) ----------

  const shipmentTrackingOverlay = $('#shipment-tracking-overlay');

  async function openShipmentTracking(shipmentId, reference) {
    if (!shipmentTrackingOverlay) return;
    shipmentTrackingOverlay.hidden = false;
    $('#shipment-tracking-ref').textContent = `Tracking — ${reference}`;
    $('#shipment-tracking-carrier-line').textContent = 'Loading…';
    $('#shipment-tracking-body').innerHTML = '<p class="table-loading">Loading…</p>';

    try {
      const data = await api(`/inbound/${shipmentId}/tracking`);
      $('#shipment-tracking-carrier-line').textContent = data.carrier
        ? `${data.origin} → ${data.destination} · ${INBOUND_MODE_LABEL[data.mode] || data.mode} · ${data.carrier} · Waybill ${data.waybillNumber || '—'}`
        : `${data.origin} → ${data.destination} · ${INBOUND_MODE_LABEL[data.mode] || data.mode} · No carrier assigned yet.`;

      const timelineHtml = `<ul class="tracking-timeline">${data.timeline.map((ev) => `
        <li class="${ev.status === 'delayed' ? 'issue' : 'done'}">
          <span class="tracking-dot"></span>
          <div>
            <div class="tracking-event-status">${INBOUND_STATUS_LABEL[ev.status] || ev.status}</div>
            ${ev.note ? `<div class="tracking-event-note">${escapeHtml(ev.note)}</div>` : ''}
            <div class="tracking-event-time">${ev.created_at}</div>
          </div>
        </li>
      `).join('')}</ul>`;

      let carrierHtml = '';
      if (data.carrier) {
        if (data.carrierTracking && data.carrierTracking.available) {
          const ct = data.carrierTracking;
          carrierHtml = `
            <div class="carrier-panel">
              <h4>Live carrier status (${data.carrier})</h4>
              <ul class="tracking-timeline">${(ct.checkpoints || []).map((c) => `
                <li class="done">
                  <span class="tracking-dot"></span>
                  <div>
                    <div class="tracking-event-status">${escapeHtml(c.message || ct.subtag || ct.tag)}</div>
                    ${c.location ? `<div class="tracking-event-note">${escapeHtml(c.location)}</div>` : ''}
                    <div class="tracking-event-time">${c.time || ''}</div>
                  </div>
                </li>
              `).join('') || '<li><div class="tracking-event-note">No checkpoints reported yet.</div></li>'}</ul>
            </div>`;
        } else {
          const reason = data.carrierTracking && data.carrierTracking.reason === 'not_configured'
            ? 'Live carrier tracking isn’t connected yet — this shows our own internal shipment status only.'
            : 'Live carrier status isn’t available right now.';
          carrierHtml = `<div class="carrier-panel"><p class="carrier-unavailable">${reason}</p></div>`;
        }
      }

      $('#shipment-tracking-body').innerHTML = timelineHtml + carrierHtml;
    } catch (err) {
      $('#shipment-tracking-body').innerHTML = `<p class="modal-error">${escapeHtml(err.message)}</p>`;
    }
  }

  $('#close-shipment-tracking')?.addEventListener('click', () => { shipmentTrackingOverlay.hidden = true; });
  shipmentTrackingOverlay?.addEventListener('click', (e) => { if (e.target === shipmentTrackingOverlay) shipmentTrackingOverlay.hidden = true; });

  $('#export-reports-btn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const res = await fetch(`${API}/reports/export`, { headers: authHeaders() });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // ---------- Boot ----------

  if (token) showApp(); else doLogout();
})();
