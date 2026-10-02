'use strict';

const XLSX = require('xlsx');
const { COUNTRY_NAMES } = require('./store');

const HEADER_MAP = {
  customername: 'customerName',
  customer: 'customerName',
  country: 'country',
  market: 'country',
  sku: 'sku',
  productname: 'productName',
  product: 'productName',
  qty: 'qty',
  quantity: 'qty',
  orderdate: 'orderDate',
  duedate: 'dueDate',
  status: 'status',
  orderstatus: 'status',
};

const COUNTRY_ALIASES = {
  singapore: 'SG',
  sg: 'SG',
  uae: 'AE',
  dubai: 'AE',
  unitedarabemirates: 'AE',
  ae: 'AE',
  uk: 'GB',
  unitedkingdom: 'GB',
  gb: 'GB',
  usa: 'US',
  unitedstates: 'US',
  us: 'US',
  canada: 'CA',
  ca: 'CA',
  mexico: 'MX',
  mx: 'MX',
};

const REQUIRED = ['customerName', 'country', 'sku', 'qty', 'orderDate'];

function normHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isRealIso(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function dateToIso(d) {
  const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return isRealIso(iso) ? iso : null;
}

function parseDateCell(v) {
  if (v == null || v === '') return { empty: true };
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return { error: 'not a real date' };
    const iso = dateToIso(v);
    return iso ? { iso } : { error: 'not a real date' };
  }
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return { error: 'not a real date' };
    const p = XLSX.SSF.parse_date_code(v);
    if (!p) return { error: 'not a real date' };
    const iso = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    return isRealIso(iso) ? { iso } : { error: 'not a real date' };
  }
  const s = String(v).trim();
  let iso = null;
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = s;
  else if (/^\d{4}\/\d{2}\/\d{2}$/.test(s)) iso = s.replace(/\//g, '-');
  else if (dmy) iso = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  if (!iso || !isRealIso(iso)) return { error: 'use YYYY-MM-DD' };
  return { iso };
}

function resolveCountry(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const key = s.toLowerCase().replace(/[^a-z]/g, '');
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
  const code = s.toUpperCase();
  if (COUNTRY_NAMES[code]) return code;
  for (const [c, name] of Object.entries(COUNTRY_NAMES)) {
    if (name.toLowerCase().replace(/[^a-z]/g, '') === key) return c;
  }
  return null;
}

function parseQty(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  const s = String(v ?? '').trim();
  if (/^[1-9]\d*$/.test(s)) return parseInt(s, 10);
  return null;
}

function cellBlank(v) {
  return v == null || String(v).trim() === '';
}

function parseStatusCell(v) {
  if (cellBlank(v)) return { empty: true };
  const raw = String(v).trim();
  const slug = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (slug === 'processing') return { status: 'processing' };
  if (slug === 'readytoship') return { status: 'ready_to_ship' };
  if (slug === 'shipped') return { status: 'shipped' };
  return { error: 'status must be Processing, Ready to ship, or Shipped' };
}

function unreadable(message) {
  return { rows: [], errors: [{ row: 1, error: message }], unreadable: true };
}

function parseOrdersWorkbook(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (_) {
    return unreadable('Could not read that spreadsheet');
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return unreadable('Could not read that spreadsheet');
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
  if (!grid.length) {
    return { rows: [], errors: [{ row: 1, error: 'No order rows found under the header' }] };
  }

  const header = (grid[0] || []).map(normHeader);
  const col = {};
  header.forEach((h, i) => {
    const field = HEADER_MAP[h];
    if (field && col[field] == null) col[field] = i;
  });
  const missing = REQUIRED.filter((f) => col[f] == null);
  if (missing.length) {
    return {
      rows: [],
      errors: [{
        row: 1,
        error: 'Row 1 must be the template header: Customer name, Country, SKU, Qty, Order date',
      }],
    };
  }

  const rows = [];
  const errors = [];
  for (let i = 1; i < grid.length; i++) {
    const line = grid[i] || [];
    const rowNumber = i + 1;
    const take = (field) => (col[field] == null ? '' : line[col[field]]);
    if (REQUIRED.every((f) => cellBlank(take(f))) && cellBlank(take('productName')) && cellBlank(take('dueDate')) && cellBlank(take('status'))) {
      continue;
    }
    const problems = [];
    const customerName = String(take('customerName') ?? '').trim();
    if (!customerName) problems.push('customer name is required');
    const country = resolveCountry(take('country'));
    if (!country) problems.push('country is not one we ship to');
    const sku = String(take('sku') ?? '').trim();
    if (!sku) problems.push('SKU is required');
    const qty = parseQty(take('qty'));
    if (qty == null) problems.push('qty must be a positive whole number');
    const orderParsed = parseDateCell(take('orderDate'));
    if (orderParsed.empty) problems.push('order date is required (YYYY-MM-DD)');
    else if (orderParsed.error) problems.push(`order date ${orderParsed.error}`);
    const dueParsed = parseDateCell(take('dueDate'));
    let dueDate = '';
    if (!dueParsed.empty) {
      if (dueParsed.error) problems.push(`due date ${dueParsed.error}`);
      else if (orderParsed.iso && dueParsed.iso < orderParsed.iso) problems.push('due date is earlier than the order date');
      else dueDate = dueParsed.iso || '';
    }
    const statusParsed = parseStatusCell(take('status'));
    if (statusParsed.error) problems.push(statusParsed.error);
    if (problems.length) {
      errors.push({ row: rowNumber, error: problems.join('; ') });
      continue;
    }
    const row = {
      rowNumber,
      customerName,
      country,
      countryName: COUNTRY_NAMES[country] || country,
      sku,
      productName: String(take('productName') ?? '').trim(),
      qty,
      orderDate: orderParsed.iso,
      dueDate,
    };
    if (statusParsed.status) row.status = statusParsed.status;
    rows.push(row);
  }

  if (!rows.length && !errors.length) {
    errors.push({ row: 1, error: 'No order rows found under the header' });
  }
  return { rows, errors };
}

function buildTemplate() {
  const wb = XLSX.utils.book_new();
  const orders = XLSX.utils.aoa_to_sheet([
    ['Customer name', 'Country', 'SKU', 'Product name', 'Qty', 'Order date', 'Due date', 'Status'],
    ['Aisha Rahman', 'SG', 'RAD-SER-30', 'Radiance Serum 30ml', 2, '2026-09-01', '2026-09-08', 'Processing'],
  ]);
  orders['!cols'] = [22, 12, 16, 28, 8, 14, 14, 16].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, orders, 'Orders');
  const countries = Object.entries(COUNTRY_NAMES).map(([code, name]) => `${code} (${name})`).join(', ');
  const notes = XLSX.utils.aoa_to_sheet([
    ['NimbusTrade order upload'],
    ['The example row on the Orders sheet will be imported if you leave it in.'],
    [`Country: ${countries}. A full name such as Singapore is accepted.`],
    ['Order date is required, YYYY-MM-DD. A missing date is not filled in for you.'],
    ['Due date is optional. When present it must be a real date on or after the order date.'],
    ['Qty is a positive whole number. Product name is optional. Blank rows are skipped.'],
    ['Status is optional. Leave it blank for Processing. Only Processing, Ready to ship, or Shipped.'],
    ['Rows that fail stay out. Rows that pass are still created.'],
  ]);
  notes['!cols'] = [{ wch: 96 }];
  XLSX.utils.book_append_sheet(wb, notes, 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { parseOrdersWorkbook, buildTemplate };
