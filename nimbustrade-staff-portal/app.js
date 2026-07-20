(function () {
  'use strict';

  const API = '/staff-access/api';
  let token = localStorage.getItem('nt-staff-token') || '';
  let staffName = localStorage.getItem('nt-staff-name') || '';
  let ordersPage = 1;
  let allClients = [];
  let allVendors = [];

  const MARKET_PRESETS = [
    { code: 'SG', name: 'Singapore', city: 'Singapore', lat: 1.3521, lng: 103.8198 },
    { code: 'MY', name: 'Malaysia', city: 'Kuala Lumpur', lat: 3.1390, lng: 101.6869 },
    { code: 'TH', name: 'Thailand', city: 'Bangkok', lat: 13.7563, lng: 100.5018 },
    { code: 'VN', name: 'Vietnam', city: 'Ho Chi Minh City', lat: 10.8231, lng: 106.6297 },
    { code: 'ID', name: 'Indonesia', city: 'Jakarta', lat: -6.2088, lng: 106.8456 },
    { code: 'PH', name: 'Philippines', city: 'Manila', lat: 14.5995, lng: 120.9842 },
    { code: 'CN', name: 'China', city: 'Shanghai', lat: 31.2304, lng: 121.4737 },
    { code: 'AU', name: 'Australia', city: 'Sydney', lat: -33.8688, lng: 151.2093 },
    { code: 'US', name: 'United States', city: 'Los Angeles', lat: 34.0522, lng: -118.2437 },
    { code: 'CA', name: 'Canada', city: 'Toronto', lat: 43.6532, lng: -79.3832 },
    { code: 'GB', name: 'United Kingdom', city: 'London', lat: 51.5072, lng: -0.1276 },
    { code: 'AE', name: 'United Arab Emirates', city: 'Dubai', lat: 25.2048, lng: 55.2708 },
    { code: 'MX', name: 'Mexico', city: 'Mexico City', lat: 19.4326, lng: -99.1332 },
  ];

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const loginScreen = $('#login-screen');
  const app = $('#app');

  function authHeaders() {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  // ---------- Theme ----------
  const root = document.documentElement;
  const storedTheme = localStorage.getItem('nimbustrade-portal-theme');
  root.dataset.theme = storedTheme || 'dark';

  [$('#theme-toggle'), $('#login-theme-toggle')].forEach((btn) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      localStorage.setItem('nimbustrade-portal-theme', next);
    });
  });

  async function api(path, opts = {}) {
    const res = await fetch(API + path, { ...opts, headers: authHeaders() });
    if (res.status === 401) { doLogout(); throw new Error('Session expired'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
      staffName = body.name;
      localStorage.setItem('nt-staff-token', token);
      localStorage.setItem('nt-staff-name', staffName);
      showApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  function doLogout() {
    localStorage.removeItem('nt-staff-token');
    localStorage.removeItem('nt-staff-name');
    token = '';
    app.hidden = true;
    loginScreen.hidden = false;
  }

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST' }); } catch (_) {}
    doLogout();
  });

  async function showApp() {
    loginScreen.hidden = true;
    app.hidden = false;
    $('#staff-name').textContent = staffName;
    loadOverview();
    await Promise.all([loadClients(), loadVendors()]);
    loadOrders();
    loadInventory();
  }

  // ---------- Tabs ----------

  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach((b) => b.classList.remove('active'));
      $$('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`#tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // ---------- Overview ----------

  async function loadOverview() {
    const data = await api('/dashboard');
    $('#ov-dropped').textContent = data.counts.dropped.toLocaleString();
    $('#ov-processing').textContent = data.counts.processing.toLocaleString();
    $('#ov-completed').textContent = data.counts.completed.toLocaleString();
    $('#ov-issue').textContent = data.counts.issue.toLocaleString();

    const tbody = $('#by-client-table tbody');
    if (!data.byClient.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-loading">No orders yet.</td></tr>';
      return;
    }
    tbody.innerHTML = data.byClient.map((c) => `
      <tr>
        <td>${escapeHtml(c.clientName)}</td>
        <td>${c.dropped}</td>
        <td>${c.processing}</td>
        <td>${c.completed}</td>
        <td>${c.issue}</td>
        <td><strong>${c.total}</strong></td>
      </tr>
    `).join('');
  }

  // ---------- Clients ----------

  async function loadClients() {
    allClients = await api('/clients');
    const tbody = $('#clients-tbody');
    if (!allClients.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-loading">No clients yet.</td></tr>';
    } else {
      tbody.innerHTML = allClients.map((c) => `
        <tr>
          <td>${escapeHtml(c.name)}</td>
          <td>${c.order_count}</td>
          <td>${c.active_users}</td>
          <td>${c.created_at.slice(0, 10)}</td>
          <td><button class="row-action" data-add-login="${c.id}" data-name="${escapeHtml(c.name)}">+ Add login</button></td>
        </tr>
      `).join('');
      tbody.querySelectorAll('[data-add-login]').forEach((btn) => {
        btn.addEventListener('click', () => {
          $('#add-user-client-id').value = btn.dataset.addLogin;
          $('#add-user-client-name').textContent = btn.dataset.name;
          $('#add-user-error').hidden = true;
          $('#add-user-form').reset();
          $('#add-user-overlay').hidden = false;
        });
      });
    }

    const filterClient = $('#filter-client');
    const selected = filterClient.value;
    filterClient.innerHTML = '<option value="">All clients</option>' +
      allClients.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    filterClient.value = selected;
  }

  $('#open-add-client').addEventListener('click', () => {
    $('#add-client-error').hidden = true;
    $('#add-client-form').reset();
    $('#add-client-overlay').hidden = false;
  });

  $('#add-client-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#add-client-error');
    errEl.hidden = true;
    try {
      await api('/clients', { method: 'POST', body: JSON.stringify({ name: $('#new-client-name').value.trim() }) });
      $('#add-client-overlay').hidden = true;
      await loadClients();
      loadInventory();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  $('#add-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#add-user-error');
    errEl.hidden = true;
    const clientId = $('#add-user-client-id').value;
    try {
      await api(`/clients/${clientId}/users`, {
        method: 'POST',
        body: JSON.stringify({
          name: $('#new-user-name').value.trim(),
          username: $('#new-user-username').value.trim(),
          password: $('#new-user-password').value,
        }),
      });
      $('#add-user-overlay').hidden = true;
      loadClients();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  // ---------- Vendors ----------

  async function loadVendors() {
    allVendors = await api('/vendors');
    const tbody = $('#vendors-tbody');
    if (!allVendors.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-loading">No vendors yet.</td></tr>';
    } else {
      tbody.innerHTML = allVendors.map((v) => `
        <tr>
          <td>${v.country}</td>
          <td>${escapeHtml(v.name)}</td>
          <td><code>${v.username}</code></td>
          <td>${v.order_count}</td>
          <td><span class="active-badge ${v.active ? 'on' : 'off'}">${v.active ? 'Active' : 'Inactive'}</span></td>
          <td><button class="row-action" data-toggle-vendor="${v.id}" data-active="${v.active}">${v.active ? 'Deactivate' : 'Activate'}</button></td>
        </tr>
      `).join('');
      tbody.querySelectorAll('[data-toggle-vendor]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const active = btn.dataset.active === '1' || btn.dataset.active === 'true';
          await api(`/vendors/${btn.dataset.toggleVendor}/active`, { method: 'PATCH', body: JSON.stringify({ active: !active }) });
          loadVendors();
        });
      });
    }

    const filterVendor = $('#filter-vendor');
    const selected = filterVendor.value;
    filterVendor.innerHTML = '<option value="">All vendors</option>' +
      allVendors.map((v) => `<option value="${v.id}">${escapeHtml(v.name)} (${v.country})</option>`).join('');
    filterVendor.value = selected;
  }

  $('#open-add-vendor').addEventListener('click', () => {
    $('#add-vendor-error').hidden = true;
    $('#add-vendor-form').reset();
    $('#add-vendor-overlay').hidden = false;
  });

  $('#add-vendor-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#add-vendor-error');
    errEl.hidden = true;
    try {
      await api('/vendors', {
        method: 'POST',
        body: JSON.stringify({
          country: $('#new-vendor-country').value,
          name: $('#new-vendor-name').value.trim(),
          username: $('#new-vendor-username').value.trim(),
          password: $('#new-vendor-password').value,
        }),
      });
      $('#add-vendor-overlay').hidden = true;
      loadVendors();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  // ---------- Modal close handlers ----------

  $$('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => { $(`#${btn.dataset.close}`).hidden = true; });
  });
  $$('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });
  });

  // ---------- Orders (master log) ----------

  const STATUS_OPTIONS = ['dropped', 'processing', 'completed', 'issue'];
  let searchDebounce;
  $('#order-search').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { ordersPage = 1; loadOrders(); }, 250);
  });
  ['#filter-client', '#filter-country', '#filter-status', '#filter-vendor'].forEach((sel) => {
    $(sel).addEventListener('change', () => { ordersPage = 1; loadOrders(); });
  });

  async function loadOrders() {
    const tbody = $('#orders-tbody');
    tbody.innerHTML = '<tr><td colspan="8" class="table-loading">Loading…</td></tr>';

    const params = new URLSearchParams({ page: ordersPage, pageSize: 25 });
    const search = $('#order-search').value.trim();
    if (search) params.set('search', search);
    if ($('#filter-client').value) params.set('clientId', $('#filter-client').value);
    if ($('#filter-country').value) params.set('country', $('#filter-country').value);
    if ($('#filter-status').value) params.set('status', $('#filter-status').value);
    if ($('#filter-vendor').value) params.set('vendorId', $('#filter-vendor').value);

    const data = await api(`/orders?${params}`);

    if (!data.rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-loading">No orders match this filter.</td></tr>';
    } else {
      tbody.innerHTML = data.rows.map((o) => `
        <tr data-id="${o.id}">
          <td><code>${o.order_ref}</code></td>
          <td>${escapeHtml(o.client_name || '')}</td>
          <td>${o.country_name}</td>
          <td>${escapeHtml(o.product_name)} <span style="color:var(--fg-muted)">(${o.sku})</span></td>
          <td>${o.qty}</td>
          <td>${o.order_date}</td>
          <td>
            <select class="vendor-select">
              ${allVendors.filter((v) => v.country === o.country).map((v) => `<option value="${v.id}" ${v.id === o.vendor_id ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('')}
            </select>
          </td>
          <td>
            <div class="status-update-cell">
              <select class="status-select">
                ${STATUS_OPTIONS.map((s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
              <input type="text" class="issue-note-input" placeholder="Note" value="${escapeHtml(o.issue_note || '')}" />
              <button class="save-order-btn">Save</button>
            </div>
          </td>
        </tr>
      `).join('');
    }

    tbody.querySelectorAll('tr[data-id]').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.save-order-btn').addEventListener('click', async () => {
        const btn = row.querySelector('.save-order-btn');
        const status = row.querySelector('.status-select').value;
        const issueNote = row.querySelector('.issue-note-input').value.trim();
        const vendorId = row.querySelector('.vendor-select').value;
        btn.textContent = '…';
        try {
          await api(`/orders/${id}`, { method: 'PATCH', body: JSON.stringify({ status, issueNote, vendorId }) });
          btn.textContent = 'Saved';
          setTimeout(() => { btn.textContent = 'Save'; }, 1200);
          loadOverview();
        } catch (e) {
          btn.textContent = 'Save';
          alert(e.message);
        }
      });
    });

    renderOrdersPagination(data.total, data.page, data.pageSize);
  }

  function renderOrdersPagination(total, page, pageSize) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const el = $('#orders-pagination');
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
      btn.addEventListener('click', () => { ordersPage = parseInt(btn.dataset.page); loadOrders(); });
    });
  }

  // ---------- Inventory — maintained per client ----------

  // Populate the market preset dropdown once.
  $('#new-location-preset').innerHTML = MARKET_PRESETS.map((m) =>
    `<option value="${m.code}" data-name="${m.name}" data-city="${m.city}" data-lat="${m.lat}" data-lng="${m.lng}">${m.name}</option>`
  ).join('');

  function applyLocationPreset() {
    const opt = $('#new-location-preset').selectedOptions[0];
    $('#new-location-city').value = opt.dataset.city;
    $('#new-location-lat').value = opt.dataset.lat;
    $('#new-location-lng').value = opt.dataset.lng;
  }
  $('#new-location-preset').addEventListener('change', applyLocationPreset);

  async function loadInventory() {
    const container = $('#inventory-clients');
    const [locations, inventory] = await Promise.all([api('/locations'), api('/inventory')]);

    if (!allClients.length) {
      container.innerHTML = '<p class="table-loading">Add a client first, from the Clients tab.</p>';
      return;
    }

    container.innerHTML = allClients.map((client) => {
      const clientLocations = locations.filter((l) => l.client_id === client.id);
      const locationsHtml = clientLocations.length
        ? clientLocations.map((loc) => {
            const items = inventory.filter((i) => i.location_id === loc.id);
            const itemsHtml = items.length
              ? items.map((i) => `
                  <div class="inv-item-row" data-id="${i.id}">
                    <div class="item-name">${escapeHtml(i.product_name)}<small>${i.sku}</small></div>
                    <span class="item-label">qty</span><input type="number" class="qty-input" min="0" value="${i.qty_on_hand}" />
                    <span class="item-label">alert at</span><input type="number" class="threshold-input" min="0" value="${i.replenish_threshold}" />
                    ${i.lowStock ? '<span class="active-badge off">Low stock</span>' : '<span class="active-badge on">OK</span>'}
                    <button class="row-action save-inv-btn">Save</button>
                  </div>
                `).join('')
              : '<p class="empty-note">No inventory items yet.</p>';
            return `
              <div class="location-block" data-location-id="${loc.id}">
                <div class="location-head">
                  <h4>${loc.country_name}</h4>
                  <span>${escapeHtml(loc.city)} &nbsp;·&nbsp; <button class="row-action" data-add-item="${loc.id}">+ Add item</button></span>
                </div>
                ${itemsHtml}
              </div>
            `;
          }).join('')
        : '<p class="empty-note">No fulfillment locations yet — add one to start tracking inventory.</p>';

      return `
        <div class="panel client-inv-panel">
          <div class="client-inv-head">
            <h3>${escapeHtml(client.name)}</h3>
            <button class="btn btn-ghost-sm" data-add-location="${client.id}" data-name="${escapeHtml(client.name)}">+ Add Location</button>
          </div>
          ${locationsHtml}
        </div>
      `;
    }).join('');

    container.querySelectorAll('[data-add-location]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('#add-location-client-id').value = btn.dataset.addLocation;
        $('#add-location-client-name').textContent = btn.dataset.name;
        $('#add-location-error').hidden = true;
        $('#add-location-form').reset();
        $('#new-location-preset').selectedIndex = 0;
        applyLocationPreset();
        $('#add-location-overlay').hidden = false;
      });
    });

    container.querySelectorAll('[data-add-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('#add-item-location-id').value = btn.dataset.addItem;
        $('#add-item-error').hidden = true;
        $('#add-item-form').reset();
        $('#add-item-overlay').hidden = false;
      });
    });

    container.querySelectorAll('.inv-item-row[data-id]').forEach((row) => {
      row.querySelector('.save-inv-btn').addEventListener('click', async () => {
        const qty = parseInt(row.querySelector('.qty-input').value, 10);
        const threshold = parseInt(row.querySelector('.threshold-input').value, 10);
        await api(`/inventory/${row.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ qty, threshold }) });
        loadInventory();
      });
    });
  }

  $('#add-location-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#add-location-error');
    errEl.hidden = true;
    const clientId = $('#add-location-client-id').value;
    const opt = $('#new-location-preset').selectedOptions[0];
    try {
      await api(`/clients/${clientId}/locations`, {
        method: 'POST',
        body: JSON.stringify({
          country: opt.value,
          countryName: opt.dataset.name,
          city: $('#new-location-city').value.trim(),
          lat: parseFloat($('#new-location-lat').value),
          lng: parseFloat($('#new-location-lng').value),
        }),
      });
      $('#add-location-overlay').hidden = true;
      loadInventory();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  $('#add-item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#add-item-error');
    errEl.hidden = true;
    const locationId = $('#add-item-location-id').value;
    try {
      await api(`/locations/${locationId}/inventory`, {
        method: 'POST',
        body: JSON.stringify({
          sku: $('#new-item-sku').value.trim(),
          productName: $('#new-item-name').value.trim(),
          qty: parseInt($('#new-item-qty').value, 10) || 0,
          threshold: parseInt($('#new-item-threshold').value, 10) || 0,
        }),
      });
      $('#add-item-overlay').hidden = true;
      loadInventory();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  // ---------- Boot ----------

  if (token) showApp(); else doLogout();
})();
