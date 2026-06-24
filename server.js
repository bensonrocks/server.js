const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const XLSX = require('xlsx');
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

// WMS column headers — exact order from BETIME_OUTBOUND_UPLOAD template
const WMS_HEADERS = [
  'd-exline','d-sitecode','d-exref2','d-exdate2','d-SKUCODE','QTY','d-uom',
  'd-shname','d-exref1','d-exdate1','d-expdate','d-priority',
  'd-shaddr1','d-shaddr2','d-shaddr3','d-shaddr4','d-shzipcode',
  'd-shtotel','d-shtotelexfax','d-isdrem1','d-rem1','d-rcdate','d-loccode',
  'd-lot1','d-lot2','d-lot3','d-lot4','d-lot5','d-lot6','d-lot7','d-lot8',
  'd-lot9','d-lot10','d-lot11','d-lot12','d-lot13','d-lot14','d-lot15','d-lot16',
];

function buildWmsRows(orders) {
  const dataRows = [];
  for (const ord of orders) {
    const orderDate = ord.required_date ? new Date(ord.required_date) : new Date();
    for (const item of ord.lines) {
      // One row per order line; d-exline formula added when writing the sheet
      dataRows.push({
        'd-sitecode': 'ULD-PL',
        'd-exref2':   ord.order_number,
        'd-exdate2':  isNaN(orderDate) ? new Date() : orderDate,
        'd-SKUCODE':  item.sku,
        'QTY':        item.qty,
        'd-uom':      item.uom || 'EACH',
        'd-shname':   ord.customer_name || '',
        'd-exref1':   '',
        'd-exdate1':  '',
        'd-expdate':  '',
        'd-priority': '',
        'd-shaddr1':  ord.waybill_number || '',   // tracking/waybill goes here
        'd-shaddr2':  '', 'd-shaddr3': '', 'd-shaddr4': '',
        'd-shzipcode':'', 'd-shtotel': '', 'd-shtotelexfax': '',
        'd-isdrem1':  '',
        'd-rem1':     ord.carrier || '',           // carrier/logistics provider
        'd-rcdate':   '', 'd-loccode': '',
        'd-lot1':'',  'd-lot2':'',  'd-lot3':'',  'd-lot4':'',
        'd-lot5':'',  'd-lot6':'',  'd-lot7':'',  'd-lot8':'',
        'd-lot9':'',  'd-lot10':'', 'd-lot11':'', 'd-lot12':'',
        'd-lot13': 'NM',                           // fixed value per template
        'd-lot14':'', 'd-lot15':'', 'd-lot16':'',
      });
    }
  }
  return dataRows;
}

// Generate WMS XLSX in the exact BETIME_OUTBOUND_UPLOAD format
app.get('/api/wms-export', (req, res) => {
  const session = getSession(req.headers['x-session-id'] || '');
  if (!session.orders.length) return res.status(400).json({ error: 'No orders loaded' });

  const orders = summarizeOrders(session.orders);
  const dataRows = buildWmsRows(orders);

  const wb = XLSX.utils.book_new();

  // Build AOA without d-exline (placeholder '') — patch formulas after sheet creation
  const aoa = [WMS_HEADERS];
  for (const r of dataRows) {
    aoa.push(WMS_HEADERS.map(h => {
      if (h === 'd-exline') return '';
      const v = r[h];
      return v instanceof Date ? v : (v ?? '');
    }));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });

  // Patch d-exline (col A) with =ROW()-1 formula + cached value for each data row
  for (let R = 1; R <= dataRows.length; R++) {
    const addr = XLSX.utils.encode_cell({ r: R, c: 0 });
    ws[addr] = { t: 'n', v: R, f: 'ROW()-1' };
  }

  // Format date column d-exdate2 (col D = index 3)
  for (let R = 1; R <= dataRows.length; R++) {
    const addr = XLSX.utils.encode_cell({ r: R, c: 3 });
    if (ws[addr]) { ws[addr].t = 'd'; ws[addr].z = 'yyyy-mm-dd'; }
  }

  XLSX.utils.book_append_sheet(wb, ws, 'IssueDetail');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="BETIME_OUTBOUND_UPLOAD.xlsx"');
  res.send(buf);
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
