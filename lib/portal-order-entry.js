// Portal "New Order" (key-in form + Excel/CSV upload): parsing, validation and
// the shape handed to the shared order intake (runOrderIntake in server.js).
// Pure functions only, so the rules are tested without a server.
const XLSX = require('xlsx');

const TEMPLATE_HEADERS = ['Order No', 'Channel', 'Recipient Name', 'Phone', 'Address', 'Postal Code', 'Remarks', 'SKU', 'Qty'];
const SAMPLE_ROWS = [
  ['SO-1001', 'Shopee', 'Tan Mei Ling', '91234567', '10 Anson Road #12-01', '079903', 'Leave at reception', 'YOUR-SKU-1', 2],
  ['SO-1001', 'Shopee', 'Tan Mei Ling', '91234567', '10 Anson Road #12-01', '079903', 'Leave at reception', 'YOUR-SKU-2', 1],
  ['SO-1002', 'Lazada', 'Ahmad Ismail', '98765432', 'Blk 123 Bedok North Ave 1 #05-67', '460123', '', 'YOUR-SKU-1', 3],
];
const FIELD_ALIASES = {
  order_number: ['order no', 'order number', 'order', 'order id', 'order #', 'order_no', 'order_number'],
  channel: ['channel', 'platform', 'channel/platform', 'marketplace'],
  recipient_name: ['recipient name', 'recipient', 'customer name', 'name', 'ship to name', 'recipient_name'],
  phone: ['phone', 'tel', 'mobile', 'contact no', 'phone number'],
  address: ['address', 'delivery address', 'shipping address'],
  postal_code: ['postal code', 'postcode', 'postal', 'zip', 'postal_code'],
  remarks: ['remarks', 'remark', 'notes', 'note'],
  sku: ['sku', 'item code', 'sku code', 'item'],
  qty: ['qty', 'quantity'],
};
const ORDER_FIELDS = ['channel', 'recipient_name', 'phone', 'address', 'postal_code', 'remarks'];
const ORDER_NO_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/#]{0,59}$/;
const MAX_ORDERS = 500, MAX_LINES = 200;

const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const norm = h => String(h ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function templateWorkbook() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, ...SAMPLE_ROWS]);
  ws['!cols'] = TEMPLATE_HEADERS.map(h => ({ wch: Math.max(10, h.length + 4) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Orders');
  const help = XLSX.utils.aoa_to_sheet([
    ['How to fill this in'],
    ['One row per item line. Rows with the same Order No are one order.'],
    ['Required: Order No, Recipient Name, Phone, Address, Postal Code (6 digits), SKU, Qty.'],
    ['SKU must be in your item master. Qty is a whole number above 0.'],
    ['Order No must be new: it cannot already exist, and cannot be reused by a different order in this file.'],
    ['Channel and Remarks are optional. Delete the sample rows before uploading.'],
  ]);
  XLSX.utils.book_append_sheet(wb, help, 'Instructions');
  return wb;
}
function templateBuffer(format = 'xlsx') {
  const wb = templateWorkbook();
  if (format === 'csv') return Buffer.from(XLSX.utils.sheet_to_csv(wb.Sheets.Orders) + '\n', 'utf8');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// File bytes → rows of cells (first sheet).
function readSheet(buf, filename = '') {
  const isCsv = /\.csv$/i.test(filename);
  const wb = isCsv ? XLSX.read(buf.toString('utf8').replace(/^\uFEFF/, ''), { type: 'string', raw: true })
                   : XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
}

// Rows of cells → orders grouped by Order No. Each order keeps the 1-based
// sheet row numbers it came from so failures can be traced back to the file.
function parseSheetRows(aoa) {
  const rows = (aoa || []).filter(r => Array.isArray(r) && r.some(c => String(c).trim() !== ''));
  if (!rows.length) return { orders: [], fileErrors: ['The file is empty.'] };
  const header = rows[0].map(norm);
  const col = {};
  for (const [f, al] of Object.entries(FIELD_ALIASES)) { const i = header.findIndex(h => al.includes(h)); if (i >= 0) col[f] = i; }
  const missingCols = ['order_number', 'sku', 'qty'].filter(f => col[f] == null);
  if (missingCols.length) {
    return { orders: [], fileErrors: [`Missing column(s): ${missingCols.map(f => TEMPLATE_HEADERS[['order_number', 'channel', 'recipient_name', 'phone', 'address', 'postal_code', 'remarks', 'sku', 'qty'].indexOf(f)]).join(', ')}. Use the sample template.`] };
  }
  const get = (r, f) => (col[f] == null ? '' : String(r[col[f]] ?? '').trim());
  const byNo = new Map(); const orders = [];
  let lastKey = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const rowNum = i + 1;
    const no = get(r, 'order_number');
    const key = no ? no.toUpperCase() : `__blank_${rowNum}`;
    let o = byNo.get(key);
    // An order's rows sit together. The same Order No coming back after a
    // different order is a second order reusing the number: a duplicate.
    if (o && key !== lastKey && !o.dupInFile) { o.dupInFile = true; o.errors.unshift(`Order No ${no} is used again at row ${rowNum} after other orders — duplicate order no in this file.`); }
    lastKey = key;
    if (!o) {
      o = { order_number: no, rows: [], lines: [], errors: [] };
      for (const f of ORDER_FIELDS) o[f] = '';
      byNo.set(key, o); orders.push(o);
    }
    o.rows.push(rowNum);
    for (const f of ORDER_FIELDS) { const v = get(r, f); if (v && !o[f]) o[f] = v; else if (v && o[f] && v !== o[f] && f !== 'remarks') o.errors.push(`Row ${rowNum}: ${f.replace('_', ' ')} "${v}" differs from "${o[f]}" on an earlier row of the same order.`); }
    o.lines.push({ sku: get(r, 'sku'), qty: get(r, 'qty'), row: rowNum });
  }
  return { orders, fileErrors: orders.length > MAX_ORDERS ? [`${orders.length} orders in one file — the maximum is ${MAX_ORDERS}.`] : [] };
}

// Validate orders against the client's OWN item master (Map sku/SKU-upper →
// item) and existing order numbers (taken(n) → true when already held).
// mode 'form' allows a blank order number (minted later); 'file' does not.
function validateOrders(orders, { items, taken = () => false, mode = 'file' } = {}) {
  const seen = new Map();
  for (const o of orders) { const k = String(o.order_number || '').trim().toUpperCase(); if (k) seen.set(k, (seen.get(k) || 0) + 1); }
  return (orders || []).map(src => {
    const errors = [...(src.errors || [])];
    const o = {
      order_number: clip(src.order_number, 60), channel: clip(src.channel, 60),
      recipient_name: clip(src.recipient_name, 120), phone: clip(src.phone, 40),
      address: clip(src.address, 300), postal_code: clip(src.postal_code, 12), remarks: clip(src.remarks, 500),
      rows: src.rows || [], lines: [],
    };
    if (!o.order_number) { if (mode !== 'form') errors.push('Order No is required.'); }
    else if (!ORDER_NO_RE.test(o.order_number)) errors.push('Order No may only use letters, digits and . _ - / # (max 60).');
    else if ((seen.get(o.order_number.toUpperCase()) || 0) > 1 && mode === 'form') errors.push(`Order No ${o.order_number} is used more than once in this submission.`);
    else if (taken(o.order_number)) errors.push(`Order No ${o.order_number} already exists.`);
    if (!o.recipient_name) errors.push('Recipient name is required.');
    if (!o.phone) errors.push('Phone is required.');
    else if (!/^\+?[0-9 ()-]{6,20}$/.test(o.phone)) errors.push('Phone must be 6–20 digits (spaces, +, - allowed).');
    if (!o.address) errors.push('Address is required.');
    if (!o.postal_code) errors.push('Postal code is required.');
    else if (!/^\d{6}$/.test(o.postal_code)) errors.push('Postal code must be 6 digits.');
    const merged = new Map();
    for (const l of Array.isArray(src.lines) ? src.lines : []) {
      const sku = clip(l && l.sku, 60); const rawQty = String(l && l.qty != null ? l.qty : '').trim();
      const at = l && l.row ? ` (row ${l.row})` : '';
      if (!sku && !rawQty) continue;
      if (!sku) { errors.push(`SKU is required${at}.`); continue; }
      const it = items.get(sku) || items.get(sku.toUpperCase());
      if (!it) { errors.push(`Unknown SKU ${sku}${at} — not in your item master.`); continue; }
      const qty = Number(rawQty);
      if (!rawQty) { errors.push(`Qty is required for ${sku}${at}.`); continue; }
      if (!Number.isInteger(qty) || qty <= 0 || qty > 100000) { errors.push(`Qty for ${sku}${at} must be a whole number from 1 to 100000.`); continue; }
      const cur = merged.get(it.sku) || { sku: it.sku, description: it.name || '', qty: 0 };
      cur.qty += qty; merged.set(it.sku, cur);
    }
    o.lines = [...merged.values()];
    if (!o.lines.length && !errors.some(e => /SKU|Qty/.test(e))) errors.push('Add at least one item line.');
    if (o.lines.length > MAX_LINES) errors.push(`At most ${MAX_LINES} lines per order.`);
    if (mode === 'file' && o.order_number && (seen.get(o.order_number.toUpperCase()) || 0) > 1) errors.unshift(`Order No ${o.order_number} appears for more than one order in this file.`);
    o.input_lines = (Array.isArray(src.lines) ? src.lines : []).map(l => ({ sku: clip(l && l.sku, 60), qty: String(l && l.qty != null ? l.qty : '').trim(), ...(l && l.row ? { row: l.row } : {}) })).filter(l => l.sku || l.qty);
    o.errors = [...new Set(errors)];
    o.ok = !o.errors.length;
    return o;
  });
}

// One validated order → the record shape POST /api/orders/intake takes.
function toIntakeOrder(o) {
  const addr = [o.address, o.postal_code && !o.address.includes(o.postal_code) ? `S(${o.postal_code})` : ''].filter(Boolean).join(' ');
  return {
    order_number: o.order_number, customer_name: o.recipient_name, tel: o.phone,
    delivery_address: addr, platform: o.channel,
    lines: o.lines.map(l => ({ sku: l.sku, qty: l.qty, description: l.description || '' })),
  };
}
// Fields the intake row shape does not carry, stamped on the created order.
function intakeExtras(o) {
  return { postal_code: o.postal_code, remarks: o.remarks, order_source: 'portal', keyed_in_portal: true };
}

// Failed orders → CSV in the template layout (+ Error), one row per line, so
// the client fixes the rows and re-uploads the same file.
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // no formula injection in Excel
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function failedRowsCsv(failed) {
  const out = [[...TEMPLATE_HEADERS, 'Error'].map(csvCell).join(',')];
  for (const o of failed || []) {
    const src = (o.input_lines && o.input_lines.length) ? o.input_lines : o.lines;
    const lines = (src && src.length) ? src : [{ sku: '', qty: '' }];
    const reason = Array.isArray(o.errors) ? o.errors.join(' | ') : (o.reason || '');
    for (const l of lines) out.push([o.order_number, o.channel, o.recipient_name, o.phone, o.address, o.postal_code, o.remarks, l.sku, l.qty, reason].map(csvCell).join(','));
  }
  return '\uFEFF' + out.join('\r\n') + '\r\n';
}

module.exports = { TEMPLATE_HEADERS, SAMPLE_ROWS, templateWorkbook, templateBuffer, readSheet, parseSheetRows, validateOrders, toIntakeOrder, intakeExtras, failedRowsCsv, csvCell, MAX_ORDERS };
