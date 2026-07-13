process.on('uncaughtException',  (err) => console.error('[CRASH] uncaughtException:', err.stack || err.message));
process.on('unhandledRejection', (err) => console.error('[CRASH] unhandledRejection:', err?.stack || err));

const express    = require('express');
const multer     = require('multer');
const { parse }  = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const zlib       = require('zlib');
const XLSX       = require('xlsx');
const nodemailer = require('nodemailer');
const { PDFDocument, PDFName, PDFRawStream, PDFArray, decodePDFRawStream } = require('pdf-lib');
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

// The English language model ships in the repo (lib/tessdata) so OCR needs no
// network download at runtime — CDN fetch remains the fallback if it's missing.
const TESSDATA_DIR = path.join(__dirname, 'lib', 'tessdata');
function createOcrWorker() {
  const opts = { logger: () => {} };
  if (fs.existsSync(path.join(TESSDATA_DIR, 'eng.traineddata.gz'))) {
    opts.langPath    = TESSDATA_DIR;
    opts.gzip        = true;
    opts.cacheMethod = 'none'; // data is already local — don't write a decompressed copy to the app dir
  }
  return Tesseract.createWorker('eng', 1, opts);
}

// Run Tesseract with LSTM engine (OEM 1) + auto page segmentation (PSM 3).
// Extra Tesseract params can be passed as extraParams (e.g. char whitelist, PSM override).
// Pass a `worker` to reuse one Tesseract instance across many images (batch OCR) —
// creating a worker costs ~1s, so per-page workers would dominate a 25-label run.
async function runOcr(buffer, extraParams = {}, worker = null) {
  const img = await preprocessForOcr(buffer);
  // OEM 1 = LSTM neural-net engine only (more accurate than legacy)
  const w = worker || await createOcrWorker();
  try {
    await w.setParameters({
      tessedit_pageseg_mode: '3',      // PSM_AUTO — let Tesseract detect layout
      preserve_interword_spaces: '1',  // keeps column spacing intact
      ...extraParams,
    });
    const { data: { text } } = await w.recognize(img);
    return text;
  } finally {
    if (!worker) await w.terminate();
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
// no-cache (= revalidate every load) on HTML/JS/CSS so every deploy reaches
// browsers on the next reload — stale cached app.js caused phantom bugs.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get('/api/ping', (_req, res) => res.json({ ok: true, ts: Date.now() }));
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

let _customHeadersCache = undefined;
function loadCustomHeaders() {
  if (_customHeadersCache !== undefined) return _customHeadersCache;
  try {
    const data = JSON.parse(fs.readFileSync(KEYFIELDS_TEMPLATE_FILE, 'utf8'));
    _customHeadersCache = (Array.isArray(data.headers) && data.headers.length > 0) ? data.headers : null;
  } catch { _customHeadersCache = null; }
  return _customHeadersCache;
}
function invalidateCustomHeadersCache() { _customHeadersCache = undefined; }

function readDb() {
  if (_dbCache) return _dbCache;
  try { _dbCache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { _dbCache = { batches: [] }; }
  return _dbCache;
}
// Persist is ATOMIC (tmp file + rename) so a crash mid-write can never leave
// a corrupt half-written db.json, and writes are serialized so concurrent
// writeDb calls coalesce instead of racing each other.
let _dbWriting = false;
let _dbWritePending = false;
function _persistDb() {
  if (_dbWriting) { _dbWritePending = true; return; }
  _dbWriting = true;
  let json;
  try { json = JSON.stringify(_dbCache); }
  catch (e) { console.error('[writeDb] stringify error:', e.message); _dbWriting = false; return; }
  const tmp = DB_FILE + '.tmp';
  fs.writeFile(tmp, json, err => {
    if (err) {
      console.error('[writeDb] persist error:', err.message);
      _dbWriting = false;
      if (_dbWritePending) { _dbWritePending = false; setImmediate(_persistDb); }
      return;
    }
    fs.rename(tmp, DB_FILE, err2 => {
      if (err2) console.error('[writeDb] rename error:', err2.message);
      _dbWriting = false;
      if (_dbWritePending) { _dbWritePending = false; setImmediate(_persistDb); }
    });
  });
}
function writeDb(data) {
  _dbCache = data;
  // Defer JSON.stringify to the NEXT event loop tick so any pending res.json()
  // calls in the current tick are not blocked by a potentially-slow stringify.
  // (A large db.json with many batches was causing 30s+ event-loop stalls.)
  setImmediate(_persistDb);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Every redeploy sends the OLD container SIGTERM so the new one can take over.
// Node's default SIGTERM behavior is to die instantly with no cleanup, which
// makes npm's wrapper log "npm error signal SIGTERM" / "command failed" —
// and Railway's crash detector can't tell that apart from a real crash, so it
// fires a "Deploy Crashed" email on EVERY push. Exiting cleanly (after letting
// any in-flight db write finish) stops that false alarm and protects the
// write from being cut off mid-flush.
let _shuttingDown = false;
function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[IdealScan] ${signal} received — shutting down cleanly`);
  const done = () => process.exit(0);
  setTimeout(done, 3000); // hard cap so a stuck flush can never hang the deploy
  (function waitForFlush() {
    if (!_dbWriting) return done();
    setTimeout(waitForFlush, 50);
  })();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ── Scan journal — crash-proof record of in-flight scan progress ────────────
// db.json persistence is deferred; a hard crash could lose the last moments
// of scanning. Every order-state change is ALSO appended (immediately) to an
// NDJSON journal; on startup any journal entries newer than the stored state
// are replayed. The journal is truncated after replay — it only ever needs
// to cover the gap since the last clean write.
const SCAN_JOURNAL_FILE = path.join(DATA_DIR, 'scan-journal.ndjson');
function journalOrderState(orderNumber, state) {
  const line = JSON.stringify({
    at: state.updated_at, order: orderNumber, status: state.status,
    scanned: state.scanned || {}, startTime: state.startTime || null,
    endTime: state.endTime || null, operator: state.operator || null,
  });
  fs.appendFile(SCAN_JOURNAL_FILE, line + '\n', err => {
    if (err) console.error('[scan-journal]', err.message);
  });
}
function replayScanJournal() {
  let raw = '';
  try { raw = fs.readFileSync(SCAN_JOURNAL_FILE, 'utf8'); } catch { return; }
  if (!raw.trim()) return;
  const latest = new Map(); // order → last journal entry (last-wins, idempotent)
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e.order) latest.set(e.order, e); } catch {}
  }
  const db = readDb();
  let recovered = 0;
  for (const [orderNumber, e] of latest) {
    const batch = (db.batches || []).find(b => (b.orders || []).some(o => o.order_number === orderNumber));
    if (!batch) continue;
    if (!batch.orderStates) batch.orderStates = {};
    const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
    if (state.updated_at && e.at && e.at <= state.updated_at) continue; // db already has it
    state.status     = e.status || state.status;
    state.scanned    = e.scanned || state.scanned;
    state.updated_at = e.at || state.updated_at;
    if (e.startTime) state.startTime = e.startTime;
    if (e.endTime)   state.endTime   = e.endTime;
    if (e.operator)  state.operator  = e.operator;
    appendScanLog(state, { kind: 'recovered', raw: '', sku: '(scan journal replay after restart)', qty: '', by: '' });
    batch.orderStates[orderNumber] = state;
    recovered++;
  }
  if (recovered > 0) {
    writeDb(db);
    console.log(`[IdealScan] Scan journal: recovered ${recovered} order state(s) lost in an unclean shutdown`);
  }
  try { fs.truncateSync(SCAN_JOURNAL_FILE, 0); } catch {}
}

// ── Audit ledger — append-only activity trail ───────────────────────────────
// Every upload, completion, cancellation and DELETION is recorded here.
// Reports read from this ledger, not from live batches, so deleting an
// upload (or running Master Reset) never erases the history.
function logAudit(type, data) {
  const db = readDb();
  if (!db.auditLog) db.auditLog = [];
  db.auditLog.push({ type, at: new Date().toISOString(), ...data });
  writeDb(db);
}

// Snapshot of a completed order for the ledger — carries everything the
// reports need (incl. lot/expiry per line) independently of the batch.
// A SKU can appear on MULTIPLE lines of one order (client files sometimes
// split the same product across lines). Scan counts are stored per SKU, so
// every comparison of scanned-vs-ordered must first pool those lines into
// one entry per SKU — otherwise the shared counter is double-counted and
// the order can never reconcile.
function uniqueSkuLines(ord) {
  const map = new Map();
  for (const l of (ord.lines || [])) {
    const m = map.get(l.sku);
    if (!m) { map.set(l.sku, { ...l }); continue; }
    m.qty += l.qty || 0;
    for (const f of ['batch_number', 'serial_number', 'expiry_date']) {
      if (l[f] && m[f] && !String(m[f]).includes(String(l[f]))) m[f] = `${m[f]} / ${l[f]}`;
      else if (l[f] && !m[f]) m[f] = l[f];
    }
  }
  return [...map.values()];
}

function completionAuditData(batch, ord, state) {
  const scanned = state.scanned || {};
  return {
    order:     ord.order_number,
    batchId:   batch.id,
    client:    batch.client_name  || '',
    customer:  ord.customer_name  || '',
    carrier:   ord.carrier        || '',
    waybill:   ord.waybill_number || '',
    operator:  state.operator     || '',
    startTime: state.startTime    || null,
    endTime:   state.endTime      || null,
    pieces:    uniqueSkuLines(ord).reduce((s, l) => s + (scanned[l.sku] ?? l.qty ?? 0), 0),
    lines:     uniqueSkuLines(ord).map(l => ({
      sku: l.sku, description: l.description || '', qty: l.qty,
      scanned: scanned[l.sku] ?? l.qty, lot: l.batch_number || '', expiry: l.expiry_date || '',
    })),
  };
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

// CODE2 map: the repo ships a baseline (lib/betime-code2.json); a copy on the
// persistent volume (written by the Barcode→SKU Map upload) overrides it so
// UI uploads survive redeploys, which wipe the app directory.
const BETIME_CODE2_VOLUME_FILE = path.join(DATA_DIR, 'betime-code2.json');
try {
  let src = BETIME_CODE2_FILE;
  try {
    if (fs.existsSync(BETIME_CODE2_VOLUME_FILE)) src = BETIME_CODE2_VOLUME_FILE;
  } catch {}
  _beTimeCode2Map = JSON.parse(fs.readFileSync(src, 'utf8'));
  _rebuildCode2Lengths();
  console.log(`[IdealScan] Betime CODE2 map loaded: ${Object.keys(_beTimeCode2Map).length} entries (${src === BETIME_CODE2_VOLUME_FILE ? 'volume' : 'built-in'})`);
} catch (e) {
  console.warn('[IdealScan] betime-code2.json not found — CODE2 barcode translation disabled');
}
try {
  _skuDescMap = JSON.parse(fs.readFileSync(SKU_DESC_FILE, 'utf8'));
  console.log(`[IdealScan] SKU description map loaded: ${Object.keys(_skuDescMap).length} entries`);
} catch (e) { /* no desc file yet — populated on first CODE2 upload */ }
// Repo-shipped description seed fills any SKUs the volume file doesn't have
// (explicit UI uploads keep priority for SKUs they cover)
try {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'lib', 'sku-descriptions-seed.json'), 'utf8'));
  let added = 0;
  for (const [sku, desc] of Object.entries(seed)) {
    if (!_skuDescMap[sku]) { _skuDescMap[sku] = desc; added++; }
  }
  if (added > 0) {
    console.log(`[IdealScan] SKU descriptions seeded from repo: +${added} (total ${Object.keys(_skuDescMap).length})`);
    fs.writeFile(SKU_DESC_FILE, JSON.stringify(_skuDescMap, null, 2), () => {});
  }
} catch (e) { /* no seed shipped — fine */ }
// No-barcode SKU seed: SKUs the client's own listing marks as having no
// barcode. They get the on-screen substitute barcode and count buttons
// automatically — no GWP text or manual marking needed.
try {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'lib', 'no-barcode-skus-seed.json'), 'utf8'));
  const db = readDb();
  if (!db.noBarcodeSkus) db.noBarcodeSkus = {};
  let added = 0;
  for (const [sku, info] of Object.entries(seed)) {
    if (!db.noBarcodeSkus[sku]) {
      db.noBarcodeSkus[sku] = { ...info, addedAt: new Date().toISOString(), addedBy: 'seed' };
      added++;
    }
  }
  if (added > 0) {
    writeDb(db);
    console.log(`[IdealScan] No-barcode SKUs seeded: +${added} (total ${Object.keys(db.noBarcodeSkus).length})`);
  }
} catch (e) { /* no seed shipped — fine */ }

// One-time audit backfill — synthesize ledger events from batches that
// existed before the ledger was introduced, so reports cover old activity.
(function backfillAuditLedger() {
  try {
    const db = readDb();
    if (db.auditBackfilled) return;
    if (!db.auditLog) db.auditLog = [];
    let n = 0;
    for (const b of db.batches || []) {
      db.auditLog.push({ type: 'upload', at: b.uploaded_at, batchId: b.id, filename: b.filename, by: b.uploaded_by || '', client: b.client_name || '', orders: b.order_count || (b.orders || []).length, lines: b.row_count || 0 });
      n++;
      const states = b.orderStates || {};
      for (const o of b.orders || []) {
        const st = states[o.order_number];
        if (!st) continue;
        if (st.status === 'done') {
          db.auditLog.push({ type: 'order_completed', at: st.endTime || st.updated_at || b.uploaded_at, ...completionAuditData(b, o, st) });
          n++;
        } else if (st.status === 'unprocessed') {
          db.auditLog.push({ type: 'order_cancelled', at: st.updated_at || b.uploaded_at, order: o.order_number, batchId: b.id, client: b.client_name || '', operator: st.operator || '', mismatches: st.mismatches || [] });
          n++;
        }
      }
    }
    db.auditLog.sort((a, b2) => new Date(a.at) - new Date(b2.at));
    db.auditBackfilled = true;
    writeDb(db);
    console.log(`[IdealScan] Audit ledger backfilled: ${n} events`);
  } catch (e) { console.error('[IdealScan] audit backfill failed:', e.message); }
})();

// Recover any scan progress that a crash prevented from reaching db.json
try { replayScanJournal(); } catch (e) { console.error('[IdealScan] scan journal replay failed:', e.message); }

// Resolve a scanned barcode to a WMS product code. Returns the original value
// unchanged when the barcode is not in the Betime CODE 2 map.
//
// Handles scanners that sweep multiple barcodes in one burst and concatenate
// them into a single string. When a direct lookup misses and the input is
// all-digits longer than the shortest known barcode, we try every key-length
// that exists in the map (derived at load time, updated on hot-reload) as a
// prefix — longest first. This works for any barcode format in any future
// upload without hardcoded lengths.
// Official CODE2 listing lookup only (no learned mappings). Returns the WMS
// product code, or null when the listing doesn't cover this barcode.
function officialResolveCode2(k) {
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
  return null;
}

function resolveBeTimeCode2(scanned) {
  if (!scanned) return scanned;
  const k = scanned.trim();
  const official = officialResolveCode2(k);
  if (official) return official;
  // Teach-on-scan learned mappings — always LOWER priority than the official
  // CODE2 listing above, so a client refresh stays authoritative
  const kStripped = k.replace(/^0+(?=.)/, '');
  if (_learnedBarcodeMap[k]) return _learnedBarcodeMap[k].sku;
  if (kStripped !== k && _learnedBarcodeMap[kStripped]) return _learnedBarcodeMap[kStripped].sku;
  // Double-pull concatenation rescue for learned barcodes too (step 4 only
  // covers official keys): two fast trigger pulls glue two codes together
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
let _learnedBarcodeMap = {}; // barcode → { sku, learnedBy, learnedAt, order }
let _learnedSkuAliases = []; // [{ a, b, learnedBy, learnedAt, order }] — a=official name, b=order-file name
try {
  const _db0 = readDb();
  _learnedBarcodeMap = _db0.learnedBarcodes  || {};
  _learnedSkuAliases = _db0.learnedSkuAliases || [];
  const n = Object.keys(_learnedBarcodeMap).length + _learnedSkuAliases.length;
  if (n) console.log(`[IdealScan] Learned barcode mappings loaded: ${Object.keys(_learnedBarcodeMap).length} barcodes, ${_learnedSkuAliases.length} aliases`);
} catch {}

// Per-order scan history — every count action is recorded so the completed
// order's slip can show exactly what was scanned, when, and by whom.
function appendScanLog(state, evt) {
  if (!state.scanLog) state.scanLog = [];
  state.scanLog.push({ at: new Date().toISOString(), ...evt });
  if (state.scanLog.length > 800) state.scanLog.splice(0, state.scanLog.length - 800);
}

// A teachable scan must look like a product barcode: 8+ chars, mostly digits,
// and not a warehouse location code.
function isTeachableBarcode(s) {
  const v = String(s || '').trim();
  if (v.length < 8 || v.length > 30) return false;
  if ((v.match(/\d/g) || []).length < 6) return false;
  if (/^[A-Z]{1,4}(-\d{1,6}){1,3}(-[A-Z]{1,2})?$/i.test(v)) return false; // location code
  return /^[A-Z0-9]+$/i.test(v);
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

  const wmsName = `WMS_${batch.idealscan_code ? batch.idealscan_code + '_' : ''}${batch.filename.replace(/\.[^.]+$/, '')}_${batch.uploaded_at.slice(0, 10)}.xlsx`;

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
        po_number:        line.po_number         || '',
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
// Waybill-PDF existence cache — one readdir per batch instead of one
// fs.existsSync per order per dashboard refresh
const _waybillDirCache = new Map(); // batchId → Set of filenames
function batchWaybillSet(batchId) {
  let set = _waybillDirCache.get(batchId);
  if (set) return set;
  try { set = new Set(fs.readdirSync(path.join(WAYBILL_DIR, batchId))); } catch { set = new Set(); }
  _waybillDirCache.set(batchId, set);
  return set;
}
function invalidateWaybillCache(batchId) { _waybillDirCache.delete(batchId); }

function globalOrdersWithState() {
  const db          = readDb();
  const orderLabels = db.orderLabels || {};
  const seen        = new Set();
  const out         = [];
  for (const batch of db.batches) {
    const states = batch.orderStates || {};
    const wbSet  = batchWaybillSet(batch.id);
    for (const ord of (batch.orders || [])) {
      if (seen.has(ord.order_number)) continue; // newest batch wins
      seen.add(ord.order_number);
      const state       = states[ord.order_number] || { status: 'pending', scanned: {} };
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
        items:             enrichedLines,
        uploadedAt:        batch.uploaded_at,
        idealscan_code:    batch.idealscan_code || '',
        scan_status:       state.status           || 'pending',
        scanned:           { ...state.scanned },
        mismatches:        state.mismatches        || [],
        startTime:         state.startTime         || null,
        endTime:           state.endTime           || null,
        operator:          state.operator          || null,
        keyfields_closed:  state.keyfields_closed  || false,
        claimed_by:        claimHolder(state),
        alert_email_sent:  state.alert_email_sent  ?? null,
        alert_email_error: state.alert_email_error || null,
        batchId:           batch.id,
        client_name:       batch.client_name       || '',
        has_waybill_pdf:   wbSet.has(`${ord.order_number}.pdf`),
        has_order_label:   !!(orderLabels[ord.order_number]),
      });
    }
  }
  return out;
}

// ── IdealScan job codes ──────────────────────────────────────────────────────
// Every uploaded job gets a unique IS-YYMMDD-NN code — the reference that ties
// the client's file, IdealScan, and the Keyfields WMS upload together (it is
// stamped into the WMS export filename). Visible to admins; the warehouse
// scan screens never show it.
function nextIdealscanCode(db) {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }).slice(2).replace(/-/g, '');
  if (!db.jobCodeSeq) db.jobCodeSeq = {};
  db.jobCodeSeq[day] = (db.jobCodeSeq[day] || 0) + 1;
  // keep only today's counter — past days never mint new codes
  for (const k of Object.keys(db.jobCodeSeq)) if (k !== day) delete db.jobCodeSeq[k];
  return `IS-${day}-${String(db.jobCodeSeq[day]).padStart(2, '0')}`;
}

// One-time backfill: give pre-existing batches codes based on their upload date
(function backfillJobCodes() {
  try {
    const db = readDb();
    if (db.jobCodesBackfilled) return;
    const perDay = {};
    let n = 0;
    const sorted = [...(db.batches || [])].sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at));
    for (const b of sorted) {
      if (b.idealscan_code) continue;
      const day = new Date(b.uploaded_at || Date.now())
        .toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }).slice(2).replace(/-/g, '');
      perDay[day] = (perDay[day] || 0) + 1;
      b.idealscan_code = `IS-${day}-${String(perDay[day]).padStart(2, '0')}`;
      n++;
    }
    // seed today's counter so new uploads continue after the backfilled ones
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }).slice(2).replace(/-/g, '');
    if (perDay[today]) {
      if (!db.jobCodeSeq) db.jobCodeSeq = {};
      db.jobCodeSeq[today] = Math.max(db.jobCodeSeq[today] || 0, perDay[today]);
    }
    db.jobCodesBackfilled = true;
    writeDb(db);
    if (n) console.log(`[IdealScan] Job codes backfilled on ${n} existing batch(es)`);
  } catch (e) { console.error('[IdealScan] job code backfill failed:', e.message); }
})();

// Find which batch holds a given order number (newest batch first).
function findBatchForOrder(db, orderNumber) {
  for (const batch of db.batches) {
    if ((batch.orders || []).some(o => o.order_number === orderNumber)) return batch;
  }
  return null;
}

// ── Auto-archive ─────────────────────────────────────────────────────────────
// db.json is rewritten on every scan, so it must stay small forever. Batches
// whose orders are ALL settled (done/unprocessed) and untouched for 60 days
// move to monthly archive files on the volume. Archived orders stay
// reachable: slips/waybills fall back to the archive, and the Completed tab
// searches archives explicitly. The audit ledger is unaffected — reports
// keep covering archived activity.
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const ARCHIVE_AFTER_DAYS = 60;

function batchArchivable(batch, cutoffIso) {
  const orders = batch.orders || [];
  if (!orders.length) return (batch.uploaded_at || '') < cutoffIso;
  const states = batch.orderStates || {};
  let newest = batch.uploaded_at || '';
  for (const o of orders) {
    const st = states[o.order_number];
    if (!st || (st.status !== 'done' && st.status !== 'unprocessed')) return false; // still open work
    const t = st.endTime || st.updated_at || '';
    if (t > newest) newest = t;
  }
  return newest < cutoffIso;
}

function runAutoArchive() {
  try {
    const db = readDb();
    const cutoff = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 86400000).toISOString();
    const keep = [], move = [];
    for (const b of db.batches || []) (batchArchivable(b, cutoff) ? move : keep).push(b);
    if (!move.length) return;
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const byMonth = {};
    for (const b of move) {
      const m = (b.uploaded_at || '').slice(0, 7) || 'unknown';
      (byMonth[m] = byMonth[m] || []).push(b);
    }
    for (const [m, batches] of Object.entries(byMonth)) {
      const file = path.join(ARCHIVE_DIR, `archive-${m}.json`);
      let existing = [];
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      existing.push(...batches);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(existing));
      fs.renameSync(tmp, file);
    }
    db.batches = keep;
    writeDb(db);
    logAudit('batches_archived', { count: move.length, months: Object.keys(byMonth).sort() });
    console.log(`[IdealScan] Auto-archive: moved ${move.length} settled batch(es) → ${Object.keys(byMonth).sort().join(', ')}`);
  } catch (e) {
    console.error('[IdealScan] auto-archive failed:', e.message);
  }
}
setTimeout(runAutoArchive, 60 * 1000);           // shortly after boot
setInterval(runAutoArchive, 24 * 3600 * 1000);   // then daily

function listArchiveFiles() {
  try { return fs.readdirSync(ARCHIVE_DIR).filter(f => /^archive-.*\.json$/.test(f)).sort().reverse(); }
  catch { return []; }
}
// Find an archived batch by id (used by slip/label endpoints as fallback)
function readArchivedBatch(batchId) {
  for (const f of listArchiveFiles()) {
    try {
      const batches = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8'));
      const hit = batches.find(b => b.id === batchId);
      if (hit) return hit;
    } catch {}
  }
  return null;
}
// Search archived orders (Completed-tab search). Returns order rows in the
// same shape the dashboard uses, newest first, capped.
function searchArchivedOrders(q, cap = 60) {
  const needle = String(q || '').trim().toLowerCase();
  if (needle.length < 3) return [];
  const out = [];
  for (const f of listArchiveFiles()) {
    let batches;
    try { batches = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8')); } catch { continue; }
    for (const batch of batches) {
      for (const o of batch.orders || []) {
        const hay = [o.order_number, o.waybill_number, o.pick_ticket, o.po_number, o.customer_name, batch.client_name, batch.idealscan_code]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(needle)) continue;
        const st = (batch.orderStates || {})[o.order_number] || {};
        out.push({
          ...o,
          items: o.lines || [],
          client_name: batch.client_name || '',
          batchId: batch.id,
          uploadedAt: batch.uploaded_at,
          idealscan_code: batch.idealscan_code || '',
          scan_status: st.status === 'done' ? 'done' : (st.status || 'pending'),
          scanned: st.scanned || {},
          startTime: st.startTime || null, endTime: st.endTime || null,
          operator: st.operator || null,
          archived: true,
        });
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
}

// ── PDF waybill splitting ───────────────────────────────────────────────────
// Normalize a string for comparison: uppercase, strip spaces/hyphens/underscores
function normStr(s) { return String(s || '').replace(/[\s\-_]/g, '').toUpperCase(); }

// Extract the text of every page from the ORIGINAL PDF buffer, in page order.
// Never run pdf-parse on pdf-lib re-saved single pages: pdf-parse (pdf.js
// 1.10) frequently fails on pdf-lib output ("Invalid PDF structure" /
// "bad XRef entry"), while original client/courier PDFs parse fine.
async function extractPdfPageTexts(buffer) {
  const pageTexts = [];
  if (!pdfParse) return pageTexts;
  await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const tc = await pageData.getTextContent();
      let last = null, text = '';
      for (const item of tc.items) {
        if (last && last.transform[5] !== item.transform[5]) text += '\n';
        text += item.str;
        last = item;
      }
      pageTexts.push(text);
      return text;
    },
  });
  return pageTexts;
}

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

    // Per-page text from the ORIGINAL buffer (re-saved pages don't parse
    // reliably); a parse failure just means no text matching, fallback below.
    let pageTexts = [];
    try { pageTexts = await extractPdfPageTexts(pdfBuffer); }
    catch (e) { console.error('[pdf-split] text extraction:', e.message); }

    for (let i = 0; i < numPages; i++) {
      const single = await PDFDocument.create();
      const [pg]   = await single.copyPages(pdfDoc, [i]);
      single.addPage(pg);
      const buf = Buffer.from(await single.save());

      let assignedOrder = null;

      if (pageTexts[i] && (byWaybill.size || byOrder.size || byIssueNo.size || byPickTicket.size)) {
        try {
          const rawText  = pageTexts[i].toUpperCase();
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
    invalidateWaybillCache(batchId);
    const rec = {
      filename: req.file.originalname || 'waybill.pdf',
      at: new Date().toISOString(), by: req.userId || '',
      matched: Object.keys(matchResult).length, total: (batch.orders || []).length,
    };
    batch.waybill_uploads = batch.waybill_uploads || [];
    batch.waybill_uploads.push(rec);
    writeDb(db);
    logAudit('waybill_upload', { batchId, ...rec });
    res.json({ ok: true, matched: rec.matched, total: rec.total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk Label PDF Import ─────────────────────────────────────────────────────

const labelImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ── Label→order matching ─────────────────────────────────────────────────────
// Two strategies, tried in order:
//   1. extract-then-lookup — extractLabelFields pulls an order/tracking number
//      from the page and we look it up (fast, but format-specific)
//   2. reverse known-key scan — we search the page text for ANY known order
//      key (order number / GI, waybill/reference, PO/shipment number). This is
//      format-agnostic: any client label matches as long as it prints one of
//      the numbers we already hold for the order.
// All-digit keys need 10+ chars (8-digit keys collide with SG phone numbers
// printed on labels); keys containing letters need 8+.
// ── Image-only label pages (e.g. Shopee SPX) ────────────────────────────────
// Some client label PDFs have no text layer at all — each page is one big
// bitmap, so pdf-parse returns nothing and both matching strategies are blind.
// For those pages we pull the embedded image straight out of the PDF (no
// rasterizer needed) and OCR it with the existing photo pipeline.

// Minimal PNG writer for raw pixel data (gray or RGB, 8-bit) so the Flate
// image path works even where sharp is unavailable.
function rawPixelsToPng(raw, width, height, channels) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = buf => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const scan = Buffer.alloc(height * (width * channels + 1));
  for (let y = 0; y < height; y++) {
    scan[y * (width * channels + 1)] = 0;
    raw.copy(scan, y * (width * channels + 1) + 1, y * width * channels, (y + 1) * width * channels);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 1 ? 0 : 2; // greyscale / truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(scan)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Returns { buf (JPEG or PNG), rotate } for the largest image on the page, or null.
function extractLargestPageImage(pdfDoc, pageIndex) {
  const page = pdfDoc.getPage(pageIndex);
  const resources = page.node.Resources();
  const xobjects = resources && resources.lookup(PDFName.of('XObject'));
  if (!xobjects || typeof xobjects.keys !== 'function') return null;

  let best = null;
  for (const key of xobjects.keys()) {
    const stream = xobjects.lookup(key);
    if (!(stream instanceof PDFRawStream)) continue;
    const dict = stream.dict;
    const subtype = dict.get(PDFName.of('Subtype'));
    if (!subtype || subtype.toString() !== '/Image') continue;
    const width  = dict.lookup(PDFName.of('Width'))?.asNumber?.()  || 0;
    const height = dict.lookup(PDFName.of('Height'))?.asNumber?.() || 0;
    if (!width || !height) continue;
    if (best && width * height <= best.width * best.height) continue;
    best = { stream, dict, width, height };
  }
  if (!best) return null;

  const rotate = (page.getRotation?.().angle || 0) % 360;
  let filter = best.dict.get(PDFName.of('Filter'));
  if (filter instanceof PDFArray) filter = filter.get(filter.size() - 1);
  const filterName = filter ? filter.toString() : '';

  if (filterName === '/DCTDecode') {
    // JPEG bytes stored as-is
    return { buf: Buffer.from(best.stream.getContents()), rotate };
  }
  if (filterName === '/FlateDecode' || filterName === '') {
    const raw = Buffer.from(filterName ? decodePDFRawStream(best.stream).decode() : best.stream.getContents());
    const bpc = best.dict.lookup(PDFName.of('BitsPerComponent'))?.asNumber?.() || 8;
    const cs  = best.dict.get(PDFName.of('ColorSpace'));
    const csName = cs ? cs.toString() : '/DeviceRGB';
    let channels = csName === '/DeviceGray' ? 1 : csName === '/DeviceRGB' ? 3 : 0;
    if (!channels) return null; // indexed/CMYK raw — not worth handling until seen
    let pixels = raw;
    if (bpc === 1 && channels === 1) {
      // unpack 1-bit rows to 8-bit
      const rowBytes = Math.ceil(best.width / 8);
      pixels = Buffer.alloc(best.width * best.height);
      for (let y = 0; y < best.height; y++) {
        for (let x = 0; x < best.width; x++) {
          const bit = (raw[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          pixels[y * best.width + x] = bit ? 255 : 0;
        }
      }
    } else if (bpc !== 8) return null;
    if (pixels.length < best.width * best.height * channels) return null;
    return { buf: rawPixelsToPng(pixels, best.width, best.height, channels), rotate };
  }
  return null; // JPX/CCITT etc. — unsupported
}

// OCR one stored single-page label PDF. Returns text ('' if nothing readable).
async function ocrLabelPageFile(filePath, worker) {
  const pageDoc = await PDFDocument.load(fs.readFileSync(filePath));
  const img = extractLargestPageImage(pageDoc, 0);
  if (!img) return '';
  let buf = img.buf;
  if (img.rotate && sharp) {
    try { buf = await sharp(buf).rotate(img.rotate).png().toBuffer(); } catch {}
  }
  let text = await runOcr(buf, {}, worker) || '';
  // A label always carries long alphanumeric codes — almost none means the
  // image is probably sideways without a /Rotate flag; try once at 90°.
  const density = t => t.replace(/[^A-Z0-9]/gi, '').length;
  if (density(text) < 12 && sharp) {
    try {
      const t2 = await runOcr(await sharp(img.buf).rotate(90).png().toBuffer(), {}, worker) || '';
      if (density(t2) > density(text)) text = t2;
    } catch {}
  }
  return text;
}

function buildLabelMatchIndex() {
  const allOrders = globalOrdersWithState();
  const byOrderNo = new Map();
  const byWaybill = new Map();
  const scanKeys  = [];
  for (const o of allOrders) {
    const keys = [
      [normStr(o.order_number),   'order_number'],
      [normStr(o.waybill_number), 'waybill_number'],
      [normStr(o.po_number),      'po_number'],
    ];
    if (keys[0][0]) byOrderNo.set(keys[0][0], o.order_number);
    if (keys[1][0]) byWaybill.set(keys[1][0], o.order_number);
    if (keys[2][0]) byWaybill.set(keys[2][0], o.order_number);
    for (const [key, field] of keys) {
      if (!key) continue;
      const minLen = /[A-Z]/.test(key) ? 8 : 10;
      if (key.length >= minLen) scanKeys.push({ key, orderNumber: o.order_number, method: field + '_scan' });
    }
  }
  scanKeys.sort((a, b) => b.key.length - a.key.length); // longest key wins
  return { byOrderNo, byWaybill, scanKeys };
}

function matchLabelPage(rawText, extracted, index) {
  const f = extracted || {};
  if (f.orderNumber) {
    const hit = index.byOrderNo.get(normStr(f.orderNumber));
    if (hit) return { hit, method: 'order_number' };
  }
  if (f.trackingNumber) {
    const hit = index.byWaybill.get(normStr(f.trackingNumber));
    if (hit) return { hit, method: 'tracking_number' };
  }
  if (rawText) {
    const hay = normStr(rawText);
    for (const k of index.scanKeys) {
      if (hay.includes(k.key)) return { hit: k.orderNumber, method: k.method };
    }
  }
  return null;
}

app.post('/api/label-imports', requireAuth, labelImportUpload.single('labelPdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file received' });
  try {
    const importId  = uuidv4();
    const importDir = path.join(LABEL_IMPORT_DIR, importId);
    fs.mkdirSync(importDir, { recursive: true });

    const pdfDoc   = await PDFDocument.load(req.file.buffer);
    const numPages = pdfDoc.getPageCount();

    const matchIndex = buildLabelMatchIndex();

    const db = readDb();
    if (!db.labelImports) db.labelImports = [];
    if (!db.orderLabels)  db.orderLabels  = {};

    const pages              = [];
    const matchedThisImport  = new Set();

    // Per-page text from the ORIGINAL upload — pdf-lib re-saved single pages
    // frequently fail to parse, so text extraction must happen before the split
    let pageTexts  = [];
    let parseError = false;
    try { pageTexts = await extractPdfPageTexts(req.file.buffer); }
    catch (e) { parseError = true; console.error('[label-import] text extraction:', e.message); }

    for (let i = 0; i < numPages; i++) {
      const single  = await PDFDocument.create();
      const [pg]    = await single.copyPages(pdfDoc, [i]);
      single.addPage(pg);
      const pageBuf  = Buffer.from(await single.save());
      const pageFile = `page_${i + 1}.pdf`;
      fs.writeFileSync(path.join(importDir, pageFile), pageBuf);

      const rawText          = pageTexts[i] || '';
      let extracted          = {};
      let matchStatus        = parseError ? 'error' : 'unmatched';
      let matchedOrderNumber = null;
      let matchMethod        = null;

      if (rawText) {
        try {
          if (extractLabelFields) extracted = extractLabelFields(rawText);
          const hit = matchLabelPage(rawText, extracted, matchIndex);
          if (hit) {
            matchedOrderNumber = hit.hit;
            matchStatus  = matchedThisImport.has(hit.hit) ? 'duplicate' : 'matched';
            matchMethod  = hit.method;
            matchedThisImport.add(hit.hit);
          }
        } catch (e) { matchStatus = 'error'; }
      }

      if (matchedOrderNumber && matchStatus === 'matched') {
        db.orderLabels[matchedOrderNumber] = {
          importId, pageIndex: i, pageFile,
          attachedAt: new Date().toISOString(), attachedBy: req.userId,
        };
      }

      // rawText kept (truncated) so later rematches can reverse-scan without
      // re-parsing the PDF from the volume
      pages.push({ pageIndex: i, pageFile, extracted, rawText: rawText.slice(0, 4000), matchStatus, matchedOrderNumber, matchMethod });
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

    // Image-only pages (no text layer) can't match yet — kick off a background
    // OCR pass so they're matched by the time anyone opens the review screen.
    if (pages.some(p => p.matchStatus === 'unmatched' && !(p.rawText || '').trim())) {
      setImmediate(() => rematchLabelImport(importId, false)
        .catch(e => console.error('[label-ocr-bg]', e.message)));
    }
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
// Core rematch, shared by the Auto Match endpoint and the post-upload
// background pass. OCRs image-only pages (once — the text is stored) so
// label PDFs without a text layer can still auto-match.
async function rematchLabelImport(id, rematchAll) {
  const db  = readDb();
  const imp = (db.labelImports || []).find(i => i.id === id);
  if (!imp) return null;
  if (!db.orderLabels) db.orderLabels = {};

  const matchIndex = buildLabelMatchIndex();

  // Track which orders are already matched in THIS import (to detect duplicates)
  const matchedInImport = new Set(
    imp.pages
      .filter(p => p.matchStatus === 'matched' && !rematchAll)
      .map(p => p.matchedOrderNumber)
      .filter(Boolean)
  );

  let newMatches = 0;
  let ocrWorker  = null;
  let ocrCount   = 0;
  const OCR_PAGE_CAP = 80; // bound worst-case runtime on huge imports

  try {
  for (const page of imp.pages) {
    if (page.matchStatus === 'matched' && !rematchAll) continue;

    // Older imports predate stored rawText — re-parse the page PDF so the
    // reverse known-key scan can run on them too
    let rawText = page.rawText || '';
    if (!rawText && pdfParse) {
      try {
        const pageBuf = fs.readFileSync(path.join(LABEL_IMPORT_DIR, id, page.pageFile));
        rawText = (await pdfParse(pageBuf)).text || '';
        page.rawText = rawText.slice(0, 4000);
      } catch {}
    }

    // Image-only page (no text layer): pull the embedded bitmap and OCR it.
    // Done once per page — the text is stored so later rematches are instant.
    if (!rawText.trim() && Tesseract && !page.ocrFailed && ocrCount < OCR_PAGE_CAP) {
      try {
        if (!ocrWorker) ocrWorker = await createOcrWorker();
        const text = await ocrLabelPageFile(path.join(LABEL_IMPORT_DIR, id, page.pageFile), ocrWorker);
        ocrCount++;
        if (text.trim()) {
          rawText       = text;
          page.rawText  = text.slice(0, 4000);
          page.ocr      = true;
          if (extractLabelFields) page.extracted = extractLabelFields(text);
        } else {
          page.ocrFailed = true; // don't burn OCR time on this page again
        }
      } catch (e) {
        console.error(`[label-ocr] page ${page.pageIndex + 1}:`, e.message);
        page.ocrFailed = true;
      }
    }

    const found  = matchLabelPage(rawText, page.extracted, matchIndex);
    const hit    = found?.hit    || null;
    const method = found?.method || null;

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
          attachedAt: new Date().toISOString(), attachedBy: 'auto-match',
        };
        matchedInImport.add(hit);
        newMatches++;
      }
    }
  }
  } finally {
    if (ocrWorker) await ocrWorker.terminate().catch(() => {});
  }

  writeDb(db);
  const matched   = imp.pages.filter(p => p.matchStatus === 'matched').length;
  const unmatched = imp.pages.filter(p => p.matchStatus === 'unmatched').length;
  if (ocrCount) console.log(`[label-ocr] import ${id}: OCR'd ${ocrCount} image-only page(s), ${newMatches} new match(es)`);
  return { newMatches, matched, unmatched, ocrCount };
}

app.post('/api/label-imports/:id/rematch', requireAuth, async (req, res) => {
  try {
    const result = await rematchLabelImport(req.params.id, req.body?.all === true);
    if (!result) return res.status(404).json({ error: 'Import not found' });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[label-rematch]', err.message);
    res.status(500).json({ error: err.message });
  }
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

// ── No-barcode SKUs — registry + printable substitute-barcode sheet ─────────
// Items with no physical barcode (GWPs, samples) can't be scanned. The packer
// scans a printed substitute barcode (encodes the SKU) from a bench sheet
// instead — it flows through the normal /api/scan/increment path unchanged.
// SKUs are learned when the packer uses the +1/All buttons, plus anything
// matching the GWP pattern in uploaded orders.
const NO_BARCODE_PAT = /\bGWP\b/i;

app.post('/api/no-barcode-skus', requireAuth, (req, res) => {
  const sku = String(req.body?.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku required' });
  const db = readDb();
  if (!db.noBarcodeSkus) db.noBarcodeSkus = {};
  if (!db.noBarcodeSkus[sku]) {
    db.noBarcodeSkus[sku] = {
      description: String(req.body?.description || '').slice(0, 200),
      client_name: String(req.body?.client_name || '').slice(0, 80),
      addedAt:     new Date().toISOString(),
      addedBy:     req.userId || '',
    };
    writeDb(db);
  }
  res.json({ ok: true });
});

app.get('/api/no-barcode-skus', requireAuth, (req, res) => {
  res.json(Object.keys(readDb().noBarcodeSkus || {}));
});

// Printable sheet: one CODE128 barcode card per no-barcode SKU, grouped by
// client. Opened in a new tab (?token= auth), printed and kept at the bench.
app.get('/api/no-barcode-sheet', requireAuthOrToken, (req, res) => {
  const db  = readDb();
  const map = new Map();
  for (const [sku, info] of Object.entries(db.noBarcodeSkus || {})) {
    map.set(sku, { description: info.description || '', client_name: info.client_name || '' });
  }
  for (const batch of db.batches || []) {
    for (const ord of batch.orders || []) {
      for (const l of ord.lines || []) {
        const known = map.get(l.sku);
        if (known) {
          if (!known.description && l.description) known.description = l.description;
          continue;
        }
        if (NO_BARCODE_PAT.test(l.sku) || NO_BARCODE_PAT.test(l.description || '')) {
          map.set(l.sku, { description: l.description || '', client_name: batch.client_name || '' });
        }
      }
    }
  }
  const items = [...map.entries()]
    .map(([sku, v]) => ({ sku, ...v }))
    .sort((a, b) => (a.client_name || '').localeCompare(b.client_name || '') || a.sku.localeCompare(b.sku));

  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cards = items.map((it, i) => `
    <div class="card">
      ${it.client_name ? `<div class="client">${esc(it.client_name)}</div>` : ''}
      <svg id="bc${i}"></svg>
      <div class="sku">${esc(it.sku)}</div>
      ${it.description && it.description !== it.sku ? `<div class="desc">${esc(it.description)}</div>` : ''}
    </div>`).join('');
  const scripts = items.map((it, i) =>
    `JsBarcode("#bc${i}", ${JSON.stringify(it.sku)}, {format:"CODE128", width:2.4, height:64, displayValue:false, margin:6});`
  ).join('\n');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>No-Barcode SKU Sheet</title>
<script src="/vendor/jsbarcode.min.js"></script>
<style>
  * { box-sizing:border-box; margin:0; padding:0; font-family:Arial,Helvetica,sans-serif; }
  body { padding:14px; }
  .toolbar { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
  .toolbar h1 { font-size:18px; }
  .toolbar .hint { color:#64748b; font-size:13px; flex:1; }
  .toolbar button { border:0; background:#2563eb; color:#fff; border-radius:8px; padding:10px 22px; font-size:15px; font-weight:700; cursor:pointer; }
  @media print { .toolbar { display:none; } }
  .grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; }
  .card { border:2px solid #000; border-radius:8px; padding:10px 12px; text-align:center; break-inside:avoid; }
  .card .client { font-size:10px; font-weight:700; letter-spacing:1px; color:#555; text-transform:uppercase; }
  .card svg { width:100%; height:70px; }
  .card .sku { font-size:22px; font-weight:800; font-family:Consolas,monospace; letter-spacing:1px; }
  .card .desc { font-size:11px; color:#333; margin-top:2px; }
  .empty { color:#64748b; font-size:15px; padding:40px; text-align:center; }
</style></head><body>
  <div class="toolbar">
    <h1>&#127991; No-Barcode SKU Sheet</h1>
    <span class="hint">Print, laminate, keep at the packing bench. Scanning a card counts the item exactly like scanning the product.</span>
    <button onclick="window.print()">&#128438; Print</button>
  </div>
  ${items.length ? `<div class="grid">${cards}</div>` : '<div class="empty">No no-barcode SKUs known yet. They are added automatically when a packer uses the +1 / All buttons, or when GWP items appear in uploads.</div>'}
  <script>${scripts}</script>
</body></html>`);
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
// Extracts text from a Keyfields WMS Picking List PDF.
// Field mapping: GI number → order_number (matches the *GI-…* barcode on the
// sheet, scanned to open the order), customer reference → waybill_number,
// pick ticket kept as a scan fallback (the second barcode on the sheet).
// A PDF may hold MANY picking lists back to back (e.g. 44 GIs in one file).
// Every page of a picking list carries its GI number, so pages are grouped
// by GI and each group is parsed as one document.
//
// SAFETY RULES — a picking list must never be silently dropped:
//  • hard cap on page count (runaway files)
//  • every GI found in the file must yield at least one item line, else the
//    upload is rejected naming the failing GIs (this exact failure once lost
//    43 of 44 orders without a word)
//  • when the printed "Grand Total" can be read, it is cross-checked against
//    the parsed piece count and mismatches are reported as warnings
const PDF_MAX_PAGES = 400;

async function parsePdfPicklistDetailed(buffer) {
  if (!pdfParse) throw new Error('pdf-parse not installed. Run: npm install pdf-parse');
  const pageTexts = await extractPdfPageTexts(buffer);
  if (!pageTexts.length) return { rows: [], issues: [{ gi: '(file)', critical: true, problem: 'No readable pages in PDF' }] };
  if (pageTexts.length > PDF_MAX_PAGES) {
    return { rows: [], issues: [{ gi: '(file)', critical: true, problem: `PDF has ${pageTexts.length} pages — maximum is ${PDF_MAX_PAGES}. Split the export into parts.` }] };
  }

  const groups = [];
  let cur = null;
  for (const t of pageTexts) {
    const gi = (t.match(/\bGI-\d{4,}\b/) || [])[0] || null;
    if (!cur || (gi && cur.gi && gi !== cur.gi)) {
      cur = { gi, texts: [] };
      groups.push(cur);
    }
    if (gi && !cur.gi) cur.gi = gi;
    cur.texts.push(t);
  }

  const rows   = [];
  const issues = [];
  for (const g of groups) {
    const text = g.texts.join('\n');
    let groupRows = [];
    try { groupRows = parsePicklistText(text); }
    catch (e) {
      issues.push({ gi: g.gi || '(no GI)', critical: true, problem: `Parse error: ${e.message}` });
      continue;
    }
    if (!groupRows.length) {
      issues.push({ gi: g.gi || '(no GI)', critical: true, problem: 'Picking list recognised but NO item lines could be parsed — layout not understood. Upload blocked so this order is not silently lost.' });
      continue;
    }
    // Completeness proof: the picking list numbers its own item lines
    // (SNo 1..N). If every sequence number up to the highest is present,
    // nothing was missed — no guessing against printed totals, whose
    // whole/loose carton arithmetic doesn't equal the sum of line
    // quantities and produced false alarms.
    const snos = groupRows.map(r => r.sno).filter(n => Number.isFinite(n) && n > 0);
    if (snos.length) {
      const maxSno   = Math.max(...snos);
      const seen     = new Set(snos);
      const missing  = [];
      for (let n = 1; n <= maxSno; n++) if (!seen.has(n)) missing.push(n);
      if (missing.length) {
        issues.push({
          gi: g.gi || '(no GI)', critical: false,
          problem: `Item line(s) #${missing.join(', #')} of ${maxSno} could not be parsed — check these lines on the picking list and amend below.`,
        });
      }
    }
    // One-sided total check catches TRUNCATED TAILS the SNo gaps cannot see
    // (if the last lines are missing, SNos 1..k still look contiguous)
    const tm = text.match(/Grand\s+Total\s+Loose\s*:\s*(\d{1,5})\s*$/im);
    if (tm) {
      const printed      = Number(tm[1]);
      const parsedPieces = groupRows.reduce((s, r) => s + (r.qty || 0), 0);
      if (printed > parsedPieces) {
        issues.push({ gi: g.gi || '(no GI)', critical: false, problem: `Picking list total is ${printed} pc(s) but only ${parsedPieces} pc(s) were captured — some lines may be missing; check and amend below.` });
      }
    }
    rows.push(...groupRows);
  }
  return { rows, issues };
}

async function parsePdfPicklist(buffer) {
  return (await parsePdfPicklistDetailed(buffer)).rows;
}

// Parse ONE picking list document from its extracted text
function parsePicklistText(text) {
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

  // ── PO / shipment number ──────────────────────────────────────────────────
  // Column concatenation puts the value on the line BEFORE the "PO Number"
  // label (e.g. "SHPM2673183962" then "PO Number"). This is often the courier
  // tracking number printed on the client's shipping label, so it is a key
  // for label-to-order matching.
  let poNumber = '';
  for (let i = 0; i < T.length; i++) {
    if (!/^PO\s*Number$/i.test(T[i])) continue;
    for (let j = i - 1; j >= 0; j--) {
      if (!T[j]) continue;
      // Must look like a shipment id (8+ alphanumeric with a digit), not a
      // neighbouring header label like "Address" or "Consignee"
      if (/^[A-Z0-9-]{8,}$/i.test(T[j]) && /\d/.test(T[j])) poNumber = T[j];
      break;
    }
    if (poNumber) break;
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
  // Enumerates every plausible batch/location/SNo/SKU split of a data line
  // and scores the candidates: the expected next line number and a SKU known
  // to the SKU master outweigh everything. A single greedy regex kept
  // swallowing digits (DMG-2 lines, 2-digit SNos) — enumeration + scoring
  // cannot be fooled that way.
  const LOC_ANCHORED = /^(?:[A-Z]{1,4}|\d{2,3})(?:-\d{1,6}){1,3}(?:-[A-Z]{1,2})?$/i;
  function parseDataLine(line, expectedSno) {
    const pats = [
      /[A-Z]{1,4}(?:-\d{1,6}){1,3}(?:-[A-Z]{1,2})?/gi,
      /\d{2,3}(?:-\d{3}){1,3}(?:-[A-Z]{1,2})?/g,
    ];
    const isBatchOk = s =>
      /^[A-Z0-9._]{0,12}$/i.test(s) ||
      /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s) ||
      /^\d{1,2}-[A-Z]{3}-\d{2,4}$/i.test(s);

    const candidates = [];
    for (const PAT of pats) {
      PAT.lastIndex = 0;
      let m;
      while ((m = PAT.exec(line)) !== null) {
        const full = m[0];
        // The location's trailing digits may really belong to SNo+SKU —
        // consider giving back 0..6 of them
        const tailDigits = (full.match(/(\d+)$/) || ['', ''])[1].length;
        for (let give = 0; give <= Math.min(tailDigits, 6); give++) {
          const loc = full.slice(0, full.length - give);
          if (!LOC_ANCHORED.test(loc)) continue;
          const batchStr  = line.slice(0, m.index);
          if (!isBatchOk(batchStr)) continue;
          const remainder = line.slice(m.index + loc.length);
          // Try each SNo length explicitly (1-3 digits)
          for (let snoLen = 1; snoLen <= 3; snoLen++) {
            const rm = remainder.match(new RegExp('^(\\d{' + snoLen + '})([A-Z0-9][A-Z0-9-]{2,}[A-Z0-9])((?:\\s|[A-Z][a-z]).*)?$'));
            if (!rm) continue;
            const sno = parseInt(rm[1], 10);
            let score = 0;
            if (Number.isFinite(expectedSno) && sno === expectedSno) score += 100;
            if (_skuDescMap[rm[2]]) score += 50;
            if (/^[A-Z]{2,}/i.test(loc) || /^\d/.test(loc)) score += 5;
            score += m.index / 100; // tie-break: longer batch (later location start)
            candidates.push({ score, batch: batchStr, sno, sku: rm[2], desc: (rm[3] || '').trim() });
          }
        }
        PAT.lastIndex = m.index + 1; // overlapping starts — try every position
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  const STOP_PAT  = /^Total\s+(Whole|Loose)\s+Qty/i;
  // "1EACH" / "CARTON 4 4PACK" / "2SET" — qty is the number glued to the UOM
  const QTY_EACH  = /(\d+)(?:EACH|PACK|PACKS|SET|SETS|PCS|PC|PIECE|PIECES|BOX|BOXES|CTN|CARTON|PAIR|PAIRS|KIT|KITS|BTL|TUBE|ROLL|UNIT|UNITS)$/i;
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
    // Header/barcode lines (order id, *540026*, Reference value) contain
    // GI-numbers that the permissive candidate parser could mistake for
    // item rows — they are never item lines
    if (/\bGI-\d{4,}\b/.test(t) || t.startsWith('*')) continue;

    // Item data line: batch+location+sno+sku concatenated
    const di = parseDataLine(t, items.length + (current ? 2 : 1));
    if (di) {
      if (current) items.push(current);
      // Run-on ALL-CAPS descriptions can glue onto the SKU
      // ("KOLI-GWP6KOLI GWP Pouch"). If the token isn't a known SKU but a
      // prefix of it is (per the shipped SKU master), trim to that prefix.
      let sku = di.sku;
      if (!_skuDescMap[sku]) {
        for (let l = sku.length - 1; l >= 3; l--) {
          if (_skuDescMap[sku.slice(0, l)]) { sku = sku.slice(0, l); break; }
        }
      }
      current = { sku, sno: di.sno, batch_number: di.batch, description: di.desc || '', expiry_date: '', qty: 1 };
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
    // GI number is the order identifier — it matches the scannable *GI-…*
    // barcode printed on the picking list, so scanning it opens the order.
    // The customer reference (e.g. Shopee order sn) goes to waybill_number
    // so the waybill-lookup path also resolves it.
    order_number:     giNumber   || reference  || pickTicket || 'UNKNOWN',
    customer_name:    accountName || '',
    client_name:      accountName || '',
    tel:              '',
    delivery_address: '',
    waybill_number:   reference  || '',
    issue_no:         giNumber   || '',
    pick_ticket:      pickTicket || '',
    po_number:        poNumber   || '',
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
  requireAuth(req, res, next);
});

// Parse-only preview — returns stats without saving anything
app.post('/api/preview', upload.single('orderFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname).toLowerCase();

    let allRows = [], skipped = 0;
    const pdfWarnings = [];
    let flagged = [];
    if (ext === '.pdf') {
      const detailed = await parsePdfPicklistDetailed(req.file.buffer);
      allRows = detailed.rows;
      for (const i of detailed.issues) {
        pdfWarnings.push(`${i.critical ? '⛔' : '⚠'} ${i.gi}: ${i.problem}`);
      }
      // Flagged orders carry their parsed lines so the Confirm window can
      // offer inline quantity adjustment before approval
      flagged = detailed.issues.map(i => ({
        gi: i.gi, problem: i.problem, critical: !!i.critical,
        lines: detailed.rows
          .filter(r => r.order_number === i.gi)
          .map(r => ({ sku: r.sku, description: String(r.description || '').slice(0, 70), qty: r.qty })),
      }));
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
    errors.push(...pdfWarnings);
    // Duplicate check so the Confirm dialog warns BEFORE approving
    {
      const existing = new Set();
      for (const b of readDb().batches || []) for (const o of b.orders || []) existing.add(o.order_number);
      const dups = [...new Set(orders.map(o => o.order_number).filter(n => existing.has(n)))];
      if (dups.length) errors.push(`⛔ ${dups.length} order(s) already uploaded earlier: ${dups.slice(0, 8).join(', ')}${dups.length > 8 ? '…' : ''} — upload will be blocked`);
    }
    const clientName = allRows.find(r => r.client_name)?.client_name || '';
    const customerNames = [...new Set(allRows.map(r => r.customer_name).filter(Boolean))];
    res.json({ rowCount: allRows.length, orderCount: orders.length, errors, converted: allRows.length > 0, clientName, customerNames, flagged });
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
    const db = readDb();
    const batch = {
      id: batchId,
      filename:    `photo-scan-${new Date().toISOString().slice(0, 10)}.jpg`,
      idealscan_code: nextIdealscanCode(db),
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.userId || '',
      client_name: client_name.trim(),
      order_count: orders.length,
      row_count:   rows.length,
      orderStates: {},
      orders,
    };
    db.batches.unshift(batch);
    writeDb(db);
    fs.writeFile(path.join(WMS_DIR, `${batchId}.xlsx`), wmsBuffer, err => {
      if (err) console.error('[ocr-upload] XLSX write error:', err.message);
    });
    logAudit('upload', { batchId, jobCode: batch.idealscan_code, filename: batch.filename || 'photo-scan', by: req.userId || '', client: batch.client_name || '', orders: orders.length, lines: rows.length });

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

    const orderExt = path.extname(orderFile.originalname).toLowerCase();
    let pdfIssues = [];
    let mapped;
    if (orderExt === '.pdf') {
      const detailed = await parsePdfPicklistDetailed(orderFile.buffer);
      mapped = detailed.rows;
      pdfIssues = detailed.issues;
    } else {
      mapped = parseUploadedFile(orderFile.buffer, orderFile.originalname);
    }
    // SAFETY RULE — no picking list may be silently dropped
    const criticalPdf = pdfIssues.filter(i => i.critical);
    if (criticalPdf.length) {
      return res.status(422).json({
        error: 'UPLOAD ABORTED:\nPDF safety check failed — some picking lists could not be parsed.\nNothing was saved.',
        validation: {
          passed: false, status: 'FAILED', totalErrors: criticalPdf.length,
          totalRowsProcessed: mapped.length, rowsWithErrors: criticalPdf.length, hasCritical: true,
          errors: criticalPdf.map(i => ({
            excelRow: '—', orderId: i.gi, field: 'pdf',
            issue: 'PICKING LIST NOT PARSED', description: i.problem,
            action: 'Check this picking list in the PDF; if the format is new, send one sample for support.',
            critical: true,
          })),
        },
      });
    }
    // Quantity amendments approved by the user in the Confirm window
    let adjustmentsApplied = 0;
    if (req.body?.adjustments) {
      try {
        for (const a of JSON.parse(req.body.adjustments)) {
          const qty = Math.floor(Number(a.qty));
          if (!Number.isFinite(qty) || qty < 0 || qty > 99999) continue;
          for (const r of mapped) {
            if (r.order_number === a.order && r.sku === a.sku && r.qty !== qty) {
              r.qty = qty;
              adjustmentsApplied++;
            }
          }
        }
        if (adjustmentsApplied) mapped = mapped.filter(r => (r.qty ?? 0) > 0); // qty 0 = line removed
      } catch { /* malformed adjustments are ignored */ }
    }

    if (!mapped.length) return res.status(400).json({ error: 'No valid order rows found' });
    if (mapped.length > UPLOAD_MAX_ROWS) return res.status(400).json({ error: `File has ${mapped.length} rows — maximum is ${UPLOAD_MAX_ROWS.toLocaleString()} per upload. Please split into smaller files.` });

    const sessionId = req.headers['x-session-id'] || uuidv4();
    const orders    = summarizeOrders(mapped);

    // SAFETY RULE — duplicate order numbers: re-uploading the same file (or
    // the same picking lists in another file) would create twin orders
    {
      const existing = new Set();
      for (const b of readDb().batches || []) for (const o of b.orders || []) existing.add(o.order_number);
      const dups = [...new Set(orders.map(o => o.order_number).filter(n => existing.has(n)))];
      if (dups.length) {
        return res.status(422).json({
          error: `UPLOAD ABORTED:\n${dups.length} order(s) in this file already exist in the system.\nNothing was saved.`,
          validation: {
            passed: false, status: 'FAILED', totalErrors: dups.length,
            totalRowsProcessed: mapped.length, rowsWithErrors: dups.length, hasCritical: true,
            errors: dups.slice(0, 50).map(n => ({
              excelRow: '—', orderId: n, field: 'order_number',
              issue: 'DUPLICATE ORDER NUMBER', description: `Order "${n}" was already uploaded earlier.`,
              action: 'If this is a re-upload, delete the earlier batch in Administrator → Upload History first.',
              critical: true,
            })),
          },
        });
      }
    }

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
    const direction  = req.body?.direction === 'Inbound' ? 'Inbound' : 'Outbound';

    const db = readDb();
    const batch = {
      id: batchId, filename: orderFile.originalname,
      idealscan_code: nextIdealscanCode(db),
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.userId || '',
      client_name: clientName,
      order_count: orders.length, row_count: mapped.length,
      orderStates: {},
      orders,
    };

    db.batches.unshift(batch);
    writeDb(db);
    fs.writeFile(path.join(WMS_DIR, `${batchId}.xlsx`), wmsBuffer, err => {
      if (err) console.error('[upload] XLSX write error:', err.message);
    });

    // Split waybill PDF if provided — record the upload once matching is done
    if (waybillPdf) {
      const wbName = waybillPdf.originalname || 'waybill.pdf';
      const wbBy   = req.userId || '';
      splitWaybillPdf(waybillPdf.buffer, batchId, orders).then(matchResult => {
        invalidateWaybillCache(batchId);
        const rec = { filename: wbName, at: new Date().toISOString(), by: wbBy,
                      matched: Object.keys(matchResult || {}).length, total: orders.length };
        const db2 = readDb();
        const b2  = db2.batches.find(x => x.id === batchId);
        if (b2) { b2.waybill_uploads = b2.waybill_uploads || []; b2.waybill_uploads.push(rec); writeDb(db2); }
        logAudit('waybill_upload', { batchId, ...rec });
      }).catch(err =>
        console.error('[waybill-pdf]', err.message)
      );
    }

    // Build order state inline — avoids calling globalOrdersWithState() which
    // does fs.existsSync per order. A freshly uploaded batch is always pending
    // with no waybill or label yet.
    const ordersWithState = orders.map(ord => ({
      ...ord,
      scan_status:       'pending',
      scanned:           {},
      mismatches:        [],
      startTime:         null,
      endTime:           null,
      operator:          null,
      keyfields_closed:  false,
      alert_email_sent:  null,
      alert_email_error: null,
      batchId,
      client_name:       clientName,
      has_waybill_pdf:   false,
      has_order_label:   false,
    }));

    logAudit('upload', { batchId, jobCode: batch.idealscan_code, filename: orderFile.originalname, by: req.userId || '', client: clientName, orders: orders.length, lines: mapped.length, adjustments: adjustmentsApplied });

    console.log(`[upload] sending response — ${orders.length} order(s), batchId=${batchId}`);
    res.json({ sessionId, batchId, idealscanCode: batch.idealscan_code, rowCount: mapped.length, orderCount: orders.length, orders: ordersWithState });
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
    ? `WMS_${batch.idealscan_code ? batch.idealscan_code + '_' : ''}${batch.filename.replace(/\.[^.]+$/, '')}_${batch.uploaded_at.slice(0, 10)}.xlsx`
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
    idealscan_code: b.idealscan_code || '',
    client_name: b.client_name || '', uploaded_by: b.uploaded_by || '',
    order_count: b.order_count, row_count: b.row_count, orderStates: b.orderStates,
    waybill_uploads: b.waybill_uploads || [],
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

// Date-windowed orders: the dashboard asks only for the selected range, so
// payloads stay small no matter how much history accumulates. Same day rules
// as the client always used: active orders filter on upload date, completed
// orders on completion date.
app.get('/api/orders', (req, res) => {
  const { range, from, to } = req.query;
  let orders = globalOrdersWithState();
  if (range && range !== 'all') {
    const dayOf    = v => v ? new Date(v).toISOString().slice(0, 10) : '';
    const todayStr = new Date().toISOString().slice(0, 10);
    const yestStr  = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const weekStr  = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const orderDay = o => dayOf(o.scan_status === 'done' ? (o.endTime || o.uploadedAt) : o.uploadedAt);
    orders = orders.filter(o => {
      const d = orderDay(o);
      if (!d) return true; // never hide records with no usable date
      if (range === 'today')     return d === todayStr;
      if (range === 'yesterday') return d === yestStr;
      if (range === 'week')     return d >= weekStr;
      if (range === 'range')    return (!from || d >= from) && (!to || d <= to);
      return true;
    });
  }
  res.json(orders);
});

// Completed-tab search across ARCHIVED orders (older than 60 days)
app.get('/api/orders/archived', (req, res) => {
  res.json(searchArchivedOrders(req.query.q));
});

app.post('/api/waybill-lookup', (req, res) => {
  const { waybill } = req.body;
  if (!waybill) return res.status(400).json({ error: 'waybill required' });
  const q = String(waybill).trim().toLowerCase();
  const strip0 = s => s.replace(/^0+(?=.)/, '');
  // Picking lists carry several scannable numbers — accept any of them:
  // order/GI number, pick ticket, waybill/reference, PO/shipment (SHPM…).
  // Matching here (not just client-side) means any order opens from the scan
  // bar even when it's outside the dashboard's loaded date window.
  const order = globalOrdersWithState().find(o => {
    const on = (o.order_number || '').trim().toLowerCase();
    const pt = (o.pick_ticket  || '').trim().toLowerCase();
    return on === q || strip0(on) === strip0(q) ||
      (pt && (pt === q || strip0(pt) === strip0(q))) ||
      (o.waybill_number && o.waybill_number.trim().toLowerCase() === q) ||
      (o.po_number      && String(o.po_number).trim().toLowerCase() === q);
  });
  if (!order) return res.status(404).json({ error: `No order for waybill: ${waybill}` });
  res.json(order);
});

// ── Order claiming — one packer per order ────────────────────────────────────
// Every station sees the same summary, so two packers could open the SAME
// order and cross each other's counts. Opening an order claims it; scans
// refresh the claim; everyone else is blocked (409) until it's released,
// completed, or the claim goes stale (station died / packer walked away).
const CLAIM_STALE_MS = 20 * 60 * 1000;
function claimHolder(state) {
  if (!state || !state.claimedBy) return null;
  if (state.status === 'done' || state.status === 'unprocessed') return null;
  if (Date.now() - new Date(state.claimedAt || 0).getTime() > CLAIM_STALE_MS) return null;
  return state.claimedBy;
}
// Returns null when userId may work the order, else the blocking holder's id
function claimBlocker(state, userId) {
  const holder = claimHolder(state);
  return holder && holder !== userId ? holder : null;
}
function refreshClaim(state, userId) {
  state.claimedBy = userId;
  state.claimedAt = new Date().toISOString();
}

// Barcode resolution data for OFFLINE scanning — the client caches this so a
// station that loses Wi-Fi can still resolve scans against order lines and
// count optimistically until the queue syncs.
app.get('/api/scan/resolve-cache', (req, res) => {
  res.json({
    code2:   _beTimeCode2Map,
    learned: Object.fromEntries(Object.entries(_learnedBarcodeMap).map(([k, v]) => [k, v.sku])),
    aliases: _learnedSkuAliases.map(al => ({ a: al.a, b: al.b })),
  });
});

app.post('/api/scan/claim', (req, res) => {
  const { orderNumber, force } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  const holder = claimBlocker(state, req.userId);
  if (holder && !force) {
    return res.status(409).json({
      error: `Order is being packed by ${holder} at another station.`,
      claimedBy: holder, claimedAt: state.claimedAt,
    });
  }
  if (holder && force) logAudit('order_takeover', { order: orderNumber, from: holder, by: req.userId || '' });
  refreshClaim(state, req.userId);
  batch.orderStates[orderNumber] = state;
  writeDb(db);
  res.json({ ok: true });
});

app.post('/api/scan/release', (req, res) => {
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  const state = (batch.orderStates || {})[orderNumber];
  if (state && state.claimedBy === req.userId) {
    delete state.claimedBy;
    delete state.claimedAt;
    writeDb(db);
  }
  res.json({ ok: true });
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
  const lines = uniqueSkuLines(ord);
  const findBySku = q => {
    const ql = q.trim().toLowerCase();
    const qn = stripLeadZeros(ql);
    return lines.find(l => {
      const ls = l.sku.trim().toLowerCase();
      return ls === ql || stripLeadZeros(ls) === qn;
    });
  };
  let item = findBySku(sku);
  // Betime scanning exception: an "NP" suffix on the product barcode is the
  // same product as the plain code — 8006NP scanned counts against line 8006
  // (and vice versa). Exact matches always win; the suffix only comes into
  // play when nothing matched as scanned.
  if (!item && /np$/i.test(sku.trim()))  item = findBySku(sku.trim().replace(/np$/i, ''));
  if (!item && !/np$/i.test(sku.trim())) item = findBySku(sku.trim() + 'NP');
  // Learned SKU aliases: the official listing sometimes names a product
  // differently from the client's order file (e.g. 9005 vs BC010). Aliases
  // are packer-taught pairs, tried only after every direct match fails.
  if (!item) {
    for (const al of _learnedSkuAliases) {
      if (al.a === sku) item = findBySku(al.b);
      else if (al.b === sku) item = findBySku(al.a);
      if (item) break;
    }
  }
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
  const holder = claimBlocker(state, req.userId);
  if (holder) return res.status(409).json({ error: `Order is being packed by ${holder} at another station.` });
  // Idempotent replay: offline-queued scans carry an eventId. If a scan
  // reached the server but the response was lost mid-Wi-Fi-drop, the replay
  // must NOT count the piece twice.
  const eventId = String(req.body.eventId || '').slice(0, 64);
  if (eventId) {
    if (!state.scanEventIds) state.scanEventIds = [];
    if (state.scanEventIds.includes(eventId)) {
      return res.json({ sku: item.sku, scanned_qty: state.scanned[item.sku] || 0, ordered_qty: item.qty, dedup: true });
    }
    state.scanEventIds.push(eventId);
    if (state.scanEventIds.length > 100) state.scanEventIds.splice(0, state.scanEventIds.length - 100);
  }
  refreshClaim(state, req.userId);
  state.status = 'processing';
  state.scanned[item.sku] = (state.scanned[item.sku] || 0) + 1;
  state.updated_at = new Date().toISOString();
  appendScanLog(state, { kind: 'scan', raw: String(req.body.sku || '').trim(), sku: item.sku, qty: state.scanned[item.sku], by: req.userId || '' });
  batch.orderStates[orderNumber] = state;
  journalOrderState(orderNumber, state);
  writeDb(db);
  res.json({ sku: item.sku, scanned_qty: state.scanned[item.sku], ordered_qty: item.qty });
});

// Teach-on-scan: packer confirms an unrecognized product barcode belongs to
// one of the order's lines. Stores the mapping (audit-logged, master-reviewable)
// and counts the piece in the same call so packing never stalls.
app.post('/api/scan/learn-barcode', (req, res) => {
  const { orderNumber, barcode, sku } = req.body;
  if (!orderNumber || !barcode || !sku) return res.status(400).json({ error: 'orderNumber, barcode and sku required' });
  const bc = String(barcode).trim();
  if (!isTeachableBarcode(bc)) return res.status(400).json({ error: 'That scan does not look like a product barcode.' });

  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  const ord  = batch.orders.find(o => o.order_number === orderNumber);
  const item = uniqueSkuLines(ord).find(l => l.sku === sku);
  if (!item) return res.status(404).json({ error: `SKU "${sku}" not in this order` });

  // Two teaching modes:
  //  - barcode unknown to the official listing → learn barcode → SKU
  //  - barcode officially maps to a DIFFERENT code than the order file uses
  //    (e.g. listing says 9005, order says BC010) → learn a SKU alias pair.
  //    The official listing itself is never modified.
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
      logAudit('sku_alias_learned', { official, orderSku: item.sku, barcode: bc, order: orderNumber, by: req.userId || '' });
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
    logAudit('barcode_learned', { barcode: bc, sku: item.sku, order: orderNumber, by: req.userId || '' });
    learnedKind = 'barcode';
  } else {
    learnedKind = 'none'; // official mapping already points at this line — just count
  }

  // Count the piece the packer is holding
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  const holder = claimBlocker(state, req.userId);
  if (holder) return res.status(409).json({ error: `Order is being packed by ${holder} at another station.` });
  refreshClaim(state, req.userId);
  state.status = 'processing';
  state.scanned[item.sku] = (state.scanned[item.sku] || 0) + 1;
  state.updated_at = new Date().toISOString();
  appendScanLog(state, { kind: 'teach', raw: bc, sku: item.sku, qty: state.scanned[item.sku], by: req.userId || '' });
  batch.orderStates[orderNumber] = state;
  journalOrderState(orderNumber, state);
  writeDb(db);
  res.json({ ok: true, sku: item.sku, scanned_qty: state.scanned[item.sku], ordered_qty: item.qty, barcode: bc, learned: learnedKind });
});

app.get('/api/master/learned-barcodes', (req, res) => {
  if (!checkMaster(req, res)) return;
  const db = readDb();
  const barcodes = Object.entries(db.learnedBarcodes || {}).map(([barcode, e]) => ({ barcode, ...e }));
  barcodes.sort((a, b) => new Date(b.learnedAt) - new Date(a.learnedAt));
  const aliases = [...(db.learnedSkuAliases || [])].sort((a, b) => new Date(b.learnedAt) - new Date(a.learnedAt));
  res.json({ barcodes, aliases });
});

// Export learned entries as XLSX — send this to the client (Betime) so their
// official listing gets corrected at the source; learned entries are meant to
// be a stop-gap, not a second source of truth.
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
  logAudit('sku_alias_removed', { a, b, by: req.userId || 'master' });
  res.json({ ok: true });
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
  logAudit('barcode_unlearned', { barcode: bc, sku: removed.sku, by: req.userId || 'master' });
  res.json({ ok: true });
});

app.post('/api/scan/setqty', (req, res) => {
  const { orderNumber, sku, qty } = req.body;
  if (!orderNumber || !sku) return res.status(400).json({ error: 'orderNumber and sku required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  const ord  = batch.orders.find(o => o.order_number === orderNumber);
  const item = uniqueSkuLines(ord).find(l => l.sku === sku);
  if (!item) return res.status(404).json({ error: `SKU "${sku}" not found` });
  // Sanity cap: a barcode "typed" into the qty field by a slow-bursting gun
  // arrives here as a gigantic number. No real count is ever this large.
  const qn = Math.max(0, parseInt(qty, 10) || 0);
  if (qn > 99999) {
    return res.status(400).json({
      error: `"${qty}" looks like a scanned barcode, not a quantity — nothing was counted. Scan the item again, or type the real count.`,
    });
  }
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  const holder = claimBlocker(state, req.userId);
  if (holder) return res.status(409).json({ error: `Order is being packed by ${holder} at another station.` });
  refreshClaim(state, req.userId);
  state.status = 'processing';
  state.scanned[item.sku] = qn;
  state.updated_at = new Date().toISOString();
  appendScanLog(state, { kind: 'count', raw: '', sku: item.sku, qty: state.scanned[item.sku], by: req.userId || '' });
  batch.orderStates[orderNumber] = state;
  journalOrderState(orderNumber, state);
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
  const mismatches = uniqueSkuLines(ord).map(item => {
    const s = state.scanned[item.sku] || 0;
    return s !== item.qty ? { sku: item.sku, description: item.description, ordered: item.qty, scanned: s, gap: s - item.qty } : null;
  }).filter(Boolean);

  const holder = claimBlocker(state, req.userId);
  if (holder) return res.status(409).json({ error: `Order is being packed by ${holder} at another station.` });
  if (!mismatches.length) {
    state.status     = 'done';
    delete state.claimedBy;
    delete state.claimedAt;
    state.updated_at = new Date().toISOString();
    if (startTime) state.startTime = startTime;
    if (endTime)   state.endTime   = endTime;
    if (operator)  state.operator  = operator;
    batch.orderStates[orderNumber] = state;
    journalOrderState(orderNumber, state);
    writeDb(db);
    logAudit('order_completed', completionAuditData(batch, ord, state));
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
  logAudit('order_cancelled', {
    order: orderNumber, batchId: batch.id, client: batch.client_name || '',
    operator: operator || '', mismatches: Array.isArray(mismatches) ? mismatches : [],
  });
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
// One active session per user. Sessions are persisted in the DB so they
// survive server restarts and Railway redeploys.
const activeSessions = new Map(); // userId → token

// Restore sessions from DB on startup
(function restoreSessions() {
  try {
    const db = readDb();
    for (const [userId, token] of Object.entries(db.sessions || {})) {
      activeSessions.set(userId, token);
    }
    console.log(`[IdealScan] Restored ${activeSessions.size} session(s) from DB`);
  } catch {}
})();

function persistSessions() {
  const db = readDb();
  db.sessions = Object.fromEntries(activeSessions);
  writeDb(db);
}

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

// Client info for the login audit trail
function clientInfo(req) {
  return {
    ip: String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(),
    device: String(req.headers['user-agent'] || '').slice(0, 160),
  };
}

app.post('/api/auth/login', (req, res) => {
  const { id, password } = req.body;
  if (!id || !password) return res.status(400).json({ error: 'User ID and password required' });
  // Case-insensitive ID match — "MASTER", "Master" and "master" are the same
  // account (passwords remain case-sensitive)
  const idNorm = String(id).trim().toLowerCase();
  const user = readUsers().find(u => String(u.id).trim().toLowerCase() === idNorm);
  if (!user || hashPass(password, user.salt) !== user.passwordHash) {
    logAudit('login_failed', { user: String(id).trim().slice(0, 60), ...clientInfo(req) });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = uuidv4();
  const kickedOther = activeSessions.has(user.id);
  activeSessions.set(user.id, token); // replaces any existing session for this user
  persistSessions();
  logAudit('login', { user: user.id, replacedSession: kickedOther, ...clientInfo(req) });
  res.json({ id: user.id, name: user.name || user.id, role: user.role || 'admin', token });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) {
    for (const [userId, t] of activeSessions) {
      if (t === token) {
        activeSessions.delete(userId);
        logAudit('logout', { user: userId, ...clientInfo(req) });
        break;
      }
    }
    persistSessions();
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
    tablePrefs:  user.tablePrefs  || null,
  });
});

// Per-user orders-table layout: column widths (px) and hidden columns
app.put('/api/profile/table-prefs', requireAuth, (req, res) => {
  const users = readUsers();
  const idx   = users.findIndex(u => u.id === req.userId);
  if (idx < 0) return res.status(404).json({ error: 'User not found' });
  const { widths, hidden } = req.body || {};
  const clean = { widths: {}, hidden: [] };
  if (widths && typeof widths === 'object') {
    for (const [k, v] of Object.entries(widths)) {
      const px = Math.round(Number(v));
      if (/^[a-z_]{2,20}$/.test(k) && px >= 40 && px <= 800) clean.widths[k] = px;
    }
  }
  if (Array.isArray(hidden)) {
    clean.hidden = hidden.filter(h => /^[a-z_]{2,20}$/.test(h)).slice(0, 12);
  }
  users[idx].tablePrefs = clean;
  writeUsers(users);
  res.json({ ok: true, tablePrefs: clean });
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
  res.setHeader('Content-Disposition', `attachment; filename="IDEALONE_Status_${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.end(buf);
});

// ── Live activity — Master dashboard ────────────────────────────────────────
// Aggregates the same orderStates data every scan endpoint already writes
// into a monitoring view: who is actively packing right now, which claimed
// orders went idle without being released (packer walked away / station
// died — the CLAIM_STALE_MS window already governs when this fires elsewhere),
// and recent scan throughput. Nothing new is persisted; this is a read-only
// projection recomputed on each request.
const LIVE_IDLE_WARN_MS = 5 * 60 * 1000; // flag an active packer as "idle" after 5 min with no scan

app.get('/api/master/live-activity', (req, res) => {
  if (!checkMaster(req, res)) return;
  const db      = readDb();
  const now     = Date.now();
  const nameFor = (() => {
    const byId = new Map(readUsers().map(u => [u.id, u.name || u.id]));
    return id => byId.get(id) || id || '(unknown)';
  })();

  const activePackers = [];
  const stuckOrders   = [];
  let scans5m = 0, scans15m = 0, scans1h = 0;

  for (const batch of db.batches || []) {
    const states = batch.orderStates || {};
    for (const ord of (batch.orders || [])) {
      const state = states[ord.order_number];
      if (!state) continue;
      const settled = state.status === 'done' || state.status === 'unprocessed';
      const scannedQty = Object.values(state.scanned || {}).reduce((s, v) => s + v, 0);
      const log = state.scanLog || [];
      const lastEvt = log.length ? log[log.length - 1] : null;

      for (let i = log.length - 1; i >= 0; i--) {
        const evt = log[i];
        if (evt.kind !== 'scan' && evt.kind !== 'teach' && evt.kind !== 'count') continue;
        const age = now - new Date(evt.at).getTime();
        if (age > 3600000) break; // scanLog is chronological — nothing older matters
        if (age <= 300000)  scans5m++;
        if (age <= 900000)  scans15m++;
        if (age <= 3600000) scans1h++;
      }

      const holder = claimHolder(state); // non-stale claim, per existing claiming logic
      if (holder && !settled) {
        const lastActivityAt = lastEvt ? new Date(lastEvt.at).getTime() : new Date(state.claimedAt || 0).getTime();
        activePackers.push({
          userId:        holder,
          userName:      nameFor(holder),
          orderNumber:   ord.order_number,
          client:        batch.client_name || '',
          scannedQty,
          totalQty:      ord.total_qty || 0,
          claimedAt:     state.claimedAt || null,
          idleMs:        now - lastActivityAt,
          idle:          (now - lastActivityAt) > LIVE_IDLE_WARN_MS,
        });
      } else if (state.claimedBy && !holder && !settled) {
        // Was claimed, claim is now stale (CLAIM_STALE_MS elapsed) — abandoned mid-pick
        stuckOrders.push({
          orderNumber:   ord.order_number,
          client:        batch.client_name || '',
          lastPacker:    state.claimedBy,
          lastPackerName: nameFor(state.claimedBy),
          scannedQty,
          totalQty:      ord.total_qty || 0,
          claimedAt:     state.claimedAt || null,
          idleMinutes:   Math.round((now - new Date(state.claimedAt || 0).getTime()) / 60000),
        });
      }
    }
  }

  activePackers.sort((a, b) => b.idleMs - a.idleMs);
  stuckOrders.sort((a, b) => b.idleMinutes - a.idleMinutes);

  res.json({
    generatedAt:   new Date().toISOString(),
    activePackers,
    stuckOrders,
    throughput:    { last5m: scans5m, last15m: scans15m, lastHour: scans1h },
  });
});

// Full JSON backup — DB (batches, orders, scan states, users, sessions) plus
// the small config files. WMS XLSX / waybill PDF binaries are excluded: they
// are regenerable from the batch data and would bloat the download.
function buildBackupObject() {
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  return {
    kind:       'idealscan-backup',
    version:    1,
    created_at: new Date().toISOString(),
    db:         readDb(),
    config: {
      keyfields_template: readJson(KEYFIELDS_TEMPLATE_FILE),
      label_templates:    readJson(LABEL_TEMPLATES_FILE),
      sku_descriptions:   readJson(SKU_DESC_FILE),
      email:              readJson(EMAIL_CONFIG_FILE),
    },
  };
}

app.get('/api/master/backup', (req, res) => {
  if (!checkMaster(req, res)) return;
  try {
    const name = `idealscan-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(JSON.stringify(buildBackupObject()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Nightly automatic backup ─────────────────────────────────────────────────
// Every night (after 02:00 Singapore time) the full backup is gzipped to the
// volume (last 14 kept) and emailed to the configured recipient. The manual
// Download Backup button remains; this just removes the "remembering" part.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
function sgDateStr(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); // YYYY-MM-DD
}
function sgHour(d = new Date()) {
  return parseInt(d.toLocaleString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', hour12: false }), 10);
}
async function runNightlyBackup(reason) {
  const day  = sgDateStr();
  const file = path.join(BACKUP_DIR, `idealscan-backup-${day}.json.gz`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(buildBackupObject())));
  fs.writeFileSync(file, gz);
  // prune: keep the newest 14
  const old = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('idealscan-backup-')).sort().slice(0, -14);
  for (const f of old) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {} }
  console.log(`[IdealScan] Nightly backup written (${reason}): ${file} (${(gz.length / 1024).toFixed(0)} KB)`);

  try {
    const transporter = buildTransporter();
    const to = getDefaultRecipient();
    if (transporter && to) {
      await transporter.sendMail({
        from: getFromEmail(), to,
        subject: `IDEALONE nightly backup — ${day}`,
        text: `Automatic nightly backup attached.\n\nRestore: Administrator → System → Download Backup holds the same format; keep this file safe.\nGenerated ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Singapore' })} SGT.`,
        attachments: [{ filename: `idealscan-backup-${day}.json.gz`, content: gz }],
      });
      console.log(`[IdealScan] Nightly backup emailed to ${to}`);
    } else {
      console.log('[IdealScan] Nightly backup email skipped — email not configured');
    }
  } catch (e) {
    console.error('[IdealScan] Nightly backup email FAILED:', e.message);
  }
}
function nightlyBackupDue() {
  const day = sgDateStr();
  if (sgHour() < 2) return false; // wait for the quiet window after 2am SGT
  try { return !fs.existsSync(path.join(BACKUP_DIR, `idealscan-backup-${day}.json.gz`)); }
  catch { return true; }
}
setInterval(() => {
  if (nightlyBackupDue()) runNightlyBackup('scheduled').catch(e => console.error('[IdealScan] nightly backup failed:', e.message));
}, 30 * 60 * 1000);
// also check shortly after boot — covers redeploys that skip the 2am window
setTimeout(() => {
  if (nightlyBackupDue()) runNightlyBackup('startup catch-up').catch(e => console.error('[IdealScan] nightly backup failed:', e.message));
}, 2 * 60 * 1000);

app.post('/api/master/reset', (req, res) => {
  if (!checkMaster(req, res)) return;
  try {
    // Keep users — the UI promises "Users and email settings are preserved",
    // but users live inside db.json now, so a bare reset would wipe them.
    // The audit ledger ALSO survives reset (deletion-proof reports) and the
    // reset itself is recorded.
    const prev = readDb();
    writeDb({
      batches: [],
      users: prev.users || [],
      noBarcodeSkus: prev.noBarcodeSkus || {},
      auditBackfilled: true,
      auditLog: [
        ...(prev.auditLog || []),
        { type: 'master_reset', at: new Date().toISOString(), by: req.userId || 'master', batchesDeleted: (prev.batches || []).length },
      ],
    });
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

// ── Standard reports — built from the audit ledger, deletion-proof ──────────
// GET /api/master/report/:kind?from=YYYY-MM-DD&to=YYYY-MM-DD  (manifest: ?date=)
//
// Access split:
//   • Operational reports → any ADMIN login (daily-summary, productivity,
//     carrier-manifest, aging, lot-traceability). Warehouse role: none.
//   • Commercial/oversight reports → MASTER key only (client-activity =
//     billing data; exceptions = includes the deletion audit that watches
//     the admins themselves).
const ADMIN_REPORT_KINDS = new Set(['daily-summary', 'productivity', 'carrier-manifest', 'aging', 'lot-traceability']);

app.get('/api/master/report/:kind', (req, res) => {
  const { kind } = req.params;
  const isMaster = req.headers['x-master-key'] === MASTER_PASS;
  if (!isMaster) {
    const role = readUsers().find(u => u.id === req.userId)?.role || 'warehouse';
    if (role !== 'admin' || !ADMIN_REPORT_KINDS.has(kind)) {
      return res.status(403).json({ error: 'This report requires Administrator access' });
    }
  }
  try {
    const db  = readDb();
    const log = db.auditLog || [];

    const today = new Date().toISOString().slice(0, 10);
    const from  = (req.query.from || '').slice(0, 10) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to    = (req.query.to   || '').slice(0, 10) || today;
    const day   = at => String(at || '').slice(0, 10);
    const inRange = ev => day(ev.at) >= from && day(ev.at) <= to;
    const mins  = ev => (ev.startTime && ev.endTime) ? Math.round((new Date(ev.endTime) - new Date(ev.startTime)) / 6000) / 10 : null;
    const avg   = a => a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length * 10) / 10 : '';
    const hhmm  = at => at ? new Date(at).toLocaleTimeString('en-SG', { hour12: false }) : '';

    const uploads   = log.filter(e => e.type === 'upload' && inRange(e));
    const completed = log.filter(e => e.type === 'order_completed' && inRange(e));
    const cancelled = log.filter(e => e.type === 'order_cancelled' && inRange(e));
    const deletions = log.filter(e => ['batch_deleted', 'order_deleted', 'master_reset'].includes(e.type) && inRange(e));

    const wb = XLSX.utils.book_new();
    const addSheet = (name, aoa) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
    let title = kind;

    if (kind === 'daily-summary') {
      title = 'Daily_Operations_Summary';
      const days = {};
      const D = d => days[d] ||= { batches: 0, ordUp: 0, lines: 0, done: 0, pieces: 0, durs: [] };
      for (const e of uploads)   { const x = D(day(e.at)); x.batches++; x.ordUp += e.orders || 0; x.lines += e.lines || 0; }
      for (const e of completed) { const x = D(day(e.at)); x.done++; x.pieces += e.pieces || 0; const m = mins(e); if (m !== null) x.durs.push(m); }
      addSheet('Daily', [
        ['Date', 'Batches Uploaded', 'Orders Uploaded', 'Lines Uploaded', 'Orders Completed', 'Pieces Scanned', 'Avg Mins / Order'],
        ...Object.keys(days).sort().map(d => { const x = days[d]; return [d, x.batches, x.ordUp, x.lines, x.done, x.pieces, avg(x.durs)]; }),
      ]);
      const dc = {};
      for (const e of completed) { const k = day(e.at) + '|' + (e.client || '—'); dc[k] ||= { done: 0, pieces: 0 }; dc[k].done++; dc[k].pieces += e.pieces || 0; }
      addSheet('By Client', [
        ['Date', 'Client', 'Orders Completed', 'Pieces Scanned'],
        ...Object.keys(dc).sort().map(k => { const [d, c] = k.split('|'); return [d, c, dc[k].done, dc[k].pieces]; }),
      ]);

    } else if (kind === 'productivity') {
      title = 'Packer_Productivity';
      const g = {};
      for (const e of completed) {
        const k = day(e.at) + '|' + (e.operator || '—');
        g[k] ||= { done: 0, pieces: 0, durs: [] };
        g[k].done++; g[k].pieces += e.pieces || 0;
        const m = mins(e); if (m !== null) g[k].durs.push(m);
      }
      addSheet('Productivity', [
        ['Date', 'Operator', 'Orders Completed', 'Pieces Scanned', 'Avg Mins / Order', 'Fastest (mins)', 'Slowest (mins)'],
        ...Object.keys(g).sort().map(k => {
          const [d, op] = k.split('|'); const x = g[k];
          return [d, op, x.done, x.pieces, avg(x.durs), x.durs.length ? Math.min(...x.durs) : '', x.durs.length ? Math.max(...x.durs) : ''];
        }),
      ]);

    } else if (kind === 'client-activity') {
      title = 'Client_Activity';
      const g = {};
      const G = c => g[c || '—'] ||= { batches: 0, ordUp: 0, lines: 0, done: 0, pieces: 0 };
      for (const e of uploads)   { const x = G(e.client); x.batches++; x.ordUp += e.orders || 0; x.lines += e.lines || 0; }
      for (const e of completed) { const x = G(e.client); x.done++; x.pieces += e.pieces || 0; }
      addSheet('Client Activity', [
        [`Period: ${from} to ${to}`],
        ['Client', 'Batches Uploaded', 'Orders Uploaded', 'Lines Uploaded', 'Orders Completed', 'Pieces Scanned'],
        ...Object.keys(g).sort().map(c => { const x = g[c]; return [c, x.batches, x.ordUp, x.lines, x.done, x.pieces]; }),
      ]);

    } else if (kind === 'exceptions') {
      title = 'Exceptions_Discrepancies';
      const rows = [];
      for (const e of cancelled) {
        if ((e.mismatches || []).length) {
          for (const m of e.mismatches) rows.push([e.at, 'Cancelled - mismatch', e.order, e.client, e.operator, m.sku, m.ordered, m.scanned, m.gap, '']);
        } else {
          rows.push([e.at, 'Cancelled', e.order, e.client, e.operator, '', '', '', '', '']);
        }
      }
      for (const e of deletions) {
        if (e.type === 'batch_deleted') rows.push([e.at, 'BATCH DELETED', '', e.client, e.by, '', '', '', '', `${e.filename} (${e.orders} orders): ${(e.orderNumbers || []).slice(0, 20).join(', ')}${(e.orderNumbers || []).length > 20 ? '…' : ''}`]);
        else if (e.type === 'order_deleted') rows.push([e.at, 'ORDER DELETED', e.order, e.client, e.by, '', '', '', '', e.reason || '']);
        else rows.push([e.at, 'MASTER RESET', '', '', e.by, '', '', '', '', `${e.batchesDeleted} batches wiped`]);
      }
      rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      addSheet('Exceptions', [
        ['Date/Time', 'Type', 'Order', 'Client', 'Operator/By', 'SKU', 'Ordered', 'Scanned', 'Gap', 'Note'],
        ...rows,
      ]);

    } else if (kind === 'carrier-manifest') {
      title = 'Carrier_Manifest';
      const date = (req.query.date || today).slice(0, 10);
      const evs  = log.filter(e => e.type === 'order_completed' && day(e.at) === date)
                      .sort((a, b) => (a.carrier || '').localeCompare(b.carrier || '') || String(a.at).localeCompare(String(b.at)));
      addSheet('Manifest', [
        [`Carrier Handover Manifest — ${date}`],
        ['Carrier', 'Order No', 'Waybill', 'Customer', 'Pieces', 'Completed At', 'Packed By', 'Received By (sign)'],
        ...evs.map(e => [e.carrier || '—', e.order, e.waybill || '', e.customer || '', e.pieces || '', hhmm(e.endTime || e.at), e.operator || '', '']),
      ]);

    } else if (kind === 'aging') {
      title = 'Order_Aging_Backlog';
      const rows = [];
      for (const b of db.batches || []) {
        const states = b.orderStates || {};
        for (const o of b.orders || []) {
          const st = states[o.order_number] || { status: 'pending' };
          if (st.status === 'done') continue;
          const daysOld = Math.floor((Date.now() - new Date(b.uploaded_at)) / 86400000);
          rows.push([o.order_number, b.client_name || '', o.carrier || '', st.status || 'pending', day(b.uploaded_at), daysOld, (o.lines || []).length, (o.lines || []).reduce((s, l) => s + (l.qty || 0), 0)]);
        }
      }
      rows.sort((a, b) => b[5] - a[5]);
      addSheet('Aging', [
        ['Order No', 'Client', 'Carrier', 'Status', 'Uploaded', 'Days Pending', 'Lines', 'Pieces Ordered'],
        ...rows,
      ]);

    } else if (kind === 'login-audit') {
      title = 'User_Login_Audit';
      const evs = log.filter(e => ['login', 'login_failed', 'logout'].includes(e.type) && inRange(e));
      const label = { login: 'Login', login_failed: 'FAILED LOGIN', logout: 'Logout' };
      addSheet('Login Audit', [
        ['Date/Time', 'User', 'Event', 'IP Address', 'Device', 'Note'],
        ...evs.map(e => [e.at, e.user || '—', label[e.type], e.ip || '', e.device || '',
                         e.replacedSession ? 'Signed in elsewhere — previous session ended' : '']),
      ]);
      // Per-user summary: first/last activity and counts
      const byUser = {};
      for (const e of evs) {
        const u = byUser[e.user || '—'] ||= { logins: 0, failed: 0, logouts: 0, first: e.at, last: e.at };
        if (e.type === 'login') u.logins++; else if (e.type === 'login_failed') u.failed++; else u.logouts++;
        if (e.at < u.first) u.first = e.at;
        if (e.at > u.last)  u.last  = e.at;
      }
      addSheet('Per User', [
        ['User', 'Logins', 'Failed Attempts', 'Logouts', 'First Activity', 'Last Activity'],
        ...Object.keys(byUser).sort().map(u => { const x = byUser[u]; return [u, x.logins, x.failed, x.logouts, x.first, x.last]; }),
      ]);

    } else if (kind === 'lot-traceability') {
      title = 'Lot_Expiry_Traceability';
      const rows = [];
      for (const e of completed) {
        for (const l of e.lines || []) {
          if (!l.lot && !l.expiry) continue;
          rows.push([day(e.at), e.order, e.client, l.sku, l.description, l.lot, l.expiry, l.scanned ?? l.qty, e.operator, e.waybill || '']);
        }
      }
      addSheet('Traceability', [
        ['Date', 'Order No', 'Client', 'SKU', 'Description', 'Lot / Batch', 'Expiry', 'Qty Shipped', 'Packed By', 'Waybill'],
        ...rows,
      ]);

    } else {
      return res.status(400).json({ error: `Unknown report kind: ${kind}` });
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${title}_${from}_to_${to}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('[report]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/master/batch/:batchId', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { batchId } = req.params;
  try {
    const db  = readDb();
    const idx = db.batches.findIndex(b => b.id === batchId);
    if (idx === -1) return res.status(404).json({ error: 'Batch not found' });
    const victim = db.batches[idx];
    db.batches.splice(idx, 1);
    writeDb(db);
    logAudit('batch_deleted', {
      batchId, filename: victim.filename || '', client: victim.client_name || '',
      orders: (victim.orders || []).length, by: req.userId || 'master',
      orderNumbers: (victim.orders || []).map(o => o.order_number).slice(0, 500),
    });
    try { fs.unlinkSync(path.join(WMS_DIR, `${batchId}.xlsx`)); } catch {}
    try { fs.rmSync(path.join(WAYBILL_DIR, batchId), { recursive: true, force: true }); } catch {}
    invalidateWaybillCache(batchId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/master/order/:batchId/:orderNumber', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { batchId, orderNumber } = req.params;
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to delete an order.' });
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
    logAudit('order_deleted', { order: orderNumber, batchId, client: batch.client_name || '', by: req.userId || 'master', reason });
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
    invalidateCustomHeadersCache();
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
  invalidateCustomHeadersCache();
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
      subject: 'IDEALONE — Email Test',
      text: `This is a test email from IDEALONE.\n\nFrom: ${fromEmail}\nSent: ${new Date().toLocaleString()}`,
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
      <p>${ok ? 'You can close this tab and return to IDEALONE.' : 'Please close this tab and try again.'}</p>
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
      return res.send(closeScript(false, 'No refresh token — revoke IDEALONE in Google Account → Security → Third-party access, then try again'));

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
      subject: 'IDEALONE — Email Test',
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
    // Volume copy is authoritative (survives redeploys); app-dir copy is
    // best-effort for consistency within this deploy
    fs.writeFileSync(BETIME_CODE2_VOLUME_FILE, JSON.stringify(map, null, 2));
    try { fs.writeFileSync(BETIME_CODE2_FILE, JSON.stringify(map, null, 2)); } catch {}
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
  const batch = db.batches.find(b => b.id === batchId) || readArchivedBatch(batchId);
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
    ['IDEALONE Completion Slip'],
    [],
    ['IdealScan Job', batch.idealscan_code || '—'],
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
    ...uniqueSkuLines(ord).map(l => {
      const s  = (state.scanned || {})[l.sku] || 0;
      const ok = s === l.qty;
      return [l.sku, l.description || '', l.qty, s, ok ? 'OK' : s > l.qty ? 'Over-scanned' : 'Short'];
    }),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true }), 'Completion Slip');

  // Sheet 2 — the full scan history: every gun scan, manual count, and
  // taught barcode, in the order they happened
  const KIND_LABEL = { scan: 'Gun scan', count: 'Manual count', teach: 'Taught barcode' };
  const logAoa = [
    ['Time', 'Action', 'Scanned Code', 'SKU', 'Count After', 'By'],
    ...((state.scanLog || []).map(e => [
      new Date(e.at).toLocaleString(), KIND_LABEL[e.kind] || e.kind, e.raw || '', e.sku, e.qty, e.by || '',
    ])),
  ];
  if (logAoa.length === 1) logAoa.push(['(no scan events recorded — order predates scan logging)', '', '', '', '', '']);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(logAoa), 'Scan Log');
  const buf  = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const date = (endTime || new Date()).toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Slip_${orderNumber}_${date}.xlsx"`);
  res.end(buf);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fulfillment Scanner on port ${PORT}`));
