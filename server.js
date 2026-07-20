// Load environment variables from .env file
require('dotenv').config();

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
const mysql      = require('mysql2/promise');
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

// Wave picking — portable core module (see lib/wave-pick.js header)
const wavePick = require('./lib/wave-pick.js');
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

// ── MySQL TMS Database (IDEALTMS: Route Planning, Drivers, Vehicles) ────────
let mysqlPool = null;
async function initMysqlPool() {
  try {
    const mysqlHost = process.env.MYSQLHOST || 'reseau.proxy.rlwy.net';
    const mysqlPort = process.env.MYSQLPORT || 54260;
    const mysqlUser = process.env.MYSQLUSER || 'root';
    const mysqlPassword = process.env.MYSQLPASSWORD || '';
    const mysqlDb = process.env.MYSQL_DATABASE || 'railway';

    mysqlPool = mysql.createPool({
      host: mysqlHost,
      port: mysqlPort,
      user: mysqlUser,
      password: mysqlPassword,
      database: mysqlDb,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectionTimeout: 5000,
      enableKeepAlive: true,
    });

    // Test connection with timeout
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout after 5s')), 5000)
    );

    const connPromise = mysqlPool.getConnection();
    const conn = await Promise.race([connPromise, timeoutPromise]);
    console.log('[MySQL] TMS database connected');
    conn.release();

    // Initialize tables
    await initTmsTables();
    return true;
  } catch (err) {
    console.warn('[MySQL] Connection unavailable (TMS features disabled):', err.message);
    mysqlPool = null;
    return false;
  }
}

// Helper to safely query MySQL
async function queryMysql(sql, params = []) {
  if (!mysqlPool) return null;
  try {
    const [rows] = await mysqlPool.execute(sql, params);
    return rows;
  } catch (err) {
    console.error('[MySQL] Query error:', err.message);
    return null;
  }
}

// ── Geocoding: Convert postal codes/addresses → lat/lng ───────────────────
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

async function geocodePostalCode(postalCode) {
  if (!postalCode) return null;

  const normalizedCode = postalCode.toString().trim().toUpperCase();

  // Check cache first
  const cached = await queryMysql(
    'SELECT latitude, longitude, address FROM geocoding_cache WHERE postal_code = ?',
    [normalizedCode]
  );

  if (cached && cached.length > 0) {
    const c = cached[0];
    return { lat: parseFloat(c.latitude), lng: parseFloat(c.longitude), address: c.address };
  }

  // If no API key, return null (will be filled in later)
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn(`[Geocoding] No API key; cache miss for ${normalizedCode}`);
    return null;
  }

  // Query Google Maps API
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(normalizedCode)}+Singapore&key=${GOOGLE_MAPS_API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.results && data.results.length > 0) {
      const result = data.results[0];
      const { lat, lng } = result.geometry.location;
      const address = result.formatted_address;

      // Cache the result
      await queryMysql(
        'INSERT INTO geocoding_cache (postal_code, latitude, longitude, address) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE accessed_at = NOW()',
        [normalizedCode, lat, lng, address]
      );

      return { lat, lng, address };
    }
  } catch (err) {
    console.error('[Geocoding] Error:', err.message);
  }

  return null;
}

// Batch geocode multiple postal codes
async function geocodeMultiple(postalCodes) {
  const results = {};
  for (const code of postalCodes) {
    results[code] = await geocodePostalCode(code);
  }
  return results;
}

// ── Route Optimization: Cluster jobs by location & optimize sequence ───────

// Haversine distance (km) between two lat/lng points
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Nearest neighbor TSP solver (quick heuristic for small route optimization)
function optimizeRouteSequence(stops) {
  if (!stops || stops.length <= 1) return stops;

  const result = [];
  const remaining = [...stops];
  let current = remaining.shift();
  result.push(current);

  while (remaining.length > 0) {
    let nearest = remaining[0];
    let minDist = haversineDistance(current.lat, current.lng, nearest.lat, nearest.lng);

    for (let i = 1; i < remaining.length; i++) {
      const dist = haversineDistance(current.lat, current.lng, remaining[i].lat, remaining[i].lng);
      if (dist < minDist) {
        minDist = dist;
        nearest = remaining[i];
      }
    }

    result.push(nearest);
    current = nearest;
    remaining.splice(remaining.indexOf(nearest), 1);
  }

  return result;
}

// Plan routes: cluster jobs by zone, optimize sequence within each
async function planRoutes(jobs, drivers, date) {
  if (!jobs || !drivers || jobs.length === 0) {
    return { routes: [], unassigned: jobs || [] };
  }

  // Geocode all jobs
  const postalCodes = [...new Set(jobs.map(j => j.postal_code || j.zip).filter(Boolean))];
  const geocoded = await geocodeMultiple(postalCodes);

  // Enrich jobs with geocoded data
  const enrichedJobs = jobs.map(j => ({
    ...j,
    postal_code: j.postal_code || j.zip,
    geo: geocoded[j.postal_code || j.zip] || { lat: 0, lng: 0 }
  })).filter(j => j.geo.lat && j.geo.lng);

  // Cluster jobs by postal code / proximity
  const clusters = {};
  for (const job of enrichedJobs) {
    const key = job.postal_code;
    if (!clusters[key]) clusters[key] = [];
    clusters[key].push(job);
  }

  // Assign clusters to drivers & optimize sequences
  const routes = [];
  const availableDrivers = [...drivers].filter(d => d.status === 'active');
  let driverIndex = 0;

  for (const [postalCode, clusterJobs] of Object.entries(clusters)) {
    if (availableDrivers.length === 0) break;

    const driver = availableDrivers[driverIndex % availableDrivers.length];
    driverIndex++;

    // Optimize job sequence within cluster
    const optimized = optimizeRouteSequence(clusterJobs);

    // Calculate metrics
    let totalDistance = 0;
    for (let i = 1; i < optimized.length; i++) {
      totalDistance += haversineDistance(
        optimized[i - 1].geo.lat, optimized[i - 1].geo.lng,
        optimized[i].geo.lat, optimized[i].geo.lng
      );
    }

    const estimatedDuration = Math.ceil(totalDistance / 30 * 60 + optimized.length * 10); // 30 km/h + 10 min per stop

    const route = {
      id: 'ROUTE-' + uuidv4().slice(0, 8).toUpperCase(),
      driver_id: driver.id,
      planned_date: date,
      zone: postalCode,
      stops: optimized.map((job, idx) => ({
        sequence: idx + 1,
        job_id: job.order_number,
        postal_code: job.postal_code,
        customer_name: job.customer_name,
        address: job.address,
        latitude: job.geo.lat,
        longitude: job.geo.lng,
        status: 'pending'
      })),
      total_distance_km: Math.round(totalDistance * 100) / 100,
      estimated_duration_minutes: estimatedDuration,
      status: 'planned'
    };

    routes.push(route);
  }

  const assignedJobs = enrichedJobs.filter(j => routes.some(r => r.stops.some(s => s.job_id === j.order_number)));
  const unassigned = enrichedJobs.filter(j => !assignedJobs.includes(j));

  return { routes, unassigned };
}

// ── Route Report Generation (PDF & Dashboard) ────────────────────────────

// Generate route report as XLSX workbook
async function generateRouteReportXlsx(routeId) {
  const route = await queryMysql('SELECT r.*, d.name as driver_name, d.phone as driver_phone FROM routes r LEFT JOIN drivers d ON r.driver_id = d.id WHERE r.id = ?', [routeId]);
  if (!route || route.length === 0) return null;

  const r = route[0];
  const stops = await queryMysql('SELECT * FROM route_stops WHERE route_id = ? ORDER BY sequence', [routeId]);

  const wb = XLSX.utils.book_new();

  // Route summary sheet
  const summaryData = [
    ['Route', r.id],
    ['Driver', r.driver_name || '—'],
    ['Phone', r.driver_phone || '—'],
    ['Date', r.planned_date],
    ['Zone', r.zone || '—'],
    ['Status', r.status || 'planned'],
    ['Total Distance', (r.total_distance_km || 0) + ' km'],
    ['Estimated Duration', (r.estimated_duration_minutes || 0) + ' min'],
    ['Total Stops', (stops && stops.length) || 0],
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Route Summary');

  // Stops sheet
  if (stops && stops.length > 0) {
    const stopsData = [
      ['Stop #', 'Order', 'Customer', 'Postal Code', 'Address', 'Status', 'Completed At'],
      ...stops.map(s => [
        s.sequence,
        s.job_id || '—',
        s.customer_name || '—',
        s.postal_code || '—',
        s.address || '—',
        s.status || 'pending',
        s.completed_at ? new Date(s.completed_at).toLocaleString() : '—'
      ])
    ];
    const stopsSheet = XLSX.utils.aoa_to_sheet(stopsData);
    // Auto-fit columns
    stopsSheet['!cols'] = [
      { wch: 8 },   // Stop #
      { wch: 12 },  // Order
      { wch: 20 },  // Customer
      { wch: 12 },  // Postal Code
      { wch: 25 },  // Address
      { wch: 10 },  // Status
      { wch: 20 }   // Completed At
    ];
    XLSX.utils.book_append_sheet(wb, stopsSheet, 'Stops');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Get route analytics/metrics
async function getRouteMetrics(dateFrom, dateTo) {
  const sql = `
    SELECT
      COUNT(DISTINCT r.id) as total_routes,
      COUNT(DISTINCT r.driver_id) as total_drivers,
      SUM(r.total_distance_km) as total_distance_km,
      AVG(r.total_distance_km) as avg_distance_km,
      SUM(r.total_stops) as total_stops,
      AVG(r.total_stops) as avg_stops_per_route,
      SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) as completed_routes
    FROM routes r
    WHERE r.planned_date BETWEEN ? AND ?
  `;

  const metrics = await queryMysql(sql, [dateFrom, dateTo]);
  return metrics && metrics.length > 0 ? metrics[0] : null;
}

// Get driver performance stats
async function getDriverPerformance(dateFrom, dateTo) {
  const sql = `
    SELECT
      d.id,
      d.name,
      COUNT(DISTINCT r.id) as routes_assigned,
      SUM(r.total_distance_km) as total_distance_km,
      SUM(r.total_stops) as total_stops,
      SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) as completed_routes,
      COUNT(CASE WHEN rs.status = 'completed' THEN 1 END) as completed_stops
    FROM drivers d
    LEFT JOIN routes r ON d.id = r.driver_id AND r.planned_date BETWEEN ? AND ?
    LEFT JOIN route_stops rs ON r.id = rs.route_id AND rs.status = 'completed'
    WHERE d.status = 'active'
    GROUP BY d.id
    ORDER BY completed_routes DESC
  `;

  return await queryMysql(sql, [dateFrom, dateTo]);
}

// Initialize TMS tables (called once on startup)
async function initTmsTables() {
  if (!mysqlPool) return;
  try {
    const conn = await mysqlPool.getConnection();

    // Drivers table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS drivers (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        email VARCHAR(255),
        vehicle_type VARCHAR(100),
        capacity_kg DECIMAL(10, 2),
        capacity_volume DECIMAL(10, 2),
        shift_start TIME,
        shift_end TIME,
        home_depot_location VARCHAR(255),
        zone_id VARCHAR(36),
        status ENUM('active', 'inactive', 'on_leave') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (status), INDEX (zone_id)
      )
    `);

    // Zones table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS zones (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        postal_codes JSON,
        assigned_days JSON,
        delivery_window_start TIME,
        delivery_window_end TIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE (name)
      )
    `);

    // Zone assignments (driver → zone → day mapping)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS zone_assignments (
        id VARCHAR(36) PRIMARY KEY,
        driver_id VARCHAR(36) NOT NULL,
        zone_id VARCHAR(36) NOT NULL,
        day_of_week INT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES drivers(id),
        FOREIGN KEY (zone_id) REFERENCES zones(id),
        INDEX (driver_id), INDEX (zone_id), INDEX (day_of_week)
      )
    `);

    // Routes table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS routes (
        id VARCHAR(36) PRIMARY KEY,
        driver_id VARCHAR(36) NOT NULL,
        planned_date DATE,
        zone_id VARCHAR(36),
        total_stops INT DEFAULT 0,
        total_distance_km DECIMAL(10, 2),
        estimated_duration_minutes INT,
        status ENUM('planned', 'in_transit', 'completed', 'cancelled') DEFAULT 'planned',
        optimized_sequence JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES drivers(id),
        FOREIGN KEY (zone_id) REFERENCES zones(id),
        INDEX (driver_id), INDEX (planned_date), INDEX (status)
      )
    `);

    // Route stops (individual deliveries in a route)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS route_stops (
        id VARCHAR(36) PRIMARY KEY,
        route_id VARCHAR(36) NOT NULL,
        job_id VARCHAR(36),
        sequence INT,
        postal_code VARCHAR(20),
        customer_name VARCHAR(255),
        address VARCHAR(500),
        latitude DECIMAL(10, 8),
        longitude DECIMAL(11, 8),
        delivery_window_start TIME,
        delivery_window_end TIME,
        estimated_arrival_time DATETIME,
        actual_arrival_time DATETIME,
        completed_at DATETIME,
        status ENUM('pending', 'arrived', 'completed', 'failed') DEFAULT 'pending',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (route_id) REFERENCES routes(id),
        INDEX (route_id), INDEX (job_id), INDEX (postal_code)
      )
    `);

    // Geocoding cache (postal_code → lat/lng)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS geocoding_cache (
        postal_code VARCHAR(20) PRIMARY KEY,
        latitude DECIMAL(10, 8),
        longitude DECIMAL(11, 8),
        address VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    conn.release();
    console.log('[MySQL] TMS tables initialized');
  } catch (err) {
    console.error('[MySQL] Schema initialization error:', err.message);
  }
}

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
// Public marketing/waitlist landing page — deliberately outside the auth
// gate (which only guards /api/*) so it's reachable by anyone, logged in or not.
app.get('/home', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/vendor/jsbarcode.min.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/jsbarcode/dist/JsBarcode.all.min.js'))
);
// QR generator — substitute codes for long SKUs are QR (a 26-char SKU as
// Code128 is too dense to scan; QR encodes it compactly)
app.get('/vendor/qrcode.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/qrcode-generator/dist/qrcode.js'))
);
// QR decoder — camera-scan fallback for phones without BarcodeDetector
// (iPhone Safari): frames are decoded in JS so warehouse staff can use
// their own smartphones as scanners
app.get('/vendor/jsqr.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/jsqr/dist/jsQR.js'))
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

const LABEL_IMPORT_DIR   = path.join(DATA_DIR, 'label_imports');
const INBOUND_PHOTO_DIR  = path.join(DATA_DIR, 'inbound_photos');
fs.mkdirSync(WMS_DIR,            { recursive: true });
fs.mkdirSync(WAYBILL_DIR,        { recursive: true });
fs.mkdirSync(LABEL_IMPORT_DIR,   { recursive: true });
fs.mkdirSync(DOC_TEMPLATE_DIR, { recursive: true });
fs.mkdirSync(INBOUND_PHOTO_DIR,  { recursive: true });

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
  catch { _dbCache = { batches: [], inbound: [], transport: [], drivers: [], fixSchedules: {} }; }
  // Ensure all required fields exist
  if (!_dbCache.batches) _dbCache.batches = [];
  if (!_dbCache.inbound) _dbCache.inbound = [];
  if (!_dbCache.transport) _dbCache.transport = [];
  if (!_dbCache.waves) _dbCache.waves = [];
  if (!_dbCache.fixSchedules) _dbCache.fixSchedules = {};
  if (!_dbCache.drivers) {
    // Initialize with sample drivers
    _dbCache.drivers = [
      { id: 'DRV-001', name: 'Ahmad Hassan', pin: '1234', phone: '6581234567', vehicle: 'Van', capacity: 1000, status: 'active' },
      { id: 'DRV-002', name: 'Sarah Chen', pin: '2345', phone: '6587654321', vehicle: 'Bike', capacity: 50, status: 'active' },
      { id: 'DRV-003', name: 'Rajesh Kumar', pin: '3456', phone: '6591112222', vehicle: 'Truck', capacity: 2000, status: 'active' }
    ];
  }
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

// Update transport record when order completes (mark as confirmed + package count)
function updateTransportOnOrderCompletion(db, order, state) {
  if (!db.transport || !order) return;

  // Find matching transport record by order identifiers.
  // Transport ids are TR-YYMMDD-NNN codes, so the real cross-reference is
  // referenceId/clientId (the PO number captured at import time).
  const orderIds = [order.order_number, order.waybill_number, order.pick_ticket, order.po_number]
    .filter(Boolean).map(String);
  const transportRecord = db.transport.find(t =>
    orderIds.includes(String(t.id)) ||
    orderIds.includes(String(t.referenceId || '')) ||
    orderIds.includes(String(t.clientId || '')) ||
    (t.clientName && t.clientName === order.customer_name)
  );

  if (!transportRecord) return;

  // Update status to confirmed and set package count
  transportRecord.status = 'confirmed';
  transportRecord.packages = state.cartons?.length || 1;
  transportRecord.completedAt = new Date().toISOString();

  // Calculate total scanned pieces
  const scannedPieces = Object.values(state.scanned || {}).reduce((sum, qty) => sum + (qty || 0), 0);
  if (scannedPieces > 0) {
    transportRecord.scannedPieces = scannedPieces;
  }

  logAudit('transport_order_completed', {
    transportId: transportRecord.id,
    orderId: order.order_number,
    packages: transportRecord.packages,
    scannedPieces: scannedPieces
  });
}

// ── Address Book — fixed-location cross-reference (BETIME stores etc.) ──────
// db.addressBook = [{ code, name, address, zip, phone }]. Import files often
// carry only a store name/code with no address; the book resolves those to a
// full address + 6-digit postal so map pins and route distances work.
function _abNorm(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ' '); }

function buildAddressBookIndex(db) {
  const idx = new Map();
  for (const e of db.addressBook || []) {
    if (e.name) idx.set(_abNorm(e.name), e);
    if (e.code) idx.set(_abNorm(e.code), e);
    // Chain + branch combos — orders often say "Watsons YEW TEE POINT"
    // while the book stores chain="Watsons", name="YEW TEE POINT"
    if (e.chain && e.name) {
      idx.set(_abNorm(`${e.chain} ${e.name}`), e);
      idx.set(_abNorm(`${e.name} ${e.chain}`), e);
    }
  }
  return idx;
}

// Fuzzy similarity for "spelled differently" store names — token overlap
// plus a Levenshtein ratio, so both word-order differences ("WESTGATE
// Watsons") and typos ("WESTGTE") score high.
function _abLev(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function addressBookSimilarity(query, entry) {
  const q = _abNorm(query);
  const candidates = [entry.name, entry.code, entry.chain && entry.name ? `${entry.chain} ${entry.name}` : '']
    .filter(Boolean).map(_abNorm);
  let best = 0;
  for (const c of candidates) {
    if (!c) continue;
    if (q === c) return 1;
    const qT = new Set(q.split(' ')), cT = new Set(c.split(' '));
    const inter = [...qT].filter(t => cT.has(t)).length;
    const tokenScore = inter / Math.max(qT.size, cT.size);
    const levScore = 1 - _abLev(q, c) / Math.max(q.length, c.length);
    let score = Math.max(tokenScore, levScore);
    if (q.includes(c) || c.includes(q)) score = Math.max(score, 0.75);
    best = Math.max(best, score);
  }
  return best;
}

// Fill address/zip/phone on every transport job that lacks a postal code,
// by looking its client name (or referenceId as a store code) up in the
// book. Called after every book change and after every job-creation path,
// so a book update "takes effect" on existing unresolved jobs immediately.
function applyAddressBookToTransport(db) {
  const idx = buildAddressBookIndex(db);
  if (!idx.size) return 0;
  let updated = 0;
  for (const job of db.transport || []) {
    if (job.shipping?.zip) continue; // already resolved — never overwrite
    const entry = idx.get(_abNorm(job.clientName)) || idx.get(_abNorm(job.referenceId));
    if (!entry) continue;
    job.shipping = job.shipping || {};
    job.shipping.addressLine1 = job.shipping.addressLine1 || entry.address || '';
    job.shipping.zip = entry.zip || '';
    if (!job.shipping.phone && entry.phone) job.shipping.phone = entry.phone;
    updated++;
  }
  return updated;
}

// Every uploaded picking-list order ALSO becomes a transport delivery job,
// so the Transport tab reflects the day's real workload without a second
// upload. Deduped by order number (referenceId), so re-uploading a batch or
// uploading the same order twice never duplicates jobs. Scanning completion
// then flips these to 'confirmed' via updateTransportOnOrderCompletion()
// (matcher already checks referenceId === order_number).
function createTransportJobsFromOrders(db, orders, clientName, batchId) {
  if (!Array.isArray(orders) || !orders.length) return 0;
  if (!db.transport) db.transport = [];

  let created = 0;
  for (const order of orders) {
    const ref = String(order.order_number || '').trim();
    if (!ref) continue;
    const exists = db.transport.some(t =>
      String(t.referenceId || '') === ref || String(t.clientId || '') === ref);
    if (exists) continue;

    const addr = String(order.delivery_address || '').trim();
    const zip  = (addr.match(/\b(\d{6})\b/) || [])[1] || ''; // SG postal from address text

    db.transport.push({
      // tmsImporter is required lower in this file — fine here since this
      // helper only runs at request time, long after module load completes
      id: tmsImporter.nextTransportCode(db),
      referenceId: ref,
      clientId: ref,
      clientName: order.customer_name || clientName || ref,
      channel: 'order-upload',
      createdAt: new Date().toISOString(),
      status: 'pending',
      currency: 'SGD',
      notes: order.carrier ? `Carrier: ${order.carrier}` : 'From picking-list upload',
      items: [{ sku: ref, name: `Order ${ref} — ${order.line_count || (order.lines || []).length || 0} line(s)`, qty: 1, unitPrice: 0 }],
      shipping: {
        recipient: order.customer_name || '',
        addressLine1: addr,
        addressLine2: '',
        city: 'Singapore', state: 'SG', zip, country: 'SG',
        phone: order.tel || '',
        email: ''
      },
      subtotal: 0, shippingCost: 0, tax: 0, total: 0,
      source: { importedAt: new Date().toISOString(), customerId: ref, format: 'order-upload', batchId: batchId || '' }
    });
    created++;
  }
  if (created) {
    applyAddressBookToTransport(db); // resolve store names → address/postal
    logAudit('transport_jobs_from_upload', { jobs: created, batchId: batchId || '', client: clientName || '' });
  }
  return created;
}

// Singapore postal sector (first 2 digits) → district centroid.
// MIRROR of the client-side map in public/app.js (getPostalCodeCoords) —
// keep the two in sync. Used server-side for the Driver Performance report's
// estimated distances.
const SG_DISTRICT_COORDS_SRV = {
  D01: [1.2850, 103.8520], D02: [1.2740, 103.8430], D03: [1.2900, 103.8100],
  D04: [1.2650, 103.8220], D05: [1.3110, 103.7650], D06: [1.2900, 103.8500],
  D07: [1.3010, 103.8580], D08: [1.3110, 103.8560], D09: [1.3050, 103.8320],
  D10: [1.3150, 103.8060], D11: [1.3270, 103.8380], D12: [1.3280, 103.8620],
  D13: [1.3350, 103.8780], D14: [1.3200, 103.8930], D15: [1.3060, 103.9020],
  D16: [1.3240, 103.9310], D17: [1.3570, 103.9880], D18: [1.3520, 103.9440],
  D19: [1.3610, 103.8850], D20: [1.3620, 103.8380], D21: [1.3350, 103.7770],
  D22: [1.3330, 103.7430], D23: [1.3770, 103.7630], D24: [1.3800, 103.7000],
  D25: [1.4360, 103.7860], D26: [1.3900, 103.8280], D27: [1.4290, 103.8360],
  D28: [1.3910, 103.8720],
};
const SG_SECTOR_TO_DISTRICT_SRV = {};
[
  ['D01', ['01','02','03','04','05','06']], ['D02', ['07','08']],
  ['D03', ['14','15','16']], ['D04', ['09','10']], ['D05', ['11','12','13']],
  ['D06', ['17']], ['D07', ['18','19']], ['D08', ['20','21']],
  ['D09', ['22','23']], ['D10', ['24','25','26','27']], ['D11', ['28','29','30']],
  ['D12', ['31','32','33']], ['D13', ['34','35','36','37']], ['D14', ['38','39','40','41']],
  ['D15', ['42','43','44','45']], ['D16', ['46','47','48']], ['D17', ['49','50','81']],
  ['D18', ['51','52']], ['D19', ['53','54','55','82']], ['D20', ['56','57']],
  ['D21', ['58','59']], ['D22', ['60','61','62','63','64']], ['D23', ['65','66','67','68']],
  ['D24', ['69','70','71']], ['D25', ['72','73']], ['D26', ['77','78']],
  ['D27', ['75','76']], ['D28', ['79','80']],
].forEach(([d, sectors]) => sectors.forEach(s => { SG_SECTOR_TO_DISTRICT_SRV[s] = d; }));

function transportPostalCoords(zip) {
  const district = SG_SECTOR_TO_DISTRICT_SRV[String(zip || '').trim().substring(0, 2)];
  return district ? SG_DISTRICT_COORDS_SRV[district] : [1.3521, 103.8198];
}
function transportLegKm(zipA, zipB) {
  const [aLat, aLng] = transportPostalCoords(zipA);
  const [bLat, bLng] = transportPostalCoords(zipB);
  const R = 6371, toRad = x => x * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Per-driver performance summary shared by the Driver Performance XLSX
// report AND the lightweight Administrator → Drivers "Performance Stats"
// tab (GET /api/drivers/performance) — one real computation, two callers,
// so the numbers can never drift apart. `from`/`to` are 'YYYY-MM-DD';
// omit both for all-time. Distance is an ESTIMATE (Singapore postal-sector
// centroids from the depot, same basis route planning uses) — never treat
// as odometer data.
function computeDriverPerformance(db, from, to) {
  const day = at => at ? sgDateStr(new Date(at)) : '';
  const jobs = (db.transport || []).filter(rec => {
    if (!rec.assignedDriver && !rec.assignedDriverName) return false;
    if (!from && !to) return true;
    const d = day(rec.deliveredAt || rec.plannedAt || rec.createdAt);
    return (!from || d >= from) && (!to || d <= to);
  });

  const drivers = {};
  for (const rec of jobs) {
    const key = rec.assignedDriverName || rec.assignedDriver;
    const drv = drivers[key] ||= { jobs: [], days: {} };
    drv.jobs.push(rec);
    const d = day(rec.deliveredAt || rec.plannedAt || rec.createdAt);
    (drv.days[d] ||= []).push(rec);
  }

  const DEPOT_ZIP = getTransportDepot(db).zip;
  const dayDistanceKm = list => {
    const sorted = [...list].sort((a, b) =>
      (a.routeNum || 99) - (b.routeNum || 99) || (a.stopSeq || 99) - (b.stopSeq || 99));
    let km = 0, prev = DEPOT_ZIP;
    for (const rec of sorted) {
      const zip = rec.shipping?.zip || '';
      km += transportLegKm(prev, zip);
      prev = zip;
    }
    return km;
  };

  const summary = Object.keys(drivers).sort().map(name => {
    const drv = drivers[name];
    const delivered = drv.jobs.filter(j => j.status === 'delivered').length;
    const confirmed = drv.jobs.filter(j => j.status === 'confirmed').length;
    const open      = drv.jobs.filter(j => j.status === 'preplanned' || j.status === 'pending').length;
    const cartons   = drv.jobs.reduce((s, j) => s + (j.packages || 1), 0);
    const km        = Object.values(drv.days).reduce((s, list) => s + dayDistanceKm(list), 0);
    const daysActive = Object.keys(drv.days).length;
    return {
      name, jobsAssigned: drv.jobs.length, delivered, confirmed, open, cartons,
      km: Math.round(km * 10) / 10, daysActive,
      avgJobsPerDay: daysActive ? Math.round(drv.jobs.length / daysActive * 10) / 10 : 0,
    };
  });

  return { drivers, summary };
}

// Apply fix schedule constraints to route planning
function applyFixScheduleToRoutes(db, routes, transportRecords, options = {}) {
  const dayOfWeek = options.dayOfWeek || new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const fixSchedules = db.fixSchedules || {};
  const daySchedule = fixSchedules[dayOfWeek];

  // If no schedule or order opts out, return routes unchanged
  if (!daySchedule?.enabled || (options.bypassFixSchedule === true)) {
    return routes;
  }

  const priorityAreas = daySchedule.priorityAreas || [];
  if (priorityAreas.length === 0) return routes;

  // Reorder routes to prioritize scheduled areas
  return routes.map(route => {
    if (!Array.isArray(route.stops) || route.stops.length <= 1) return route;

    // Find which stops match priority areas
    const stopsWithPriority = route.stops.map((stop, idx) => {
      const record = transportRecords.find(t => t.id === stop.transportId);
      if (!record) return { stop, priority: 0, index: idx };

      // Check if postal code prefix matches any priority area
      const postalPrefix = (record.shipping?.zip || '').substring(0, 2);
      const priority = priorityAreas.find(a => a.postalPrefix === postalPrefix);

      return {
        stop,
        priority: priority ? priority.order : 0,
        index: idx
      };
    });

    // Reorder: high priority stops first, maintain relative order within priority levels
    const reordered = stopsWithPriority
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority; // Higher priority first
        return a.index - b.index; // Maintain original order within same priority
      })
      .map(item => item.stop);

    return { ...route, stops: reordered };
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

// Wave picking needs a DIFFERENT pooling than uniqueSkuLines() above: a
// packer picks from a physical bin, so the same SKU at two different
// locations within one order must stay two separate lines (each with its
// own needed qty) rather than being merged into one location-blind total.
// Deliberately a separate function — uniqueSkuLines() is relied on by every
// other scan/complete/mismatch path, which only ever needs a SKU-level
// total and must not change behaviour here.
function uniqueSkuLocationLines(ord) {
  const map = new Map();
  for (const l of (ord.lines || [])) {
    const key = `${l.sku}::${l.location || ''}`;
    const m = map.get(key);
    if (!m) { map.set(key, { ...l }); continue; }
    m.qty += l.qty || 0;
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

// Per-carton breakdown — a big order can take more than one physical box.
// Every scan/count lands in the ACTIVE carton's tally, so the completion
// slip can show exactly what went in which box. Orders that never
// explicitly split cartons end up with one implicit carton holding
// everything — no extra step for the common case.
//
// `state.activeCartonNum` is an explicit pointer (not always "the last
// array entry") so a packer can reopen an earlier, already-closed carton
// via /api/scan/carton/switch to add/remove items, then move on — cartons
// are never reordered, only re-activated. Legacy state with no pointer
// (or a stale one) falls back to the last carton, matching the original
// always-append behaviour exactly.
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

// Flags a SKU that appears more than once within the SAME order, matching
// batch number + expiry date too — NOT blocking, since a genuine split pick
// across two bins is valid and should simply sum, but it looks identical to
// a data-entry duplicate, so the uploader gets a chance to check the source
// file before committing rather than silently trusting whichever total the
// file happens to add up to. Read-only warning surfaced at /api/preview time
// — see the call site for why this is kept separate from the existing
// editable "flagged" review table.
function findDuplicateLineWarnings(orders) {
  const warnings = [];
  for (const order of orders) {
    const groups = new Map(); // "sku|batch|expiry" → matching lines
    for (const line of order.lines || []) {
      const key = `${line.sku}|${line.batch_number || ''}|${line.expiry_date || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(line);
    }
    for (const [key, lines] of groups) {
      if (lines.length < 2) continue;
      const [sku, batch, expiry] = key.split('|');
      const totalQty = lines.reduce((s, l) => s + (l.qty || 0), 0);
      warnings.push({
        gi: order.order_number,
        problem: `SKU ${sku} appears ${lines.length} times in this order` +
          `${batch ? ` (batch ${batch})` : ''}${expiry ? `, expiry ${expiry}` : ''}` +
          ` — combined qty is ${totalQty}. Confirm this isn't a duplicate line before uploading.`,
        critical: false,
        lines: lines.map(l => ({ sku: l.sku, description: String(l.description || '').slice(0, 70), qty: l.qty })),
      });
    }
  }
  return warnings;
}

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
      location:       line.location       || '',
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
        pending_deletion:  state.pending_deletion  || null,
        cartons:           state.cartons           || [],
        active_carton_num: state.activeCartonNum   || (state.cartons && state.cartons.length ? state.cartons[state.cartons.length - 1].num : 1),
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

// Mirrors nextIdealscanCode() for IdealInbound — its own per-day sequence
// (separate counter key, IB- prefix) so an inbound serial never collides
// with or depends on the outbound order numbering.
function nextInboundCode(db) {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }).slice(2).replace(/-/g, '');
  if (!db.inboundCodeSeq) db.inboundCodeSeq = {};
  db.inboundCodeSeq[day] = (db.inboundCodeSeq[day] || 0) + 1;
  for (const k of Object.keys(db.inboundCodeSeq)) if (k !== day) delete db.inboundCodeSeq[k];
  return `IB-${day}-${String(db.inboundCodeSeq[day]).padStart(2, '0')}`;
}

// Mirrors nextIdealscanCode()/nextInboundCode() for wave picking — its own
// per-day sequence (separate counter key, WV- prefix).
function nextWaveCode(db) {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }).slice(2).replace(/-/g, '');
  if (!db.waveCodeSeq) db.waveCodeSeq = {};
  db.waveCodeSeq[day] = (db.waveCodeSeq[day] || 0) + 1;
  for (const k of Object.keys(db.waveCodeSeq)) if (k !== day) delete db.waveCodeSeq[k];
  return `WV-${day}-${String(db.waveCodeSeq[day]).padStart(2, '0')}`;
}

// One-time backfill: give pre-existing inbound records a serial based on their upload date
(function backfillInboundCodes() {
  try {
    const db = readDb();
    if (db.inboundCodesBackfilled) return;
    const perDay = {};
    let n = 0;
    const sorted = [...(db.inbound || [])].sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at));
    for (const rec of sorted) {
      if (rec.serial) continue;
      const day = new Date(rec.uploaded_at || Date.now())
        .toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }).slice(2).replace(/-/g, '');
      perDay[day] = (perDay[day] || 0) + 1;
      rec.serial = `IB-${day}-${String(perDay[day]).padStart(2, '0')}`;
      n++;
    }
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }).slice(2).replace(/-/g, '');
    if (perDay[today]) {
      if (!db.inboundCodeSeq) db.inboundCodeSeq = {};
      db.inboundCodeSeq[today] = Math.max(db.inboundCodeSeq[today] || 0, perDay[today]);
    }
    db.inboundCodesBackfilled = true;
    writeDb(db);
    if (n) console.log(`[IdealScan] Inbound serials backfilled on ${n} existing record(s)`);
  } catch (e) { console.error('[IdealScan] inbound serial backfill failed:', e.message); }
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
// whose orders are ALL settled (done/unprocessed) and untouched for 12 months
// move to monthly archive files on the volume. Archived orders stay
// reachable: slips/waybills fall back to the archive, and the Completed tab
// searches archives explicitly. The audit ledger is unaffected — reports
// keep covering archived activity.
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const ARCHIVE_AFTER_DAYS = 365; // 12 months retention

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

// ── Audit log retention ──────────────────────────────────────────────────────
// db.auditLog backs every Administrator report and grows forever otherwise —
// same "must stay small forever" problem batches had. Entries older than 12
// months move to monthly archive files; readAuditLogForRange() transparently
// reads them back in whenever a report's date range reaches that far, so
// reports can always toggle/filter across the full 12-month retention period.
const AUDIT_ARCHIVE_AFTER_DAYS = 365; // 12 months retention

function runAuditLogArchive() {
  try {
    const db = readDb();
    if (!db.auditLog || !db.auditLog.length) return;
    const cutoff = new Date(Date.now() - AUDIT_ARCHIVE_AFTER_DAYS * 86400000).toISOString();
    const keep = [], move = [];
    for (const e of db.auditLog) ((e.at || '') < cutoff ? move : keep).push(e);
    if (!move.length) return;
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const byMonth = {};
    for (const e of move) {
      const m = (e.at || '').slice(0, 7) || 'unknown';
      (byMonth[m] = byMonth[m] || []).push(e);
    }
    for (const [m, events] of Object.entries(byMonth)) {
      const file = path.join(ARCHIVE_DIR, `audit-archive-${m}.json`);
      let existing = [];
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      existing.push(...events);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(existing));
      fs.renameSync(tmp, file);
    }
    db.auditLog = keep;
    writeDb(db);
    console.log(`[IdealScan] Audit log archive: moved ${move.length} event(s) → ${Object.keys(byMonth).sort().join(', ')}`);
  } catch (e) {
    console.error('[IdealScan] audit log archive failed:', e.message);
  }
}
setTimeout(runAuditLogArchive, 90 * 1000);          // shortly after boot (staggered from batch archive)
setInterval(runAuditLogArchive, 24 * 3600 * 1000);  // then daily

// Merges live db.auditLog with archived months when a report's requested
// range reaches further back than what's still live — transparent to every
// report kind, which just keeps reading `log` as before.
function readAuditLogForRange(db, from, to) {
  const live = db.auditLog || [];
  const cutoff = new Date(Date.now() - AUDIT_ARCHIVE_AFTER_DAYS * 86400000).toISOString().slice(0, 10);
  if (from >= cutoff) return live; // fast path — nothing archived is needed
  const months = new Set();
  const endMonth = to < cutoff ? to : cutoff;
  let d = new Date(from.slice(0, 7) + '-01T00:00:00Z');
  const endD = new Date(endMonth.slice(0, 7) + '-01T00:00:00Z');
  while (d <= endD) {
    months.add(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  const archived = [];
  for (const m of months) {
    try { archived.push(...JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, `audit-archive-${m}.json`), 'utf8'))); }
    catch {}
  }
  return [...archived, ...live];
}

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
  // QR, not Code128 — the QR encodes the FULL SKU value, so scanning it
  // feeds the exact SKU into processing. A long SKU (26+ chars) as Code128
  // is too wide/dense to read off a card; QR stays compact at any length.
  const cards = items.map((it, i) => `
    <div class="card">
      ${it.client_name ? `<div class="client">${esc(it.client_name)}</div>` : ''}
      <div class="qr" id="qr${i}"></div>
      <div class="sku">${esc(it.sku)}</div>
      ${it.description && it.description !== it.sku ? `<div class="desc">${esc(it.description)}</div>` : ''}
    </div>`).join('');
  const scripts = items.map((it, i) => `
    (function(){ var q = qrcode(0, 'M'); q.addData(${JSON.stringify(it.sku)}); q.make();
      document.getElementById("qr${i}").innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); })();`
  ).join('\n');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>No-Barcode SKU Sheet</title>
<script src="/vendor/qrcode.js"></script>
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
  .card .qr { display:flex; justify-content:center; padding:4px 0; }
  .card .qr svg { width:110px; height:110px; }
  .card .sku { font-size:20px; font-weight:800; font-family:Consolas,monospace; letter-spacing:1px; overflow-wrap:break-word; }
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

// Read-only — serves an inbound receiving photo's bytes. Registered before
// the blanket requireAuth middleware (below) so ?token= works for plain
// <img> tags, which can't send the x-auth-token header — same pattern as
// the PDF viewers above.
app.get('/api/inbound/:id/photo/:photoId', requireAuthOrToken, (req, res) => {
  const { id, photoId } = req.params;
  const db    = readDb();
  const rec   = findInbound(db, id);
  const photo = rec?.photos?.find(p => p.id === photoId);
  if (!photo) return res.status(404).send('Not found');
  res.sendFile(path.join(INBOUND_PHOTO_DIR, id, photo.filename), err => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
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
  // The SKU-shape heuristics below exist to catch summary labels leaking in
  // from AI-DETECTED columns. A SKU from a KNOWN schema column (d-SKUCODE,
  // "SKU", "Item Code", …) is real data and may legitimately contain spaces
  // ("Thermal Grease X23-7783D") or label-like words — trust it outright.
  if (r._skuSource === 'schema') return false;
  // SKU with spaces → a summary label like "Total Whole Qty", "Grand Total Loose"
  if (/\s/.test(sku)) return true;
  // SKU is a known label word (Status, Account, Reference, …)
  if (_LABEL_WORDS.has(sku.toLowerCase())) return true;
  return false;
}

// ── Location-code-shaped SKU check ───────────────────────────────────────────
// Warehouse bin/location pattern (e.g. AC-007-003-B, A-01-02-C) — but real
// product SKUs can share this exact shape (THT-64-427-3). This used to live
// inside isMetadataRow and SILENTLY dropped such rows, which lost legitimate
// lines. Now: rows whose SKU came from a KNOWN named column (_skuSource ===
// 'schema', e.g. d-SKUCODE or an "SKU"/"Item Code" header) are trusted
// outright; rows where only the AI column-scoring picked the SKU column are
// flagged as SUSPECTS for the user to confirm at upload time — never dropped
// without asking, never accepted on a guess.
const LOCATION_SKU_PAT = /^[A-Z]{1,4}-\d{2,5}-\d{2,5}(-[A-Z0-9]{1,2})?$/i;

function splitSuspectSkuRows(rows) {
  const kept = [], suspects = [];
  for (const r of rows) {
    if (r._skuSource !== 'schema' && LOCATION_SKU_PAT.test(String(r.sku || '').trim())) suspects.push(r);
    else kept.push(r);
  }
  return { kept, suspects };
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
  '/api/driver/login',
  '/api/lazada/callback', // Lazada Open Platform push mechanism (external caller)
]);
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (AUTH_PUBLIC.has(req.path) || req.path.startsWith('/api/public/') || req.path.startsWith('/api/driver/')) return next();
  // Allow master key access to /api/master/* and /api/transport/import/* endpoints
  if ((req.path.startsWith('/api/master/') || req.path === '/api/transport/import') && req.headers['x-master-key'] === MASTER_PASS) return next();
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
    // Heads-up for AI-detected SKUs shaped like warehouse location codes —
    // the actual include/exclude decision happens at upload time (409
    // needsSkuConfirm), this just makes the doubt visible before Approve.
    {
      const { suspects } = splitSuspectSkuRows(allRows);
      if (suspects.length) {
        const uniq = [...new Set(suspects.map(r => r.sku))];
        errors.push(`⚠ ${suspects.length} line(s) have SKUs shaped like warehouse location codes: ${uniq.slice(0, 6).join(', ')}${uniq.length > 6 ? '…' : ''} — you'll be asked to confirm they are real products when you approve.`);
      }
    }
    // Read-only heads-up, deliberately NOT fed into `flagged` — that array
    // drives the editable quantity-adjustment table, which matches rows by
    // order+SKU only. Two duplicate rows share that same key, so editing one
    // row's qty there would silently overwrite the OTHER row too. Surface
    // these as plain informational warnings instead; the uploader fixes the
    // source file and re-uploads if the duplicate is a mistake.
    const duplicateWarnings = findDuplicateLineWarnings(orders).map(w => w.problem);
    // Duplicate check so the Confirm dialog warns BEFORE approving — mirrors
    // /api/upload's three-way split: completed+sameGI = blocked, still
    // pending/processing = Overwrite-or-Abort prompt, completed+differentGI
    // = upload-as-new prompt.
    {
      const existing = new Map(); // order_number → {status, issueNo}
      for (const b of readDb().batches || []) for (const o of b.orders || []) {
        if (!existing.has(o.order_number)) {
          existing.set(o.order_number, {
            status: b.orderStates?.[o.order_number]?.status || 'pending',
            issueNo: String(o.issue_no || '').trim(),
          });
        }
      }
      const locked = [], overwritable = [], asNew = [];
      for (const o of orders) {
        const src = existing.get(o.order_number);
        if (!src) continue;
        const newGi = String(o.issue_no || '').trim();
        const giDiffers = newGi && src.issueNo && newGi !== src.issueNo;
        if (src.status === 'done' && giDiffers) asNew.push(o.order_number);
        else if (src.status === 'done')         locked.push(o.order_number);
        else                                    overwritable.push(o.order_number);
      }
      const list = a => [...new Set(a)].slice(0, 8).join(', ') + (new Set(a).size > 8 ? '…' : '');
      if (locked.length)       errors.push(`⛔ ${locked.length} order(s) already uploaded AND completed: ${list(locked)} — upload will be blocked`);
      if (overwritable.length) errors.push(`⚠ ${overwritable.length} order(s) already uploaded earlier (not yet completed): ${list(overwritable)} — you'll be asked to Overwrite or Abort when you approve`);
      if (asNew.length)        errors.push(`⚠ ${asNew.length} completed order(s) share a number with this file but have a different GI: ${list(asNew)} — you'll be asked to confirm uploading them as new orders`);
    }
    const clientName = allRows.find(r => r.client_name)?.client_name || '';
    const customerNames = [...new Set(allRows.map(r => r.customer_name).filter(Boolean))];

    // Check if delivery planning is available (orders have postal codes)
    const hasPostalCodes = orders.some(o => o.postal_code || o.zip || o.zip_code);
    const deliveryPlanningAvailable = hasPostalCodes;

    res.json({
      rowCount: allRows.length,
      orderCount: orders.length,
      errors,
      converted: allRows.length > 0,
      clientName,
      customerNames,
      flagged,
      duplicateWarnings,
      deliveryPlanningAvailable,
      deliveryPlanningHint: deliveryPlanningAvailable ? 'This shipment can be grouped into delivery jobs for route planning.' : null
    });
  } catch (err) {
    res.json({ rowCount: 0, orderCount: 0, errors: [err.message], converted: false });
  }
});

// ── Delivery Job Planning — Group orders by postal code/zone ─────────────────
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
    // Photo-scanned picking lists also feed the Transport tab — but only when
    // the user answered YES to the delivery-arrangement question.
    if (req.body?.arrange_delivery === 'yes' && req.body?.direction !== 'Inbound') {
      createTransportJobsFromOrders(db, orders, batch.client_name, batchId);
    }
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
    // SUSPECT SKUs — AI-detected SKU column values shaped like warehouse
    // location codes (THT-64-427-3 vs bin AC-007-003-B are indistinguishable
    // by pattern). Never assume either way: ask the user. Client resends with
    // suspect_skus=include (they're real SKUs) or =exclude (drop those lines).
    // PDF picking lists are exempt — their parser separates location and SKU
    // columns explicitly (lib/ocr-parse.js LOCATION_CODE_PAT).
    if (orderExt !== '.pdf') {
      const { kept, suspects } = splitSuspectSkuRows(mapped);
      if (suspects.length) {
        const decision = String(req.body?.suspect_skus || '').toLowerCase();
        if (decision === 'include') {
          logAudit('upload_suspect_skus_included', {
            count: suspects.length,
            skus: [...new Set(suspects.map(r => r.sku))].slice(0, 20),
            ...clientInfo(req),
          });
        } else if (decision === 'exclude') {
          mapped = kept;
          logAudit('upload_suspect_skus_excluded', {
            count: suspects.length,
            skus: [...new Set(suspects.map(r => r.sku))].slice(0, 20),
            ...clientInfo(req),
          });
        } else {
          return res.status(409).json({
            needsSkuConfirm: true,
            suspects: suspects.map(r => ({
              order: r.order_number, sku: r.sku, qty: r.qty,
              description: String(r.description || '').slice(0, 60),
            })),
            message:
              `${suspects.length} line(s) have SKUs shaped like warehouse location codes ` +
              `(letters-digits-digits). The system cannot tell if these are real products or ` +
              `bin locations that leaked into the SKU column — please confirm.`,
          });
        }
      }
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
    // the same picking lists in another file) would create twin orders.
    // The error names the exact batch each duplicate already lives in.
    //
    // EXCEPTION — clients recycle order numbers (e.g. date-letter codes like
    // "20260716-H"): when the earlier order is already COMPLETED and the GI
    // number DIFFERS, this is almost certainly a genuinely different order
    // that reuses the client's number. That case becomes a CONFIRMABLE
    // warning instead of a hard block: the user is told what likely happened
    // and can approve the upload (resent with confirm_duplicates=yes).
    {
      const existingIn = new Map(); // order_number → {code, filename, at, status, issueNo}
      for (const b of readDb().batches || []) {
        for (const o of b.orders || []) {
          if (!existingIn.has(o.order_number)) {
            existingIn.set(o.order_number, {
              code: b.idealscan_code || '', filename: b.filename || '',
              at: (b.uploaded_at || '').slice(0, 16).replace('T', ' '),
              status: b.orderStates?.[o.order_number]?.status || 'pending',
              issueNo: String(o.issue_no || '').trim(),
            });
          }
        }
      }

      const lockedDups    = [];   // earlier order already DONE (same/missing GI) → always abort, completed work is never overwritten
      const overwriteDups = [];   // earlier order still pending/processing → user chooses Abort or Overwrite
      const softDups      = [];   // completed + different GI → confirmable as a NEW separate order
      for (const o of orders) {
        const src = existingIn.get(o.order_number);
        if (!src) continue;
        const newGi = String(o.issue_no || '').trim();
        const giDiffers = newGi && src.issueNo && newGi !== src.issueNo;
        if (src.status === 'done' && giDiffers) {
          softDups.push({ order: o.order_number, existingGi: src.issueNo, newGi, ...src });
        } else if (src.status === 'done') {
          lockedDups.push({ order: o.order_number, ...src });
        } else {
          overwriteDups.push({ order: o.order_number, ...src });
        }
      }

      if (lockedDups.length) {
        return res.status(422).json({
          error: `UPLOAD ABORTED:\n${lockedDups.length} order(s) in this file were already uploaded AND completed.\nNothing was saved.`,
          validation: {
            passed: false, status: 'FAILED', totalErrors: lockedDups.length,
            totalRowsProcessed: mapped.length, rowsWithErrors: lockedDups.length, hasCritical: true,
            errors: lockedDups.slice(0, 50).map(d => ({
              excelRow: '—', orderId: d.order, field: 'order_number',
              issue: 'ORDER ALREADY COMPLETED',
              description: `Order "${d.order}" was already completed in job ${d.code || '(unknown)'} — "${d.filename}", uploaded ${d.at}.`,
              action: 'Completed orders are never overwritten. If this is genuinely a different order, its GI number must differ; if the completed record is wrong, use the Master deletion workflow first.',
              critical: true,
            })),
          },
        });
      }

      // Same order number, earlier copy NOT yet completed — the uploader
      // decides: abort, or OVERWRITE (replace the earlier upload with this
      // file's version; any scan progress on it is discarded).
      if (overwriteDups.length && req.body?.overwrite_duplicates !== 'yes') {
        return res.status(409).json({
          needsOverwriteConfirm: true,
          duplicates: overwriteDups.map(d => ({
            order: d.order, job: d.code, filename: d.filename, at: d.at, status: d.status,
          })),
          message: `${overwriteDups.length} order number(s) in this file were already uploaded and are still ${overwriteDups.some(d => d.status === 'processing') ? 'pending / in progress' : 'pending'}. You can OVERWRITE them with this file's version (the earlier upload — including any scan progress — is discarded) or abort.`,
        });
      }
      if (overwriteDups.length) {
        const dupNums = new Set(overwriteDups.map(d => d.order));
        const db0 = readDb();
        for (const b of db0.batches || []) {
          const before = (b.orders || []).length;
          if (!before) continue;
          b.orders = b.orders.filter(o => !dupNums.has(o.order_number));
          if (b.orders.length !== before) {
            for (const on of dupNums) { if (b.orderStates?.[on]) delete b.orderStates[on]; }
            b.order_count = b.orders.length;
            b.row_count   = b.orders.reduce((s, o) => s + (o.lines?.length || 0), 0);
          }
        }
        // A batch whose every order was overwritten would linger as an empty shell
        db0.batches = (db0.batches || []).filter(b => (b.orders || []).length > 0);
        writeDb(db0);
        logAudit('upload_duplicate_overwritten', {
          orders: overwriteDups.map(d => `${d.order} (was ${d.status} in ${d.code})`).slice(0, 20),
          count: overwriteDups.length, by: req.userId || '',
        });
      }

      if (softDups.length && req.body?.confirm_duplicates !== 'yes') {
        return res.status(409).json({
          needsDuplicateConfirm: true,
          duplicates: softDups.map(d => ({
            order: d.order, existingGi: d.existingGi, newGi: d.newGi,
            job: d.code, filename: d.filename, at: d.at,
          })),
          message: `${softDups.length} order number(s) in this file were already uploaded AND completed scanning — but with a DIFFERENT GI number. The client has most likely re-used/duplicated their order numbers, so these are probably different orders that happen to share a number. Confirm to upload them as new, separate orders.`,
        });
      }
      if (softDups.length) {
        logAudit('upload_duplicate_confirmed', {
          orders: softDups.map(d => `${d.order} (${d.existingGi} → ${d.newGi})`).slice(0, 20),
          count: softDups.length, by: req.userId || '',
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
    // "Delivery arrangement needed?" — the user answers yes/no in the
    // Confirm-Upload modal. Yes → each order also becomes a Transport job
    // (deduped by order no). No → orders go to scanning only.
    let transportJobsCreated = 0;
    if (direction !== 'Inbound' && req.body?.arrange_delivery === 'yes') {
      transportJobsCreated = createTransportJobsFromOrders(db, orders, clientName, batchId);
    }
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

    console.log(`[upload] sending response — ${orders.length} order(s), batchId=${batchId}${transportJobsCreated ? `, ${transportJobsCreated} transport job(s)` : ''}`);
    res.json({
      sessionId,
      batchId,
      idealscanCode: batch.idealscan_code,
      rowCount: mapped.length,
      orderCount: orders.length,
      orders: ordersWithState,
      transportJobsCreated
    });
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
  // Calendar days are SGT (Asia/Singapore) — naive UTC slicing put anything
  // before 08:00 SGT on the previous day, so morning uploads/completions
  // vanished from "today" counts.
  const todayStr     = sgDateStr();
  const yesterdayStr = sgDateStr(new Date(Date.now() - 86400000));

  let todayPending = 0, todayDone = 0, yesterdayDone = 0, totalScanMs = 0, scanCount = 0;
  let totalOrders  = 0, totalLines   = 0, pendingBacklog = 0, totalDone = 0;
  const clientMap  = {};   // { [name]: { todayUploaded, todayPending, yesterdayBalance } }

  for (const batch of db.batches) {
    const batchDate   = sgDateStr(new Date(batch.uploaded_at));
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
      if (isPending) pendingBacklog++; // ANY day — feeds the sidebar Orders badge
      if (batchDate === todayStr) {
        cs.todayUploaded++;
        if (isPending) { cs.todayPending++; todayPending++; }
      } else if (batchDate === yesterdayStr && isPending) {
        cs.yesterdayBalance++;
      }
    }

    for (const state of Object.values(states)) {
      if (state.status === 'done') {
        totalDone++; // all-time processed (live 12-month window)
        const doneAt   = state.endTime || state.updated_at || '';
        const doneDate = doneAt ? sgDateStr(new Date(doneAt)) : '';
        if (doneDate === todayStr)     todayDone++;
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

  res.json({ todayPending, todayDone, yesterdayDone, totalOrders, totalLines,
    pendingBacklog, totalDone,
    avgScanMs: scanCount ? Math.round(totalScanMs / scanCount) : 0, clientStats });
});

// Date-windowed orders: the dashboard asks only for the selected range, so
// payloads stay small no matter how much history accumulates. Same day rules
// as the client always used: active orders filter on upload date, completed
// orders on completion date.
app.get('/api/orders', (req, res) => {
  const { range, from, to } = req.query;
  let orders = globalOrdersWithState();
  // Cross-reference: show which Transport job (TR-...) each order is linked
  // to. Linked by order number → referenceId/clientId, the same match the
  // scan-completion confirm uses. Purely informational on the order row.
  {
    const db = readDb();
    const trByRef = new Map();
    for (const t of db.transport || []) {
      if (t.referenceId) trByRef.set(String(t.referenceId), t.id);
      if (t.clientId)    trByRef.set(String(t.clientId), t.id);
    }
    if (trByRef.size) {
      orders = orders.map(o => {
        const tid = trByRef.get(String(o.order_number || ''));
        return tid ? { ...o, transport_id: tid } : o;
      });
    }
  }
  if (range && range !== 'all') {
    // SGT calendar days — see /api/stats note; UTC slicing shifted anything
    // before 08:00 SGT onto the previous day.
    const dayOf    = v => v ? sgDateStr(new Date(v)) : '';
    const todayStr = sgDateStr();
    const yestStr  = sgDateStr(new Date(Date.now() - 86400000));
    const weekStr  = sgDateStr(new Date(Date.now() - 6 * 86400000));
    const orderDay = o => dayOf(o.scan_status === 'done' ? (o.endTime || o.uploadedAt) : o.uploadedAt);
    orders = orders.filter(o => {
      // Unfinished work is NEVER hidden by the date window: the Active list
      // always shows today's orders PLUS the pending/in-progress balance
      // carried over from earlier days — so it tallies with the sidebar
      // badge. The date filter effectively applies to settled orders
      // (done/unprocessed) only.
      if (o.scan_status === 'pending' || o.scan_status === 'processing') return true;
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
  //
  // GI number lands in different fields depending on upload path: the
  // Keyfields picking-list PDF parser makes it the order_number directly
  // (parsePdfPicklistDetailed), but an XLSX/CSV upload with an "Issue No" /
  // "iWMS GINo" column maps it into issue_no instead (detectColumnMap) — so
  // issue_no must be checked here too, or that upload path's GI barcode
  // never resolves to an order.
  const order = globalOrdersWithState().find(o => {
    const on = (o.order_number || '').trim().toLowerCase();
    const pt = (o.pick_ticket  || '').trim().toLowerCase();
    const gi = (o.issue_no     || '').trim().toLowerCase();
    return on === q || strip0(on) === strip0(q) ||
      (pt && (pt === q || strip0(pt) === strip0(q))) ||
      (gi && (gi === q || strip0(gi) === strip0(q))) ||
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
  // Same SKU already sitting in a DIFFERENT carton? Fine — orders can
  // legitimately split one SKU across boxes — but it's easy to do by
  // accident, so confirm before it happens. Skipped for offline replays
  // (eventId present): the packer already made the physical call with no
  // network to ask, re-litigating it after the fact isn't meaningful.
  if (!eventId && !req.body.confirmCrossCarton && state.cartons && state.cartons.length > 1) {
    const active = activeCarton(state);
    if (!(active.scans[item.sku] > 0)) {
      const elsewhere = state.cartons.filter(c => c.num !== active.num && (c.scans[item.sku] || 0) > 0).map(c => c.num);
      if (elsewhere.length) {
        return res.status(409).json({
          crossCartonConfirm: true,
          sku: item.sku,
          activeCartonNum: active.num,
          existingCartonNums: elsewhere,
          error: `${item.sku} is already packed in carton ${elsewhere.join(', ')}.`,
        });
      }
    }
  }
  refreshClaim(state, req.userId);
  state.status = 'processing';
  state.scanned[item.sku] = (state.scanned[item.sku] || 0) + 1;
  addToActiveCarton(state, item.sku, 1);
  state.updated_at = new Date().toISOString();
  appendScanLog(state, { kind: 'scan', raw: String(req.body.sku || '').trim(), sku: item.sku, qty: state.scanned[item.sku], by: req.userId || '' });
  batch.orderStates[orderNumber] = state;
  journalOrderState(orderNumber, state);
  writeDb(db);
  res.json({ sku: item.sku, scanned_qty: state.scanned[item.sku], ordered_qty: item.qty, cartonNum: activeCarton(state).num, cartonCount: state.cartons.length });
});

// Big orders can take more than one physical box. The packer marks a carton
// full and starts the next one; every scan from here on tallies against the
// new carton until the order completes (which auto-closes the last one).
app.post('/api/scan/new-carton', (req, res) => {
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  const holder = claimBlocker(state, req.userId);
  if (holder) return res.status(409).json({ error: `Order is being packed by ${holder} at another station.` });
  const current = activeCarton(state);
  const currentCount = Object.values(current.scans).reduce((s, v) => s + v, 0);
  if (currentCount === 0) {
    return res.status(400).json({ error: 'Scan at least one item into this carton before starting a new one.' });
  }
  current.closedAt = new Date().toISOString();
  // Always a genuinely new carton, appended after whatever exists — even if
  // the packer had switched back to an earlier one to edit it. Use it to
  // reopen a past carton instead (/api/scan/carton/switch).
  const next = { num: Math.max(...state.cartons.map(c => c.num)) + 1, scans: {}, startedAt: new Date().toISOString(), closedAt: null };
  state.cartons.push(next);
  state.activeCartonNum = next.num;
  refreshClaim(state, req.userId);
  state.updated_at = new Date().toISOString();
  appendScanLog(state, { kind: 'new_carton', raw: '', sku: '', qty: '', by: req.userId || '' });
  batch.orderStates[orderNumber] = state;
  journalOrderState(orderNumber, state);
  writeDb(db);
  res.json({ ok: true, cartonCount: state.cartons.length, activeCartonNum: next.num });
});

// Reopen any existing carton (open OR previously closed) as the active one —
// "toggle through" cartons to add/remove items from an earlier box, then
// move on. Cartons are never reordered or renumbered by this; only which
// one is currently receiving scans changes. Existing contents/quantities
// are untouched here — it's purely a pointer change.
app.post('/api/scan/carton/switch', (req, res) => {
  const { orderNumber, cartonNum } = req.body;
  const num = parseInt(cartonNum, 10);
  if (!orderNumber || !num) return res.status(400).json({ error: 'orderNumber and cartonNum required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  const holder = claimBlocker(state, req.userId);
  if (holder) return res.status(409).json({ error: `Order is being packed by ${holder} at another station.` });
  activeCarton(state); // ensure cartons/pointer initialized before lookup
  const target = state.cartons.find(c => c.num === num);
  if (!target) return res.status(404).json({ error: `Carton ${num} not found.` });
  const current = state.cartons.find(c => c.num === state.activeCartonNum);
  if (current && current.num !== target.num && !current.closedAt) current.closedAt = new Date().toISOString();
  target.closedAt = null; // reopened
  state.activeCartonNum = target.num;
  refreshClaim(state, req.userId);
  state.updated_at = new Date().toISOString();
  appendScanLog(state, { kind: 'carton_switch', raw: '', sku: '', qty: '', by: req.userId || '' });
  batch.orderStates[orderNumber] = state;
  journalOrderState(orderNumber, state);
  writeDb(db);
  res.json({ ok: true, activeCartonNum: target.num, cartonCount: state.cartons.length });
});

// "Actually, it all fits in one box" — merges every carton's contents back
// into a single carton 1. Order-level scanned totals are untouched (they
// were already the sum across cartons); only the box-level breakdown
// collapses. Used when a packer starts splitting cartons, then decides
// they can squeeze everything into fewer boxes after all.
app.post('/api/scan/carton/cancel-multi', (req, res) => {
  const { orderNumber } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  const holder = claimBlocker(state, req.userId);
  if (holder) return res.status(409).json({ error: `Order is being packed by ${holder} at another station.` });
  if (!state.cartons || state.cartons.length <= 1) {
    return res.status(400).json({ error: 'This order is not split into multiple cartons.' });
  }
  const merged = {};
  let earliest = state.cartons[0].startedAt;
  for (const c of state.cartons) {
    for (const [sku, qty] of Object.entries(c.scans || {})) merged[sku] = (merged[sku] || 0) + qty;
    if (c.startedAt && c.startedAt < earliest) earliest = c.startedAt;
  }
  state.cartons = [{ num: 1, scans: merged, startedAt: earliest, closedAt: null }];
  state.activeCartonNum = 1;
  refreshClaim(state, req.userId);
  state.updated_at = new Date().toISOString();
  appendScanLog(state, { kind: 'carton_cancel_multi', raw: '', sku: '', qty: '', by: req.userId || '' });
  batch.orderStates[orderNumber] = state;
  journalOrderState(orderNumber, state);
  writeDb(db);
  res.json({ ok: true, cartonCount: 1, activeCartonNum: 1 });
});

// Records that the packer confirmed they wrote the carton label — persists
// carton.labelConfirmed so the prompt never fires twice for the same box,
// plus an audit-log entry. Never itself blocks the packer; the prompt (not
// this call) is what enforces the pause, so a failed request here never
// stalls the UI. Can fire before any scan (carton 1 is labelled the moment
// packing starts) — lazily creates order state exactly like a real scan
// would, but WITHOUT flipping status to "processing".
app.post('/api/scan/carton/label-confirmed', (req, res) => {
  const { orderNumber, cartonNum, label } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber required' });
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  const num = parseInt(cartonNum, 10) || 1;
  activeCarton(state); // lazily ensures state.cartons exists, same as any scan path
  let carton = state.cartons.find(c => c.num === num);
  if (!carton) { carton = { num, scans: {}, startedAt: new Date().toISOString(), closedAt: null }; state.cartons.push(carton); }
  carton.labelConfirmed = true;
  appendScanLog(state, { kind: 'carton_labeled', raw: String(label || '').trim(), sku: '', qty: '', by: req.userId || '' });
  batch.orderStates[orderNumber] = state;
  writeDb(db);
  res.json({ ok: true });
});

// Read-only — a single carton's contents for printing a per-box packing
// slip on the spot (distinct from the Waybill label and from the full
// multi-sheet completion slip). Defaults to the currently-open carton;
// pass ?cartonNum=N to reprint an earlier one. Purely additive: no state
// is written here, so it can't affect the scan/complete flow at all.
app.get('/api/scan/carton-slip/:orderNumber', (req, res) => {
  const { orderNumber } = req.params;
  const db    = readDb();
  const batch = findBatchForOrder(db, orderNumber);
  if (!batch) return res.status(404).json({ error: 'Order not found' });
  const ord   = batch.orders.find(o => o.order_number === orderNumber);
  const state = (batch.orderStates || {})[orderNumber] || {};
  const cartons = (state.cartons && state.cartons.length) ? state.cartons : [{ num: 1, scans: state.scanned || {} }];
  const requestedNum = parseInt(req.query.cartonNum, 10);
  const carton = requestedNum ? cartons.find(c => c.num === requestedNum) : cartons[cartons.length - 1];
  if (!carton) return res.status(404).json({ error: 'Carton not found' });
  const items = Object.entries(carton.scans || {})
    .filter(([, qty]) => qty > 0)
    .map(([sku, qty]) => {
      const line = uniqueSkuLines(ord).find(l => l.sku === sku);
      return { sku, description: line?.description || '', qty };
    });
  res.json({
    orderNumber,
    cartonNum:    carton.num,
    cartonCount:  cartons.length,
    customerName: ord.customer_name || '',
    clientName:   batch.client_name || ord.client_name || '',
    items,
  });
});

// ── IdealInbound — receiving (POs/ASNs and returns) ──────────────────────────
// The outbound picking flow scans a known order DOWN to zero remaining;
// receiving runs the same physical idea in reverse — goods arrive across one
// or more boxes/pallets and need their contents logged. Every inbound job
// lives in its own flat db.inbound[] record (no batch/order nesting — one
// upload or one "+ New Return" IS the job), but reuses the exact same carton
// primitives as outbound (`activeCarton`, `addToActiveCarton`, `appendScanLog`)
// since a box is a box regardless of which direction it's moving.
//
// Two job types:
//   'po'     — an uploaded PO/ASN file supplies expected SKU+qty per line;
//              receiving matches scans against it like outbound does, but
//              never blocks on an unlisted SKU (real shipments often include
//              something not on the paperwork — it's still logged, just with
//              no "expected" line to compare against).
//   'return' — no expected list at all. Created manually, scans are free-form,
//              and each scan carries a condition code (straight_to_inventory/
//              damaged/kiv) rolled up into state.conditionTotals.
function findInbound(db, id) {
  return (db.inbound || []).find(r => r.id === id);
}
// Auto-detects SKU / Description / Qty columns from an uploaded PO/ASN file.
// Deliberately independent of parseUploadedFile/detectColumnMap (lib/keyfields.js)
// — those are tuned for outbound picking lists (order_number, customer, address…)
// and would drag in columns receiving doesn't have or need.
// Best-effort generic ASN/PO PDF line parser. Unlike parsePdfPicklistDetailed
// (tuned to ONE known Keyfields layout with GI numbers / SNo sequence /
// "Grand Total Loose"), real-world ASN/PO PDFs vary supplier to supplier —
// this can only be a heuristic: look for lines shaped like
// "SKU  description text  qty" (SKU first token, integer qty last token).
// If it can't find any such lines it fails loudly rather than silently
// create a PO with wrong/missing lines — same "upload aborted, don't guess"
// safety philosophy the picking-list PDF parser already uses.
// NOTE: deliberately does NOT reuse the outbound picking-list's
// LOCATION_CODE_PAT filter — that pattern (1-4 letters + 1-6 digit groups)
// is exactly the shape of a completely ordinary SKU here (e.g. "URI-8001",
// "NUX-5450"), so applying it would reject legitimate SKUs. Location vs.
// SKU ambiguity is a real concern INSIDE a picking list (which prints both
// as separate columns); an ASN/PO PDF has no such second column to confuse
// it with.
const PDF_ITEM_LINE_PAT   = /^([A-Z0-9][A-Z0-9_\-\/]{1,29})\s+(.+?)\s+(\d{1,6})\s*$/i;
const PDF_SKU_SKIP_WORDS = new Set([
  'SKU', 'ITEM', 'CODE', 'DESCRIPTION', 'DESC', 'QTY', 'QUANTITY', 'PRODUCT',
  'PART', 'NO', 'PAGE', 'TOTAL', 'GRAND', 'DATE', 'PO', 'ASN', 'INVOICE',
  'REFERENCE', 'REF', 'SUPPLIER', 'SHIP', 'BILL', 'ORDER',
]);
async function parseAsnPdfFile(buffer) {
  if (!pdfParse) throw new Error('PDF parsing not installed. Run: npm install pdf-parse');
  const pageTexts = await extractPdfPageTexts(buffer);
  if (!pageTexts.length) {
    throw new Error('No readable pages in PDF — if this is a scanned image (no selectable text), use the XLSX/CSV upload instead.');
  }
  const out = [];
  for (const pageText of pageTexts) {
    for (const rawLine of pageText.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = line.match(PDF_ITEM_LINE_PAT);
      if (!m) continue;
      const sku = m[1].trim();
      const description = m[2].trim();
      const qty = parseInt(m[3], 10);
      if (PDF_SKU_SKIP_WORDS.has(sku.toUpperCase())) continue;
      if (!qty || qty <= 0 || qty > 99999) continue;
      if (!description) continue;
      out.push({ sku, description, qty });
    }
  }
  if (!out.length) {
    throw new Error('Could not recognize any SKU/description/qty lines in this PDF. This parser only handles simple text-based tables (SKU, then description, then quantity, left to right) — if the layout is different, or this is a scanned image, use the XLSX/CSV upload instead.');
  }
  return out;
}

async function parseInboundFile(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return parseAsnPdfFile(buffer);
  let rows;
  if (ext === '.csv') {
    rows = parse(buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  } else if (ext === '.xlsx' || ext === '.xls') {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } else {
    throw new Error('Unsupported file type. Upload XLSX, CSV, or PDF.');
  }
  if (!rows.length) return [];
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const SKU_KEYS  = new Set(['sku', 'productcode', 'itemcode', 'code']);
  const DESC_KEYS = new Set(['description', 'productdescription', 'itemdescription', 'productname', 'name']);
  const QTY_KEYS  = new Set(['qty', 'quantity', 'expectedqty', 'orderedqty', 'expectedquantity']);
  const headerKeys = Object.keys(rows[0]);
  const skuKey  = headerKeys.find(k => SKU_KEYS.has(norm(k)));
  const descKey = headerKeys.find(k => DESC_KEYS.has(norm(k)));
  const qtyKey  = headerKeys.find(k => QTY_KEYS.has(norm(k)));
  if (!skuKey) throw new Error('Could not find a SKU column. Expected a header like "SKU" or "Product Code".');
  const out = [];
  for (const r of rows) {
    const sku = String(r[skuKey] || '').trim();
    if (!sku) continue;
    const qty = qtyKey ? Math.max(0, parseInt(r[qtyKey], 10) || 0) : 0;
    out.push({ sku, description: descKey ? String(r[descKey] || '').trim() : '', qty });
  }
  return out;
}

app.get('/api/inbound', (req, res) => {
  const db = readDb();
  const list = (db.inbound || []).map(rec => {
    const state = rec.state || {};
    const expectedTotal = (rec.lines || []).reduce((s, l) => s + (l.expected_qty || 0), 0);
    const scannedTotal  = Object.values(state.scanned || {}).reduce((s, q) => s + q, 0);
    return {
      id:                rec.id,
      serial:            rec.serial || '',
      type:              rec.type,
      reference:         rec.reference || '',
      source_name:       rec.source_name || '',
      client_name:       rec.client_name || '',
      uploaded_at:       rec.uploaded_at,
      uploaded_by:       rec.uploaded_by,
      filename:          rec.filename || null,
      lines:             rec.lines || [],
      line_count:        (rec.lines || []).length,
      expected_total:    expectedTotal,
      scanned_total:     scannedTotal,
      status:            state.status || 'pending',
      scanned:           state.scanned || {},
      conditionTotals:   state.conditionTotals || {},
      cartons:           state.cartons || [],
      active_carton_num: state.activeCartonNum || (state.cartons && state.cartons.length ? state.cartons[state.cartons.length - 1].num : 1),
      startTime:         state.startTime || null,
      endTime:           state.endTime || null,
      photos:            (rec.photos || []).map(p => ({ id: p.id, sku: p.sku, caption: p.caption, uploadedAt: p.uploadedAt })),
      pending_deletion:  rec.pending_deletion || null,
    };
  });
  res.json(list);
});

// Attach a photo to a receiving job — optionally tagged to a SKU (e.g.
// photographing a damaged item right when it's scanned) or left untagged
// for a general shot of the box/shipment. Bytes are written to disk
// (INBOUND_PHOTO_DIR/<jobId>/<photoId>.<ext>) rather than into db.json,
// same reasoning as WMS/waybill files — keeps the JSON blob small.
app.post('/api/inbound/:id/photo', upload.single('photo'), (req, res) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
  const db  = readDb();
  const rec = findInbound(db, id);
  if (!rec) return res.status(404).json({ error: 'Inbound record not found' });

  const photoId = uuidv4();
  const ext = (path.extname(req.file.originalname || '') || '.jpg').toLowerCase();
  const dir = path.join(INBOUND_PHOTO_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${photoId}${ext}`), req.file.buffer);

  const photo = {
    id: photoId,
    filename: `${photoId}${ext}`,
    mimeType: req.file.mimetype,
    sku: (req.body.sku || '').trim() || null,
    caption: (req.body.caption || '').trim(),
    uploadedBy: req.userId || '',
    uploadedAt: new Date().toISOString(),
  };
  rec.photos = rec.photos || [];
  rec.photos.push(photo);
  writeDb(db);
  res.json({ ok: true, photo: { id: photo.id, sku: photo.sku, caption: photo.caption, uploadedAt: photo.uploadedAt } });
});

app.post('/api/inbound/upload', upload.single('inboundFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const rows = await parseInboundFile(req.file.buffer, req.file.originalname);
    if (!rows.length) return res.status(400).json({ error: 'No valid SKU rows found in file' });

    // Same SKU can legitimately appear on multiple rows (split across lots,
    // etc.) — merge into one expected line so scanning matches cleanly.
    const merged = new Map();
    for (const r of rows) {
      const cur = merged.get(r.sku) || { sku: r.sku, description: r.description, expected_qty: 0 };
      cur.expected_qty += r.qty;
      if (!cur.description && r.description) cur.description = r.description;
      merged.set(r.sku, cur);
    }

    const db = readDb();
    db.inbound = db.inbound || [];
    const rec = {
      id:          uuidv4(),
      serial:      nextInboundCode(db),
      type:        'po',
      reference:   (req.body?.reference   || '').trim(),
      source_name: (req.body?.source_name || '').trim(),
      client_name: (req.body?.client_name || '').trim(),
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.userId || '',
      filename:    req.file.originalname,
      lines:       [...merged.values()],
      state:       { status: 'pending', scanned: {}, scanLog: [] },
    };
    db.inbound.unshift(rec);
    writeDb(db);
    logAudit('inbound_upload', { id: rec.id, reference: rec.reference, by: req.userId || '', lines: rec.lines.length });
    res.json({ ok: true, id: rec.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/inbound/return', (req, res) => {
  const { reference, source_name, client_name } = req.body || {};
  const db = readDb();
  db.inbound = db.inbound || [];
  const rec = {
    id:          uuidv4(),
    serial:      nextInboundCode(db),
    type:        'return',
    reference:   String(reference   || '').trim(),
    source_name: String(source_name || '').trim(),
    client_name: String(client_name || '').trim(),
    uploaded_at: new Date().toISOString(),
    uploaded_by: req.userId || '',
    filename:    null,
    lines:       [],
    state:       { status: 'pending', scanned: {}, conditionTotals: {}, scanLog: [] },
  };
  db.inbound.unshift(rec);
  writeDb(db);
  logAudit('inbound_return_created', { id: rec.id, reference: rec.reference, by: req.userId || '' });
  res.json({ ok: true, id: rec.id });
});

const INBOUND_CONDITIONS = new Set(['straight_to_inventory', 'damaged', 'kiv']);
app.post('/api/inbound/:id/scan', (req, res) => {
  const { id } = req.params;
  const { code, qty, condition } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const db  = readDb();
  const rec = findInbound(db, id);
  if (!rec) return res.status(404).json({ error: 'Inbound record not found' });
  const state = rec.state = rec.state || { status: 'pending', scanned: {}, scanLog: [] };
  if (state.status === 'done') return res.status(409).json({ error: 'This receipt has already been ended — no further scans can be logged.' });

  const inc = Math.max(1, parseInt(qty, 10) || 1);
  const raw = String(code).trim();
  let sku = raw, description = '';

  if (rec.type === 'po') {
    // Unlisted SKUs are still accepted — a shipment containing something not
    // on the paperwork shouldn't block the receiver; it just has no
    // "expected" line to compare against on the receiving screen.
    const line = (rec.lines || []).find(l => l.sku.toUpperCase() === raw.toUpperCase());
    if (line) { sku = line.sku; description = line.description || ''; }
  }

  state.scanned = state.scanned || {};
  state.scanned[sku] = (state.scanned[sku] || 0) + inc;
  addToActiveCarton(state, sku, inc);

  if (rec.type === 'return') {
    const cond = INBOUND_CONDITIONS.has(condition) ? condition : 'straight_to_inventory';
    state.conditionTotals = state.conditionTotals || {};
    state.conditionTotals[sku] = state.conditionTotals[sku] || { straight_to_inventory: 0, damaged: 0, kiv: 0 };
    state.conditionTotals[sku][cond] += inc;
    appendScanLog(state, { kind: 'scan', raw, sku, qty: inc, condition: cond, by: req.userId || '' });
  } else {
    appendScanLog(state, { kind: 'scan', raw, sku, qty: inc, by: req.userId || '' });
  }

  if (state.status === 'pending') { state.status = 'processing'; state.startTime = new Date().toISOString(); }
  state.updated_at = new Date().toISOString();
  rec.state = state;
  writeDb(db);

  const carton = activeCarton(state);
  res.json({ ok: true, sku, description, scanned_qty: state.scanned[sku], cartonNum: carton.num, cartonCount: state.cartons.length });
});

app.post('/api/inbound/:id/new-carton', (req, res) => {
  const { id } = req.params;
  const db  = readDb();
  const rec = findInbound(db, id);
  if (!rec) return res.status(404).json({ error: 'Inbound record not found' });
  const state = rec.state = rec.state || {};
  const current = activeCarton(state);
  if (!Object.keys(current.scans || {}).length) {
    return res.status(400).json({ error: 'Current carton is empty — scan at least one item before starting a new one.' });
  }
  current.closedAt = new Date().toISOString();
  const nextNum = Math.max(...state.cartons.map(c => c.num)) + 1;
  const next = { num: nextNum, scans: {}, startedAt: new Date().toISOString(), closedAt: null };
  state.cartons.push(next);
  state.activeCartonNum = nextNum;
  rec.state = state;
  writeDb(db);
  res.json({ ok: true, cartonCount: state.cartons.length, activeCartonNum: next.num });
});

app.post('/api/inbound/:id/carton/switch', (req, res) => {
  const { id } = req.params;
  const { cartonNum } = req.body;
  const db  = readDb();
  const rec = findInbound(db, id);
  if (!rec) return res.status(404).json({ error: 'Inbound record not found' });
  const state = rec.state = rec.state || {};
  activeCarton(state);
  const target = state.cartons.find(c => c.num === parseInt(cartonNum, 10));
  if (!target) return res.status(404).json({ error: 'Carton not found' });
  state.activeCartonNum = target.num;
  rec.state = state;
  writeDb(db);
  res.json({ ok: true, activeCartonNum: target.num, cartonCount: state.cartons.length });
});

app.post('/api/inbound/:id/carton/cancel-multi', (req, res) => {
  const { id } = req.params;
  const db  = readDb();
  const rec = findInbound(db, id);
  if (!rec) return res.status(404).json({ error: 'Inbound record not found' });
  const state = rec.state = rec.state || {};
  if (!state.cartons || state.cartons.length <= 1) return res.status(400).json({ error: 'This job was never split into multiple cartons.' });
  const merged = {};
  let earliest = state.cartons[0].startedAt;
  for (const c of state.cartons) {
    for (const [sku, qty] of Object.entries(c.scans || {})) merged[sku] = (merged[sku] || 0) + qty;
    if (c.startedAt < earliest) earliest = c.startedAt;
  }
  state.cartons = [{ num: 1, scans: merged, startedAt: earliest, closedAt: null }];
  state.activeCartonNum = 1;
  rec.state = state;
  writeDb(db);
  res.json({ ok: true, cartonCount: 1, activeCartonNum: 1 });
});

app.post('/api/inbound/:id/carton/label-confirmed', (req, res) => {
  const { id } = req.params;
  const { cartonNum, label } = req.body;
  const db  = readDb();
  const rec = findInbound(db, id);
  if (!rec) return res.status(404).json({ error: 'Inbound record not found' });
  const state = rec.state = rec.state || {};
  const num = parseInt(cartonNum, 10) || 1;
  activeCarton(state);
  let carton = state.cartons.find(c => c.num === num);
  if (!carton) { carton = { num, scans: {}, startedAt: new Date().toISOString(), closedAt: null }; state.cartons.push(carton); }
  carton.labelConfirmed = true;
  appendScanLog(state, { kind: 'carton_labeled', raw: String(label || '').trim(), sku: '', qty: '', by: req.userId || '' });
  rec.state = state;
  writeDb(db);
  res.json({ ok: true });
});

// Ends receiving on this job — the ONLY thing that locks it read-only.
// Until this is called, the job stays open for repeated Receive sessions
// (status pending/processing both show "Receive" in the list; nothing else
// ever sets status to 'done'), so a packer can always come back and log more
// scans across as many visits as needed.
//
// PO/ASN end-receipt surfaces mismatches (over/under vs expected, plus any
// unlisted SKU that was scanned) but never hard-blocks like outbound does —
// receiving discrepancies are routine and must still be logged, not stuck.
// Pass {force:true} once the receiver has seen the mismatch list and chosen
// to end receiving anyway. Returns are never checked (no expected qty to compare).
app.post('/api/inbound/:id/end-receipt', (req, res) => {
  const { id } = req.params;
  const { force } = req.body || {};
  const db  = readDb();
  const rec = findInbound(db, id);
  if (!rec) return res.status(404).json({ error: 'Inbound record not found' });
  const state = rec.state = rec.state || {};
  if (state.status === 'done') return res.status(409).json({ error: 'This receipt has already been ended.' });

  if (rec.type === 'po' && !force) {
    const mismatches = (rec.lines || [])
      .map(l => ({ sku: l.sku, description: l.description, expected_qty: l.expected_qty, scanned_qty: (state.scanned || {})[l.sku] || 0 }))
      .filter(m => m.scanned_qty !== m.expected_qty);
    const extras = Object.entries(state.scanned || {})
      .filter(([sku]) => !(rec.lines || []).some(l => l.sku === sku))
      .map(([sku, qty]) => ({ sku, scanned_qty: qty }));
    if (mismatches.length || extras.length) return res.status(409).json({ needsConfirm: true, mismatches, extras });
  }

  if (state.cartons && state.cartons.length) {
    const last = state.cartons[state.cartons.length - 1];
    if (state.cartons.length > 1 && !Object.keys(last.scans || {}).length) state.cartons.pop();
    const closeTime = new Date().toISOString();
    for (const c of state.cartons) if (!c.closedAt) c.closedAt = closeTime;
  }

  state.status  = 'done';
  state.endTime = new Date().toISOString();
  rec.state = state;
  writeDb(db);
  logAudit('inbound_end_receipt', { id: rec.id, jobType: rec.type, reference: rec.reference, by: req.userId || '' });
  res.json({ ok: true });
});

// Read-only per-carton receiving slip — mirrors the outbound carton-slip.
app.get('/api/inbound/:id/carton-slip', (req, res) => {
  const { id } = req.params;
  const db  = readDb();
  const rec = findInbound(db, id);
  if (!rec) return res.status(404).json({ error: 'Inbound record not found' });
  const state = rec.state || {};
  const cartons = (state.cartons && state.cartons.length) ? state.cartons : [{ num: 1, scans: state.scanned || {} }];
  const requestedNum = parseInt(req.query.cartonNum, 10);
  const carton = requestedNum ? cartons.find(c => c.num === requestedNum) : cartons[cartons.length - 1];
  if (!carton) return res.status(404).json({ error: 'Carton not found' });
  const items = Object.entries(carton.scans || {})
    .filter(([, qty]) => qty > 0)
    .map(([sku, qty]) => {
      const line = (rec.lines || []).find(l => l.sku === sku);
      return { sku, description: line?.description || '', qty };
    });
  res.json({
    id: rec.id, type: rec.type, reference: rec.reference || '',
    sourceName: rec.source_name || '', clientName: rec.client_name || '',
    cartonNum: carton.num, cartonCount: cartons.length, items,
  });
});

// ── Inbound deletion — mirrors the outbound Orders workflow exactly ─────────
// IdealInbound has no batch/order two-layer split (one upload or one
// "+ New Return" IS the whole job — see the module note above), so there's
// no separate "delete the whole batch" vs "delete one record" distinction
// to preserve: each db.inbound[] entry already plays both roles. One
// deletion path, same two ways in as outbound orders:
//   (1) Master deletes directly — DELETE /api/master/inbound/:id
//   (2) Admin requests (own password + reason) — Master approves/rejects
// Both block once the job is 'done', same rule outbound orders use.
function removeInboundRecord(db, id) {
  const idx = (db.inbound || []).findIndex(r => r.id === id);
  if (idx === -1) return null;
  const [victim] = db.inbound.splice(idx, 1);
  try { fs.rmSync(path.join(INBOUND_PHOTO_DIR, id), { recursive: true, force: true }); } catch {}
  return victim;
}

app.delete('/api/master/inbound/:id', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { id } = req.params;
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to delete this record.' });
  const db  = readDb();
  const rec = findInbound(db, id);
  if (!rec) return res.status(404).json({ error: 'Inbound record not found' });
  if ((rec.state || {}).status === 'done') {
    return res.status(403).json({ error: 'This record is completed and can no longer be deleted.' });
  }
  removeInboundRecord(db, id);
  writeDb(db);
  logAudit('inbound_deleted', { id, reference: rec.reference || '', jobType: rec.type, client: rec.client_name || '', by: req.userId || 'master', reason });
  res.json({ ok: true });
});

app.post('/api/inbound/:id/deletion-request', (req, res) => {
  const { id } = req.params;
  const { reason, password } = req.body || {};
  const reasonTrim = String(reason || '').trim();
  if (!reasonTrim) return res.status(400).json({ error: 'A reason is required to request deletion.' });
  const user = readUsers().find(u => u.id === req.userId);
  if (!user) return res.status(401).json({ error: 'Session user not found.' });
  if ((user.role || 'admin') !== 'admin') {
    return res.status(403).json({ error: 'Only Admin users can request deletion.' });
  }
  if (!password || hashPass(String(password), user.salt) !== user.passwordHash) {
    // 403, not 401 — the session token is still valid; only this re-entered
    // password check failed (same reasoning as the outbound order-deletion
    // request: a 401 here would trip the client's global session-expired
    // handler and force-reload the page).
    return res.status(403).json({ error: 'Incorrect password.' });
  }
  const db  = readDb();
  const rec = findInbound(db, id);
  if (!rec) return res.status(404).json({ error: 'Inbound record not found' });
  if ((rec.state || {}).status === 'done') {
    return res.status(403).json({ error: 'This record is completed and can no longer be deleted.' });
  }
  if (rec.pending_deletion) {
    return res.status(409).json({ error: 'A deletion request is already pending for this record.' });
  }
  rec.pending_deletion = { reason: reasonTrim, requestedBy: req.userId, requestedAt: new Date().toISOString() };
  writeDb(db);
  logAudit('inbound_deletion_requested', { id, reference: rec.reference || '', jobType: rec.type, client: rec.client_name || '', by: req.userId || '', reason: reasonTrim });
  res.json({ ok: true });
});

app.get('/api/master/inbound-pending-deletions', (req, res) => {
  if (!checkMaster(req, res)) return;
  const db      = readDb();
  const nameFor = (() => {
    const byId = new Map(readUsers().map(u => [u.id, u.name || u.id]));
    return uid => byId.get(uid) || uid || '(unknown)';
  })();
  const out = (db.inbound || [])
    .filter(rec => rec.pending_deletion)
    .map(rec => ({
      id:              rec.id,
      type:            rec.type,
      reference:       rec.reference || '',
      client:          rec.client_name || '',
      reason:          rec.pending_deletion.reason,
      requestedBy:     rec.pending_deletion.requestedBy,
      requestedByName: nameFor(rec.pending_deletion.requestedBy),
      requestedAt:     rec.pending_deletion.requestedAt,
      scannedTotal:    Object.values((rec.state || {}).scanned || {}).reduce((s, q) => s + q, 0),
      expectedTotal:   (rec.lines || []).reduce((s, l) => s + (l.expected_qty || 0), 0),
    }))
    .sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt))); // oldest-waiting first
  res.json(out);
});

app.post('/api/master/inbound-pending-deletions/:id/approve', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { id } = req.params;
  const db  = readDb();
  const rec = findInbound(db, id);
  if (!rec || !rec.pending_deletion) return res.status(404).json({ error: 'No pending deletion request for this record.' });
  const pending = rec.pending_deletion;
  removeInboundRecord(db, id);
  writeDb(db);
  logAudit('inbound_deleted', {
    id, reference: rec.reference || '', jobType: rec.type, client: rec.client_name || '',
    by: req.userId || 'master', reason: pending.reason, requestedBy: pending.requestedBy,
  });
  res.json({ ok: true });
});

app.post('/api/master/inbound-pending-deletions/:id/reject', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { id } = req.params;
  const note = String(req.body?.note || '').trim();
  const db  = readDb();
  const rec = findInbound(db, id);
  if (!rec || !rec.pending_deletion) return res.status(404).json({ error: 'No pending deletion request for this record.' });
  const pending = rec.pending_deletion;
  delete rec.pending_deletion;
  writeDb(db);
  logAudit('inbound_deletion_rejected', {
    id, reference: rec.reference || '', jobType: rec.type, client: rec.client_name || '',
    by: req.userId || 'master', requestedBy: pending.requestedBy, reason: pending.reason, note,
  });
  res.json({ ok: true });
});

// Teach-on-scan: packer confirms an unrecognized product barcode belongs to
// one of the order's lines. Stores the mapping (audit-logged, master-reviewable)
// and counts the piece in the same call so packing never stalls.
// ── Transport Management (TMS Importer) ────────────────────────────────────────
// Import delivery schedules (BETIME, Outright) and manage transport requests.
const tmsImporter = require('./lib/tms-importer.js');

app.get('/api/transport', (req, res) => {
  const db = readDb();
  const transportRequests = (db.transport || []).map(req => ({
    id: req.id,
    referenceId: req.referenceId || req.clientId || '',
    clientName: req.clientName,
    status: req.status || 'pending',
    createdAt: req.createdAt,
    items: req.items || [],
    shipping: req.shipping || {},
    assignedDriver: req.assignedDriver || '',
    assignedDriverName: req.assignedDriverName || '',
    routeNum: req.routeNum || null,
    stopSeq: req.stopSeq || null,
    packages: req.packages || 1,
    plannedAt: req.plannedAt || null,
    deliveredAt: req.deliveredAt || null,
    podRemarks: req.podRemarks || '',
    pendingDeletion: !!req.pending_deletion
  }));
  res.json(transportRequests);
});

app.post('/api/transport', (req, res) => {
  const db = readDb();
  if (!db.transport) db.transport = [];

  const newRequest = {
    id: `TRN-${Date.now()}`,
    clientName: req.body?.clientName || 'New Request',
    status: 'pending',
    createdAt: new Date().toISOString(),
    items: req.body?.items || [],
    shipping: req.body?.shipping || {},
    source: { manual: true }
  };

  db.transport.push(newRequest);
  _persistDb(db);
  logAudit('transport_created', { id: newRequest.id, client: newRequest.clientName });
  res.json(newRequest);
});

// TMS Import — Unified transport import (handles any file format via attribute-based detection)
// Must come before :id route to prevent "import" from being treated as an ID
app.post('/api/transport/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const db = readDb();
    const sheets = tmsImporter.parseExcelFile(req.file.buffer);
    const firstSheet = sheets[Object.keys(sheets)[0]] || [];

    if (!Array.isArray(firstSheet) || firstSheet.length === 0) {
      return res.status(400).json({ error: 'No data found in file' });
    }

    // Use attribute-based detection to handle any format
    const customers = tmsImporter.importBetimeDeliveries(firstSheet);

    if (customers.length === 0) {
      // Fallback to outright format if betime didn't work
      const orders = tmsImporter.importOutrightOrders(firstSheet);
      if (orders.length === 0) {
        return res.status(400).json({ error: 'Could not parse file — no valid delivery or order records found' });
      }
      const result = tmsImporter.createOrdersFromImport({ customers: orders }, db);
      applyAddressBookToTransport(db); // fill address/postal from the Address Book
      _persistDb(db);
      logAudit('tms_import', {
        ordersCreated: result.created.length,
        ordersUpdated: result.updated.length,
        skipped: result.skipped?.length || 0,
        detectedFormat: 'outright'
      });
      return res.json({
        success: true,
        imported: {
          ordersCreated: result.created.length,
          ordersUpdated: result.updated.length,
          skipped: result.skipped?.length || 0,
          createdOrders: result.created.slice(0, 10),
          summary: `Imported ${result.created.length} orders from file`
        }
      });
    }

    // Process deliveries with attribute-based parsing
    const result = tmsImporter.createOrdersFromImport({ customers }, db);
    applyAddressBookToTransport(db); // fill address/postal from the Address Book
    _persistDb(db);
    logAudit('tms_import', {
      ordersCreated: result.created.length,
      ordersUpdated: result.updated.length,
      skipped: result.skipped?.length || 0,
      detectedFormat: 'delivery'
    });

    res.json({
      success: true,
      imported: {
        ordersCreated: result.created.length,
        ordersUpdated: result.updated.length,
        skipped: result.skipped?.length || 0,
        createdOrders: result.created.slice(0, 10),
        summary: `Imported ${result.created.length} deliveries from file`
      }
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Fix Schedule Management — Define routing constraints per day
// Must come before :id route to prevent "fix-schedule" from being treated as an ID
app.get('/api/transport/fix-schedule', (req, res) => {
  const db = readDb();
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const schedules = {};

  for (const day of days) {
    schedules[day] = db.fixSchedules?.[day] || { enabled: false, day, priorityAreas: [] };
  }

  res.json(schedules);
});

app.post('/api/transport/fix-schedule/:day', (req, res) => {
  const { day } = req.params;
  const { enabled, priorityAreas } = req.body || {};
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  if (!days.includes(day)) {
    return res.status(400).json({ error: `Invalid day: ${day}` });
  }

  const db = readDb();
  if (!db.fixSchedules) db.fixSchedules = {};

  db.fixSchedules[day] = {
    day,
    enabled: enabled === true,
    priorityAreas: Array.isArray(priorityAreas) ? priorityAreas : [],
    updatedAt: new Date().toISOString()
  };

  _persistDb(db);
  logAudit('fix_schedule_updated', { day, enabled, areasCount: priorityAreas?.length || 0 });

  res.json(db.fixSchedules[day]);
});

// Approve a route plan — assigns drivers to jobs and marks them PREPLANNED.
// Jobs stay preplanned until warehouse scanning completes the matching order,
// at which point updateTransportOnOrderCompletion() flips them to CONFIRMED.
// Must come before the :id route.
app.post('/api/transport/plan/approve', (req, res) => {
  const { assignments } = req.body || {};
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return res.status(400).json({ error: 'assignments array required' });
  }

  const db = readDb();
  if (!db.transport) db.transport = [];

  let assigned = 0;
  const notFound = [];
  for (const a of assignments) {
    const rec = db.transport.find(r => r.id === a.id);
    if (!rec) { notFound.push(a.id); continue; }
    // Never regress a job that scanning already confirmed/delivered
    if (rec.status === 'confirmed' || rec.status === 'delivered') continue;
    rec.status = 'preplanned';
    rec.assignedDriver = a.driverId || '';
    rec.assignedDriverName = a.driverName || '';
    rec.routeNum = a.route || null;
    rec.stopSeq = a.stopSeq || null;
    rec.plannedAt = new Date().toISOString();
    assigned++;
  }

  _persistDb(db);
  logAudit('transport_plan_approved', {
    jobs: assigned,
    drivers: [...new Set(assignments.map(a => a.driverName).filter(Boolean))].length,
    notFound: notFound.length
  });

  res.json({ success: true, assigned, notFound });
});

// Export the CURRENT route plan as a two-sheet Excel workbook: a per-driver
// summary + full route details (PO, address, postal, cartons, driver).
// The client posts the plan exactly as displayed. Before the :id routes.
app.post('/api/transport/plan/export', (req, res) => {
  const { rows = [], depot = '', generatedAt = '' } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No plan rows to export' });

  const wb = XLSX.utils.book_new();

  // Sheet 1 — per-driver summary
  const byDriver = new Map();
  for (const r of rows) {
    const key = r.driverName || '— Unassigned —';
    const d = byDriver.get(key) || { phone: r.driverPhone || '', plate: r.driverPlate || '', vehicle: r.driverVehicle || '',
                                     routes: new Set(), drops: 0, cartons: 0, km: new Map() };
    d.routes.add(r.route);
    d.drops++;
    d.cartons += Number(r.packages) || 1;
    d.km.set(r.route, Math.max(d.km.get(r.route) || 0, Number(r.cumKm) || 0));
    byDriver.set(key, d);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Route Plan Summary'],
    ['Generated', generatedAt || new Date().toISOString(), 'Pickup / depot', depot],
    [],
    ['Driver', 'Phone', 'Plate', 'Vehicle', 'Routes', 'Drops', 'Cartons', 'Depot → Last Drop (km)'],
    ...[...byDriver.entries()].map(([name, d]) => [
      name, d.phone, d.plate, d.vehicle,
      [...d.routes].sort((a, b) => a - b).join(', '), d.drops, d.cartons,
      Math.round([...d.km.values()].reduce((s, v) => s + v, 0) * 10) / 10,
    ]),
  ]), 'Plan Summary');

  // Sheet 2 — every stop with full details
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Route', 'Stop #', 'PO / Order Ref', 'Client / Store', 'Address', 'Postal', 'Cartons', 'Leg (km)', 'Cumulative (km)', 'Est (mins)', 'Driver', 'Driver Phone', 'Plate'],
    ...rows.map(r => [
      `Route ${r.route}`, r.stopSeq, r.ref || '', r.client || '', r.address || '', r.zip || '',
      Number(r.packages) || 1, Number(r.legKm) || 0, Number(r.cumKm) || 0, Number(r.estMin) || 0,
      r.driverName || '', r.driverPhone || '', r.driverPlate || '',
    ]),
  ]), 'Route Details');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Route_Plan_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buf);
});

// Delivery HISTORY — everything already delivered, filterable by date.
// (The Transport tab itself deliberately shows only today's workload.)
// Before the :id routes.
function deliveryHistoryRows(db, from, to) {
  const day = at => at ? sgDateStr(new Date(at)) : ''; // SGT calendar day
  return (db.transport || [])
    .filter(r => r.status === 'delivered' && day(r.deliveredAt) >= from && day(r.deliveredAt) <= to)
    .sort((a, b) => String(b.deliveredAt).localeCompare(String(a.deliveredAt)))
    .map(r => ({
      id: r.id,
      referenceId: r.referenceId || r.clientId || '',
      clientName: r.clientName || '',
      address: r.shipping?.addressLine1 || '',
      zip: r.shipping?.zip || '',
      packages: r.packages || 1,
      driver: r.assignedDriverName || '',
      deliveredAt: r.deliveredAt || '',
      podRemarks: r.podRemarks || '',
    }));
}

app.get('/api/transport/history', (req, res) => {
  const today = sgDateStr();
  const from = (req.query.from || '').slice(0, 10) || today;
  const to   = (req.query.to   || '').slice(0, 10) || today;
  res.json(deliveryHistoryRows(readDb(), from, to));
});

app.get('/api/transport/history/export', (req, res) => {
  const today = sgDateStr();
  const from = (req.query.from || '').slice(0, 10) || today;
  const to   = (req.query.to   || '').slice(0, 10) || today;
  const rows = deliveryHistoryRows(readDb(), from, to);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Delivery History', `${from} to ${to}`, `${rows.length} delivery(ies)`],
    [],
    ['Delivered At', 'TMS ID', 'PO / Order Ref', 'Client / Store', 'Address', 'Postal', 'Cartons', 'Driver', 'Status', 'POD Remarks'],
    ...rows.map(r => [
      r.deliveredAt ? new Date(r.deliveredAt).toLocaleString('en-SG') : '',
      r.id, r.referenceId, r.clientName, r.address, r.zip, r.packages, r.driver,
      r.podRemarks ? 'Delivered w/ Remarks' : 'Delivered',
      r.podRemarks,
    ]),
  ]), 'Delivery History');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Delivery_History_${from}_to_${to}.xlsx"`);
  res.send(buf);
});

// Batch status update — the office moves whole groups of jobs through the
// delivery lifecycle (Staging → On the road → Delivered[/w Remarks]) until
// a driver-side app takes over. Before the :id routes.
app.post('/api/transport/bulk-status', (req, res) => {
  const { ids, status, remarks } = req.body || {};
  const allowed = ['confirmed', 'in-transit', 'delivered'];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });

  const db = readDb();
  const now = new Date().toISOString();
  let updated = 0;
  for (const rec of db.transport || []) {
    if (!ids.includes(rec.id) || rec.status === 'cancelled') continue;
    rec.status = status;
    if (status === 'delivered') {
      if (!rec.deliveredAt) rec.deliveredAt = now;
      if (String(remarks || '').trim()) rec.podRemarks = String(remarks).trim();
    }
    rec.updatedAt = now;
    updated++;
  }
  _persistDb(db);
  logAudit('transport_bulk_status', { jobs: updated, status, withRemarks: !!String(remarks || '').trim(), by: req.userId || '' });
  res.json({ success: true, updated });
});

// Mark jobs DELIVERED — the office-side close-out for drivers who don't use
// the driver portal. Accepts explicit ids, or {allConfirmed:true} to close
// out every currently-confirmed job in one go (end-of-day sweep).
// Must come before the :id route.
app.post('/api/transport/mark-delivered', (req, res) => {
  const { ids, allConfirmed, remarks } = req.body || {};
  const db = readDb();
  if (!db.transport) db.transport = [];

  let targets;
  if (allConfirmed === true) {
    // end-of-day sweep: staging (confirmed) AND on-the-road (in-transit)
    targets = db.transport.filter(r => r.status === 'confirmed' || r.status === 'in-transit');
  } else if (Array.isArray(ids) && ids.length) {
    targets = db.transport.filter(r => ids.includes(r.id));
  } else {
    return res.status(400).json({ error: 'Provide ids array or allConfirmed:true' });
  }

  let delivered = 0;
  const now = new Date().toISOString();
  for (const rec of targets) {
    if (rec.status === 'delivered' || rec.status === 'cancelled') continue;
    rec.status = 'delivered';
    rec.deliveredAt = now;
    // Non-empty remarks = 'Delivered with Remarks' — an issue to follow up
    if (String(remarks || '').trim()) rec.podRemarks = String(remarks).trim();
    delivered++;
  }

  _persistDb(db);
  logAudit('transport_marked_delivered', { jobs: delivered, mode: allConfirmed ? 'all-confirmed' : 'ids', by: req.userId || '' });
  res.json({ success: true, delivered });
});

// ── Drivers — the shared fleet list ──────────────────────────────────────────
// Server-side (db.drivers) so EVERY login/device sees the same drivers.
// (Was localStorage-only, which made drivers invisible from other logins.)
app.get('/api/drivers', (req, res) => {
  const db = readDb();
  // Never expose pin hashes/salts — every logged-in admin/warehouse user can
  // fetch this list for the assignment dropdowns.
  res.json((db.drivers || []).map(({ pinHash, pinSalt, ...d }) => ({ ...d, hasPin: !!pinHash })));
});

app.post('/api/drivers', (req, res) => {
  const { id, name, phone, vehicle, plate, capacity, capacityM3, status, pin } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Driver name is required' });
  const db = readDb();
  if (!db.drivers) db.drivers = [];
  const existing = db.drivers.find(d => d.id === id);
  const drv = {
    id: id || 'DRV-' + Date.now(),
    name: String(name).trim(),
    phone: String(phone || '').trim(),
    vehicle: String(vehicle || 'Van'),
    plate: String(plate || '').trim().toUpperCase(),
    capacity: Number(capacity) || 0,
    capacityM3: Number(capacityM3) || 0,
    status: status || 'active',
  };
  // PIN (Driver App login) — hashed like any other password; blank on edit
  // keeps whatever PIN is already set, exactly like the Zort key-blank rule.
  if (pin && String(pin).trim()) {
    const pinStr = String(pin).trim();
    if (!/^\d{4,8}$/.test(pinStr)) return res.status(400).json({ error: 'PIN must be 4-8 digits' });
    const pinSalt = crypto.randomBytes(16).toString('hex');
    drv.pinSalt = pinSalt;
    drv.pinHash = hashPass(pinStr, pinSalt);
  } else if (existing) {
    drv.pinSalt = existing.pinSalt;
    drv.pinHash = existing.pinHash;
  }
  const i = db.drivers.findIndex(d => d.id === drv.id);
  if (i >= 0) db.drivers[i] = { ...db.drivers[i], ...drv }; else db.drivers.push(drv);
  _persistDb(db);
  logAudit('driver_upsert', { driverId: drv.id, name: drv.name, pinChanged: !!(pin && String(pin).trim()), by: req.userId || '' });
  const { pinHash, pinSalt, ...pub } = db.drivers[i >= 0 ? i : db.drivers.length - 1];
  res.json({ ...pub, hasPin: !!pinHash });
});

app.delete('/api/drivers/:id', (req, res) => {
  const db = readDb();
  const before = (db.drivers || []).length;
  db.drivers = (db.drivers || []).filter(d => d.id !== req.params.id);
  if (db.drivers.length === before) return res.status(404).json({ error: 'Driver not found' });
  _persistDb(db);
  logAudit('driver_delete', { driverId: req.params.id, by: req.userId || '' });
  res.json({ success: true });
});

// All-time per-driver performance summary for the Administrator → Drivers
// "Performance Stats" tab — same computation as the Driver Performance
// report (kind='drivers'), just as JSON with no date range.
app.get('/api/drivers/performance', (req, res) => {
  const db = readDb();
  const { summary } = computeDriverPerformance(db, null, null);
  res.json({ drivers: summary });
});

// Portable roster export — the full db.drivers list as an Excel sheet, e.g.
// to hand off to (or import into) another system such as IDEALOMS. Secrets
// (pinHash/pinSalt) are NEVER included — only whether a PIN is set.
app.get('/api/drivers/export', (req, res) => {
  const db = readDb();
  const rows = (db.drivers || []).map(d => [
    d.id, d.name || '', d.phone || '', d.vehicle || '', d.plate || '',
    d.capacity || 0, d.capacityM3 || 0, d.status || 'active', d.pinHash ? 'Yes' : 'No',
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Driver ID', 'Name', 'Phone', 'Vehicle', 'Plate', 'Capacity (kg)', 'Capacity (m3)', 'Status', 'Driver App PIN Set'],
    ...rows,
  ]), 'Drivers');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="IDEALONE_Drivers_${sgDateStr()}.xlsx"`);
  logAudit('driver_roster_exported', { count: rows.length, by: req.userId || '' });
  res.send(buf);
});

// ── Address Book endpoints — maintain the store→address cross-reference ─────
app.get('/api/address-book', (req, res) => {
  const db = readDb();
  res.json(db.addressBook || []);
});

// Upsert one entry (matched by code, else by name)
app.post('/api/address-book', (req, res) => {
  const { code = '', name = '', address = '', zip = '', phone = '' } = req.body || {};
  if (!name.trim()) return res.status(400).json({ error: 'Store name is required' });
  if (zip && !/^\d{6}$/.test(String(zip).trim())) {
    return res.status(400).json({ error: 'Postal code must be exactly 6 digits' });
  }
  const db = readDb();
  if (!db.addressBook) db.addressBook = [];
  const i = db.addressBook.findIndex(e =>
    (String(code).trim() && _abNorm(e.code) === _abNorm(code)) || _abNorm(e.name) === _abNorm(name));
  // MERGE with any existing entry — a postal-only update (e.g. from the
  // delivery-detail editor) must not wipe the address/code/chain fields.
  const prev = i >= 0 ? db.addressBook[i] : {};
  const pick = (v, old) => String(v ?? '').trim() || old || '';
  const entry = {
    ...prev,
    code: pick(code, prev.code), name: pick(name, prev.name),
    address: pick(address, prev.address), zip: pick(zip, prev.zip), phone: pick(phone, prev.phone),
  };
  if (i >= 0) db.addressBook[i] = entry; else db.addressBook.push(entry);
  const jobsFixed = applyAddressBookToTransport(db);
  _persistDb(db);
  logAudit('address_book_upsert', { name: entry.name, jobsFixed, by: req.userId || '' });
  res.json({ success: true, entries: db.addressBook.length, jobsFixed });
});

app.delete('/api/address-book/:name', (req, res) => {
  const key = _abNorm(decodeURIComponent(req.params.name));
  const db = readDb();
  const before = (db.addressBook || []).length;
  db.addressBook = (db.addressBook || []).filter(e => _abNorm(e.name) !== key && _abNorm(e.code) !== key);
  if (db.addressBook.length === before) return res.status(404).json({ error: 'Entry not found' });
  _persistDb(db);
  logAudit('address_book_delete', { name: req.params.name, by: req.userId || '' });
  res.json({ success: true, entries: db.addressBook.length });
});

// Download the current list as XLSX (a ready-to-edit template when empty)
app.get('/api/address-book/export', (req, res) => {
  const db = readDb();
  const rows = (db.addressBook || []).length
    ? db.addressBook.map(e => ({ 'Store': e.chain || '', 'Branch Name': e.name || '',
        'Branch Code': e.code || '', 'Address': e.address || '',
        'Postal Code': e.zip || '', 'Phone': e.phone || '' }))
    : [{ 'Store': 'Watsons', 'Branch Name': 'NEX', 'Branch Code': 'NEX01',
        'Address': '23 Serangoon Central', 'Postal Code': '556083', 'Phone': '' }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Address Book');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Address_Book_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buf);
});

// Re-upload the (edited) list — REPLACES the whole book, then immediately
// re-resolves every transport job still missing a postal code.
app.post('/api/address-book/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]] || {});
    const norm = k => String(k).toLowerCase().replace(/[^a-z]/g, '');
    const entries = [];
    const badZips = [];
    for (const row of rows) {
      const get = (...names) => {
        for (const key of Object.keys(row)) if (names.includes(norm(key))) return String(row[key] ?? '').trim();
        return '';
      };
      // Branch-level name first (STORE_CODE_with_postal_code.xlsx layout:
      // Store=chain, Branch Name=the actual location); plain layouts after.
      const name = get('branchname', 'storename', 'name', 'customer', 'client') || get('store');
      if (!name) continue;
      const chainCol = get('store', 'chain', 'brand');
      const chain = chainCol && _abNorm(chainCol) !== _abNorm(name) ? chainCol : '';
      let zip = get('postalcode', 'postal', 'zip', 'zipcode');
      // Excel stores numeric postals as numbers — a leading zero is lost
      // (018945 → 18945). SG postals are exactly 6 digits: repair 5-digit
      // numerics by restoring the zero.
      if (/^\d{5}$/.test(zip)) zip = '0' + zip;
      if (zip && !/^\d{6}$/.test(zip)) { badZips.push(`${name}: "${zip}"`); continue; }
      entries.push({
        code: get('branchcode', 'storecode', 'code', 'id'),
        name,
        chain,
        address: get('address', 'addressline1', 'deliveryaddress', 'fulladdress'),
        zip,
        phone: get('phone', 'tel', 'contact'),
      });
    }
    if (!entries.length) {
      return res.status(400).json({ error: 'No valid rows found. Columns needed: Store Name (required), Address, Postal Code (6 digits), plus optional Store Code and Phone.' });
    }
    const db = readDb();
    db.addressBook = entries;
    const jobsFixed = applyAddressBookToTransport(db);
    _persistDb(db);
    logAudit('address_book_import', { entries: entries.length, skippedBadZip: badZips.length, jobsFixed, by: req.userId || '' });
    res.json({ success: true, entries: entries.length, jobsFixed,
      warnings: badZips.length ? [`${badZips.length} row(s) skipped — postal code not 6 digits: ${badZips.slice(0, 5).join('; ')}`] : [] });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Unresolved jobs + nearest Address Book suggestions — feeds the client's
// "confirm the closest match" resolver. Must come before the :id route.
app.get('/api/transport/unresolved-suggestions', (req, res) => {
  const db = readDb();
  const book = db.addressBook || [];
  const unresolved = (db.transport || []).filter(j =>
    !j.shipping?.zip && j.status !== 'delivered' && j.status !== 'cancelled');

  const out = unresolved.map(j => {
    const scored = book
      .map(e => ({ name: e.name, code: e.code || '', chain: e.chain || '', zip: e.zip || '', address: e.address || '',
                   score: Math.round(addressBookSimilarity(j.clientName || j.referenceId || '', e) * 100) }))
      .filter(x => x.zip && x.score >= 40)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    return { jobId: j.id, clientName: j.clientName || j.referenceId || '', suggestions: scored };
  });
  res.json(out);
});

// Confirming a fuzzy match LEARNS it: the misspelled variant is added to
// the Address Book as an alias of the confirmed store, then every job
// carrying that name resolves — now and on all future uploads.
app.post('/api/address-book/learn-alias', (req, res) => {
  const { alias, targetName } = req.body || {};
  if (!String(alias || '').trim() || !String(targetName || '').trim()) {
    return res.status(400).json({ error: 'alias and targetName required' });
  }
  const db = readDb();
  const target = (db.addressBook || []).find(e => _abNorm(e.name) === _abNorm(targetName) || _abNorm(e.code) === _abNorm(targetName));
  if (!target) return res.status(404).json({ error: `No Address Book entry named "${targetName}"` });
  if (!db.addressBook) db.addressBook = [];
  const aliasName = String(alias).trim();
  const exists = db.addressBook.some(e => _abNorm(e.name) === _abNorm(aliasName));
  if (!exists) {
    db.addressBook.push({
      code: '', name: aliasName, chain: '',
      address: target.address || '', zip: target.zip || '', phone: target.phone || '',
      aliasOf: target.name, learnedAt: new Date().toISOString(), learnedBy: req.userId || '',
    });
  }
  const jobsFixed = applyAddressBookToTransport(db);
  _persistDb(db);
  logAudit('address_book_alias_learned', { alias: aliasName, target: target.name, jobsFixed, by: req.userId || '' });
  res.json({ success: true, jobsFixed, target: { name: target.name, zip: target.zip } });
});

// Transport job deletion — ADMIN ROLE (or master key) only. Warehouse users
// get a real 403 even calling the endpoint directly, mirroring the report
// access pattern. Deletions are audit-logged with who/what/how many.
function requireTransportAdmin(req, res) {
  if (req.headers['x-master-key'] === MASTER_PASS) return true;
  const role = readUsers().find(u => u.id === req.userId)?.role;
  if (role !== 'admin') {
    res.status(403).json({ error: 'Administrator access required to delete transport jobs' });
    return false;
  }
  return true;
}

// Bulk delete — {ids:[...]} for selected jobs, {all:true} wipes every job
// (clearing test imports / starting fresh). Must come before the :id route.
app.post('/api/transport/bulk-delete', (req, res) => {
  if (!requireTransportAdmin(req, res)) return;
  const { ids, all } = req.body || {};
  const db = readDb();
  if (!db.transport) db.transport = [];
  const before = db.transport.length;

  if (all === true) {
    db.transport = [];
  } else if (Array.isArray(ids) && ids.length) {
    db.transport = db.transport.filter(r => !ids.includes(r.id));
  } else {
    return res.status(400).json({ error: 'Provide ids array or all:true' });
  }

  const deleted = before - db.transport.length;
  _persistDb(db);
  logAudit('transport_deleted', { jobs: deleted, mode: all === true ? 'all' : 'ids', by: req.userId || '' });
  res.json({ success: true, deleted });
});

// Route START LOCATION (depot) — where drivers pick up cargo. Defaults to
// the IDEALONE warehouse; changeable from the planner and shared across
// users. Must be registered before the :id routes.
const DEFAULT_TRANSPORT_DEPOT = { name: 'IDEALONE Warehouse', address: '40 Penjuru Lane #04-01', zip: '609216' };
function getTransportDepot(db) {
  return { ...DEFAULT_TRANSPORT_DEPOT, ...(db.transportDepot || {}) };
}
app.get('/api/transport/depot', (req, res) => {
  res.json(getTransportDepot(readDb()));
});
app.post('/api/transport/depot', (req, res) => {
  const { address = '', zip = '', name = '' } = req.body || {};
  if (!/^\d{6}$/.test(String(zip).trim())) {
    return res.status(400).json({ error: 'Postal code must be exactly 6 digits' });
  }
  const db = readDb();
  db.transportDepot = {
    name: String(name).trim() || DEFAULT_TRANSPORT_DEPOT.name,
    address: String(address).trim(),
    zip: String(zip).trim(),
  };
  _persistDb(db);
  logAudit('transport_depot_updated', { ...db.transportDepot, by: req.userId || '' });
  res.json(db.transportDepot);
});

// Route templates — SHARED across users (db.transportTemplates), was
// localStorage-only. Must be registered before the :id routes.
app.get('/api/transport/templates', (req, res) => {
  const db = readDb();
  res.json(db.transportTemplates || {});
});
app.post('/api/transport/templates', (req, res) => {
  const { name, data } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Template name required' });
  const db = readDb();
  if (!db.transportTemplates) db.transportTemplates = {};
  db.transportTemplates[String(name).trim()] = { ...(data || {}), savedAt: new Date().toISOString(), savedBy: req.userId || '' };
  _persistDb(db);
  logAudit('transport_template_saved', { template: String(name).trim(), by: req.userId || '' });
  res.json({ success: true });
});
app.delete('/api/transport/templates/:name', (req, res) => {
  const db = readDb();
  const name = decodeURIComponent(req.params.name);
  if (!db.transportTemplates?.[name]) return res.status(404).json({ error: 'Template not found' });
  delete db.transportTemplates[name];
  _persistDb(db);
  logAudit('transport_template_deleted', { template: name, by: req.userId || '' });
  res.json({ success: true });
});

// Generic transport record endpoints — must come after specific routes
app.get('/api/transport/:id', (req, res) => {
  const db = readDb();
  const req_data = (db.transport || []).find(r => r.id === req.params.id);
  if (!req_data) return res.status(404).json({ error: 'Transport request not found' });
  res.json(req_data);
});

app.delete('/api/transport/:id', (req, res) => {
  if (!requireTransportAdmin(req, res)) return;
  const db = readDb();
  const idx = (db.transport || []).findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Transport request not found' });
  const victim = db.transport.splice(idx, 1)[0];
  _persistDb(db);
  logAudit('transport_deleted', { jobs: 1, mode: 'single', id: victim.id, client: victim.clientName || '', by: req.userId || '' });
  res.json({ success: true, deleted: 1 });
});

app.post('/api/transport/:id/update', (req, res) => {
  const db = readDb();
  const request = (db.transport || []).find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Transport request not found' });

  const updates = req.body || {};
  if (updates.status) request.status = updates.status;
  if (updates.clientName) request.clientName = updates.clientName;
  if (updates.shipping) request.shipping = { ...request.shipping, ...updates.shipping };
  if (updates.notes !== undefined) request.notes = updates.notes;
  if (updates.podRemarks !== undefined) request.podRemarks = String(updates.podRemarks || '');
  if (updates.packages !== undefined) request.packages = Number(updates.packages) || 1;
  // Assigning a driver outside the planner (bulk assign / edit modal) —
  // moves the job to preplanned unless a status was explicitly given,
  // and never regresses a confirmed/delivered job.
  if (updates.assignedDriver !== undefined) {
    request.assignedDriver = updates.assignedDriver || '';
    request.assignedDriverName = updates.assignedDriverName || '';
    if (!updates.status && updates.assignedDriver &&
        request.status !== 'confirmed' && request.status !== 'delivered') {
      request.status = 'preplanned';
      request.plannedAt = new Date().toISOString();
    }
  }

  request.updatedAt = new Date().toISOString();
  _persistDb(db);
  logAudit('transport_updated', { id: request.id, status: request.status, by: req.userId || '' });
  res.json(request);
});

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
  addToActiveCarton(state, item.sku, 1);
  state.updated_at = new Date().toISOString();
  appendScanLog(state, { kind: 'teach', raw: bc, sku: item.sku, qty: state.scanned[item.sku], by: req.userId || '' });
  batch.orderStates[orderNumber] = state;
  journalOrderState(orderNumber, state);
  writeDb(db);
  res.json({ ok: true, sku: item.sku, scanned_qty: state.scanned[item.sku], ordered_qty: item.qty, barcode: bc, learned: learnedKind, cartonNum: activeCarton(state).num, cartonCount: state.cartons.length });
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
  const prevQty = state.scanned[item.sku] || 0;
  state.scanned[item.sku] = qn;
  addToActiveCarton(state, item.sku, qn - prevQty); // manual correction — nudge the open carton by the delta
  state.updated_at = new Date().toISOString();
  appendScanLog(state, { kind: 'count', raw: '', sku: item.sku, qty: state.scanned[item.sku], by: req.userId || '' });
  batch.orderStates[orderNumber] = state;
  journalOrderState(orderNumber, state);
  writeDb(db);
  res.json({ sku: item.sku, scanned_qty: state.scanned[item.sku], ordered_qty: item.qty, cartonNum: activeCarton(state).num, cartonCount: state.cartons.length });
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
    if (state.cartons && state.cartons.length) {
      const last = state.cartons[state.cartons.length - 1];
      // A stray "New Carton" tap with nothing scanned into it yet (e.g. the
      // packer's last action before Complete) shouldn't leave a phantom
      // empty carton on the slip — drop it rather than close it.
      if (state.cartons.length > 1 && Object.keys(last.scans).length === 0) {
        state.cartons.pop();
      }
      // Close every carton still open — covers the normal case (last one)
      // AND a packer who switched back to an earlier carton to edit it and
      // completed the order without switching forward again.
      const closeTime = new Date().toISOString();
      for (const c of state.cartons) if (!c.closedAt) c.closedAt = closeTime;
    }
    state.updated_at = new Date().toISOString();
    if (startTime) state.startTime = startTime;
    if (endTime)   state.endTime   = endTime;
    if (operator)  state.operator  = operator;
    batch.orderStates[orderNumber] = state;
    journalOrderState(orderNumber, state);
    updateTransportOnOrderCompletion(db, ord, state);
    writeDb(db);
    logAudit('order_completed', completionAuditData(batch, ord, state));
    // Zort-sourced order? Push the completion back to the client's store
    // (async, never blocks completion; failures are audit-logged).
    pushZortCompletion(db, ord, state);
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

// ── Wave Picking ─────────────────────────────────────────────────────────────
// "Consolidated pick, then sort": a packer selects 2+ pending orders, picks
// every SKU's TOTAL quantity across the whole wave once, then divides the
// scanned pile back into each order's required quantity on a sort screen.
// Wave progress (db.waves[]) is entirely separate from the real per-order
// orderStates until /complete — only then does allocated quantity land in
// each order's actual scanned totals (as if scanned individually), via the
// portable lib/wave-pick.js core. Completing a wave does NOT auto-complete
// orders — the packer still opens each one through the normal scan overlay
// to verify cartons and hit Complete, reusing all existing carton/mismatch/
// waybill logic with zero duplication.
function findWave(db, id) { return (db.waves || []).find(w => w.id === id); }

// ULD's bin location convention is Row-Bay-Location (AA-BB-CC, e.g.
// "99-001-011"). Row "99" is FLOOR level — no ladder/reach truck, the
// fastest pick a packer can make — so floor bins are grouped together
// AHEAD of every racked row, before the normal location+SKU ordering.
// Deliberately kept OUT of lib/wave-pick.js (which stays a generic, portable
// core with no site-specific location convention baked in) — this is a
// thin ULD-only re-sort applied right after the wave's pick list is built.
function uldLocationSortKey(location) {
  const loc = String(location || '').trim();
  if (!loc) return [2, '', '']; // no location data on this line — sort last
  const m = /^(\d{2,})-(\d{1,4})-(\d{1,4})/.exec(loc);
  if (!m) return [1, loc, '']; // doesn't match the Row-Bay-Location shape — sort with racked rows, by raw string
  const [, row, bay, locNum] = m;
  return [row === '99' ? 0 : 1, row.padStart(3, '0'), `${bay.padStart(4, '0')}-${locNum.padStart(4, '0')}`];
}
function sortPickListUldFloorFirst(pickList) {
  return [...pickList].sort((a, b) => {
    const ka = uldLocationSortKey(a.location), kb = uldLocationSortKey(b.location);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return a.sku.localeCompare(b.sku);
  });
}

app.post('/api/waves', (req, res) => {
  const orderNumbers = [...new Set((req.body.orderNumbers || []).map(String))];
  if (orderNumbers.length < 2) return res.status(400).json({ error: 'Select at least 2 orders to start a wave (1 order scans normally).' });
  const db = readDb();
  const orders = [];
  for (const orderNumber of orderNumbers) {
    const batch = findBatchForOrder(db, orderNumber);
    if (!batch) return res.status(404).json({ error: `Order "${orderNumber}" not found` });
    const state = (batch.orderStates || {})[orderNumber];
    if (state?.status === 'done') return res.status(409).json({ error: `Order ${orderNumber} is already completed` });
    const activeWave = (db.waves || []).find(w => w.status !== 'done' && w.status !== 'cancelled' && w.orderNumbers.includes(orderNumber));
    if (activeWave) return res.status(409).json({ error: `Order ${orderNumber} is already in wave ${activeWave.id}` });
    const ord = batch.orders.find(o => o.order_number === orderNumber);
    orders.push({ order_number: orderNumber, items: uniqueSkuLocationLines(ord).map(l => ({ sku: l.sku, description: l.description || '', qty: l.qty, location: l.location || '' })) });
  }
  const wave = wavePick.createWave({ id: nextWaveCode(db), orderNumbers, orders, createdBy: req.userId || '' });
  wave.pickList = sortPickListUldFloorFirst(wave.pickList);
  db.waves.unshift(wave);
  writeDb(db);
  logAudit('wave_created', { waveId: wave.id, orders: orderNumbers, by: req.userId || '' });
  res.json({ wave });
});

app.get('/api/waves', (req, res) => {
  const db = readDb();
  res.json((db.waves || []).map(w => ({
    id: w.id, createdAt: w.createdAt, createdBy: w.createdBy, status: w.status,
    orderNumbers: w.orderNumbers, skuCount: w.pickList.length,
    totalQty: w.pickList.reduce((s, e) => s + e.totalQty, 0),
    scannedQty: w.pickList.reduce((s, e) => s + e.scannedQty, 0),
  })));
});

app.get('/api/waves/:id', (req, res) => {
  const db = readDb();
  const wave = findWave(db, req.params.id);
  if (!wave) return res.status(404).json({ error: 'Wave not found' });
  res.json({ wave, allocationSummary: wavePick.allocationSummary(wave) });
});

app.post('/api/waves/:id/scan', (req, res) => {
  const db = readDb();
  const wave = findWave(db, req.params.id);
  if (!wave) return res.status(404).json({ error: 'Wave not found' });
  if (wave.status === 'done' || wave.status === 'cancelled') return res.status(409).json({ error: `Wave is ${wave.status}` });
  const sku = resolveBeTimeCode2(req.body.sku);
  const qty = Number(req.body.qty) || 1;
  const location = req.body.location ? String(req.body.location).trim() : '';
  if (!sku) return res.status(400).json({ error: 'sku required' });
  const result = wavePick.recordPickScan(wave, sku, qty, { by: req.userId || '', eventId: req.body.eventId || null, location });
  if (!result.ok) {
    if (result.reason === 'ambiguous_location') {
      return res.status(409).json({
        error: `SKU "${sku}" is stocked at ${result.options.length} different locations in this wave — pick which one you're at.`,
        ambiguousLocation: true, sku, options: result.options,
      });
    }
    return res.status(404).json({ error: `SKU "${sku}" is not part of this wave` });
  }
  wavePick.autoAllocate(wave);
  writeDb(db);
  res.json({ wave, entry: result.entry });
});

app.post('/api/waves/:id/finish-picking', (req, res) => {
  const db = readDb();
  const wave = findWave(db, req.params.id);
  if (!wave) return res.status(404).json({ error: 'Wave not found' });
  wave.status = 'sorting';
  wavePick.autoAllocate(wave);
  writeDb(db);
  res.json({ wave, allocationSummary: wavePick.allocationSummary(wave) });
});

app.post('/api/waves/:id/allocate', (req, res) => {
  const db = readDb();
  const wave = findWave(db, req.params.id);
  if (!wave) return res.status(404).json({ error: 'Wave not found' });
  const { sku, orderNumber, qty, location } = req.body;
  const ok = wavePick.adjustAllocation(wave, sku, orderNumber, Number(qty) || 0, location);
  if (!ok) return res.status(404).json({ error: 'SKU/order not found in this wave' });
  writeDb(db);
  res.json({ wave, allocationSummary: wavePick.allocationSummary(wave) });
});

app.post('/api/waves/:id/complete', (req, res) => {
  const db = readDb();
  const wave = findWave(db, req.params.id);
  if (!wave) return res.status(404).json({ error: 'Wave not found' });
  if (wave.status === 'done') return res.status(409).json({ error: 'Wave already completed' });
  const applied = wavePick.applyWaveToOrderStates(wave, (orderNumber, sku, qty, location) => {
    const batch = findBatchForOrder(db, orderNumber);
    if (!batch) return;
    if (!batch.orderStates) batch.orderStates = {};
    const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
    state.scanned[sku] = (state.scanned[sku] || 0) + qty;
    if (state.status === 'pending') state.status = 'processing';
    addToActiveCarton(state, sku, qty);
    appendScanLog(state, { kind: 'wave_pick', sku, qty, location: location || '', waveId: wave.id, by: req.userId || '' });
    batch.orderStates[orderNumber] = state;
    journalOrderState(orderNumber, state);
  });
  wave.status = 'done';
  wave.completedAt = new Date().toISOString();
  writeDb(db);
  logAudit('wave_completed', { waveId: wave.id, orders: wave.orderNumbers, linesApplied: applied, by: req.userId || '' });
  res.json({ ok: true, wave, allocationSummary: wavePick.allocationSummary(wave) });
});

app.post('/api/waves/:id/cancel', (req, res) => {
  const db = readDb();
  const wave = findWave(db, req.params.id);
  if (!wave) return res.status(404).json({ error: 'Wave not found' });
  if (wave.status === 'done') return res.status(409).json({ error: 'Cannot cancel a completed wave' });
  wave.status = 'cancelled';
  writeDb(db);
  logAudit('wave_cancelled', { waveId: wave.id, by: req.userId || '' });
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
    features:    user.features    || null,
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

// ── Activity Overview / Station Throughput dashboards ───────────────────────
// Both read from db.auditLog's 'order_completed' events (via
// completionAuditData() at order-completion time) — the same deletion-proof,
// ≥12-month-retained source every other Administrator report already uses.
// Calendar days are bucketed in SGT (Asia/Singapore), matching sgDateStr()
// used everywhere else timezone-sensitive in this file (nightly backup, etc).
// Returns the 3 full calendar days immediately BEFORE today, oldest first —
// "today" is still in progress, so it's excluded rather than shown partial.
function previousSgDays(n) {
  const days = [];
  for (let i = n; i >= 1; i--) days.push(sgDateStr(new Date(Date.now() - i * 86400000)));
  return days;
}
function completedOrderEventsForDays(db, days) {
  const from = days[0], to = days[days.length - 1];
  const log  = readAuditLogForRange(db, from, to);
  const set  = new Set(days);
  return log
    .filter(e => e.type === 'order_completed')
    .map(e => ({ ...e, sgDay: sgDateStr(new Date(e.endTime || e.at)) }))
    .filter(e => set.has(e.sgDay));
}

app.get('/api/master/dashboard/activity-overview', (req, res) => {
  const isMaster = req.headers['x-master-key'] === MASTER_PASS;
  if (!isMaster) {
    const role = readUsers().find(u => u.id === req.userId)?.role || 'warehouse';
    if (role !== 'admin') return res.status(403).json({ error: 'This dashboard requires Administrator access' });
  }
  const db     = readDb();
  const days   = previousSgDays(3);
  const events = completedOrderEventsForDays(db, days);

  const byDay = new Map(days.map(d => [d, []]));
  for (const e of events) byDay.get(e.sgDay).push(e);

  const result = days.map(d => {
    const dayEvents  = byDay.get(d);
    const totalOrders = dayEvents.length;
    const totalLines  = dayEvents.reduce((s, e) => s + (e.lines || []).length, 0);
    let largestBySize = null, largestByLines = null;
    for (const e of dayEvents) {
      const size = e.pieces || 0;
      const lineCount = (e.lines || []).length;
      if (!largestBySize || size > largestBySize.value) largestBySize = { order: e.order, client: e.client || '', value: size, date: d };
      if (!largestByLines || lineCount > largestByLines.value) largestByLines = { order: e.order, client: e.client || '', value: lineCount, date: d };
    }
    return { date: d, totalOrders, totalLines, largestBySize, largestByLines };
  });
  res.json({ days: result });
});

app.get('/api/master/dashboard/station-throughput', (req, res) => {
  const isMaster = req.headers['x-master-key'] === MASTER_PASS;
  if (!isMaster) {
    const role = readUsers().find(u => u.id === req.userId)?.role || 'warehouse';
    if (role !== 'admin' && role !== 'warehouse') return res.status(403).json({ error: 'Forbidden' });
  }
  const db     = readDb();
  const days   = previousSgDays(3);
  const events = completedOrderEventsForDays(db, days);
  const byId   = new Map(readUsers().map(u => [u.id, u.name || u.id]));
  const nameFor = id => byId.get(id) || id || '(unassigned)';

  // "Station" = the packer/user who completed the order (operator on the
  // completion event) — this system has no separate physical-station ID;
  // one logged-in packer is the closest available proxy for one station.
  const totalsByDay = Object.fromEntries(days.map(d => [d, 0]));
  const stationsMap = new Map();
  for (const e of events) {
    totalsByDay[e.sgDay]++;
    const stationId = e.operator || '(unassigned)';
    if (!stationsMap.has(stationId)) {
      stationsMap.set(stationId, {
        station: stationId, stationName: nameFor(stationId),
        byDay: Object.fromEntries(days.map(d => [d, { orders: 0, lines: 0 }])),
      });
    }
    const s = stationsMap.get(stationId).byDay[e.sgDay];
    s.orders++;
    s.lines += (e.lines || []).length;
  }
  const stations = [...stationsMap.values()].sort((a, b) => a.stationName.localeCompare(b.stationName));
  res.json({ days, totalsByDay, stations });
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
const ADMIN_REPORT_KINDS = new Set(['daily-summary', 'productivity', 'carrier-manifest', 'aging', 'lot-traceability', 'order-size', 'inbound', 'drivers']);

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

    const today = sgDateStr();
    const from  = (req.query.from || '').slice(0, 10) || sgDateStr(new Date(Date.now() - 30 * 86400000));
    const to    = (req.query.to   || '').slice(0, 10) || today;
    // Transparently pulls in archived months when the range reaches past
    // what's still live in db.auditLog — reports can filter back at least
    // 6 months regardless of how long ago the data actually happened.
    const log   = readAuditLogForRange(db, from, to);
    const day   = at => at ? sgDateStr(new Date(at)) : ''; // SGT calendar day
    const inRange = ev => day(ev.at) >= from && day(ev.at) <= to;
    const mins  = ev => (ev.startTime && ev.endTime) ? Math.round((new Date(ev.endTime) - new Date(ev.startTime)) / 6000) / 10 : null;
    const avg   = a => a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length * 10) / 10 : '';
    const hhmm  = at => at ? new Date(at).toLocaleTimeString('en-SG', { hour12: false }) : '';
    const byUserId = new Map(readUsers().map(u => [u.id, u.name || u.id]));
    const nameFor  = id => byUserId.get(id) || id || '—';

    const uploads   = log.filter(e => e.type === 'upload' && inRange(e));
    const completed = log.filter(e => e.type === 'order_completed' && inRange(e));
    const cancelled = log.filter(e => e.type === 'order_cancelled' && inRange(e));
    const deletions = log.filter(e => ['batch_deleted', 'order_deleted', 'order_deletion_rejected', 'master_reset'].includes(e.type) && inRange(e));

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
        else if (e.type === 'order_deleted') rows.push([e.at, 'ORDER DELETED', e.order, e.client, e.by, '', '', '', '', e.requestedBy ? `${e.reason || ''} (requested by ${e.requestedBy}, approved by ${e.by})` : (e.reason || '')]);
        else if (e.type === 'order_deletion_rejected') rows.push([e.at, 'DELETION REJECTED', e.order, e.client, e.by, '', '', '', '', `Requested by ${e.requestedBy}: "${e.reason || ''}"${e.note ? ` — Master note: ${e.note}` : ''}`]);
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

    } else if (kind === 'order-size') {
      title = 'Order_Size_Analysis';
      const SIZE_BUCKETS = [
        { label: 'Small (1-5 pcs)',   test: p => p <= 5 },
        { label: 'Medium (6-20 pcs)', test: p => p > 5 && p <= 20 },
        { label: 'Large (21+ pcs)',   test: p => p > 20 },
      ];
      const orderRows = completed.map(e => [
        e.order, e.client || '', e.customer || '', e.pieces || 0, (e.lines || []).length, day(e.at), e.operator || '',
      ]);

      const bySize = SIZE_BUCKETS.map(b => {
        const matched = orderRows.filter(r => b.test(r[3]));
        return [b.label, matched.length, matched.reduce((s, r) => s + r[3], 0)];
      });
      addSheet('Size Summary', [
        ['Size Bucket', 'Orders', 'Total Pieces'],
        ...bySize,
        ['All orders', orderRows.length, orderRows.reduce((s, r) => s + r[3], 0)],
      ]);

      addSheet('By Pieces', [
        ['Order No', 'Client', 'Customer', 'Pieces', 'Line Items', 'Completed', 'Operator'],
        ...[...orderRows].sort((a, b) => b[3] - a[3]),
      ]);

      addSheet('By Line Items', [
        ['Order No', 'Client', 'Customer', 'Pieces', 'Line Items', 'Completed', 'Operator'],
        ...[...orderRows].sort((a, b) => b[4] - a[4]),
      ]);

    } else if (kind === 'inbound') {
      title = 'Inbound_Receiving';
      // Live data straight from db.inbound — same pattern as 'aging' above —
      // since inbound jobs aren't audit-log-derived the way order completion is.
      const jobs = (db.inbound || []).filter(rec => {
        const d = day(rec.uploaded_at);
        return d >= from && d <= to;
      });

      addSheet('Inbound Jobs', [
        ['Serial', 'Type', 'Reference', 'Source', 'Client', 'Uploaded', 'Uploaded By', 'Status', 'Expected Qty', 'Scanned Qty', 'Cartons'],
        ...jobs.map(rec => {
          const state = rec.state || {};
          const expected = (rec.lines || []).reduce((s, l) => s + (l.expected_qty || 0), 0);
          const scanned  = Object.values(state.scanned || {}).reduce((s, q) => s + q, 0);
          return [
            rec.serial || '', rec.type === 'po' ? 'PO / ASN' : 'Return', rec.reference || '',
            rec.source_name || '', rec.client_name || '', day(rec.uploaded_at), nameFor(rec.uploaded_by),
            state.status || 'pending', rec.type === 'po' ? expected : '', scanned,
            (state.cartons || []).length || 1,
          ];
        }),
      ]);

      const lineRows = [];
      for (const rec of jobs) {
        const state = rec.state || {};
        const scanned = state.scanned || {};
        const bySku = new Map((rec.lines || []).map(l => [l.sku, l]));
        const skus = new Set([...bySku.keys(), ...Object.keys(scanned)]);
        for (const sku of skus) {
          const line = bySku.get(sku);
          const qty  = scanned[sku] || 0;
          const cond = (state.conditionTotals || {})[sku] || {};
          lineRows.push([
            rec.serial || '', rec.reference || '', sku, line?.description || '',
            rec.type === 'po' ? (line?.expected_qty || 0) : '', qty,
            cond.straight_to_inventory || '', cond.damaged || '', cond.kiv || '',
          ]);
        }
      }
      addSheet('Inbound Lines', [
        ['Serial', 'Reference', 'SKU', 'Description', 'Expected Qty', 'Scanned Qty', 'Straight to Inventory', 'Damaged', 'KIV'],
        ...lineRows,
      ]);

    } else if (kind === 'drivers') {
      title = 'Driver_Performance';
      const { drivers, summary } = computeDriverPerformance(db, from, to);

      addSheet('Driver Summary', [
        ['Driver', 'Jobs Assigned', 'Delivered', 'Confirmed (awaiting delivery)', 'Preplanned (open)', 'Total Cartons', 'Est. Distance (km)', 'Days Active', 'Avg Jobs / Day'],
        ...summary.map(s => [s.name, s.jobsAssigned, s.delivered, s.confirmed, s.open, s.cartons, s.km, s.daysActive, s.avgJobsPerDay]),
      ]);

      addSheet('Driver Jobs', [
        ['Driver', 'Date', 'Job ID', 'Client', 'Postal', 'Cartons', 'Route', 'Stop #', 'Status', 'Planned At', 'Delivered At'],
        ...Object.keys(drivers).sort().flatMap(name =>
          drivers[name].jobs
            .sort((a, b) => day(a.deliveredAt || a.plannedAt || a.createdAt).localeCompare(day(b.deliveredAt || b.plannedAt || b.createdAt)) ||
                            (a.routeNum || 99) - (b.routeNum || 99) || (a.stopSeq || 99) - (b.stopSeq || 99))
            .map(j => [
              name, day(j.deliveredAt || j.plannedAt || j.createdAt), j.id, j.clientName || '',
              j.shipping?.zip || '', j.packages || 1, j.routeNum || '', j.stopSeq || '',
              j.status || 'pending', hhmm(j.plannedAt), hhmm(j.deliveredAt),
            ])),
      ]);

      addSheet('Notes', [
        ['About this report'],
        ['Distances are ESTIMATES based on Singapore postal-district centroids (the same basis route planning uses), starting each day from the Marina depot reference. They are suitable for comparing drivers and days, not for odometer/fuel claims.'],
        ['A job counts toward the day it was delivered; undelivered jobs count toward the day they were planned (or created).'],
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

// Removes an order from a batch (splice + orderStates cleanup + waybill PDF).
// Shared by the direct master delete and the deletion-request approval path.
function removeOrderFromBatch(batch, orderNumber) {
  const before  = (batch.orders || []).length;
  batch.orders  = (batch.orders || []).filter(o => o.order_number !== orderNumber);
  if (batch.orders.length === before) return false;
  batch.order_count = batch.orders.length;
  if (batch.orderStates) delete batch.orderStates[orderNumber];
  try { fs.unlinkSync(path.join(WAYBILL_DIR, batch.id, `${orderNumber}.pdf`)); } catch {}
  return true;
}

app.delete('/api/master/order/:batchId/:orderNumber', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { batchId, orderNumber } = req.params;
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to delete an order.' });
  try {
    const db    = readDb();
    const batch = db.batches.find(b => b.id === batchId);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const state = (batch.orderStates || {})[orderNumber];
    if (state && state.status === 'done') {
      return res.status(403).json({ error: 'This order is completed and can no longer be deleted.' });
    }
    if (!removeOrderFromBatch(batch, orderNumber)) return res.status(404).json({ error: 'Order not found in batch' });
    writeDb(db);
    logAudit('order_deleted', { order: orderNumber, batchId, client: batch.client_name || '', by: req.userId || 'master', reason });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Order deletion requests — Admin requests, Master confirms ───────────────
// Admin-role users don't hold the master key, so they can no longer delete
// an order outright. They request deletion (re-entering their OWN account
// password as a confirmation step); the order is flagged pending_deletion
// (visible to everyone as a status) until Master reviews it from the
// Administrator "Pending Deletions" tab and approves or rejects it.
app.post('/api/scan/order-deletion-request', (req, res) => {
  const { orderNumber, batchId, reason, password } = req.body || {};
  const reasonTrim = String(reason || '').trim();
  if (!orderNumber || !batchId) return res.status(400).json({ error: 'orderNumber and batchId required' });
  if (!reasonTrim) return res.status(400).json({ error: 'A reason is required to request deletion.' });
  const user = readUsers().find(u => u.id === req.userId);
  if (!user) return res.status(401).json({ error: 'Session user not found.' });
  if ((user.role || 'admin') !== 'admin') {
    return res.status(403).json({ error: 'Only Admin users can request order deletion.' });
  }
  if (!password || hashPass(String(password), user.salt) !== user.passwordHash) {
    // 403, not 401 — the session (x-auth-token) is still valid; only this
    // re-entered password check failed. A 401 here would trip the client's
    // global "session expired" handler and force-reload the whole page.
    return res.status(403).json({ error: 'Incorrect password.' });
  }
  const db    = readDb();
  const batch = db.batches.find(b => b.id === batchId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (!(batch.orders || []).some(o => o.order_number === orderNumber)) {
    return res.status(404).json({ error: 'Order not found in batch' });
  }
  if (!batch.orderStates) batch.orderStates = {};
  const state = batch.orderStates[orderNumber] || { status: 'pending', scanned: {} };
  if (state.status === 'done') {
    return res.status(403).json({ error: 'This order is completed and can no longer be deleted.' });
  }
  if (state.pending_deletion) {
    return res.status(409).json({ error: 'A deletion request is already pending for this order.' });
  }
  state.pending_deletion = { reason: reasonTrim, requestedBy: req.userId, requestedAt: new Date().toISOString() };
  batch.orderStates[orderNumber] = state;
  writeDb(db);
  logAudit('order_deletion_requested', { order: orderNumber, batchId, client: batch.client_name || '', by: req.userId || '', reason: reasonTrim });
  res.json({ ok: true });
});

app.get('/api/master/pending-deletions', (req, res) => {
  if (!checkMaster(req, res)) return;
  const db      = readDb();
  const nameFor = (() => {
    const byId = new Map(readUsers().map(u => [u.id, u.name || u.id]));
    return id => byId.get(id) || id || '(unknown)';
  })();
  const out = [];
  for (const batch of db.batches || []) {
    const states = batch.orderStates || {};
    for (const ord of (batch.orders || [])) {
      const state = states[ord.order_number];
      if (!state || !state.pending_deletion) continue;
      const scannedQty = Object.values(state.scanned || {}).reduce((s, v) => s + v, 0);
      out.push({
        orderNumber:     ord.order_number,
        batchId:         batch.id,
        client:          batch.client_name || '',
        reason:          state.pending_deletion.reason,
        requestedBy:     state.pending_deletion.requestedBy,
        requestedByName: nameFor(state.pending_deletion.requestedBy),
        requestedAt:     state.pending_deletion.requestedAt,
        scannedQty,
        totalQty:        ord.total_qty || 0,
      });
    }
  }
  out.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt))); // oldest-waiting first
  res.json(out);
});

app.post('/api/master/pending-deletions/:batchId/:orderNumber/approve', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { batchId, orderNumber } = req.params;
  try {
    const db    = readDb();
    const batch = db.batches.find(b => b.id === batchId);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const state = (batch.orderStates || {})[orderNumber];
    if (!state || !state.pending_deletion) return res.status(404).json({ error: 'No pending deletion request for this order.' });
    const pending = state.pending_deletion;
    if (!removeOrderFromBatch(batch, orderNumber)) return res.status(404).json({ error: 'Order not found in batch' });
    writeDb(db);
    logAudit('order_deleted', {
      order: orderNumber, batchId, client: batch.client_name || '',
      by: req.userId || 'master', reason: pending.reason, requestedBy: pending.requestedBy,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/master/pending-deletions/:batchId/:orderNumber/reject', (req, res) => {
  if (!checkMaster(req, res)) return;
  const { batchId, orderNumber } = req.params;
  const note = String(req.body?.note || '').trim();
  try {
    const db    = readDb();
    const batch = db.batches.find(b => b.id === batchId);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const state = (batch.orderStates || {})[orderNumber];
    if (!state || !state.pending_deletion) return res.status(404).json({ error: 'No pending deletion request for this order.' });
    const pending = state.pending_deletion;
    delete state.pending_deletion;
    writeDb(db);
    logAudit('order_deletion_rejected', {
      order: orderNumber, batchId, client: batch.client_name || '',
      by: req.userId || 'master', requestedBy: pending.requestedBy, reason: pending.reason, note,
    });
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
  res.json(readUsers().map(({ id, name, role, features }) => ({ id, name, role: role || 'admin', features: features || null })));
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

// Full user roster as XLSX — same shape as the drivers export (no
// passwordHash/salt ever leave the server).
app.get('/api/master/users/export', (req, res) => {
  if (!checkMaster(req, res)) return;
  const rows = readUsers().map(u => [
    u.id, u.name || u.id, u.role || 'admin',
    u.features ? USER_FEATURE_KEYS.filter(k => u.features[k] !== false).join(', ') : 'All',
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['User ID', 'Name', 'Role', 'Enabled Features'],
    ...rows,
  ]), 'Users');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="IDEALONE_Users_${sgDateStr()}.xlsx"`);
  logAudit('user_roster_exported', { count: rows.length, by: req.userId || '' });
  res.send(buf);
});

// Per-user FEATURE TOGGLES — which main functions this user sees.
// Absent/never-set = everything visible (role rules still apply on top).
const USER_FEATURE_KEYS = ['upload', 'orders', 'inbound', 'transport', 'labels', 'reports'];
// ── Lazada Open Platform — push-mechanism callback ──────────────────────────
// Lazada's console verifies this URL (expects a fast HTTP 200) and then
// pushes JSON events (new orders, status changes) here. For now we ACK and
// RECORD every push — nothing is processed into orders yet, since payloads
// arrive unverified until the app is approved and signature checking is
// wired. The stored log is exactly what we need to build the real Lazada
// order import against actual payload shapes.
app.all('/api/lazada/callback', express.json({ limit: '512kb' }), (req, res) => {
  res.status(200).json({ code: '0', message: 'success' }); // ACK fast — Lazada retries slow endpoints
  try {
    const db = readDb();
    if (!db.lazadaPushLog) db.lazadaPushLog = [];
    db.lazadaPushLog.push({
      at: new Date().toISOString(),
      method: req.method,
      query: req.query || {},
      body: (req.body && typeof req.body === 'object') ? req.body : { raw: String(req.body || '').slice(0, 2000) },
    });
    if (db.lazadaPushLog.length > 200) db.lazadaPushLog.splice(0, db.lazadaPushLog.length - 200);
    writeDb(db);
    logAudit('lazada_push_received', { method: req.method, msgType: req.body?.message_type ?? req.body?.type ?? '' });
  } catch (e) { console.error('[lazada] push log error:', e.message); }
});

// ── ZORT integration — per-client merchant store connections ────────────────
// Each fulfillment CLIENT connects their own Zort store (storename/apikey/
// apisecret). Their paid sales orders pull into IDEALONE as normal batches
// (tagged with the client's name), get picked/scanned like any upload, and on
// completion the status can be pushed back to THAT client's store. Secrets
// live only in db.json (never in git); API responses mask them.
const zortApi = require('./lib/zort.js');

function zortStores(db) { return db.zortStores || (db.zortStores = []); }
function zortMask(s) { s = String(s || ''); return s.length <= 6 ? '••••' : s.slice(0, 3) + '••••' + s.slice(-3); }
function zortStorePublic(s) {
  return {
    id: s.id, clientName: s.clientName, storename: s.storename,
    apikeyMasked: zortMask(s.apikey), apisecretMasked: zortMask(s.apisecret),
    endpoint: s.endpoint || '', enabled: !!s.enabled,
    channelClients: s.channelClients || {},
    autoPullMinutes: s.autoPullMinutes || 0,
    completeAction: s.completeAction || 'none',
    completeStatusCode: s.completeStatusCode ?? 1,
    lastPullAt: s.lastPullAt || null, lastResult: s.lastResult || null,
  };
}

// Pull new/updated orders from one store into a fresh batch.
async function pullZortStore(db, store) {
  const existing = new Set();
  for (const b of db.batches || []) for (const o of b.orders || []) existing.add(o.order_number);

  // Look back 1 day past the last pull (or 7 days on first pull) — date
  // params are day-granular, overlap is deduped by order number anyway.
  const sinceMs = store.lastPullAt ? new Date(store.lastPullAt).getTime() - 86400000 : Date.now() - 7 * 86400000;
  const query = { limit: 100, page: 1, updatedafter: new Date(sinceMs).toISOString().slice(0, 10) };

  const rows = [];
  const zortMeta = {}; // order_number → {zort_id, zort_status}
  let fetched = 0, skippedExisting = 0, skippedVoid = 0;
  for (let page = 1; page <= 20; page++) {
    const resp = await zortApi.getOrders(store, { ...query, page });
    const list = resp.list || resp.orders || resp.data || [];
    fetched += list.length;
    for (const o of list) {
      const number = String(o.number || '').trim();
      if (!number) continue;
      // Zort status 2 = voided/cancelled in their scheme — never import
      if (Number(o.status) === 2) { skippedVoid++; continue; }
      if (existing.has(number)) { skippedExisting++; continue; }
      const lines = o.list || o.orderlist || [];
      if (!lines.length) continue;
      // Which CLIENT does this order belong to? The sales channel it came
      // from (the client's Lazada/Shopee/TikTok shop connected inside the
      // ZORT account) decides — via the store's channel→client mapping.
      const channel = String(o.saleschannel || o.channel || '').trim();
      const clientForOrder = (store.channelClients || {})[channel] || store.clientName || channel || 'ZORT';
      zortMeta[number] = { zort_id: o.id, zort_status: o.status, client: clientForOrder };
      for (const l of lines) {
        rows.push({
          order_number:     number,
          customer_name:    String(o.customername || o.customer_name || o.shippingname || '').trim(),
          client_name:      clientForOrder,
          sku:              String(l.sku || '').trim(),
          qty:              Math.max(0, Math.round(Number(l.number) || 0)),
          description:      String(l.name || '').slice(0, 200),
          delivery_address: String(o.shippingaddress || o.customeraddress || '').trim(),
          tel:              String(o.shippingphone || o.customerphone || '').trim(),
          carrier:          String(o.shippingchannel || '').trim(),
          platform:         String(o.saleschannel || o.channel || '').trim(),
          waybill_number:   String(o.trackingno || '').trim(),
          date:             String(o.orderdate || '').slice(0, 10),
        });
      }
    }
    if (list.length < query.limit) break;
  }

  const orders = summarizeOrders(rows.filter(r => r.sku && r.qty > 0));
  // summarizeOrders keeps only known fields — re-attach the Zort linkage the
  // completion push needs, and the client each order resolved to
  for (const o of orders) {
    const m = zortMeta[o.order_number] || {};
    o.zort_id = m.zort_id;
    o.zort_store_id = store.id;
    o._client = m.client || store.clientName || 'ZORT';
  }

  // ONE ZORT account carries MANY clients' sales channels — group the pull
  // into one batch PER CLIENT so the Orders tab, client filters and reports
  // see each merchant separately (batch.client_name is the client identity
  // everywhere else in the app).
  const byClient = new Map();
  for (const o of orders) {
    const c = o._client;
    delete o._client;
    if (!byClient.has(c)) byClient.set(c, []);
    byClient.get(c).push(o);
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '');
  const batchClients = [];
  for (const [clientName, clientOrders] of byClient) {
    const batch = {
      id: uuidv4(),
      filename:    `zort-${clientName.replace(/[^A-Za-z0-9_-]+/g, '_')}-${stamp}`,
      idealscan_code: nextIdealscanCode(db),
      uploaded_at: new Date().toISOString(),
      uploaded_by: 'zort-sync',
      client_name: clientName,
      order_count: clientOrders.length,
      row_count:   clientOrders.reduce((n, o) => n + o.lines.length, 0),
      orderStates: {},
      orders: clientOrders,
    };
    db.batches.unshift(batch);
    batchClients.push(`${clientName} (${clientOrders.length})`);
  }
  store.lastPullAt = new Date().toISOString();
  store.lastResult = { at: store.lastPullAt, fetched, created: orders.length, skippedExisting, skippedVoid, clients: batchClients };
  writeDb(db);
  logAudit('zort_pull', { storeId: store.id, fetched, created: orders.length, skippedExisting, skippedVoid, clients: batchClients.slice(0, 20) });
  return store.lastResult;
}

// Fire-and-forget push of a completed order back to its client's Zort store.
function pushZortCompletion(db, ord, state) {
  try {
    if (!ord?.zort_id || !ord?.zort_store_id) return;
    const store = zortStores(db).find(s => s.id === ord.zort_store_id);
    if (!store || !store.enabled) return;
    const action = store.completeAction || 'none';
    if (action === 'none') return;
    const tracking = String(ord.waybill_number || '').trim();
    const p =
      action === 'pack'        ? zortApi.packOrder(store, { id: ord.zort_id, trackingno: tracking || undefined }) :
      action === 'readytoship' ? zortApi.readyToShip(store, { id: ord.zort_id, trackingno: tracking || undefined }) :
      zortApi.updateOrderStatus(store, { id: ord.zort_id, status: store.completeStatusCode ?? 1, actionDate: new Date().toISOString().slice(0, 10) });
    p.then(() => {
      logAudit('zort_completion_pushed', { order: ord.order_number, client: store.clientName || '', action });
    }).catch(err => {
      console.error(`[zort] completion push failed for ${ord.order_number}:`, err.message);
      logAudit('zort_completion_push_failed', { order: ord.order_number, client: store.clientName || '', action, error: String(err.message).slice(0, 200) });
    });
  } catch (e) { console.error('[zort] push error:', e.message); }
}

app.get('/api/master/zort/stores', (req, res) => {
  if (!checkMaster(req, res)) return;
  res.json(zortStores(readDb()).map(zortStorePublic));
});

app.post('/api/master/zort/stores', (req, res) => {
  if (!checkMaster(req, res)) return;
  const b = req.body || {};
  const db = readDb();
  const stores = zortStores(db);
  let store = b.id ? stores.find(s => s.id === b.id) : null;
  if (!store) {
    if (!b.clientName || !b.storename || !b.apikey || !b.apisecret) {
      return res.status(400).json({ error: 'clientName, storename, apikey and apisecret are required' });
    }
    store = { id: uuidv4(), createdAt: new Date().toISOString() };
    stores.push(store);
  }
  store.clientName = String(b.clientName ?? store.clientName ?? '').slice(0, 80);
  store.storename  = String(b.storename  ?? store.storename  ?? '').trim();
  // Blank key/secret on edit = keep the stored one (the UI shows masks)
  if (b.apikey)    store.apikey    = String(b.apikey).trim();
  if (b.apisecret) store.apisecret = String(b.apisecret).trim();
  if (b.endpoint !== undefined) store.endpoint = String(b.endpoint || '').trim();
  store.enabled = b.enabled !== undefined ? !!b.enabled : (store.enabled ?? true);
  // Sales-channel → client mapping: orders from the channel named e.g.
  // "Lazada - ClientX" tag as ClientX. Plain short strings both sides.
  if (b.channelClients && typeof b.channelClients === 'object') {
    const map = {};
    for (const [k, v] of Object.entries(b.channelClients).slice(0, 100)) {
      const key = String(k).slice(0, 80).trim(), val = String(v || '').slice(0, 80).trim();
      if (key && val) map[key] = val;
    }
    store.channelClients = map;
  }
  store.autoPullMinutes = Math.max(0, Math.min(1440, parseInt(b.autoPullMinutes, 10) || 0));
  if (['none', 'status', 'pack', 'readytoship'].includes(b.completeAction)) store.completeAction = b.completeAction;
  if (b.completeStatusCode !== undefined) store.completeStatusCode = parseInt(b.completeStatusCode, 10) || 1;
  writeDb(db);
  logAudit('zort_store_saved', { client: store.clientName, storeId: store.id, by: req.userId || '' });
  res.json(zortStorePublic(store));
});

app.delete('/api/master/zort/stores/:id', (req, res) => {
  if (!checkMaster(req, res)) return;
  const db = readDb();
  const stores = zortStores(db);
  const idx = stores.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Store not found' });
  const [gone] = stores.splice(idx, 1);
  writeDb(db);
  logAudit('zort_store_deleted', { client: gone.clientName || '', storeId: gone.id, by: req.userId || '' });
  res.json({ ok: true });
});

app.post('/api/master/zort/stores/:id/test', async (req, res) => {
  if (!checkMaster(req, res)) return;
  const store = zortStores(readDb()).find(s => s.id === req.params.id);
  if (!store) return res.status(404).json({ error: 'Store not found' });
  try {
    const info = await zortApi.validateApi(store);
    res.json({ ok: true, info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Which marketplaces has this client linked INSIDE their Zort account?
// (Lazada/Shopee/TikTok credentials are keyed into ZORT's own dashboard by
// the merchant — Settings → Sales Channels — never into IDEALONE. We can
// only READ the resulting list and show it.)
app.get('/api/master/zort/stores/:id/channels', async (req, res) => {
  if (!checkMaster(req, res)) return;
  const store = zortStores(readDb()).find(s => s.id === req.params.id);
  if (!store) return res.status(404).json({ error: 'Store not found' });
  try {
    const d = await zortApi.getSalesChannels(store);
    res.json({ ok: true, channels: d.list || d.channels || d.data || d });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post('/api/master/zort/stores/:id/pull', async (req, res) => {
  if (!checkMaster(req, res)) return;
  const db = readDb();
  const store = zortStores(db).find(s => s.id === req.params.id);
  if (!store) return res.status(404).json({ error: 'Store not found' });
  try {
    res.json({ ok: true, result: await pullZortStore(db, store) });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Auto-pull scheduler: each enabled store with autoPullMinutes > 0 is pulled
// on its own cadence. Errors are logged, never fatal.
let _zortPulling = false;
setInterval(async () => {
  if (_zortPulling) return;
  _zortPulling = true;
  try {
    const db = readDb();
    for (const store of zortStores(db)) {
      if (!store.enabled || !(store.autoPullMinutes > 0)) continue;
      const last = store.lastPullAt ? new Date(store.lastPullAt).getTime() : 0;
      if (Date.now() - last < store.autoPullMinutes * 60000) continue;
      try { await pullZortStore(db, store); }
      catch (e) { console.error(`[zort] auto-pull failed (${store.clientName}):`, e.message); }
    }
  } catch (e) { console.error('[zort] scheduler error:', e.message); }
  finally { _zortPulling = false; }
}, 60000);

app.put('/api/master/users/:id/features', (req, res) => {
  if (!checkMaster(req, res)) return;
  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'User not found' });
  const incoming = req.body?.features || {};
  const features = {};
  for (const k of USER_FEATURE_KEYS) features[k] = incoming[k] !== false; // default true
  users[idx].features = features;
  writeUsers(users);
  logAudit('user_features_updated', {
    userId: req.params.id,
    hidden: USER_FEATURE_KEYS.filter(k => !features[k]).join(',') || '(none)',
  });
  res.json({ ok: true, features });
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

  // Cartons — big orders can take more than one physical box. Orders that
  // never explicitly split cartons fall back to one implicit carton holding
  // everything scanned, so this always reflects reality even for pre-feature
  // completed orders (which have no state.cartons at all).
  const cartons = (state.cartons && state.cartons.length) ? state.cartons : [{ num: 1, scans: state.scanned || {} }];

  const aoa = [
    ['IDEALONE Completion Slip'],
    [],
    ['IdealScan Job', batch.idealscan_code || '—'],
    ['Order Number', orderNumber],
    ['Customer',     ord.customer_name || '—'],
    ['Client',       ord.client_name   || '—'],
    ['Carrier',      ord.carrier       || '—'],
    ['Waybill No.',  ord.waybill_number || '—'],
    ['Cartons',      cartons.length],
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

  // Sheet 2 — per-carton contents: which SKU/qty went in which physical box
  const cartonAoa = [['Carton', 'SKU', 'Description', 'Qty']];
  for (const c of cartons) {
    const entries = Object.entries(c.scans || {}).filter(([, q]) => q > 0);
    if (!entries.length) { cartonAoa.push([c.num, '(empty)', '', 0]); continue; }
    for (const [sku, qty] of entries) {
      const line = uniqueSkuLines(ord).find(l => l.sku === sku);
      cartonAoa.push([c.num, sku, line?.description || '', qty]);
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cartonAoa), 'Cartons');

  // Sheet 3 — the full scan history: every gun scan, manual count, and
  // taught barcode, in the order they happened
  const KIND_LABEL = { scan: 'Gun scan', count: 'Manual count', teach: 'Taught barcode', new_carton: 'New carton started', carton_labeled: 'Carton label confirmed', carton_switch: 'Switched carton', carton_cancel_multi: 'Cartons merged into one' };
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

// ── IDEALTMS — Transport Management System (Routes, Drivers, Zones) ─────────

// Middleware: Check MySQL availability for TMS endpoints
function requireMysql(req, res, next) {
  if (!mysqlPool) {
    return res.status(503).json({ error: 'TMS database unavailable. Please contact your system administrator.' });
  }
  next();
}

// GET /api/tms/drivers — List all drivers
app.get('/api/tms/drivers', requireAuth, requireMysql, async (req, res) => {
  try {
    const drivers = await queryMysql('SELECT * FROM drivers ORDER BY created_at DESC');
    res.json(drivers || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tms/drivers — Create new driver (Admin request)
app.post('/api/tms/drivers', requireAuth, requireMysql, express.json(), async (req, res) => {
  try {
    const { name, phone, email, vehicle_type, capacity_kg, capacity_volume, shift_start, shift_end, home_depot } = req.body;
    if (!name) return res.status(400).json({ error: 'Driver name required' });

    const driverId = 'DRV-' + uuidv4().slice(0, 8).toUpperCase();
    const userId = req.userId || 'unknown';

    // Create driver pending approval
    await queryMysql(
      `INSERT INTO drivers (id, name, phone, email, vehicle_type, capacity_kg, capacity_volume, shift_start, shift_end, home_depot_location, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [driverId, name, phone || null, email || null, vehicle_type || null, capacity_kg || null, capacity_volume || null, shift_start || null, shift_end || null, home_depot || null]
    );

    logAudit('tms_driver_created', { driverId, name, by: userId });
    res.json({ id: driverId, name, status: 'active', message: 'Driver added successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tms/drivers/:id — Update driver details
app.put('/api/tms/drivers/:id', requireAuth, requireMysql, express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, vehicle_type, capacity_kg, capacity_volume, shift_start, shift_end, status } = req.body;

    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (phone !== undefined) { updates.push('phone = ?'); params.push(phone); }
    if (email !== undefined) { updates.push('email = ?'); params.push(email); }
    if (vehicle_type !== undefined) { updates.push('vehicle_type = ?'); params.push(vehicle_type); }
    if (capacity_kg !== undefined) { updates.push('capacity_kg = ?'); params.push(capacity_kg); }
    if (capacity_volume !== undefined) { updates.push('capacity_volume = ?'); params.push(capacity_volume); }
    if (shift_start !== undefined) { updates.push('shift_start = ?'); params.push(shift_start); }
    if (shift_end !== undefined) { updates.push('shift_end = ?'); params.push(shift_end); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(id);
    const sql = `UPDATE drivers SET ${updates.join(', ')} WHERE id = ?`;
    await queryMysql(sql, params);

    logAudit('tms_driver_updated', { driverId: id, by: req.userId || 'unknown' });
    res.json({ success: true, id, message: 'Driver updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/tms/drivers/:id — Delete driver (Master only)
app.delete('/api/tms/drivers/:id', (req, res) => {
  if (!checkMaster(req, res)) return;
  if (!mysqlPool) return res.status(503).json({ error: 'TMS database unavailable' });
  (async () => {
    try {
      const { id } = req.params;
      await queryMysql('DELETE FROM drivers WHERE id = ?', [id]);
      logAudit('tms_driver_deleted', { driverId: id });
      res.json({ success: true, message: 'Driver deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  })();
});

// GET /api/tms/zones — List all zones
app.get('/api/tms/zones', requireAuth, requireMysql, async (req, res) => {
  try {
    const zones = await queryMysql('SELECT * FROM zones ORDER BY name');
    res.json(zones || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tms/zones — Create new zone
app.post('/api/tms/zones', requireAuth, requireMysql, express.json(), async (req, res) => {
  try {
    const { name, postal_codes, assigned_days, delivery_window_start, delivery_window_end } = req.body;
    if (!name) return res.status(400).json({ error: 'Zone name required' });

    const zoneId = 'ZONE-' + uuidv4().slice(0, 8).toUpperCase();
    const postalCodesJson = JSON.stringify(postal_codes || []);
    const assignedDaysJson = JSON.stringify(assigned_days || []);

    await queryMysql(
      `INSERT INTO zones (id, name, postal_codes, assigned_days, delivery_window_start, delivery_window_end)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [zoneId, name, postalCodesJson, assignedDaysJson, delivery_window_start || null, delivery_window_end || null]
    );

    logAudit('tms_zone_created', { zoneId, name, by: req.userId || 'unknown' });
    res.json({ id: zoneId, name, message: 'Zone created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route Planning & Optimization ────────────────────────────────────────
// POST /api/tms/routes/plan — Plan optimal routes from delivery jobs
app.post('/api/tms/routes/plan', requireAuth, requireMysql, express.json(), async (req, res) => {
  try {
    const { jobs, date } = req.body;
    if (!jobs || !Array.isArray(jobs)) return res.status(400).json({ error: 'Jobs array required' });
    if (!date) return res.status(400).json({ error: 'Date required' });

    // Get active drivers
    const drivers = await queryMysql('SELECT * FROM drivers WHERE status = "active"');
    if (!drivers || drivers.length === 0) {
      return res.status(400).json({ error: 'No active drivers available' });
    }

    // Plan routes
    const { routes, unassigned } = await planRoutes(jobs, drivers, date);

    // Persist routes to database
    for (const route of routes) {
      const routeId = route.id;
      await queryMysql(
        `INSERT INTO routes (id, driver_id, planned_date, zone_id, total_stops, total_distance_km, estimated_duration_minutes, status, optimized_sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
        [routeId, route.driver_id, route.planned_date, route.zone, route.stops.length, route.total_distance_km, route.estimated_duration_minutes, JSON.stringify(route.stops)]
      );

      // Insert route stops
      for (const stop of route.stops) {
        await queryMysql(
          `INSERT INTO route_stops (id, route_id, job_id, sequence, postal_code, customer_name, address, latitude, longitude, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          ['STOP-' + uuidv4().slice(0, 8), routeId, stop.job_id, stop.sequence, stop.postal_code, stop.customer_name, stop.address, stop.latitude, stop.longitude]
        );
      }
    }

    logAudit('tms_routes_planned', { routesCreated: routes.length, jobsAssigned: jobs.length - unassigned.length, by: req.userId || 'unknown' });
    res.json({
      routes: routes.map(r => ({
        id: r.id,
        driver_id: r.driver_id,
        zone: r.zone,
        totalStops: r.stops.length,
        totalDistance: r.total_distance_km,
        estimatedDuration: r.estimated_duration_minutes,
        status: r.status,
        stops: r.stops
      })),
      unassigned: unassigned.length,
      message: `Planned ${routes.length} routes for ${jobs.length - unassigned.length} jobs`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tms/routes — List all planned routes
app.get('/api/tms/routes', requireAuth, requireMysql, async (req, res) => {
  try {
    const { date, driver_id, status } = req.query;
    let sql = 'SELECT r.*, d.name as driver_name FROM routes r LEFT JOIN drivers d ON r.driver_id = d.id WHERE 1=1';
    const params = [];

    if (date) { sql += ' AND r.planned_date = ?'; params.push(date); }
    if (driver_id) { sql += ' AND r.driver_id = ?'; params.push(driver_id); }
    if (status) { sql += ' AND r.status = ?'; params.push(status); }

    sql += ' ORDER BY r.planned_date DESC, r.zone';
    const routes = await queryMysql(sql, params);
    res.json(routes || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tms/routes/:id — Get route details with stops
app.get('/api/tms/routes/:id', requireAuth, requireMysql, async (req, res) => {
  try {
    const { id } = req.params;
    const route = await queryMysql('SELECT r.*, d.name as driver_name FROM routes r LEFT JOIN drivers d ON r.driver_id = d.id WHERE r.id = ?', [id]);
    if (!route || route.length === 0) return res.status(404).json({ error: 'Route not found' });

    const stops = await queryMysql('SELECT * FROM route_stops WHERE route_id = ? ORDER BY sequence', [id]);
    res.json({ ...route[0], stops: stops || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tms/routes/:id/reorder — Reorder stops in a route (planner modification)
app.post('/api/tms/routes/:id/reorder', requireAuth, requireMysql, express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { stops } = req.body;
    if (!stops || !Array.isArray(stops)) return res.status(400).json({ error: 'Stops array required' });

    // Update stop sequences
    for (let i = 0; i < stops.length; i++) {
      await queryMysql(
        'UPDATE route_stops SET sequence = ? WHERE id = ?',
        [i + 1, stops[i].id]
      );
    }

    logAudit('tms_route_reordered', { routeId: id, stopsCount: stops.length, by: req.userId || 'unknown' });
    res.json({ success: true, message: 'Route reordered' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route Reports & Analytics ────────────────────────────────────────────
// GET /api/tms/routes/:id/export — Export route as XLSX
app.get('/api/tms/routes/:id/export', requireAuth, requireMysql, async (req, res) => {
  try {
    const { id } = req.params;
    const buf = await generateRouteReportXlsx(id);
    if (!buf) return res.status(404).json({ error: 'Route not found' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Route_${id}.xlsx"`);
    res.end(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tms/metrics — Get route metrics for date range
app.get('/api/tms/metrics', requireAuth, requireMysql, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });

    const metrics = await getRouteMetrics(from, to);
    const driverPerf = await getDriverPerformance(from, to);

    res.json({
      summary: metrics || {},
      driverPerformance: driverPerf || [],
      dateRange: { from, to }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tms/stops/:id/complete — Mark route stop as completed
app.post('/api/tms/stops/:id/complete', requireAuth, requireMysql, express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, photo_url } = req.body;

    await queryMysql(
      'UPDATE route_stops SET status = "completed", completed_at = NOW(), notes = ? WHERE id = ?',
      [notes || null, id]
    );

    // Check if all stops in the route are completed
    const stop = await queryMysql('SELECT route_id FROM route_stops WHERE id = ?', [id]);
    if (stop && stop.length > 0) {
      const routeId = stop[0].route_id;
      const remaining = await queryMysql(
        'SELECT COUNT(*) as count FROM route_stops WHERE route_id = ? AND status != "completed"',
        [routeId]
      );

      if (remaining && remaining.length > 0 && remaining[0].count === 0) {
        // All stops completed, mark route as completed
        await queryMysql('UPDATE routes SET status = "completed" WHERE id = ?', [routeId]);
        logAudit('tms_route_completed', { routeId });
      }
    }

    logAudit('tms_stop_completed', { stopId: id, by: req.userId || 'unknown' });
    res.json({ success: true, message: 'Stop marked as completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tms/stops/:id/fail — Mark route stop as failed
app.post('/api/tms/stops/:id/fail', requireAuth, requireMysql, express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, notes } = req.body;

    await queryMysql(
      'UPDATE route_stops SET status = "failed", notes = ? WHERE id = ?',
      [notes || reason || null, id]
    );

    logAudit('tms_stop_failed', { stopId: id, reason: reason || 'unknown', by: req.userId || 'unknown' });
    res.json({ success: true, message: 'Stop marked as failed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DRIVER APP API ENDPOINTS ─────────────────────────────────────────────────
// Drivers are `db.drivers[]` records (the SAME roster the Transport route
// planner assigns from — see /api/drivers above) with an optional PIN set
// via Transport → Driver Details. This deliberately replaces an earlier,
// broken implementation that authenticated against `users[role==='driver']`
// — a store nothing could ever create a record in (the user-creation form
// only offers admin/warehouse) and, even if it could, whose ids never
// matched `transport.assignedDriver` (populated from db.drivers ids by the
// route planner) — so no job could ever have appeared for a logged-in
// driver. Session tokens are issued through the same `activeSessions` map
// as every other login, just namespaced `driver:<id>` so they can never
// collide with an admin/warehouse user id.
function driverStatusLabel(job) {
  const remarks = String(job?.podRemarks || '').trim();
  if (job?.status === 'confirmed')  return { label: 'Staging', color: '#64748b' };
  if (job?.status === 'in-transit') return { label: 'On the road', color: '#f59e0b' };
  if (job?.status === 'delivered')  return remarks
    ? { label: 'Delivered w/ Remarks', color: '#ef4444' }
    : { label: 'Delivered', color: '#22c55e' };
  if (job?.status === 'cancelled')  return { label: 'Cancelled', color: '#94a3b8' };
  return { label: 'Preplanned', color: '#0ea5e9' };
}
// Local token check (the '/api/driver/' prefix is exempt from the global
// requireAuth middleware — see AUTH_PUBLIC — so each handler checks itself).
function requireDriverAuth(req, res) {
  const token = req.headers['x-auth-token'];
  if (!token) { res.status(401).json({ error: 'Unauthorised' }); return null; }
  for (const [userId, t] of activeSessions) {
    if (t === token && userId.startsWith('driver:')) return userId.slice(7);
  }
  res.status(401).json({ error: 'Session expired' });
  return null;
}

app.post('/api/driver/login', express.json(), (req, res) => {
  const { id, pin } = req.body || {};
  if (!String(id || '').trim() || !String(pin || '').trim()) {
    return res.status(400).json({ error: 'Driver ID and PIN required' });
  }
  const idNorm = String(id).trim().toLowerCase();
  const db = readDb();
  const driver = (db.drivers || []).find(d => String(d.id).trim().toLowerCase() === idNorm);
  if (!driver) {
    logAudit('driver_login_failed', { driver: String(id).trim().slice(0, 60), reason: 'not_found' });
    return res.status(401).json({ error: 'Driver not found' });
  }
  if (!driver.pinHash) {
    return res.status(401).json({ error: 'No PIN set for this driver yet — ask your dispatcher to set one in Transport → Driver Details.' });
  }
  if (hashPass(String(pin).trim(), driver.pinSalt) !== driver.pinHash) {
    logAudit('driver_login_failed', { driver: driver.id, reason: 'bad_pin' });
    return res.status(401).json({ error: 'Invalid PIN' });
  }
  const token = uuidv4();
  const sessionKey = 'driver:' + driver.id;
  const kickedOther = activeSessions.has(sessionKey);
  activeSessions.set(sessionKey, token); // one active device per driver, same rule as user logins
  persistSessions();
  logAudit('driver_login', { driver: driver.id, replacedSession: kickedOther });
  res.json({ token, driver: { id: driver.id, name: driver.name, phone: driver.phone, vehicle: driver.vehicle, plate: driver.plate } });
});

app.post('/api/driver/logout', express.json(), (req, res) => {
  const driverId = requireDriverAuth(req, res);
  if (!driverId) return;
  activeSessions.delete('driver:' + driverId);
  persistSessions();
  logAudit('driver_logout', { driver: driverId });
  res.json({ ok: true });
});

// GET /api/driver/jobs — the logged-in driver's own worklist: everything
// assigned to them that isn't cancelled, sorted into route order (matches
// the sequence the planner gave them), with today's already-delivered stops
// kept visible for reference at the end of the list.
app.get('/api/driver/jobs', (req, res) => {
  const driverId = requireDriverAuth(req, res);
  if (!driverId) return;
  const db = readDb();
  const todayStr = sgDateStr();
  const jobs = (db.transport || [])
    .filter(t => t.assignedDriver === driverId && t.status !== 'cancelled')
    .filter(t => t.status !== 'delivered' || sgDateStr(new Date(t.deliveredAt || 0)) === todayStr)
    .sort((a, b) => (a.routeNum ?? 9999) - (b.routeNum ?? 9999) || (a.stopSeq ?? 9999) - (b.stopSeq ?? 9999))
    .map(t => {
      const st = driverStatusLabel(t);
      return {
        id: t.id,
        client: t.clientName || '',
        referenceId: t.referenceId || t.clientId || '',
        address: t.shipping?.addressLine1 || '',
        zip: t.shipping?.zip || '',
        phone: t.shipping?.phone || '',
        notes: t.notes || '',
        packages: t.packages || 1,
        routeNum: t.routeNum ?? null,
        stopSeq: t.stopSeq ?? null,
        status: t.status || 'pending',
        statusLabel: st.label,
        statusColor: st.color,
        podRemarks: t.podRemarks || '',
        deliveredAt: t.deliveredAt || null,
      };
    });
  res.json({ jobs });
});

// POST /api/driver/jobs/:id/pickup — "I've picked this up, heading out."
// Same transition the office map popup's "Picked Up" button performs, just
// ownership-scoped so a driver can only move their OWN assigned jobs.
app.post('/api/driver/jobs/:id/pickup', express.json(), (req, res) => {
  const driverId = requireDriverAuth(req, res);
  if (!driverId) return;
  const db = readDb();
  const job = (db.transport || []).find(t => t.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.assignedDriver !== driverId) return res.status(403).json({ error: 'This job is not assigned to you' });
  if (job.status !== 'confirmed') return res.status(409).json({ error: `Job is "${job.status}", not ready for pickup` });
  job.status = 'in-transit';
  job.updatedAt = new Date().toISOString();
  _persistDb(db);
  logAudit('driver_job_pickup', { jobId: job.id, driver: driverId, client: job.clientName || '' });
  res.json({ ok: true, job });
});

// POST /api/driver/jobs/:id/deliver — closes out the stop; optional remarks
// mark it "Delivered w/ Remarks" (an issue to follow up), same rule as the
// office Mark Delivered flow.
app.post('/api/driver/jobs/:id/deliver', express.json(), (req, res) => {
  const driverId = requireDriverAuth(req, res);
  if (!driverId) return;
  const { remarks } = req.body || {};
  const db = readDb();
  const job = (db.transport || []).find(t => t.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.assignedDriver !== driverId) return res.status(403).json({ error: 'This job is not assigned to you' });
  if (job.status === 'delivered' || job.status === 'cancelled') return res.status(409).json({ error: `Job is already ${job.status}` });
  job.status = 'delivered';
  job.deliveredAt = new Date().toISOString();
  if (String(remarks || '').trim()) job.podRemarks = String(remarks).trim();
  _persistDb(db);
  logAudit('driver_job_delivered', { jobId: job.id, driver: driverId, client: job.clientName || '', withRemarks: !!String(remarks || '').trim() });
  res.json({ ok: true, job });
});

// NOTE: the old /api/master/drivers* CRUD (a separate users[role=='driver']
// store, disconnected from db.drivers/route planning) was removed here —
// Administrator → Drivers now reads/writes the same /api/drivers roster as
// Transport → Driver Details and the Driver App. See CLAUDE.md "Driver App".

// GET /driver — Serve the driver portal
app.get('/driver', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'driver.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fulfillment Scanner on port ${PORT}`))
  .on('error', err => {
    if (err.code === 'EADDRINUSE') {
      // A second copy is already running — exit cleanly instead of crashing
      console.error(`[IdealScan] Port ${PORT} is already in use — another instance is running. Exiting.`);
      process.exit(1);
    }
    throw err;
  });

// Initialize MySQL in the background (non-blocking)
initMysqlPool().catch(err => console.error('[Startup] MySQL init failed:', err.message));
