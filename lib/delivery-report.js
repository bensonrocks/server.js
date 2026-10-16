// DELIVERY STATUS REPORT + DAILY DELIVERY OUTCOME (Transport page download).
// One row per item line (job fields repeated), plus a per-job sheet and, in
// daily mode, an outcome summary by driver and client.
//
// The event loop is never held for long: work is done in slices of SLICE jobs
// with a setImmediate yield between them, and the row count is capped.
'use strict';
const SLICE = 300;
const MAX_ROWS = 50000;
const yieldNow = () => new Promise(r => setImmediate(r));

const sgDay = at => {
  if (!at) return '';
  const d = new Date(at); if (isNaN(d)) return '';
  return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10);
};
const sgDateTime = at => {
  if (!at) return '';
  const d = new Date(at); if (isNaN(d)) return '';
  return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
};
const sgTime = at => sgDateTime(at).slice(11);
const todaySg = () => sgDay(new Date());

function poExpiryStatus(job, today = todaySg()) {
  const v = job.poExpiry;
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'TBA';
  if (job.status === 'delivered' || job.status === 'cancelled') return 'OK';
  const days = Math.round((Date.parse(v) - Date.parse(today)) / 86400000);
  if (days < 0) return 'Expired';
  if (days <= 2) return 'Amber';
  return 'OK';
}
// Planned delivery day: the schedule's delivery date if imported, else the day
// the job was planned onto a route, else the day it was created.
const plannedDay = j => sgDay(j.source?.deliveryDate) || sgDay(j.plannedAt) || sgDay(j.createdAt);
const failReason = j => j.failReason || j.podOverride?.reason || (j.status === 'cancelled' ? (j.notes || 'Cancelled') : '') || '';

function outcome(j, day, today) {
  if (j.status === 'delivered') {
    const other = plannedDay(j) && plannedDay(j) !== day && sgDay(j.deliveredAt) === day;
    return { outcome: 'Delivered', detail: `Delivered ${sgTime(j.deliveredAt)}${j.podRemarks ? ' (with remarks)' : ''}`, flag: other ? `Delivered on ${day}, planned ${plannedDay(j)}` : '' };
  }
  if (j.status === 'cancelled' || j.status === 'failed') return { outcome: 'Not delivered', detail: failReason(j) || j.status, flag: '' };
  if (day < today) return { outcome: 'Not delivered', detail: `Not delivered on ${day} (status ${j.status || 'pending'})`, flag: '' };
  return { outcome: 'Pending', detail: `Still open (${j.status || 'pending'})`, flag: '' };
}

// Order-number → lines, built once per request (sliced) for just the refs needed.
async function orderIndex(db, refs) {
  const want = new Set(refs.filter(Boolean)); const idx = new Map();
  let n = 0;
  for (const b of db.batches || []) {
    if (++n % 50 === 0) await yieldNow();
    for (const o of b.orders || []) {
      if (!want.has(o.order_number)) continue;
      const prev = idx.get(o.order_number);
      if (prev && !prev.reference) continue;                 // a work order beats a reference copy
      idx.set(o.order_number, { lines: o.lines || [], reference: !!b.reference_only });
    }
  }
  return idx;
}
function mergeLines(lines) {
  const m = new Map();
  for (const l of lines) {
    const k = l.sku || l.description || '';
    const e = m.get(k);
    if (e) e.qty += Number(l.qty) || 0; else m.set(k, { sku: l.sku || '', description: l.description || l.name || '', qty: Number(l.qty) || 0, delivered: l.qty_delivered ?? l.deliveredQty ?? '' });
  }
  return [...m.values()];
}

const ITEM_COLS = ['Job ID', 'PO / Reference', 'Client', 'Store / Consignee', 'Address', 'Postal Code',
  'PO Date', 'PO Expiry', 'PO Expiry Status', 'PO Expiry Note',
  'Planned Delivery Date', 'Driver', 'Route', 'Stop #', 'Status',
  'Delivered Date', 'Delivered Time (SGT)', 'POD Signed By', 'Signature Captured', 'POD Remarks', 'Failed / Exception Reason',
  'Cartons', 'Item SKU', 'Item Description', 'Qty Ordered', 'Qty Delivered',
  'Linked Order No(s)', 'Last Updated (SGT)'];
const DAILY_COLS = ['Outcome', 'Outcome Detail', 'Flag'];

/**
 * opts: { mode: 'range'|'daily', from, to, dateField: 'delivery'|'created', client, status, day }
 * returns { itemRows, jobRows, summaryRows|null, itemCols, jobCols, truncated, totalJobs }
 */
async function buildReport(db, opts = {}) {
  const today = todaySg();
  const mode = opts.mode === 'daily' ? 'daily' : 'range';
  const day = (opts.day || today).slice(0, 10);
  const from = (opts.from || today).slice(0, 10), to = (opts.to || from).slice(0, 10);
  const client = String(opts.client || '').trim().toLowerCase();
  const status = String(opts.status || '').trim().toLowerCase();
  const all = db.transport || [];
  const sel = [];
  for (let i = 0; i < all.length; i++) {
    if (i % 2000 === 0 && i) await yieldNow();
    const j = all[i];
    if (client && !String(j.clientName || '').toLowerCase().includes(client) && !String(j.channel || '').toLowerCase().includes(client)) continue;
    if (status && String(j.status || 'pending').toLowerCase() !== status) continue;
    if (mode === 'daily') {
      if (plannedDay(j) !== day && sgDay(j.deliveredAt) !== day) continue;
    } else {
      const d = opts.dateField === 'created' ? sgDay(j.createdAt) : (sgDay(j.deliveredAt) || plannedDay(j));
      if (!d || d < from || d > to) continue;
    }
    sel.push(j);
  }
  sel.sort((a, b) => String(a.assignedDriverName || '~').localeCompare(String(b.assignedDriverName || '~')) || (a.routeNum || 999) - (b.routeNum || 999) || (a.stopSeq || 999) - (b.stopSeq || 999) || String(a.id).localeCompare(String(b.id)));
  const orders = await orderIndex(db, sel.map(j => j.referenceId || j.clientId));

  const itemRows = [], jobRows = []; let truncated = false;
  for (let i = 0; i < sel.length; i++) {
    if (i % SLICE === 0 && i) await yieldNow();
    const j = sel[i];
    const ref = j.referenceId || j.clientId || '';
    const ord = orders.get(ref);
    const placeholder = (j.items || []).filter(it => !/^(DELIVERY-|XFER-)/.test(String(it.sku || '')) || !ord);
    const lines = mergeLines(ord && ord.lines.length ? ord.lines : placeholder);
    const base = [j.id, ref, j.clientName || '', j.shipping?.recipient || j.clientName || '', j.shipping?.addressLine1 || '', j.shipping?.zip || '',
      j.poDate || j.source?.poDate || '', j.poExpiry || '', poExpiryStatus(j, today), j.poExpiryMatch && j.poExpiryMatch !== 'import' ? j.poExpiryMatch : '',
      plannedDay(j), j.assignedDriverName || j.assignedDriver || '', j.routeNum ?? '', j.stopSeq ?? '', j.status || 'pending',
      sgDay(j.deliveredAt), sgTime(j.deliveredAt), j.podSignature?.receiverName || '', j.podSignature ? 'Yes' : 'No', j.podRemarks || '', failReason(j),
      j.packages || 1];
    const tail = [ord ? ref : '', sgDateTime(j.updatedAt || j.deliveredAt || j.plannedAt || j.createdAt)];
    const oc = mode === 'daily' ? outcome(j, day, today) : null;
    const extra = oc ? [oc.outcome, oc.detail, oc.flag] : [];
    const rowsForJob = lines.length ? lines : [null];
    if (itemRows.length + rowsForJob.length > MAX_ROWS) { truncated = true; break; }
    for (const l of rowsForJob) itemRows.push([...extra, ...base, l ? l.sku : '', l ? l.description : '', l ? l.qty : '', l ? l.delivered : '', ...tail]);
    jobRows.push([...extra, ...base, lines.length, lines.reduce((s, l) => s + (Number(l.qty) || 0), 0), ...tail]);
  }
  const prefix = mode === 'daily' ? DAILY_COLS : [];
  const jobCols = [...prefix, ...ITEM_COLS.slice(0, 22), 'Item Lines', 'Total Qty', ...ITEM_COLS.slice(26)];
  // Client-facing: plain counts only (no per-driver / per-client rates).
  let summaryRows = null;
  if (mode === 'daily') {
    const c = { total: jobRows.length, delivered: 0, not: 0, pending: 0, other: 0 };
    for (const r of jobRows) { if (r[0] === 'Delivered') c.delivered++; else if (r[0] === 'Not delivered') c.not++; else c.pending++; if (r[2]) c.other++; }
    summaryRows = [[`Daily Delivery Outcome — ${day} (SGT)`], [`Generated ${sgDateTime(new Date())} SGT`], [],
      ['Total jobs', c.total], ['Delivered', c.delivered], ['Not delivered', c.not], ['Pending / open', c.pending], [],
      ['Of the delivered, planned for another day', c.other]];
  }
  return { mode, day, from, to, itemCols: [...prefix, ...ITEM_COLS], jobCols, itemRows, jobRows, summaryRows, truncated, totalJobs: sel.length, maxRows: MAX_ROWS };
}

function toXlsx(XLSX, rep) {
  const wb = XLSX.utils.book_new();
  const title = rep.mode === 'daily' ? `Daily Delivery Outcome ${rep.day}` : `Delivery Status Report ${rep.from} to ${rep.to}`;
  const warn = rep.truncated ? [[`WARNING: capped at ${rep.maxRows} item rows — narrow the date range or filters for the full set.`]] : [];
  if (rep.summaryRows) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...warn, ...rep.summaryRows]), 'Outcome Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[title], ...warn, rep.itemCols, ...rep.itemRows]), 'Items');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[title], ...warn, rep.jobCols, ...rep.jobRows]), 'Summary');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
async function writeCsv(res, rep) {
  res.write('\ufeff' + rep.itemCols.map(csvCell).join(',') + '\r\n');
  for (let i = 0; i < rep.itemRows.length; i++) {
    if (i % 2000 === 0 && i) await yieldNow();
    res.write(rep.itemRows[i].map(csvCell).join(',') + '\r\n');
  }
  if (rep.truncated) res.write(csvCell(`WARNING: capped at ${rep.maxRows} rows`) + '\r\n');
  res.end();
}

// XLSX.write is synchronous and takes seconds on big sheets, so run it in a
// worker thread: the main event loop (scans, packing, labels) keeps running.
function toXlsxAsync(rep) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const w = new Worker(`
      const { parentPort, workerData } = require('worker_threads');
      const XLSX = require(workerData.xlsxPath);
      const { toXlsx } = require(workerData.selfPath);
      const buf = toXlsx(XLSX, workerData.rep);
      parentPort.postMessage(buf, [buf.buffer]);`,
      { eval: true, workerData: { rep, xlsxPath: require.resolve('xlsx'), selfPath: __filename } });
    w.once('message', b => resolve(Buffer.from(b.buffer, b.byteOffset, b.byteLength)));
    w.once('error', reject);
    w.once('exit', code => { if (code) reject(new Error('report worker exited ' + code)); });
  });
}

module.exports = {
  toXlsxAsync, buildReport, toXlsx, writeCsv, poExpiryStatus, plannedDay, outcome, MAX_ROWS };
