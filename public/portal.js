'use strict';
// IDEALONE Client Portal — read-only self-service for warehousing clients.
// Own login (portal:<tenant>:<client> sessions server-side); every view is
// scoped to the signed-in client and strictly read-only. No third-party
// platform or vendor names appear anywhere in this UI by design.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const num = n => (Number(n) || 0).toLocaleString();

  let token = localStorage.getItem('portal_token') || '';
  let clientName = localStorage.getItem('portal_client') || '';
  let overview = null, stock = [], orders = [], inbound = [];
  let stFilter = 'all', orFilter = 'all', ibFilter = 'all';
  let agingDays = 15, screenDays = 90, exportMaxDays = 365, slaWorkingDays = 2;
  const openOrder = new Set();      // order numbers expanded on screen
  const orderDetail = new Map();    // order_number -> line detail (lazy loaded)

  const api = (path, opts = {}) => fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token, ...(opts.headers || {}) },
  });

  // ── Dates ─────────────────────────────────────────────────────────────────
  // Everything the warehouse records is bucketed by Singapore calendar day, so
  // the portal reads days the same way rather than the viewer's own timezone.
  const SGT = { timeZone: 'Asia/Singapore' };
  const fmtDate = v => { if (!v) return ''; const d = new Date(v); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { ...SGT, day: '2-digit', month: 'short', year: 'numeric' }); };
  const fmtDateTime = v => { if (!v) return ''; const d = new Date(v); return isNaN(d) ? '' : d.toLocaleString('en-GB', { ...SGT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  const sgToday = () => new Date().toLocaleDateString('en-CA', SGT);
  // A bare YYYY-MM-DD day string (SLA due dates, ETAs) — already a calendar
  // day, so it must NOT be pushed through a timezone conversion again.
  const fmtDay = s => {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || '';
    const [y, m, d] = s.split('-');
    return `${d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]}`;
  };
  function relative(v) {
    if (!v) return '';
    const ms = Date.now() - new Date(v).getTime();
    if (isNaN(ms)) return '';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    const d = Math.floor(h / 24);
    if (d < 7) return d + (d === 1 ? ' day ago' : ' days ago');
    return fmtDate(v);
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  async function login() {
    const btn = $('liBtn');
    const client = $('liClient').value.trim();
    const password = $('liPass').value;
    $('liErr').textContent = '';
    if (!client || !password) { $('liErr').textContent = 'Enter your client name and password.'; return; }
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const r = await fetch('/api/portal/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client, password }),
      });
      const d = await r.json();
      if (!r.ok) { $('liErr').textContent = d.error || 'Sign-in failed'; return; }
      token = d.token; clientName = d.client;
      localStorage.setItem('portal_token', token);
      localStorage.setItem('portal_client', clientName);
      $('liPass').value = '';
      showApp();
    } catch (e) {
      $('liErr').textContent = 'Could not reach the server — check your connection.';
    } finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  }
  function logout() {
    api('/api/portal/logout', { method: 'POST' }).catch(() => {});
    token = ''; clientName = '';
    localStorage.removeItem('portal_token'); localStorage.removeItem('portal_client');
    overview = null; stock = []; orders = []; inbound = [];
    $('appView').classList.add('hidden');
    $('loginView').classList.remove('hidden');
  }
  function showApp() {
    $('loginView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    $('whoName').textContent = clientName;
    document.title = clientName + ' — IDEALONE Portal';
    showSkeleton();
    loadAll();
  }

  function showSkeleton() {
    $('ovHero').innerHTML = '<div class="skel" style="height:118px;border-radius:16px"></div>';
    $('ovBody').innerHTML = '<div class="grid" style="margin-top:.75rem">'
      + '<div class="skel" style="height:86px"></div>'.repeat(4) + '</div>'
      + '<div class="skel" style="height:170px;margin-top:.75rem;border-radius:14px"></div>';
  }

  // ── Load ──────────────────────────────────────────────────────────────────
  let loading = false;
  async function loadAll() {
    if (loading) return;
    loading = true;
    $('refreshBtn').classList.add('spin');
    try {
      const [ov, st, or, ib] = await Promise.all([
        api('/api/portal/overview'), api('/api/portal/stock'),
        api('/api/portal/orders'), api('/api/portal/inbound'),
      ]);
      if ([ov, st, or, ib].some(r => r.status === 401)) { logout(); return; }
      if (ov.ok) overview = await ov.json();
      if (st.ok) {
        const d = await st.json();
        stock = d.rows || [];
        if (Number.isFinite(d.agingDays)) agingDays = d.agingDays;
      }
      if (or.ok) orders = await or.json();
      if (ib.ok) {
        const d = await ib.json();
        inbound = d.rows || [];
        if (Number.isFinite(d.screenDays)) screenDays = d.screenDays;
        if (Number.isFinite(d.exportMaxDays)) exportMaxDays = d.exportMaxDays;
        if (Number.isFinite(d.slaWorkingDays)) slaWorkingDays = d.slaWorkingDays;
      }
      orderDetail.clear();
      $('agingInput').value = agingDays;
      $('asnSlaText').textContent = `${slaWorkingDays} working day${slaWorkingDays === 1 ? '' : 's'}`;
      renderOverview(); renderStock(); renderOrders(); renderInbound();
    } catch (e) {
      if (!overview) {
        $('ovHero').innerHTML = '';
        $('ovBody').innerHTML = emptyState('&#128246;', 'Cannot reach the warehouse right now',
          'Your connection dropped. Pull down or tap ↻ to try again — nothing has been lost.');
      }
    } finally {
      loading = false;
      $('refreshBtn').classList.remove('spin');
    }
  }

  const emptyState = (ic, t, s) =>
    `<div class="card empty"><div class="e-ic">${ic}</div><div class="e-t">${t}</div><div class="e-s">${s}</div></div>`;

  // ── Overview ──────────────────────────────────────────────────────────────
  function renderOverview() {
    if (!overview) return;
    const o = overview, s = o.stock || {};
    const hour = Number(new Date().toLocaleString('en-GB', { ...SGT, hour: '2-digit', hour12: false }));
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    // A plain-English summary of where things stand — the first thing a client
    // reads, and it must make sense when every number is zero.
    let line;
    if (o.openOrders > 0) {
      line = `${num(o.openOrders)} order${o.openOrders === 1 ? '' : 's'} in progress`
        + (o.openPieces ? ` — ${num(o.openPieces)} pieces being picked and packed.` : '.');
    } else if (o.inboundOpen > 0) {
      line = `No outbound orders queued. ${num(o.inboundOpen)} inbound shipment${o.inboundOpen === 1 ? '' : 's'} being received.`;
    } else if (s.skus > 0) {
      line = `Everything is up to date — no orders waiting and nothing being received.`;
    } else {
      line = `Your account is set up and ready. Stock will appear here as soon as your first shipment is received.`;
    }

    $('ovHero').innerHTML = `
      <div class="hero">
        <div class="greet">${greet}</div>
        <h2>${esc(clientName)}</h2>
        <p>${line}</p>
        <div class="live"><span class="dot"></span> Live from the warehouse${o.generatedAt ? ' · ' + fmtDateTime(o.generatedAt) : ''}</div>
      </div>`;

    const trend = o.trend || [];
    const t30 = o.last30 || {};
    const parts = [];

    // ── Key numbers
    parts.push(`
      <div class="sec">
        <div class="grid">
          <div class="tile"><div class="ic">&#128230;</div><div class="v n">${num(s.available)}</div>
            <div class="l">Available</div>
            <div class="x">${num(s.skus)} SKU${s.skus === 1 ? '' : 's'} · ${num(s.onHand)} on hand</div></div>
          <div class="tile ${s.reserved > 0 ? 't-warn' : 't-mute'}"><div class="ic">&#128274;</div><div class="v n">${num(s.reserved)}</div>
            <div class="l">Reserved</div>
            <div class="x">${s.reserved > 0 ? 'Allocated to open orders' : 'Nothing allocated'}</div></div>
          <div class="tile ${o.openOrders > 0 ? '' : 't-mute'}"><div class="ic">&#128666;</div><div class="v n">${num(o.openOrders)}</div>
            <div class="l">Orders in progress</div>
            <div class="x">${o.openPieces ? num(o.openPieces) + ' pcs to ship' : 'Nothing queued'}</div></div>
          <div class="tile t-ok"><div class="ic">&#9989;</div><div class="v n">${num(o.doneOrders)}</div>
            <div class="l">Orders shipped</div>
            <div class="x">All time</div></div>
        </div>
      </div>`);

    // ── Alerts (only when there is genuinely something to act on)
    const alerts = [];
    if (s.outOfStock > 0) alerts.push(`<div class="alert a-bad"><span>&#9888;</span><div>
      <b>${num(s.outOfStock)} SKU${s.outOfStock === 1 ? '' : 's'} out of stock</b>
      Nothing available to pick. Send a replenishment shipment to keep orders moving.</div></div>`);
    if (s.lowStock > 0) alerts.push(`<div class="alert a-warn"><span>&#128200;</span><div>
      <b>${num(s.lowStock)} SKU${s.lowStock === 1 ? '' : 's'} running low</b>
      At or below the reorder level — worth topping up soon.</div></div>`);
    if (o.openDiscrepancies > 0) alerts.push(`<div class="alert a-warn"><span>&#128203;</span><div>
      <b>${num(o.openDiscrepancies)} receiving discrepanc${o.openDiscrepancies === 1 ? 'y' : 'ies'}</b>
      Counts differed from the paperwork. Open the Inbound tab and view the receipt note for the detail.</div></div>`);
    if (o.quarantineOpen > 0) alerts.push(`<div class="alert a-bad"><span>&#128683;</span><div>
      <b>${num(o.quarantineOpen)} unit${o.quarantineOpen === 1 ? '' : 's'} in quarantine</b>
      Held aside as damaged or pending inspection — not available to sell.</div></div>`);
    if (s.aging > 0) alerts.push(`<div class="alert a-warn"><span>&#9203;</span><div>
      <b>${num(s.aging)} SKU${s.aging === 1 ? '' : 's'} not moving${s.agingPieces ? ` (${num(s.agingPieces)} pcs)` : ''}</b>
      No movement for more than ${o.agingDays} days. Open the Stock tab and tap “Aging” to see which.</div></div>`);
    if (o.inboundSlaSummary?.overdue > 0) alerts.push(`<div class="alert a-warn"><span>&#128340;</span><div>
      <b>${num(o.inboundSlaSummary.overdue)} inbound shipment${o.inboundSlaSummary.overdue === 1 ? '' : 's'} past our service level</b>
      We're behind on receiving these. Your account manager has been notified.</div></div>`);
    if (alerts.length) {
      parts.push(`<div class="sec"><div class="sec-hd"><h3>Needs attention</h3></div>${alerts.join('')}</div>`);
    } else if (s.skus > 0) {
      parts.push(`<div class="sec"><div class="alert a-ok"><span>&#10003;</span><div>
        <b>All clear</b>No stock alerts, no receiving discrepancies and nothing in quarantine.</div></div></div>`);
    }

    // ── 14-day activity
    parts.push(`
      <div class="sec">
        <div class="sec-hd"><h3>Shipping activity</h3><span class="sub">Last 14 days</span></div>
        <div class="card">${trendChart(trend)}</div>
      </div>`);

    // ── Last 30 days
    if (t30.orders > 0) {
      parts.push(`
        <div class="sec">
          <div class="sec-hd"><h3>Last 30 days</h3></div>
          <div class="card"><div class="strip">
            <div><div class="v n">${num(t30.orders)}</div><div class="l">Orders shipped</div></div>
            <div><div class="v n">${num(t30.pieces)}</div><div class="l">Pieces shipped</div></div>
            <div><div class="v n">${t30.avgLinesPerOrder}</div><div class="l">Avg lines / order</div></div>
          </div></div>
        </div>`);
    }

    // ── Receiving performance against our promise (only once there is history)
    const sl = o.inboundSlaSummary || {};
    if ((sl.met || 0) + (sl.missed || 0) > 0) {
      const total = sl.met + sl.missed;
      const pct = Math.round((sl.met / total) * 100);
      parts.push(`
        <div class="sec">
          <div class="sec-hd"><h3>Receiving service level</h3><span class="sub">D+${sl.workingDays} working days</span></div>
          <div class="card">
            <div class="row">
              <div><div style="font-size:1.5rem;font-weight:800" class="n">${pct}%</div>
                <div class="muted" style="font-size:.76rem">${num(sl.met)} of ${num(total)} shipments received within our promise</div></div>
              <div style="text-align:right">
                <span class="pill p-sla-met">${num(sl.met)} met</span>
                ${sl.missed ? `<div style="margin-top:.3rem"><span class="pill p-sla-miss">${num(sl.missed)} missed</span></div>` : ''}
              </div>
            </div>
            <div class="meter" style="height:7px;margin-top:.6rem"><i style="width:${pct}%"></i></div>
          </div>
        </div>`);
    }

    // ── Aging stock detail
    if ((o.agingList || []).length) {
      parts.push(`
        <div class="sec">
          <div class="sec-hd"><h3>Not moving</h3><span class="sub">Longest first</span></div>
          <div class="card">${o.agingList.map(r => `
            <div class="lrow">
              <div class="g"><div class="t mono">${esc(r.sku)}</div><div class="s">${esc(r.name || '—')}</div></div>
              <div class="r"><span class="pill p-aging">${r.days}d</span>
                <div class="s">${num(r.on_hand)} on hand</div></div>
            </div>`).join('')}</div>
        </div>`);
    }

    // ── Low stock detail
    if ((o.lowStockList || []).length) {
      parts.push(`
        <div class="sec">
          <div class="sec-hd"><h3>Replenish soon</h3><span class="sub">Lowest first</span></div>
          <div class="card">${o.lowStockList.map(r => `
            <div class="lrow">
              <div class="g"><div class="t mono">${esc(r.sku)}</div><div class="s">${esc(r.name || '—')}</div></div>
              <div class="r"><b class="n" style="color:${r.available <= 0 ? 'var(--bad)' : 'var(--warn)'}">${num(r.available)}</b>
                <div class="s">of ${num(r.reorder_point)} min</div></div>
            </div>`).join('')}</div>
        </div>`);
    }

    // ── Recent activity
    const act = o.activity || [];
    parts.push(`
      <div class="sec">
        <div class="sec-hd"><h3>Recent activity</h3></div>
        ${act.length ? `<div class="card">${act.map(a => {
          const out = a.kind === 'order_shipped';
          return `<div class="lrow">
            <div class="avatar ${out ? 'a-out' : 'a-in'}">${out ? '&#128666;' : '&#128229;'}</div>
            <div class="g"><div class="t">${out ? 'Order shipped' : 'Goods received'} · <span class="mono">${esc(a.ref)}</span></div>
              <div class="s">${esc(a.detail || '')}</div></div>
            <div class="r"><div class="s">${relative(a.at)}</div></div>
          </div>`;
        }).join('')}</div>`
        : emptyState('&#128339;', 'No activity yet',
            'Once your goods arrive and orders start shipping, every movement will be listed here.')}
      </div>`);

    $('ovBody').innerHTML = parts.join('');
    $('ovUpdated').textContent = 'All figures live from the warehouse system · Singapore time';
  }

  // Pure-SVG bar chart — no charting library, so nothing to load and it renders
  // identically offline. Handles the all-zero case as a real state rather than
  // an empty box.
  //
  // The bars are drawn with preserveAspectRatio="none" so they stretch to the
  // card width at any screen size. That stretch also distorts TEXT inside the
  // SVG (a label came out several times its intended width and ran off the
  // page), so every label lives in HTML underneath instead — never in the SVG.
  function trendChart(trend) {
    if (!trend.length) return '<div class="muted">No data.</div>';
    const max = Math.max(...trend.map(d => d.pieces), 0);
    const total = trend.reduce((s, d) => s + d.pieces, 0);
    const totalOrders = trend.reduce((s, d) => s + d.orders, 0);
    const W = 100, H = 60, gap = 1.5;
    const bw = (W - gap * (trend.length - 1)) / trend.length;
    const today = sgToday();
    const bars = trend.map((d, i) => {
      const h = max > 0 ? (d.pieces / max) * (H - 2) : 0;
      const x = i * (bw + gap);
      const zero = d.pieces === 0;
      const hh = zero ? 1.5 : Math.max(h, 2);
      return `<rect class="bar${zero ? ' z' : ''}" x="${x.toFixed(2)}" y="${(H - hh).toFixed(2)}"
        width="${bw.toFixed(2)}" height="${hh.toFixed(2)}" rx="0.8"><title>${esc(`${d.day} — ${d.pieces} pcs, ${d.orders} order(s)`)}</title></rect>`;
    }).join('');
    // Day ruler in HTML: first day, midpoint and "today", positioned by flexbox
    // so nothing can distort or overflow.
    const first = trend[0].day.slice(8) + '/' + trend[0].day.slice(5, 7);
    const mid = trend[Math.floor(trend.length / 2)].day;
    const midLbl = mid.slice(8) + '/' + mid.slice(5, 7);
    const endsToday = trend[trend.length - 1].day === today;
    // Nothing shipped in the whole window: a full-height chart of nothing is
    // just a big empty box. Say so in one compact line instead.
    if (total === 0) {
      return `<div class="row" style="gap:.6rem">
        <span style="font-size:1.3rem;opacity:.35">&#128202;</span>
        <div style="flex:1">
          <div style="font-weight:700;font-size:.87rem">No shipments in the last 14 days</div>
          <div class="muted" style="font-size:.78rem">Daily volume will chart here once orders start going out.</div>
        </div></div>`;
    }
    return `
      <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
           aria-label="Pieces shipped per day over the last 14 days">
        <defs><linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1e3a8a"/>
        </linearGradient></defs>
        ${bars}
      </svg>
      <div class="chart-axis"><span>${first}</span><span>${midLbl}</span><span>${endsToday ? 'today' : ''}</span></div>
      <div class="chart-legend">
        <span>${total > 0 ? `<b class="n">${num(total)}</b> pieces · <b class="n">${num(totalOrders)}</b> orders`
                          : 'No shipments in this period'}</span>
        <span>${max > 0 ? 'peak ' + num(max) + '/day' : ''}</span>
      </div>`;
  }

  // ── Stock ─────────────────────────────────────────────────────────────────
  function renderStock() {
    const q = ($('stSearch').value || '').trim().toLowerCase();
    let rows = stock.filter(r => {
      if (stFilter === 'low') { if (!(r.available > 0 && r.available <= (r.reorder_point ?? 10))) return false; }
      else if (stFilter === 'out') { if (r.available > 0) return false; }
      else if (stFilter === 'aging') { if (!r.aging) return false; }
      else if (stFilter === 'res') { if (!(r.reserved > 0)) return false; }
      if (!q) return true;
      return String(r.sku).toLowerCase().includes(q)
        || String(r.name || '').toLowerCase().includes(q)
        || String(r.barcode || '').toLowerCase().includes(q);
    });
    rows = rows.sort((a, b) => a.available - b.available || String(a.sku).localeCompare(String(b.sku)));

    if (!stock.length) {
      $('stSummary').innerHTML = '';
      $('stList').innerHTML = emptyState('&#128230;', 'No stock on record yet',
        'As soon as your first shipment is received into the warehouse, every SKU and its live count will show up here.');
      return;
    }
    const avail = stock.reduce((s, r) => s + r.available, 0);
    const onHand = stock.reduce((s, r) => s + r.on_hand, 0);
    const rsv = stock.reduce((s, r) => s + r.reserved, 0);
    $('stSummary').innerHTML = `<div class="card" style="margin-bottom:.6rem"><div class="strip">
      <div><div class="v n">${num(avail)}</div><div class="l">Available</div></div>
      <div><div class="v n">${num(onHand)}</div><div class="l">On hand</div></div>
      <div><div class="v n" style="color:${rsv ? 'var(--warn)' : 'inherit'}">${num(rsv)}</div><div class="l">Reserved</div></div>
    </div></div>`;

    if (!rows.length) {
      $('stList').innerHTML = emptyState('&#128269;', 'Nothing matches',
        'Try a different search term, or switch back to “All”.');
      return;
    }
    $('stList').innerHTML = rows.map(r => {
      const low = r.available > 0 && r.available <= (r.reorder_point ?? 10);
      const out = r.available <= 0;
      // The meter shows how much of the on-hand stock is still FREE, so it is
      // only meaningful when something is actually reserved. Drawing it
      // unconditionally made a nearly-empty SKU show a full bar (available
      // equals on-hand whenever nothing is allocated), which read as healthy.
      const showMeter = r.reserved > 0 && r.on_hand > 0;
      const pct = showMeter ? Math.max(2, Math.round((r.available / r.on_hand) * 100)) : 0;
      return `<div class="card" style="margin-bottom:.5rem">
        <div class="row">
          <div style="min-width:0;flex:1">
            <div class="t mono" style="font-weight:800;font-size:.9rem">${esc(r.sku)}</div>
            <div class="s muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name || '—')}</div>
            ${r.barcode ? `<div class="s muted mono" style="font-size:.7rem;margin-top:.1rem">${esc(r.barcode)}</div>` : ''}
          </div>
          <div style="text-align:right;white-space:nowrap">
            <div class="n" style="font-size:1.15rem;font-weight:800;color:${out ? 'var(--bad)' : low ? 'var(--warn)' : 'var(--ok)'}">${num(r.available)}</div>
            <div class="l" style="font-size:.63rem;color:var(--muted);font-weight:800;text-transform:uppercase">Available</div>
          </div>
        </div>
        ${showMeter ? `<div class="meter" title="${num(r.available)} of ${num(r.on_hand)} free to pick"><i style="width:${pct}%"></i></div>` : ''}
        <div class="row" style="margin-top:.35rem;flex-wrap:wrap;gap:.3rem">
          <span class="muted" style="font-size:.75rem">${num(r.on_hand)} on hand${r.reserved > 0 ? ` · ${num(r.reserved)} reserved` : ''}${
            r.days_since_movement !== null && r.days_since_movement !== undefined
              ? ` · last moved ${r.days_since_movement === 0 ? 'today' : r.days_since_movement + 'd ago'}` : ''}</span>
          <span style="display:flex;gap:.3rem;flex-wrap:wrap">
            ${r.aging ? `<span class="pill p-aging" title="No movement for ${r.days_since_movement} days (your threshold is ${agingDays})">&#9203; Aging ${r.days_since_movement}d</span>` : ''}
            ${out ? '<span class="pill p-bad">Out of stock</span>'
              : low ? `<span class="pill p-open">Low · min ${num(r.reorder_point ?? 10)}</span>`
                    : '<span class="pill p-done">In stock</span>'}
          </span>
        </div>
      </div>`;
    }).join('');
  }

  // ── Orders ────────────────────────────────────────────────────────────────
  const STATUS = {
    done:        { label: 'Completed',   pill: 'p-done' },
    processing:  { label: 'Being packed', pill: 'p-open' },
    pending:     { label: 'Queued',      pill: 'p-info' },
    unprocessed: { label: 'Cancelled',   pill: 'p-bad' },
  };
  const statusOf = st => STATUS[st] || STATUS.pending;

  function renderOrders() {
    const q = ($('orSearch').value || '').trim().toLowerCase();
    const rows = orders.filter(o => {
      if (orFilter === 'done' && o.status !== 'done') return false;
      if (orFilter === 'cancelled' && o.status !== 'unprocessed') return false;
      if (orFilter === 'open' && (o.status === 'done' || o.status === 'unprocessed')) return false;
      if (!q) return true;
      return String(o.order_number).toLowerCase().includes(q)
        || String(o.waybill || '').toLowerCase().includes(q);
    });

    if (!orders.length) {
      $('orSummary').innerHTML = '';
      $('orList').innerHTML = emptyState('&#128666;', 'No orders yet',
        'Every order we pick and pack for you will appear here — with its status, contents and waybill.');
      return;
    }
    const done = orders.filter(o => o.status === 'done').length;
    const open = orders.filter(o => o.status !== 'done' && o.status !== 'unprocessed').length;
    const pcs = orders.reduce((s, o) => s + (o.total_qty || 0), 0);
    $('orSummary').innerHTML = `<div class="card" style="margin-bottom:.6rem"><div class="strip">
      <div><div class="v n">${num(open)}</div><div class="l">In progress</div></div>
      <div><div class="v n" style="color:var(--ok)">${num(done)}</div><div class="l">Completed</div></div>
      <div><div class="v n">${num(pcs)}</div><div class="l">Pieces total</div></div>
    </div></div>`;

    if (!rows.length) {
      $('orList').innerHTML = emptyState('&#128269;', 'Nothing matches', 'Try a different search or filter.');
      return;
    }
    $('orList').innerHTML = rows.map(o => {
      const s = statusOf(o.status);
      const isOpen = openOrder.has(o.order_number);
      const d = orderDetail.get(o.order_number);
      return `<div class="card exp" data-order="${esc(o.order_number)}" style="margin-bottom:.5rem">
        <div class="row">
          <div style="min-width:0;flex:1">
            <div class="mono" style="font-weight:800;font-size:.9rem">${esc(o.order_number)}</div>
            <div class="muted" style="font-size:.76rem">
              ${fmtDate(o.date)} · ${num(o.lines)} line${o.lines === 1 ? '' : 's'} · ${num(o.total_qty)} pcs
            </div>
            ${o.waybill ? `<div class="muted mono" style="font-size:.7rem;margin-top:.1rem">Waybill ${esc(o.waybill)}</div>` : ''}
          </div>
          <div style="text-align:right">
            <span class="pill ${s.pill}">${s.label}</span>
            <div class="muted" style="font-size:.68rem;margin-top:.3rem">${isOpen ? '▲ hide' : '▼ details'}</div>
          </div>
        </div>
        ${isOpen ? `<div class="detail">${d ? orderDetailHtml(d) : '<div class="skel" style="height:58px"></div>'}</div>` : ''}
      </div>`;
    }).join('');
  }

  function orderDetailHtml(d) {
    if (d.error) return `<div class="muted">${esc(d.error)}</div>`;
    const meta = [];
    if (d.po_number) meta.push(`PO ${esc(d.po_number)}`);
    if (d.carrier) meta.push(esc(d.carrier));
    if (d.cartons) meta.push(`${d.cartons} carton${d.cartons === 1 ? '' : 's'}`);
    if (d.completed_at) meta.push(`Shipped ${fmtDateTime(d.completed_at)}`);
    const showPacked = d.status === 'done' || d.status === 'processing';
    return `
      ${meta.length ? `<div class="muted" style="margin-bottom:.45rem">${meta.join(' · ')}</div>` : ''}
      ${d.delivery_address ? `<div class="muted" style="margin-bottom:.45rem">&#128205; ${esc(d.delivery_address)}</div>` : ''}
      <table class="dtab"><thead><tr>
        <th>SKU</th><th>Product</th><th class="r">Ordered</th>${showPacked ? '<th class="r">Packed</th>' : ''}
      </tr></thead><tbody>
        ${d.lines.map(l => `<tr>
          <td class="mono">${esc(l.sku)}</td>
          <td>${esc(l.description || '—')}${l.batch_number ? `<div class="muted" style="font-size:.7rem">Batch ${esc(l.batch_number)}${l.expiry_date ? ' · exp ' + esc(l.expiry_date) : ''}</div>` : ''}</td>
          <td class="r n">${num(l.qty)}</td>
          ${showPacked ? `<td class="r n" style="color:${l.packed >= l.qty ? 'var(--ok)' : 'var(--warn)'}">${num(l.packed)}</td>` : ''}
        </tr>`).join('')}
      </tbody></table>`;
  }

  async function toggleOrder(orderNumber) {
    if (openOrder.has(orderNumber)) { openOrder.delete(orderNumber); renderOrders(); return; }
    openOrder.add(orderNumber);
    renderOrders();
    if (orderDetail.has(orderNumber)) return;
    try {
      const r = await api('/api/portal/order/' + encodeURIComponent(orderNumber));
      const d = await r.json();
      orderDetail.set(orderNumber, r.ok ? d : { error: d.error || 'Could not load the order detail.' });
    } catch (e) {
      orderDetail.set(orderNumber, { error: 'Could not load the order detail — check your connection.' });
    }
    if (openOrder.has(orderNumber)) renderOrders();
  }

  // ── Inbound ───────────────────────────────────────────────────────────────
  // SLA pill: GREEN when the promise was met, BLUE when it was not. While a job
  // is still open the pill shows the due date instead of a verdict — there is
  // nothing to judge yet.
  function slaPill(sla) {
    if (!sla) return '';
    if (sla.status === 'closed') {
      const d = sla.workingDaysEarly;
      const detail = d > 0 ? `${d} day${d === 1 ? '' : 's'} early` : d === 0 ? 'on time' : `${-d} day${d === -1 ? '' : 's'} late`;
      return sla.met
        ? `<span class="pill p-sla-met" title="Due ${sla.dueDay}, received ${sla.doneDay}">&#10003; SLA met · ${detail}</span>`
        : `<span class="pill p-sla-miss" title="Due ${sla.dueDay}, received ${sla.doneDay}">SLA missed · ${detail}</span>`;
    }
    const n = sla.workingDaysLeft;
    if (sla.overdue) return `<span class="pill p-overdue" title="Was due ${sla.dueDay}">Overdue by ${-n} working day${n === -1 ? '' : 's'}</span>`;
    return `<span class="pill p-due">Due ${fmtDay(sla.dueDay)}${n === 0 ? ' · today' : ` · in ${n} working day${n === 1 ? '' : 's'}`}</span>`;
  }

  function renderInbound() {
    const q = ($('ibSearch').value || '').trim().toLowerCase();
    const rows = inbound.filter(r => {
      if (ibFilter === 'done' && r.status !== 'done') return false;
      if (ibFilter === 'open' && r.status === 'done') return false;
      if (ibFilter === 'issue' && !(r.discrepancies || r.damaged)) return false;
      if (ibFilter === 'late' && !(r.sla && (r.sla.met === false || r.sla.overdue))) return false;
      if (!q) return true;
      return String(r.serial || '').toLowerCase().includes(q)
        || String(r.reference || '').toLowerCase().includes(q);
    });

    $('ibWindowNote').textContent = inbound.length
      ? `Showing the last ${screenDays} days plus anything still in progress · download up to ${exportMaxDays} days as a report`
      : '';

    if (!inbound.length) {
      $('ibSummary').innerHTML = '';
      $('ibList').innerHTML = emptyState('&#128229;', 'No shipments yet',
        'Submit an ASN above to tell us what you are sending. Once it arrives we check it in piece by piece, and each receipt appears here with a printable receipt note.');
      return;
    }
    const pcs = inbound.reduce((s, r) => s + (r.received || 0), 0);
    const closed = inbound.filter(r => r.sla && r.sla.status === 'closed');
    const met = closed.filter(r => r.sla.met).length;
    $('ibSummary').innerHTML = `<div class="card" style="margin-bottom:.6rem"><div class="strip">
      <div><div class="v n">${num(inbound.length)}</div><div class="l">Receipts</div></div>
      <div><div class="v n">${num(pcs)}</div><div class="l">Pieces in</div></div>
      <div><div class="v n" style="color:${closed.length && met === closed.length ? 'var(--ok)' : closed.length ? 'var(--brand-2)' : 'inherit'}">${closed.length ? met + '/' + closed.length : '—'}</div>
        <div class="l">SLA met</div></div>
    </div></div>`;

    if (!rows.length) {
      $('ibList').innerHTML = emptyState('&#128269;', 'Nothing matches', 'Try a different search or filter.');
      return;
    }
    $('ibList').innerHTML = rows.map(r => {
      const pct = r.expected > 0 ? Math.min(100, Math.round((r.received / r.expected) * 100)) : (r.received > 0 ? 100 : 0);
      const short = r.expected > 0 && r.received < r.expected;
      const stage = r.status === 'done' ? '<span class="pill p-done">Received</span>'
                  : r.status === 'processing' ? '<span class="pill p-open">Being checked in</span>'
                  : '<span class="pill p-info">Awaiting arrival</span>';
      const meta = [
        r.type === 'po' ? 'Inbound shipment' : 'Return',
        r.reference ? esc(r.reference) : '',
        r.submitted_at ? 'submitted ' + fmtDate(r.submitted_at) : '',
        r.eta ? 'ETA ' + fmtDay(r.eta) : '',
        r.received_at ? 'received ' + fmtDate(r.received_at) : '',
      ].filter(Boolean).join(' · ');
      return `<div class="card" style="margin-bottom:.5rem">
        <div class="row">
          <div style="min-width:0;flex:1">
            <div class="mono" style="font-weight:800;font-size:.9rem">${esc(r.serial || r.reference || '—')}</div>
            <div class="muted" style="font-size:.76rem">${meta}</div>
          </div>
          <div>${stage}</div>
        </div>
        ${r.expected > 0 ? `<div class="meter"><i class="${short ? 'w' : ''}" style="width:${pct}%"></i></div>` : ''}
        <div class="row" style="margin-top:.4rem;flex-wrap:wrap;gap:.35rem">
          <span class="muted" style="font-size:.75rem">
            ${r.expected ? `${num(r.received)} of ${num(r.expected)} expected` : `${num(r.received)} pieces received`}
            ${r.line_count ? ` · ${num(r.line_count)} line${r.line_count === 1 ? '' : 's'}` : ''}
          </span>
          <span style="display:flex;gap:.3rem;align-items:center;flex-wrap:wrap">
            ${slaPill(r.sla)}
            ${r.damaged ? `<span class="pill p-bad">${num(r.damaged)} damaged / held</span>` : ''}
            ${r.discrepancies ? `<span class="pill p-open">${num(r.discrepancies)} discrepanc${r.discrepancies === 1 ? 'y' : 'ies'}</span>` : ''}
            ${r.status === 'done' ? `<button class="link ib-grn" data-id="${esc(r.id)}">&#128196; Receipt note</button>` : ''}
          </span>
        </div>
      </div>`;
    }).join('');
    document.querySelectorAll('.ib-grn').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); openGrn(b.dataset.id); }));
  }

  // ── ASN submission ────────────────────────────────────────────────────────
  const asnMsg = (kind, text) => {
    const el = $('asnMsg');
    el.className = 'asn-msg' + (kind ? ' ' + kind : '');
    el.innerHTML = text;
    el.classList.remove('hidden');
  };
  function toggleAsnFields(show) {
    $('asnFields').classList.toggle('hidden', !show);
    $('asnUploadBtn').classList.toggle('hidden', show);
    if (!show) { $('asnFile').value = ''; $('asnRef').value = ''; $('asnEta').value = ''; }
  }
  async function submitAsn() {
    const f = $('asnFile').files[0];
    if (!f) { asnMsg('err', 'Choose your filled-in ASN file first.'); return; }
    const btn = $('asnSubmitBtn');
    btn.disabled = true; btn.textContent = 'Submitting…';
    asnMsg('busy', 'Reading your ASN…');
    try {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('reference', $('asnRef').value.trim());
      fd.append('eta', $('asnEta').value);
      // No Content-Type header — the browser must set the multipart boundary.
      const r = await fetch('/api/portal/asn', { method: 'POST', headers: { 'x-auth-token': token }, body: fd });
      const d = await r.json();
      if (!r.ok) { asnMsg('err', esc(d.error || 'That file could not be read.')); return; }
      asnMsg('', `&#10003; ASN <b>${esc(d.serial)}</b> received — ${num(d.lines)} line(s), ${num(d.pieces)} pieces.`
        + `<br>We aim to have it checked in by <b>${fmtDay(d.due)}</b>. You'll see the status update here.`);
      toggleAsnFields(false);
      loadAll();
    } catch (e) {
      asnMsg('err', 'Could not reach the server — please try again.');
    } finally { btn.disabled = false; btn.textContent = 'Submit'; }
  }

  // GRN — printable goods received note, same figures the warehouse produced.
  async function openGrn(id) {
    let g;
    try {
      const r = await api('/api/portal/grn/' + encodeURIComponent(id));
      g = await r.json();
      if (!r.ok) { alert(g.error || 'Could not load the receipt note.'); return; }
    } catch (e) { alert('Could not load the receipt note — check your connection.'); return; }
    const w = window.open('', '_blank');
    if (!w) { alert('Please allow pop-ups to view the receipt note.'); return; }
    const rows = g.lines.map(l => `<tr${l.damaged || l.kiv ? ' class="flag"' : ''}>
      <td class="mono">${esc(l.sku)}</td><td>${esc(l.description)}</td>
      <td class="n">${l.expected ?? '—'}</td><td class="n">${l.received}</td><td class="n">${l.good}</td>
      <td class="n">${l.damaged || ''}</td><td class="n">${l.kiv || ''}</td>
      <td class="n">${l.diff === null ? '' : (l.diff === 0 ? '✓' : (l.diff > 0 ? '+' + l.diff : l.diff))}</td></tr>`).join('');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>Goods Received Note ${esc(g.serial || g.reference)}</title><style>
      body{font-family:-apple-system,Arial,sans-serif;margin:26px;font-size:12.5px;color:#0b1220}
      .hd{display:flex;align-items:center;gap:12px;border-bottom:2.5px solid #1e3a8a;padding-bottom:11px;margin-bottom:14px}
      .mk{width:44px;height:44px;display:block}
      .bn{font-weight:800;letter-spacing:.08em;font-size:15px}
      .bs{color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;font-weight:700}
      h2{margin:.1em 0;font-size:16px}
      .meta{color:#475569;margin-bottom:14px;line-height:1.7}
      table{border-collapse:collapse;width:100%}
      th,td{border:1px solid #cbd5e1;padding:5px 7px;text-align:left}
      td.n,th.n{text-align:right} thead{background:#eff6ff} th{font-size:10.5px;text-transform:uppercase;letter-spacing:.03em}
      tr.flag{background:#fef2f2} .mono{font-family:ui-monospace,Menlo,monospace}
      .tot{margin-top:12px;padding:9px 11px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px}
      .ft{margin-top:20px;padding-top:10px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:10px}
      @media print{.np{display:none}body{margin:0}}</style></head><body>
      <div class="np" style="margin-bottom:12px">
        <button onclick="window.print()" style="padding:7px 13px;font-weight:700;cursor:pointer;
          border:0;border-radius:7px;background:#1e3a8a;color:#fff">&#128424; Print</button></div>
      <div class="hd"><img class="mk" src="${location.origin}/icons/idealone-mark.png" alt="IDEALONE">
        <div><div class="bn">IDEALONE</div><div class="bs">Client Portal &middot; Goods Received Note</div></div></div>
      <h2>${esc(g.serial || g.reference)}</h2>
      <div class="meta">
        <b>Client:</b> ${esc(g.client)}<br>
        <b>Source:</b> ${esc(g.source || '—')} &nbsp;·&nbsp; <b>Received:</b> ${g.ended ? new Date(g.ended).toLocaleString('en-GB', { timeZone: 'Asia/Singapore' }) + ' SGT' : '—'}<br>
        <b>Cartons:</b> ${g.cartons} &nbsp;·&nbsp; <b>Photos on file:</b> ${g.photos}
      </div>
      <table><thead><tr><th>SKU</th><th>Description</th><th class="n">Expected</th><th class="n">Received</th>
        <th class="n">Good</th><th class="n">Damaged</th><th class="n">Held</th><th class="n">Diff</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <div class="tot"><b>Totals</b> — expected ${g.totals.expected} · received ${g.totals.received} ·
        good ${g.totals.good} · damaged ${g.totals.damaged} · held ${g.totals.kiv}</div>
      ${g.discrepancies.length || g.extras.length
        ? `<h3 style="margin-top:16px;font-size:13px">&#9888; Discrepancies</h3><ul style="line-height:1.8">
            ${g.discrepancies.map(m => `<li>${esc(m.sku)} — expected ${m.expected_qty}, received ${m.scanned_qty}</li>`).join('')}
            ${g.extras.map(x => `<li>${esc(x.sku)} — ${x.scanned_qty} received but not on the paperwork</li>`).join('')}</ul>`
        : '<p style="margin-top:14px;color:#059669;font-weight:700">&#10003; No discrepancies — received exactly as documented.</p>'}
      <div class="ft">Generated ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Singapore' })} SGT from the IDEALONE Client Portal.</div>
      </body></html>`);
    w.document.close();
  }

  // ── Export ────────────────────────────────────────────────────────────────
  // fetch + blob rather than a plain link, because the download needs the
  // session token header that an <a href> cannot send.
  async function download(kind, btn, range) {
    const orig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      const qs = range ? `?from=${range.from}&to=${range.to}` : '';
      const r = await api('/api/portal/export/' + kind + qs);
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Export failed');
      }
      const blob = await r.blob();
      const cd = r.headers.get('content-disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = m ? m[1] : `${kind}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally { if (btn) { btn.disabled = false; btn.innerHTML = orig; } }
  }

  // Dated report picker. Stock is a live position so it downloads immediately;
  // orders and inbound are period reports and get the date window.
  let dlKind = null;
  function openDownload(kind) {
    dlKind = kind;
    $('dlTitle').textContent = kind === 'orders' ? 'Download orders report' : 'Download inbound report';
    $('dlHint').textContent = `Pick any period up to ${exportMaxDays} days. The screen shows the last ${screenDays} days — reports can reach further back.`;
    const to = sgToday();
    const from = new Date(Date.now() - 89 * 86400000).toLocaleDateString('en-CA', SGT);
    $('dlFrom').value = from; $('dlTo').value = to; $('dlTo').max = to; $('dlFrom').max = to;
    $('dlErr').classList.add('hidden');
    $('dlModal').classList.remove('hidden');
  }
  function closeDownload() { $('dlModal').classList.add('hidden'); dlKind = null; }

  // ── Wiring ────────────────────────────────────────────────────────────────
  document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('main > section').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + b.dataset.tab));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  function wireChips(wrapId, set) {
    const wrap = $(wrapId);
    if (!wrap) return;
    wrap.addEventListener('click', e => {
      const c = e.target.closest('.chip');
      if (!c) return;
      wrap.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c));
      set(c.dataset.f);
    });
  }
  wireChips('stChips', f => { stFilter = f; renderStock(); });
  wireChips('orChips', f => { orFilter = f; renderOrders(); });
  wireChips('ibChips', f => { ibFilter = f; renderInbound(); });

  $('liBtn').addEventListener('click', login);
  $('liClient').addEventListener('keydown', e => { if (e.key === 'Enter') $('liPass').focus(); });
  $('liPass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('logoutBtn').addEventListener('click', logout);
  $('refreshBtn').addEventListener('click', loadAll);
  $('stSearch').addEventListener('input', renderStock);
  $('orSearch').addEventListener('input', renderOrders);
  $('ibSearch').addEventListener('input', renderInbound);
  // Stock is a live position — straight download, no date window.
  $('stExport').addEventListener('click', async e => {
    const r = await download('stock', e.currentTarget);
    if (!r.ok) alert(r.error || 'Could not prepare the download.');
  });
  $('orExport').addEventListener('click', () => openDownload('orders'));
  $('ibExport').addEventListener('click', () => openDownload('inbound'));
  $('dlCancel').addEventListener('click', closeDownload);
  $('dlModal').addEventListener('click', e => { if (e.target === $('dlModal')) closeDownload(); });
  $('dlModal').querySelectorAll('.chip[data-days]').forEach(c => c.addEventListener('click', () => {
    const n = parseInt(c.dataset.days, 10);
    $('dlTo').value = sgToday();
    $('dlFrom').value = new Date(Date.now() - (n - 1) * 86400000).toLocaleDateString('en-CA', SGT);
    $('dlModal').querySelectorAll('.chip[data-days]').forEach(x => x.classList.toggle('on', x === c));
  }));
  $('dlGo').addEventListener('click', async e => {
    const from = $('dlFrom').value, to = $('dlTo').value;
    const err = $('dlErr');
    err.classList.add('hidden');
    if (!from || !to) { err.textContent = 'Choose both dates.'; err.classList.remove('hidden'); return; }
    if (from > to) { err.textContent = 'The start date is after the end date.'; err.classList.remove('hidden'); return; }
    const span = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
    if (span > exportMaxDays) {
      err.textContent = `That is ${span} days. The most you can download at once is ${exportMaxDays} days.`;
      err.classList.remove('hidden'); return;
    }
    const r = await download(dlKind, e.currentTarget, { from, to });
    if (!r.ok) { err.textContent = r.error || 'Could not prepare the download.'; err.classList.remove('hidden'); return; }
    closeDownload();
  });

  // ── ASN + aging controls ──────────────────────────────────────────────────
  $('asnTemplateBtn').addEventListener('click', async e => {
    const btn = e.currentTarget, orig = btn.innerHTML;
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await api('/api/portal/asn-template');
      if (!r.ok) throw new Error('Could not prepare the template');
      const blob = await r.blob();
      const cd = r.headers.get('content-disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = m ? m[1] : 'ASN_Template.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      asnMsg('busy', 'Template downloaded. Fill in one row per SKU, then tap <b>Submit ASN</b>.');
    } catch (err) { asnMsg('err', 'Could not download the template — please try again.'); }
    finally { btn.disabled = false; btn.innerHTML = orig; }
  });
  $('asnUploadBtn').addEventListener('click', () => { $('asnMsg').classList.add('hidden'); toggleAsnFields(true); });
  $('asnCancelBtn').addEventListener('click', () => { toggleAsnFields(false); $('asnMsg').classList.add('hidden'); });
  $('asnSubmitBtn').addEventListener('click', submitAsn);

  $('agingSave').addEventListener('click', async e => {
    const btn = e.currentTarget, orig = btn.textContent;
    const n = parseInt($('agingInput').value, 10);
    const msg = (k, t) => { const el = $('agingMsg'); el.className = 'asn-msg' + (k ? ' ' + k : ''); el.textContent = t; el.classList.remove('hidden'); };
    if (!Number.isFinite(n) || n < 1 || n > 365) { msg('err', 'Enter a number of days between 1 and 365.'); return; }
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await fetch('/api/portal/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
        body: JSON.stringify({ agingDays: n }),
      });
      const d = await r.json();
      if (!r.ok) { msg('err', d.error || 'Could not save.'); return; }
      agingDays = d.agingDays;
      msg('', `✓ Anything with no movement for more than ${d.agingDays} days is now flagged.`);
      loadAll();
    } catch (err) { msg('err', 'Could not reach the server.'); }
    finally { btn.disabled = false; btn.textContent = orig; }
  });

  // Order cards expand to show their contents.
  $('orList').addEventListener('click', e => {
    const card = e.target.closest('.card[data-order]');
    if (card) toggleOrder(card.dataset.order);
  });

  // Coming back to the tab after a while should show current numbers, not a
  // stale screen — but only refresh if it has actually been a while.
  let lastLoad = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && token && Date.now() - lastLoad > 60000) {
      lastLoad = Date.now();
      loadAll();
    }
  });

  if (token && clientName) showApp();
})();
