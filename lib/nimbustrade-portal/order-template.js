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
  malaysia: 'MY',
  my: 'MY',
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

const BWL_MAP = {
  ordertype: 'orderType', ordernumber: 'orderNumber', recipientname: 'recipientName',
  recipientaddressline1: 'address1', recipientaddressline2: 'address2',
  city: 'city', state: 'state', country: 'country', recipientpostalcode: 'postal',
  countrycode: 'countryCode', recipientemail: 'email', recipientphone: 'phone',
  totalproducts: 'totalProducts', productsku: 'sku', productquantity: 'qty',
  productprice: 'price', ordertotal: 'orderTotal', currencycode: 'currency',
  paymentmethod: 'payment', carriercode: 'carrier',
};

const ITEM_MAP = {
  sku: 'sku', productsku: 'sku',
  description: 'description', productname: 'description',
  batchdetails: 'batch', batch: 'batch',
  serialnumber: 'serial', serial: 'serial',
  remark1: 'remark1', remark2: 'remark2',
};

const INBOUND_MAP = {
  reference: 'reference', country: 'country', origin: 'origin', mode: 'mode',
  carrier: 'carrier', waybill: 'waybillNumber', waybillnumber: 'waybillNumber',
  contents: 'contents', expectedqty: 'expectedQty', quantity: 'expectedQty', qty: 'expectedQty',
  expecteddate: 'expectedDate',
};

function looksLikeBwl(header) {
  return header.includes('ordernumber') && header.includes('productsku');
}

function readGrid(buffer) {
  let wb;
  try { wb = XLSX.read(buffer, { type: 'buffer', cellDates: true }); }
  catch (_) { return null; }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return null;
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
}

function mapColumns(header, map) {
  const col = {};
  header.forEach((h, i) => {
    const field = map[h];
    if (field && col[field] == null) col[field] = i;
  });
  return col;
}

function parseBwlGrid(grid) {
  const header = (grid[0] || []).map(normHeader);
  const col = mapColumns(header, BWL_MAP);
  if (col.orderNumber == null || col.recipientName == null || col.sku == null || col.qty == null || (col.country == null && col.countryCode == null)) {
    return unreadable('This order sheet needs Order Number, Recipient Name, Country or Country Code, Product Sku, and Product Quantity');
  }
  const rows = [];
  const errors = [];
  for (let i = 1; i < grid.length; i++) {
    const line = grid[i] || [];
    const rowNumber = i + 1;
    const take = (field) => (col[field] == null ? '' : line[col[field]]);
    const orderNumber = String(take('orderNumber') ?? '').trim();
    const recipientName = String(take('recipientName') ?? '').trim();
    const sku = String(take('sku') ?? '').trim();
    const countryRaw = String(take('country') ?? '').trim();
    const countryCodeRaw = String(take('countryCode') ?? '').trim();
    if ([orderNumber, recipientName, sku, countryRaw, countryCodeRaw, String(take('qty') ?? '').trim()].every((v) => !v)) continue;
    const problems = [];
    if (!orderNumber) problems.push('order number is required');
    if (!recipientName) problems.push('recipient name is required');
    const country = resolveCountry(countryRaw) || resolveCountry(countryCodeRaw);
    if (!country) problems.push('country is not one we ship to');
    if (!sku) problems.push('product sku is required');
    const qty = parseQty(take('qty'));
    if (qty == null) problems.push('product quantity must be a positive whole number');
    if (problems.length) {
      errors.push({ row: rowNumber, error: problems.join('; ') });
      continue;
    }
    const detail = {
      orderType: String(take('orderType') ?? '').trim(),
      address1: String(take('address1') ?? '').trim(),
      address2: String(take('address2') ?? '').trim(),
      city: String(take('city') ?? '').trim(),
      state: String(take('state') ?? '').trim(),
      postal: String(take('postal') ?? '').trim(),
      countryCode: countryCodeRaw,
      email: String(take('email') ?? '').trim(),
      phone: String(take('phone') ?? '').trim(),
      totalProducts: String(take('totalProducts') ?? '').trim(),
      price: String(take('price') ?? '').trim(),
      orderTotal: String(take('orderTotal') ?? '').trim(),
      currency: String(take('currency') ?? '').trim(),
      payment: String(take('payment') ?? '').trim(),
      carrier: String(take('carrier') ?? '').trim(),
    };
    rows.push({
      rowNumber,
      customerName: recipientName,
      country,
      countryName: COUNTRY_NAMES[country] || country,
      sku,
      productName: '',
      qty,
      orderDate: '',
      dueDate: '',
      orderRef: orderNumber,
      carrier: detail.carrier,
      detail,
    });
  }
  if (!rows.length && !errors.length) errors.push({ row: 1, error: 'No order rows found under the header' });
  return { rows, errors };
}

function parseItemMasterWorkbook(buffer) {
  const grid = readGrid(buffer);
  if (!grid) return unreadable('Could not read that spreadsheet');
  if (!grid.length) return { rows: [], errors: [{ row: 1, error: 'No item rows found under the header' }] };
  const header = (grid[0] || []).map(normHeader);
  if (looksLikeBwl(header)) return unreadable('This is an order sheet. Use the order upload, not the item master.');
  const col = mapColumns(header, ITEM_MAP);
  if (col.sku == null || col.description == null) {
    return unreadable('The item master header needs SKU and Description');
  }
  const rows = [];
  const errors = [];
  for (let i = 1; i < grid.length; i++) {
    const line = grid[i] || [];
    const rowNumber = i + 1;
    const take = (field) => (col[field] == null ? '' : line[col[field]]);
    const sku = String(take('sku') ?? '').trim();
    const description = String(take('description') ?? '').trim();
    const batch = String(take('batch') ?? '').trim();
    const serial = String(take('serial') ?? '').trim();
    const remark1 = String(take('remark1') ?? '').trim();
    const remark2 = String(take('remark2') ?? '').trim();
    if (![sku, description, batch, serial, remark1, remark2].some(Boolean)) continue;
    if (!sku || !description) {
      errors.push({ row: rowNumber, error: 'SKU and description are required' });
      continue;
    }
    rows.push({ rowNumber, sku, description, batch, serial, remark1, remark2 });
  }
  if (!rows.length && !errors.length) errors.push({ row: 1, error: 'No item rows found under the header' });
  return { rows, errors };
}

function parseInboundWorkbook(buffer) {
  const grid = readGrid(buffer);
  if (!grid) return unreadable('Could not read that spreadsheet');
  if (!grid.length) return { rows: [], errors: [{ row: 1, error: 'No inbound rows found under the header' }] };
  const header = (grid[0] || []).map(normHeader);
  if (looksLikeBwl(header)) return unreadable('This is an order sheet. Use the order upload, not inbound.');
  const col = mapColumns(header, INBOUND_MAP);
  if (col.country == null || col.contents == null || col.expectedQty == null) {
    return unreadable('The inbound header needs Country, Contents, and Expected Qty');
  }
  const rows = [];
  const errors = [];
  for (let i = 1; i < grid.length; i++) {
    const line = grid[i] || [];
    const rowNumber = i + 1;
    const take = (field) => (col[field] == null ? '' : line[col[field]]);
    const reference = String(take('reference') ?? '').trim();
    const countryRaw = String(take('country') ?? '').trim();
    const origin = String(take('origin') ?? '').trim();
    const modeRaw = String(take('mode') ?? '').trim().toLowerCase();
    const carrier = String(take('carrier') ?? '').trim();
    const waybillNumber = String(take('waybillNumber') ?? '').trim();
    const contents = String(take('contents') ?? '').trim();
    const expectedDateRaw = take('expectedDate');
    if (![reference, countryRaw, origin, modeRaw, carrier, waybillNumber, contents, String(take('expectedQty') ?? '').trim(), String(expectedDateRaw ?? '').trim()].some(Boolean)) continue;
    const problems = [];
    const country = resolveCountry(countryRaw);
    if (!country) problems.push('country is not one we ship to');
    if (!contents) problems.push('contents are required');
    const expectedQty = parseQty(take('expectedQty'));
    if (expectedQty == null) problems.push('expected qty must be a positive whole number');
    let mode = modeRaw || 'air';
    if (!['air', 'sea', 'road'].includes(mode)) problems.push('mode must be air, sea, or road');
    const dateParsed = parseDateCell(expectedDateRaw);
    let expectedDate = '';
    if (!dateParsed.empty) {
      if (dateParsed.error) problems.push(`expected date ${dateParsed.error}`);
      else expectedDate = dateParsed.iso || '';
    }
    if (problems.length) {
      errors.push({ row: rowNumber, error: problems.join('; ') });
      continue;
    }
    rows.push({
      rowNumber, reference, country, countryName: COUNTRY_NAMES[country] || country,
      origin, mode, carrier, waybillNumber, contents, expectedQty, expectedDate,
    });
  }
  if (!rows.length && !errors.length) errors.push({ row: 1, error: 'No inbound rows found under the header' });
  return { rows, errors };
}

function sheetBuffer(rows, sheetName, widths) {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (widths) sheet['!cols'] = widths.map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function buildBwlTemplate() {
  return sheetBuffer([
    ['#', 'Order Type', 'Order Number', 'Recipient Name', 'Recipient Address Line 1', 'Recipient Address Line 2', 'City', 'State', 'Country', 'Recipient Postal Code', 'Country Code', 'Recipient Email', 'Recipient Phone', 'Total Products', 'Product Sku', 'Product Quantity', 'Product Price', 'Order Total', 'Currency Code', 'Payment Method', 'Carrier Code'],
    [1, 'B2C', 'BWL-DEMO-1001', 'Aisha Rahman', '12 Harbour Walk', '', 'Singapore', '', 'Singapore', '018956', 'SG', 'aisha.demo@example.com', '', 1, 'RAD-SER-30', 2, '18.00', '36.00', 'SGD', 'Prepaid', 'DEMO'],
  ], 'Orders', [6, 12, 18, 20, 28, 24, 16, 12, 16, 18, 14, 28, 16, 14, 16, 16, 14, 14, 14, 16, 14]);
}

function buildItemMasterTemplate() {
  return sheetBuffer([
    ['SKU', 'Description', 'Batch details', 'Serial number', 'Remark 1', 'Remark 2'],
    ['RAD-SER-30', 'Radiance Serum 30ml', 'BATCH-DEMO-01', 'SN-DEMO-0001', '', ''],
  ], 'Item master', [16, 32, 18, 18, 18, 18]);
}

function buildInboundTemplate() {
  return sheetBuffer([
    ['Reference', 'Country', 'Origin', 'Mode', 'Carrier', 'Waybill Number', 'Contents', 'Expected Qty', 'Expected Date'],
    ['INB-DEMO-1', 'SG', 'Singapore', 'air', 'Demo Air', 'WB-DEMO-1001', 'Radiance Serum 30ml', 24, '2026-10-08'],
  ], 'Inbound', [16, 12, 16, 10, 16, 18, 28, 14, 16]);
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
  if (looksLikeBwl(header)) return parseBwlGrid(grid);
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

module.exports = {
  parseOrdersWorkbook,
  buildTemplate,
  parseItemMasterWorkbook,
  buildItemMasterTemplate,
  parseInboundWorkbook,
  buildInboundTemplate,
  buildBwlTemplate,
};
