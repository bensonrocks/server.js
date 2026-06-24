const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = {};

function getSession(id) {
  if (!sessions[id]) sessions[id] = { orders: [], scanStates: {} };
  return sessions[id];
}

function getScanState(session, orderNumber) {
  if (!session.scanStates[orderNumber]) {
    session.scanStates[orderNumber] = { status: 'pending', scanned: {} };
  }
  return session.scanStates[orderNumber];
}

function normalizeRow(r) {
  const row = {};
  for (const k of Object.keys(r)) row[k.toLowerCase().replace(/[\s\-]+/g, '_')] = r[k];
  return row;
}

function summarizeOrders(lines) {
  const map = {};
  for (const line of lines) {
    const ordNo = line.order_number || line.order_no || 'UNKNOWN';
    if (!map[ordNo]) {
      map[ordNo] = {
        order_number: ordNo,
        customer_name: line.customer_name || line.customer || '',
        carrier: line.carrier || '',
        waybill_number: line.waybill_number || line.waybill || line.tracking_number || '',
        required_date: line.required_date || line.ship_date || '',
        lines: [],
        total_qty: 0,
      };
    }
    const qty = parseInt(line.quantity || line.qty || '1', 10) || 1;
    map[ordNo].lines.push({
      sku: line.sku || line.item_code || '',
      description: line.product_name || line.description || line.item_name || '',
      qty,
      uom: line.uom || line.unit || 'EACH',
    });
    map[ordNo].total_qty += qty;
  }
  return Object.values(map);
}

function ordersWithState(session) {
  return summarizeOrders(session.orders).map(ord => {
    const state = getScanState(session, ord.order_number);
    return { ...ord, scan_status: state.status, scanned: { ...state.scanned } };
  });
}

// Upload picklist CSV
app.post('/api/upload', upload.single('orderFile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const records = parse(req.file.buffer.toString('utf8'), {
      columns: true, skip_empty_lines: true, trim: true,
    });
    if (!records.length) return res.status(400).json({ error: 'CSV is empty' });

    const normalized = records.map(normalizeRow);
    const required = ['order_number', 'sku', 'quantity'];
    const missing = required.filter(f => !(f in normalized[0]));
    if (missing.length) return res.status(400).json({ error: `Missing required columns: ${missing.join(', ')}` });

    const sessionId = req.headers['x-session-id'] || uuidv4();
    const session = getSession(sessionId);
    session.orders = normalized;
    session.scanStates = {}; // reset on new upload

    const orders = ordersWithState(session);
    res.json({ sessionId, rowCount: normalized.length, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all orders with scan status
app.get('/api/orders', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  if (!session.orders.length) return res.json([]);
  res.json(ordersWithState(session));
});

// Look up order by waybill barcode
app.post('/api/waybill-lookup', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  const { waybill } = req.body;
  if (!waybill) return res.status(400).json({ error: 'waybill required' });

  const orders = ordersWithState(session);
  const order = orders.find(o =>
    o.waybill_number && o.waybill_number.trim().toLowerCase() === waybill.trim().toLowerCase()
  );
  if (!order) return res.status(404).json({ error: `No order found for waybill: ${waybill}` });
  res.json(order);
});

// Increment SKU qty by 1 (each barcode scan = +1)
app.post('/api/scan/increment', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  const { orderNumber, sku } = req.body;
  if (!orderNumber || !sku) return res.status(400).json({ error: 'orderNumber and sku required' });

  const orders = summarizeOrders(session.orders);
  const order = orders.find(o => o.order_number === orderNumber);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // Case-insensitive SKU match, also trim whitespace
  const item = order.lines.find(
    l => l.sku.trim().toLowerCase() === sku.trim().toLowerCase()
  );
  if (!item) return res.status(404).json({ error: `SKU "${sku}" not found in this order` });

  const state = getScanState(session, orderNumber);
  state.status = 'processing';
  state.scanned[item.sku] = (state.scanned[item.sku] || 0) + 1;

  res.json({ sku: item.sku, scanned_qty: state.scanned[item.sku], ordered_qty: item.qty });
});

// Set SKU qty directly (manual entry)
app.post('/api/scan/setqty', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  const { orderNumber, sku, qty } = req.body;
  if (!orderNumber || !sku) return res.status(400).json({ error: 'orderNumber and sku required' });

  const orders = summarizeOrders(session.orders);
  const order = orders.find(o => o.order_number === orderNumber);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const item = order.lines.find(l => l.sku === sku);
  if (!item) return res.status(404).json({ error: `SKU "${sku}" not found` });

  const state = getScanState(session, orderNumber);
  state.status = 'processing';
  state.scanned[item.sku] = Math.max(0, parseInt(qty, 10) || 0);

  res.json({ sku: item.sku, scanned_qty: state.scanned[item.sku], ordered_qty: item.qty });
});

// Validate and finalize an order
app.post('/api/scan/complete', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });

  const orders = summarizeOrders(session.orders);
  const order = orders.find(o => o.order_number === orderNumber);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const state = getScanState(session, orderNumber);
  const mismatches = order.lines
    .map(item => {
      const scanned = state.scanned[item.sku] || 0;
      return scanned !== item.qty
        ? { sku: item.sku, description: item.description, ordered: item.qty, scanned, gap: scanned - item.qty }
        : null;
    })
    .filter(Boolean);

  if (mismatches.length === 0) {
    state.status = 'done';
    res.json({ ok: true, mismatches: [] });
  } else {
    res.json({ ok: false, mismatches });
  }
});

// Cancel order — mark as unprocessed, clear scanned state
app.post('/api/scan/cancel', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });

  session.scanStates[orderNumber] = { status: 'unprocessed', scanned: {} };
  res.json({ ok: true });
});

// Reset order back to pending (for retry)
app.post('/api/scan/reset', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });

  session.scanStates[orderNumber] = { status: 'pending', scanned: {} };
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fulfillment Scanner running on port ${PORT}`));
