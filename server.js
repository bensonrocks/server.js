const express    = require('express');
const multer     = require('multer');
const { parse }  = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const crypto     = require('crypto');
const XLSX       = require('xlsx');
const nodemailer = require('nodemailer');
const { execFile } = require('child_process');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
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
// Pure-JS PDF rasterizer (pdfjs-dist + @napi-rs/canvas) — fallback for label
// OCR when the system `pdftoppm` binary isn't on the deploy image. npm-only,
// so it survives ANY build system (Nixpacks, Docker, buildpacks) unchanged.
let pdfjsLib = null, napiCanvas = null;
try {
  napiCanvas = require('@napi-rs/canvas');
  // pdfjs's Node polyfills expect the `canvas` package; @napi-rs/canvas
  // provides the same globals — install them before pdfjs loads.
  for (const k of ['DOMMatrix', 'Path2D', 'ImageData']) {
    if (!globalThis[k] && napiCanvas[k]) globalThis[k] = napiCanvas[k];
  }
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
} catch (e) {
  console.error('[label-ocr] JS rasterizer unavailable:', e.message);
  pdfjsLib = null; napiCanvas = null;
}

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
  return new Promise(async (resolve, reject) => {
    let worker;
    const timeout = setTimeout(() => {
      try { worker?.terminate?.(); } catch {}
      reject(new Error('OCR processing timeout — image too complex or large'));
    }, 55000);

    try {
      // Language model is bundled in the repo (lib/tessdata/eng.traineddata) —
      // Tesseract's default behaviour is to fetch it from a CDN on first use,
      // which hangs/fails under network policies that block that CDN (this
      // was why OCR was disabled entirely before). Bundling removes the
      // runtime network dependency altogether, on Railway or anywhere else.
      worker = await Tesseract.createWorker('eng', 1, {
        langPath: path.join(__dirname, 'lib', 'tessdata'),
        // cachePath must point at the same dir — otherwise tesseract.js
        // re-writes a 23MB eng.traineddata copy into the process cwd on
        // every worker start.
        cachePath: path.join(__dirname, 'lib', 'tessdata'),
        gzip: false,
        logger: m => { if (m.status === 'error') reject(m); }
      });
      await worker.setParameters({
        tessedit_pageseg_mode: '3',      // PSM_AUTO — let Tesseract detect layout
        preserve_interword_spaces: '1',  // keeps column spacing intact
        ...extraParams,
      });
      const { data: { text } } = await worker.recognize(img);
      clearTimeout(timeout);
      await worker.terminate();
      resolve(text);
    } catch (err) {
      clearTimeout(timeout);
      try { await worker?.terminate(); } catch {}
      if (err.message && err.message.includes('Network error')) {
        reject(new Error('OCR data download failed (network blocked). Check your network settings.'));
      } else {
        reject(err);
      }
    }
  });
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
// Priority: explicit DATA_DIR → Railway volume mount (auto-detected, so a
// deploy can never silently ignore the persistent volume and boot with an
// empty database) → local ./data for development.
const DATA_DIR    = process.env.DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || path.join(__dirname, 'data');
const WMS_DIR     = path.join(DATA_DIR, 'wms');
const WAYBILL_DIR = path.join(DATA_DIR, 'waybills');
// Split shipping-label pages matched to orders by the other production line's
// Labels module — db.orderLabels[orderNumber] = { importId, pageFile, … } with
// the page PDFs under label_imports/<importId>/. Read-only compatibility so
// historical matches stay visible and downloadable here.
const LABEL_IMPORT_DIR = path.join(DATA_DIR, 'label_imports');
// COMPATIBILITY — the other production line migrates the flat db.json into
// DATA_DIR/tenants/default/db.json (renaming the flat file to
// .migrated-backup). On a shared volume, use the tenant-store copy whenever
// it exists so the orders/batches written by that build stay visible here.
// Same JSON shape for everything this branch touches; collections this
// branch doesn't know (transport, inbound, …) ride along untouched because
// writeDb() always writes the whole object back.
const _TENANT_DB_FILE = path.join(DATA_DIR, 'tenants', 'default', 'db.json');
const DB_FILE     = fs.existsSync(_TENANT_DB_FILE)
  ? _TENANT_DB_FILE
  : path.join(DATA_DIR, 'db.json');

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
  const users = Array.isArray(db.users) ? [...db.users] : [];
  // COMPATIBILITY — the other production line stores users in
  // DATA_DIR/global.json ({users:[...]}, identical salt + scrypt
  // passwordHash scheme). A shared Railway volume written by that build
  // must still log in here, so merge those accounts in read-only;
  // db.users wins on any id clash and writes still go to db.json only.
  try {
    const g = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'global.json'), 'utf8'));
    if (Array.isArray(g.users)) {
      const have = new Set(users.map(u => String(u.id).trim().toLowerCase()));
      for (const u of g.users) {
        if (u && u.id && u.passwordHash && !have.has(String(u.id).trim().toLowerCase())) {
          users.push(u);
        }
      }
    }
  } catch {}
  return users;
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
let _beTimeCode2Lengths = []; // known map-key lengths, longest first — for prefix matching
function _rebuildCode2Lengths() {
  _beTimeCode2Lengths = [...new Set(Object.keys(_beTimeCode2Map).map(k => k.length))].sort((a, b) => b - a);
}
try {
  _beTimeCode2Map = JSON.parse(fs.readFileSync(BETIME_CODE2_FILE, 'utf8'));
  _rebuildCode2Lengths();
  console.log(`[IdealScan] Betime CODE2 map loaded: ${Object.keys(_beTimeCode2Map).length} entries`);
} catch (e) {
  console.warn('[IdealScan] betime-code2.json not found — CODE2 barcode translation disabled');
}

// Official CODE2 listing lookup only (no learned mappings). Returns the WMS
// product code, or null when the listing doesn't cover this barcode.
function officialResolveCode2(k) {
  if (_beTimeCode2Map[k]) return _beTimeCode2Map[k];
  // Scanner adds/strips a leading zero — try both directions
  const kStripped = k.replace(/^0+(?=.)/, '');
  if (kStripped !== k && _beTimeCode2Map[kStripped]) return _beTimeCode2Map[kStripped];
  // Multi-barcode burst: all-digit input longer than any known key length —
  // try every known key-length as a prefix, longest first
  const minLen = _beTimeCode2Lengths[_beTimeCode2Lengths.length - 1] || 8;
  if (/^\d+$/.test(k) && k.length > minLen) {
    for (const len of _beTimeCode2Lengths) {
      if (k.length > len) {
        const hit = _beTimeCode2Map[k.slice(0, len)];
        if (hit) return hit;
      }
    }
  }
  return null;
}

// Resolve a scanned barcode to a WMS product code: official listing first,
// then packer-taught mappings (teach-on-scan, always lower priority so a
// client's official listing refresh stays authoritative). Returns the
// original value unchanged when nothing resolves it.
function resolveBeTimeCode2(scanned) {
  if (!scanned) return scanned;
  const k = String(scanned).trim();
  const official = officialResolveCode2(k);
  if (official) return official;
  const kStripped = k.replace(/^0+(?=.)/, '');
  if (_learnedBarcodeMap[k]) return _learnedBarcodeMap[k].sku;
  if (kStripped !== k && _learnedBarcodeMap[kStripped]) return _learnedBarcodeMap[kStripped].sku;
  if (/^\d+$/.test(k)) {
    for (const key of Object.keys(_learnedBarcodeMap)) {
      if (k.length > key.length && k.startsWith(key)) return _learnedBarcodeMap[key].sku;
    }
  }
  return k;
}

// ── Teach-on-scan: packer-confirmed barcode → SKU mappings ───────────────────
// When a scanned product barcode isn't in the CODE2 listing (item master not
// yet updated for new products), the packer confirms which order line it is;
// the mapping is stored here and applies everywhere from then on.
let _learnedBarcodeMap = {}; // barcode → { sku, description, learnedBy, learnedAt, order }
let _learnedSkuAliases = []; // [{ a, b, learnedBy, learnedAt, order }] — a=official code, b=order-file code
try {
  const _db0 = readDb();
  _learnedBarcodeMap = _db0.learnedBarcodes   || {};
  _learnedSkuAliases = _db0.learnedSkuAliases || [];
  const n = Object.keys(_learnedBarcodeMap).length + _learnedSkuAliases.length;
  if (n) console.log(`[IdealScan] Learned barcode mappings loaded: ${Object.keys(_learnedBarcodeMap).length} barcodes, ${_learnedSkuAliases.length} aliases`);
} catch {}

// Only offer teach-on-scan for things that plausibly ARE product barcodes —
// not location codes, not garbage from a mis-scan.
function isTeachableBarcode(s) {
  const v = String(s || '').trim();
  if (v.length < 8 || v.length > 30) return false;
  if ((v.match(/\d/g) || []).length < 6) return false;
  if (/^[A-Z]{1,4}(-\d{1,6}){1,3}(-[A-Z]{1,2})?$/i.test(v)) return false; // location code
  return /^[A-Z0-9]+$/i.test(v);
}

// ── SKU → description master catalog ────────────────────────────────────────
// Learned automatically from every upload whose file carries descriptions
// (e.g. the GI Analysis export), then used to fill descriptions on uploads
// that don't (bare picking lists, OCR photo scans). Bulk view/load via
// /api/master/sku-catalog.
const SKU_CATALOG_FILE = path.join(DATA_DIR, 'sku_catalog.json');
let _skuCatalog = {};
try {
  _skuCatalog = JSON.parse(fs.readFileSync(SKU_CATALOG_FILE, 'utf8'));
  console.log(`[IdealScan] SKU catalog loaded: ${Object.keys(_skuCatalog).length} entries`);
} catch {
  console.log('[IdealScan] sku_catalog.json not found — starting with empty SKU catalog');
}
function _saveSkuCatalog() {
  try { fs.writeFileSync(SKU_CATALOG_FILE, JSON.stringify(_skuCatalog, null, 2)); }
  catch (e) { console.error('[sku-catalog] save failed:', e.message); }
}

// Record SKU→description pairs from rows that carry both. A description equal
// to the SKU itself is noise (old snapshots stored SKU as description) and is
// never learned. Returns the number of new/changed entries persisted.
function learnSkuDescriptions(rows) {
  let learned = 0;
  for (const r of rows) {
    const sku  = String(r.sku || '').trim();
    const desc = String(r.description || '').trim();
    if (!sku || !desc || desc === sku) continue;
    if (_skuCatalog[sku] !== desc) { _skuCatalog[sku] = desc; learned++; }
  }
  if (learned) _saveSkuCatalog();
  return learned;
}

// Fill blank descriptions from the catalog (in place). Returns count filled.
function fillSkuDescriptions(rows) {
  let filled = 0;
  for (const r of rows) {
    const sku = String(r.sku || '').trim();
    if (sku && !String(r.description || '').trim() && _skuCatalog[sku]) {
      r.description = _skuCatalog[sku];
      filled++;
    }
  }
  return filled;
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
        customer_ref:     line.customer_ref      || '',
        platform:         line.platform         || '',
        shop_name:        line.shop_name        || '',
        date:             line.date,
        lines:            [],
        total_qty:        0,
      };
    }
    map[key].lines.push({
      sku:            line.sku,
      description:    line.description || line.name || line.product || '',
      qty:            line.qty,
      uom:            line.uom || 'EACH',
      batch_number:   line.batch_number   || line.lot_number || '',
      serial_number:  line.serial_number  || '',
      expiry_date:    line.expiry_date    || line.expiring  || '',
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
  const orderLabels = db.orderLabels || {};
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
        uploaded_at:      batch.uploaded_at      || null,
        has_waybill_pdf:  fs.existsSync(waybillPath),
        has_order_label:  !!orderLabels[ord.order_number],
        cartons:          state.cartons || [],
        active_carton_num: state.activeCartonNum || (state.cartons && state.cartons.length ? state.cartons[state.cartons.length - 1].num : 1),
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
    // Priority 1: waybill number  2: customer/marketplace ref  3: order number
    // 4: issue no  5: pick ticket
    // customer_ref matters most for marketplace labels: Shopee/Lazada labels
    // print the marketplace order number + tracking no, never the GI number.
    const byWaybill    = new Map();
    const byCustRef    = new Map();
    const byOrder      = new Map();
    const byIssueNo    = new Map();
    const byPickTicket = new Map();
    for (const o of orders) {
      if (o.waybill_number) byWaybill.set(normStr(o.waybill_number),  o.order_number);
      if (o.customer_ref)   byCustRef.set(normStr(o.customer_ref),    o.order_number);
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

      if (pdfParse && (byWaybill.size || byCustRef.size || byOrder.size || byIssueNo.size || byPickTicket.size)) {
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
          // Priority 2: match by customer/marketplace order reference — the
          // number marketplace labels actually print (GI numbers never appear
          // on carrier labels)
          if (!assignedOrder) {
            for (const [key, orderNo] of byCustRef) {
              if (!matched[orderNo] && key.length >= 6 && normText.includes(key)) {
                assignedOrder = orderNo; matched[orderNo] = true; break;
              }
            }
          }
          // Priority 3: match by order number
          if (!assignedOrder) {
            for (const [key, orderNo] of byOrder) {
              if (!matched[orderNo] && key.length >= 4 && normText.includes(key)) {
                assignedOrder = orderNo; matched[orderNo] = true; break;
              }
            }
          }
          // Priority 4: match by Issue No (Betime / WMS internal ref)
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
const _HEADER_TERMS = /^(s[._\/]?n\.?|seq\.?|no\.?|status|account|reference|consign|address|remarks?|order|sku|item|code|qty|quantity|name|desc|description|date|product|part|material|batch|expiry|price|amount|total|uom|unit|barcode|pick|ticket|deliver|waybill|carrier|tel|phone|weight|pcs|pieces|line|ref|invoice|dispatch|pick_ticket|gi|goods)$/i;

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
  'gi no':            'gi_no',
  'gi number':        'gi_no',
  'gi':               'gi_no',
  'goods issue':      'gi_no',
  'goods issue no':   'gi_no',
  'goods issue number': 'gi_no',
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

// Every uploaded order must carry a unique key: GI No / GI Number,
// Waybill No, or Order Reference. If the file has item rows but none of
// them resolved a key, reject with an explicit message instead of silently
// dropping every row as metadata.
function _requireOrderKey(mappedRows) {
  const itemRows = mappedRows.filter(r => r.sku);
  if (itemRows.length && itemRows.every(r => !r.order_number || r.order_number === 'UNKNOWN')) {
    throw new Error('No order key found — the file must contain a GI No / GI Number, Waybill No, or Order Reference column.');
  }
}

// ── File parsing ────────────────────────────────────────────────────────────
function parseUploadedFile(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.csv') {
    const records  = parse(buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
    const detected = detectColumnMap(records);
    const mapped   = records.map(r => mapRow(r, detected));
    _requireOrderKey(mapped);
    return mapped.filter(r => r.sku && !isMetadataRow(r));
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const wb                   = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const ws                   = wb.Sheets[wb.SheetNames[0]];
    const { records, headers } = _parseExcelSheet(ws);
    const melted               = _tryMeltWide(records, headers);
    const finalRecs            = melted || records;
    const cleanRecs            = finalRecs.filter(r => !_isFooterRow(r));
    const detected             = detectColumnMap(cleanRecs);
    const mapped               = cleanRecs.map(r => mapRow(r, detected));
    _requireOrderKey(mapped);
    return mapped.filter(r => r.sku && !isMetadataRow(r));
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
      _requireOrderKey(all);
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
      _requireOrderKey(all);
      allRows = all.filter(r => r.sku && !isMetadataRow(r));
      skipped = cleanRecs.length - allRows.length;
    }

    if (allRows.length > UPLOAD_MAX_ROWS) {
      return res.json({ rowCount: allRows.length, orderCount: 0, errors: [`File has ${allRows.length} rows — maximum is ${UPLOAD_MAX_ROWS.toLocaleString()} per upload. Please split into smaller files.`], converted: false });
    }
    fillSkuDescriptions(allRows);   // preview shows catalog-filled descriptions (no learning on preview)
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

    learnSkuDescriptions(rows);
    fillSkuDescriptions(rows);      // OCR rows never carry descriptions — fill from catalog
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
    learnSkuDescriptions(mapped);   // grow the catalog from files that have descriptions
    fillSkuDescriptions(mapped);    // fill blanks from the catalog for files that don't
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

// ── Label imports — bulk shipping-label PDF management ──────────────────────
// db.labelImports[] = { id, filename, uploadedAt, uploadedBy, pageCount,
//   pages: [{ pageIndex, pageFile, rawText, matchStatus, matchedOrderNumber,
//   matchMethod }] } with page PDFs at label_imports/<id>/page_N.pdf and
// per-order refs in db.orderLabels. Same shapes the other production line
// wrote, so its historical imports on the shared volume render here.
function _requireAdminRole(req, res) {
  const u = readUsers().find(x => x.id === req.userId);
  if (!u || u.role === 'warehouse') {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

// All orders across every batch → identifier lookup maps for label matching.
function _allOrdersMatchIndex(db) {
  const byWaybill = new Map(), byCustRef = new Map(), byOrder = new Map(),
        byIssueNo = new Map(), byPickTicket = new Map();
  for (const batch of db.batches || []) {
    for (const o of batch.orders || []) {
      if (o.waybill_number) byWaybill.set(normStr(o.waybill_number), o.order_number);
      if (o.customer_ref)   byCustRef.set(normStr(o.customer_ref),   o.order_number);
      if (o.order_number)   byOrder.set(normStr(o.order_number),     o.order_number);
      if (o.issue_no)       byIssueNo.set(normStr(o.issue_no),       o.order_number);
      if (o.pick_ticket)    byPickTicket.set(normStr(o.pick_ticket), o.order_number);
    }
  }
  return { byWaybill, byCustRef, byOrder, byIssueNo, byPickTicket };
}

function _labelMatchTiers(db) {
  const idx = _allOrdersMatchIndex(db);
  return [
    ['waybill',      idx.byWaybill,    4],
    ['customer_ref', idx.byCustRef,    6],
    ['order_no',     idx.byOrder,      4],
    ['issue_no',     idx.byIssueNo,    4],
    ['pick_ticket',  idx.byPickTicket, 4],
  ];
}

// Try every tier against one page's text. Mutates pg + db.orderLabels.
// Returns true when the page ended up matched.
function _matchLabelPage(db, tiers, importId, pg, rawText, userId) {
  const normText = String(rawText || '').replace(/[\s\-_]/g, '');
  if (!normText) return false;
  for (const [method, map, minLen] of tiers) {
    for (const [key, orderNo] of map) {
      if (key.length >= minLen && normText.includes(key)) {
        const held = db.orderLabels[orderNo];
        const isSelf = held && held.importId === importId && held.pageIndex === pg.pageIndex;
        if (held && !isSelf) {
          pg.matchStatus = 'duplicate'; pg.matchedOrderNumber = orderNo; pg.matchMethod = method;
          return false;
        }
        pg.matchStatus = 'matched'; pg.matchedOrderNumber = orderNo; pg.matchMethod = method;
        db.orderLabels[orderNo] = {
          importId, pageIndex: pg.pageIndex, pageFile: pg.pageFile,
          attachedAt: new Date().toISOString(), attachedBy: userId || '',
        };
        return true;
      }
    }
  }
  return false;
}

// Rasterize a single-page PDF to PNG, then OCR it. For shipping labels with
// no text layer at all (scanned/rasterized label templates — common for some
// carrier exports), this is the only way to read the tracking number off the
// page. Two rasterizers, tried in order:
//   1. system `pdftoppm` (poppler-utils) — fastest, but only present if the
//      deploy image installed it (nixpacks.toml), which is NOT guaranteed;
//   2. pure-JS pdfjs-dist + @napi-rs/canvas — plain npm deps, present on any
//      deploy that ran `npm install`, so OCR keeps working even when the
//      build system ignored the poppler package.
// Returns null/'' on failure — callers treat that exactly like "no text
// found", never a hard error.
function _popplerRasterizePdfPage(pdfBuffer) {
  return new Promise(resolve => {
    const tmpBase = path.join(os.tmpdir(), `label-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const srcPdf  = tmpBase + '.pdf';
    try { fs.writeFileSync(srcPdf, pdfBuffer); } catch { return resolve(null); }
    execFile('pdftoppm', ['-png', '-r', '250', '-singlefile', srcPdf, tmpBase], { timeout: 15000 }, (err) => {
      try { fs.unlinkSync(srcPdf); } catch {}
      if (err) return resolve(null);
      try {
        const png = fs.readFileSync(tmpBase + '.png');
        fs.unlinkSync(tmpBase + '.png');
        resolve(png);
      } catch { resolve(null); }
    });
  });
}

// pdfjs's built-in Node canvas factory hardcodes the `canvas` package; this
// one backs it with @napi-rs/canvas (prebuilt binaries, no system deps).
class _NapiCanvasFactory {
  create(width, height) {
    const canvas = napiCanvas.createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(cw, w, h) { cw.canvas.width = Math.max(1, Math.ceil(w)); cw.canvas.height = Math.max(1, Math.ceil(h)); }
  destroy(cw) { cw.canvas = null; cw.context = null; }
}

async function _jsRasterizePdfPage(pdfBuffer) {
  if (!pdfjsLib || !napiCanvas) return null;
  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
      disableFontFace: true,
      verbosity: 0,
      canvasFactory: new _NapiCanvasFactory(),
      standardFontDataUrl: path.join(__dirname, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep,
    }).promise;
    const page     = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 250 / 72 }); // match pdftoppm -r 250
    const canvas   = napiCanvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx      = canvas.getContext('2d');
    ctx.fillStyle  = '#fff';                                // labels assume a white page
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toBuffer('image/png');
  } catch {
    return null;
  } finally {
    try { await doc?.destroy(); } catch {}
  }
}

async function _rasterizePdfPage(pdfBuffer) {
  return (await _popplerRasterizePdfPage(pdfBuffer)) || (await _jsRasterizePdfPage(pdfBuffer));
}
async function _ocrLabelPage(pdfBuffer) {
  if (!Tesseract) return '';
  try {
    const png = await _rasterizePdfPage(pdfBuffer);
    if (!png) return '';
    const text = await runOcr(png, { tessedit_pageseg_mode: '3' }); // PSM_AUTO — labels mix a big tracking no. with small print
    return text || '';
  } catch {
    return '';
  }
}

// Identifier-looking tokens on a label page — shown for unmatched pages so an
// admin can see what the label carries vs what the orders hold.
function _labelCandidates(rawText) {
  const toks = String(rawText || '').toUpperCase().match(/[A-Z0-9][A-Z0-9\-]{7,}/g) || [];
  return [...new Set(toks.map(t => t.replace(/[^A-Z0-9]/g, '')).filter(t => /\d/.test(t) && t.length >= 8))].slice(0, 8);
}

app.post('/api/label-imports', upload.single('file'), async (req, res) => {
  if (!_requireAdminRole(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  try {
    const db     = readDb();
    if (!db.labelImports) db.labelImports = [];
    if (!db.orderLabels)  db.orderLabels  = {};
    const pdfDoc   = await PDFDocument.load(req.file.buffer);
    const numPages = pdfDoc.getPageCount();
    const importId = uuidv4();
    const dir      = path.join(LABEL_IMPORT_DIR, importId);
    fs.mkdirSync(dir, { recursive: true });

    const tiers = _labelMatchTiers(db);

    // Per-page text in ONE parse of the original upload — re-parsing each
    // re-saved single page trips pdf-parse on some encoders ("unknown
    // compression method"), and one pass is faster anyway.
    const pageTexts = [];
    let wholeParseFailed = false;
    if (pdfParse) {
      try {
        await pdfParse(req.file.buffer, {
          pagerender: page => page.getTextContent().then(tc => {
            const t = tc.items.map(it => it.str).join(' ');
            pageTexts.push(t);
            return t;
          }),
        });
      } catch (e) { wholeParseFailed = true; }
    }

    const pages = [];
    for (let i = 0; i < numPages; i++) {
      const single    = await PDFDocument.create();
      const [copied]  = await single.copyPages(pdfDoc, [i]);
      single.addPage(copied);
      const buf      = Buffer.from(await single.save());
      const pageFile = `page_${i + 1}.pdf`;
      fs.writeFileSync(path.join(dir, pageFile), buf);

      let rawText = String(pageTexts[i] || '').toUpperCase();
      let pageParseFailed = false;
      if (!rawText && pdfParse) {
        // Whole-file pass gave nothing for this page — try the split page alone
        try { rawText = String((await pdfParse(buf)).text || '').toUpperCase(); }
        catch { pageParseFailed = true; }
      }
      const pg = {
        pageIndex: i, pageFile, rawText: rawText.slice(0, 2000),
        matchStatus: (!rawText && (wholeParseFailed || pageParseFailed)) ? 'error' : 'unmatched',
        matchedOrderNumber: null, matchMethod: null,
      };
      if (rawText) _matchLabelPage(db, tiers, importId, pg, rawText, req.userId);
      pages.push(pg);
    }

    const importRecord = {
      id: importId, filename: req.file.originalname || 'labels.pdf',
      uploadedAt: new Date().toISOString(), uploadedBy: req.userId || '',
      pageCount: numPages, pages,
    };
    db.labelImports.push(importRecord);
    writeDb(db);
    res.json({ ok: true, importId, pageCount: numPages, matched: pages.filter(p => p.matchStatus === 'matched').length });

    // Image-only pages (no text layer — e.g. certain carrier label templates)
    // can't match yet at this point. Kick off a background OCR pass so
    // they're matched by the time anyone opens the Labels tab, without
    // making the upload request itself wait on slow OCR.
    if (pages.some(p => p.matchStatus !== 'matched' && !p.rawText.trim())) {
      setImmediate(async () => {
        try {
          const db2  = readDb();
          const imp2 = (db2.labelImports || []).find(i => i.id === importId);
          if (!imp2) return;
          await _rematchImportPages(db2, imp2, req.userId);
          writeDb(db2);
        } catch (e) { console.error('[label-ocr-bg]', e.message); }
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/label-imports', (req, res) => {
  const db = readDb();
  const list = (db.labelImports || []).slice().reverse();
  res.json(list.map(imp => ({
    id: imp.id, filename: imp.filename, uploadedAt: imp.uploadedAt, uploadedBy: imp.uploadedBy,
    pageCount: imp.pageCount,
    matched:   (imp.pages || []).filter(p => p.matchStatus === 'matched').length,
    unmatched: (imp.pages || []).filter(p => p.matchStatus === 'unmatched').length,
    duplicate: (imp.pages || []).filter(p => p.matchStatus === 'duplicate').length,
    error:     (imp.pages || []).filter(p => p.matchStatus === 'error').length,
  })));
});

app.get('/api/label-imports/:id', (req, res) => {
  const db  = readDb();
  const imp = (db.labelImports || []).find(i => i.id === req.params.id);
  if (!imp) return res.status(404).json({ error: 'Import not found' });
  // rawText is bulky and internal — replace it with the identifier-looking
  // tokens found on unmatched/error pages so the reason is visible in the UI.
  res.json({
    ...imp,
    pages: (imp.pages || []).map(({ rawText, extracted, ...p }) => ({
      ...p,
      candidates: p.matchStatus === 'matched' ? [] : _labelCandidates(rawText),
      noText: !String(rawText || '').trim(),
    })),
  });
});

// Suggest which orders a label page most likely belongs to.
// Text pages: score orders whose identifiers resemble codes found on the page.
// Image-only pages: fall back to print-order position — bulk carrier label
// PDFs come out in the same sequence as the picklist, so page N most likely
// belongs to the Nth still-unlabelled order of that upload.
app.get('/api/label-imports/:id/pages/:idx/suggestions', (req, res) => {
  const db  = readDb();
  const imp = (db.labelImports || []).find(i => i.id === req.params.id);
  const i   = Number(req.params.idx);
  const pg  = imp && (imp.pages || [])[i];
  if (!pg) return res.status(404).json({ error: 'Page not found' });
  const labels = db.orderLabels || {};

  // Every order without a label yet, newest batch first
  const free = [];
  for (const batch of db.batches || []) {
    for (const o of batch.orders || []) {
      if (labels[o.order_number]) continue;
      if (free.some(f => f.order_number === o.order_number)) continue;
      free.push({
        order_number: o.order_number,
        client_name:  batch.client_name || '',
        customer_name: o.customer_name || '',
        waybill_number: o.waybill_number || '',
        customer_ref: o.customer_ref || '',
        carrier: o.carrier || '',
        date: o.date || batch.uploaded_at || null,
        items: (o.lines || []).length,
      });
    }
  }

  // Collapse common OCR/scan confusions (O/0, I/L/1, S/5, B/8) so a mangled
  // label read still lines up against the clean value stored on the order.
  const ocrFold = s => String(s || '').toUpperCase()
    .replace(/[O]/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8');

  // Many carrier label templates position each barcode-adjacent character as
  // its own text run, so pdf-parse returns them space-separated
  // ("L Z S G D 1 0 1 5…") — a naive token regex over the raw text never
  // finds an 8+ char run even though the tracking number is right there.
  // Despace the WHOLE page first (same technique the proven upload/rematch
  // matcher already uses) and test containment — this is the primary check;
  // token-based OCR-fold scoring below is a secondary net for genuinely
  // garbled/misread text.
  const despacedPage = normStr(pg.rawText);
  const cands = _labelCandidates(pg.rawText);
  const hasText = despacedPage.length > 0;

  const scored = free.map(o => {
    let score = 0, why = '';
    const ids = [
      ['waybill_number', o.waybill_number],
      ['customer_ref',   o.customer_ref],
      ['order_number',   o.order_number],
    ];
    for (const [field, raw] of ids) {
      if (!raw) continue;
      const idNorm = normStr(raw);
      if (idNorm.length >= 6 && despacedPage.includes(idNorm)) {
        const s = 90 + Math.min(idNorm.length, 10);
        if (s > score) { score = s; why = `${field.replace('_', ' ')} "${raw}" found on the label`; }
      }
    }
    // Token-level OCR-fold pass (catches misreads the plain despace can't)
    const idsFold = [o.waybill_number, o.customer_ref, o.order_number].filter(Boolean).map(normStr);
    for (const c of cands) {
      const cFold = ocrFold(c);
      for (const id of idsFold) {
        const idFold = ocrFold(id);
        if (id === c)                              { if (score < 100) { score = 100; why = `exact match with ${c}`; } }
        else if (id.includes(c) || c.includes(id)) { if (score < 85)  { score = 85;  why = `contains ${c}`; } }
        else if (idFold === cFold)                 { if (score < 80)  { score = 80;  why = `matches ${c} allowing for O/0, I/1, S/5, B/8 mix-ups`; } }
        else {
          let n = 0;
          while (n < Math.min(idFold.length, cFold.length) && idFold[idFold.length - 1 - n] === cFold[cFold.length - 1 - n]) n++;
          if (n >= 6) { const s = 40 + n * 3; if (s > score) { score = s; why = `last ${n} characters match ${c} (allowing OCR mix-ups)`; } }
        }
      }
    }
    return { ...o, score, why };
  });

  const textSnippet = String(pg.rawText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  let suggestions;
  if (hasText && scored.some(s => s.score > 0)) {
    suggestions = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
  } else if (hasText) {
    // Real text was read, but it matches no known order — say so plainly
    // rather than silently guessing by position.
    suggestions = [];
  } else {
    // Position-based: which unmatched page is this within the import?
    const unlabelledPages = (imp.pages || []).filter(p => p.matchStatus !== 'matched').map(p => p.pageIndex);
    const rank = Math.max(0, unlabelledPages.indexOf(i));
    const ordered = free.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.order_number).localeCompare(String(b.order_number)));
    suggestions = ordered.slice(rank, rank + 1).map(o => ({ ...o, score: 50, why: `print-order position (unmatched page ${rank + 1})` }))
      .concat(ordered.filter((_, n) => n !== rank).slice(0, 7).map(o => ({ ...o, score: 0, why: '' })));
  }
  res.json({
    pageIndex: i, candidates: cands, hasText, textSnippet,
    noMatchButHasText: hasText && suggestions.length === 0,
    unlabelledCount: free.length,
    suggestions,
    all: free.slice(0, 400),
  });
});

// Re-run matching for pages that never matched — labels uploaded BEFORE their
// orders (or before an order file was re-uploaded with more identifiers) can
// only match on a second pass. Already-matched pages are left untouched.
// Shared by the manual "↻ Rematch" button AND the automatic background pass
// kicked off right after upload (see /api/label-imports POST).
async function _rematchImportPages(db, imp, userId) {
  if (!db.orderLabels) db.orderLabels = {};
  const tiers = _labelMatchTiers(db);
  let newly = 0, recovered = 0, ocrRecovered = 0, stillBlank = 0;
  for (const pg of imp.pages || []) {
    if (pg.matchStatus === 'matched') continue;
    let rawText = String(pg.rawText || '');
    const filePath = path.join(LABEL_IMPORT_DIR, imp.id, pg.pageFile);
    // No stored text (older import, or a page that failed to parse) → re-read
    // the stored page PDF now.
    if (!rawText.trim() && pdfParse && fs.existsSync(filePath)) {
      try {
        rawText = String((await pdfParse(fs.readFileSync(filePath))).text || '').toUpperCase();
        if (rawText.trim()) { pg.rawText = rawText.slice(0, 2000); recovered++; }
      } catch { /* leave as-is */ }
    }
    // Still nothing — this page has NO text layer at all (a scanned/rasterized
    // label template). Last resort: rasterize the page to an image and OCR it.
    if (!rawText.trim() && fs.existsSync(filePath)) {
      const ocrText = await _ocrLabelPage(fs.readFileSync(filePath));
      if (ocrText.trim()) {
        rawText = ocrText.toUpperCase();
        pg.rawText = rawText.slice(0, 2000);
        pg.textSource = 'ocr';
        ocrRecovered++;
      }
    }
    if (!rawText.trim()) { pg.matchStatus = 'error'; stillBlank++; continue; }
    if (pg.matchStatus === 'error') pg.matchStatus = 'unmatched';
    if (_matchLabelPage(db, tiers, imp.id, pg, rawText, userId)) newly++;
  }
  return { newly, recovered, ocrRecovered, stillBlank };
}

app.post('/api/label-imports/:id/rematch', async (req, res) => {
  if (!_requireAdminRole(req, res)) return;
  const db  = readDb();
  const imp = (db.labelImports || []).find(i => i.id === req.params.id);
  if (!imp) return res.status(404).json({ error: 'Import not found' });
  const { newly, recovered, ocrRecovered, stillBlank } = await _rematchImportPages(db, imp, req.userId);
  writeDb(db);
  res.json({
    ok: true, newlyMatched: newly, textRecovered: recovered, ocrRecovered, noTextPages: stillBlank,
    matched:   (imp.pages || []).filter(p => p.matchStatus === 'matched').length,
    unmatched: (imp.pages || []).filter(p => p.matchStatus === 'unmatched').length,
    total:     (imp.pages || []).length,
  });
});

app.get('/api/label-imports/:id/pages/:idx/pdf', (req, res) => {
  const db  = readDb();
  const imp = (db.labelImports || []).find(i => i.id === req.params.id);
  const pg  = imp && (imp.pages || [])[Number(req.params.idx)];
  if (!pg) return res.status(404).json({ error: 'Page not found' });
  const filePath = path.join(LABEL_IMPORT_DIR, imp.id, pg.pageFile);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Label file missing' });
  const disposition = req.query.dl === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="label_p${Number(req.params.idx) + 1}.pdf"`);
  fs.createReadStream(filePath).pipe(res);
});

// Manually attach a page to an order (fix an unmatched/wrong match)
app.post('/api/label-imports/:id/pages/:idx/match', express.json(), (req, res) => {
  if (!_requireAdminRole(req, res)) return;
  const orderNumber = String(req.body?.orderNumber || '').trim();
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db  = readDb();
  const imp = (db.labelImports || []).find(i => i.id === req.params.id);
  const i   = Number(req.params.idx);
  const pg  = imp && (imp.pages || [])[i];
  if (!pg) return res.status(404).json({ error: 'Page not found' });
  const exists = (db.batches || []).some(b => (b.orders || []).some(o => o.order_number === orderNumber));
  if (!exists) return res.status(404).json({ error: `Order ${orderNumber} not found` });
  if (!db.orderLabels) db.orderLabels = {};
  // Detach whatever this page or this order was previously linked to
  if (pg.matchedOrderNumber && db.orderLabels[pg.matchedOrderNumber]?.importId === imp.id
      && db.orderLabels[pg.matchedOrderNumber]?.pageIndex === i) {
    delete db.orderLabels[pg.matchedOrderNumber];
  }
  const prevRef = db.orderLabels[orderNumber];
  if (prevRef) {
    const prevImp = (db.labelImports || []).find(x => x.id === prevRef.importId);
    const prevPg  = prevImp && (prevImp.pages || [])[prevRef.pageIndex];
    if (prevPg) { prevPg.matchStatus = 'unmatched'; prevPg.matchedOrderNumber = null; prevPg.matchMethod = null; }
  }
  pg.matchStatus = 'matched'; pg.matchedOrderNumber = orderNumber; pg.matchMethod = 'manual';
  db.orderLabels[orderNumber] = { importId: imp.id, pageIndex: i, pageFile: pg.pageFile, attachedAt: new Date().toISOString(), attachedBy: req.userId || '' };
  writeDb(db);
  res.json({ ok: true });
});

app.delete('/api/label-imports/:id/pages/:idx/match', (req, res) => {
  if (!_requireAdminRole(req, res)) return;
  const db  = readDb();
  const imp = (db.labelImports || []).find(i => i.id === req.params.id);
  const i   = Number(req.params.idx);
  const pg  = imp && (imp.pages || [])[i];
  if (!pg) return res.status(404).json({ error: 'Page not found' });
  if (pg.matchedOrderNumber && db.orderLabels?.[pg.matchedOrderNumber]?.importId === imp.id
      && db.orderLabels[pg.matchedOrderNumber]?.pageIndex === i) {
    delete db.orderLabels[pg.matchedOrderNumber];
  }
  pg.matchStatus = 'unmatched'; pg.matchedOrderNumber = null; pg.matchMethod = null;
  writeDb(db);
  res.json({ ok: true });
});

// Delete a whole import: removes page files + orderLabels refs only —
// never touches batches, orders, or scan state.
app.delete('/api/label-imports/:id', (req, res) => {
  if (!_requireAdminRole(req, res)) return;
  const db  = readDb();
  const idx = (db.labelImports || []).findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Import not found' });
  const imp = db.labelImports[idx];
  for (const [on, ref] of Object.entries(db.orderLabels || {})) {
    if (ref?.importId === imp.id) delete db.orderLabels[on];
  }
  db.labelImports.splice(idx, 1);
  writeDb(db);
  try { fs.rmSync(path.join(LABEL_IMPORT_DIR, imp.id), { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

// Serve a shipping-label page matched by the other line's Labels module
// (db.orderLabels + label_imports/<importId>/<pageFile> on the shared volume).
app.get('/api/order-label/:orderNumber/pdf', (req, res) => {
  const { orderNumber } = req.params;
  const db       = readDb();
  const labelRef = (db.orderLabels || {})[orderNumber];
  if (!labelRef) return res.status(404).json({ error: 'No label matched to this order' });
  const filePath = path.join(LABEL_IMPORT_DIR, String(labelRef.importId || ''), String(labelRef.pageFile || ''));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Label file missing' });
  const disposition = req.query.dl === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${orderNumber}_label.pdf"`);
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
    if (!batch.uploaded_at) continue; // Skip batches without upload date
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

// Picking lists and labels carry several scannable numbers — accept any of
// them: GI/order number, waybill, marketplace customer ref, issue no, pick
// ticket, or PO/shipment number. Leading zeros are stripped for comparison
// too, since scanners and different upload paths aren't always consistent
// about them (e.g. "0102030" vs "102030" for the same code).
//
// GI number lands in different fields depending on upload path: a PDF
// picking-list parser may put it straight in order_number, while an XLSX/CSV
// with an "Issue No" / "iWMS GINo" column maps it into issue_no instead — so
// issue_no must be checked too, or that upload path's GI barcode never
// resolves to an order.
app.post('/api/waybill-lookup', (req, res) => {
  const { waybill } = req.body;
  if (!waybill) return res.status(400).json({ error: 'waybill required' });
  const strip0   = s => s.replace(/^0+(?=.)/, '');
  const scanned  = normStr(waybill);
  const scanned0 = strip0(scanned);
  const orders   = globalOrdersWithState();
  const hit = (val) => {
    const v = normStr(val);
    return v && (v === scanned || strip0(v) === scanned0);
  };
  const order = orders.find(o =>
    hit(o.order_number) || hit(o.waybill_number) || hit(o.customer_ref) ||
    hit(o.issue_no)     || hit(o.pick_ticket)     || hit(o.po_number)
  );
  if (!order) return res.status(404).json({ error: `No order found for: ${waybill}` });
  res.json(order);
});

// ── Carton splitting ─────────────────────────────────────────────────────────
// A big order can take more than one physical box. Every scan lands in the
// ACTIVE carton's own tally (state.cartons[]) in addition to the order-level
// state.scanned total (which stays the single source of truth for progress
// bars, the Orders table, and completion). Orders that never split cartons
// end up with one implicit carton holding everything — no extra step for
// the common case.
function activeCarton(state) {
  if (!state.cartons || !state.cartons.length) {
    state.cartons = [{ num: 1, scans: {}, startedAt: new Date().toISOString(), closedAt: null }];
    state.activeCartonNum = 1;
  }
  const found = state.cartons.find(c => c.num === state.activeCartonNum);
  if (found) return found;
  const last = state.cartons[state.cartons.length - 1];
  state.activeCartonNum = last.num;
  return last;
}
function addToActiveCarton(state, sku, delta) {
  const carton = activeCarton(state);
  carton.scans[sku] = Math.max(0, (carton.scans[sku] || 0) + delta);
}

// Find the order line a scanned/resolved SKU belongs to. Tries: exact match,
// then Betime's "NP" suffix exception (8006NP and 8006 are the same product —
// exact matches always win, NP is only tried when nothing else matched),
// then packer-taught SKU aliases (the official listing sometimes names a
// product differently from the order file, e.g. 9005 vs BC010).
function findScanLine(ord, sku) {
  const stripLeadZeros = s => s.trim().toLowerCase().replace(/^0+(?=.)/, '');
  const findBySku = q => {
    const ql = q.trim().toLowerCase();
    const qn = stripLeadZeros(ql);
    return ord.lines.find(l => {
      const ls = l.sku.trim().toLowerCase();
      return ls === ql || stripLeadZeros(ls) === qn;
    });
  };
  let item = findBySku(sku);
  if (!item && /np$/i.test(sku.trim()))  item = findBySku(sku.trim().replace(/np$/i, ''));
  if (!item && !/np$/i.test(sku.trim())) item = findBySku(sku.trim() + 'NP');
  if (!item) {
    for (const al of _learnedSkuAliases) {
      if (al.a === sku) item = findBySku(al.b);
      else if (al.b === sku) item = findBySku(al.a);
      if (item) break;
    }
  }
  return item;
}

// An order file can list the SAME SKU on several lines (e.g. 1 pc + 12 pcs)
// — each line is a distinct picking unit and must be able to close on its
// own. Scans are tallied per SKU, so for line-level views the SKU total is
// allocated across its lines in file order: earlier lines fill first, each
// line closes when its share is full, and any over-scan lands on the SKU's
// last line. Returns one allocated quantity per line, same order as ord.lines.
function allocateScansToLines(ord, scanned) {
  const linesLeft = {};
  for (const l of ord.lines || []) linesLeft[l.sku] = (linesLeft[l.sku] || 0) + 1;
  const pool = { ...(scanned || {}) };
  return (ord.lines || []).map(l => {
    const have = pool[l.sku] || 0;
    linesLeft[l.sku]--;
    const take = linesLeft[l.sku] === 0 ? have : Math.min(have, l.qty || 0);
    pool[l.sku] = have - take;
    return take;
  });
}

// Total ordered qty for a SKU across ALL its lines — scan feedback compares
// the per-SKU scan tally against this, not against whichever line matched.
function orderedTotalForSku(ord, sku) {
  return (ord.lines || []).filter(l => l.sku === sku).reduce((s, l) => s + (l.qty || 0), 0);
}

app.post('/api/scan/increment', (req, res) => {
  const { orderNumber } = req.body;
  const sku = resolveBeTimeCode2(req.body.sku);  // translate barcode → product code
  if (!orderNumber || !sku) return res.status(400).json({ error: 'orderNumber and sku required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  const ord  = batch.orders.find(o => o.order_number === orderNumber);
  const item = findScanLine(ord, sku);
  if (!item) {
    // Unknown (or differently-named) product barcode? Offer teach-on-scan:
    // the packer confirms which line this is and it's remembered for good.
    const raw = String(req.body.sku || '').trim();
    return res.status(404).json({
      error: `SKU "${sku}" not in this order`,
      teachable: isTeachableBarcode(raw),
      barcode: raw,
      resolved: sku !== raw ? sku : null, // official mapping that missed
    });
  }
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  state.status = 'processing';
  state.scanned[item.sku] = (state.scanned[item.sku] || 0) + 1;
  addToActiveCarton(state, item.sku, 1);
  state.updated_at = new Date().toISOString();
  batch.orderStates[orderNumber] = state;
  writeDb(db);
  res.json({
    sku: item.sku, scanned_qty: state.scanned[item.sku], ordered_qty: orderedTotalForSku(ord, item.sku),
    cartonNum: activeCarton(state).num, cartonCount: state.cartons.length, cartonScans: { ...activeCarton(state).scans },
  });
});

// Big orders can take more than one physical box. The packer marks the
// current carton full and starts the next one; every scan from here on
// tallies against the new carton until the order completes.
app.post('/api/scan/new-carton', (req, res) => {
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  if (!batch.orderStates) batch.orderStates = {};
  const state   = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  const current = activeCarton(state);
  const currentCount = Object.values(current.scans).reduce((s, v) => s + v, 0);
  if (currentCount === 0) {
    return res.status(400).json({ error: 'Scan at least one item into this carton before starting a new one.' });
  }
  current.closedAt = new Date().toISOString();
  const next = { num: Math.max(...state.cartons.map(c => c.num)) + 1, scans: {}, startedAt: new Date().toISOString(), closedAt: null };
  state.cartons.push(next);
  state.activeCartonNum = next.num;
  state.updated_at = new Date().toISOString();
  batch.orderStates[orderNumber] = state;
  writeDb(db);
  res.json({ ok: true, cartonCount: state.cartons.length, activeCartonNum: next.num, cartonScans: {} });
});

// Records that the packer confirmed they wrote the carton label on the box.
// Fire-and-forget from the client — this call never blocks the scan UI; the
// modal pausing scan capture is what enforces the pause, not this request.
// Can fire before any scan (carton 1 is labelled the moment packing starts).
app.post('/api/scan/carton/label-confirmed', (req, res) => {
  const { orderNumber, cartonNum } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  const num = parseInt(cartonNum, 10) || 1;
  activeCarton(state); // lazily ensures state.cartons exists
  let carton = state.cartons.find(c => c.num === num);
  if (!carton) { carton = { num, scans: {}, startedAt: new Date().toISOString(), closedAt: null }; state.cartons.push(carton); }
  carton.labelConfirmed = true;
  batch.orderStates[orderNumber] = state;
  writeDb(db);
  res.json({ ok: true });
});

// Packer confirms which order line an unrecognized barcode belongs to.
// Learns either a new barcode→SKU mapping (barcode wasn't in the official
// listing) or a SKU alias (the listing maps it to a DIFFERENT code than this
// order's file uses) — the official listing itself is never modified — then
// counts the piece the packer is holding, same as a normal scan.
app.post('/api/scan/learn-barcode', (req, res) => {
  const { orderNumber, barcode, sku } = req.body;
  if (!orderNumber || !barcode || !sku) return res.status(400).json({ error: 'orderNumber, barcode and sku required' });
  const bc = String(barcode).trim();
  if (!isTeachableBarcode(bc)) return res.status(400).json({ error: 'That scan does not look like a product barcode.' });

  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  const ord  = batch.orders.find(o => o.order_number === orderNumber);
  const item = ord.lines.find(l => l.sku === sku);
  if (!item) return res.status(404).json({ error: `SKU "${sku}" not in this order` });

  const official = officialResolveCode2(bc);
  let learnedKind;
  if (official && official !== item.sku) {
    if (!db.learnedSkuAliases) db.learnedSkuAliases = [];
    const exists = db.learnedSkuAliases.some(al =>
      (al.a === official && al.b === item.sku) || (al.a === item.sku && al.b === official));
    if (!exists) {
      const alias = { a: official, b: item.sku, learnedBy: req.userId || '', learnedAt: new Date().toISOString(), order: orderNumber };
      db.learnedSkuAliases.push(alias);
      _learnedSkuAliases.push(alias);
    }
    learnedKind = 'alias';
  } else if (!official) {
    if (!db.learnedBarcodes) db.learnedBarcodes = {};
    const entry = {
      sku: item.sku,
      description: item.description || _skuDescMap[item.sku] || '',
      learnedBy: req.userId || '',
      learnedAt: new Date().toISOString(),
      order: orderNumber,
    };
    db.learnedBarcodes[bc] = entry;
    _learnedBarcodeMap[bc] = entry;
    learnedKind = 'barcode';
  } else {
    learnedKind = 'none'; // official mapping already points at this line — just count
  }

  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  state.status = 'processing';
  state.scanned[item.sku] = (state.scanned[item.sku] || 0) + 1;
  addToActiveCarton(state, item.sku, 1);
  state.updated_at = new Date().toISOString();
  batch.orderStates[orderNumber] = state;
  writeDb(db);
  res.json({
    ok: true, sku: item.sku, scanned_qty: state.scanned[item.sku], ordered_qty: orderedTotalForSku(ord, item.sku), barcode: bc, learned: learnedKind,
    cartonNum: activeCarton(state).num, cartonCount: state.cartons.length, cartonScans: { ...activeCarton(state).scans },
  });
});

// ── Master: learned barcode mappings (view / export / delete) ───────────────
app.get('/api/master/learned-barcodes', (req, res) => {
  if (!checkMaster(req, res)) return;
  const db = readDb();
  const barcodes = Object.entries(db.learnedBarcodes || {}).map(([barcode, e]) => ({ barcode, ...e }));
  barcodes.sort((a, b) => new Date(b.learnedAt) - new Date(a.learnedAt));
  const aliases = [...(db.learnedSkuAliases || [])].sort((a, b) => new Date(b.learnedAt) - new Date(a.learnedAt));
  res.json({ barcodes, aliases });
});

// Export so the client (Betime) can correct their official listing at the
// source — learned entries are meant to be a stop-gap, not a second truth.
app.get('/api/master/learned-barcodes/export', (req, res) => {
  if (!checkMaster(req, res)) return;
  const db = readDb();
  const barcodes = Object.entries(db.learnedBarcodes || {}).map(([barcode, e]) => ({ barcode, ...e }));
  const aliases  = db.learnedSkuAliases || [];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Barcode', 'SKU', 'Description', 'Taught By', 'Taught At', 'On Order'],
    ...barcodes.map(e => [e.barcode, e.sku, e.description || '', e.learnedBy || '', e.learnedAt || '', e.order || '']),
  ]), 'Missing Barcodes');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Listing SKU', 'Order-File SKU', 'Taught By', 'Taught At', 'On Order'],
    ...aliases.map(e => [e.a, e.b, e.learnedBy || '', e.learnedAt || '', e.order || '']),
  ]), 'SKU Name Differences');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Learned_Barcodes_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.end(buf);
});

app.delete('/api/master/learned-barcodes/:barcode', (req, res) => {
  if (!checkMaster(req, res)) return;
  const bc = req.params.barcode;
  const db = readDb();
  if (!db.learnedBarcodes?.[bc]) return res.status(404).json({ error: 'Mapping not found' });
  const removed = db.learnedBarcodes[bc];
  delete db.learnedBarcodes[bc];
  delete _learnedBarcodeMap[bc];
  writeDb(db);
  res.json({ ok: true, removed });
});

app.delete('/api/master/learned-aliases/:a/:b', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { a, b } = req.params;
  const db = readDb();
  const match = al => (al.a === a && al.b === b) || (al.a === b && al.b === a);
  const idx = (db.learnedSkuAliases || []).findIndex(match);
  if (idx < 0) return res.status(404).json({ error: 'Alias not found' });
  db.learnedSkuAliases.splice(idx, 1);
  const idx2 = _learnedSkuAliases.findIndex(match);
  if (idx2 >= 0) _learnedSkuAliases.splice(idx2, 1);
  writeDb(db);
  res.json({ ok: true });
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
  // Line-by-line check via allocation — duplicate-SKU lines each close on
  // their own share of the SKU's scan total instead of all comparing
  // against the same aggregate (which made such orders impossible to complete).
  const alloc = allocateScansToLines(ord, state.scanned);
  const mismatches = ord.lines.map((item, i) => {
    const s = alloc[i];
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
  const idNorm = String(id).trim().toLowerCase();
  const user = readUsers().find(u => String(u.id).trim().toLowerCase() === idNorm);
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

// ── Check for deleted orders (notify user on login) ────────────────────────
app.get('/api/user/deleted-orders-check', requireAuth, (req, res) => {
  try {
    const db = readDb();
    const deletedOrders = (db.deleted_orders || []).filter(o => {
      // Show orders deleted within last 24 hours and not yet acknowledged
      const timeSinceDelete = Date.now() - new Date(o.deleted_at).getTime();
      return timeSinceDelete < 24 * 60 * 60 * 1000 && !o.acknowledged;
    });

    if (deletedOrders.length > 0) {
      // Mark as acknowledged for this user
      deletedOrders.forEach(o => { o.acknowledged = true; });
      writeDb(db);
    }

    res.json({ ok: true, deleted_orders: deletedOrders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Which build is actually running — Railway injects the commit SHA at build
// time; shown in the sidebar footer so "what's deployed?" is answerable at a
// glance from the app itself (and distinguishes IDEALSCAN from lookalikes).
app.get('/api/public/version', (_req, res) => {
  res.json({
    app:    'IDEALSCAN',
    commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev',
    branch: process.env.RAILWAY_GIT_BRANCH || '',
    startedAt: _serverStartedAt,
  });
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

// ── Bulk delete: mark orders for deletion (pending admin approval) ────────────
app.post('/api/orders/pending-delete', requireAuth, (req, res) => {
  const { orders } = req.body;
  if (!Array.isArray(orders) || orders.length === 0) {
    return res.status(400).json({ error: 'No orders specified' });
  }
  try {
    const db = readDb();
    const user = readUsers().find(u => u.id === req.userId);
    if (!db.pending_deletions) db.pending_deletions = [];
    const now = new Date().toISOString();
    const requestedBy = user?.name || req.userId || 'unknown';

    for (const orderNum of orders) {
      // Find the order to mark it
      let found = false;
      for (const batch of db.batches || []) {
        const order = (batch.orders || []).find(o => o.order_number === orderNum);
        if (order) {
          order.pending_delete = true;
          order.deletion_requested_at = now;
          order.deletion_requested_by = requestedBy;
          found = true;
          break;
        }
      }
      if (!found) {
        return res.status(404).json({ error: `Order ${orderNum} not found` });
      }
    }

    // Log the deletion requests
    db.pending_deletions.push({
      id: Date.now().toString(),
      orders: orders,
      requested_by: requestedBy,
      requested_at: now,
      status: 'pending'
    });

    writeDb(db);
    res.json({ ok: true, orders_marked: orders.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: list pending deletions ──────────────────────────────────────────────
app.get('/api/admin/orders/pending-delete', requireAuth, (req, res) => {
  const user = readUsers().find(u => u.id === req.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const db = readDb();
    const pending = [];
    for (const batch of db.batches || []) {
      for (const order of batch.orders || []) {
        if (order.pending_delete) {
          pending.push({
            order_number: order.order_number,
            batch_id: batch.id,
            customer_name: order.customer_name,
            deletion_requested_by: order.deletion_requested_by,
            deletion_requested_at: order.deletion_requested_at
          });
        }
      }
    }
    res.json({ ok: true, count: pending.length, orders: pending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: approve and execute deletion ──────────────────────────────────────
app.post('/api/admin/orders/approve-delete', requireAuth, (req, res) => {
  const user = readUsers().find(u => u.id === req.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { orders } = req.body;
  if (!Array.isArray(orders) || orders.length === 0) {
    return res.status(400).json({ error: 'No orders specified' });
  }
  try {
    const db = readDb();
    const now = new Date().toISOString();
    const approvedBy = user.name || req.userId || 'admin';

    for (const orderNum of orders) {
      let batchId = null;
      for (const batch of db.batches || []) {
        const order = (batch.orders || []).find(o => o.order_number === orderNum);
        if (order && order.pending_delete) {
          // Store deletion notification for owner
          const deletedOrdersLog = db.deleted_orders || [];
          deletedOrdersLog.push({
            order_number: orderNum,
            deleted_at: now,
            deleted_by: approvedBy,
            originally_requested_by: order.deletion_requested_by,
            customer_name: order.customer_name
          });
          db.deleted_orders = deletedOrdersLog;

          // Hard delete from batch
          batch.orders = batch.orders.filter(o => o.order_number !== orderNum);
          batch.order_count = batch.orders.length;
          if (batch.rawRows) batch.rawRows = batch.rawRows.filter(r => r.order_number !== orderNum);
          if (batch.orderStates) delete batch.orderStates[orderNum];
          try { fs.unlinkSync(path.join(WAYBILL_DIR, batch.id, `${orderNum}.pdf`)); } catch {}
          batchId = batch.id;
          break;
        }
      }
      if (!batchId) return res.status(404).json({ error: `Pending deletion not found for ${orderNum}` });
    }

    writeDb(db);
    res.json({ ok: true, approved: orders.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: reject pending deletion ─────────────────────────────────────────────
app.post('/api/admin/orders/reject-delete', requireAuth, (req, res) => {
  const user = readUsers().find(u => u.id === req.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { orders } = req.body;
  if (!Array.isArray(orders) || orders.length === 0) {
    return res.status(400).json({ error: 'No orders specified' });
  }
  try {
    const db = readDb();
    for (const orderNum of orders) {
      for (const batch of db.batches || []) {
        const order = (batch.orders || []).find(o => o.order_number === orderNum);
        if (order) {
          order.pending_delete = false;
          delete order.deletion_requested_at;
          delete order.deletion_requested_by;
          break;
        }
      }
    }
    writeDb(db);
    res.json({ ok: true, rejected: orders.length });
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

// Diagnostic: proves exactly which piece of the image-only-label OCR pipeline
// is broken on a given deployment (Tesseract worker load, bundled tessdata
// file, the pdftoppm binary from poppler-utils, or the full rasterize→OCR
// round trip) instead of guessing from "0 matched / N error" in the Labels
// tab. Master-key gated like the other /api/master/* routes.
app.get('/api/master/ocr-status', async (req, res) => {
  if (!checkMaster(req, res)) return;
  const out = {
    tesseractLoaded: !!Tesseract,
    sharpLoaded: !!sharp,
  };

  const tessdataPath = path.join(__dirname, 'lib', 'tessdata', 'eng.traineddata');
  try {
    const st = fs.statSync(tessdataPath);
    out.tessdata = { path: tessdataPath, exists: true, sizeBytes: st.size };
  } catch (e) {
    out.tessdata = { path: tessdataPath, exists: false, error: e.message };
  }

  out.pdftoppm = await new Promise(resolve => {
    execFile('pdftoppm', ['-v'], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) return resolve({ found: false, error: err.message, code: err.code });
      resolve({ found: true, version: String(stderr || stdout || '').split('\n')[0] });
    });
  });
  out.jsRasterizer = { loaded: !!(pdfjsLib && napiCanvas), pdfjsVersion: pdfjsLib ? pdfjsLib.version : null };

  // Live round trip: build a one-page PDF with drawn (not embedded-font-file)
  // text and NO text layer for our OCR path to cheat off, rasterize it via
  // pdftoppm, then OCR the resulting image — mirrors exactly what happens to
  // a real image-only label page. If this succeeds end-to-end, the pipeline
  // works on this machine; if it fails, the stage-by-stage fields above say
  // which link broke.
  try {
    const testDoc  = await PDFDocument.create();
    const page     = testDoc.addPage([300, 120]);
    const font     = await testDoc.embedFont(StandardFonts.HelveticaBold);
    page.drawText('TEST9988776655', { x: 20, y: 60, size: 22, font, color: rgb(0, 0, 0) });
    const testPdfBuf = Buffer.from(await testDoc.save());

    const rasterStart = Date.now();
    let png = await _popplerRasterizePdfPage(testPdfBuf);
    let via = png ? 'pdftoppm' : null;
    if (!png) { png = await _jsRasterizePdfPage(testPdfBuf); if (png) via = 'js (pdfjs + napi-canvas)'; }
    out.rasterize = png
      ? { ok: true, via, pngBytes: png.length, ms: Date.now() - rasterStart }
      : { ok: false, reason: 'both rasterizers failed — see pdftoppm and jsRasterizer fields above' };

    if (png) {
      const ocrStart = Date.now();
      const text = await runOcr(png, { tessedit_pageseg_mode: '3' });
      out.ocr = { ok: true, ms: Date.now() - ocrStart, textRead: text.trim(), matchesExpected: /TEST9988776655/i.test(text.replace(/\s+/g, '')) };
    } else {
      out.ocr = { ok: false, reason: 'skipped — rasterize step failed' };
    }
  } catch (e) {
    out.roundTripError = e.message;
  }

  out.verdict = (out.rasterize && out.rasterize.ok && out.ocr && out.ocr.ok && out.ocr.matchesExpected)
    ? `OCR pipeline fully working on this deployment (rasterizer: ${out.rasterize.via})`
    : (!out.pdftoppm.found && !out.jsRasterizer.loaded)
      ? 'NO rasterizer available: pdftoppm not installed AND the JS fallback failed to load — check server startup logs for [label-ocr]'
      : (!out.tessdata.exists)
        ? 'Tesseract language data file is missing from the deployed image'
        : 'Pipeline reached the round trip but did not produce correct text — see rasterize/ocr fields';

  res.json(out);
});

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
    _rebuildCode2Lengths();
    res.json({ ok: true, entries: Object.keys(map).length, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Master: SKU → description catalog ───────────────────────────────────────
app.get('/api/master/sku-catalog', (req, res) => {
  if (!checkMaster(req, res)) return;
  res.json({ entries: Object.keys(_skuCatalog).length, map: _skuCatalog });
});

// POST — bulk-load an XLSX/CSV with SKU + Description columns; merges into the
// catalog (existing SKUs are updated, others kept).
app.post('/api/master/sku-catalog', upload.single('file'), (req, res) => {
  if (!checkMaster(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb      = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws      = wb.Sheets[wb.SheetNames[0]];
    const records = XLSX.utils.sheet_to_json(ws, { defval: null });
    const SKU_KEYS  = ['sku', 'product_code', 'item_code', 'item_no', 'code', 'barcode'];
    const DESC_KEYS = ['description', 'item_description', 'product_description', 'product_name', 'item_name', 'name', 'desc'];
    let added = 0, updated = 0, skipped = 0;
    for (const rec of records) {
      const n = {};
      for (const k of Object.keys(rec)) n[normalizeKey(k)] = rec[k];
      const sku  = String(SKU_KEYS.map(k => n[k]).find(v => v != null) ?? '').trim();
      const desc = String(DESC_KEYS.map(k => n[k]).find(v => v != null) ?? '').trim();
      if (!sku || !desc || desc === sku) { skipped++; continue; }
      if (_skuCatalog[sku] === undefined)      added++;
      else if (_skuCatalog[sku] !== desc)      updated++;
      _skuCatalog[sku] = desc;
    }
    _saveSkuCatalog();
    res.json({ ok: true, entries: Object.keys(_skuCatalog).length, added, updated, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/master/sku-catalog', (req, res) => {
  if (!checkMaster(req, res)) return;
  _skuCatalog = {};
  _saveSkuCatalog();
  res.json({ ok: true, entries: 0 });
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
    ...(() => {
      const alloc = allocateScansToLines(ord, state.scanned || {});
      return ord.lines.map((l, i) => {
        const s  = alloc[i];
        const ok = s === l.qty;
        return [l.sku, l.description || '', l.qty, s, ok ? 'OK' : s > l.qty ? 'Over-scanned' : 'Short'];
      });
    })(),
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
const _serverStartedAt = new Date().toISOString();
app.listen(PORT, () => console.log(`Fulfillment Scanner on port ${PORT}`));
