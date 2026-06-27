const express    = require('express');
const multer     = require('multer');
const { parse }  = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');
const XLSX       = require('xlsx');
const nodemailer = require('nodemailer');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Persistent storage ─────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WMS_DIR  = path.join(DATA_DIR, 'wms');
const DB_FILE  = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(WMS_DIR, { recursive: true });

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { batches: [] }; }
}
function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── Email ──────────────────────────────────────────────────────────────────
async function sendWmsEmail(batch, wmsBuffer, orders) {
  const { EMAIL_USER, EMAIL_PASS, EMAIL_TO, SMTP_HOST, SMTP_PORT } = process.env;
  if (!EMAIL_USER || !EMAIL_PASS || !EMAIL_TO) return;

  const transporter = nodemailer.createTransport({
    host:   SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(SMTP_PORT || '587', 10),
    secure: false,
    auth:   { user: EMAIL_USER, pass: EMAIL_PASS },
  });

  const orderList = orders.map(o =>
    `• ${o.order_number} | ${o.customer_name} | Waybill: ${o.waybill_number} | ${o.total_qty} units`
  ).join('\n');

  const wmsName = `WMS_${batch.filename.replace(/\.[^.]+$/, '')}_${batch.uploaded_at.slice(0, 10)}.xlsx`;

  await transporter.sendMail({
    from: EMAIL_USER,
    to:   EMAIL_TO,
    subject: `WMS Upload Ready — ${batch.filename} (${batch.order_count} orders)`,
    text: [
      `New order batch uploaded on ${new Date(batch.uploaded_at).toLocaleString()}.`,
      ``,
      `File: ${batch.filename}`,
      `Orders: ${batch.order_count}`,
      `Lines: ${batch.row_count}`,
      ``,
      orderList,
      ``,
      `WMS file attached.`,
    ].join('\n'),
    attachments: [{
      filename:    wmsName,
      content:     wmsBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }],
  });
}

// ── Session state ──────────────────────────────────────────────────────────
const sessions = {};

function getSession(id) {
  if (!sessions[id]) sessions[id] = { orders: [], scanStates: {}, batchId: null };
  return sessions[id];
}

function getScanState(session, orderNumber) {
  if (!session.scanStates[orderNumber])
    session.scanStates[orderNumber] = { status: 'pending', scanned: {} };
  return session.scanStates[orderNumber];
}

// ── Column mapping ─────────────────────────────────────────────────────────
function normalizeKey(k) {
  return String(k).toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().split('T')[0];
  const s = String(v).split('T')[0];
  return s || null;
}

function mapClientRow(row) {
  const n = {};
  for (const k of Object.keys(row)) n[normalizeKey(k)] = row[k];

  const rawQty = n.quantity ?? n.qty ?? 1;
  const qty    = typeof rawQty === 'number' ? Math.round(rawQty) : parseInt(String(rawQty), 10) || 1;

  return {
    order_number:     String(n.ref ?? n.order_number ?? n.order_no ?? 'UNKNOWN'),
    customer_name:    String(n.customer_name ?? ''),
    tel:              String(n.tel ?? ''),
    delivery_address: String(n.delivery_address ?? ''),
    waybill_number:   String(n.tracking_number ?? n.waybill_number ?? n.waybill ?? ''),
    carrier:          String(n.driver ?? n.carrier ?? ''),
    platform:         String(n.platform ?? ''),
    shop_name:        String(n.shop_name ?? ''),
    date:             dateStr(n.date),
    sku:              String(n.product_code ?? n.sku ?? n.item_code ?? ''),
    qty,
    batch_number:     String(n.batch_number ?? ''),
    expiry_date:      dateStr(n.expiry_date),
    remarks:          String(n.remarks ?? ''),
    remarks_betime:   String(n.remarks_betime ?? ''),
  };
}

function summarizeOrders(lines) {
  const map = {};
  for (const line of lines) {
    const key = line.order_number;
    if (!map[key]) {
      map[key] = {
        order_number:   key,
        customer_name:  line.customer_name,
        carrier:        line.carrier,
        waybill_number: line.waybill_number,
        date:           line.date,
        lines:     [],
        total_qty: 0,
      };
    }
    map[key].lines.push({
      sku:           line.sku,
      description:   line.sku,
      qty:           line.qty,
      uom:           'EACH',
      expiry_date:   line.expiry_date,
      remarks_betime: line.remarks_betime,
    });
    map[key].total_qty += line.qty;
  }
  return Object.values(map);
}

function ordersWithState(session) {
  return summarizeOrders(session.orders).map(ord => {
    const state = getScanState(session, ord.order_number);
    return { ...ord, scan_status: state.status, scanned: { ...state.scanned } };
  });
}

// ── BETIME WMS XLSX generation ─────────────────────────────────────────────
const BETIME_HEADERS = [
  'd-exline','d-sitecode','d-exref2','d-exdate2','d-SKUCODE','QTY',
  'd-uom','d-shname','d-exref1','d-exdate1','d-expdate','d-priority',
  'd-shaddr1','d-shaddr2','d-shaddr3','d-shaddr4','d-shzipcode',
  'd-shtotel','d-shtotelexfax','d-isdrem1','d-rem1','d-rcdate',
  'd-loccode','d-lot1','d-lot2','d-lot3','d-lot4','d-lot5',
  'd-lot6','d-lot7','d-lot8','d-lot9','d-lot10','d-lot11',
  'd-lot12','d-lot13','d-lot14','d-lot15','d-lot16',
];

function generateBeTimeXLSX(orders) {
  const aoa = [BETIME_HEADERS];
  let lineNum = 1;

  for (const order of orders) {
    const date = order.date ? new Date(order.date) : null;
    for (const line of order.lines) {
      const expiry = line.expiry_date ? new Date(line.expiry_date) : null;
      aoa.push([
        lineNum++,            // d-exline (replaced with formula below)
        'ULD-PL',             // d-sitecode
        order.order_number,   // d-exref2
        date,                 // d-exdate2
        line.sku,             // d-SKUCODE
        line.qty,             // QTY
        'EACH',               // d-uom
        order.customer_name,  // d-shname
        null, null, null, null,           // d-exref1, d-exdate1, d-expdate, d-priority
        order.waybill_number, // d-shaddr1
        null, null, null, null, null, null, null, // shaddr2-4, zipcode, tel, telexfax, isdrem1
        order.carrier,        // d-rem1
        null, null,           // d-rcdate, d-loccode
        expiry,               // d-lot1 (expiry date)
        null, null, null, null, null, null, null, null, null, null, null, // d-lot2-12
        line.remarks_betime || 'NM', // d-lot13
        null, null, null,     // d-lot14-16
      ]);
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });

  // Patch d-exline column with =ROW()-1 formula
  for (let r = 1; r < aoa.length; r++) {
    const addr  = XLSX.utils.encode_cell({ r, c: 0 });
    ws[addr]    = { t: 'n', f: 'ROW()-1', v: r };
  }

  XLSX.utils.book_append_sheet(wb, ws, 'IssueDetail');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── File parsing ───────────────────────────────────────────────────────────
function parseUploadedFile(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.csv') {
    const records = parse(buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
    return records.map(mapClientRow);
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const wb      = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const ws      = wb.Sheets[wb.SheetNames[0]];
    const records = XLSX.utils.sheet_to_json(ws, { defval: null });
    return records
      .map(mapClientRow)
      .filter(r => r.sku && r.order_number !== 'UNKNOWN');
  }

  throw new Error('Unsupported file type. Upload XLSX or CSV.');
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.post('/api/upload', upload.single('orderFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const mapped = parseUploadedFile(req.file.buffer, req.file.originalname);
    if (!mapped.length) return res.status(400).json({ error: 'No valid order rows found' });

    const sessionId     = req.headers['x-session-id'] || uuidv4();
    const session       = getSession(sessionId);
    session.orders      = mapped;
    session.scanStates  = {};

    const orders    = summarizeOrders(mapped);
    const wmsBuffer = generateBeTimeXLSX(orders);

    const batchId = uuidv4();
    const batch   = {
      id:          batchId,
      filename:    req.file.originalname,
      uploaded_at: new Date().toISOString(),
      order_count: orders.length,
      row_count:   mapped.length,
      orderStates: {},
    };

    const db = readDb();
    db.batches.unshift(batch);
    writeDb(db);
    fs.writeFileSync(path.join(WMS_DIR, `${batchId}.xlsx`), wmsBuffer);

    session.batchId = batchId;

    // Email in background — never blocks the upload response
    sendWmsEmail(batch, wmsBuffer, orders).catch(err =>
      console.error('[email]', err.message)
    );

    res.json({ sessionId, batchId, rowCount: mapped.length, orders: ordersWithState(session) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/download-wms/:batchId', (req, res) => {
  const filePath = path.join(WMS_DIR, `${req.params.batchId}.xlsx`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const db    = readDb();
  const batch = db.batches.find(b => b.id === req.params.batchId);
  const name  = batch
    ? `WMS_${batch.filename.replace(/\.[^.]+$/, '')}_${batch.uploaded_at.slice(0, 10)}.xlsx`
    : 'WMS_output.xlsx';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  fs.createReadStream(filePath).pipe(res);
});

app.get('/api/batches', (_req, res) => {
  const db = readDb();
  res.json(db.batches || []);
});

app.get('/api/orders', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  if (!session.orders.length) return res.json([]);
  res.json(ordersWithState(session));
});

app.post('/api/waybill-lookup', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  const { waybill } = req.body;
  if (!waybill) return res.status(400).json({ error: 'waybill required' });
  const order = ordersWithState(session).find(o =>
    o.waybill_number && o.waybill_number.trim().toLowerCase() === waybill.trim().toLowerCase()
  );
  if (!order) return res.status(404).json({ error: `No order for waybill: ${waybill}` });
  res.json(order);
});

app.post('/api/scan/increment', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  const { orderNumber, sku } = req.body;
  if (!orderNumber || !sku) return res.status(400).json({ error: 'orderNumber and sku required' });
  const order = summarizeOrders(session.orders).find(o => o.order_number === orderNumber);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const item = order.lines.find(l => l.sku.trim().toLowerCase() === sku.trim().toLowerCase());
  if (!item) return res.status(404).json({ error: `SKU "${sku}" not in this order` });
  const state = getScanState(session, orderNumber);
  state.status = 'processing';
  state.scanned[item.sku] = (state.scanned[item.sku] || 0) + 1;
  res.json({ sku: item.sku, scanned_qty: state.scanned[item.sku], ordered_qty: item.qty });
});

app.post('/api/scan/setqty', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  const { orderNumber, sku, qty } = req.body;
  if (!orderNumber || !sku) return res.status(400).json({ error: 'orderNumber and sku required' });
  const order = summarizeOrders(session.orders).find(o => o.order_number === orderNumber);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const item = order.lines.find(l => l.sku === sku);
  if (!item) return res.status(404).json({ error: `SKU "${sku}" not found` });
  const state = getScanState(session, orderNumber);
  state.status = 'processing';
  state.scanned[item.sku] = Math.max(0, parseInt(qty, 10) || 0);
  res.json({ sku: item.sku, scanned_qty: state.scanned[item.sku], ordered_qty: item.qty });
});

app.post('/api/scan/complete', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const order = summarizeOrders(session.orders).find(o => o.order_number === orderNumber);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const state = getScanState(session, orderNumber);
  const mismatches = order.lines
    .map(item => {
      const s = state.scanned[item.sku] || 0;
      return s !== item.qty
        ? { sku: item.sku, description: item.description, ordered: item.qty, scanned: s, gap: s - item.qty }
        : null;
    })
    .filter(Boolean);

  if (!mismatches.length) {
    state.status = 'done';
    persistState(session, orderNumber, 'done', state.scanned);
    return res.json({ ok: true, mismatches: [] });
  }
  res.json({ ok: false, mismatches });
});

app.post('/api/scan/cancel', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  session.scanStates[orderNumber] = { status: 'unprocessed', scanned: {} };
  persistState(session, orderNumber, 'unprocessed', {});
  res.json({ ok: true });
});

app.post('/api/scan/reset', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  session.scanStates[orderNumber] = { status: 'pending', scanned: {} };
  res.json({ ok: true });
});

function persistState(session, orderNumber, status, scanned) {
  if (!session.batchId) return;
  const db    = readDb();
  const batch = db.batches.find(b => b.id === session.batchId);
  if (!batch) return;
  if (!batch.orderStates) batch.orderStates = {};
  batch.orderStates[orderNumber] = { status, scanned, updated_at: new Date().toISOString() };
  writeDb(db);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fulfillment Scanner on port ${PORT}`));
