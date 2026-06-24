const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory session store (keyed by sessionId)
const sessions = {};

function getSession(id) {
  if (!sessions[id]) sessions[id] = { orders: [], waybills: {} };
  return sessions[id];
}

// Parse uploaded client order CSV into normalized order lines
app.post('/api/upload', upload.single('orderFile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const records = parse(req.file.buffer.toString('utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    if (!records.length) return res.status(400).json({ error: 'CSV is empty' });

    // Normalize column names to lowercase with underscores
    const normalized = records.map((r, idx) => {
      const row = {};
      for (const k of Object.keys(r)) row[k.toLowerCase().replace(/\s+/g, '_')] = r[k];
      return row;
    });

    // Required fields check
    const required = ['order_number', 'sku', 'quantity'];
    const missing = required.filter(f => !(f in normalized[0]));
    if (missing.length) {
      return res.status(400).json({ error: `Missing required columns: ${missing.join(', ')}` });
    }

    const sessionId = req.headers['x-session-id'] || uuidv4();
    const session = getSession(sessionId);
    session.orders = normalized;

    // Build waybill index: waybill_number -> [order_numbers]
    session.waybills = {};
    for (const line of normalized) {
      const wb = line.waybill_number || line.waybill || line.tracking_number || '';
      const ord = line.order_number || line.order_no || '';
      if (wb && ord) {
        if (!session.waybills[wb]) session.waybills[wb] = new Set();
        session.waybills[wb].add(ord);
      }
    }
    // Convert Sets to arrays for JSON
    for (const wb of Object.keys(session.waybills)) {
      session.waybills[wb] = [...session.waybills[wb]];
    }

    const orderSummary = summarizeOrders(normalized);

    res.json({ sessionId, rowCount: normalized.length, orders: orderSummary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Summarize order lines into order-level objects
function summarizeOrders(lines) {
  const map = {};
  for (const line of lines) {
    const ordNo = line.order_number || line.order_no || 'UNKNOWN';
    if (!map[ordNo]) {
      map[ordNo] = {
        order_number: ordNo,
        customer_name: line.customer_name || line.customer || '',
        ship_to_address: [
          line.ship_to_address || line.address || '',
          line.ship_to_city || line.city || '',
          line.ship_to_state || line.state || '',
          line.ship_to_zip || line.zip || '',
        ].filter(Boolean).join(', '),
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
      uom: line.uom || line.unit || 'EA',
    });
    map[ordNo].total_qty += qty;
  }
  return Object.values(map);
}

// Generate WMS order format CSV for picklist upload
app.get('/api/wms-export', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  if (!session.orders.length) return res.status(400).json({ error: 'No orders loaded' });

  const orders = summarizeOrders(session.orders);
  const rows = [];
  let wmsOrderCounter = 1;

  for (const ord of orders) {
    let lineNo = 1;
    const wmsOrderNo = `WMS-${String(wmsOrderCounter++).padStart(6, '0')}`;
    for (const item of ord.lines) {
      rows.push({
        WAREHOUSE_ORDER_NO: wmsOrderNo,
        CLIENT_ORDER_NO: ord.order_number,
        ORDER_DATE: new Date().toISOString().slice(0, 10),
        REQUIRED_DATE: ord.required_date || '',
        CUSTOMER_NAME: ord.customer_name,
        SHIP_TO_ADDRESS: ord.ship_to_address,
        CARRIER: ord.carrier,
        WAYBILL_NO: ord.waybill_number,
        LINE_NO: lineNo++,
        SKU: item.sku,
        DESCRIPTION: item.description,
        QTY_ORDERED: item.qty,
        UOM: item.uom,
        QTY_PICKED: '',
        PICK_STATUS: 'PENDING',
      });
    }
  }

  const csv = stringify(rows, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="wms_picklist.csv"');
  res.send(csv);
});

// Generate order scanning sheet: one row per line, ready for scan verification
app.get('/api/scan-sheet', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  if (!session.orders.length) return res.status(400).json({ error: 'No orders loaded' });

  const orders = summarizeOrders(session.orders);
  const rows = [];

  for (const ord of orders) {
    let lineNo = 1;
    for (const item of ord.lines) {
      rows.push({
        ORDER_NO: ord.order_number,
        CUSTOMER_NAME: ord.customer_name,
        WAYBILL_NO: ord.waybill_number,
        CARRIER: ord.carrier,
        REQUIRED_DATE: ord.required_date || '',
        LINE_NO: lineNo++,
        SKU: item.sku,
        DESCRIPTION: item.description,
        QTY_ORDERED: item.qty,
        QTY_SCANNED: '',
        SCAN_STATUS: '',
        WAYBILL_MATCH: '',
        REMARKS: '',
      });
    }
  }

  const csv = stringify(rows, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="order_scan_sheet.csv"');
  res.send(csv);
});

// Return order summary JSON for the UI
app.get('/api/orders', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  if (!session.orders.length) return res.json([]);
  res.json(summarizeOrders(session.orders));
});

// Verify a waybill against orders — POST { waybill, scannedItems: [{sku, qty}] }
app.post('/api/verify', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  const { orderNumber, scannedItems } = req.body;

  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });

  const orders = summarizeOrders(session.orders);
  const order = orders.find(o => o.order_number === orderNumber);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const scannedMap = {};
  for (const s of (scannedItems || [])) {
    scannedMap[s.sku] = (scannedMap[s.sku] || 0) + s.qty;
  }

  const lineResults = order.lines.map(line => {
    const pickedQty = scannedMap[line.sku] || 0;
    const status = pickedQty === line.qty ? 'OK' : pickedQty < line.qty ? 'SHORT' : 'OVER';
    return { sku: line.sku, description: line.description, qty_ordered: line.qty, qty_picked: pickedQty, status };
  });

  const allOk = lineResults.every(l => l.status === 'OK');
  const waybillMatch = !!order.waybill_number;

  res.json({
    order_number: order.order_number,
    customer_name: order.customer_name,
    waybill_number: order.waybill_number,
    waybill_match: waybillMatch,
    overall_status: allOk && waybillMatch ? 'READY_TO_SHIP' : 'NEEDS_REVIEW',
    lines: lineResults,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Order Processing Server running on port ${PORT}`));
