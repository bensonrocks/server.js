// 24H PROCESSING TIMER (Red / Yellow / Green). Benson: "orders flow in from all
// sources — put in a timer, i.e. 24 hrs to process the order so it's not late,
// and it can be seen".
//
// Pure and dependency-free so the SAME code runs in the browser (served as
// /vendor/order-sla.js) and in tests. It is computed CLIENT-SIDE from fields
// GET /api/orders already returns (uploadedAt, scan_status, endTime,
// client_name, reference_only), so the server does no per-order work at all.
//
// Definitions:
//   START    = when the order ENTERED IdealOne (`uploadedAt`, the batch's
//              upload/sync time). Every source has it (Excel/GI uploads, portal
//              orders, marketplace syncs); a platform order time only exists
//              for some synced orders, and the existing Handover KPI already
//              runs from that one.
//   STOP     = PROCESSED = the order's pick/pack scan completed (scan_status
//              'done', at `endTime`). That is the moment the warehouse's work
//              is finished; RTS follows automatically from it and courier
//              pickup is outside the warehouse's hands.
//   EXCLUDED = cancelled (scan_status 'unprocessed' or withdrawn by client) and
//              channel reference copies (reference_only, e.g. Betime Online).
//   COLOUR   = Green while more than `yellowHours` are left, Yellow at or below
//              that, Red once overdue. Done orders stop and grey out (with
//              "in time" / "late" kept for reference).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrderSla = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEFAULTS = { hours: 24, yellowHours: 8 };
  const H = 3600000;

  function clampHours(v, d, lo, hi) {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
  }
  // cfg: { hours, yellowHours, clients: { '<lowercased client or alias>': { hours, yellowHours } } }
  function policyFor(cfg, clientName) {
    const c = cfg || {};
    const base = { hours: clampHours(c.hours, DEFAULTS.hours, 1, 720), yellowHours: clampHours(c.yellowHours, DEFAULTS.yellowHours, 0, 720) };
    const k = String(clientName || '').trim().toLowerCase();
    const o = (c.clients && k && c.clients[k]) || null;
    if (o) {
      base.hours = clampHours(o.hours, base.hours, 1, 720);
      base.yellowHours = clampHours(o.yellowHours, base.yellowHours, 0, 720);
    }
    if (base.yellowHours >= base.hours) base.yellowHours = Math.max(0, base.hours / 3);
    return base;
  }

  function fmtDur(ms) {
    const m = Math.max(0, Math.round(Math.abs(ms) / 60000));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return mm ? `${h}h ${mm}m` : `${h}h`;
    return `${mm}m`;
  }

  // Returns null when the order is excluded or has no start time; otherwise
  // { state: 'green'|'yellow'|'red'|'done', late, startAt, dueAt, msLeft, label, hours }.
  function compute(order, cfg, now) {
    if (!order || order.reference_only) return null;
    if (order.scan_status === 'unprocessed' || order.client_cancelled) return null;
    const start = Date.parse(order.uploadedAt || order.uploaded_at || '');
    if (!Number.isFinite(start)) return null;
    const pol = policyFor(cfg, order.client_name);
    const dueAt = start + pol.hours * H;
    if (order.scan_status === 'done') {
      const end = Date.parse(order.endTime || '');
      const late = Number.isFinite(end) ? end > dueAt : false;
      return { state: 'done', late, startAt: start, dueAt, msLeft: null, hours: pol.hours,
        label: Number.isFinite(end) ? (late ? `Done · ${fmtDur(end - dueAt)} late` : 'Done in time') : 'Done' };
    }
    const t = typeof now === 'number' ? now : (now ? Date.parse(now) : Date.now());
    const msLeft = dueAt - t;
    const state = msLeft < 0 ? 'red' : msLeft <= pol.yellowHours * H ? 'yellow' : 'green';
    return { state, late: msLeft < 0, startAt: start, dueAt, msLeft, hours: pol.hours,
      label: msLeft < 0 ? `Late ${fmtDur(msLeft)}` : `${fmtDur(msLeft)} left` };
  }

  function summarize(orders, cfg, now) {
    const out = { red: 0, yellow: 0, green: 0, done: 0 };
    for (const o of orders || []) { const s = compute(o, cfg, now); if (s) out[s.state]++; }
    return out;
  }

  // Most urgent first: open orders by least time left (most overdue first),
  // then done, then excluded; stable otherwise.
  function urgencyKey(order, cfg, now) {
    const s = compute(order, cfg, now);
    if (!s) return [3, 0];
    if (s.state === 'done') return [2, 0];
    return [0, s.msLeft];
  }

  return { DEFAULTS, policyFor, compute, summarize, urgencyKey, fmtDur };
}));
