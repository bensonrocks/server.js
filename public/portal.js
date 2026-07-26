'use strict';
// IDEALONE Client Portal — read-only self-service for 3PL clients.
// Own login (portal:<tenant>:<client> sessions server-side); every view is
// scoped to the signed-in client and strictly read-only.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let token = localStorage.getItem('portal_token') || '';
  let clientName = localStorage.getItem('portal_client') || '';
  let stock = [], orders = [], inbound = [];

  const api = (path, opts = {}) => fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'x-auth-token': token, ...(opts.headers || {}) } });

  // ── Login ────────────────────────────────────────────────────────────────
  async function login() {
    const client = $('liClient').value.trim();
    const password = $('liPass').value;
    $('liErr').textContent = '';
    if (!client || !password) { $('liErr').textContent = 'Enter your client name and password.'; return; }
    try {
      const r = await fetch('/api/portal/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, password }) });
      const d = await r.json();
      if (!r.ok) { $('liErr').textContent = d.error || 'Login failed'; return; }
      token = d.token; clientName = d.client;
      localStorage.setItem('portal_token', token);
      localStorage.setItem('portal_client', clientName);
      showApp();
    } catch (e) { $('liErr').textContent = e.message; }
  }
  function logout() {
    api('/api/portal/logout', { method: 'POST' }).catch(() => {});
    token = ''; clientName = '';
    localStorage.removeItem('portal_token'); localStorage.removeItem('portal_client');
    $('appView').classList.add('hidden'); $('loginView').classList.remove('hidden');
  }
  function showApp() {
    $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden');
    $('whoName').textContent = clientName;
    loadAll();
  }

  // ── Data loads ───────────────────────────────────────────────────────────
  async function loadAll() {
    try {
      const [ov, st, or, ib] = await Promise.all([
        api('/api/portal/overview'), api('/api/portal/stock'), api('/api/portal/orders'), api('/api/portal/inbound'),
      ]);
      if (ov.status === 401) { logout(); return; }
      renderOverview(ov.ok ? await ov.json() : {});
      stock = st.ok ? await st.json() : []; renderStock();
      orders = or.ok ? await or.json() : []; renderOrders();
      inbound = ib.ok ? await ib.json() : []; renderInbound();
    } catch (e) { /* offline — leave last view */ }
  }
  function renderOverview(o) {
    const s = o.stock || {};
    $('ovTiles').innerHTML = `
      <div class="tile"><div class="v">${s.skus ?? 0}</div><div class="l">SKUs</div></div>
      <div class="tile"><div class="v">${s.available ?? 0}</div><div class="l">Available pcs</div></div>
      <div class="tile"><div class="v">${s.onHand ?? 0}</div><div class="l">On hand</div></div>
      <div class="tile"><div class="v" style="color:var(--warn)">${s.reserved ?? 0}</div><div class="l">Reserved</div></div>
      <div class="tile"><div class="v">${o.openOrders ?? 0}</div><div class="l">Orders in progress</div></div>
      <div class="tile"><div class="v" style="color:var(--ok)">${o.doneOrders ?? 0}</div><div class="l">Orders completed</div></div>
      <div class="tile"><div class="v">${o.inboundOpen ?? 0}</div><div class="l">Inbound receiving</div></div>
      <div class="tile"><div class="v" style="color:${(o.quarantineOpen || 0) > 0 ? 'var(--bad)' : 'var(--ok)'}">${o.quarantineOpen ?? 0}</div><div class="l">Units in quarantine</div></div>`;
    $('ovUpdated').textContent = 'Live as of ' + new Date().toLocaleString();
  }
  function renderStock() {
    const q = ($('stSearch').value || '').toLowerCase();
    const rows = stock.filter(r => !q || r.sku.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q));
    $('stList').innerHTML = rows.length ? rows.map(r => `
      <div class="card row">
        <div style="min-width:0"><b class="mono">${esc(r.sku)}</b><div class="muted">${esc(r.name || '')}</div></div>
        <div style="text-align:right;white-space:nowrap">
          <b style="color:${r.available <= 0 ? 'var(--bad)' : 'var(--ok)'}">${r.available}</b> avail
          <div class="muted">${r.on_hand} on hand · ${r.reserved} rsv</div>
        </div>
      </div>`).join('') : '<div class="empty">No stock records yet.</div>';
  }
  const orderPill = st => st === 'done' ? '<span class="pill p-done">Completed</span>'
    : st === 'processing' ? '<span class="pill p-open">Packing</span>'
    : st === 'unprocessed' ? '<span class="pill p-bad">Cancelled</span>'
    : '<span class="pill p-open">Queued</span>';
  function renderOrders() {
    const q = ($('orSearch').value || '').toLowerCase();
    const rows = orders.filter(o => !q || o.order_number.toLowerCase().includes(q));
    $('orList').innerHTML = rows.length ? rows.map(o => `
      <div class="card row">
        <div style="min-width:0"><b class="mono">${esc(o.order_number)}</b>
          <div class="muted">${o.date ? new Date(o.date).toLocaleDateString() : ''} · ${o.lines} line(s) · ${o.total_qty} pcs${o.waybill ? ' · ' + esc(o.waybill) : ''}</div>
        </div>
        <div>${orderPill(o.status)}</div>
      </div>`).join('') : '<div class="empty">No orders yet.</div>';
  }
  function renderInbound() {
    $('ibList').innerHTML = inbound.length ? inbound.map(r => `
      <div class="card">
        <div class="row">
          <div><b class="mono">${esc(r.serial || r.reference)}</b>
            <div class="muted">${r.type === 'po' ? 'PO/ASN' : 'Return'}${r.reference ? ' · ' + esc(r.reference) : ''}${r.received_at ? ' · ' + new Date(r.received_at).toLocaleDateString() : ''}</div>
          </div>
          <div>${r.status === 'done' ? '<span class="pill p-done">Received</span>' : '<span class="pill p-open">Receiving</span>'}</div>
        </div>
        <div class="muted" style="margin-top:.4rem">
          ${r.expected ? `expected ${r.expected} · ` : ''}received ${r.received}
          ${r.damaged ? ` · <span style="color:var(--bad);font-weight:700">${r.damaged} damaged/KIV</span>` : ''}
          ${r.discrepancies ? ` · <span style="color:var(--warn);font-weight:700">${r.discrepancies} discrepancy</span>` : ''}
          ${r.status === 'done' ? ` · <button class="link ib-grn" data-id="${esc(r.id)}">📄 View GRN</button>` : ''}
        </div>
      </div>`).join('') : '<div class="empty">No inbound receipts yet.</div>';
    document.querySelectorAll('.ib-grn').forEach(b => b.addEventListener('click', () => openGrn(b.dataset.id)));
  }

  // GRN — printable, same layout the warehouse produces.
  async function openGrn(id) {
    let g;
    try { const r = await api('/api/portal/grn/' + encodeURIComponent(id)); g = await r.json(); if (!r.ok) { alert(g.error || 'Could not load'); return; } }
    catch (e) { alert(e.message); return; }
    const w = window.open('', '_blank');
    if (!w) { alert('Please allow pop-ups to view the GRN.'); return; }
    const rows = g.lines.map(l => `<tr${l.damaged || l.kiv ? ' style="background:#fef2f2"' : ''}><td>${esc(l.sku)}</td><td>${esc(l.description)}</td><td class="n">${l.expected ?? '—'}</td><td class="n">${l.received}</td><td class="n">${l.good}</td><td class="n">${l.damaged || ''}</td><td class="n">${l.kiv || ''}</td><td class="n">${l.diff === null ? '' : (l.diff === 0 ? '✓' : (l.diff > 0 ? '+' + l.diff : l.diff))}</td></tr>`).join('');
    w.document.write(`<html><head><title>GRN ${esc(g.serial || g.reference)}</title><style>
      body{font-family:sans-serif;margin:20px;font-size:13px}h2{margin:.1em 0}.meta{color:#555;margin-bottom:12px}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:5px 7px;text-align:left}td.n,th.n{text-align:right}thead{background:#f1f5f9}
      @media print{.np{display:none}}</style></head><body>
      <div class="np" style="margin-bottom:10px"><button onclick="window.print()">🖨 Print</button></div>
      <h2>Goods Received Note — ${esc(g.serial || g.reference)}</h2>
      <div class="meta">Client: <b>${esc(g.client)}</b> · Source: ${esc(g.source || '—')} · Received: ${g.ended ? new Date(g.ended).toLocaleString() : '—'} · Cartons: ${g.cartons} · Photos: ${g.photos}</div>
      <table><thead><tr><th>SKU</th><th>Description</th><th class="n">Expected</th><th class="n">Received</th><th class="n">Good</th><th class="n">Damaged</th><th class="n">KIV</th><th class="n">Diff</th></tr></thead><tbody>${rows}</tbody></table>
      <p><b>Totals</b> — expected ${g.totals.expected} · received ${g.totals.received} · good ${g.totals.good} · damaged ${g.totals.damaged} · KIV ${g.totals.kiv}</p>
      ${g.discrepancies.length || g.extras.length ? `<h3>⚠ Discrepancies</h3><ul>${g.discrepancies.map(m => `<li>${esc(m.sku)}: expected ${m.expected_qty}, received ${m.scanned_qty}</li>`).join('')}${g.extras.map(x => `<li>${esc(x.sku)}: ${x.scanned_qty} received but not on the paperwork</li>`).join('')}</ul>` : '<p>✓ No discrepancies.</p>'}
      </body></html>`);
    w.document.close();
  }

  // ── Tabs + wiring ────────────────────────────────────────────────────────
  document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('main > section').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + b.dataset.tab));
  }));
  $('liBtn').addEventListener('click', login);
  $('liPass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('logoutBtn').addEventListener('click', logout);
  $('refreshBtn').addEventListener('click', loadAll);
  $('stSearch').addEventListener('input', renderStock);
  $('orSearch').addEventListener('input', renderOrders);

  if (token && clientName) showApp();
})();
