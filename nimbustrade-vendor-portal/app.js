(function () {
  'use strict';

  const API = '/vendor-access/api';
  let token = localStorage.getItem('nt-vendor-token') || '';
  let vendorName = localStorage.getItem('nt-vendor-name') || '';
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
      vendorName = `${body.name} (${body.country})`;
      localStorage.setItem('nt-vendor-token', token);
      localStorage.setItem('nt-vendor-name', vendorName);
      showApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  function doLogout() {
    localStorage.removeItem('nt-vendor-token');
    localStorage.removeItem('nt-vendor-name');
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
    $('#vendor-name').textContent = vendorName;
    loadDashboard();
    loadOrders();
  }

  async function loadDashboard() {
    const counts = await api('/dashboard');
    $('#stat-dropped').textContent = counts.dropped.toLocaleString();
    $('#stat-processing').textContent = counts.processing.toLocaleString();
    $('#stat-completed').textContent = counts.completed.toLocaleString();
    $('#stat-issue').textContent = counts.issue.toLocaleString();
  }

  let searchDebounce;
  $('#order-search').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { currentPage = 1; loadOrders(); }, 250);
  });
  $('#status-filter').addEventListener('change', () => { currentPage = 1; loadOrders(); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const STATUS_OPTIONS = ['dropped', 'processing', 'completed', 'issue'];

  async function loadOrders() {
    const tbody = $('#orders-tbody');
    tbody.innerHTML = '<tr><td colspan="7" class="table-loading">Loading…</td></tr>';

    const params = new URLSearchParams({ page: currentPage, pageSize: 25 });
    const search = $('#order-search').value.trim();
    const status = $('#status-filter').value;
    if (search) params.set('search', search);
    if (status) params.set('status', status);

    const data = await api(`/orders?${params}`);

    if (!data.rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-loading">No orders match this filter.</td></tr>';
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
            <div class="status-update-cell">
              <select class="status-select">
                ${STATUS_OPTIONS.map((s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
              <input type="text" class="issue-note-input" placeholder="Issue note (optional)" value="${escapeHtml(o.issue_note || '')}" />
              <button class="save-status-btn">Update</button>
            </div>
          </td>
        </tr>
      `).join('');
    }

    tbody.querySelectorAll('tr[data-id]').forEach((row) => {
      const id = row.dataset.id;
      const btn = row.querySelector('.save-status-btn');
      btn.addEventListener('click', async () => {
        const status = row.querySelector('.status-select').value;
        const issueNote = row.querySelector('.issue-note-input').value.trim();
        btn.textContent = '…';
        try {
          await api(`/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, issueNote }) });
          btn.textContent = 'Update';
          loadDashboard();
          loadOrders();
        } catch (e) {
          btn.textContent = 'Update';
          alert(e.message);
        }
      });
    });

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

  if (token) showApp(); else doLogout();
})();
