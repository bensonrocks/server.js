const express    = require('express');
const multer     = require('multer');
const { parse }  = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const XLSX       = require('xlsx');
const nodemailer = require('nodemailer');
const { PDFDocument } = require('pdf-lib');
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch {}

let Docxtemplater, PizZip, DocxImageModule, bwipjs;
try {
  Docxtemplater   = require('docxtemplater');
  PizZip          = require('pizzip');
  DocxImageModule = require('docxtemplater-image-module-free');
} catch (e) { console.warn('[IdealScan] docxtemplater not available:', e.message); }
try { bwipjs = require('bwip-js'); } catch (e) { console.warn('[IdealScan] bwip-js not available:', e.message); }

// Keyfields WMS format — edit lib/keyfields.js to change column mappings or output
const {
  mapRow, normalizeKey, dateVal,
  detectColumnMap,
  buildRow,
  generateKeyfieldsXLSX, generateTemplateSampleXLSX,
  KEYFIELDS_HEADERS,
} = require('./lib/keyfields');

// Upload validation ruleset — edit lib/validation.js to change rules
const { validateRows } = require('./lib/validation');

// OCR parser for photo-based picklist upload
const { parseOcrPicklist } = require('./lib/ocr-parse');
let Tesseract;
try { Tesseract = require('tesseract.js'); } catch { Tesseract = null; }
let sharp;
try { sharp = require('sharp'); } catch { sharp = null; }

// Preprocess image before OCR: greyscale → normalize contrast → sharpen text edges
// Returns the processed PNG buffer, or the original buffer if sharp is unavailable.
async function preprocessForOcr(buffer) {
  if (!sharp) return buffer;
  try {
    return await sharp(buffer)
      .greyscale()
      .normalize()
      .sharpen({ sigma: 1.5, m1: 2.0, m2: 0.5 })
      .threshold(140)   // binarize to pure black/white — eliminates grey-pixel blur
                        // between characters that causes LSTM to hallucinate extra chars
      .png({ compressionLevel: 1 })
      .toBuffer();
  } catch {
    return buffer;
  }
}

// Run Tesseract with LSTM engine (OEM 1) + auto page segmentation (PSM 3).
// Extra Tesseract params can be passed as extraParams (e.g. char whitelist, PSM override).
async function runOcr(buffer, extraParams = {}) {
  const img = await preprocessForOcr(buffer);
  // OEM 1 = LSTM neural-net engine only (more accurate than legacy)
  const worker = await Tesseract.createWorker('eng', 1, { logger: () => {} });
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: '3',      // PSM_AUTO — let Tesseract detect layout
      preserve_interword_spaces: '1',  // keeps column spacing intact
      ...extraParams,
    });
    const { data: { text } } = await worker.recognize(img);
    return text;
  } finally {
    await worker.terminate();
  }
}

const app    = express();
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
const UPLOAD_MAX_ROWS  = 5000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/jsbarcode.min.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/jsbarcode/dist/JsBarcode.all.min.js'))
);

// ── Persistent storage ──────────────────────────────────────────────────────
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, 'data');
const WMS_DIR     = path.join(DATA_DIR, 'wms');
const WAYBILL_DIR = path.join(DATA_DIR, 'waybills');
const DB_FILE     = path.join(DATA_DIR, 'db.json');

const KEYFIELDS_TEMPLATE_FILE = path.join(DATA_DIR, 'keyfields_template.json');
const LABEL_TEMPLATES_FILE    = path.join(DATA_DIR, 'label_templates.json');
const DOC_TEMPLATE_DIR        = path.join(DATA_DIR, 'label_doc_templates');
const USERS_FILE              = path.join(DATA_DIR, 'users.json');
const EMAIL_CONFIG_FILE       = path.join(DATA_DIR, 'email_config.json');
// Not DATA_DIR — static reference data, always lives with the app code
const BETIME_CODE2_FILE       = path.join(__dirname, 'lib', 'betime-code2.json');

fs.mkdirSync(WMS_DIR,          { recursive: true });
fs.mkdirSync(WAYBILL_DIR,      { recursive: true });
fs.mkdirSync(DOC_TEMPLATE_DIR, { recursive: true });

// ── User credentials ─────────────────────────────────────────────────────────
// Users are stored inside db.json under the "users" key so all app data lives
// in one file. On first boot, existing users.json is migrated automatically.
function readUsers() {
  const db = readDb();
  return Array.isArray(db.users) ? db.users : [];
}
function writeUsers(users) {
  const db = readDb();
  db.users = users;
  writeDb(db);
}
function hashPass(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
// Seed / migrate users on startup
// SEED_USERS env var (JSON array) defines fixed accounts that are always
// recreated if missing. Existing passwords are never overwritten so
// admin-set passwords survive server restarts.
// Format: [{"id":"Admin1","name":"Admin One","role":"admin","password":"secret"}, ...]
;(function initUsers() {
  const db = readDb();

  // Migrate from legacy users.json if db.users doesn't exist yet
  if (!Array.isArray(db.users)) {
    let users = [];
    try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch {}
    if (!users.length) {
      const salt = crypto.randomBytes(16).toString('hex');
      users = [{ id: 'demo', name: 'Demo', role: 'admin', salt, passwordHash: hashPass('demo', salt) }];
    }
    db.users = users;
    writeDb(db);
  }

  // Apply SEED_USERS — add any missing accounts, never touch existing ones
  let seedList = [];
  try { seedList = JSON.parse(process.env.SEED_USERS || '[]'); } catch {}
  if (seedList.length) {
    const users  = readUsers();
    let changed  = false;
    for (const seed of seedList) {
      if (!seed.id || !seed.password) continue;
      const exists = users.find(u => u.id === String(seed.id));
      if (!exists) {
        const salt = crypto.randomBytes(16).toString('hex');
        users.push({
          id:           String(seed.id),
          name:         String(seed.name || seed.id),
          role:         seed.role === 'warehouse' ? 'warehouse' : 'admin',
          salt,
          passwordHash: hashPass(String(seed.password), salt),
        });
        changed = true;
        console.log(`[IdealScan] Seeded user: ${seed.id} (${seed.role || 'admin'})`);
      }
    }
    if (changed) writeUsers(users);
  }

  // Migrate existing users that pre-date the role field
  const users = readUsers();
  let changed = false;
  for (const u of users) { if (!u.role) { u.role = 'admin'; changed = true; } }
  if (changed) writeUsers(users);
})();

function loadCustomHeaders() {
  try {
    const data = JSON.parse(fs.readFileSync(KEYFIELDS_TEMPLATE_FILE, 'utf8'));
    if (Array.isArray(data.headers) && data.headers.length > 0) return data.headers;
  } catch {}
  return null;
}

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { batches: [] }; }
}
function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── Betime CODE 2 → Product Code map ─────────────────────────────────────────
// Loaded at startup. Translates customer barcodes (EAN-13 / CODE 2 field) to
// WMS product codes so scanning a barcode finds the correct order line.
// Entries with comma-separated barcodes in the source Excel are split so each
// barcode is its own key. Empty CODE 2 rows are omitted entirely.
let _beTimeCode2Map = {};
try {
  _beTimeCode2Map = JSON.parse(fs.readFileSync(BETIME_CODE2_FILE, 'utf8'));
  console.log(`[IdealScan] Betime CODE2 map loaded: ${Object.keys(_beTimeCode2Map).length} entries`);
} catch (e) {
  console.warn('[IdealScan] betime-code2.json not found — CODE2 barcode translation disabled');
}

// Resolve a scanned barcode to a WMS product code. Returns the original value
// unchanged when the barcode is not in the Betime CODE 2 map.
function resolveBeTimeCode2(scanned) {
  if (!scanned) return scanned;
  const k = scanned.trim();
  return _beTimeCode2Map[k] || k;
}

// ── Email config ─────────────────────────────────────────────────────────────
function readEmailConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(EMAIL_CONFIG_FILE, 'utf8')); } catch {}
  return {
    from_email: saved.from_email || process.env.EMAIL_USER || '',
    password:   saved.password   || process.env.EMAIL_PASS  || '',
    smtp_host:  saved.smtp_host  || process.env.SMTP_HOST   || 'smtp.gmail.com',
    smtp_port:  saved.smtp_port  || parseInt(process.env.SMTP_PORT || '587', 10),
    to_email:   saved.to_email   || process.env.EMAIL_TO    || 'opsgroup-sg@uldgroup.net',
  };
}

// ── Email ───────────────────────────────────────────────────────────────────
async function sendCompletionAlert(orderNumber, ord, operator) {
  const conf = readEmailConfig();
  if (!conf.from_email || !conf.password || !conf.to_email) {
    console.warn(`[IdealScan] Completion alert for ${orderNumber} skipped — email not configured.`);
    return { sent: false, reason: 'not_configured' };
  }
  const transporter = nodemailer.createTransport({
    host: conf.smtp_host, port: conf.smtp_port, secure: false,
    auth: { user: conf.from_email, pass: conf.password },
  });
  const opLine = operator ? `Operator: ${operator}\n` : '';
  await transporter.sendMail({
    from: conf.from_email, to: conf.to_email,
    subject: `[IdealScan] Order ${orderNumber} completed — please close in Keyfields`,
    text: [
      `Order ${orderNumber} has been fully scanned and marked completed.`,
      '',
      `Customer: ${ord.customer_name || ''}`,
      `Waybill:  ${ord.waybill_number || ''}`,
      opLine,
      'Please log into Keyfields WMS and close this order.',
      '',
      'Once closed, acknowledge it in IdealScan under the Orders tab.',
    ].join('\n'),
  });
  console.log(`[IdealScan] Completion alert sent to ${conf.to_email} for order ${orderNumber}.`);
  return { sent: true };
}

async function sendWmsEmail(batch, wmsBuffer, orders, emailTo, direction) {
  const conf = readEmailConfig();
  const recipient = emailTo || conf.to_email;
  if (!conf.from_email || !conf.password)
    throw new Error('Email not configured — add credentials in the Master panel (Upload Log → Email Settings)');
  if (!recipient) throw new Error('No recipient email address provided');

  const transporter = nodemailer.createTransport({
    host: conf.smtp_host,
    port: conf.smtp_port,
    secure: false,
    auth: { user: conf.from_email, pass: conf.password },
  });

  const orderList = orders.map(o =>
    `• ${o.order_number} | ${o.customer_name} | Waybill: ${o.waybill_number} | ${o.total_qty} units`
  ).join('\n');

  const wmsName = `WMS_${batch.filename.replace(/\.[^.]+$/, '')}_${batch.uploaded_at.slice(0, 10)}.xlsx`;

  const uploadDate  = new Date(batch.uploaded_at);
  const dateStr     = uploadDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const clientLabel = batch.client_name || orders[0]?.customer_name || 'General';
  const dirLabel    = direction === 'Inbound' ? 'Inbound' : 'Outbound';
  const subject     = `${dateStr} / ${clientLabel} / ${dirLabel} Upload`;

  await transporter.sendMail({
    from: conf.from_email, to: recipient,
    subject,
    text: [
      `New ${dirLabel.toLowerCase()} order batch uploaded on ${uploadDate.toLocaleString()}.`,
      '', `File: ${batch.filename}`, `Client: ${clientLabel}`,
      `Orders: ${batch.order_count}`, `Lines: ${batch.row_count}`,
      '', orderList, '', 'WMS file attached.',
    ].join('\n'),
    attachments: [{
      filename: wmsName, content: wmsBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }],
  });
}

// Column mapping and format generation live in lib/keyfields.js

function summarizeOrders(lines) {
  const map = {};
  for (const line of lines) {
    const key = line.order_number;
    if (!map[key]) {
      map[key] = {
        order_number:     key,
        customer_name:    line.customer_name,
        tel:              line.tel              || '',
        delivery_address: line.delivery_address || '',
        carrier:          line.carrier,
        waybill_number:   line.waybill_number,
        issue_no:         line.issue_no         || '',
        pick_ticket:      line.pick_ticket       || '',
        platform:         line.platform         || '',
        shop_name:        line.shop_name        || '',
        date:             line.date,
        lines:            [],
        total_qty:        0,
      };
    }
    map[key].lines.push({
      sku:            line.sku,
      description:    line.sku,
      qty:            line.qty,
      uom:            'EACH',
      batch_number:   line.batch_number   || '',
      serial_number:  line.serial_number  || '',
      expiry_date:    line.expiry_date    || '',
      remarks_betime: line.remarks_betime || '',
    });
    map[key].total_qty += line.qty;
  }
  return Object.values(map);
}

// Global shared view — reads all orders and their scan states directly from DB.
// Every browser/device sees the same data; no per-session isolation.
function globalOrdersWithState() {
  const db   = readDb();
  const seen = new Set();
  const out  = [];
  for (const batch of db.batches) {
    const states = batch.orderStates || {};
    for (const ord of (batch.orders || [])) {
      if (seen.has(ord.order_number)) continue; // newest batch wins
      seen.add(ord.order_number);
      const state       = states[ord.order_number] || { status: 'pending', scanned: {} };
      const waybillPath = path.join(WAYBILL_DIR, batch.id, `${ord.order_number}.pdf`);
      out.push({
        ...ord,
        scan_status:      state.status          || 'pending',
        scanned:          { ...state.scanned },
        mismatches:       state.mismatches       || [],
        startTime:        state.startTime        || null,
        endTime:          state.endTime          || null,
        operator:         state.operator         || null,
        keyfields_closed:  state.keyfields_closed   || false,
        alert_email_sent:  state.alert_email_sent   ?? null,
        alert_email_error: state.alert_email_error  || null,
        batchId:           batch.id,
        client_name:      batch.client_name      || '',
        has_waybill_pdf:  fs.existsSync(waybillPath),
      });
    }
  }
  return out;
}

// Find which batch holds a given order number (newest batch first).
function findBatchForOrder(db, orderNumber) {
  for (const batch of db.batches) {
    if ((batch.orders || []).some(o => o.order_number === orderNumber)) return batch;
  }
  return null;
}

// ── PDF waybill splitting ───────────────────────────────────────────────────
// Normalize a string for comparison: uppercase, strip spaces/hyphens/underscores
function normStr(s) { return String(s || '').replace(/[\s\-_]/g, '').toUpperCase(); }

async function splitWaybillPdf(pdfBuffer, batchId, orders) {
  const matched = {};
  try {
    const pdfDoc   = await PDFDocument.load(pdfBuffer);
    const numPages = pdfDoc.getPageCount();
    const dir      = path.join(WAYBILL_DIR, batchId);
    fs.mkdirSync(dir, { recursive: true });

    // Build lookup maps: normalized identifier → orderNumber
    // Priority 1: waybill number  2: order number  3: issue no  4: pick ticket
    const byWaybill    = new Map();
    const byOrder      = new Map();
    const byIssueNo    = new Map();
    const byPickTicket = new Map();
    for (const o of orders) {
      if (o.waybill_number) byWaybill.set(normStr(o.waybill_number),  o.order_number);
      if (o.order_number)   byOrder.set(normStr(o.order_number),      o.order_number);
      if (o.issue_no)       byIssueNo.set(normStr(o.issue_no),        o.order_number);
      if (o.pick_ticket)    byPickTicket.set(normStr(o.pick_ticket),   o.order_number);
    }

    for (let i = 0; i < numPages; i++) {
      const single = await PDFDocument.create();
      const [pg]   = await single.copyPages(pdfDoc, [i]);
      single.addPage(pg);
      const buf = Buffer.from(await single.save());

      let assignedOrder = null;

      if (pdfParse && (byWaybill.size || byOrder.size || byIssueNo.size || byPickTicket.size)) {
        try {
          const parsed   = await pdfParse(buf);
          const rawText  = (parsed.text || '').toUpperCase();
          const normText = rawText.replace(/[\s\-_]/g, '');

          // Priority 1: match by waybill number (most specific)
          for (const [key, orderNo] of byWaybill) {
            if (!matched[orderNo] && key.length >= 4 && normText.includes(key)) {
              assignedOrder = orderNo; matched[orderNo] = true; break;
            }
          }
          // Priority 2: match by order number
          if (!assignedOrder) {
            for (const [key, orderNo] of byOrder) {
              if (!matched[orderNo] && key.length >= 4 && normText.includes(key)) {
                assignedOrder = orderNo; matched[orderNo] = true; break;
              }
            }
          }
          // Priority 3: match by Issue No (Betime / WMS internal ref)
          if (!assignedOrder) {
            for (const [key, orderNo] of byIssueNo) {
              if (!matched[orderNo] && key.length >= 4 && normText.includes(key)) {
                assignedOrder = orderNo; matched[orderNo] = true; break;
              }
            }
          }
          // Priority 4: match by PickTicket number (Betime / WMS internal ref)
          if (!assignedOrder) {
            for (const [key, orderNo] of byPickTicket) {
              if (!matched[orderNo] && key.length >= 4 && normText.includes(key)) {
                assignedOrder = orderNo; matched[orderNo] = true; break;
              }
            }
          }
        } catch {}
      }

      const fname = assignedOrder ? `${assignedOrder}.pdf` : `_page_${i + 1}.pdf`;
      fs.writeFileSync(path.join(dir, fname), buf);
    }

    // Sequential fallback — if text extraction matched fewer pages than orders
    // (e.g. image-based label PDFs where no text can be extracted), match
    // remaining unmatched pages to remaining unmatched orders in sequence.
    // This works because carrier bulk label PDFs are printed in picklist order.
    const unmatchedOrders = orders.map(o => o.order_number).filter(n => !matched[n]);
    if (unmatchedOrders.length > 0 && numPages > 0) {
      // Collect unmatched page files in page order
      const unmatchedPages = [];
      for (let i = 0; i < numPages; i++) {
        const tmpPath = path.join(path.join(WAYBILL_DIR, batchId), `_page_${i + 1}.pdf`);
        if (fs.existsSync(tmpPath)) unmatchedPages.push({ i, tmpPath });
      }
      const pairs = Math.min(unmatchedPages.length, unmatchedOrders.length);
      for (let j = 0; j < pairs; j++) {
        const orderNo  = unmatchedOrders[j];
        const destPath = path.join(WAYBILL_DIR, batchId, `${orderNo}.pdf`);
        fs.renameSync(unmatchedPages[j].tmpPath, destPath);
        matched[orderNo] = true;
      }
    }
  } catch (err) {
    console.error('[pdf-split]', err.message);
  }
  return matched;
}

// Upload waybill PDF for an existing batch (post-upload or re-match)
const waybillPdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.post('/api/batch/:batchId/waybill-pdf', waybillPdfUpload.single('waybillPdf'), async (req, res) => {
  const { batchId } = req.params;
  const db    = readDb();
  const batch = db.batches.find(b => b.id === batchId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (!req.file) return res.status(400).json({ error: 'No PDF file received' });
  try {
    const matchResult = await splitWaybillPdf(req.file.buffer, batchId, batch.orders || []);
    res.json({ ok: true, matched: Object.keys(matchResult).length, total: (batch.orders || []).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Keyfields XLSX generation → see lib/keyfields.js

// ── Header-row detection ─────────────────────────────────────────────────────
// Some files have title/blank rows before the real column headers.
// Scan the first 15 rows and pick the one that looks most like headers.
const _HEADER_TERMS = /^(s[._\/]?n\.?|seq\.?|no\.?|status|account|reference|consign|address|remarks?|order|sku|item|code|qty|quantity|name|desc|date|product|part|material|batch|expiry|price|amount|total|uom|unit|barcode|pick|ticket|deliver|waybill|carrier|tel|phone|weight|pcs|pieces|line|ref|invoice|dispatch|pick_ticket)$/i;

function _detectHeaderRow(aoa) {
  let bestIdx = 0, bestScore = -1;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const row = aoa[i] || [];
    let score = 0;
    let strCells = 0;
    for (const cell of row) {
      if (cell === null || cell === undefined) continue;
      const s = String(cell).trim();
      if (_HEADER_TERMS.test(s)) score += 3;
      if (typeof cell === 'string' && /[A-Za-z]/.test(s) && s.length >= 2) { score += 0.5; strCells++; }
    }
    // Prefer rows with several string cells (header rows are mostly text)
    if (strCells >= 3) score += 1;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

// Scan rows BEFORE the table header for vertical key-value metadata pairs
// (col A = label, col B = value) and return them keyed for mapRow injection.
// e.g. "Reference | 1004643709" → { reference: "1004643709" }
const _KV_MAP = {
  'reference':        'reference',
  'ref':              'reference',
  'order no':         'order_no',
  'order number':     'order_number',
  'po number':        'po_number',
  'po no':            'po_number',
  'invoice no':       'order_number',
  'invoice number':   'order_number',
  'pick ticket':      'pick_ticket',
  'pick ticket no':   'pick_ticket',
  'pt no':            'pt_no',
  'issue no':         'issue_no',
  'issue number':     'issue_no',
  'consignee':        'consignee',
  'consignee name':   'consignee',
  'account':          'account',
  'client':           'client_name',
  'client name':      'client_name',
  'delivery date':    'delivery_date',
  'ship date':        'ship_date',
};
function _extractKVMeta(aoa, headerIdx) {
  const meta = {};
  for (let i = 0; i < headerIdx; i++) {
    const row = aoa[i] || [];
    const key = row[0] != null ? String(row[0]).trim().toLowerCase() : '';
    const val = row[1] != null ? String(row[1]).trim() : '';
    if (!key || !val) continue;
    const mapped = _KV_MAP[key];
    if (mapped && !meta[mapped]) meta[mapped] = val;
  }
  return meta;
}

// Build column-keyed record objects starting from the detected header row.
// When the sheet has a vertical KV section before the table (e.g. picking list
// exports), the extracted metadata (Reference, Issue No, etc.) is injected into
// every data record so mapRow can resolve the order number.
function _parseExcelSheet(ws) {
  const aoa     = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const hdrIdx  = _detectHeaderRow(aoa);
  const rawHdrs = aoa[hdrIdx] || [];
  const headers = rawHdrs.map((h, i) =>
    (h !== null && h !== undefined && String(h).trim() !== '') ? String(h).trim() : `_col${i}`
  );
  const records = aoa.slice(hdrIdx + 1)
    .filter(row => row && row.some(v => v !== null && v !== undefined && String(v).trim() !== ''))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (row[i] !== undefined ? row[i] : null); });
      return obj;
    });

  // Inject KV metadata so mapRow can find the order number and consignee
  const kvMeta = _extractKVMeta(aoa, hdrIdx);
  if (Object.keys(kvMeta).length > 0) {
    for (const rec of records) {
      for (const [k, v] of Object.entries(kvMeta)) {
        if (rec[k] === null || rec[k] === undefined || String(rec[k]).trim() === '') {
          rec[k] = v;
        }
      }
    }
  }

  return { records, headers };
}

// ── Wide-format (pivot) detection & melt ────────────────────────────────────
// Wide-format files have SKUs as COLUMN NAMES (one column per SKU, one row
// per order).  Detect and convert to long format (one row per order+SKU pair).
function _tryMeltWide(records, headers) {
  // A column is SKU-like if it has digits OR hyphens (e.g. AC-007-003-B, 100ML)
  // and is not a known metadata field name.
  const META_PAT = /^(s[._\/]?n|no\.?|seq|status|account|ref|address|remarks?|date|name|consign|line|uom|unit|total|grand|deliver|print|day|rite|amount|price|weight)$/i;
  // Keyfields/Betime reserved schema columns (d-exline, d-exref2, d-shaddr1, d-lot1...) are
  // metadata field names, never wide-pivot SKU columns — exclude the whole "d-"/"d_" namespace.
  const D_PREFIX_PAT = /^d[-_]/i;
  const skuCols  = headers.filter(h => (/\d/.test(h) || /[-_]/.test(h)) && /^[A-Z0-9][A-Z0-9_\-]{1,}$/i.test(h) && !META_PAT.test(h) && !D_PREFIX_PAT.test(h));
  if (skuCols.length < 2) return null;
  if (skuCols.length / headers.length < 0.25) return null;

  // Find the best order-identifier column
  const orderCol = headers.find(h => /ref(?:erence)?|order|consign|invoice|doc(?:ument)?|account/i.test(h))
    || headers.find(h => !META_PAT.test(h) && !/\d/.test(h) && h.length >= 3);
  if (!orderCol) return null;

  const melted = [];
  for (const rec of records) {
    const orderVal = (rec[orderCol] !== null && rec[orderCol] !== undefined) ? String(rec[orderCol]).trim() : '';
    if (!orderVal || orderVal === '') continue;
    for (const sku of skuCols) {
      const qty = Number(rec[sku]);
      if (!isNaN(qty) && qty > 0) {
        melted.push({ ...rec, [orderCol]: orderVal, __sku__: sku, __qty__: qty });
      }
    }
  }
  return melted.length > 0 ? melted : null;
}

// ── Metadata-row filter ──────────────────────────────────────────────────────
// Known single-word labels that are never valid SKUs.
const _LABEL_WORDS = new Set([
  'status','account','reference','consignee','address','line','remarks','remark',
  'note','notes','total','subtotal','grand','delivery','date','time','name',
  'description','type','category','price','amount','value','cost','no','number',
  'print','rite','day','item','product','qty','quantity','uom','unit','header',
  'footer','serial','sequence','count','sum','balance','debit','credit',
]);

function isMetadataRow(r) {
  const on  = String(r.order_number || '').trim();
  const sku = String(r.sku          || '').trim();
  if (!on || on === 'UNKNOWN') return true;
  // Same value for both order and sku → same column detected for both → wrong
  if (on === sku && on !== '') return true;
  // Multi-word phrase with no digits (e.g. "Pick Ticket", "Issuing Date/Time")
  if (/\s/.test(on) && !/\d/.test(on) && /^[A-Za-z]/.test(on)) return true;
  // SKU with spaces → a summary label like "Total Whole Qty", "Grand Total Loose"
  if (/\s/.test(sku)) return true;
  // SKU is a known label word (Status, Account, Reference, …)
  if (_LABEL_WORDS.has(sku.toLowerCase())) return true;
  // Warehouse bin/location address pattern (e.g. AC-007-003-B, A-01-02-C)
  // Format: [1-4 letters]-[2-5 digits]-[2-5 digits][-optional 1-2 alphanum]
  if (/^[A-Z]{1,4}-\d{2,5}-\d{2,5}(-[A-Z0-9]{1,2})?$/i.test(sku)) return true;
  return false;
}

// Quick pre-filter: strip obvious footer/total rows before column-map detection
// so they don't skew AI scoring of the real data columns.
function _isFooterRow(rec) {
  const first = Object.values(rec).find(v => v != null && String(v).trim() !== '');
  if (!first) return false;
  return /^(total\s+whole|total\s+loose|grand\s+total|subtotal|remarks?[\s:]|picked\s+by|checked\s+by|released\s+by)/i.test(String(first).trim());
}

// ── File parsing ────────────────────────────────────────────────────────────
function parseUploadedFile(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.csv') {
    const records  = parse(buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
    const detected = detectColumnMap(records);
    return records.map(r => mapRow(r, detected)).filter(r => r.sku && !isMetadataRow(r));
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const wb                   = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const ws                   = wb.Sheets[wb.SheetNames[0]];
    const { records, headers } = _parseExcelSheet(ws);
    const melted               = _tryMeltWide(records, headers);
    const finalRecs            = melted || records;
    const cleanRecs            = finalRecs.filter(r => !_isFooterRow(r));
    const detected             = detectColumnMap(cleanRecs);
    return cleanRecs.map(r => mapRow(r, detected)).filter(r => r.sku && !isMetadataRow(r));
  }
  throw new Error('Unsupported file type. Upload XLSX or CSV.');
}


// ── Routes ──────────────────────────────────────────────────────────────────

// Global auth guard — all /api/ routes require a valid session token except
// the explicit public list below.
const AUTH_PUBLIC = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/stats',
  '/api/public/orders',
  '/api/public/config',
]);
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (AUTH_PUBLIC.has(req.path) || req.path.startsWith('/api/public/')) return next();
  requireAuth(req, res, next);
});

// Parse-only preview — returns stats without saving anything
app.post('/api/preview', upload.single('orderFile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
      return res.json({ rowCount: 0, orderCount: 0, errors: ['Unsupported file type. Upload XLSX or CSV.'], converted: false });
    }

    let allRows = [], skipped = 0;
    if (ext === '.csv') {
      const records  = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
      const detected = detectColumnMap(records);
      const all      = records.map(r => mapRow(r, detected));
      allRows = all.filter(r => r.sku && !isMetadataRow(r));
      skipped = all.length - allRows.length;
    } else {
      const wb                   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      const ws                   = wb.Sheets[wb.SheetNames[0]];
      const { records, headers } = _parseExcelSheet(ws);
      const melted               = _tryMeltWide(records, headers);
      const finalRecs            = melted || records;
      const cleanRecs            = finalRecs.filter(r => !_isFooterRow(r));
      const detected             = detectColumnMap(cleanRecs);
      const all                  = cleanRecs.map(r => mapRow(r, detected));
      allRows = all.filter(r => r.sku && !isMetadataRow(r));
      skipped = cleanRecs.length - allRows.length;
    }

    if (allRows.length > UPLOAD_MAX_ROWS) {
      return res.json({ rowCount: allRows.length, orderCount: 0, errors: [`File has ${allRows.length} rows — maximum is ${UPLOAD_MAX_ROWS.toLocaleString()} per upload. Please split into smaller files.`], converted: false });
    }
    const orders     = summarizeOrders(allRows);
    const errors     = skipped > 0 ? [`${skipped} row(s) skipped (missing SKU or order number)`] : [];
    const clientName = allRows.find(r => r.client_name)?.client_name || '';
    const customerNames = [...new Set(allRows.map(r => r.customer_name).filter(Boolean))];
    res.json({ rowCount: allRows.length, orderCount: orders.length, errors, converted: allRows.length > 0, clientName, customerNames });
  } catch (err) {
    res.json({ rowCount: 0, orderCount: 0, errors: [err.message], converted: false });
  }
});

// ── OCR preview — photo → text → order parse (no save) ──────────────────────
app.post('/api/ocr/preview', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  if (!Tesseract) {
    return res.status(501).json({ error: 'OCR engine not installed. Run: npm install tesseract.js' });
  }
  try {
    const text   = await runOcr(req.file.buffer);
    const rows   = parseOcrPicklist(text);
    const orders = summarizeOrders(rows);
    if (!rows.length) {
      return res.json({ rowCount: 0, orderCount: 0, errors: ['No order items detected in photo. Ensure the picking list is clearly visible and in focus.'], converted: false, ocrText: text.slice(0, 500) });
    }
    res.json({ rowCount: rows.length, orderCount: orders.length, errors: [], converted: true, clientName: '', customerNames: [], ocrRows: rows });
  } catch (err) {
    res.json({ rowCount: 0, orderCount: 0, errors: [`OCR error: ${err.message}`], converted: false });
  }
});

// ── OCR upload — submit parsed photo rows as a batch ───────────────────────
app.post('/api/ocr/upload', express.json(), async (req, res) => {
  try {
    const { rows, client_name = '', direction = 'Outbound' } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows provided' });

    const orders    = summarizeOrders(rows);
    const wmsRows   = [];
    let vLine = 1;
    for (const order of orders) {
      for (const line of order.lines) wmsRows.push(buildRow(vLine++, order, line));
    }
    const validation = validateRows(wmsRows);
    if (!validation.passed) {
      return res.status(422).json({ error: validation.abortMessage, validation });
    }

    const wmsBuffer = generateKeyfieldsXLSX(orders, loadCustomHeaders());
    const batchId   = uuidv4();
    const batch = {
      id: batchId,
      filename:    `photo-scan-${new Date().toISOString().slice(0, 10)}.jpg`,
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.userId || '',
      client_name: client_name.trim(),
      order_count: orders.length,
      row_count:   rows.length,
      orderStates: {},
      orders,
      rawRows: rows,
    };
    const db = readDb();
    db.batches.unshift(batch);
    writeDb(db);
    fs.writeFileSync(path.join(WMS_DIR, `${batchId}.xlsx`), wmsBuffer);

    res.json({ batchId, orders, rowCount: rows.length, sessionId: uuidv4() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── OCR label scan — photo of white product label → {sku, batch, expiry} ──────
function parseLabelLines(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let sku = null, batch = null, expiry = null;

  for (const line of lines) {
    // SKU: 4–8 digit numeric code
    if (!sku && /^\d{4,8}$/.test(line)) { sku = line; continue; }
    // Expiry: MM/YYYY or MM-YYYY
    if (!expiry && /^\d{2}[\/\-]\d{4}$/.test(line)) { expiry = line.replace('-', '/'); continue; }
    // Batch: alphanumeric, 3–20 chars, not already used
    if (!batch && /^[A-Z0-9][A-Z0-9\-_]{2,19}$/i.test(line) && line !== sku) { batch = line; continue; }
  }

  // Looser pass: try inline extraction if line-per-field failed
  if (!sku) {
    const m = text.match(/\b(\d{4,8})\b/);
    if (m) sku = m[1];
  }
  if (!expiry) {
    const m = text.match(/\b(\d{2}[\/\-]\d{4})\b/);
    if (m) expiry = m[1].replace('-', '/');
  }
  if (!batch) {
    const m = text.match(/\b([A-Z]{2,4}\d{4,10}[A-Z0-9\-]*)\b/i);
    if (m && m[1] !== sku) batch = m[1];
  }

  const confidence = (sku ? 50 : 0) + (batch ? 25 : 0) + (expiry ? 25 : 0);
  return { sku: sku || null, batch: batch || null, expiry: expiry || null, confidence, needs_review: !sku || confidence < 75 };
}

app.post('/api/ocr/label', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  if (!Tesseract) {
    return res.status(501).json({ error: 'OCR engine not installed. Run: npm install tesseract.js' });
  }
  try {
    const text   = await runOcr(req.file.buffer, {
      tessedit_pageseg_mode: '6',  // PSM_SINGLE_BLOCK — compact product labels
      tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -_./:()&',
    });
    const result = parseLabelLines(text);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, sku: null, batch: null, expiry: null, confidence: 0, needs_review: true });
  }
});

const uploadFields = upload.fields([
  { name: 'orderFile',   maxCount: 1 },
  { name: 'waybillPdf',  maxCount: 1 },
]);

app.post('/api/upload', uploadFields, async (req, res) => {
  try {
    const orderFile  = req.files?.orderFile?.[0];
    const waybillPdf = req.files?.waybillPdf?.[0];

    if (!orderFile) return res.status(400).json({ error: 'No order file uploaded' });

    const mapped = parseUploadedFile(orderFile.buffer, orderFile.originalname);
    if (!mapped.length) return res.status(400).json({ error: 'No valid order rows found' });
    if (mapped.length > UPLOAD_MAX_ROWS) return res.status(400).json({ error: `File has ${mapped.length} rows — maximum is ${UPLOAD_MAX_ROWS.toLocaleString()} per upload. Please split into smaller files.` });

    const sessionId = req.headers['x-session-id'] || uuidv4();
    const orders    = summarizeOrders(mapped);

    // ── Validation (lib/validation.js) — ABORT if any error found ──────────
    const wmsRows = [];
    let vLine = 1;
    for (const order of orders) {
      for (const line of order.lines) {
        wmsRows.push(buildRow(vLine++, order, line));
      }
    }
    const validation = validateRows(wmsRows);
    if (!validation.passed) {
      return res.status(422).json({
        error:      validation.abortMessage,
        validation,
      });
    }
    // ── Validation passed — proceed ─────────────────────────────────────────

    const wmsBuffer  = generateKeyfieldsXLSX(orders, loadCustomHeaders());
    const batchId    = uuidv4();
    const fileClientName = mapped.find(r => r.client_name)?.client_name || '';
    const clientName = ((req.body?.client_name || '').trim() || fileClientName).trim();
    const emailTo    = (req.body?.email_to   || '').trim();
    const direction  = req.body?.direction === 'Inbound' ? 'Inbound' : 'Outbound';

    const batch = {
      id: batchId, filename: orderFile.originalname,
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.userId || '',
      client_name: clientName,
      order_count: orders.length, row_count: mapped.length,
      orderStates: {},
      orders,
      rawRows: mapped,
    };

    const db = readDb();
    db.batches.unshift(batch);
    writeDb(db);
    fs.writeFileSync(path.join(WMS_DIR, `${batchId}.xlsx`), wmsBuffer);

    // Split waybill PDF if provided
    if (waybillPdf) {
      splitWaybillPdf(waybillPdf.buffer, batchId, orders).catch(err =>
        console.error('[waybill-pdf]', err.message)
      );
    }

    let emailSent = false, emailError = '', actualRecipient = '';
    try {
      const conf = readEmailConfig();
      actualRecipient = emailTo || conf.to_email;
      await sendWmsEmail(batch, wmsBuffer, orders, emailTo, direction);
      emailSent = true;
    } catch (err) {
      console.error('[email]', err.message);
      emailError = err.message;
    }

    // Return the global view so every client immediately sees the same data
    res.json({ sessionId, batchId, rowCount: mapped.length, orders: globalOrdersWithState(), emailSent, emailError, emailTo: actualRecipient });
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

app.get('/api/waybill-pdf/:batchId/:orderNumber', (req, res) => {
  const { batchId, orderNumber } = req.params;
  const filePath = path.join(WAYBILL_DIR, batchId, `${orderNumber}.pdf`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Waybill PDF not found' });
  const disposition = req.query.dl === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${orderNumber}_waybill.pdf"`);
  fs.createReadStream(filePath).pipe(res);
});

app.get('/api/batches', (_req, res) => {
  const db = readDb();
  res.json(db.batches.map(b => ({
    id: b.id, filename: b.filename, uploaded_at: b.uploaded_at,
    client_name: b.client_name || '',
    order_count: b.order_count, row_count: b.row_count, orderStates: b.orderStates,
  })));
});

app.get('/api/stats', (_req, res) => {
  const db  = readDb();
  const now = new Date();
  const todayStr     = now.toISOString().split('T')[0];
  const yesterdayStr = new Date(now.getTime() - 86400000).toISOString().split('T')[0];

  let todayPending = 0, yesterdayDone = 0, totalScanMs = 0, scanCount = 0;
  let totalOrders  = 0, totalLines   = 0;
  const clientMap  = {};   // { [name]: { todayUploaded, todayPending, yesterdayBalance } }

  for (const batch of db.batches) {
    const batchDate   = batch.uploaded_at.split('T')[0];
    const states      = batch.orderStates || {};
    const batchOrders = batch.orders      || [];
    const cname       = (batch.client_name || 'General').trim();

    if (!clientMap[cname]) clientMap[cname] = { todayUploaded: 0, todayPending: 0, yesterdayBalance: 0 };
    const cs = clientMap[cname];

    totalOrders += batch.order_count || 0;
    totalLines  += batch.row_count   || 0;

    for (const ord of batchOrders) {
      const state  = states[ord.order_number];
      const isPending = !state || state.status === 'pending' || state.status === 'processing';
      if (batchDate === todayStr) {
        cs.todayUploaded++;
        if (isPending) { cs.todayPending++; todayPending++; }
      } else if (batchDate === yesterdayStr && isPending) {
        cs.yesterdayBalance++;
      }
    }

    for (const state of Object.values(states)) {
      if (state.status === 'done') {
        const doneDate = (state.endTime || state.updated_at || '').split('T')[0];
        if (doneDate === yesterdayStr) yesterdayDone++;
        if (state.startTime && state.endTime) {
          const ms = new Date(state.endTime) - new Date(state.startTime);
          if (ms > 0 && ms < 7200000) { totalScanMs += ms; scanCount++; }
        }
      }
    }
  }

  // Only include clients that have activity today or a yesterday balance
  const clientStats = Object.entries(clientMap)
    .filter(([, v]) => v.todayUploaded > 0 || v.yesterdayBalance > 0)
    .sort((a, b) => (b[1].todayUploaded - a[1].todayUploaded) || a[0].localeCompare(b[0]))
    .map(([name, v]) => ({ name, ...v }));

  res.json({ todayPending, yesterdayDone, totalOrders, totalLines,
    avgScanMs: scanCount ? Math.round(totalScanMs / scanCount) : 0, clientStats });
});

app.get('/api/orders', (_req, res) => {
  res.json(globalOrdersWithState());
});

app.post('/api/waybill-lookup', (req, res) => {
  const { waybill } = req.body;
  if (!waybill) return res.status(400).json({ error: 'waybill required' });
  const order = globalOrdersWithState().find(o =>
    o.waybill_number && o.waybill_number.trim().toLowerCase() === waybill.trim().toLowerCase()
  );
  if (!order) return res.status(404).json({ error: `No order for waybill: ${waybill}` });
  res.json(order);
});

app.post('/api/scan/increment', (req, res) => {
  const { orderNumber } = req.body;
  const raw = req.body.sku;
  const sku = resolveBeTimeCode2(raw);  // translate barcode → product code
  console.log(`[scan] raw="${raw}" resolved="${sku}" mapSize=${Object.keys(_beTimeCode2Map).length}`);
  if (!orderNumber || !sku) return res.status(400).json({ error: 'orderNumber and sku required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  const ord  = batch.orders.find(o => o.order_number === orderNumber);
  const item = ord.lines.find(l => l.sku.trim().toLowerCase() === sku.trim().toLowerCase());
  if (!item) return res.status(404).json({ error: `SKU "${sku}" not in this order` });
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  state.status = 'processing';
  state.scanned[item.sku] = (state.scanned[item.sku] || 0) + 1;
  state.updated_at = new Date().toISOString();
  batch.orderStates[orderNumber] = state;
  writeDb(db);
  res.json({ sku: item.sku, scanned_qty: state.scanned[item.sku], ordered_qty: item.qty });
});

app.post('/api/scan/setqty', (req, res) => {
  const { orderNumber, sku, qty } = req.body;
  if (!orderNumber || !sku) return res.status(400).json({ error: 'orderNumber and sku required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  const ord  = batch.orders.find(o => o.order_number === orderNumber);
  const item = ord.lines.find(l => l.sku === sku);
  if (!item) return res.status(404).json({ error: `SKU "${sku}" not found` });
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  state.status = 'processing';
  state.scanned[item.sku] = Math.max(0, parseInt(qty, 10) || 0);
  state.updated_at = new Date().toISOString();
  batch.orderStates[orderNumber] = state;
  writeDb(db);
  res.json({ sku: item.sku, scanned_qty: state.scanned[item.sku], ordered_qty: item.qty });
});

app.post('/api/scan/save', (req, res) => {
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  if (state.status !== 'done' && state.status !== 'unprocessed') state.status = 'processing';
  state.updated_at = new Date().toISOString();
  batch.orderStates[orderNumber] = state;
  writeDb(db);
  res.json({ ok: true });
});

app.post('/api/scan/complete', (req, res) => {
  const { orderNumber, startTime, endTime, operator } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  const ord   = batch.orders.find(o => o.order_number === orderNumber);
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  const mismatches = ord.lines.map(item => {
    const s = state.scanned[item.sku] || 0;
    return s !== item.qty ? { sku: item.sku, description: item.description, ordered: item.qty, scanned: s, gap: s - item.qty } : null;
  }).filter(Boolean);

  if (!mismatches.length) {
    state.status     = 'done';
    state.updated_at = new Date().toISOString();
    if (startTime) state.startTime = startTime;
    if (endTime)   state.endTime   = endTime;
    if (operator)  state.operator  = operator;
    batch.orderStates[orderNumber] = state;
    writeDb(db);
    sendCompletionAlert(orderNumber, ord, operator).then(result => {
      const db2    = readDb();
      const batch2 = findBatchForOrder(db2, orderNumber);
      if (batch2) {
        if (!batch2.orderStates) batch2.orderStates = {};
        const s2 = batch2.orderStates[orderNumber] || {};
        s2.alert_email_sent   = result?.sent ?? false;
        s2.alert_email_at     = new Date().toISOString();
        batch2.orderStates[orderNumber] = s2;
        writeDb(db2);
      }
    }).catch(err => {
      console.error(`[IdealScan] Completion alert FAILED for order ${orderNumber}:`, err.message);
      const db2    = readDb();
      const batch2 = findBatchForOrder(db2, orderNumber);
      if (batch2) {
        if (!batch2.orderStates) batch2.orderStates = {};
        const s2 = batch2.orderStates[orderNumber] || {};
        s2.alert_email_sent  = false;
        s2.alert_email_error = err.message;
        batch2.orderStates[orderNumber] = s2;
        writeDb(db2);
      }
    });
    return res.json({ ok: true, mismatches: [] });
  }
  res.json({ ok: false, mismatches });
});

app.post('/api/scan/cancel', (req, res) => {
  const { orderNumber, startTime, endTime, operator, mismatches } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  if (!batch.orderStates) batch.orderStates = {};
  const prevState = batch.orderStates[orderNumber] || { scanned: {} };
  batch.orderStates[orderNumber] = {
    status:     'unprocessed',
    scanned:    prevState.scanned || {},
    mismatches: Array.isArray(mismatches) ? mismatches : [],
    updated_at: new Date().toISOString(),
    ...(startTime && { startTime }),
    ...(endTime   && { endTime }),
    ...(operator  && { operator }),
  };
  writeDb(db);
  res.json({ ok: true });
});

app.post('/api/scan/reset', (req, res) => {
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  if (!batch.orderStates) batch.orderStates = {};
  batch.orderStates[orderNumber] = { status: 'pending', scanned: {}, updated_at: new Date().toISOString() };
  writeDb(db);
  res.json({ ok: true });
});

app.post('/api/scan/resend-completion-alert', async (req, res) => {
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  const ord = batch.orders.find(o => o.order_number === orderNumber);
  const state = (batch.orderStates || {})[orderNumber] || {};
  try {
    await sendCompletionAlert(orderNumber, ord, state.operator);
    if (!batch.orderStates) batch.orderStates = {};
    const s = batch.orderStates[orderNumber] || {};
    s.alert_email_sent  = true;
    s.alert_email_at    = new Date().toISOString();
    delete s.alert_email_error;
    batch.orderStates[orderNumber] = s;
    writeDb(db);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scan/keyfields-close', (req, res) => {
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  state.keyfields_closed    = true;
  state.keyfields_closed_at = new Date().toISOString();
  batch.orderStates[orderNumber] = state;
  writeDb(db);
  res.json({ ok: true });
});

// ── Auth / session enforcement ───────────────────────────────────────────────
// One active session per user. Logging in from a new device invalidates the old one.
const activeSessions = new Map(); // userId → token

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  for (const [userId, t] of activeSessions) {
    if (t === token) { req.userId = userId; return next(); }
  }
  res.status(401).json({ error: 'Session expired' });
}

app.post('/api/auth/login', (req, res) => {
  const { id, password } = req.body;
  if (!id || !password) return res.status(400).json({ error: 'User ID and password required' });
  const user = readUsers().find(u => u.id === String(id).trim());
  if (!user || hashPass(password, user.salt) !== user.passwordHash)
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = uuidv4();
  activeSessions.set(user.id, token); // replaces any existing session for this user
  res.json({ id: user.id, name: user.name || user.id, role: user.role || 'admin', token });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) {
    for (const [userId, t] of activeSessions) {
      if (t === token) { activeSessions.delete(userId); break; }
    }
  }
  res.json({ ok: true });
});

// ── Profile — per-user settings (printer, label size) ───────────────────────
const VALID_LABEL_SIZES = ['100x160', '100x150', '4x6'];

app.get('/api/profile', requireAuth, (req, res) => {
  const user = readUsers().find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    id:          user.id,
    name:        user.name,
    role:        user.role || 'admin',
    printerName: user.printerName || '',
    labelSize:   user.labelSize   || '100x160',
  });
});

app.put('/api/profile/printer', requireAuth, (req, res) => {
  const { printerName, labelSize } = req.body || {};
  const users = readUsers();
  const idx   = users.findIndex(u => u.id === req.userId);
  if (idx < 0) return res.status(404).json({ error: 'User not found' });
  users[idx].printerName = String(printerName || '').trim().slice(0, 120);
  users[idx].labelSize   = VALID_LABEL_SIZES.includes(labelSize) ? labelSize : '100x160';
  writeUsers(users);
  res.json({ ok: true, printerName: users[idx].printerName, labelSize: users[idx].labelSize });
});

// ── Public stats (no auth needed) ──────────────────────────────────────────
// /api/stats already has no auth — it's used on page load before login.

// /api/public/orders — same as /api/orders, kept for backward compat
app.get('/api/public/orders', (_req, res) => res.json(globalOrdersWithState()));

// Public: non-sensitive config (default recipient address only — no credentials)
app.get('/api/public/config', (_req, res) => {
  const conf = readEmailConfig();
  res.json({ default_email: conf.to_email || '' });
});

// ── Master endpoints (password-protected) ───────────────────────────────────
const MASTER_PASS = process.env.MASTER_KEY || '201432547E';

function checkMaster(req, res) {
  if (req.headers['x-master-key'] !== MASTER_PASS) {
    res.status(403).json({ error: 'Forbidden' }); return false;
  }
  return true;
}

app.get('/api/master/export-status', (req, res) => {
  if (!checkMaster(req, res)) return;
  const db   = readDb();
  const rows = [['Batch File','Uploaded By','Client','Uploaded At','Order No','Customer','Carrier','Waybill','Total Qty','Status','Scanned Qty','Start Time','End Time','Operator']];
  for (const batch of db.batches) {
    const states  = batch.orderStates || {};
    const dateStr = new Date(batch.uploaded_at).toLocaleString();
    for (const ord of (batch.orders || [])) {
      const state        = states[ord.order_number] || {};
      const scannedTotal = Object.values(state.scanned || {}).reduce((s, v) => s + v, 0);
      rows.push([
        batch.filename, batch.uploaded_by || '', batch.client_name || '', dateStr,
        ord.order_number, ord.customer_name || '', ord.carrier || '', ord.waybill_number || '',
        ord.total_qty || 0, state.status || 'pending', scannedTotal,
        state.startTime || '', state.endTime || '', state.operator || '',
      ]);
    }
  }
  const wb  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Status');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="IDEALSCAN_Status_${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.end(buf);
});

app.post('/api/master/reset', (req, res) => {
  if (!checkMaster(req, res)) return;
  try {
    writeDb({ batches: [] });
    activeSessions.clear();
    for (const f of fs.readdirSync(WMS_DIR))
      try { fs.unlinkSync(path.join(WMS_DIR, f)); } catch {}
    for (const d of fs.readdirSync(WAYBILL_DIR)) {
      const dp = path.join(WAYBILL_DIR, d);
      try { fs.rmSync(dp, { recursive: true, force: true }); } catch {}
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Master: delete batch / delete single order ───────────────────────────────

app.delete('/api/master/batch/:batchId', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { batchId } = req.params;
  try {
    const db  = readDb();
    const idx = db.batches.findIndex(b => b.id === batchId);
    if (idx === -1) return res.status(404).json({ error: 'Batch not found' });
    db.batches.splice(idx, 1);
    writeDb(db);
    try { fs.unlinkSync(path.join(WMS_DIR, `${batchId}.xlsx`)); } catch {}
    try { fs.rmSync(path.join(WAYBILL_DIR, batchId), { recursive: true, force: true }); } catch {}
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/master/order/:batchId/:orderNumber', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { batchId, orderNumber } = req.params;
  try {
    const db    = readDb();
    const batch = db.batches.find(b => b.id === batchId);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const before  = (batch.orders || []).length;
    batch.orders  = (batch.orders || []).filter(o => o.order_number !== orderNumber);
    if (batch.orders.length === before) return res.status(404).json({ error: 'Order not found in batch' });
    batch.order_count = batch.orders.length;
    if (batch.rawRows) batch.rawRows = batch.rawRows.filter(r => r.order_number !== orderNumber);
    if (batch.orderStates) delete batch.orderStates[orderNumber];
    try { fs.unlinkSync(path.join(WAYBILL_DIR, batchId, `${orderNumber}.pdf`)); } catch {}
    writeDb(db);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Master: find/remove batches corrupted by the wide-pivot-melt bug ────────
// A fixed bug (_tryMeltWide misreading Keyfields/Betime "d-" metadata columns
// as SKU columns) saved some uploaded batches with fake item rows (sku values
// like "d-exline", "d-exref2", "d-exdate2") instead of real product SKUs. The
// real SKU values were never stored, so these batches can't be repaired in
// place — they must be re-uploaded from the original source file. These
// routes locate and remove the affected batches so they can be re-uploaded.
// Exact match only (no "d-" prefix heuristic) — a real product SKU could
// legitimately start with "D-"; the reserved Keyfields names below are an
// exact, fixed list so matching them precisely carries no false-positive risk.
const _RESERVED_KEYFIELDS = new Set(KEYFIELDS_HEADERS.map(h => h.toLowerCase()));
function _isMeltBugSku(sku) {
  return _RESERVED_KEYFIELDS.has(String(sku || '').trim().toLowerCase());
}
function _findMeltBugBatches(db) {
  return db.batches.filter(b =>
    (b.orders || []).some(o => (o.lines || []).some(l => _isMeltBugSku(l.sku)))
  );
}

app.get('/api/master/melt-bug-scan', (req, res) => {
  if (!checkMaster(req, res)) return;
  const db       = readDb();
  const affected = _findMeltBugBatches(db).map(b => ({
    batchId:      b.id,
    filename:     b.filename,
    uploaded_at:  b.uploaded_at,
    client_name:  b.client_name || '',
    order_count:  b.order_count,
    row_count:    b.row_count,
  }));
  res.json({ affectedCount: affected.length, batches: affected });
});

app.delete('/api/master/melt-bug-batches', (req, res) => {
  if (!checkMaster(req, res)) return;
  try {
    const db       = readDb();
    const affected = _findMeltBugBatches(db);
    const removed  = affected.map(b => ({ batchId: b.id, filename: b.filename, client_name: b.client_name || '' }));
    const ids      = new Set(affected.map(b => b.id));
    db.batches = db.batches.filter(b => !ids.has(b.id));
    writeDb(db);
    for (const b of affected) {
      try { fs.unlinkSync(path.join(WMS_DIR, `${b.id}.xlsx`)); } catch {}
      try { fs.rmSync(path.join(WAYBILL_DIR, b.id), { recursive: true, force: true }); } catch {}
    }
    res.json({ ok: true, removedCount: removed.length, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Master: Keyfields template download / upload / reset ────────────────────

app.get('/api/master/keyfields-template', (req, res) => {
  if (!checkMaster(req, res)) return;
  const customHeaders = loadCustomHeaders();
  const buf = generateTemplateSampleXLSX(customHeaders);
  const tag = customHeaders ? 'custom' : 'default';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Keyfields_Template_${tag}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.end(buf);
});

app.post('/api/master/keyfields-template', upload.single('templateFile'), (req, res) => {
  if (!checkMaster(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return res.status(400).json({ error: 'Empty workbook' });
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const headers = (aoa[0] || []).map(h => String(h).trim()).filter(Boolean);
    if (headers.length === 0) return res.status(400).json({ error: 'No headers found in row 1' });
    fs.writeFileSync(KEYFIELDS_TEMPLATE_FILE, JSON.stringify({ headers, uploadedAt: new Date().toISOString() }, null, 2));
    res.json({ ok: true, headers, count: headers.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/master/keyfields-template', (req, res) => {
  if (!checkMaster(req, res)) return;
  try {
    fs.unlinkSync(KEYFIELDS_TEMPLATE_FILE);
  } catch {}
  res.json({ ok: true, headers: KEYFIELDS_HEADERS });
});

// ── Master: Label templates ──────────────────────────────────────────────────
const LABEL_TPL_COLUMNS = [
  'carrier','header_text','header_bg','header_color',
  'show_barcode','show_items','show_address','show_tel','show_platform','show_order_no',
];

function readLabelTemplates() {
  try { return JSON.parse(fs.readFileSync(LABEL_TEMPLATES_FILE, 'utf8')); }
  catch { return []; }
}
function writeLabelTemplates(templates) {
  fs.writeFileSync(LABEL_TEMPLATES_FILE, JSON.stringify(templates, null, 2));
}
function parseBool(v, def = true) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase().trim();
  if (s === 'false' || s === '0' || s === 'no') return false;
  if (s === 'true'  || s === '1' || s === 'yes') return true;
  return def;
}

app.get('/api/master/label-templates', (req, res) => {
  if (!checkMaster(req, res)) return;
  res.json(readLabelTemplates());
});

app.get('/api/master/label-templates/export', (req, res) => {
  if (!checkMaster(req, res)) return;
  const rows = readLabelTemplates();
  const aoa  = [
    LABEL_TPL_COLUMNS,
    ...rows.map(t => LABEL_TPL_COLUMNS.map(k => {
      const v = t[k];
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      return v ?? '';
    })),
    // blank sample row
    ['NewCarrier','Header Text','#000000','#ffffff','TRUE','TRUE','TRUE','TRUE','TRUE','TRUE'],
  ];
  const wb  = XLSX.utils.book_new();
  const ws  = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = LABEL_TPL_COLUMNS.map((c, i) => ({ wch: i < 2 ? 18 : 14 }));
  XLSX.utils.book_append_sheet(wb, ws, 'LabelTemplates');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="LabelTemplates_${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.end(buf);
});

app.post('/api/master/label-templates/upload', upload.single('templateFile'), (req, res) => {
  if (!checkMaster(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb  = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws  = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return res.status(400).json({ error: 'Empty workbook' });
    const [headerRow, ...dataRows] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const cols = (headerRow || []).map(h => String(h).trim().toLowerCase());
    const ci   = k => cols.indexOf(k);
    if (ci('carrier') < 0) return res.status(400).json({ error: 'Missing "carrier" column in row 1' });

    const imported = [];
    for (const row of dataRows) {
      const carrier = String(row[ci('carrier')] || '').trim();
      if (!carrier || carrier.toLowerCase() === 'newcarrier') continue;
      imported.push({
        carrier,
        header_text  : String(row[ci('header_text')]  || carrier).trim(),
        header_bg    : String(row[ci('header_bg')]     || '#000000').trim(),
        header_color : String(row[ci('header_color')]  || '#ffffff').trim(),
        show_barcode : parseBool(row[ci('show_barcode')]),
        show_items   : parseBool(row[ci('show_items')]),
        show_address : parseBool(row[ci('show_address')]),
        show_tel     : parseBool(row[ci('show_tel')]),
        show_platform: parseBool(row[ci('show_platform')]),
        show_order_no: parseBool(row[ci('show_order_no')]),
      });
    }
    if (imported.length === 0) return res.status(400).json({ error: 'No valid carrier rows found' });

    const previousCount = readLabelTemplates().length;
    // Full replace — new file becomes the complete list
    writeLabelTemplates(imported);
    res.json({ ok: true, imported: imported.length, replaced: previousCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/master/label-templates', express.json(), (req, res) => {
  if (!checkMaster(req, res)) return;
  const { carrier, header_text, header_bg, header_color,
          show_barcode, show_items, show_address, show_tel,
          show_platform, show_order_no } = req.body;
  if (!carrier) return res.status(400).json({ error: 'carrier is required' });
  const templates = readLabelTemplates();
  const idx = templates.findIndex(t => t.carrier.toLowerCase() === carrier.toLowerCase());
  const entry = {
    carrier      : String(carrier).trim(),
    header_text  : String(header_text || carrier).trim(),
    header_bg    : header_bg    || '#000000',
    header_color : header_color || '#ffffff',
    show_barcode : show_barcode  !== false,
    show_items   : show_items    !== false,
    show_address : show_address  !== false,
    show_tel     : show_tel      !== false,
    show_platform: show_platform !== false,
    show_order_no: show_order_no !== false,
  };
  if (idx >= 0) templates[idx] = entry; else templates.push(entry);
  writeLabelTemplates(templates);
  res.json({ ok: true });
});

app.delete('/api/master/label-templates/:carrier', (req, res) => {
  if (!checkMaster(req, res)) return;
  const remaining = readLabelTemplates()
    .filter(t => t.carrier.toLowerCase() !== req.params.carrier.toLowerCase());
  writeLabelTemplates(remaining);
  res.json({ ok: true });
});

// ── Word doc label templates ─────────────────────────────────────────────────
function carrierSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
const DOC_TPL_INDEX = path.join(DOC_TEMPLATE_DIR, '_index.json');
function readDocTplIndex() {
  try { return JSON.parse(fs.readFileSync(DOC_TPL_INDEX, 'utf8')); }
  catch { return {}; }
}
function writeDocTplIndex(idx) {
  fs.writeFileSync(DOC_TPL_INDEX, JSON.stringify(idx, null, 2));
}

const _EMPTY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

async function generateLabelDoc(templateBuf, order) {
  if (!Docxtemplater || !PizZip) throw new Error('DOCX support not installed on the server.');

  let barcodePng = null;
  if (bwipjs && order.waybill_number) {
    try {
      barcodePng = await bwipjs.toBuffer({
        bcid: 'code128', text: String(order.waybill_number),
        scale: 2, height: 12, includetext: true, textxalign: 'center',
      });
    } catch (e) { console.warn('[IdealScan] barcode gen failed:', e.message); }
  }

  const modules = [];
  if (DocxImageModule) {
    modules.push(new DocxImageModule({
      centered : false,
      getImage : (tagValue) => (Buffer.isBuffer(tagValue) && tagValue.length > 4 ? tagValue : _EMPTY_PNG),
      getSize  : (img)      => img === _EMPTY_PNG ? [1, 1] : [280, 70],
    }));
  }

  const zip = new PizZip(templateBuf);
  const doc = new Docxtemplater(zip, { modules, paragraphLoop: true, linebreaks: true });

  const platform = order.platform
    ? (order.shop_name ? `${order.platform} / ${order.shop_name}` : order.platform)
    : (order.shop_name || '');
  const items = (order.lines || []).map(l => `${l.sku} x${l.qty}`).join(', ');

  try {
    doc.render({
      customer_name   : order.customer_name    || '',
      delivery_address: order.delivery_address || '',
      waybill_number  : order.waybill_number   || '',
      order_number    : order.order_number     || '',
      platform,
      tel             : order.tel              || '',
      carrier         : order.carrier          || '',
      items,
      date            : new Date().toLocaleDateString('en-SG', { year: 'numeric', month: 'short', day: '2-digit' }),
      waybill_barcode : barcodePng || _EMPTY_PNG,
    });
  } catch (err) {
    const msgs = (err.properties && err.properties.errors || []).map(e => e.message).join('; ');
    throw new Error(msgs || err.message);
  }

  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Admin routes — manage stored doc templates
app.get('/api/master/label-doc-templates', (req, res) => {
  if (!checkMaster(req, res)) return;
  const idx = readDocTplIndex();
  res.json(Object.entries(idx).map(([slug, carrier]) => ({ slug, carrier })));
});

app.post('/api/master/label-doc-templates', upload.single('docxFile'), (req, res) => {
  if (!checkMaster(req, res)) return;
  const carrier = String(req.body && req.body.carrier || '').trim();
  if (!carrier) return res.status(400).json({ error: 'carrier name is required' });
  if (!req.file)  return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname || '').toLowerCase();
  if (ext !== '.docx') return res.status(400).json({ error: 'Only .docx files are accepted' });
  const slug    = carrierSlug(carrier);
  const outPath = path.join(DOC_TEMPLATE_DIR, `${slug}.docx`);
  fs.writeFileSync(outPath, req.file.buffer);
  const idx = readDocTplIndex();
  idx[slug] = carrier;
  writeDocTplIndex(idx);
  res.json({ ok: true, slug, carrier });
});

app.delete('/api/master/label-doc-templates/:slug', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { slug } = req.params;
  try { fs.unlinkSync(path.join(DOC_TEMPLATE_DIR, `${slug}.docx`)); } catch {}
  const idx = readDocTplIndex();
  delete idx[slug];
  writeDocTplIndex(idx);
  res.json({ ok: true });
});

app.get('/api/master/label-doc-templates/:slug/download', (req, res) => {
  if (!checkMaster(req, res)) return;
  const idx  = readDocTplIndex();
  const name = idx[req.params.slug] || req.params.slug;
  const tplPath = path.join(DOC_TEMPLATE_DIR, `${req.params.slug}.docx`);
  if (!fs.existsSync(tplPath)) return res.status(404).json({ error: 'Template not found' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^a-z0-9_-]/gi,'_')}_template.docx"`);
  res.end(fs.readFileSync(tplPath));
});

// User route — list carriers that have doc templates (for print-label decision)
app.get('/api/label/doc-templates', requireAuth, (req, res) => {
  const idx = readDocTplIndex();
  res.json(Object.values(idx));
});

// User route — generate and download a populated label docx
app.post('/api/label/doc', requireAuth, express.json(), async (req, res) => {
  const { carrier, order } = req.body || {};
  if (!carrier || !order) return res.status(400).json({ error: 'carrier and order required' });
  if (!Docxtemplater || !PizZip)
    return res.status(503).json({ error: 'DOCX support not installed. Contact administrator.' });
  const idx  = readDocTplIndex();
  const slug = Object.keys(idx).find(s => idx[s].toLowerCase() === carrier.toLowerCase());
  if (!slug) return res.status(404).json({ error: `No Word template for carrier "${carrier}"` });
  const tplPath = path.join(DOC_TEMPLATE_DIR, `${slug}.docx`);
  if (!fs.existsSync(tplPath)) return res.status(404).json({ error: 'Template file missing' });
  try {
    const docBuf  = await generateLabelDoc(fs.readFileSync(tplPath), order);
    const safeName = String(order.order_number || 'label').replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Label_${safeName}.docx"`);
    res.end(docBuf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Master: User management ──────────────────────────────────────────────────
app.get('/api/master/users', (req, res) => {
  if (!checkMaster(req, res)) return;
  res.json(readUsers().map(({ id, name, role }) => ({ id, name, role: role || 'admin' })));
});

app.post('/api/master/users', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { id, name, password, role } = req.body;
  if (!id || !password) return res.status(400).json({ error: 'User ID and password required' });
  const users = readUsers();
  if (users.find(u => u.id === id)) return res.status(409).json({ error: `User "${id}" already exists` });
  const salt     = crypto.randomBytes(16).toString('hex');
  const userRole = role === 'warehouse' ? 'warehouse' : 'admin';
  users.push({ id: String(id).trim(), name: String(name || id).trim(), role: userRole, salt, passwordHash: hashPass(password, salt) });
  writeUsers(users);
  res.json({ ok: true });
});

app.put('/api/master/users/:id/password', (req, res) => {
  if (!checkMaster(req, res)) return;
  const users = readUsers();
  const idx   = users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'User not found' });
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'New password required' });
  const salt = crypto.randomBytes(16).toString('hex');
  users[idx].salt         = salt;
  users[idx].passwordHash = hashPass(password, salt);
  writeUsers(users);
  res.json({ ok: true });
});

app.put('/api/master/users/:id/role', (req, res) => {
  if (!checkMaster(req, res)) return;
  const users = readUsers();
  const idx   = users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'User not found' });
  const { role } = req.body;
  if (!['admin', 'warehouse'].includes(role)) return res.status(400).json({ error: 'Role must be admin or warehouse' });
  users[idx].role = role;
  writeUsers(users);
  res.json({ ok: true });
});

app.delete('/api/master/users/:id', (req, res) => {
  if (!checkMaster(req, res)) return;
  const users = readUsers();
  if (!users.find(u => u.id === req.params.id)) return res.status(404).json({ error: 'User not found' });
  if (users.length <= 1) return res.status(400).json({ error: 'Cannot delete the only user' });
  writeUsers(users.filter(u => u.id !== req.params.id));
  res.json({ ok: true });
});

// ── Master: Email configuration ──────────────────────────────────────────────
app.get('/api/master/email-config', (req, res) => {
  if (!checkMaster(req, res)) return;
  const conf = readEmailConfig();
  res.json({
    from_email: conf.from_email,
    password:   conf.password ? '••••••••' : '',   // never expose the real password
    smtp_host:  conf.smtp_host,
    smtp_port:  conf.smtp_port,
    to_email:   conf.to_email,
    has_password: !!conf.password,
  });
});

app.post('/api/master/email-config', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { from_email, password, smtp_host, smtp_port, to_email } = req.body;
  if (!from_email) return res.status(400).json({ error: 'From email is required' });
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(EMAIL_CONFIG_FILE, 'utf8')); } catch {}
  const updated = {
    from_email: from_email.trim(),
    password:   password ? password.trim() : (saved.password || ''),  // keep existing if blank
    smtp_host:  (smtp_host || 'smtp.gmail.com').trim(),
    smtp_port:  parseInt(smtp_port || 587, 10),
    to_email:   (to_email || '').trim(),
  };
  fs.writeFileSync(EMAIL_CONFIG_FILE, JSON.stringify(updated, null, 2));
  res.json({ ok: true });
});

app.post('/api/master/email-config/test', async (req, res) => {
  if (!checkMaster(req, res)) return;
  const conf = readEmailConfig();
  if (!conf.from_email || !conf.password)
    return res.status(400).json({ error: 'Email credentials not configured yet' });
  const to = (req.body?.to || conf.to_email || '').trim();
  if (!to) return res.status(400).json({ error: 'No recipient address — enter one or set Default Recipient' });
  try {
    const transporter = nodemailer.createTransport({
      host: conf.smtp_host, port: conf.smtp_port, secure: false,
      auth: { user: conf.from_email, pass: conf.password },
    });
    await transporter.sendMail({
      from: conf.from_email, to,
      subject: 'IDEALSCAN — Email Test',
      text: `This is a test email from IDEALSCAN Fulfillment Scanner.\n\nSMTP: ${conf.smtp_host}:${conf.smtp_port}\nFrom: ${conf.from_email}\nSent: ${new Date().toLocaleString()}`,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/master/email-config', (req, res) => {
  if (!checkMaster(req, res)) return;
  try { fs.unlinkSync(EMAIL_CONFIG_FILE); } catch {}
  res.json({ ok: true });
});

// ── Betime CODE 2 map management ─────────────────────────────────────────────

// GET — return current map stats + all entries so admin can review mismatches
app.get('/api/master/betime-code2', (req, res) => {
  if (!checkMaster(req, res)) return;
  res.json({ entries: Object.keys(_beTimeCode2Map).length, map: _beTimeCode2Map });
});

// POST — upload a new Betime SKU Excel; regenerates and hot-reloads the map
app.post('/api/master/betime-code2', upload.single('file'), (req, res) => {
  if (!checkMaster(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const hdr  = data[0] || [];
    const code1Idx = hdr.indexOf('Product Code');
    const code2Idx = hdr.indexOf('CODE 2');
    if (code1Idx === -1 || code2Idx === -1) {
      return res.status(400).json({ error: 'Excel must have "Product Code" and "CODE 2" columns' });
    }
    const map = {};
    let skipped = 0;
    data.slice(1).forEach(row => {
      const pc = String(row[code1Idx] || '').trim();
      const c2 = String(row[code2Idx] || '').trim();
      if (!pc || !c2) { skipped++; return; }
      c2.split(',').forEach(b => { const bc = b.trim(); if (bc) map[bc] = pc; });
    });
    fs.writeFileSync(BETIME_CODE2_FILE, JSON.stringify(map, null, 2));
    _beTimeCode2Map = map;  // hot-reload in memory
    res.json({ ok: true, entries: Object.keys(map).length, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Completion slip ──────────────────────────────────────────────────────────
app.get('/api/completion-slip/:batchId/:orderNumber', (req, res) => {
  const { batchId, orderNumber } = req.params;
  const db    = readDb();
  const batch = db.batches.find(b => b.id === batchId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  const ord = (batch.orders || []).find(o => o.order_number === orderNumber);
  if (!ord) return res.status(404).json({ error: 'Order not found' });
  const state = (batch.orderStates || {})[orderNumber] || {};

  const startTime = state.startTime ? new Date(state.startTime) : null;
  const endTime   = state.endTime   ? new Date(state.endTime)   : null;
  const elapsedSec = (startTime && endTime) ? Math.round((endTime - startTime) / 1000) : null;
  const elapsedStr = elapsedSec !== null
    ? `${Math.floor(elapsedSec / 3600)}h ${Math.floor((elapsedSec % 3600) / 60)}m ${elapsedSec % 60}s`
    : '—';

  const aoa = [
    ['IDEALSCAN Completion Slip'],
    [],
    ['Order Number', orderNumber],
    ['Customer',     ord.customer_name || '—'],
    ['Client',       ord.client_name   || '—'],
    ['Carrier',      ord.carrier       || '—'],
    ['Waybill No.',  ord.waybill_number || '—'],
    [],
    ['Operator',     state.operator || '—'],
    ['Start Time',   startTime || '—'],
    ['End Time',     endTime   || '—'],
    ['Elapsed',      elapsedStr],
    [],
    ['SKU', 'Description', 'Ordered Qty', 'Scanned Qty', 'Result'],
    ...ord.lines.map(l => {
      const s  = (state.scanned || {})[l.sku] || 0;
      const ok = s === l.qty;
      return [l.sku, l.description || '', l.qty, s, ok ? 'OK' : s > l.qty ? 'Over-scanned' : 'Short'];
    }),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true }), 'Completion Slip');
  const buf  = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const date = (endTime || new Date()).toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Slip_${orderNumber}_${date}.xlsx"`);
  res.end(buf);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fulfillment Scanner on port ${PORT}`));
