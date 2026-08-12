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
  // Which of the client's logins this is, and what it may do. Re-confirmed
  // against the server on every load — a stale copy in localStorage must never
  // be what decides whether the Send tab appears.
  let portalUser = (() => { try { return JSON.parse(localStorage.getItem('portal_user') || 'null'); } catch { return null; } })();
  const canWrite = () => (portalUser?.access || 'full') !== 'view';
  let overview = null, stock = [], orders = [], inbound = [];
  let stFilter = 'all', orFilter = 'all', ibFilter = 'all';
  let agingDays = 15, screenDays = 90, exportMaxDays = 365, slaWorkingDays = 2;
  const openOrder = new Set();      // order numbers expanded on screen
  const orderDetail = new Map();    // order_number -> line detail (lazy loaded)

  // ── Faults reach US, not the client ───────────────────────────────────────
  // Per the user: if the portal hits an error, it is notified through System
  // Outages. Deliberately NOT the office/driver treatment — those show a stack
  // trace and ask the person to send it to us, which is fine for our own staff
  // and our own drivers but not for a customer. A client sees one calm
  // sentence; the diagnosable part is posted to /api/errors (app: 'portal') so
  // it lands in the Administrator's outage panel with the client's name on it.
  const _faultSeen = new Set();
  function reportFault(detail, context) {
    try {
      const text = detail && detail.stack ? String(detail.stack)
                 : detail && detail.message ? String(detail.message)
                 : String(detail == null ? 'Unknown error' : detail);
      // Never let a repeating fault (a render loop, a poll that keeps failing)
      // turn into a flood of requests. The server counts recurrences on its
      // own row, so it loses nothing by hearing it once per session.
      const key = String(context) + '|' + text.split('\n')[0].slice(0, 160);
      if (_faultSeen.has(key)) return;
      _faultSeen.add(key);
      fetch('/api/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'x-auth-token': token } : {}) },
        body: JSON.stringify({
          app: 'portal', message: text, context: context || '', stack: text,
          page: location.pathname + (location.hash || ''), userAgent: navigator.userAgent,
        }),
      }).catch(() => {});   // reporting a fault must never raise one
    } catch (_) { /* ditto */ }
  }
  function showFault(msg) {
    let el = document.getElementById('pfFault');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pfFault'; el.className = 'pf-fault';
      document.body.appendChild(el);
    }
    el.innerHTML = `<span>&#9888;</span><div><b>Something didn't load.</b>`
      + `<span id="pfFaultMsg"></span></div><button aria-label="Dismiss">&times;</button>`;
    el.querySelector('#pfFaultMsg').textContent = msg
      || ' Our team has been notified automatically. Please try again in a moment.';
    el.querySelector('button').onclick = () => el.remove();
    clearTimeout(el._t);
    el._t = setTimeout(() => el.remove(), 12000);
  }
  window.addEventListener('error', e => {
    // An opaque cross-origin "Script error." carries no file, line or stack and
    // is almost always a browser extension, not our code. Clients are on their
    // own machines, so they hit this most — never alarm them over it.
    if (e instanceof ErrorEvent && !e.error && !e.filename && !e.lineno) return;
    reportFault(e.error || e.message, 'Uncaught error');
    showFault();
  });
  window.addEventListener('unhandledrejection', e => {
    if (e.reason === undefined || e.reason === null) return;
    reportFault(e.reason, 'Unhandled async error');
    showFault();
  });

  // EVERY portal request goes through here, which is why the reporting lives
  // here rather than at each call site — a new screen added later is covered
  // without anyone remembering to wire it up.
  const api = async (path, opts = {}) => {
    let r;
    try {
      // A file upload must NOT be given a JSON content type — the browser has
      // to set its own multipart boundary. Handling that here is what lets the
      // upload screens use this same funnel instead of a bare fetch that
      // nothing watches.
      const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
      r = await fetch(path, {
        ...opts,
        headers: {
          ...(isForm ? {} : { 'Content-Type': 'application/json' }),
          'x-auth-token': token, ...(opts.headers || {}),
        },
      });
    } catch (err) {
      // The request never completed — the client's own connection, or ours
      // being unreachable. Worth knowing either way, and the client is told
      // plainly rather than being left with a screen that simply never fills.
      reportFault(err, `Request failed: ${String(path).split('?')[0]}`);
      showFault(' We could not reach IdealOne. Check your connection and try again.');
      throw err;
    }
    // 4xx is the system working — an expired session, a record that is not
    // theirs. A 5xx IS an outage, but the SERVER files it (its /api/portal
    // finish hook sees every route, including the multipart uploads that do
    // not come through here, and knows the real error). Reporting it from both
    // ends would file one fault as two rows with different wording, so this
    // side only tells the client.
    if (r.status >= 500) showFault();
    return r;
  };

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
    const user = $('liUser').value.trim();
    const password = $('liPass').value;
    $('liErr').textContent = '';
    if (!client || !password) { $('liErr').textContent = 'Enter your client name and password.'; return; }
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const r = await fetch('/api/portal/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client, user, password }),
      });
      const d = await r.json();
      if (!r.ok) {
        $('liErr').textContent = d.error || 'Sign-in failed';
        // The company has several logins and this person did not say which —
        // put the cursor where the answer goes rather than making them hunt.
        if (d.needsUser) $('liUser').focus();
        return;
      }
      token = d.token; clientName = d.client;
      portalUser = d.user || null;
      localStorage.setItem('portal_token', token);
      localStorage.setItem('portal_client', clientName);
      localStorage.setItem('portal_user', JSON.stringify(portalUser || {}));
      $('liPass').value = '';
      showApp();
    } catch (e) {
      $('liErr').textContent = 'Could not reach the server — check your connection.';
    } finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  }
  function logout() {
    api('/api/portal/logout', { method: 'POST' }).catch(() => {});
    token = ''; clientName = ''; portalUser = null;
    localStorage.removeItem('portal_token'); localStorage.removeItem('portal_client');
    localStorage.removeItem('portal_user');
    overview = null; stock = []; orders = []; inbound = [];
    $('appView').classList.add('hidden');
    $('loginView').classList.remove('hidden');
  }
  async function showApp() {
    $('loginView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    $('whoName').textContent = clientName;
    document.title = clientName + ' — IDEALONE Portal';
    showSkeleton();
    await applyAccess();
    loadAll();
  }

  // What this login may do, taken from the SERVER — the copy in localStorage is
  // only a hint for the first paint. Hiding the Send tab is a courtesy; every
  // write is refused server-side regardless of what the page shows.
  async function applyAccess() {
    try {
      const r = await api('/api/portal/me');
      if (r.status === 401) { logout(); return; }
      if (r.ok) {
        portalUser = await r.json();
        localStorage.setItem('portal_user', JSON.stringify(portalUser));
      }
    } catch (e) { /* keep whatever we had */ }
    const write = canWrite();
    document.querySelector('nav button[data-tab="send"]')?.classList.toggle('hidden', !write);
    // The other two places a client can write: sending an ASN, and setting
    // their own aging threshold. Both are hidden for a view-only login (and
    // both are refused server-side regardless).
    $('asnCard')?.classList.toggle('hidden', !write);
    $('agingCard')?.classList.toggle('hidden', !write);
    if (!write && document.querySelector('nav button[data-tab="send"]')?.classList.contains('active')) {
      document.querySelector('nav button[data-tab="overview"]')?.click();
    }
    const chip = $('whoUser');
    if (chip) {
      chip.textContent = portalUser?.name ? (write ? portalUser.name : `${portalUser.name} · view only`) : '';
      chip.classList.toggle('hidden', !portalUser?.name);
      chip.classList.toggle('view-only', !write);
    }
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
      loadNotices();
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
  // The sort the user picked. Kept in ONE place and mirrored to the server for
  // the download, so a file can never come out in a different order from the
  // list it was downloaded from.
  let stSort = 'sku', stDir = 'asc';
  const STOCK_SORT = {
    sku:       r => String(r.sku || '').toUpperCase(),
    name:      r => String(r.name || '').toUpperCase(),
    available: r => Number(r.available) || 0,
    on_hand:   r => Number(r.on_hand) || 0,
    reserved:  r => Number(r.reserved) || 0,
    moved:     r => String(r.last_movement_at || ''),
  };
  function sortRows(rows) {
    const key = STOCK_SORT[stSort] || STOCK_SORT.sku;
    const sign = stDir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const x = key(a), y = key(b);
      if (x === y) return String(a.sku || '').localeCompare(String(b.sku || ''));
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
      return String(x).localeCompare(String(y)) * sign;
    });
  }

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
    rows = sortRows(rows);

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
    pending:     { label: 'Pending Processing', pill: 'p-wait' },
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
          ${o.can_delete && canWrite()
            ? `<input type="checkbox" class="pick" data-k="${esc(o.order_number)}" title="Select to cancel">`
            : '<span class="no-pick"></span>'}
          <div style="min-width:0;flex:1">
            <div class="mono" style="font-weight:800;font-size:.9rem">${esc(o.order_number)}</div>
            <div class="muted" style="font-size:.76rem">
              ${fmtDate(o.date)} · ${num(o.lines)} line${o.lines === 1 ? '' : 's'} · ${num(o.total_qty)} pcs
            </div>
            ${o.waybill ? `<div class="muted mono" style="font-size:.7rem;margin-top:.1rem">Waybill ${esc(o.waybill)}</div>` : ''}
          </div>
          <div style="text-align:right">
            <span class="pill ${s.pill}">${s.label}</span>
            ${pickupPill(o.pickup)}
            ${deliveryPill(o.delivery)}
            <div class="muted" style="font-size:.68rem;margin-top:.3rem">${isOpen ? '▲ hide' : '▼ details'}</div>
          </div>
        </div>
        ${isOpen ? `<div class="detail">${d ? orderDetailHtml(d) : '<div class="skel" style="height:58px"></div>'}</div>` : ''}
      </div>`;
    }).join('');
    syncSel('orders');
  }

  // COLLECTION PILL — where a finished parcel has got to. The LABEL comes from
  // the server so the client reads exactly the words the office reads, and the
  // colours match the office list: green once it has left, amber while it is
  // still on our shelf, red once its collection day has passed.
  function pickupPill(pk) {
    if (!pk || !pk.label) return '';
    // Ready for Collection is GREEN — the pick is done and the parcel is on the
    // shelf. Picked Up is a STRONGER green so the terminal state still reads as
    // final rather than as one more green pill.
    const cls = pk.status === 'picked_up' ? 'p-gone' : pk.status === 'late' ? 'p-sla-miss' : 'p-ready';
    const tip = pk.status === 'picked_up'
      ? `Left us ${fmtDateTime(pk.at)}${pk.by_us ? ' — delivered to the drop-off point by us' : ''}`
      : pk.due ? `Due to leave ${fmtDate(pk.due)}` : 'Packed and waiting for collection';
    return `<div style="margin-top:.25rem"><span class="pill ${cls}" title="${esc(tip)}">&#128230; ${esc(pk.label)}</span></div>`;
  }

  // DELIVERY PILL — only when we are moving it ourselves. The LABEL comes from
  // the server, which mirrors the TMS wording the office uses, so the client
  // reads exactly what our own people read. Colours follow the office scheme:
  // Staging grey, On the road amber, Delivered green, w/ Remarks red.
  const DELIVERY_PILL = {
    'Staging':              'p-due',
    'On the road':          'p-overdue',
    'Delivered':            'p-sla-met',
    'Delivered w/ Remarks': 'p-dlv-rem',
    'Preplanned':           'p-sla-miss',
    'Cancelled':            'p-due',
  };
  function deliveryPill(dv) {
    if (!dv || !dv.label) return '';
    const cls = DELIVERY_PILL[dv.label] || 'p-due';
    const tip = dv.remarks ? ` title="${esc(dv.remarks)}"` : '';
    return `<div style="margin-top:.25rem"><span class="pill ${cls}"${tip}>&#128666; ${esc(dv.label)}</span></div>`;
  }

  function orderDetailHtml(d) {
    if (d.error) return `<div class="muted">${esc(d.error)}</div>`;
    const meta = [];
    if (d.po_number) meta.push(`PO ${esc(d.po_number)}`);
    if (d.carrier) meta.push(esc(d.carrier));
    if (d.cartons) meta.push(`${d.cartons} carton${d.cartons === 1 ? '' : 's'}`);
    if (d.completed_at) meta.push(`Packed ${fmtDateTime(d.completed_at)}`);
    if (d.pickup?.status === 'picked_up') {
      meta.push(`Picked up ${fmtDateTime(d.pickup.at)}${d.pickup.by_us ? ' (to the drop-off point by us)' : ''}`);
    } else if (d.pickup?.due) {
      meta.push(`Due to leave ${fmtDate(d.pickup.due)}`);
    }
    if (d.issue_no) meta.push(`GI ${esc(d.issue_no)}`);
    const showPacked = d.status === 'done' || d.status === 'processing';
    // THE WAYBILL AS A PILL. A tracking number on its own asks the client to
    // take it on trust; this opens the actual label we matched to the order.
    // The fetch+blob dance is because a plain <a href> cannot carry the session
    // token header — the same reason the exports do it.
    const wb = d.waybill
      ? `<span class="pill ${d.has_label ? 'p-sla-met' : 'p-due'} wbpill"${d.has_label ? ` data-o="${esc(d.order_number)}" style="cursor:pointer"` : ''}
           title="${d.has_label ? 'Open the waybill we matched to this order' : 'No waybill label on file for this order yet'}"
         >&#127991; ${esc(d.waybill)}${d.has_label ? ' \u00b7 view' : ''}</span>`
      : '';
    return `
      ${wb ? `<div style="margin-bottom:.5rem">${wb}</div>` : ''}
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
    // What the 2-working-day clock ran from, so a verdict is never a mystery.
    const from = sla.basis === 'arrival' ? `actual arrival ${fmtDay(sla.basisDay)}`
               : sla.basis === 'eta'     ? `expected arrival ${fmtDay(sla.basisDay)}`
               :                           `submission ${fmtDay(sla.basisDay)}`;
    if (sla.status === 'closed') {
      const d = sla.workingDaysEarly;
      const detail = d > 0 ? `${d} day${d === 1 ? '' : 's'} early` : d === 0 ? 'on time' : `${-d} day${d === -1 ? '' : 's'} late`;
      const tip = `2 working days from ${from} → due ${sla.dueDay}; received ${sla.doneDay}`;
      return sla.met
        ? `<span class="pill p-sla-met" title="${esc(tip)}">&#10003; SLA met · ${detail}</span>`
        : `<span class="pill p-sla-miss" title="${esc(tip)}">SLA missed · ${detail}</span>`;
    }
    const n = sla.workingDaysLeft;
    const tip = `2 working days from ${from}`;
    // Before the goods are even due to land there is nothing to be late for.
    if (sla.notYetDue) return `<span class="pill p-due" title="${esc(tip)}">Awaiting arrival · due ${fmtDay(sla.dueDay)}</span>`;
    if (sla.overdue) return `<span class="pill p-overdue" title="${esc(tip)} — was due ${sla.dueDay}">Overdue by ${-n} working day${n === -1 ? '' : 's'}</span>`;
    return `<span class="pill p-due" title="${esc(tip)}">Due ${fmtDay(sla.dueDay)}${n === 0 ? ' · today' : ` · in ${n} working day${n === 1 ? '' : 's'}`}</span>`;
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
          ${r.can_delete && canWrite()
            ? `<input type="checkbox" class="pick" data-k="${esc(r.id)}" title="Select to cancel">`
            : '<span class="no-pick"></span>'}
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
    syncSel('inbound');
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
      const r = await api('/api/portal/asn', { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) { asnMsg('err', esc(d.error || 'That file could not be read.')); return; }
      asnMsg('', `&#10003; ASN <b>${esc(d.serial)}</b> received — ${num(d.lines)} line(s), ${num(d.pieces)} pieces.`
        + (d.due
            ? `<br>Based on ${d.eta ? `an expected arrival of <b>${fmtDay(d.eta)}</b>` : 'today'}, `
              + `we aim to have it checked in by <b>${fmtDay(d.due)}</b>.`
              + (d.eta ? ' If it lands later, that target moves with it.' : '')
            : '')
        + `<br>You'll see the status update here.`);
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
      <td class="ts">${tallyStatus(l)}</td></tr>`).join('');
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
      td.ts{text-align:center;white-space:nowrap}
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
        <b>Photos on file:</b> ${g.photos}
      </div>
      <table><thead><tr><th>SKU</th><th>Description</th><th class="n">Expected</th><th class="n">Received</th>
        <th class="n">Good</th><th class="n">Damaged</th><th class="n">Held</th><th>Tally Status</th></tr></thead>
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

  // TALLY STATUS — a tick means the count agreed with the paperwork. Anything
  // else says what the difference actually was, in words, rather than leaving
  // the client to work out what "-3" meant.
  function tallyStatus(l) {
    if (l.expected === null) return '<span style="color:#b45309">Not on paperwork</span>';
    if (l.diff === 0) return '<span style="color:#059669;font-weight:700">&#10003;</span>';
    return l.diff > 0
      ? `<span style="color:#b45309;font-weight:700">${l.diff} over</span>`
      : `<span style="color:#b91c1c;font-weight:700">${Math.abs(l.diff)} short</span>`;
  }

  // ── Office broadcasts ─────────────────────────────────────────────────────
  // Shown above every tab until acknowledged. One acknowledgement clears it for
  // the whole account — a company reads a notice once.
  async function loadNotices() {
    try {
      const r = await api('/api/portal/notices');
      if (!r.ok) return;
      const d = await r.json();
      const wrap = $('noticeWrap');
      wrap.innerHTML = (d.notices || []).map(n => `
        <div class="notice${n.priority === 'urgent' ? ' urgent' : ''}">
          <div class="nb">
            <span class="nt">${n.priority === 'urgent' ? '\u26a0 Urgent \u00b7 ' : ''}From the warehouse \u00b7 ${
              new Date(n.createdAt).toLocaleString('en-GB', { ...SGT, hour12: false })}</span>
            ${esc(n.message)}
          </div>
          <button class="btn-sm nack" data-id="${esc(n.id)}">Got it</button>
        </div>`).join('');
      wrap.querySelectorAll('.nack').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true;
        await api('/api/portal/notices/' + encodeURIComponent(b.dataset.id) + '/ack', { method: 'POST' })
          .catch(() => {});
        loadNotices();
      }));
    } catch (_) { /* a broadcast failing must never break the portal */ }
  }

  // ── Export ────────────────────────────────────────────────────────────────
  // fetch + blob rather than a plain link, because the download needs the
  // session token header that an <a href> cannot send.
  async function download(kind, btn, range) {
    const orig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      // Stock carries the sort the user is looking at, so the file matches the
      // screen. Other kinds are period reports and have no sort to carry.
      const parts = [];
      if (range) parts.push(`from=${range.from}`, `to=${range.to}`);
      if (kind === 'stock') parts.push(`sort=${encodeURIComponent(stSort)}`, `dir=${encodeURIComponent(stDir)}`);
      const qs = parts.length ? '?' + parts.join('&') : '';
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
    $('dlTitle').textContent = kind === 'orders' ? 'Download orders report'
      : kind === 'fulfillability' ? 'Download: what can ship from stock'
      : kind === 'transactions' ? 'Download transaction statement'
      : 'Download inbound report';
    $('dlHint').textContent = `Pick any period up to ${exportMaxDays} days. The screen shows the last ${screenDays} days — reports can reach further back.`;
    const to = sgToday();
    const from = new Date(Date.now() - 89 * 86400000).toLocaleDateString('en-CA', SGT);
    $('dlFrom').value = from; $('dlTo').value = to; $('dlTo').max = to; $('dlFrom').max = to;
    $('dlErr').classList.add('hidden');
    $('dlModal').classList.remove('hidden');
  }
  function closeDownload() { $('dlModal').classList.add('hidden'); dlKind = null; }

  // ── Self-cancel: pick your own untouched records and remove them ──────────
  // No approval needed — but ONLY for records nothing has happened to yet. The
  // server decides that (`can_delete`); this UI only ever offers a tick where
  // the server has already said yes, so a client can't be shown an action that
  // will then be refused.
  const orSel = new Set(), ibSel = new Set();

  function syncSel(which) {
    const isOrders = which === 'orders';
    const sel = isOrders ? orSel : ibSel;
    const rows = isOrders ? orders : inbound;
    const idOf = r => isOrders ? r.order_number : r.id;
    // Drop anything that has since been picked/received, or has vanished.
    const eligible = new Set(canWrite() ? rows.filter(r => r.can_delete).map(idOf) : []);
    [...sel].forEach(k => { if (!eligible.has(k)) sel.delete(k); });

    const pre = isOrders ? 'or' : 'ib';
    document.querySelectorAll(`#${pre}List .pick`).forEach(cb => { cb.checked = sel.has(cb.dataset.k); });
    $(pre + 'SelCount').textContent = `${sel.size} selected`;
    $(pre + 'SelBar').classList.toggle('hidden', sel.size === 0);
    $(pre + 'PickAllWrap').classList.toggle('hidden', eligible.size === 0);
    const allBox = $(pre + 'PickAll');
    allBox.checked = eligible.size > 0 && sel.size === eligible.size;
    allBox.indeterminate = sel.size > 0 && sel.size < eligible.size;
  }

  function wireSel(which) {
    const isOrders = which === 'orders';
    const pre = isOrders ? 'or' : 'ib';
    const sel = isOrders ? orSel : ibSel;
    const idOf = r => isOrders ? r.order_number : r.id;

    $(pre + 'List').addEventListener('change', e => {
      if (!e.target.classList.contains('pick')) return;
      if (e.target.checked) sel.add(e.target.dataset.k); else sel.delete(e.target.dataset.k);
      syncSel(which);
    });
    $(pre + 'PickAll').addEventListener('change', e => {
      const rows = canWrite() ? (isOrders ? orders : inbound).filter(r => r.can_delete) : [];
      rows.forEach(r => { if (e.target.checked) sel.add(idOf(r)); else sel.delete(idOf(r)); });
      syncSel(which);
    });
    $(pre + 'SelClear').addEventListener('click', () => { sel.clear(); syncSel(which); });
    $(pre + 'SelDelete').addEventListener('click', async e => {
      const n = sel.size;
      if (!n) return;
      const noun = isOrders ? 'order' : 'shipment';
      const typed = prompt(
        `Cancel ${n} ${noun}${n === 1 ? '' : 's'}?\n\n`
        + `They will be removed and we will not process them. This cannot be undone.\n`
        + `Anything we have already started is left untouched.\n\n`
        + `Type CANCEL to confirm:`);
      if (typed === null) return;
      if (typed.trim().toUpperCase() !== 'CANCEL') { alert('Not confirmed — nothing was cancelled.'); return; }
      const reason = prompt('Reason (optional) — this is recorded and visible to us:', '') || '';

      const btn = e.currentTarget, orig = btn.innerHTML;
      btn.disabled = true; btn.textContent = 'Cancelling…';
      try {
        const r = await api('/api/portal/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
          body: JSON.stringify({ kind: isOrders ? 'orders' : 'inbound', items: [...sel], reason }),
        });
        const d = await r.json();
        if (!r.ok) { alert(d.error || 'Could not cancel those records.'); return; }
        sel.clear();
        let msg = `Cancelled ${d.deleted} ${noun}${d.deleted === 1 ? '' : 's'}.`;
        const ref = d.refused || [];
        if (ref.length) {
          const byReason = {};
          ref.forEach(f => { byReason[f.error] = (byReason[f.error] || 0) + 1; });
          msg += `\n\n${ref.length} could not be cancelled:\n`
            + Object.entries(byReason).map(([er, c]) => `  • ${c} × ${er}`).join('\n');
        }
        alert(msg);
        loadAll();
      } catch (err) { alert('Could not reach the server — please try again.'); }
      finally { btn.disabled = false; btn.innerHTML = orig; }
    });
  }
  wireSel('orders');
  wireSel('inbound');

  // ── SEND: three steps, in order ───────────────────────────────────────────
  // 1. the order file (previewed, then held as a DRAFT — nothing has reached us)
  // 2. the waybill PDF, matched against those very orders on the spot
  // 3. send — the moment the package actually arrives with the office
  //
  // Doing it in this order is what makes step 2's match meaningful: the orders
  // are not live yet, so there would otherwise be nothing for a label to match.
  let sendPreview  = null;   // {filename, orderCount, rowCount, totalQty, warnings, ...}
  let sendFileBlob = null;   // the file itself, held until the client confirms step 1
  let sendDraft    = null;   // the draft submission once step 1 is committed
  let lastMatch    = null;   // the waybill match result last shown

  function sendMsg(text, kind, id) {
    const el = $(id || 'sendMsg');
    el.className = 'asn-msg' + (kind ? ' ' + kind : '');
    el.textContent = text;
    el.classList.remove('hidden');
  }

  // Which step is on screen, and which are behind us.
  function sendStep(n) {
    for (let i = 1; i <= 3; i++) $('sendStep' + i).classList.toggle('hidden', i !== n);
    document.querySelectorAll('#sendSteps .step').forEach(el => {
      const i = Number(el.dataset.step);
      el.classList.toggle('on', i === n);
      el.classList.toggle('done', i < n);
    });
  }

  async function sendPickFile(file) {
    if (!file) return;
    sendFileBlob = file;
    sendMsg('Reading ' + file.name + '…', 'busy');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api('/api/portal/preview-orders', { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) { sendMsg(d.error || 'We could not read that file.', 'err'); sendFileBlob = null; return; }
      sendPreview = d;
      $('sendMsg').classList.add('hidden');
      openSendConfirm();
    } catch (e) {
      sendMsg('Network error — please try again.', 'err');
    }
  }

  function openSendConfirm() {
    const d = sendPreview;
    $('cfmFile').textContent = d.filename;
    $('cfmOrders').textContent = d.orderCount;
    $('cfmLines').textContent = d.rowCount;
    $('cfmQty').textContent = d.totalQty;
    const w = $('cfmWarn');
    if ((d.warnings || []).length) { w.innerHTML = d.warnings.map(esc).join('<br>'); w.classList.remove('hidden'); }
    else w.classList.add('hidden');
    const dup = $('cfmDup');
    if ((d.duplicateWarnings || []).length) { dup.innerHTML = d.duplicateWarnings.map(esc).join('<br>'); dup.classList.remove('hidden'); }
    else dup.classList.add('hidden');
    // Line-level preview so the client can see the SKUs and names WE resolved —
    // this is what proves a barcode-only file came out right before they send it.
    $('cfmPreview').innerHTML = (d.orders || []).map(o => `
      <div class="o">
        <div class="on">${esc(o.order_number)} <span class="muted">· ${o.total_qty} pc</span></div>
        ${(o.lines || []).map(l => `<div class="ln"><b>${esc(l.sku)}</b><span>${esc(String(l.description || '').slice(0, 44))}</span><span>×${l.qty}</span></div>`).join('')}
      </div>`).join('');
    $('sendConfirm').classList.remove('hidden');
  }

  // STEP 1 → commit the order file as a draft, then move to waybills.
  async function sendSubmit() {
    if (!sendFileBlob) return;
    $('cfmGo').disabled = true;
    const fd = new FormData();
    fd.append('file', sendFileBlob);
    try {
      let r = await api('/api/portal/submit-orders', { method: 'POST', body: fd });
      // ── DUPLICATE ORDER NUMBERS ────────────────────────────────────────
      // Which ones, and when we last saw them. Approve or abort — nothing has
      // been stored yet, so aborting leaves nothing behind.
      if (r.status === 409) {
        const dj = await r.clone().json().catch(() => ({}));
        if (dj.needsDuplicateConfirm) {
          const shown = (dj.lines || []).slice(0, 15).join('\n');
          const more = (dj.duplicates || []).length > 15 ? `\n…and ${dj.duplicates.length - 15} more` : '';
          const go = confirm(`\u26a0 ALREADY WITH US\n\n${dj.message}\n\n${shown}${more}`
            + `\n\nOK = send it anyway (our team will check it again before accepting)`
            + `\nCancel = do not send — nothing is uploaded`);
          if (!go) { sendMsg('Not sent — nothing was uploaded.', 'err'); $('cfmGo').disabled = false; return; }
          fd.append('confirm_duplicates', 'yes');
          r = await api('/api/portal/submit-orders', { method: 'POST', body: fd });
        }
      }
      const d = await r.json();
      if (!r.ok) { sendMsg(d.error || 'Submission failed.', 'err'); return; }
      sendDraft = d.submission;
      sendPreview = null; sendFileBlob = null;
      $('sendFile').value = '';
      $('sendMsg').classList.add('hidden');
      $('sendMatch').classList.add('hidden');
      $('sendLabelMsg').classList.add('hidden');
      $('sendLabelsNext').classList.add('hidden');
      sendStep(2);
      loadSubmissions();
    } catch (e) {
      sendMsg('Network error — nothing was saved.', 'err');
    } finally {
      $('cfmGo').disabled = false;
      $('sendConfirm').classList.add('hidden');
    }
  }

  // STEP 2 → the waybills, matched against step 1's orders straight away.
  async function sendLabelsFile(file) {
    if (!file || !sendDraft) return;
    // Scanned labels have to be read with text recognition, which takes a
    // couple of seconds a page — say so rather than leaving them staring at it.
    sendMsg(`Reading ${file.name} and matching to your orders… scanned labels take a few seconds a page.`, 'busy', 'sendLabelMsg');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('for_submission', sendDraft.id);
    try {
      const r = await api('/api/portal/submit-labels', { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) { sendMsg(d.error || 'We could not read that PDF.', 'err', 'sendLabelMsg'); return; }
      $('sendLabelMsg').classList.add('hidden');
      renderMatch(file.name, d);
      lastMatch = d;
      $('sendLabelsNext').classList.remove('hidden');
      $('sendSkipLabels').textContent = 'Remove waybills';
      loadSubmissions();
    } catch (e) { sendMsg('Network error — please try again.', 'err', 'sendLabelMsg'); }
  }

  // What matched, and — just as important — what did not, with whatever we could
  // read off the page so an unmatched label is explainable rather than a number.
  function renderMatch(filename, d) {
    const el = $('sendMatch');
    const pages = d.pages || 0, matched = d.matched || 0;
    const un = d.unmatched || [];
    const allGood = matched === pages;
    // Scanned labels carry no text, so those pages are read by OCR. Saying so
    // explains both the wait and why an OCR page might read slightly off.
    const howRead = d.ocrPages
      ? `<div class="muted" style="font-size:.75rem;margin-top:.2rem">${d.ocrPages} page(s) were scanned images — we read them with text recognition.${
          d.ocrSkipped ? ` ${d.ocrSkipped} were left for us to read on our side.` : ''}</div>`
      : '';
    el.innerHTML = `
      <div class="mt-head">
        <span>${allGood ? '✅' : '⚠️'}</span>
        <span>${matched} of ${pages} waybill page(s) matched to your orders</span>
      </div>
      <div class="muted" style="font-size:.76rem;margin-top:.2rem">${esc(filename)}</div>
      ${howRead}
      ${un.length ? `
        <div class="mt-list">
          ${un.slice(0, 12).map(u => `<div class="mt-row">
            <span class="pg">p.${u.page}</span>
            <span class="to muted">${esc(u.tracking || u.order
              || (u.via === 'none' ? 'we could not read this page' : 'read, but no matching order above'))}</span>
          </div>`).join('')}
        </div>
        <div class="muted" style="font-size:.76rem;margin-top:.4rem">
          ${un.length > 12 ? `and ${un.length - 12} more. ` : ''}You can still send these —
          we'll try to match them again on our side. Usually it means the order is not in the file above.
        </div>` : ''}`;
    el.classList.remove('hidden');
  }

  async function removeLabels() {
    if (!sendDraft) return;
    try {
      const r = await api(`/api/portal/submissions/${sendDraft.id}/labels`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) { sendMsg(d.error || 'Could not remove that file.', 'err', 'sendLabelMsg'); return; }
      $('sendMatch').classList.add('hidden');
      $('sendLabelsNext').classList.add('hidden');
      $('sendSkipLabels').textContent = 'Skip — no waybills';
      $('sendLabels').value = '';
      loadSubmissions();
    } catch (e) { sendMsg('Network error — please try again.', 'err', 'sendLabelMsg'); }
  }

  // STEP 3 → what is about to be sent, then send it.
  async function openSendFinal() {
    // Re-read the draft so the summary reflects whatever is actually attached.
    try {
      const rows = await (await api('/api/portal/submissions')).json();
      const fresh = rows.find(x => x.id === sendDraft?.id);
      if (fresh) sendDraft = fresh;
    } catch (e) { /* fall back to what we have */ }
    const d = sendDraft;
    if (!d) return;
    const lab = d.labels;
    $('sendSummary').innerHTML = `
      <div class="cfm-row"><span>Orders file</span><span>${esc(d.filename)}</span></div>
      <div class="cfm-row"><span>Orders</span><span class="cfm-big">${d.order_count}</span></div>
      <div class="cfm-row"><span>Lines</span><span class="cfm-big">${d.row_count}</span></div>
      <div class="cfm-row"><span>Total pieces</span><span class="cfm-big">${d.total_qty}</span></div>
      <div class="cfm-row"><span>Waybills</span><span>${lab
        ? `${esc(lab.filename)} — <b>${lab.matched} of ${lab.pages}</b> matched`
        : '<span class="muted">none attached</span>'}</span></div>`;
    $('sendFinalMsg').classList.add('hidden');
    sendStep(3);
  }

  async function sendTransmit() {
    if (!sendDraft) return;
    const btn = $('sendTransmit');
    btn.disabled = true;
    try {
      const r = await api(`/api/portal/submissions/${sendDraft.id}/transmit`, {
        method: 'POST', headers: { 'x-auth-token': token, 'content-type': 'application/json' }, body: '{}',
      });
      const d = await r.json();
      if (!r.ok) { sendMsg(d.error || 'Could not send.', 'err', 'sendFinalMsg'); return; }
      const code = d.submission.code;
      sendDraft = null;
      sendStep(1);
      sendMsg(`✓ Sent for approval as ${code}. You'll see the status below.`, '');
      loadSubmissions();
    } catch (e) { sendMsg('Network error — nothing was sent.', 'err', 'sendFinalMsg'); }
    finally { btn.disabled = false; }
  }

  async function sendDiscard() {
    if (!sendDraft) return;
    if (!confirm('Discard this upload? Nothing has been sent to us, so nothing is lost on our side.')) return;
    try {
      await api(`/api/portal/submissions/${sendDraft.id}`, { method: 'DELETE' });
    } catch (e) { /* it is a draft; a failure here is not worth blocking on */ }
    sendDraft = null;
    $('sendFile').value = ''; $('sendLabels').value = '';
    $('sendMatch').classList.add('hidden');
    $('sendSkipLabels').textContent = 'Skip — no waybills';
    sendStep(1);
    $('sendMsg').classList.add('hidden');
    loadSubmissions();
  }

  // Resume an upload the client started and never sent — a draft that is only
  // reachable from the list would otherwise be stranded.
  async function resumeDraft(id) {
    try {
      const rows = await (await api('/api/portal/submissions')).json();
      sendDraft = rows.find(x => x.id === id) || null;
    } catch (e) { return; }
    if (!sendDraft) return;
    if (sendDraft.labels) {
      renderMatch(sendDraft.labels.filename, {
        pages: sendDraft.labels.pages, matched: sendDraft.labels.matched, unmatched: sendDraft.labels.unmatched,
      });
      $('sendLabelsNext').classList.remove('hidden');
      $('sendSkipLabels').textContent = 'Remove waybills';
    } else {
      $('sendMatch').classList.add('hidden');
      $('sendLabelsNext').classList.add('hidden');
      $('sendSkipLabels').textContent = 'Skip — no waybills';
    }
    sendStep(2);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const SUB_PILL = {
    draft:    ['p-due',     'Not sent yet'],
    pending:  ['p-due',     'Waiting for approval'],
    approved: ['p-sla-met', 'Approved'],
    rejected: ['p-sla-miss', 'Not accepted'],
  };
  async function loadSubmissions() {
    try {
      const rows = await (await api('/api/portal/submissions')).json();
      const el = $('sendList');
      if (!Array.isArray(rows) || !rows.length) {
        el.innerHTML = '<div class="card muted" style="font-size:.83rem">Nothing sent yet. Anything you upload above appears here with its status.</div>';
        return;
      }
      el.innerHTML = rows.map(s => {
        const [cls, label] = SUB_PILL[s.status] || ['p-due', s.status];
        const kind = s.kind === 'labels' ? `${s.row_count} waybill page(s)` : `${s.order_count} order(s) · ${s.row_count} line(s)`;
        const lab = s.labels
          ? `<div class="muted" style="font-size:.78rem;margin-top:.2rem">🏷 ${esc(s.labels.filename)} — ${
              s.labels.matched == null ? `${s.labels.pages} page(s)` : `<b>${s.labels.matched} of ${s.labels.pages}</b> matched`}</div>`
          : '';
        // A draft is the client's own unfinished work — it must be finishable
        // or removable from here, or it would be stranded on this list forever.
        const draftActs = s.status === 'draft'
          ? `<div style="margin-top:.5rem;display:flex;gap:.4rem;flex-wrap:wrap">
               <button class="btn-sm asn-primary" data-resume="${esc(s.id)}">Continue →</button>
               <button class="btn-sm" data-drop="${esc(s.id)}">Discard</button>
             </div>`
          : '';
        // Live status per order, including where it has got to physically —
        // "done" only means we finished packing it, and the client wants to
        // know whether it has actually left. Floor shorthand is translated.
        const orders = (s.orders || []).map(o => {
          const where = o.pickup?.status === 'picked_up' ? 'Picked Up'
                      : o.pickup?.label || statusOf(o.status).label;
          // Same colours as the Orders tab — a client should not have to learn
          // two schemes for the same fact.
          const cls = o.pickup?.status === 'picked_up' ? 'p-gone'
                    : o.pickup?.status === 'late' ? 'p-sla-miss'
                    : o.pickup ? 'p-ready'
                    : statusOf(o.status).pill;
          return `<span class="pill ${cls}">${esc(o.order_number)} · ${esc(where)}</span>`;
        }).join(' ');
        return `<div class="card">
          <div class="sub-row">
            <span class="code">${esc(s.code)}</span>
            <span class="pill ${cls}">${esc(label)}</span>
            <span class="muted" style="margin-left:auto;font-size:.76rem">${esc(fmtDateTime(s.submitted_at))}</span>
          </div>
          <div class="muted" style="font-size:.79rem;margin-top:.25rem">${esc(s.filename)} — ${kind}</div>
          ${s.job_code ? `<div class="muted" style="font-size:.78rem;margin-top:.2rem">Our job reference: <b>${esc(s.job_code)}</b></div>` : ''}
          ${s.status === 'rejected' && s.reject_reason ? `<div class="asn-msg err" style="margin-top:.45rem">${esc(s.reject_reason)}</div>` : ''}
          ${lab}
          ${orders ? `<div style="margin-top:.45rem;display:flex;gap:.3rem;flex-wrap:wrap">${orders}</div>` : ''}
          ${draftActs}
        </div>`;
      }).join('');
      el.querySelectorAll('[data-resume]').forEach(b =>
        b.addEventListener('click', () => resumeDraft(b.dataset.resume)));
      el.querySelectorAll('[data-drop]').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Discard this upload? It was never sent to us.')) return;
        await api(`/api/portal/submissions/${b.dataset.drop}`, { method: 'DELETE' }).catch(() => {});
        if (sendDraft && sendDraft.id === b.dataset.drop) { sendDraft = null; sendStep(1); }
        loadSubmissions();
      }));
    } catch (e) { /* leave whatever is on screen */ }
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('main > section').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'send') loadSubmissions();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));

  // Send flow — pickers, drag & drop, and the step buttons
  $('sendBrowse').addEventListener('click', () => $('sendFile').click());
  $('sendFile').addEventListener('change', e => sendPickFile(e.target.files[0]));
  $('sendLabelsBrowse').addEventListener('click', () => $('sendLabels').click());
  $('sendLabels').addEventListener('change', e => sendLabelsFile(e.target.files[0]));
  function wireDrop(id, onFile) {
    const dz = $(id);
    if (!dz) return;
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', e => onFile(e.dataTransfer?.files?.[0]));
  }
  wireDrop('sendDrop', sendPickFile);
  wireDrop('sendLabelDrop', sendLabelsFile);
  $('cfmCancel').addEventListener('click', () => { $('sendConfirm').classList.add('hidden'); sendPreview = null; sendFileBlob = null; $('sendFile').value = ''; });
  $('cfmGo').addEventListener('click', sendSubmit);
  // The same button is "skip" until a PDF is attached, then "remove" — one
  // control, because those are the same decision made twice.
  $('sendSkipLabels').addEventListener('click', () => {
    if (sendDraft?.labels || !$('sendMatch').classList.contains('hidden')) removeLabels();
    else openSendFinal();
  });
  $('sendLabelsNext').addEventListener('click', openSendFinal);
  $('sendBack2').addEventListener('click', () => sendStep(2));
  $('sendTransmit').addEventListener('click', sendTransmit);
  $('sendDiscard').addEventListener('click', sendDiscard);
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
  $('stSort').addEventListener('change', e => { stSort = e.target.value; renderStock(); });
  $('stDir').addEventListener('click', () => {
    stDir = stDir === 'asc' ? 'desc' : 'asc';
    $('stDir').dataset.dir = stDir;
    $('stDir').innerHTML = stDir === 'asc' ? '\u25b2 Ascending' : '\u25bc Descending';
    renderStock();
  });
  $('orSearch').addEventListener('input', renderOrders);
  $('ibSearch').addEventListener('input', renderInbound);
  // Stock is a live position — straight download, no date window.
  $('stExport').addEventListener('click', async e => {
    const r = await download('stock', e.currentTarget);
    if (!r.ok) alert(r.error || 'Could not prepare the download.');
  });
  $('orExport').addEventListener('click', () => openDownload('orders'));
  // What can ship — fulfillability of the client's open orders against the
  // stock we hold, same sheets the office sees.
  $('orFulfilExport').addEventListener('click', () => openDownload('fulfillability'));
  // Month-end statement: everything in and out, with balances that reconcile.
  $('orTxnExport').addEventListener('click', () => openDownload('transactions'));
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
      const r = await api('/api/portal/settings', {
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
  $('orList').addEventListener('click', async e => {
    // Ticking the cancel checkbox must not also expand the card.
    if (e.target.classList.contains('pick')) return;
    // Neither must opening the waybill — it sits INSIDE the expanded card, so
    // letting the click through would collapse it again.
    const wb = e.target.closest('.wbpill[data-o]');
    if (wb) {
      e.stopPropagation();
      const orig = wb.textContent;
      wb.textContent = 'opening…';
      try {
        const r = await api('/api/portal/order/' + encodeURIComponent(wb.dataset.o) + '/label');
        if (!r.ok) { alert('That waybill is not available.'); return; }
        const url = URL.createObjectURL(await r.blob());
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (_) { alert('Could not open the waybill.'); }
      finally { wb.textContent = orig; }
      return;
    }
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
