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
  const INBOUND_STATUS_LABEL = { booked: 'Booked', in_transit: 'In Transit', arrived: 'Arrived', delayed: 'Delayed', partial: 'Partial' };
  const INBOUND_MODE_LABEL = { air: 'Air', sea: 'Sea', road: 'Road' };

  let token = localStorage.getItem('nt-client-token') || '';
  let clientName = localStorage.getItem('nt-client-name') || '';
  let selectedCountry = new URLSearchParams(window.location.search).get('country') || '';
  let uploadIds = new URLSearchParams(window.location.search).get('ids') || '';
  let orderById = new Map();
  let currentPage = 1;
  let inventoryLocations = [];
  let selectedInvLocation = null;

  const $ = (sel) => document.querySelector(sel);
  const loginScreen = $('#login-screen');
  const app = $('#app');

  function authHeaders() {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  function sgDay(d = new Date()) {
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  }

  function formatEventTime(value) {
    const s = String(value || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    if (m) {
      const dt = new Date(`${m[1]}T${m[2]}Z`);
      if (!Number.isNaN(dt.getTime())) {
        return dt.toLocaleString('en-SG', { timeZone: 'Asia/Singapore', hour12: false });
      }
    }
    return s;
  }

  function syncOrdersQuery() {
    const params = new URLSearchParams();
    if (selectedCountry) params.set('country', selectedCountry);
    if (uploadIds) params.set('ids', uploadIds);
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
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
    if ($('#item-master-tbody')) loadItemMaster();
    if ($('#chart-columns')) {
      loadCharts().catch((err) => {
        const wrap = $('#chart-columns');
        if (wrap) wrap.innerHTML = `<p class="chart-empty">${escapeHtml(err.message)}</p>`;
      });
    }
    if ($('#admin-chart-columns') && !$('#company-picker')) {
      loadAdminCharts('').catch((err) => {
        const wrap = $('#admin-chart-columns');
        if (wrap) wrap.innerHTML = `<p class="chart-empty">${escapeHtml(err.message)}</p>`;
      });
    }
    if ($('#uploads-tbody')) loadClientUploads();
    revealAdminRail();
  }

  async function revealAdminRail() {
    const link = $('#rail-admin');
    const workspace = $('#company-workspace');
    const denied = $('#company-denied');
    const loading = $('#company-loading');
    try {
      const me = await api('/me');
      const isAdmin = me.clientId === 'admin';
      if (link) link.hidden = !isAdmin;
      if (workspace || denied) {
        if (isAdmin) {
          if (denied) denied.hidden = true;
          if (workspace) workspace.hidden = false;
          await loadCompaniesAdmin();
        } else {
          if (workspace) workspace.hidden = true;
          if (denied) denied.hidden = false;
        }
      }
    } catch (_) {
      if (link) link.hidden = true;
      if (workspace) workspace.hidden = true;
      if (denied) denied.hidden = false;
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function clearCompanyView() {
    const detail = $('#company-detail');
    if (detail) detail.hidden = true;
  }

  function renderCompanyOrders(orders, opts) {
    const tbody = $('#company-orders');
    if (!tbody) return;
    const all = !!(opts && opts.all);
    const rows = (orders && orders.rows) || [];
    orderById = new Map(rows.map((o) => [o.id, o]));
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="10" class="table-loading">${all ? 'No orders yet.' : 'No orders for this company yet.'}</td></tr>`;
    } else {
      tbody.innerHTML = rows.map((o) => {
        const next = o.next_label
          ? `<button type="button" class="btn btn-ghost-sm advance-order" data-advance="${escapeHtml(o.id)}">${escapeHtml(o.next_label)}</button>`
          : '—';
        return `
        <tr data-id="${escapeHtml(o.id)}">
          <td><code>${escapeHtml(o.order_ref)}</code></td>
          <td>${escapeHtml(o.client_name || '')}</td>
          <td>${escapeHtml(o.country_name || '')}</td>
          <td>${escapeHtml(o.customer_name || '')}</td>
          <td>${escapeHtml(o.product_name || '')} <span style="color:var(--fg-muted)">(${escapeHtml(o.sku || '')})</span></td>
          <td>${escapeHtml(o.qty)}</td>
          <td><span class="status-pill ${escapeHtml(o.flow_status || '')}">${escapeHtml(o.status_label || o.status || '')}</span></td>
          <td>${escapeHtml(o.due_date || '—')}</td>
          <td>${escapeHtml(o.order_date || '')}</td>
          <td>${next}</td>
        </tr>`;
      }).join('');
      tbody.querySelectorAll('tr[data-id]').forEach((row) => {
        row.addEventListener('click', () => openOrderDetail(row.dataset.id));
      });
      tbody.querySelectorAll('.advance-order').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          advanceOrder(btn.dataset.advance);
        });
      });
    }
    const note = $('#company-orders-note');
    if (note) {
      const total = orders ? Number(orders.total) || 0 : 0;
      note.textContent = total > rows.length
        ? `Showing the ${rows.length} most recent of ${total} orders.`
        : `${total} order${total === 1 ? '' : 's'}`;
    }
  }

  async function advanceOrder(id) {
    const errEl = $('#company-error');
    if (errEl) errEl.hidden = true;
    try {
      await api('/admin/orders/' + encodeURIComponent(id) + '/advance', { method: 'POST', body: '{}' });
      const picker = $('#company-picker');
      if (picker && picker.value) await showCompany(picker.value);
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    }
  }

  function renderCompanyDetail(data) {
    const detail = $('#company-detail');
    if (!detail || !data) return;
    detail.hidden = false;
    const counts = data.counts || {};
    const countsEl = $('#company-counts');
    if (countsEl) {
      const tiles = [
        ['Total', counts.total || 0, ''],
        ['Processing', counts.processing || 0, 'stat-processing'],
        ['Ready to ship', counts.ready_to_ship || 0, 'stat-ready'],
        ['Shipped', counts.shipped || 0, 'stat-shipped'],
      ];
      countsEl.innerHTML = tiles.map(([label, n, cls]) => `
        <div class="stat-tile ${cls}">
          <span class="stat-dot"></span>
          <span class="stat-label">${escapeHtml(label)}</span>
          <span class="stat-value">${Number(n).toLocaleString()}</span>
        </div>
      `).join('');
    }
    const usersEl = $('#company-users');
    if (usersEl) {
      const users = data.users || [];
      usersEl.innerHTML = users.length
        ? users.map((u) => `
          <tr>
            <td>${escapeHtml(u.name || '')}</td>
            <td><code>${escapeHtml(u.username || '')}</code></td>
            <td>${u.active ? 'Active' : 'Off'}</td>
          </tr>
        `).join('')
        : '<tr><td colspan="3" class="table-loading">No login on this company.</td></tr>';
    }
    renderCompanyOrders(data.orders);
  }

  async function showCompany(id) {
    if (!id) { clearCompanyView(); return; }
    if (id === '__all__') {
      const orders = await api('/admin/orders?pageSize=50');
      const detail = $('#company-detail');
      if (detail) detail.hidden = false;
      const usersWrap = $('#company-users-wrap');
      if (usersWrap) usersWrap.hidden = true;
      const counts = $('#company-counts');
      if (counts) counts.hidden = true;
      renderCompanyOrders(orders, { all: true });
      await loadAdminCharts('');
      return;
    }
    const usersWrap = $('#company-users-wrap');
    if (usersWrap) usersWrap.hidden = false;
    const counts = $('#company-counts');
    if (counts) counts.hidden = false;
    const data = await api('/admin/companies/' + encodeURIComponent(id));
    renderCompanyDetail(data);
    await loadAdminCharts(id);
  }

  async function loadCompaniesAdmin() {
    const picker = $('#company-picker');
    if (!picker) return;
    const list = await api('/admin/companies');
    const current = picker.value;
    picker.replaceChildren();
    const allOpt = document.createElement('option');
    allOpt.value = '__all__';
    allOpt.textContent = 'All companies';
    picker.appendChild(allOpt);
    for (const c of list) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      picker.appendChild(opt);
    }
    if (current === '__all__' || (current && list.some((c) => c.id === current))) {
      picker.value = current;
    } else {
      picker.value = '__all__';
    }
    await showCompany(picker.value);
    await loadPendingUploads();
  }

  $('#company-picker')?.addEventListener('change', () => {
    const errEl = $('#company-error');
    if (errEl) errEl.hidden = true;
    showCompany($('#company-picker').value).catch((err) => {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });
  });

  $('#company-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#company-error');
    const okEl = $('#company-ok');
    if (errEl) errEl.hidden = true;
    if (okEl) okEl.hidden = true;
    const passwordEl = $('#company-password');
    const companyName = $('#company-name').value.trim();
    try {
      const created = await api('/admin/companies', {
        method: 'POST',
        body: JSON.stringify({
          companyName,
          displayName: $('#company-display').value.trim(),
          username: $('#company-username').value.trim(),
          password: passwordEl ? passwordEl.value : '',
        }),
      });
      if (passwordEl) passwordEl.value = '';
      $('#company-form').reset();
      if (okEl) {
        okEl.textContent = `${created.company.name} is set up. They sign in to this same portal and see only their own orders.`;
        okEl.hidden = false;
      }
      await loadCompaniesAdmin();
      const picker = $('#company-picker');
      if (picker && created.company && created.company.id) {
        picker.value = created.company.id;
        await showCompany(created.company.id);
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    }
  });

  // ---------- Dashboard (stats + map) ----------

  async function loadDashboard() {
    const needsShipments = !!$('#world-map');
    const [data, shipments] = await Promise.all([
      api('/dashboard'),
      needsShipments ? api('/inbound') : Promise.resolve([]),
    ]);
    if ($('#stat-total')) {
      const counts = ($('#today-orders') && data.today) ? data.today.counts : data.counts;
      $('#stat-total').textContent = Number(counts.total || 0).toLocaleString();
      $('#stat-processing').textContent = Number(counts.processing || 0).toLocaleString();
      $('#stat-ready').textContent = Number(counts.ready_to_ship || 0).toLocaleString();
      $('#stat-shipped').textContent = Number(counts.shipped || 0).toLocaleString();
      renderMonthlyBars(data.months);
    }
    const note = $('#all-time-note');
    if (note && data.counts) {
      const c = data.counts;
      note.textContent = `All time: ${Number(c.total || 0).toLocaleString()} orders — ${Number(c.processing || 0).toLocaleString()} processing, ${Number(c.ready_to_ship || 0).toLocaleString()} ready to ship, ${Number(c.shipped || 0).toLocaleString()} shipped.`;
    }
    if ($('#today-orders')) renderTodayOrders(data.today);
    if (needsShipments) renderMap(data.countries, shipments);
  }

  function renderTodayOrders(today) {
    const tbody = $('#today-orders');
    if (!tbody) return;
    const rows = (today && today.orders) || [];
    orderById = new Map(rows.map((o) => [o.id, o]));
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-loading">No orders dated today. Uploads appear here after an administrator approves them.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((o) => `
      <tr data-id="${escapeHtml(o.id)}">
        <td><code>${escapeHtml(o.order_ref)}</code></td>
        <td>${escapeHtml(o.country_name || '')}</td>
        <td>${escapeHtml(o.customer_name || '')}</td>
        <td>${escapeHtml(o.product_name || '')} <span style="color:var(--fg-muted)">(${escapeHtml(o.sku || '')})</span></td>
        <td>${escapeHtml(o.qty)}</td>
        <td><span class="status-pill ${escapeHtml(o.flow_status || '')}">${escapeHtml(o.status_label || o.status || '')}</span></td>
        <td>${escapeHtml(o.order_date || '')}</td>
      </tr>
    `).join('');
    tbody.querySelectorAll('tr[data-id]').forEach((row) => {
      row.addEventListener('click', () => openOrderDetail(row.dataset.id));
    });
  }

  function chartBars(series) {
    const max = Math.max(1, ...series.map((d) => Number(d.n) || 0));
    return `<div class="day-bars">${series.map((d) => {
      const n = Number(d.n) || 0;
      const h = Math.round((n / max) * 100);
      return `<div class="day-bar" title="${escapeHtml(d.date)}: ${n}"><span class="day-bar-fill" style="height:${h}%"></span></div>`;
    }).join('')}</div>`;
  }

  function chartBlock(title, total, series, emptyText) {
    const empty = Number(total) === 0;
    return `<div class="chart-block"><h4>${escapeHtml(title)}</h4><p class="chart-figure">${Number(total).toLocaleString()}</p>${
      empty ? `<p class="chart-empty">${escapeHtml(emptyText)}</p>` : chartBars(series || [])
    }</div>`;
  }

  const CLIENT_CHARTS = {
    day: '#chart-day', from: '#chart-from', to: '#chart-to',
    kpis: '#chart-kpis', columns: '#chart-columns', path: '/charts',
  };
  const ADMIN_CHARTS = {
    day: '#admin-chart-day', from: '#admin-chart-from', to: '#admin-chart-to',
    kpis: '#admin-chart-kpis', columns: '#admin-chart-columns', path: '/admin/charts',
  };

  async function paintCharts(ids, clientId) {
    const wrap = $(ids.columns);
    if (!wrap) return;
    const day = $(ids.day)?.value || '';
    const from = $(ids.from)?.value || '';
    const to = $(ids.to)?.value || '';
    const params = new URLSearchParams();
    if (day) params.set('day', day);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (clientId && clientId !== '__all__') params.set('clientId', clientId);
    const data = await api(`${ids.path}?${params}`);
    if ($(ids.day) && !$(ids.day).value) $(ids.day).value = data.day;
    if ($(ids.from) && !$(ids.from).value) $(ids.from).value = data.from;
    if ($(ids.to) && !$(ids.to).value) $(ids.to).value = data.to;
    const mix = data.statusMix || {};
    const kpis = $(ids.kpis);
    if (kpis) {
      kpis.innerHTML = [
        ['Orders on this day', data.ordersInDay],
        ['Orders in period', data.ordersInPeriod],
        ['Deliveries shipped', data.deliveriesCompleted],
        ['Late deliveries', data.lateDeliveries],
        ['Processing', mix.processing || 0],
        ['Ready to ship', mix.ready_to_ship || 0],
        ['Status mix · Shipped', mix.shipped || 0],
      ].map(([label, n]) => `<div class="chart-kpi"><span>${escapeHtml(label)}</span><strong>${Number(n).toLocaleString()}</strong></div>`).join('');
    }
    wrap.innerHTML = [
      chartBlock('Orders on this day', data.ordersInDay, data.ordersOnDay, 'No orders on this day.'),
      chartBlock('Orders over the period', data.ordersInPeriod, data.ordersByDay, 'No orders in this period.'),
      chartBlock('Deliveries', data.deliveriesCompleted, data.deliveriesByDay, 'No shipped orders in this period.'),
      chartBlock('Late deliveries', data.lateDeliveries, data.lateByDay, 'No late deliveries in this period.'),
    ].join('');
  }

  function loadCharts() {
    return paintCharts(CLIENT_CHARTS);
  }

  function loadAdminCharts(clientId) {
    return paintCharts(ADMIN_CHARTS, clientId);
  }

  $('#chart-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    loadCharts().catch((err) => {
      const wrap = $('#chart-columns');
      if (wrap) wrap.innerHTML = `<p class="chart-empty">${escapeHtml(err.message)}</p>`;
    });
  });

  $('#admin-chart-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const picker = $('#company-picker');
    const clientId = picker ? picker.value : '';
    loadAdminCharts(clientId).catch((err) => {
      const wrap = $('#admin-chart-columns');
      if (wrap) wrap.innerHTML = `<p class="chart-empty">${escapeHtml(err.message)}</p>`;
    });
  });

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
    if ((c.processing || 0) > 0 || (c.ready_to_ship || 0) > 0) return 'amber';
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

  function renderMap(countries, shipments) {
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
        <div class="nt-popup-row"><span>Processing</span><span>${c.processing}</span></div>
        <div class="nt-popup-row"><span>Ready to ship</span><span>${c.ready_to_ship}</span></div>
        <div class="nt-popup-row"><span>Shipped</span><span>${c.shipped}</span></div>
      `, { className: 'nt-popup' });
      marker.on('click', () => selectMarket(c.country));
      if (selected) selectedMarker = marker;
      marker.addTo(markerLayer);
    });

    renderShipmentTrails(shipments || []);

    if (!boundsSet) {
      leafletMap.fitBounds(L.latLngBounds(allPoints), { padding: [30, 30] });
      boundsSet = true;
    }
    if (selectedMarker) selectedMarker.openPopup();
    renderMarketChips(countries);
  }

  // Shipment trails — physical inbound freight moving SG hub → DC, layered on
  // top of the same map as the order-presence lines but visually distinct
  // (solid, colored by mode) and grouped by destination since several
  // shipments can be moving to the same DC at once. Only ships still moving
  // (not yet "arrived") are drawn — an arrived shipment isn't a trail anymore.
  function renderShipmentTrails(shipments) {
    const active = shipments.filter((s) => s.status !== 'arrived' && s.lat != null && s.lng != null);
    const byDest = new Map();
    active.forEach((s) => {
      const key = `${s.lat},${s.lng}`;
      if (!byDest.has(key)) byDest.set(key, { lat: s.lat, lng: s.lng, countryName: s.country_name, city: s.city, shipments: [] });
      byDest.get(key).shipments.push(s);
    });

    byDest.forEach((dest) => {
      const hasDelayed = dest.shipments.some((s) => s.status === 'delayed');
      const primaryMode = dest.shipments[0].mode || 'air';
      const midLat = (SG_HUB.lat + dest.lat) / 2;
      const midLng = (SG_HUB.lng + dest.lng) / 2;

      L.polyline([[SG_HUB.lat, SG_HUB.lng], [dest.lat, dest.lng]], {
        color: hasDelayed ? '#9c3223' : '#0f6aa8', weight: 2, opacity: 0.85, interactive: false,
      }).addTo(markerLayer);

      const icon = L.divIcon({
        className: '',
        html: `<div class="nt-shipment-marker mode-${primaryMode}${hasDelayed ? ' status-delayed' : ''}" style="width:22px;height:22px;">${dest.shipments.length}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });

      L.marker([midLat, midLng], { icon })
        .bindPopup(`
          <span class="nt-popup-title">Inbound to ${escapeHtml(dest.countryName)}</span>
          ${dest.shipments.map((s) => `
            <div class="nt-popup-shipment">
              <div class="nt-popup-row"><span>${escapeHtml(s.reference)}</span><span>${INBOUND_STATUS_LABEL[s.status] || s.status}</span></div>
              <div class="nt-popup-row"><span>${escapeHtml(s.origin)} · ${INBOUND_MODE_LABEL[s.mode] || s.mode}</span><span>${escapeHtml(s.carrier || 'No carrier')}</span></div>
            </div>
          `).join('')}
        `, { className: 'nt-popup' })
        .addTo(markerLayer);
    });
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
    syncOrdersQuery();
    loadOrders();
  });
  $('#orders-clear-upload')?.addEventListener('click', () => {
    uploadIds = '';
    currentPage = 1;
    syncOrdersQuery();
    loadOrders();
  });

  async function loadOrders() {
    const tbody = $('#orders-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9" class="table-loading">Loading…</td></tr>';

    const filterHint = $('#orders-filter-hint');
    if (filterHint) {
      if (selectedCountry) {
        filterHint.hidden = false;
        filterHint.querySelector('.filter-country').textContent = selectedCountry;
      } else {
        filterHint.hidden = true;
      }
    }
    const uploadHint = $('#orders-upload-hint');
    if (uploadHint) uploadHint.hidden = !uploadIds;

    const params = new URLSearchParams({ page: currentPage, pageSize: 25 });
    const search = $('#order-search').value.trim();
    const status = $('#status-filter').value;
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (selectedCountry) params.set('country', selectedCountry);
    if (uploadIds) params.set('ids', uploadIds);

    const data = await api(`/orders?${params}`);
    orderById = new Map((data.rows || []).map((o) => [o.id, o]));

    if (!data.rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="table-loading">No orders match this filter.</td></tr>';
    } else {
      tbody.innerHTML = data.rows.map((o) => `
        <tr data-id="${o.id}">
          <td><code>${escapeHtml(o.order_ref)}</code></td>
          <td>${escapeHtml(o.country_name)}</td>
          <td>${escapeHtml(o.customer_name)}</td>
          <td>${escapeHtml(o.product_name)} <span style="color:var(--fg-muted)">(${escapeHtml(o.sku)})</span></td>
          <td>${o.qty}</td>
          <td><span class="status-pill ${escapeHtml(o.flow_status || '')}">${escapeHtml(o.status_label || o.status)}</span>${o.issue_note ? ` <span title="${escapeHtml(o.issue_note)}" style="cursor:help;color:var(--fg-muted)">ⓘ</span>` : ''}</td>
          <td>${escapeHtml(o.due_date || '—')}</td>
          <td>${escapeHtml(o.order_date)}</td>
          <td><button class="track-btn" data-track="${o.id}" data-ref="${escapeHtml(o.order_ref)}">Track</button></td>
        </tr>
      `).join('');
      tbody.querySelectorAll('tr[data-id]').forEach((row) => {
        row.addEventListener('click', () => openOrderDetail(row.dataset.id));
      });
      tbody.querySelectorAll('button[data-track]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openTracking(btn.dataset.track, btn.dataset.ref);
        });
      });
    }

    renderPagination(data.total, data.page, data.pageSize);
  }

  function openOrderDetail(id) {
    const o = orderById.get(id);
    const overlay = $('#order-detail-overlay');
    if (!o || !overlay) return;
    $('#order-detail-ref').textContent = o.order_ref || 'Order';
    $('#order-detail-status').textContent = o.status_label || '';
    const body = $('#order-detail-body');
    body.replaceChildren();
    const detail = o.detail || {};
    const address = [detail.address1, detail.address2, detail.city, detail.state, detail.postal].filter(Boolean).join(', ');
    const rows = [
      ['Customer', o.customer_name],
    ];
    if (address) rows.push(['Address', address]);
    if (detail.email) rows.push(['Email', detail.email]);
    if (detail.phone) rows.push(['Phone', detail.phone]);
    rows.push(
      ['Market', o.country_name],
      ['SKU', o.sku],
      ['Product', o.product_name],
      ['Quantity', o.qty],
      ['Order date', o.order_date],
      ['Due', o.due_date || '—'],
      ['Status', o.status_label],
      ['Carrier', o.carrier || '—'],
      ['Waybill', o.waybill_number || '—'],
    );
    if (o.issue_note) rows.push(['Note', o.issue_note]);
    for (const [label, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value == null || value === '' ? '—' : String(value);
      body.appendChild(dt);
      body.appendChild(dd);
    }
    overlay.hidden = false;
  }

  $('#close-order-detail')?.addEventListener('click', () => {
    const overlay = $('#order-detail-overlay');
    if (overlay) overlay.hidden = true;
  });
  $('#order-detail-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'order-detail-overlay') e.target.hidden = true;
  });

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
    $('#order-date').value = sgDay();
    $('#drop-order-form').reset();
    $('#order-date').value = sgDay();
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
        <li class="${ev.flow_status === 'shipped' ? 'done' : ''}">
          <span class="tracking-dot"></span>
          <div>
            <div class="tracking-event-status">${escapeHtml(ev.status_label || ev.status)}</div>
            ${ev.note ? `<div class="tracking-event-note">${escapeHtml(ev.note)}</div>` : ''}
            <div class="tracking-event-time">${escapeHtml(formatEventTime(ev.created_at))}</div>
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

  // ---------- Upload orders (spreadsheet template) ----------

  const uploadOverlay = $('#upload-orders-overlay');

  $('#open-upload-orders')?.addEventListener('click', () => {
    $('#upload-orders-file').value = '';
    $('#upload-orders-summary').hidden = true;
    $('#upload-orders-error').hidden = true;
    $('#submit-upload-orders').disabled = true;
    uploadOverlay.hidden = false;
  });
  $('#cancel-upload-orders')?.addEventListener('click', () => { uploadOverlay.hidden = true; });
  uploadOverlay?.addEventListener('click', (e) => { if (e.target === uploadOverlay) uploadOverlay.hidden = true; });

  $('#download-order-template')?.addEventListener('click', (e) => {
    e.preventDefault();
    downloadAuthed('/orders/template', 'nimbustrade-order-template.xlsx');
  });

  $('#download-bwl-template')?.addEventListener('click', (e) => {
    e.preventDefault();
    downloadAuthed('/orders/bwl-template', 'bwl-order-template.xlsx');
  });

  $('#upload-orders-file')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    const summaryEl = $('#upload-orders-summary');
    const errEl = $('#upload-orders-error');
    errEl.hidden = true;
    summaryEl.hidden = !file;
    $('#submit-upload-orders').disabled = !file;
    if (file) summaryEl.textContent = `${file.name} selected. The server checks every row before anything is created.`;
  });

  $('#submit-upload-orders')?.addEventListener('click', async () => {
    const errEl = $('#upload-orders-error');
    const summaryEl = $('#upload-orders-summary');
    const file = $('#upload-orders-file').files[0];
    errEl.hidden = true;
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch(`${API}/orders/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) { doLogout(); return; }
      const lines = body.errors || [];
      if (!res.ok && !lines.length) {
        errEl.textContent = body.error || 'Upload failed';
        errEl.hidden = false;
        return;
      }
      if (!res.ok) {
        errEl.textContent = body.error || 'Upload failed';
        errEl.hidden = false;
      }
      fillUploadSummary(summaryEl, body);
      loadDashboard();
      loadOrders();
      loadClientUploads();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  function fillUploadSummary(summaryEl, body) {
    const created = body.created || 0;
    const errors = body.errors || [];
    const orders = body.orders || [];
    const queued = !!body.queued;
    const n = queued ? (body.upload && body.upload.row_count) || 0 : created;
    const leadText = queued
      ? `Submitted ${n} row(s) for approval. They appear in your orders after an administrator approves them.`
      : `Imported ${created} order(s).`;
    if (summaryEl) {
      summaryEl.replaceChildren();
      const lead = document.createElement('span');
      lead.textContent = leadText;
      summaryEl.appendChild(lead);
      for (const row of errors) {
        summaryEl.appendChild(document.createElement('br'));
        const line = document.createElement('span');
        line.textContent = `Row ${row.row}: ${row.error}`;
        summaryEl.appendChild(line);
      }
      const ids = orders.map((o) => o.id).filter(Boolean);
      if (ids.length && !queued) {
        summaryEl.appendChild(document.createElement('br'));
        const a = document.createElement('a');
        a.href = `orders.html?ids=${encodeURIComponent(ids.join(','))}`;
        a.textContent = 'Open these orders';
        summaryEl.appendChild(a);
      }
      summaryEl.hidden = false;
    }
    const pageResult = $('#upload-result');
    if (pageResult && pageResult !== summaryEl) pageResult.textContent = leadText;
  }

  const UPLOAD_KIND = { orders: 'Outbound orders', items: 'Item master', inbound: 'Inbound' };

  function previewText(kind, row) {
    if (!row) return '';
    if (kind === 'orders') return [row.orderRef, row.sku && `${row.sku} ×${row.qty || ''}`].filter(Boolean).join(' · ');
    if (kind === 'items') return [row.sku, row.description].filter(Boolean).join(' · ');
    if (kind === 'inbound') return [row.reference, row.contents && `${row.contents} ×${row.expectedQty || ''}`].filter(Boolean).join(' · ');
    return '';
  }

  async function loadPendingUploads() {
    const tbody = $('#pending-uploads');
    if (!tbody) return;
    const rows = await api('/admin/uploads');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-loading">Nothing waiting for approval.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((u) => {
      const preview = (u.preview || []).map((r) => previewText(u.kind, r)).filter(Boolean).slice(0, 3).join('; ');
      const more = (u.preview || []).length > 3 ? '…' : '';
      return `<tr>
        <td>${escapeHtml(u.client_name || '')}</td>
        <td>${escapeHtml(UPLOAD_KIND[u.kind] || u.kind)}</td>
        <td>${escapeHtml(u.filename || '')}</td>
        <td>${escapeHtml(u.row_count)}</td>
        <td>${escapeHtml(preview)}${more}</td>
        <td><div class="row-actions">
          <input class="pending-note" maxlength="400" placeholder="Note" />
          <button type="button" class="btn btn-primary" data-decide="approve" data-id="${escapeHtml(u.id)}">Approve</button>
          <button type="button" class="btn btn-ghost-sm" data-decide="reject" data-id="${escapeHtml(u.id)}">Reject</button>
        </div></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-decide]').forEach((btn) => {
      btn.addEventListener('click', () => decideUpload(btn));
    });
  }

  async function decideUpload(btn) {
    const errEl = $('#company-error');
    const noteEl = btn.closest('tr')?.querySelector('.pending-note');
    const note = noteEl ? noteEl.value : '';
    try {
      await api('/admin/uploads/' + encodeURIComponent(btn.dataset.id) + '/decide', {
        method: 'POST',
        body: JSON.stringify({ action: btn.dataset.decide, note }),
      });
      await loadPendingUploads();
      const picker = $('#company-picker');
      if (picker && picker.value) await showCompany(picker.value);
    } catch (err) {
      if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
    }
  }

  async function downloadAuthed(path, filename) {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { doLogout(); return; }
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function postSpreadsheet(path, file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { doLogout(); throw new Error('Signed out'); }
    if (!res.ok && !(body.errors && body.errors.length)) throw new Error(body.error || 'Upload failed');
    return body;
  }

  async function loadClientUploads() {
    const tbody = $('#uploads-tbody');
    if (!tbody) return;
    const rows = await api('/uploads');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-loading">No submissions yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((u) => `
      <tr>
        <td>${escapeHtml(UPLOAD_KIND[u.kind] || u.kind)}</td>
        <td>${escapeHtml(u.filename || '')}</td>
        <td>${escapeHtml(u.row_count)}</td>
        <td>${escapeHtml(u.status || '')}</td>
        <td>${escapeHtml(u.note || '—')}</td>
        <td>${escapeHtml(u.created_at || '')}</td>
      </tr>
    `).join('');
  }

  async function loadItemMaster() {
    const tbody = $('#item-master-tbody');
    if (!tbody) return;
    const rows = await api('/item-master');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-loading">No SKUs yet. Download the template and submit it for approval.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td><code>${escapeHtml(r.sku)}</code></td>
        <td>${escapeHtml(r.description || '')}</td>
        <td>${escapeHtml(r.batch_details || '—')}</td>
        <td>${escapeHtml(r.serial_number || '—')}</td>
        <td>${escapeHtml(r.remark_1 || '—')}</td>
        <td>${escapeHtml(r.remark_2 || '—')}</td>
      </tr>
    `).join('');
  }

  $('#download-item-template')?.addEventListener('click', (e) => {
    e.preventDefault();
    downloadAuthed('/item-master/template', 'item-master-template.xlsx');
  });

  $('#upload-item-master')?.addEventListener('click', async () => {
    const file = $('#item-master-file')?.files[0];
    const result = $('#item-upload-result');
    if (!file) {
      if (result) result.textContent = 'Choose an item master file first.';
      return;
    }
    try {
      const body = await postSpreadsheet('/item-master/upload', file);
      const n = (body.upload && body.upload.row_count) || 0;
      const lead = body.queued
        ? `Submitted ${n} SKU row(s) for approval. They appear here after an administrator approves them.`
        : (body.error || 'Nothing was submitted.');
      if (result) result.textContent = lead;
      const errs = body.errors || [];
      if (errs.length && result) result.textContent += ' ' + errs.map((r) => `Row ${r.row}: ${r.error}`).join(' ');
      await loadItemMaster();
    } catch (err) {
      if (result) result.textContent = err.message;
    }
  });

  $('#download-inbound-template')?.addEventListener('click', (e) => {
    e.preventDefault();
    downloadAuthed('/inbound/template', 'inbound-template.xlsx');
  });

  $('#upload-inbound')?.addEventListener('click', async () => {
    const file = $('#inbound-file')?.files[0];
    const result = $('#inbound-upload-result');
    if (!file) {
      if (result) result.textContent = 'Choose an inbound file first.';
      return;
    }
    try {
      const body = await postSpreadsheet('/inbound/upload', file);
      const n = (body.upload && body.upload.row_count) || 0;
      const lead = body.queued
        ? `Submitted ${n} inbound row(s) for approval. They appear in this list after an administrator approves them.`
        : (body.error || 'Nothing was submitted.');
      if (result) result.textContent = lead;
      const errs = body.errors || [];
      if (errs.length && result) result.textContent += ' ' + errs.map((r) => `Row ${r.row}: ${r.error}`).join(' ');
      if (typeof loadReports === 'function') loadReports();
    } catch (err) {
      if (result) result.textContent = err.message;
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
    if (uploadIds) params.set('ids', uploadIds);

    const res = await fetch(`${API}/orders/export?${params}`, { headers: authHeaders() });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orders-${sgDay()}.csv`;
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
        <div class="billing-stat"><span>Shipped</span><strong>${b.despatched.toLocaleString()}</strong></div>
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
              <td>${b.despatched.toLocaleString()} shipped × ${fmtUsd(b.deliveryRate)}</td>
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

  async function loadReports() {
    const marketTbody = $('#reports-market-tbody');
    const inboundTbody = $('#reports-inbound-tbody');
    if (!marketTbody || !inboundTbody) return;
    $('#reports-generated-at').textContent = `Generated ${new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore', hour12: false })}`;

    try {
      const [dashboard, inbound] = await Promise.all([api('/dashboard'), api('/inbound')]);
      const markets = dashboard.countries;

      $('#reports-stat-outbound').textContent = dashboard.counts.total.toLocaleString();
      $('#reports-stat-processing').textContent = dashboard.counts.processing.toLocaleString();
      $('#reports-stat-ready').textContent = dashboard.counts.ready_to_ship.toLocaleString();
      $('#reports-stat-shipped').textContent = dashboard.counts.shipped.toLocaleString();
      $('#reports-stat-inbound').textContent = inbound.length.toLocaleString();
      $('#reports-stat-delayed').textContent = inbound.filter((s) => s.status === 'delayed').length.toLocaleString();

      marketTbody.innerHTML = markets.length ? markets.map((m) => `
        <tr>
          <td>${escapeHtml(m.countryName)}</td>
          <td>${m.processing}</td>
          <td>${m.ready_to_ship}</td>
          <td>${m.shipped}</td>
          <td>${m.total}</td>
        </tr>
      `).join('') : '<tr><td colspan="5" class="table-loading">No orders yet.</td></tr>';

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
      marketTbody.innerHTML = `<tr><td colspan="5" class="table-loading">${escapeHtml(err.message)}</td></tr>`;
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
    a.download = `report-${sgDay()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // ---------- Boot ----------

  if (token) showApp(); else doLogout();
})();
