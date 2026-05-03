'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  orders: [],
  stats: null,
  clients: [],
  channels: [],
  activeClient: null,
  activeChannel: null,
  activeStatus: '',
  searchQuery: '',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const fmt = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = s => new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const CHANNEL_LABELS = {
  email: 'Email', shopify: 'Shopify', amazon: 'Amazon',
  woocommerce: 'WooCommerce', web: 'Web', instagram: 'Instagram',
};

function channelBadge(ch) {
  const label = CHANNEL_LABELS[ch] || ch;
  return `<span class="badge badge-${ch}"><span class="ch-dot ch-${ch}"></span>${label}</span>`;
}

function statusBadge(s) {
  return `<span class="status status-${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</span>`;
}

// ── API ───────────────────────────────────────────────────────────────────────

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function loadAll() {
  const params = new URLSearchParams();
  if (state.activeClient)  params.set('clientId', state.activeClient);
  if (state.activeChannel) params.set('channel',  state.activeChannel);
  if (state.activeStatus)  params.set('status',   state.activeStatus);
  if (state.searchQuery)   params.set('search',   state.searchQuery);

  const [orders, stats, clients, channels] = await Promise.all([
    api('/api/orders?' + params),
    api('/api/stats'),
    api('/api/clients'),
    api('/api/channels'),
  ]);

  state.orders   = orders;
  state.stats    = stats;
  state.clients  = clients;
  state.channels = channels;

  renderAll();
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderAll() {
  renderStats();
  renderClientList();
  renderChannelList();
  renderChannelTabs();
  renderOrders();
}

function renderStats() {
  const s = state.stats;
  if (!s) return;
  $('stat-orders').textContent   = s.totalOrders;
  $('stat-revenue').textContent  = fmt(s.totalRevenue);
  $('stat-clients').textContent  = s.totalClients;
  $('stat-channels').textContent = s.totalChannels;
}

function renderClientList() {
  const ul = $('client-list');
  const total = state.stats ? state.stats.totalOrders : 0;

  const allItem = makeNavItem('All Clients', total, state.activeClient === null, () => {
    state.activeClient = null;
    loadAll();
  });
  ul.innerHTML = '';
  ul.appendChild(allItem);

  for (const c of state.clients) {
    const item = makeNavItem(c.name, c.orderCount, state.activeClient === c.id, () => {
      state.activeClient = c.id;
      loadAll();
    });
    ul.appendChild(item);
  }
}

function renderChannelList() {
  const ul = $('channel-list');
  ul.innerHTML = '';
  for (const c of state.channels) {
    const label = CHANNEL_LABELS[c.channel] || c.channel;
    const li = document.createElement('li');
    li.className = 'nav-item' + (state.activeChannel === c.channel ? ' active' : '');
    li.innerHTML = `<span class="ch-dot ch-${c.channel}"></span><span class="nav-item-name">${label}</span><span class="nav-badge">${c.count}</span>`;
    li.onclick = () => {
      state.activeChannel = state.activeChannel === c.channel ? null : c.channel;
      loadAll();
    };
    ul.appendChild(li);
  }
}

function renderChannelTabs() {
  const container = $('channel-tabs');
  const allBtn = document.createElement('button');
  allBtn.className = 'tab-btn' + (!state.activeChannel ? ' active' : '');
  allBtn.textContent = 'All';
  allBtn.onclick = () => { state.activeChannel = null; loadAll(); };
  container.innerHTML = '';
  container.appendChild(allBtn);

  for (const c of state.channels) {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (state.activeChannel === c.channel ? ' active' : '');
    btn.textContent = CHANNEL_LABELS[c.channel] || c.channel;
    btn.onclick = () => { state.activeChannel = c.channel; loadAll(); };
    container.appendChild(btn);
  }
}

function renderOrders() {
  const tbody = $('orders-body');
  if (!state.orders.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No orders found</td></tr>';
    return;
  }
  tbody.innerHTML = state.orders.map(o => `
    <tr data-id="${o.id}">
      <td><span class="order-id">${o.id}</span></td>
      <td><span class="client-name">${o.clientName}</span></td>
      <td>${channelBadge(o.channel)}</td>
      <td>${fmtDate(o.orderDate)}</td>
      <td class="items-count">${o.items.length} item${o.items.length !== 1 ? 's' : ''}</td>
      <td class="amount">${fmt(o.total)}</td>
      <td>${statusBadge(o.status)}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.onclick = () => openDetail(tr.dataset.id);
  });
}

function makeNavItem(name, count, active, onClick) {
  const li = document.createElement('li');
  li.className = 'nav-item' + (active ? ' active' : '');
  li.innerHTML = `<span class="nav-item-name">${name}</span><span class="nav-badge">${count}</span>`;
  li.onclick = onClick;
  return li;
}

// ── Order detail panel ────────────────────────────────────────────────────────

async function openDetail(id) {
  const order = await api('/api/orders/' + id);
  $('detail-title').textContent = order.id;
  $('detail-content').innerHTML = buildDetailHTML(order);
  $('detail-panel').classList.add('open');
  $('panel-overlay').classList.remove('hidden');
}

function closeDetail() {
  $('detail-panel').classList.remove('open');
  $('panel-overlay').classList.add('hidden');
}

function buildDetailHTML(o) {
  const addr = [o.shipping.addressLine1, o.shipping.addressLine2, o.shipping.city,
    (o.shipping.state ? o.shipping.state + ' ' : '') + o.shipping.zip, o.shipping.country]
    .filter(Boolean).join(', ');

  const itemsRows = o.items.map(i => `
    <tr>
      <td><div>${i.name}</div><div class="sku">${i.sku}</div></td>
      <td style="text-align:center">${i.qty}</td>
      <td style="text-align:right">${fmt(i.unitPrice)}</td>
      <td style="text-align:right;font-weight:600">${fmt(i.qty * i.unitPrice)}</td>
    </tr>
  `).join('');

  const sourceInfo = o.source.emailFrom
    ? `<div class="detail-row"><span class="dk">From</span><span class="dv">${o.source.emailFrom}</span></div>
       <div class="detail-row"><span class="dk">Subject</span><span class="dv">${o.source.emailSubject || '—'}</span></div>`
    : '';

  const notesSection = o.notes
    ? `<div class="detail-section">
         <div class="detail-section-title">Notes</div>
         <div class="notes-box">${o.notes}</div>
       </div>`
    : '';

  return `
    <div class="detail-section">
      <div class="detail-section-title">Order Info</div>
      <div class="detail-row"><span class="dk">Client</span><span class="dv">${o.clientName}</span></div>
      <div class="detail-row"><span class="dk">Channel</span><span class="dv">${channelBadge(o.channel)}</span></div>
      <div class="detail-row"><span class="dk">Date</span><span class="dv">${fmtDate(o.orderDate)}</span></div>
      <div class="detail-row"><span class="dk">Status</span><span class="dv">${statusBadge(o.status)}</span></div>
      <div class="detail-row"><span class="dk">Currency</span><span class="dv">${o.currency}</span></div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Items</div>
      <table class="items-table">
        <thead><tr><th>Product</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit</th><th style="text-align:right">Line</th></tr></thead>
        <tbody>${itemsRows}</tbody>
      </table>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Totals</div>
      <div class="totals-box">
        <div class="totals-row"><span>Subtotal</span><span>${fmt(o.subtotal)}</span></div>
        <div class="totals-row"><span>Shipping</span><span>${o.shippingCost > 0 ? fmt(o.shippingCost) : 'Free'}</span></div>
        <div class="totals-row"><span>Tax</span><span>${fmt(o.tax)}</span></div>
        <div class="totals-row total"><span>Total</span><span>${fmt(o.total)}</span></div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Ship To</div>
      <div class="detail-row"><span class="dk">Recipient</span><span class="dv">${o.shipping.recipient}</span></div>
      <div class="detail-row"><span class="dk">Address</span><span class="dv">${addr}</span></div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Source</div>
      <div class="detail-row"><span class="dk">Type</span><span class="dv">${channelBadge(o.source.type)}</span></div>
      <div class="detail-row"><span class="dk">Ingested</span><span class="dv">${fmtDate(o.source.ingestedAt)}</span></div>
      ${sourceInfo}
    </div>

    ${notesSection}
  `;
}

// ── Email ingest modal ────────────────────────────────────────────────────────

const SAMPLE_EMAIL = `---ORDER-START---
ORDER_ID: ORD-2026-021
CLIENT_ID: acme-corp
CLIENT_NAME: Acme Corp
CHANNEL: email
ORDER_DATE: 2026-05-03T15:00:00Z
STATUS: confirmed
CURRENCY: USD
NOTES: Sample ingested order

---ITEMS---
SKU|NAME|QTY|UNIT_PRICE
WIDGET-BLU|Blue Widget|2|29.99
DESK-PAD|Desk Pad XL|1|24.99

---SHIPPING---
RECIPIENT: Test Customer
ADDRESS_LINE1: 1 Example Street
ADDRESS_LINE2: Unit 7
CITY: San Francisco
STATE: CA
ZIP: 94102
COUNTRY: US

---TOTALS---
SUBTOTAL: 84.97
SHIPPING: 5.99
TAX: 7.65
TOTAL: 98.61
---ORDER-END---`;

function openModal() {
  $('ingest-modal').classList.remove('hidden');
  $('modal-overlay').classList.remove('hidden');
  $('ingest-error').classList.add('hidden');
  $('ingest-error').textContent = '';
}

function closeModal() {
  $('ingest-modal').classList.add('hidden');
  $('modal-overlay').classList.add('hidden');
}

async function submitEmail() {
  const body    = $('email-body').value.trim();
  const subject = $('email-subject').value.trim();
  const from    = $('email-from').value.trim();

  $('ingest-error').classList.add('hidden');
  if (!body) {
    showIngestError('Email body is required.');
    return;
  }

  const btn = $('btn-submit-email');
  btn.disabled = true;
  btn.textContent = 'Parsing…';

  try {
    await api('/api/orders/ingest-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, subject, from }),
    });
    closeModal();
    clearModalForm();
    await loadAll();
  } catch (err) {
    showIngestError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Parse & Add Order';
  }
}

function showIngestError(msg) {
  const el = $('ingest-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearModalForm() {
  $('email-from').value = '';
  $('email-subject').value = '';
  $('email-body').value = '';
  $('ingest-error').classList.add('hidden');
}

// ── Event listeners ───────────────────────────────────────────────────────────

$('close-detail').onclick  = closeDetail;
$('panel-overlay').onclick = closeDetail;

$('btn-ingest').onclick    = openModal;
$('close-modal').onclick   = closeModal;
$('modal-overlay').onclick = closeModal;
$('btn-cancel').onclick    = closeModal;
$('btn-submit-email').onclick = submitEmail;
$('btn-sample').onclick    = () => { $('email-body').value = SAMPLE_EMAIL; };

let searchTimer;
const onSearch = e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.searchQuery = e.target.value.trim();
    loadAll();
  }, 250);
};
$('search').oninput = onSearch;
$('search-mobile').oninput = onSearch;

// ── Hamburger / drawer ────────────────────────────────────────────────────────

const hamburger = $('hamburger');
const sidebar   = $('sidebar');

hamburger.onclick = e => {
  e.stopPropagation();
  sidebar.classList.toggle('open');
};

document.addEventListener('click', e => {
  if (sidebar.classList.contains('open') &&
      !sidebar.contains(e.target) &&
      e.target !== hamburger) {
    sidebar.classList.remove('open');
  }
});

$('status-filter').onchange = e => {
  state.activeStatus = e.target.value;
  loadAll();
};

// ── Boot ──────────────────────────────────────────────────────────────────────

loadAll();
