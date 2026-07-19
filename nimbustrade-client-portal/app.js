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
  const MAP_W = 1000, MAP_H = 460;

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

  function project(lat, lng) {
    const x = (lng + 180) / 360 * MAP_W;
    const y = (90 - lat) / 180 * MAP_H;
    return [x, y];
  }

  function statusOf(c) {
    // Rate-based, not raw-count-based: a couple of exceptions in a month of
    // hundreds of orders is normal operations, not a market in trouble.
    const issueRate = c.total > 0 ? c.issue / c.total : 0;
    if (issueRate > 0.02) return 'red';
    if (c.processing > 0 || c.dropped > 0) return 'amber';
    return 'green';
  }

  function renderMap(countries) {
    const svg = $('#world-map');
    const parts = [];

    // Graticule
    for (let lng = -160; lng <= 160; lng += 40) {
      const [x1] = project(0, lng);
      parts.push(`<line class="map-graticule" x1="${x1}" y1="0" x2="${x1}" y2="${MAP_H}" />`);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const [, y1] = project(lat, 0);
      parts.push(`<line class="map-graticule" x1="0" y1="${y1}" x2="${MAP_W}" y2="${y1}" />`);
    }

    const [hx, hy] = project(SG_HUB.lat, SG_HUB.lng);

    // Trade-route arcs from Singapore hub to each market
    countries.forEach((c) => {
      const [cx, cy] = project(c.lat, c.lng);
      const midX = (hx + cx) / 2;
      const midY = Math.min(hy, cy) - 40;
      parts.push(`<path class="map-hub-line" d="M ${hx} ${hy} Q ${midX} ${midY} ${cx} ${cy}" />`);
    });

    // Hub marker
    parts.push(`
      <g>
        <circle class="map-hub" cx="${hx}" cy="${hy}" r="4.5" />
        <text class="map-hub-label" x="${hx + 10}" y="${hy + 4}">SG · HUB</text>
      </g>
    `);

    // Country markers
    countries.forEach((c) => {
      const [cx, cy] = project(c.lat, c.lng);
      const status = statusOf(c);
      const r = Math.max(7, Math.min(16, 6 + Math.sqrt(c.total) * 0.9));
      const selected = c.country === selectedCountry ? 'selected' : '';
      parts.push(`
        <g class="map-marker status-${status} ${selected}" data-country="${c.country}"
           data-name="${c.countryName}" data-dropped="${c.dropped}" data-processing="${c.processing}"
           data-completed="${c.completed}" data-issue="${c.issue}" data-total="${c.total}"
           data-cx="${cx}" data-cy="${cy}">
          <circle class="marker-ring" cx="${cx}" cy="${cy}" r="${r + 6}" />
          <circle class="marker-dot" cx="${cx}" cy="${cy}" r="${r}" />
          <text x="${cx}" y="${cy - r - 10}" text-anchor="middle">${c.country}</text>
          <text class="marker-count" x="${cx}" y="${cy - r + 2}" text-anchor="middle" dy="0">${c.total}</text>
        </g>
      `);
    });

    svg.innerHTML = parts.join('');

    svg.querySelectorAll('.map-marker').forEach((el) => {
      el.addEventListener('mouseenter', () => showTooltip(el));
      el.addEventListener('mouseleave', hideTooltip);
      el.addEventListener('click', () => {
        selectedCountry = selectedCountry === el.dataset.country ? '' : el.dataset.country;
        renderMap(countries);
        currentPage = 1;
        loadOrders();
        updateMapFilterHint();
      });
    });
  }

  function showTooltip(el) {
    const tt = $('#map-tooltip');
    const wrap = $('.map-wrap');
    const wrapRect = wrap.getBoundingClientRect();
    const svgRect = $('#world-map').getBoundingClientRect();
    const scaleX = svgRect.width / MAP_W;
    const scaleY = svgRect.height / MAP_H;
    const cx = parseFloat(el.dataset.cx) * scaleX + (svgRect.left - wrapRect.left);
    const cy = parseFloat(el.dataset.cy) * scaleY + (svgRect.top - wrapRect.top);

    tt.innerHTML = `
      <strong>${el.dataset.name}</strong>
      <div class="tt-row"><span>Dropped</span><span>${el.dataset.dropped}</span></div>
      <div class="tt-row"><span>Processing</span><span>${el.dataset.processing}</span></div>
      <div class="tt-row"><span>Completed</span><span>${el.dataset.completed}</span></div>
      <div class="tt-row"><span>Issues</span><span>${el.dataset.issue}</span></div>
    `;
    tt.style.left = `${cx}px`;
    tt.style.top = `${cy}px`;
    tt.hidden = false;
  }

  function hideTooltip() { $('#map-tooltip').hidden = true; }

  function updateMapFilterHint() {
    const btn = $('#clear-map-filter');
    btn.hidden = !selectedCountry;
  }

  $('#clear-map-filter').addEventListener('click', () => {
    selectedCountry = '';
    currentPage = 1;
    loadDashboard();
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
