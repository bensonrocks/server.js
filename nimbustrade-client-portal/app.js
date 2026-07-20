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
  let selectedCountry = '';
  let currentPage = 1;

  const $ = (sel) => document.querySelector(sel);
  const loginScreen = $('#login-screen');
  const app = $('#app');

  function authHeaders() {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  // ---------- Theme ----------
  const root = document.documentElement;
  const storedTheme = localStorage.getItem('nimbustrade-portal-theme');
  root.dataset.theme = storedTheme || 'dark';

  function setTheme(next) {
    root.dataset.theme = next;
    localStorage.setItem('nimbustrade-portal-theme', next);
    if (tileLayer) tileLayer.setUrl(tileUrlForTheme());
  }

  [$('#theme-toggle'), $('#login-theme-toggle')].forEach((btn) => {
    if (!btn) return;
    btn.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
  });

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
    loadDashboard();
    loadOrders();
    loadInventory();
  }

  // ---------- Dashboard (stats + map) ----------

  async function loadDashboard() {
    const data = await api('/dashboard');
    $('#stat-total').textContent = data.counts.total.toLocaleString();
    $('#stat-dropped').textContent = data.counts.dropped.toLocaleString();
    $('#stat-processing').textContent = data.counts.processing.toLocaleString();
    $('#stat-completed').textContent = data.counts.completed.toLocaleString();
    $('#stat-issue').textContent = data.counts.issue.toLocaleString();
    renderMap(data.countries);
  }

  function statusOf(c) {
    // Rate-based, not raw-count-based: a couple of exceptions in a month of
    // hundreds of orders is normal operations, not a market in trouble.
    const issueRate = c.total > 0 ? c.issue / c.total : 0;
    if (issueRate > 0.02) return 'red';
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
    selectedCountry = selectedCountry === country ? '' : country;
    currentPage = 1;
    renderMap(lastCountries);
    loadOrders();
    updateMapFilterHint();
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

  function updateMapFilterHint() {
    const btn = $('#clear-map-filter');
    btn.hidden = !selectedCountry;
  }

  $('#clear-map-filter').addEventListener('click', () => {
    selectedCountry = '';
    currentPage = 1;
    renderMap(lastCountries);
    loadOrders();
    updateMapFilterHint();
  });

  // ---------- Orders table ----------

  let searchDebounce;
  $('#order-search').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { currentPage = 1; loadOrders(); }, 250);
  });
  $('#status-filter').addEventListener('change', () => { currentPage = 1; loadOrders(); });

  async function loadOrders() {
    const tbody = $('#orders-tbody');
    tbody.innerHTML = '<tr><td colspan="7" class="table-loading">Loading…</td></tr>';

    const params = new URLSearchParams({ page: currentPage, pageSize: 25 });
    const search = $('#order-search').value.trim();
    const status = $('#status-filter').value;
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (selectedCountry) params.set('country', selectedCountry);

    const data = await api(`/orders?${params}`);

    if (!data.rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-loading">No orders match this filter.</td></tr>';
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
        </tr>
      `).join('');
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
    const grid = $('#inventory-grid');
    const locations = await api('/inventory');
    grid.innerHTML = locations.map((loc) => `
      <div class="inv-location">
        <div class="inv-location-head">
          <h4>${loc.country_name}</h4>
          <span>${loc.city}</span>
        </div>
        ${loc.items.map((i) => `
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
    `).join('');

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
  skuSelect.innerHTML = SKU_CATALOG.map((s) => `<option value="${s.sku}" data-name="${s.name}">${s.name} (${s.sku})</option>`).join('');

  $('#open-drop-order').addEventListener('click', () => {
    $('#drop-order-error').hidden = true;
    $('#order-date').value = new Date().toISOString().slice(0, 10);
    $('#drop-order-form').reset();
    $('#order-date').value = new Date().toISOString().slice(0, 10);
    dropOverlay.hidden = false;
  });
  $('#cancel-drop-order').addEventListener('click', () => { dropOverlay.hidden = true; });
  dropOverlay.addEventListener('click', (e) => { if (e.target === dropOverlay) dropOverlay.hidden = true; });

  $('#drop-order-form').addEventListener('submit', async (e) => {
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
      loadOrders();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  // ---------- Boot ----------

  if (token) showApp(); else doLogout();
})();
