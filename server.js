process.on('uncaughtException',  (err) => console.error('[CRASH] uncaughtException:', err.stack || err.message));
process.on('unhandledRejection', (err) => console.error('[CRASH] unhandledRejection:', err?.stack || err));

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
let extractLabelFields;
try { ({ extractLabelFields } = require('./lib/label-extract')); } catch {}

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
app.use((req, res, next) => { if (req.path.startsWith('/api/')) console.log(`[REQ] ${req.method} ${req.path}`); next(); });
app.get('/api/ping', (_req, res) => res.json({ ok: true, version: 'req-log-6', ts: Date.now() }));
// Quick multer-free upload test — no auth needed
app.post('/api/test-upload', upload.single('orderFile'), (req, res) => {
  console.log('[test-upload] file:', req.file?.originalname, req.file?.size, 'bytes');
  res.json({ ok: true, filename: req.file?.originalname, size: req.file?.size });
});
app.get('/vendor/jsbarcode.min.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/jsbarcode/dist/JsBarcode.all.min.js'))
);

// ── Persistent storage ──────────────────────────────────────────────────────
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, 'data');
const WMS_DIR     = path.join(DATA_DIR, 'wms');
const WAYBILL_DIR = path.join(DATA_DIR, 'waybills');
const DB_FILE     = path.join(DATA_DIR, 'db.json');
let _dbCache = null;

const KEYFIELDS_TEMPLATE_FILE = path.join(DATA_DIR, 'keyfields_template.json');
const LABEL_TEMPLATES_FILE    = path.join(DATA_DIR, 'label_templates.json');
const DOC_TEMPLATE_DIR        = path.join(DATA_DIR, 'label_doc_templates');
const USERS_FILE              = path.join(DATA_DIR, 'users.json');
const EMAIL_CONFIG_FILE       = path.join(DATA_DIR, 'email_config.json');
const GMAIL_OAUTH_FILE        = path.join(DATA_DIR, 'gmail_oauth.json');
// Not DATA_DIR — static reference data, always lives with the app code
const BETIME_CODE2_FILE       = path.join(__dirname, 'lib', 'betime-code2.json');
// DATA_DIR (persistent volume) so descriptions survive redeploys
const SKU_DESC_FILE           = path.join(DATA_DIR, 'sku-descriptions.json');

const LABEL_IMPORT_DIR = path.join(DATA_DIR, 'label_imports');
fs.mkdirSync(WMS_DIR,            { recursive: true });
fs.mkdirSync(WAYBILL_DIR,        { recursive: true });
fs.mkdirSync(LABEL_IMPORT_DIR,   { recursive: true });
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
  if (_dbCache) return _dbCache;
  try { _dbCache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { _dbCache = { batches: [] }; }
  return _dbCache;
}
function writeDb(data) {
  _dbCache = data;
  // Write to disk async so uploads don't block on Railway volume I/O
  fs.writeFile(DB_FILE, JSON.stringify(data, null, 2), err => {
    if (err) console.error('[writeDb] persist error:', err.message);
  });
}

// ── Betime CODE 2 → Product Code map ─────────────────────────────────────────
// Loaded at startup. Translates customer barcodes (EAN-13 / CODE 2 field) to
// WMS product codes so scanning a barcode finds the correct order line.
// Entries with comma-separated barcodes in the source Excel are split so each
// barcode is its own key. Empty CODE 2 rows are omitted entirely.
let _beTimeCode2Map = {};
let _beTimeCode2Lengths = []; // unique key lengths, descending — rebuilt whenever map changes
let _beTimeCode2NormMap = {}; // stripped-key index: leading zeros removed from every barcode key
let _skuDescMap = {};         // SKU → description, loaded from the CODE 2 reference file

function _rebuildCode2Lengths() {
  const lens = [...new Set(Object.keys(_beTimeCode2Map).map(k => k.length))];
  lens.sort((a, b) => b - a); // longest first so we match the most-specific prefix
  _beTimeCode2Lengths = lens;
  // Build secondary index with leading zeros stripped from every key so lookups
  // succeed when the reference file stored a barcode with a leading zero but the
  // scanner transmits it without (or vice-versa — existing keys without zeros are
  // also indexed so they remain reachable after stripping the scan value).
  _beTimeCode2NormMap = {};
  for (const [k, v] of Object.entries(_beTimeCode2Map)) {
    const stripped = k.replace(/^0+(?=.)/, '');
    if (!_beTimeCode2NormMap[stripped]) _beTimeCode2NormMap[stripped] = v;
  }
}

try {
  _beTimeCode2Map = JSON.parse(fs.readFileSync(BETIME_CODE2_FILE, 'utf8'));
  _rebuildCode2Lengths();
  console.log(`[IdealScan] Betime CODE2 map loaded: ${Object.keys(_beTimeCode2Map).length} entries`);
} catch (e) {
  console.warn('[IdealScan] betime-code2.json not found — CODE2 barcode translation disabled');
}
try {
  _skuDescMap = JSON.parse(fs.readFileSync(SKU_DESC_FILE, 'utf8'));
  console.log(`[IdealScan] SKU description map loaded: ${Object.keys(_skuDescMap).length} entries`);
} catch (e) { /* no desc file yet — populated on first CODE2 upload */ }

// Resolve a scanned barcode to a WMS product code. Returns the original value
// unchanged when the barcode is not in the Betime CODE 2 map.
//
// Handles scanners that sweep multiple barcodes in one burst and concatenate
// them into a single string. When a direct lookup misses and the input is
// all-digits longer than the shortest known barcode, we try every key-length
// that exists in the map (derived at load time, updated on hot-reload) as a
// prefix — longest first. This works for any barcode format in any future
// upload without hardcoded lengths.
function resolveBeTimeCode2(scanned) {
  if (!scanned) return scanned;
  const k = scanned.trim();
  // 1. Exact match
  if (_beTimeCode2Map[k]) return _beTimeCode2Map[k];
  // 2. Strip leading zeros from the scanned value and try both the exact map
  //    and the normalized index — covers scanner-adds-zeros AND scanner-strips-zeros
  const kStripped = k.replace(/^0+(?=.)/, '');
  if (kStripped !== k) {
    if (_beTimeCode2Map[kStripped])     return _beTimeCode2Map[kStripped];
    if (_beTimeCode2NormMap[kStripped]) return _beTimeCode2NormMap[kStripped];
  }
  // 3. Also try the normalized index with the original value in case the map
  //    key had a leading zero that was already stripped when building the index
  if (_beTimeCode2NormMap[k]) return _beTimeCode2NormMap[k];
  // 4. Multi-barcode burst: all-digit input longer than any known key length —
  //    try every known key-length as a prefix, longest first
  const minLen = _beTimeCode2Lengths[_beTimeCode2Lengths.length - 1] || 8;
  if (/^\d+$/.test(k) && k.length > minLen) {
    for (const len of _beTimeCode2Lengths) {
      if (k.length > len) {
        const hit = _beTimeCode2Map[k.slice(0, len)];
        if (hit) return hit;
      }
    }
  }
  return k;
}

// ── Email config ─────────────────────────────────────────────────────────────
function readEmailConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(EMAIL_CONFIG_FILE, 'utf8')); } catch {}
  return {
    from_email:  saved.from_email  || process.env.EMAIL_USER  || '',
    smtp_login:  saved.smtp_login  || process.env.SMTP_LOGIN  || '',  // auth user if different from from_email
    password:    saved.password    || process.env.EMAIL_PASS  || '',
    smtp_host:   saved.smtp_host   || process.env.SMTP_HOST   || 'smtp.gmail.com',
    smtp_port:   saved.smtp_port   || parseInt(process.env.SMTP_PORT || '587', 10),
    to_email:    saved.to_email    || process.env.EMAIL_TO    || 'opsgroup-sg@uldgroup.net',
  };
}

// ── Gmail OAuth2 helpers ─────────────────────────────────────────────────────
function readGmailOAuth() {
  try { return JSON.parse(fs.readFileSync(GMAIL_OAUTH_FILE, 'utf8')); } catch { return null; }
}

function buildTransporter() {
  const oauth = readGmailOAuth();
  if (oauth?.refresh_token && oauth?.client_id && oauth?.client_secret && oauth?.email) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { type: 'OAuth2', user: oauth.email,
              clientId: oauth.client_id, clientSecret: oauth.client_secret,
              refreshToken: oauth.refresh_token },
      connectionTimeout: 15000,
      socketTimeout: 30000,
    });
  }
  const conf = readEmailConfig();
  if (!conf.from_email || !conf.password) return null;
  return nodemailer.createTransport({
    host: conf.smtp_host, port: conf.smtp_port, secure: false,
    auth: { user: conf.smtp_login || conf.from_email, pass: conf.password },
    connectionTimeout: 15000,
    socketTimeout: 30000,
  });
}

function getFromEmail() {
  const oauth = readGmailOAuth();
  return (oauth?.email) || readEmailConfig().from_email;
}

function getDefaultRecipient() {
  const oauth = readGmailOAuth();
  return (oauth?.to_email) || readEmailConfig().to_email;
}

// Pending OAuth handshakes: state token → { client_id, client_secret, email, to_email, expires }
const _pendingOAuthStates = new Map();

// ── Email ───────────────────────────────────────────────────────────────────
async function sendCompletionAlert(orderNumber, ord, operator) {
  const transporter = buildTransporter();
  const fromEmail   = getFromEmail();
  const toEmail     = getDefaultRecipient();
  if (!transporter || !fromEmail || !toEmail) {
    console.warn(`[IdealScan] Completion alert for ${orderNumber} skipped — email not configured.`);
    return { sent: false, reason: 'not_configured' };
  }
  const opLine = operator ? `Operator: ${operator}\n` : '';
  await transporter.sendMail({
    from: fromEmail, to: toEmail,
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
  console.log(`[IdealScan] Completion alert sent to ${toEmail} for order ${orderNumber}.`);
  return { sent: true };
}

async function sendWmsEmail(batch, wmsBuffer, orders, emailTo, direction) {
  const transporter = buildTransporter();
  const fromEmail   = getFromEmail();
  if (!transporter || !fromEmail)
    throw new Error('Email not configured — add credentials in the Master panel (Admin → Email Settings)');
  const recipient = emailTo || getDefaultRecipient();
  if (!recipient) throw new Error('No recipient email address provided');

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
    from: fromEmail, to: recipient,
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
      description:    line.description || '',
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
  const db          = readDb();
  const orderLabels = db.orderLabels || {};
  const seen        = new Set();
  const out         = [];
  for (const batch of db.batches) {
    const states = batch.orderStates || {};
    for (const ord of (batch.orders || [])) {
      if (seen.has(ord.order_number)) continue; // newest batch wins
      seen.add(ord.order_number);
      const state       = states[ord.order_number] || { status: 'pending', scanned: {} };
      const waybillPath = path.join(WAYBILL_DIR, batch.id, `${ord.order_number}.pdf`);
      const enrichedLines = (ord.lines || []).map(l => {
        const stored = l.description || '';
        // Ignore stored description if it equals the SKU (legacy data bug)
        const realDesc = (stored && stored !== l.sku) ? stored : '';
        return {
          ...l,
          description: realDesc || _skuDescMap[l.sku] || _skuDescMap[(l.sku || '').trim()] || '',
        };
      });
      out.push({
        ...ord,
        lines:             enrichedLines,
        scan_status:       state.status           || 'pending',
        scanned:           { ...state.scanned },
        mismatches:        state.mismatches        || [],
        startTime:         state.startTime         || null,
        endTime:           state.endTime           || null,
        operator:          state.operator          || null,
        keyfields_closed:  state.keyfields_closed  || false,
        alert_email_sent:  state.alert_email_sent  ?? null,
        alert_email_error: state.alert_email_error || null,
        batchId:           batch.id,
        client_name:       batch.client_name       || '',
        has_waybill_pdf:   fs.existsSync(waybillPath),
        has_order_label:   !!(orderLabels[ord.order_number]),
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

// ── Bulk Label PDF Import ─────────────────────────────────────────────────────

const labelImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

app.post('/api/label-imports', requireAuth, labelImportUpload.single('labelPdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file received' });
  try {
    const importId  = uuidv4();
    const importDir = path.join(LABEL_IMPORT_DIR, importId);
    fs.mkdirSync(importDir, { recursive: true });

    const pdfDoc   = await PDFDocument.load(req.file.buffer);
    const numPages = pdfDoc.getPageCount();

    const allOrders = globalOrdersWithState();
    const byOrderNo = new Map(allOrders.map(o => [normStr(o.order_number), o.order_number]));
    const byWaybill = new Map(
      allOrders.filter(o => o.waybill_number).map(o => [normStr(o.waybill_number), o.order_number])
    );

    const db = readDb();
    if (!db.labelImports) db.labelImports = [];
    if (!db.orderLabels)  db.orderLabels  = {};

    const pages              = [];
    const matchedThisImport  = new Set();

    for (let i = 0; i < numPages; i++) {
      const single  = await PDFDocument.create();
      const [pg]    = await single.copyPages(pdfDoc, [i]);
      single.addPage(pg);
      const pageBuf  = Buffer.from(await single.save());
      const pageFile = `page_${i + 1}.pdf`;
      fs.writeFileSync(path.join(importDir, pageFile), pageBuf);

      let extracted          = {};
      let matchStatus        = 'unmatched';
      let matchedOrderNumber = null;
      let matchMethod        = null;

      if (pdfParse) {
        try {
          const parsed  = await pdfParse(pageBuf);
          const rawText = parsed.text || '';
          if (extractLabelFields) extracted = extractLabelFields(rawText);

          // Priority 1: order number
          if (extracted.orderNumber) {
            const hit = byOrderNo.get(normStr(extracted.orderNumber));
            if (hit) {
              matchedOrderNumber = hit;
              matchStatus  = matchedThisImport.has(hit) ? 'duplicate' : 'matched';
              matchMethod  = 'order_number';
              matchedThisImport.add(hit);
            }
          }
          // Priority 2: tracking number
          if (!matchedOrderNumber && extracted.trackingNumber) {
            const hit = byWaybill.get(normStr(extracted.trackingNumber));
            if (hit) {
              matchedOrderNumber = hit;
              matchStatus  = matchedThisImport.has(hit) ? 'duplicate' : 'matched';
              matchMethod  = 'tracking_number';
              matchedThisImport.add(hit);
            }
          }
        } catch (e) { matchStatus = 'error'; }
      }

      if (matchedOrderNumber && matchStatus === 'matched') {
        db.orderLabels[matchedOrderNumber] = {
          importId, pageIndex: i, pageFile,
          attachedAt: new Date().toISOString(), attachedBy: req.userId,
        };
      }

      pages.push({ pageIndex: i, pageFile, extracted, matchStatus, matchedOrderNumber, matchMethod });
    }

    const importRecord = {
      id: importId, filename: req.file.originalname || 'label.pdf',
      uploadedAt: new Date().toISOString(), uploadedBy: req.userId,
      pageCount: numPages, pages,
    };
    db.labelImports.push(importRecord);
    writeDb(db);

    const matched = pages.filter(p => p.matchStatus === 'matched').length;
    res.json({ ok: true, importId, pageCount: numPages, matched, import: importRecord });
  } catch (err) {
    console.error('[label-import]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/label-imports', requireAuth, (req, res) => {
  const db = readDb();
  const list = (db.labelImports || []).slice().reverse();
  res.json(list.map(imp => ({
    id:          imp.id,
    filename:    imp.filename,
    uploadedAt:  imp.uploadedAt,
    uploadedBy:  imp.uploadedBy,
    pageCount:   imp.pageCount,
    matched:     (imp.pages || []).filter(p => p.matchStatus === 'matched').length,
    unmatched:   (imp.pages || []).filter(p => p.matchStatus === 'unmatched').length,
    duplicate:   (imp.pages || []).filter(p => p.matchStatus === 'duplicate').length,
    error:       (imp.pages || []).filter(p => p.matchStatus === 'error').length,
  })));
});

app.get('/api/label-imports/:id', requireAuth, (req, res) => {
  const db  = readDb();
  const imp = (db.labelImports || []).find(i => i.id === req.params.id);
  if (!imp) return res.status(404).json({ error: 'Import not found' });
  res.json(imp);
});

// PDF served with token query-param support so browser iframes can authenticate
app.get('/api/label-imports/:id/pages/:idx/pdf', requireAuthOrToken, (req, res) => {
  const { id, idx } = req.params;
  const filePath    = path.join(LABEL_IMPORT_DIR, id, `page_${parseInt(idx) + 1}.pdf`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Page not found' });
  const disp = req.query.dl === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disp}; filename="label_page_${parseInt(idx) + 1}.pdf"`);
  fs.createReadStream(filePath).pipe(res);
});

app.post('/api/label-imports/:id/pages/:idx/match', requireAuth, (req, res) => {
  const { id, idx } = req.params;
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db  = readDb();
  const imp = (db.labelImports || []).find(i => i.id === id);
  if (!imp) return res.status(404).json({ error: 'Import not found' });
  const pageIdx = parseInt(idx);
  const page    = imp.pages[pageIdx];
  if (!page) return res.status(404).json({ error: 'Page not found' });

  const order = globalOrdersWithState().find(o => o.order_number === orderNumber);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (!db.orderLabels) db.orderLabels = {};
  // Remove previous mapping for this page if any
  if (page.matchedOrderNumber && db.orderLabels[page.matchedOrderNumber]?.importId === id
      && db.orderLabels[page.matchedOrderNumber]?.pageIndex === pageIdx) {
    delete db.orderLabels[page.matchedOrderNumber];
  }
  page.matchedOrderNumber = orderNumber;
  page.matchStatus        = 'matched';
  page.matchMethod        = 'manual';
  db.orderLabels[orderNumber] = {
    importId: id, pageIndex: pageIdx, pageFile: page.pageFile,
    attachedAt: new Date().toISOString(), attachedBy: req.userId,
  };
  writeDb(db);
  res.json({ ok: true, page });
});

app.delete('/api/label-imports/:id/pages/:idx/match', requireAuth, (req, res) => {
  const { id, idx } = req.params;
  const db  = readDb();
  const imp = (db.labelImports || []).find(i => i.id === id);
  if (!imp) return res.status(404).json({ error: 'Import not found' });
  const pageIdx = parseInt(idx);
  const page    = imp.pages[pageIdx];
  if (!page) return res.status(404).json({ error: 'Page not found' });
  if (!db.orderLabels) db.orderLabels = {};
  if (page.matchedOrderNumber && db.orderLabels[page.matchedOrderNumber]?.importId === id) {
    delete db.orderLabels[page.matchedOrderNumber];
  }
  page.matchedOrderNumber = null;
  page.matchStatus        = 'unmatched';
  page.matchMethod        = null;
  writeDb(db);
  res.json({ ok: true });
});

// Re-run auto-matching for all unmatched (and optionally all) pages in an import
app.post('/api/label-imports/:id/rematch', requireAuth, async (req, res) => {
  const { id } = req.params;
  const rematchAll = req.body?.all === true;   // if true, also retry already-matched pages
  const db  = readDb();
  const imp = (db.labelImports || []).find(i => i.id === id);
  if (!imp) return res.status(404).json({ error: 'Import not found' });
  if (!db.orderLabels) db.orderLabels = {};

  const allOrders = globalOrdersWithState();
  const byOrderNo = new Map(allOrders.map(o => [normStr(o.order_number), o.order_number]));
  const byWaybill = new Map(
    allOrders.filter(o => o.waybill_number).map(o => [normStr(o.waybill_number), o.order_number])
  );

  // Track which orders are already matched in THIS import (to detect duplicates)
  const matchedInImport = new Set(
    imp.pages
      .filter(p => p.matchStatus === 'matched' && !rematchAll)
      .map(p => p.matchedOrderNumber)
      .filter(Boolean)
  );

  let newMatches = 0;
  for (const page of imp.pages) {
    if (page.matchStatus === 'matched' && !rematchAll) continue;
    const f = page.extracted || {};

    let hit = null;
    let method = null;

    // Try order number
    if (f.orderNumber) {
      hit = byOrderNo.get(normStr(f.orderNumber));
      if (hit) method = 'order_number';
    }
    // Try tracking / waybill
    if (!hit && f.trackingNumber) {
      hit = byWaybill.get(normStr(f.trackingNumber));
      if (hit) method = 'tracking_number';
    }

    if (hit) {
      if (matchedInImport.has(hit)) {
        page.matchStatus        = 'duplicate';
        page.matchedOrderNumber = hit;
        page.matchMethod        = method;
      } else {
        // Remove stale label reference from previous match if any
        if (page.matchedOrderNumber && page.matchedOrderNumber !== hit) {
          delete db.orderLabels[page.matchedOrderNumber];
        }
        page.matchedOrderNumber = hit;
        page.matchStatus        = 'matched';
        page.matchMethod        = method;
        db.orderLabels[hit] = {
          importId: id, pageIndex: page.pageIndex, pageFile: page.pageFile,
          attachedAt: new Date().toISOString(), attachedBy: req.userId,
        };
        matchedInImport.add(hit);
        newMatches++;
      }
    }
  }

  writeDb(db);
  const matched   = imp.pages.filter(p => p.matchStatus === 'matched').length;
  const unmatched = imp.pages.filter(p => p.matchStatus === 'unmatched').length;
  res.json({ ok: true, newMatches, matched, unmatched });
});

// Serve the matched label PDF for an order (token-param auth for iframes)
app.get('/api/order-label/:orderNumber/pdf', requireAuthOrToken, (req, res) => {
  const { orderNumber } = req.params;
  const db       = readDb();
  const labelRef = (db.orderLabels || {})[orderNumber];
  if (!labelRef) return res.status(404).json({ error: 'No label for this order' });
  const filePath = path.join(LABEL_IMPORT_DIR, labelRef.importId, labelRef.pageFile);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Label file missing' });
  const disp = req.query.dl === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disp}; filename="${orderNumber}_label.pdf"`);
  fs.createReadStream(filePath).pipe(res);
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

// ── PDF Picking List parser ──────────────────────────────────────────────────
// Extracts text from a Keyfields WMS Picking List PDF and parses it with the
// same OCR parser used for photo uploads.  The GI / Issue No becomes the
// order_number (takes priority over Reference which ORDER_PATTERNS finds first).
async function parsePdfPicklist(buffer) {
  if (!pdfParse) throw new Error('pdf-parse not installed. Run: npm install pdf-parse');
  const parsed = await pdfParse(buffer);
  const text   = parsed.text || '';
  // T[i] = trimmed version of each raw line (keeps index for lookahead)
  const T = text.split('\n').map(l => l.trim());

  // ── GI number (order identifier) ─────────────────────────────────────────
  let giNumber = '';
  for (const t of T) {
    const m = t.match(/\b(GI-\d{4,})\b/);
    if (m) { giNumber = m[1]; break; }
  }

  // ── Header fields ─────────────────────────────────────────────────────────
  // pdfParse reads the 2-column header in reading order: labels and values
  // appear on separate lines (e.g. "Pick Ticket" then "539937" on next line).
  let pickTicket   = '';
  let accountName  = '';
  let reference    = '';
  let deliveryDate = '';
  let carrier      = '';

  // Return next non-empty T[i] after index i
  const nextVal = (i) => {
    for (let j = i + 1; j < T.length; j++) if (T[j]) return T[j];
    return '';
  };
  // Return index of next non-empty T[i] after index i, or -1
  const nextValIdx = (i) => {
    for (let j = i + 1; j < T.length; j++) if (T[j]) return j;
    return -1;
  };

  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    // Handle both "Label VALUE" on one line AND "Label" + value on next line
    let m;
    if ((m = t.match(/^Account\s+(.*\S)/i))) {
      accountName = m[1];
      // In 2-column PDF layout, Reference value appears on the very next non-empty
      // line after the Account value (before the "Reference" label itself appears)
      reference = nextVal(i);
      continue;
    }
    if (t === 'Account') {
      const accIdx = nextValIdx(i);
      if (accIdx !== -1) { accountName = T[accIdx]; reference = nextVal(accIdx); }
      continue;
    }
    if ((m = t.match(/^Pick\s*Ticket\s+(\S+)/i)))  { pickTicket   = m[1]; continue; }
    if (/^Pick\s*Ticket$/i.test(t))                { pickTicket   = nextVal(i); continue; }
    if ((m = t.match(/^Delivery\s+Date\s+(\S+)/i))){ deliveryDate = m[1]; continue; }
    if (/^Delivery\s+Date$/i.test(t))              { deliveryDate = nextVal(i); continue; }
    if (/^Remarks?:?\s*$/i.test(t)) {
      const v = nextVal(i);
      if (v && !/^(Total|Grand|Print)/i.test(v)) carrier = v;
    }
    if ((m = t.match(/^Remarks?:\s+(\S.*)/i))) carrier = m[1].trim();
  }

  // ── Item table ────────────────────────────────────────────────────────────
  // pdfParse concatenates PDF columns. Each item produces lines like:
  //   "433411AC-011-002-A18156SS"  → {batch}{location}{sno}{sku}  (data line)
  //   "Uriage Cica Daily Serum "   → description text
  //   "Sample 1ml"                 → description continuation
  //   "CARTON 1 1EACH"             → WholeUom + LHU + qty (or " 1EACH" no carton)
  //   "19/Jan/2029"                → expiry date on its own line

  // Parse a concatenated batch+location+sno+sku data line.
  // Uses exec loop to find leftmost location code; try 2-letter prefix first
  // (handles batch trailing letters like "40311J" + "AC-012-003-A" correctly),
  // then fall back to 1-4 letter prefix.
  function parseDataLine(line) {
    const pats = [
      /[A-Z]{2}(?:-\d{1,6}){1,3}(?:-[A-Z]{1,2})?/gi,
      /[A-Z]{1,4}(?:-\d{1,6}){1,3}(?:-[A-Z]{1,2})?/gi,
    ];
    for (const PAT of pats) {
      PAT.lastIndex = 0;
      let m;
      while ((m = PAT.exec(line)) !== null) {
        const batchStr  = line.slice(0, m.index);
        const remainder = line.slice(m.index + m[0].length);
        if (!/^\d{4,}[A-Z]{0,2}$/i.test(batchStr)) continue;
        const rm = remainder.match(/^(\d{1,3}?)([A-Z0-9]{4,})$/i);
        if (!rm) continue;
        return { batch: batchStr, sku: rm[2] };
      }
    }
    return null;
  }

  const STOP_PAT  = /^Total\s+(Whole|Loose)\s+Qty/i;
  const QTY_EACH  = /(\d+)EACH$/i;           // "1EACH" or "CARTON 1 1EACH"
  const EXPIRY_RE = /^\d{1,2}[\/\-]\w+[\/\-]\d{2,4}$/; // "19/Jan/2029" on its own line
  const SKIP_DASH = /^-\s+\S+$/;             // "- 8750" repeated-SKU markers
  const NUM_ONLY  = /^\d+$/;                 // bare LHU count lines like "1"

  let inTable = false;
  let current = null;
  const items = [];

  for (const t of T) {
    if (STOP_PAT.test(t)) {
      if (current) { items.push(current); current = null; }
      break;
    }
    if (!t) continue;

    // Item data line: batch+location+sno+sku concatenated
    const di = parseDataLine(t);
    if (di) {
      if (current) items.push(current);
      current = { sku: di.sku, batch_number: di.batch, description: '', expiry_date: '', qty: 1 };
      inTable = true;
      continue;
    }

    if (!inTable || !current) continue;

    const qm = t.match(QTY_EACH);
    if (qm) { current.qty = parseInt(qm[1], 10) || 1; continue; }

    if (EXPIRY_RE.test(t)) { current.expiry_date = t; continue; }

    if (SKIP_DASH.test(t) || NUM_ONLY.test(t)) continue;

    current.description = current.description ? current.description + ' ' + t : t;
  }
  if (current) items.push(current);
  if (!items.length) return [];

  return items.map(item => ({
    order_number:     reference  || giNumber   || pickTicket || 'UNKNOWN',
    customer_name:    accountName || '',
    client_name:      accountName || '',
    tel:              '',
    delivery_address: '',
    waybill_number:   '',
    issue_no:         giNumber   || '',
    pick_ticket:      pickTicket || '',
    carrier:          carrier    || 'Offline',
    platform:         '',
    shop_name:        '',
    date:             deliveryDate || null,
    sku:              item.sku,
    qty:              item.qty,
    description:      item.description.trim(),
    batch_number:     item.batch_number || '',
    expiry_date:      item.expiry_date  || null,
    serial_number:    '',
    remarks:          '',
    remarks_betime:   '',
  }));
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
  if (req.method === 'POST' && req.path === '/api/upload') console.log('[upload-mw] auth check, token present:', !!req.headers['x-auth-token']);
  requireAuth(req, res, next);
});

// Temporary debug: return raw pdfParse text so we can diagnose unknown PDF formats
app.post('/api/pdf-debug', upload.single('orderFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    if (!pdfParse) return res.status(501).json({ error: 'pdf-parse not installed' });
    const parsed = await pdfParse(req.file.buffer);
    res.json({ text: parsed.text, pages: parsed.numpages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Parse-only preview — returns stats without saving anything
app.post('/api/preview', upload.single('orderFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname).toLowerCase();

    let allRows = [], skipped = 0;
    if (ext === '.pdf') {
      allRows = await parsePdfPicklist(req.file.buffer);
    } else if (ext === '.csv') {
      const records  = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
      const detected = detectColumnMap(records);
      const all      = records.map(r => mapRow(r, detected));
      allRows = all.filter(r => r.sku && !isMetadataRow(r));
      skipped = all.length - allRows.length;
    } else if (ext === '.xlsx' || ext === '.xls') {
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
    } else {
      return res.json({ rowCount: 0, orderCount: 0, errors: ['Unsupported file type. Upload XLSX, CSV, or PDF.'], converted: false });
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
  const T = Date.now();
  const L = (s) => console.log(`[upload +${Date.now()-T}ms] ${s}`);
  try {
    L('start');
    const orderFile  = req.files?.orderFile?.[0];
    const waybillPdf = req.files?.waybillPdf?.[0];

    if (!orderFile) return res.status(400).json({ error: 'No order file uploaded' });
    L(`file received: ${orderFile.originalname} ${orderFile.size}b`);

    const orderExt = path.extname(orderFile.originalname).toLowerCase();
    const mapped = orderExt === '.pdf'
      ? await parsePdfPicklist(orderFile.buffer)
      : parseUploadedFile(orderFile.buffer, orderFile.originalname);
    L(`parsed: ${mapped.length} rows`);
    if (!mapped.length) return res.status(400).json({ error: 'No valid order rows found' });
    if (mapped.length > UPLOAD_MAX_ROWS) return res.status(400).json({ error: `File has ${mapped.length} rows — maximum is ${UPLOAD_MAX_ROWS.toLocaleString()} per upload. Please split into smaller files.` });

    const sessionId = req.headers['x-session-id'] || uuidv4();
    const orders    = summarizeOrders(mapped);
    L(`summarized: ${orders.length} orders`);

    // ── Validation (lib/validation.js) — ABORT if any error found ──────────
    const wmsRows = [];
    let vLine = 1;
    for (const order of orders) {
      for (const line of order.lines) {
        wmsRows.push(buildRow(vLine++, order, line));
      }
    }
    const validation = validateRows(wmsRows);
    L(`validation: ${validation.passed ? 'passed' : 'FAILED'}`);
    if (!validation.passed) {
      return res.status(422).json({
        error:      validation.abortMessage,
        validation,
      });
    }
    // ── Validation passed — proceed ─────────────────────────────────────────

    L('generating XLSX');
    const wmsBuffer  = generateKeyfieldsXLSX(orders, loadCustomHeaders());
    L('XLSX done');
    const batchId    = uuidv4();
    const fileClientName = mapped.find(r => r.client_name)?.client_name || '';
    const clientName = ((req.body?.client_name || '').trim() || fileClientName).trim();
    const direction  = req.body?.direction === 'Inbound' ? 'Inbound' : 'Outbound';

    const batch = {
      id: batchId, filename: orderFile.originalname,
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.userId || '',
      client_name: clientName,
      order_count: orders.length, row_count: mapped.length,
      orderStates: {},
      orders,
    };

    L('writing DB');
    const db = readDb();
    db.batches.unshift(batch);
    writeDb(db);
    L('writing XLSX file');
    fs.writeFileSync(path.join(WMS_DIR, `${batchId}.xlsx`), wmsBuffer);
    L('done — building orders state');

    // Split waybill PDF if provided
    if (waybillPdf) {
      splitWaybillPdf(waybillPdf.buffer, batchId, orders).catch(err =>
        console.error('[waybill-pdf]', err.message)
      );
    }

    // Return immediately — client fetches full order list via /api/orders separately
    L('sending response');
    res.json({ sessionId, batchId, rowCount: mapped.length, orderCount: orders.length, orders: [] });
    L('response sent');
  } catch (err) {
    console.error('[upload] ERROR:', err.message);
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
  const sku = resolveBeTimeCode2(req.body.sku);  // translate barcode → product code
  if (!orderNumber || !sku) return res.status(400).json({ error: 'orderNumber and sku required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  const ord  = batch.orders.find(o => o.order_number === orderNumber);
  const stripLeadZeros = s => s.trim().toLowerCase().replace(/^0+(?=.)/, '');
  const skuNorm = stripLeadZeros(sku);
  const item = ord.lines.find(l => {
    const ls = l.sku.trim().toLowerCase();
    return ls === sku.trim().toLowerCase() || stripLeadZeros(ls) === skuNorm;
  });
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

// requireAuthOrToken: accepts token in header OR ?token= query param (for PDF iframes)
function requireAuthOrToken(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  for (const [userId, t] of activeSessions) {
    if (t === token) { req.userId = userId; return next(); }
  }
  res.status(401).json({ error: 'Session expired' });
}

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

app.get('/api/master/inspect-descriptions', (req, res) => {
  if (!checkMaster(req, res)) return;
  const db = readDb();
  const results = [];
  for (const batch of (db.batches || []).slice(0, 3)) {
    for (const order of (batch.orders || []).slice(0, 5)) {
      for (const line of (order.lines || []).slice(0, 3)) {
        results.push({
          batch: batch.filename,
          order: order.order_number,
          sku: line.sku,
          description: line.description,
          desc_equals_sku: line.description === line.sku,
          desc_empty: !line.description,
        });
      }
    }
  }
  res.json(results);
});

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
    // rawRows no longer persisted in DB — nothing to filter here
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
    from_email:   conf.from_email,
    smtp_login:   conf.smtp_login,
    password:     conf.password ? '••••••••' : '',   // never expose the real password
    smtp_host:    conf.smtp_host,
    smtp_port:    conf.smtp_port,
    to_email:     conf.to_email,
    has_password: !!conf.password,
  });
});

app.post('/api/master/email-config', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { from_email, smtp_login, password, smtp_host, smtp_port, to_email } = req.body;
  if (!from_email) return res.status(400).json({ error: 'From email is required' });
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(EMAIL_CONFIG_FILE, 'utf8')); } catch {}
  const updated = {
    from_email:  from_email.trim(),
    smtp_login:  (smtp_login || '').trim(),
    password:    password ? password.trim() : (saved.password || ''),  // keep existing if blank
    smtp_host:   (smtp_host || 'smtp.gmail.com').trim(),
    smtp_port:   parseInt(smtp_port || 587, 10),
    to_email:    (to_email || '').trim(),
  };
  fs.writeFileSync(EMAIL_CONFIG_FILE, JSON.stringify(updated, null, 2));
  res.json({ ok: true });
});

app.post('/api/master/email-config/test', async (req, res) => {
  if (!checkMaster(req, res)) return;
  const transporter = buildTransporter();
  const fromEmail   = getFromEmail();
  if (!transporter || !fromEmail)
    return res.status(400).json({ error: 'Email credentials not configured yet' });
  const to = (req.body?.to || getDefaultRecipient() || '').trim();
  if (!to) return res.status(400).json({ error: 'No recipient address — enter one or set Default Recipient' });
  try {
    await transporter.sendMail({
      from: fromEmail, to,
      subject: 'IDEALSCAN — Email Test',
      text: `This is a test email from IDEALSCAN Fulfillment Scanner.\n\nFrom: ${fromEmail}\nSent: ${new Date().toLocaleString()}`,
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

// ── Gmail OAuth2 routes ──────────────────────────────────────────────────────

// Returns connection status
app.get('/api/master/gmail/status', (req, res) => {
  if (!checkMaster(req, res)) return;
  const oauth = readGmailOAuth();
  if (oauth?.refresh_token) {
    res.json({ connected: true, email: oauth.email, to_email: oauth.to_email, connected_at: oauth.connected_at });
  } else {
    res.json({ connected: false });
  }
});

// Starts the OAuth flow — returns the authorization URL and stores pending state
app.post('/api/master/gmail/connect', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { client_id, client_secret, email, to_email } = req.body;
  if (!client_id || !client_secret || !email)
    return res.status(400).json({ error: 'client_id, client_secret and email are required' });

  const crypto = require('crypto');
  const state  = crypto.randomBytes(20).toString('hex');
  _pendingOAuthStates.set(state, {
    client_id:     client_id.trim(),
    client_secret: client_secret.trim(),
    email:         email.trim(),
    to_email:      (to_email || '').trim(),
    expires:       Date.now() + 10 * 60 * 1000,
  });

  const redirectUri = `${req.protocol}://${req.get('host')}/oauth2callback`;
  const params = new URLSearchParams({
    client_id:     client_id.trim(),
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'https://mail.google.com/',
    access_type:   'offline',
    prompt:        'consent',
    state,
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, redirect_uri: redirectUri });
});

// Google redirects here after user approves
app.get('/oauth2callback', async (req, res) => {
  const { code, state, error } = req.query;

  const closeScript = (ok, msg) =>
    `<html><body style="font-family:sans-serif;text-align:center;padding:3rem">
      <h2 style="color:${ok ? '#16a34a' : '#dc2626'}">${ok ? '✓' : '✗'} ${msg}</h2>
      <p>${ok ? 'You can close this tab and return to IDEALSCAN.' : 'Please close this tab and try again.'}</p>
      <script>window.opener?.postMessage({type:"gmail-oauth",ok:${ok}},"*");setTimeout(()=>window.close(),2500);</script>
     </body></html>`;

  if (error) return res.send(closeScript(false, `Authorization denied: ${error}`));

  const pending = _pendingOAuthStates.get(state);
  if (!pending || Date.now() > pending.expires) {
    return res.status(400).send(closeScript(false, 'Request expired — please try again'));
  }
  _pendingOAuthStates.delete(state);

  const redirectUri = `${req.protocol}://${req.get('host')}/oauth2callback`;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     pending.client_id,
        client_secret: pending.client_secret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.error)
      return res.send(closeScript(false, tokens.error_description || tokens.error));
    if (!tokens.refresh_token)
      return res.send(closeScript(false, 'No refresh token — revoke IDEALSCAN in Google Account → Security → Third-party access, then try again'));

    fs.writeFileSync(GMAIL_OAUTH_FILE, JSON.stringify({
      client_id:     pending.client_id,
      client_secret: pending.client_secret,
      refresh_token: tokens.refresh_token,
      email:         pending.email,
      to_email:      pending.to_email,
      connected_at:  new Date().toISOString(),
    }, null, 2));
    res.send(closeScript(true, 'Gmail connected!'));
  } catch (err) {
    res.status(500).send(closeScript(false, err.message));
  }
});

// Disconnect Gmail OAuth
app.delete('/api/master/gmail/disconnect', (req, res) => {
  if (!checkMaster(req, res)) return;
  try { fs.unlinkSync(GMAIL_OAUTH_FILE); } catch {}
  res.json({ ok: true });
});

// Update Gmail test to use OAuth2 transporter when available
app.post('/api/master/gmail/test', async (req, res) => {
  if (!checkMaster(req, res)) return;
  const transporter = buildTransporter();
  const fromEmail   = getFromEmail();
  if (!transporter || !fromEmail)
    return res.status(400).json({ error: 'Email not configured' });
  const to = (req.body?.to || getDefaultRecipient() || '').trim();
  if (!to) return res.status(400).json({ error: 'No recipient address — set Default Alert Recipient first' });
  try {
    await transporter.sendMail({
      from: fromEmail, to,
      subject: 'IDEALSCAN — Email Test',
      text: `This is a test email from IDEALSCAN.\n\nSent: ${new Date().toLocaleString()}\nFrom: ${fromEmail}`,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Betime CODE 2 map management ─────────────────────────────────────────────

// GET — return current map stats + all entries so admin can review mismatches
app.get('/api/master/betime-code2', (req, res) => {
  if (!checkMaster(req, res)) return;
  res.json({ entries: Object.keys(_beTimeCode2Map).length, map: _beTimeCode2Map });
});

// POST — upload a barcode→SKU map. Accepts two formats:
//   1. Keyfields WMS "List Of SKU Report": 3 title rows, row 3 = headers with "code"/"code2"
//   2. Legacy Betime format: row 0 = headers with "Product Code"/"CODE 2"
app.post('/api/master/betime-code2', upload.single('file'), (req, res) => {
  if (!checkMaster(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

    // Auto-detect format
    let hdr, dataRows;
    const row3 = data[3] || [];
    if (row3.indexOf('code') !== -1 && row3.indexOf('code2') !== -1) {
      // Keyfields WMS SKU Report (3 title rows, headers at row 3)
      hdr      = row3;
      dataRows = data.slice(4);
    } else {
      // Legacy / Betime format (headers at row 0)
      hdr      = data[0] || [];
      dataRows = data.slice(1);
    }

    const code1Idx = hdr.indexOf('code') !== -1          ? hdr.indexOf('code')          : hdr.indexOf('Product Code');
    const code2Idx = hdr.indexOf('code2') !== -1         ? hdr.indexOf('code2')         : hdr.indexOf('CODE 2');
    if (code1Idx === -1 || code2Idx === -1) {
      return res.status(400).json({
        error: 'Unrecognised format. Expected Keyfields WMS SKU Report (columns "code"/"code2") or Betime format (columns "Product Code"/"CODE 2")',
      });
    }

    // Find description column: name-match first, then data-driven fallback
    const hdrNorm = hdr.map(h => String(h ?? '').toLowerCase().trim().replace(/\s+/g, '_'));
    const descCandidates = ['description','desc','name','item_name','product_name','item_description',
      'product_description','goods_name','goods_description','short_name','long_name','item_desc',
      'goods','product','commodity','model','title','label','spec','specification','detail','remark'];
    let descIdx = -1;
    for (const c of descCandidates) {
      const i = hdrNorm.indexOf(c);
      if (i !== -1 && i !== code1Idx && i !== code2Idx) { descIdx = i; break; }
    }
    // Data-driven fallback: score every column by avg text length and non-numeric ratio
    if (descIdx === -1) {
      let bestScore = -1;
      hdr.forEach((_, ci) => {
        if (ci === code1Idx || ci === code2Idx) return;
        const vals = dataRows.map(r => String(r[ci] ?? '').trim()).filter(Boolean);
        if (vals.length < 3) return;
        const numRatio = vals.filter(v => /^\d+(\.\d+)?$/.test(v)).length / vals.length;
        const avgLen   = vals.reduce((s, v) => s + v.length, 0) / vals.length;
        if (numRatio > 0.5 || avgLen < 3) return;
        const score = avgLen * (1 - numRatio);
        if (score > bestScore) { bestScore = score; descIdx = ci; }
      });
    }

    const map = {};
    const descMap = {};
    let skipped = 0;
    dataRows.forEach(row => {
      const pc = String(row[code1Idx] ?? '').trim();
      const c2 = String(row[code2Idx] ?? '').trim();
      if (!pc || !c2 || c2 === 'undefined') { skipped++; return; }
      c2.split(',').forEach(b => {
        const bc = b.trim();
        if (!bc) return;
        map[bc] = pc;
        // Excel stores EAN-13 barcodes as numbers, dropping the leading 0.
        // A 12-digit all-numeric value is almost certainly an EAN-13 with its
        // leading 0 stripped — store the padded version too so scanners that
        // transmit all 13 digits still match.
        if (/^\d{12}$/.test(bc)) map['0' + bc] = map['0' + bc] || pc;
      });
      if (descIdx !== -1) {
        const desc = String(row[descIdx] ?? '').trim();
        if (pc && desc) descMap[pc] = desc;
      }
    });
    fs.writeFileSync(BETIME_CODE2_FILE, JSON.stringify(map, null, 2));
    _beTimeCode2Map = map;
    _rebuildCode2Lengths();
    if (Object.keys(descMap).length > 0) {
      fs.writeFileSync(SKU_DESC_FILE, JSON.stringify(descMap, null, 2));
      _skuDescMap = descMap;
    }
    res.json({
      ok: true,
      entries: Object.keys(map).length,
      skipped,
      descriptions: Object.keys(descMap).length,
      headers_found: hdr.map(String),
      desc_column: descIdx !== -1 ? hdr[descIdx] : null,
    });
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
