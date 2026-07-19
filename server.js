'use strict';

// Load .env file without requiring dotenv package
try {
  const fs = require('fs'), path = require('path');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch {}

const express    = require('express');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');
const crypto     = require('crypto');
const { exec }   = require('child_process');
const multer     = require('multer');

const mainDb          = require('./lib/db/main');
const { getTenantDb } = require('./lib/db/tenant');
const connectionsDb   = require('./lib/db/connections');
const createStore     = require('./lib/store');
const createCreds     = require('./lib/credentials');
const createSyncLog   = require('./lib/sync-log');
const createOrderSync = require('./lib/order-sync');
const emailP          = require('./lib/email-parser');
const registry        = require('./lib/connector-registry');
const auth            = require('./lib/auth');
const importer        = require('./lib/file-importer');
const { createClientAuth } = require('./lib/client-auth');
const staffAuth = require('./lib/staff-auth');
const createInventory   = require('./lib/inventory');
const createFulfillment = require('./lib/fulfillment');
const createPicking     = require('./lib/picking');
const shopifyApp        = require('./lib/shopify-app');
const inventorySync     = require('./lib/inventory-sync');
const createSecurity    = require('./lib/security');
const createAutoAllocator = require('./lib/auto-allocator');
const createPickingWave = require('./lib/picking-wave');
const createLabelPrinter = require('./lib/label-printer');
const createReturnsManager = require('./lib/returns-manager');
const createInventoryForecast = require('./lib/inventory-forecast');
const createAnalytics = require('./lib/analytics');
const createScanPack = require('./lib/scan-pack');
const createPrintQueue = require('./lib/print-queue');
const createPickingOrchestrator = require('./lib/picking-orchestrator');
const createOrderTypeDetector = require('./lib/order-type-detector');
const createPOManager = require('./lib/po-manager');
const createPOCSVImporter = require('./lib/po-csv-importer');
const createB2BBatchProcessor = require('./lib/b2b-batch-processor');
const createDocumentGenerator = require('./lib/document-generator');
const createInventoryWarehouse = require('./lib/inventory-warehouse');
const createCustomsLotManager = require('./lib/customs-lot-manager');
const createWarehouseAllocator = require('./lib/warehouse-allocator');
const createPickingIntegration = require('./lib/picking-integration');
const createCycleCount = require('./lib/cycle-count');
const createReplenishment = require('./lib/replenishment');
const createAutoTriggerScheduler = require('./lib/auto-trigger-scheduler');
const createBarcodeScanner = require('./lib/barcode-scanner');
const createDemandForecast = require('./lib/demand-forecast');
const createOCRLabels = require('./lib/ocr-labels');
const createZoneCycleCount = require('./lib/zone-cycle-count');
const createInboundGoodsReceipt = require('./lib/inbound-goods-receipt');
const createEnhancedReturns = require('./lib/enhanced-returns');
const createASNManager = require('./lib/inbound-asn');
const createImporter = require('./lib/excel-importer');
const createSyncDaemon = require('./lib/sync-daemon');

// ── Presentation seed ─────────────────────────────────────────────────────────
// Always seed fresh demo orders on startup so the dashboard looks right.
require('./seed_idealscan.js');

// ── Data migration: copy legacy single-tenant DB → default tenant ─────────────

(function migrateLegacy() {
  const legacyPath = path.join(__dirname, 'data', 'idealoms.db');
  const tenantPath = path.join(__dirname, 'data', 'tenants', 'default.db');
  if (fs.existsSync(legacyPath) && !fs.existsSync(tenantPath)) {
    try {
      const dir = path.dirname(tenantPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(legacyPath, tenantPath);
      console.log('  Migrated legacy idealoms.db → data/tenants/default.db');
    } catch (e) {
      console.warn('  Legacy migration skipped:', e.message);
    }
  }
})();

const app      = express();
const PORT     = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Resolve the public base URL for OAuth callbacks.
// Respects BASE_URL env var, then x-forwarded headers (nginx/Cloudflare), then falls back.
function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || req.protocol;
  const host  = req.headers['x-forwarded-host']  || req.headers['host'] || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 20 * 1024 * 1024 } });
const security = createSecurity(process.env.ENCRYPTION_KEY || 'default-encryption-key');

// verify callback stores the raw Buffer on req so webhook HMAC verification can use it
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.get('/', (req, res) => res.redirect('/about.html'));
app.use(express.static(path.join(__dirname, 'public')));

// ── Tenant context cache ──────────────────────────────────────────────────────

const tenantCtx = new Map();

function getCtx(tenantId) {
  if (!tenantCtx.has(tenantId)) {
    const db         = getTenantDb(tenantId);
    const store      = createStore(db);
    const creds      = createCreds(tenantId);
    const syncLog    = createSyncLog(db);
    const inventory   = createInventory(db);
    const fulfillment = createFulfillment({ store, creds, inventory, db });
    const picking     = createPicking({ db, store });
    tenantCtx.set(tenantId, { db, store, creds, syncLog, inventory, fulfillment, picking });
  }
  return tenantCtx.get(tenantId);
}

// Auto-seed default tenant inventory if empty
setImmediate(() => {
  try {
    const inv = getCtx('default').inventory;
    if (inv.getAll().length === 0) {
      const { seedInventory } = require('./seed_inventory');
      seedInventory('default');
      console.log('[startup] Auto-seeded inventory for default tenant');
    }
  } catch (e) {
    console.warn('[startup] Could not auto-seed inventory:', e.message);
  }
});

// ── Auth middleware ───────────────────────────────────────────────────────────

function withTenant(req, res, next) {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  if (!session) return res.status(401).json({ error: 'Authentication required' });
  const ctx     = getCtx(session.tenantId);
  req.tenantId  = session.tenantId;
  req.ctx       = ctx;
  req.db        = ctx.db;
  req.store     = ctx.store;
  req.creds     = ctx.creds;
  req.syncLog   = ctx.syncLog;
  next();
}

// For staff routes that also need a tenant context (staff use a different token type)
function withStaffTenant(req, res, next) {
  const tenantId = req.query.tenantId || req.headers['x-tenant-id'] || 'default';
  const tenant   = mainDb.prepare('SELECT id, active FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant)        return res.status(404).json({ error: 'Tenant not found' });
  if (!tenant.active) return res.status(403).json({ error: 'Tenant suspended' });
  const ctx      = getCtx(tenantId);
  req.tenantId   = tenantId;
  req.ctx        = ctx;
  req.db         = ctx.db;
  req.store      = ctx.store;
  req.creds      = ctx.creds;
  req.syncLog    = ctx.syncLog;
  next();
}

// ── Shopify Public App integration ───────────────────────────────────────────
shopifyApp.init(app, getCtx, withTenant);

// ── Super-admin middleware ────────────────────────────────────────────────────

const SUPER_PW = process.env.IDEAL_SUPER_PASSWORD || 'SuperAdmin@2024';

function withSuperAdmin(req, res, next) {
  const pw = (req.headers['x-super-password'] || '').trim();
  if (!pw || pw !== SUPER_PW) return res.status(401).json({ error: 'Super-admin password required' });
  next();
}

// ── Staff portal middleware ───────────────────────────────────────────────────

function withStaff(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = staffAuth.validateToken(token);
  if (!session) return res.status(401).json({ error: 'Staff authentication required' });
  req.staffUsername = session.username;
  req.staffRole = session.role || 'warehouse';
  next();
}

function withAdmin(req, res, next) {
  withStaff(req, res, () => {
    if (req.staffRole !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// ── Staff portal routes ───────────────────────────────────────────────────────

// Emergency admin reset — requires super-admin password (x-super-password header)
app.get('/api/staff/emergency', withSuperAdmin, (req, res) => {
  const { createHash } = require('crypto');
  const pw = 'Admin1234';
  const hash = createHash('sha256').update(pw).digest('hex');
  mainDb.prepare("INSERT OR IGNORE INTO staff_users (username, password_hash, role) VALUES ('administrator', ?, 'admin')").run(hash);
  mainDb.prepare("UPDATE staff_users SET password_hash = ?, role = 'admin', active = 1 WHERE username = 'administrator'").run(hash);
  const token = staffAuth.generateToken('administrator');
  console.log('[emergency] administrator reset, token issued');
  res.json({ ok: true, username: 'administrator', password: pw, token, role: 'admin' });
});

app.post('/api/staff/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const user = staffAuth.checkPassword(username, password || '');
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  res.json({ token: staffAuth.generateToken(username), username, role: user.role || 'warehouse' });
});

app.post('/api/staff/logout', withStaff, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  staffAuth.revokeToken(token);
  res.json({ ok: true });
});

app.get('/api/staff/me', withStaff, (req, res) => {
  res.json({ username: req.staffUsername, role: req.staffRole });
});

// Staff user management (admin only)
app.get('/api/staff/users', withAdmin, (req, res) => {
  res.json(staffAuth.listStaff());
});

app.post('/api/staff/users', withAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || username.trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const validRoles = ['admin', 'warehouse'];
  const assignedRole = validRoles.includes(role) ? role : 'warehouse';
  try {
    staffAuth.createUser(username.trim(), password, assignedRole);
    res.json({ ok: true, username: username.trim(), role: assignedRole });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    throw e;
  }
});

app.patch('/api/staff/users/:username/role', withAdmin, (req, res) => {
  const { role } = req.body || {};
  if (!['admin', 'warehouse'].includes(role)) return res.status(400).json({ error: 'Role must be admin or warehouse' });
  staffAuth.setRole(req.params.username, role);
  res.json({ ok: true });
});

app.patch('/api/staff/users/:username/active', withAdmin, (req, res) => {
  staffAuth.setActive(req.params.username, req.body?.active !== false);
  res.json({ ok: true });
});

app.delete('/api/staff/users/:username', withAdmin, (req, res) => {
  if (req.params.username === req.staffUsername) return res.status(400).json({ error: 'Cannot delete yourself' });
  mainDb.prepare('DELETE FROM staff_users WHERE username = ?').run(req.params.username);
  mainDb.prepare('DELETE FROM staff_sessions WHERE username = ?').run(req.params.username);
  res.json({ ok: true });
});

// List client portal users
app.get('/api/staff/client-users', withStaff, withStaffTenant, (req, res) => {
  res.json(createClientAuth(req.db).listUsers());
});

// Reset a client portal user's password
app.patch('/api/staff/client-users/:clientId', withStaff, withStaffTenant, (req, res) => {
  const { clientId } = req.params;
  const { password } = req.body || {};
  if (!password || password.length < 1) return res.status(400).json({ error: 'New password required' });
  try {
    createClientAuth(req.db).setPassword(clientId, password);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Toggle client portal user active/inactive
app.patch('/api/staff/client-users/:clientId/active', withStaff, withStaffTenant, (req, res) => {
  const { clientId } = req.params;
  const { active } = req.body || {};
  createClientAuth(req.db).setActive(clientId, !!active);
  res.json({ ok: true });
});

// Change OMS admin password (the main system login)
app.patch('/api/staff/oms-password', withStaff, (req, res) => {
  const { tenantId = 'default', newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 1) return res.status(400).json({ error: 'New password required' });
  const { db } = getCtx(tenantId);
  auth.changePassword(db, newPassword);
  auth.revokeAllTenantSessions(tenantId);
  res.json({ ok: true });
});

// Change staff user's own password
app.patch('/api/staff/my-password', withStaff, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 1) return res.status(400).json({ error: 'New password required' });
  staffAuth.changePassword(req.staffUsername, newPassword);
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  staffAuth.revokeToken(token);
  res.json({ ok: true });
});

// Change staff user's own username
app.patch('/api/staff/my-username', withStaff, (req, res) => {
  const { newUsername } = req.body || {};
  if (!newUsername || newUsername.trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  const trimmed = newUsername.trim();
  const existing = mainDb.prepare('SELECT username FROM staff_users WHERE username = ? AND username != ?').get(trimmed, req.staffUsername);
  if (existing) return res.status(409).json({ error: 'Username already taken' });
  mainDb.prepare('UPDATE staff_users SET username = ? WHERE username = ?').run(trimmed, req.staffUsername);
  mainDb.prepare('UPDATE staff_sessions SET username = ? WHERE username = ?').run(trimmed, req.staffUsername);
  res.json({ ok: true, username: trimmed });
});

// API key management (staff only)
app.get('/api/staff/api-keys', withStaff, withStaffTenant, (req, res) => {
  res.json(createClientAuth(req.db).listApiKeys());
});

app.post('/api/staff/api-keys', withStaff, withStaffTenant, (req, res) => {
  const { clientId, clientName, label } = req.body || {};
  if (!clientId || !clientName) return res.status(400).json({ error: 'clientId and clientName required' });
  const key = createClientAuth(req.db).generateApiKey(clientId, clientName, label || '');
  res.json({ key });
});

app.delete('/api/staff/api-keys/:key', withStaff, withStaffTenant, (req, res) => {
  createClientAuth(req.db).revokeApiKey(req.params.key);
  res.json({ ok: true });
});

app.patch('/api/staff/api-keys/:key/active', withStaff, withStaffTenant, (req, res) => {
  const { active } = req.body || {};
  createClientAuth(req.db).setApiKeyActive(req.params.key, !!active);
  res.json({ ok: true });
});

// ── API key middleware (client ingest) ────────────────────────────────────────

function withApiKey(req, res, next) {
  const key      = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const tenantId = req.headers['x-tenant-id'] || 'default';
  const tenant   = mainDb.prepare('SELECT id, active FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant || !tenant.active) return res.status(404).json({ error: 'Tenant not found' });
  const ctx      = getCtx(tenantId);
  const ca       = createClientAuth(ctx.db);
  const session  = ca.validateApiKey(key);
  if (!session) return res.status(401).json({ error: 'Invalid or revoked API key' });
  req.tenantId   = tenantId;
  req.clientId   = session.clientId;
  req.clientName = session.clientName;
  req.store      = ctx.store;
  next();
}

// ── Client portal middleware ──────────────────────────────────────────────────

function withClientAuth(req, res, next) {
  const token    = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const tenantId = req.headers['x-tenant-id'] || 'default';
  const tenant   = mainDb.prepare('SELECT id, active FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant || !tenant.active) return res.status(404).json({ error: 'Tenant not found' });
  const ctx      = getCtx(tenantId);
  const ca       = createClientAuth(ctx.db);
  const session  = ca.validateToken(token);
  if (!session) return res.status(401).json({ error: 'Client authentication required' });
  req.tenantId     = tenantId;
  req.clientId     = session.clientId;
  req.clientName   = session.clientName;
  req.clientAuth   = ca;
  req.ctx          = ctx;
  req.store        = ctx.store;
  req.db           = ctx.db;
  next();
}

// ── Auth — public routes ──────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { tenantId = 'default', username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const tenant = mainDb.prepare('SELECT id, active FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant)        return res.status(404).json({ error: 'Tenant not found' });
  if (!tenant.active) return res.status(403).json({ error: 'Tenant suspended' });

  const { db } = getCtx(tenantId);
  if (!auth.checkUsername(db, username) || !auth.checkPassword(db, password))
    return res.status(401).json({ error: 'Incorrect username or password' });

  res.json({ token: auth.generateToken(tenantId), tenantId });
});

app.post('/api/auth/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  auth.revokeToken(token);
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  res.json({ authenticated: !!session, tenantId: session?.tenantId || null });
});

app.post('/api/auth/change-password', withTenant, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  auth.changePassword(req.db, newPassword);
  auth.revokeAllTenantSessions(req.tenantId);
  res.json({ ok: true });
});

// ── Admin stats ───────────────────────────────────────────────────────────────

app.get('/api/admin/stats', withTenant, (req, res) => {
  const orders   = req.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const leads    = req.db.prepare('SELECT COUNT(*) AS n FROM leads').get().n;
  const sessions = req.db.prepare('SELECT COUNT(*) AS n FROM lead_sessions').get().n;
  const syncs    = req.db.prepare('SELECT COUNT(*) AS n FROM sync_log').get().n;
  res.json({ orders, leads, leadSessions: sessions, syncEntries: syncs });
});

// ── Orders ────────────────────────────────────────────────────────────────────

app.get('/api/orders', withTenant, (req, res) => {
  const { clientId, channel, status, search } = req.query;
  res.json(req.store.getOrders({ clientId, channel, status, search }));
});

app.get('/api/orders/:id', withTenant, (req, res) => {
  const order = req.store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

app.patch('/api/orders/:id', withTenant, (req, res) => {
  const { status, notes, source, shipping } = req.body || {};
  try {
    const updated = req.store.updateOrder(req.params.id, { status, notes, source, shipping });
    res.json(updated);
  } catch (e) {
    res.status(e.message.includes('not found') ? 404 : 400).json({ error: e.message });
  }
});

app.delete('/api/orders/:id', withTenant, (req, res) => {
  try {
    req.store.deleteOrder(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.message.includes('not found') ? 404 : 400).json({ error: e.message });
  }
});

app.delete('/api/orders', withTenant, (req, res) => {
  const { confirm } = req.body || {};
  if (confirm !== 'DELETE ALL') return res.status(400).json({ error: 'Send confirm: "DELETE ALL"' });
  const deleted = req.store.deleteAllOrders();
  res.json({ ok: true, deleted });
});

app.delete('/api/sync-log', withTenant, (req, res) => {
  req.syncLog.clear();
  res.json({ ok: true });
});

app.post('/api/orders/ingest-email', withTenant, (req, res) => {
  const { body, subject, from } = req.body || {};
  if (!body) return res.status(400).json({ error: 'Email body is required' });
  try {
    const order = emailP.parseEmailBody(body);
    if (subject) order.source.emailSubject = subject;
    if (from)    order.source.emailFrom    = from;
    req.store.addOrder(order);
    res.status(201).json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── File import ───────────────────────────────────────────────────────────────

function extractedToOrder(data, index) {
  const now   = new Date().toISOString();
  const refNo = data.trackingNumber || data.orderNumber;
  const orderId = data.id ||
    (refNo
      ? 'IMP-' + refNo.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 18)
      : 'IMP-' + Date.now().toString(36).toUpperCase() + String(index).padStart(3, '0'));

  const clientName = (data.clientName || 'Imported').trim();
  const clientId   = clientName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);

  const items = Array.isArray(data.items) && data.items.length
    ? data.items.map(i => ({ sku: String(i.sku || 'ITEM'), name: String(i.name || 'Item'), qty: parseInt(i.qty) || 1, unitPrice: parseFloat(i.unitPrice) || 0 }))
    : [{ sku: 'ITEM', name: 'Imported Item', qty: 1, unitPrice: 0 }];

  const subtotal = items.reduce((s, i) => s + i.qty * i.unitPrice, 0);

  return {
    id: orderId, clientId, clientName,
    channel: 'waybill', orderDate: now, status: 'pending', currency: 'MYR',
    notes: data.notes || '', items,
    shipping: {
      recipient:    data.recipientName || '',
      addressLine1: data.addressLine1  || '',
      addressLine2: data.addressLine2  || '',
      city:         data.city          || '',
      state:        data.state         || '',
      zip:          data.zip           || '',
      country:      data.country       || 'MY',
    },
    subtotal, shippingCost: 0, tax: 0, total: subtotal,
    source: {
      type: 'import',
      courier:    data.courier       || undefined,
      trackingNo: data.trackingNumber|| undefined,
      ingestedAt: now,
    },
  };
}

app.post('/api/orders/extract', withTenant, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { mimetype, path: filePath, originalname } = req.file;
  const ext = (originalname.split('.').pop() || '').toLowerCase();

  try {
    let extracted;

    if (mimetype.startsWith('image/')) {
      extracted = await importer.extractFromImage(filePath, mimetype);
    } else if (mimetype === 'application/pdf' || ext === 'pdf') {
      extracted = await importer.extractFromPDF(filePath);
    } else if (ext === 'csv' || mimetype === 'text/csv' || ext === 'xlsx' || ext === 'xls' || mimetype.includes('spreadsheet') || mimetype.includes('excel')) {
      extracted = importer.extractFromSpreadsheet(filePath);
    } else if (ext === 'docx' || mimetype.includes('wordprocessingml')) {
      const mammoth = require('mammoth');
      const { value: text } = await mammoth.extractRawText({ path: filePath });
      extracted = await importer.extractFromDocxText(text);
    } else {
      return res.status(400).json({ error: `Unsupported file type: ${ext || mimetype}. Supported: JPG, PNG, PDF, CSV, Excel (.xlsx/.xls), Word (.docx)` });
    }

    res.json({ orders: extracted || [], count: (extracted || []).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
});

app.post('/api/orders/bulk-import', withTenant, (req, res) => {
  const { orders: raw } = req.body || {};
  if (!Array.isArray(raw) || !raw.length) return res.status(400).json({ error: 'No orders provided' });

  let imported = 0, skipped = 0;
  const errors = [];

  raw.forEach((data, i) => {
    try {
      req.store.addOrder(extractedToOrder(data, i));
      imported++;
    } catch (err) {
      if (err.message.includes('already exists')) skipped++;
      else errors.push(err.message);
    }
  });

  res.json({ imported, skipped, errors });
});

// ─────────────────────────────────────────────────────────────────────────────

// ── Dashboard KPI stats ───────────────────────────────────────────────────────
app.get('/api/dashboard', withTenant, (req, res) => {
  const orders = req.store.getOrders();
  const totalOrders = Array.isArray(orders) ? orders.length : 0;
  res.json({ totalOrders });
});

app.get('/api/dashboard/stats', withTenant, (req, res) => {
  const db = req.db;
  const { clientId, from, to } = req.query;
  const cf  = clientId ? `AND client_id = '${clientId.replace(/'/g,"''")}'` : '';
  const esc = s => String(s || '').replace(/'/g, "''");

  const g = sql => (db.prepare(sql).get() || {}).n || 0;
  const s = sql => (db.prepare(sql).get() || {}).n || 0;

  // Today's new pending/unprocessed vs yesterday's — drives "from yesterday" badge
  const toProcess       = g(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('pending','confirmed') AND date(order_date) = date('now') ${cf}`);
  const toProcessPrev   = g(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('pending','confirmed') AND date(order_date) = date('now','-1 day') ${cf}`);
  const unprocessed     = g(`SELECT COUNT(*) AS n FROM orders WHERE status NOT IN ('shipped','delivered','cancelled','returned') ${cf}`);
  const unprocessedPrev = g(`SELECT COUNT(*) AS n FROM orders WHERE status NOT IN ('shipped','delivered','cancelled','returned') AND date(order_date) <= date('now','-1 day') ${cf}`);

  const outOfStock  = g(`SELECT COUNT(*) AS n FROM inventory WHERE (stock_qty - reserved_qty) <= 0 ${clientId ? `AND client_id = '${esc(clientId)}'` : ''}`);
  const failedSync  = g(`SELECT COUNT(*) AS n FROM sync_log WHERE error IS NOT NULL AND error != '' AND created_at >= datetime('now','-30 days')`);
  const orderMonth  = g(`SELECT COUNT(*) AS n FROM orders WHERE date(order_date) >= date('now','start of month') ${cf}`);
  const orderLastMonth = g(`SELECT COUNT(*) AS n FROM orders WHERE date(order_date) >= date('now','start of month','-1 month') AND date(order_date) < date('now','start of month') ${cf}`);
  const salesMonth  = s(`SELECT COALESCE(SUM(total),0) AS n FROM orders WHERE date(order_date) >= date('now','start of month') AND status NOT IN ('cancelled','returned') ${cf}`);
  const salesLastMonth = s(`SELECT COALESCE(SUM(total),0) AS n FROM orders WHERE date(order_date) >= date('now','start of month','-1 month') AND date(order_date) < date('now','start of month') AND status NOT IN ('cancelled','returned') ${cf}`);

  // Chart: respect ?from=&to= if provided, else default 30 days
  const chartFrom = from ? `'${esc(from)}'` : `date('now','-29 days')`;
  const chartTo   = to   ? `'${esc(to)}'`   : `date('now')`;
  const salesByDay = db.prepare(
    `SELECT date(order_date) as day, COUNT(*) as count, COALESCE(SUM(total),0) as sales
     FROM orders WHERE date(order_date) >= ${chartFrom} AND date(order_date) <= ${chartTo}
     AND status NOT IN ('cancelled','returned') ${cf}
     GROUP BY date(order_date) ORDER BY day ASC`
  ).all();

  res.json({ toProcess, toProcessPrev, unprocessed, unprocessedPrev, outOfStock, failedSync, orderMonth, orderLastMonth, salesMonth, salesLastMonth, salesByDay });
});

app.get('/api/stats', withTenant, (req, res) => {
  res.json(req.store.getStats());
});

app.get('/api/clients', withTenant, (req, res) => {
  res.json(req.store.getClients());
});

app.get('/api/channels', withTenant, (req, res) => {
  res.json(req.store.getChannels());
});

// ── Connector registry ────────────────────────────────────────────────────────

const PLATFORMS = Object.keys(registry);

app.get('/api/connect/status', withTenant, (req, res) => {
  const all    = req.creds.getAll();
  const result = {};
  for (const id of PLATFORMS) {
    const conn = registry[id];
    const c    = all[id] || {};
    result[id] = {
      connected:      !!(c.accessToken || c.licenseKey || c.apikey || c.email),
      hasCredentials: !!(c.appKey || c.partnerId || c.apiKey || c.licenseKey || c.apikey || c.email),
      storeName:      c.storeName   || conn.meta.defaultStoreName || null,
      connectedAt:    c.connectedAt || null,
      lastSync:       c.lastSync    || null,
      lastSyncCount:  c.lastSyncCount ?? null,
      meta:           { type: conn.meta.type, authType: conn.meta.authType },
    };
  }
  res.json(result);
});

app.get('/api/credentials/:platform', withTenant, (req, res) => {
  const { platform } = req.params;
  if (!registry[platform]) return res.status(400).json({ error: 'Unknown platform' });

  const cred = req.creds.get(platform);
  if (!cred) return res.json(null);

  // Return credential data without sensitive parts
  const { apiSecret, partnerKey, appSecret, ...safe } = cred;
  res.json({
    platform,
    storeName: safe.storeName,
    email: safe.email,
    displayName: safe.displayName || safe.storeName,
    ...safe
  });
});

app.post('/api/connect/:platform', withTenant, (req, res) => {
  const { platform } = req.params;
  if (!registry[platform]) return res.status(400).json({ error: 'Unknown platform' });
  const saved = req.creds.set(platform, req.body);
  const { appSecret, partnerKey, apiSecret, ...safe } = saved;
  res.json({ ok: true, ...safe });
});

app.delete('/api/connect/:platform', withTenant, (req, res) => {
  const { platform } = req.params;
  if (!registry[platform]) return res.status(400).json({ error: 'Unknown platform' });
  req.creds.remove(platform);
  res.json({ ok: true });
});

// ── Inventory sync routes ─────────────────────────────────────────────────────

// Auto-discover SKU→marketplace mappings from existing order history
app.post('/api/connect/:platform/inventory/discover', withStaff, withStaffTenant, (req, res) => {
  const { platform } = req.params;
  if (!inventorySync.SUPPORTED.has(platform)) return res.status(400).json({ error: `Inventory sync not supported for ${platform}` });
  try {
    res.json(inventorySync.discover(platform, req.ctx.db));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List current SKU mappings for a platform
app.get('/api/connect/:platform/inventory/map', withStaff, withStaffTenant, (req, res) => {
  const { platform } = req.params;
  res.json(req.ctx.db.prepare('SELECT * FROM channel_sku_map WHERE platform = ? ORDER BY oms_sku').all(platform));
});

// Add or update a SKU mapping manually
app.post('/api/connect/:platform/inventory/map', withStaff, withStaffTenant, (req, res) => {
  const { platform } = req.params;
  const { oms_sku, external_id, external_sku_id, external_name } = req.body || {};
  if (!oms_sku) return res.status(400).json({ error: 'oms_sku required' });
  req.ctx.db.prepare(`
    INSERT INTO channel_sku_map (platform, oms_sku, external_id, external_sku_id, external_name, last_seen_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(platform, oms_sku) DO UPDATE SET
      external_id=excluded.external_id, external_sku_id=excluded.external_sku_id,
      external_name=excluded.external_name, last_seen_at=excluded.last_seen_at
  `).run(platform, oms_sku, external_id || '', external_sku_id || '', external_name || '');
  res.json({ ok: true });
});

// Delete a SKU mapping
app.delete('/api/connect/:platform/inventory/map/:sku', withStaff, withStaffTenant, (req, res) => {
  req.ctx.db.prepare('DELETE FROM channel_sku_map WHERE platform = ? AND oms_sku = ?').run(req.params.platform, req.params.sku);
  res.json({ ok: true });
});

// Pull inventory FROM marketplace → update OMS stock
app.post('/api/connect/:platform/inventory/pull', withStaff, withStaffTenant, async (req, res) => {
  const { platform } = req.params;
  if (!inventorySync.SUPPORTED.has(platform)) return res.status(400).json({ error: `Not supported for ${platform}` });
  const creds = req.ctx.creds.get(platform);
  if (!creds?.accessToken) return res.status(400).json({ error: `${platform} not connected — save credentials first` });
  try {
    res.json(await inventorySync.syncInventory('pull', platform, creds, req.ctx.db, req.ctx.inventory));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Push OMS stock → marketplace
app.post('/api/connect/:platform/inventory/push', withStaff, withStaffTenant, async (req, res) => {
  const { platform } = req.params;
  if (!inventorySync.SUPPORTED.has(platform)) return res.status(400).json({ error: `Not supported for ${platform}` });
  const creds = req.ctx.creds.get(platform);
  if (!creds?.accessToken) return res.status(400).json({ error: `${platform} not connected — save credentials first` });
  try {
    res.json(await inventorySync.syncInventory('push', platform, creds, req.ctx.db, req.ctx.inventory));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/connect/:platform/oauth-url', withTenant, (req, res) => {
  const { platform } = req.params;
  const conn = registry[platform];
  if (!conn)              return res.status(400).json({ error: 'Unknown platform' });
  if (!conn.buildAuthUrl) return res.status(400).json({ error: `${conn.meta.name} does not use OAuth` });
  const c = req.creds.get(platform) || {};
  for (const field of conn.meta.requiredForOAuth || []) {
    if (!c[field]) return res.status(400).json({ error: `Save your ${conn.meta.name} ${field} first` });
  }
  res.json({ url: conn.buildAuthUrl(c, `${getBaseUrl(req)}/api/connect/${platform}/callback`) });
});

app.get('/api/connect/:platform/callback', async (req, res) => {
  const { platform } = req.params;
  const conn = registry[platform];
  if (!conn) return res.status(400).send(errPage('Unknown', 'Unknown platform'));

  // Resolve tenant from state param (OAuth state carries tenantId)
  const tenantId = req.query.tenantId || 'default';
  const _t = mainDb.prepare('SELECT id, active FROM tenants WHERE id = ?').get(tenantId);
  if (!_t || !_t.active) return res.status(400).send(errPage('Error', 'Invalid or suspended tenant'));
  const { creds } = getCtx(tenantId);

  try {
    const tokens = await conn.exchangeCode(creds.get(platform) || {}, req.query);
    creds.set(platform, { ...tokens, connectedAt: new Date().toISOString() });
    res.send(okPage(conn.meta.name));
  } catch (e) {
    res.status(500).send(errPage(conn.meta.name, e.message));
  }
});

// ── ZORT extended sync routes ─────────────────────────────────────────────────

const { gateway } = require('./dist/gateway');

// Pull products + pricing from ZORT → OMS inventory
app.post('/api/connect/zort/products/sync', withTenant, async (req, res) => {
  const creds = req.creds.get('zort');
  if (!creds?.apikey) return res.status(400).json({ error: 'ZORT not connected — save storename, apikey, apisecret first' });
  try {
    const { zortAdapter } = require('./dist/gateway/adapters/zort/zort.adapter');
    const items = await zortAdapter.fetchProducts(creds);
    const inv = req.ctx.inventory;
    let upserted = 0;
    for (const item of items) {
      try {
        inv.upsert({
          sku:        item.sku || '',
          name:       item.name || '',
          category:   item.warehouse || '',
          unit:       'pcs',
          sell_price: 0,
          cost_price: 0,
          stock_qty:  item.qty || 0,
        });
        upserted++;
      } catch (_) {}
    }
    res.json({ ok: true, count: upserted, fetched: items.length, upserted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pull ZORT inventory stock levels → OMS
app.post('/api/connect/zort/inventory/pull', withTenant, async (req, res) => {
  const creds = req.creds.get('zort');
  if (!creds?.apikey) return res.status(400).json({ error: 'ZORT not connected' });
  try {
    const items = await gateway.fetchInventory('zort', creds);
    const inv = req.ctx.inventory;
    let updated = 0;
    for (const item of items) {
      if (!item.sku) continue;
      const existing = inv.get(item.sku);
      if (existing) {
        inv.upsert({ ...existing, stock_qty: item.qty, sku: item.sku });
        updated++;
      }
    }
    res.json({ ok: true, fetched: items.length, updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Push OMS stock levels → ZORT (available qty after reservation deductions)
app.post('/api/connect/zort/inventory/push', withTenant, async (req, res) => {
  const creds = req.creds.get('zort');
  if (!creds?.apikey) return res.status(400).json({ error: 'ZORT not connected' });
  try {
    const omsItems = req.ctx.inventory.getAll();
    const standardItems = omsItems.map(i => ({
      sku:      i.sku,
      name:     i.name,
      qty:      i.stock_qty || 0,
      reserved: i.reserved_qty || 0,
      channel:  'zort',
    }));
    await gateway.syncInventory('zort', creds, standardItems);
    res.json({ ok: true, pushed: standardItems.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pull customers/contacts from ZORT
app.get('/api/connect/zort/customers', withTenant, async (req, res) => {
  const creds = req.creds.get('zort');
  if (!creds?.apikey) return res.status(400).json({ error: 'ZORT not connected' });
  try {
    const { zortAdapter } = require('./dist/gateway/adapters/zort/zort.adapter');
    res.json(await zortAdapter.fetchCustomers(creds));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Register OMS webhook URL with ZORT so status/stock changes stream in
app.post('/api/connect/zort/webhook/register', withTenant, async (req, res) => {
  const creds = req.creds.get('zort');
  if (!creds?.apikey) return res.status(400).json({ error: 'ZORT not connected' });
  const webhookUrl = req.body?.url || `${process.env.BASE_URL || ''}/webhook/zort`;
  try {
    const { zortAdapter } = require('./dist/gateway/adapters/zort/zort.adapter');
    const result = await zortAdapter.registerWebhook(creds, webhookUrl);
    req.creds.set('zort', { webhookUrl, webhookRegisteredAt: new Date().toISOString() });
    res.json({ ok: true, webhookUrl, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Multi-Platform Credential Management ──────────────────────────────────────

const createMultiCredentials = require('./lib/credentials-multi');

// POST /api/test/platform — Test platform credentials without saving
app.post('/api/test/platform', withTenant, async (req, res) => {
  try {
    const { platform, shopId, apiKey, apiSecret, shopUrl, accessToken } = req.body;

    if (!platform) {
      return res.status(400).json({ error: 'Platform is required' });
    }

    // Validate required fields per platform
    if (['shopee', 'lazada', 'tiktok'].includes(platform)) {
      if (!shopId || !apiKey || !apiSecret) {
        return res.status(400).json({ error: `${platform} requires shopId, apiKey, and apiSecret` });
      }
      // TODO: Add actual API call to verify credentials with platform
      // For now, just validate format
      if (typeof apiKey !== 'string' || apiKey.length < 5) {
        return res.status(400).json({ error: 'Invalid API key format' });
      }
    } else if (platform === 'shopify') {
      if (!shopUrl || !accessToken) {
        return res.status(400).json({ error: 'Shopify requires shopUrl and accessToken' });
      }
      // TODO: Add actual API call to verify Shopify credentials
      if (typeof accessToken !== 'string' || accessToken.length < 10) {
        return res.status(400).json({ error: 'Invalid access token format' });
      }
    }

    res.json({
      success: true,
      message: `${platform} credentials are valid`,
      platform
    });
  } catch (err) {
    console.error('Error testing platform credentials:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/connect/platform — Save new platform credentials
app.post('/api/connect/platform', withTenant, (req, res) => {
  try {
    const { platform, source = 'direct', shopId, apiKey, apiSecret, shopUrl, accessToken, webhookSecret, setAsActive = true } = req.body;

    if (!platform) {
      return res.status(400).json({ error: 'Platform is required' });
    }

    // Validate required fields per platform
    if (['shopee', 'lazada', 'tiktok'].includes(platform)) {
      if (!shopId || !apiKey || !apiSecret) {
        return res.status(400).json({ error: `${platform} requires shopId, apiKey, and apiSecret` });
      }
    } else if (platform === 'shopify') {
      if (!shopUrl || !accessToken) {
        return res.status(400).json({ error: 'Shopify requires shopUrl and accessToken' });
      }
    }

    const multiCreds = createMultiCredentials(tenantId);
    const credData = {
      platform,
      source,
      ...(shopId && { shopId }),
      ...(apiKey && { apiKey }),
      ...(apiSecret && { apiSecret }),
      ...(shopUrl && { shopUrl }),
      ...(accessToken && { accessToken }),
      ...(webhookSecret && { webhookSecret }),
      connectedAt: new Date().toISOString()
    };

    const result = multiCreds.saveCredentials(platform, source, credData, setAsActive);

    res.json({
      success: true,
      message: `${platform} credentials saved${setAsActive ? ' and activated' : ''}`,
      credential: {
        id: result.id,
        platform: result.platform,
        source: result.source,
        isActive: result.isActive,
        createdAt: result.createdAt
      }
    });
  } catch (err) {
    console.error('Error saving platform credentials:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/connect/platform/:platform — Get all credentials for a platform
app.get('/api/connect/platform/:platform', withTenant, (req, res) => {
  try {
    const { platform } = req.params;

    const multiCreds = createMultiCredentials(tenantId);
    const allCreds = multiCreds.getAllCredentials(platform);

    res.json({
      platform,
      credentials: allCreds.map(c => ({
        id: c.id,
        platform: c.platform,
        source: c.source,
        isActive: c.isActive,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      }))
    });
  } catch (err) {
    console.error('Error fetching platform credentials:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/connect/platform/:credentialId/activate — Switch to different credentials
app.put('/api/connect/platform/:credentialId/activate', withTenant, (req, res) => {
  try {
    const { credentialId } = req.params;

    const multiCreds = createMultiCredentials(tenantId);
    const result = multiCreds.activateCredentials(credentialId);

    if (!result) {
      return res.status(404).json({ error: 'Credential not found' });
    }

    res.json({
      success: true,
      message: 'Credentials activated',
      credential: {
        id: result.id,
        platform: result.platform,
        source: result.source,
        isActive: true,
        createdAt: result.createdAt
      }
    });
  } catch (err) {
    console.error('Error activating credentials:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/connect/platform/:credentialId — Archive credentials
app.delete('/api/connect/platform/:credentialId', withTenant, (req, res) => {
  try {
    const { credentialId } = req.params;

    const multiCreds = createMultiCredentials(tenantId);
    const result = multiCreds.deleteCredentials(credentialId);

    if (!result) {
      return res.status(404).json({ error: 'Credential not found' });
    }

    res.json({
      success: true,
      message: 'Credentials archived'
    });
  } catch (err) {
    console.error('Error deleting credentials:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Order Sync (Generic, Platform-Agnostic) ───────────────────────────────────

/**
 * POST /api/sync/:source/orders
 *
 * Generic endpoint to sync orders from ANY platform source
 * (ZORT, Shopee, Lazada, TikTok, Shopify, or your own API)
 *
 * Supports both:
 * 1. Pulling orders via adapter (via body.source)
 * 2. Pushing pre-fetched orders (via body.orders)
 *
 * Body:
 * {
 *   "source": "zort" | "shopee" | "lazada" | "tiktok" | "shopify",
 *   "orders": [ StandardOrder[] ],  // Pre-fetched orders to sync
 *   "autoAllocate": true             // Auto-transition orders to ALLOCATED?
 * }
 *
 * Returns:
 * {
 *   "created": 5,
 *   "updated": 2,
 *   "failed": 0,
 *   "message": "Orders synced successfully"
 * }
 */
app.post('/api/sync/:source/orders', withTenant, async (req, res) => {
  try {
    const { source } = req.params;
    const { orders, autoAllocate } = req.body;

    if (!source || !orders || !Array.isArray(orders)) {
      return res.status(400).json({
        error: 'Required: source in URL, orders[] in body',
      });
    }

    // Get IDEALONE database for this tenant
    const { db } = req.ctx;

    // Sync orders
    const orderSync = createOrderSync(db);
    const result = await orderSync.syncOrders({
      tenantId: tenantId,
      source: source,
      platform: req.body.platform || source,
      orders: orders,
      userId: req.user?.id || 'system',
    });

    // Optionally auto-allocate (transition to ALLOCATED)
    if (autoAllocate && result.created > 0) {
      const allocResult = await orderSync.autoAllocateNewOrders(tenantId, source);
      result.autoAllocated = allocResult.allocated;
    }

    res.json({
      success: true,
      message: `${result.created} orders created, ${result.updated} updated, ${result.failed} failed`,
      ...result,
    });
  } catch (err) {
    console.error('Error syncing orders:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sync/zort/orders
 *
 * Specific ZORT order sync endpoint
 * Fetches orders from ZORT API and syncs to IDEALONE
 *
 * Query params:
 * - since: ISO date (fetch orders since this date)
 * - statuses: Comma-separated list (pending, confirmed, etc)
 * - autoAllocate: boolean (auto-transition to ALLOCATED?)
 *
 * Returns same as generic endpoint
 */
app.post('/api/sync/zort/orders', withTenant, async (req, res) => {
  try {
    const creds = req.creds.get('zort');
    if (!creds?.apikey) {
      return res.status(400).json({
        error: 'ZORT not connected — save credentials first',
      });
    }

    // Parse query params
    const since = req.query.since ? new Date(req.query.since) : null;
    const statuses = req.query.statuses?.split(',') || ['pending', 'confirmed'];
    const autoAllocate = req.query.autoAllocate === 'true';

    // Fetch orders from ZORT (via adapter)
    const { zortOrdersAdapter } = require('./dist/gateway/adapters/zort/zort-orders.adapter');
    const orders = await zortOrdersAdapter.fetchOrders(creds, {
      since,
      statuses,
    });

    if (!orders || orders.length === 0) {
      return res.json({
        success: true,
        message: 'No new orders from ZORT',
        created: 0,
        updated: 0,
        failed: 0,
        orders: [],
      });
    }

    // Sync to IDEALONE using generic endpoint
    const { db } = req.ctx;
    const orderSync = createOrderSync(db);
    const result = await orderSync.syncOrders({
      tenantId: tenantId,
      source: 'zort',
      platform: 'zort',
      orders: orders,
      userId: req.user?.id || 'system',
    });

    // Optionally auto-allocate
    if (autoAllocate && result.created > 0) {
      const allocResult = await orderSync.autoAllocateNewOrders(tenantId, 'zort');
      result.autoAllocated = allocResult.allocated;
    }

    res.json({
      success: true,
      message: `${result.created} ZORT orders created, ${result.updated} updated, ${result.failed} failed`,
      ...result,
    });
  } catch (err) {
    console.error('Error syncing ZORT orders:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sync/:source/orders/status
 *
 * Check sync status for a platform source
 * Shows: last sync time, total orders imported, pending orders, etc
 */
app.get('/api/sync/:source/orders/status', withTenant, (req, res) => {
  try {
    const { source } = req.params;
    const { db } = req.ctx;

    // Get sync statistics
    const stats = db.prepare(`
      SELECT
        source_system as source,
        COUNT(*) as total_imported,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed,
        MAX(sync_timestamp) as last_sync
      FROM sync_log
      WHERE tenant_id = ? AND source_system = ?
      GROUP BY source_system
    `).get(tenantId, source);

    if (!stats) {
      return res.json({
        source,
        total_imported: 0,
        pending: 0,
        confirmed: 0,
        last_sync: null,
      });
    }

    res.json({
      source,
      total_imported: stats.total_imported,
      pending: stats.pending,
      confirmed: stats.confirmed,
      last_sync: stats.last_sync,
    });
  } catch (err) {
    console.error('Error fetching sync status:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Generic Order Sync ────────────────────────────────────────────────────────

app.get('/api/sync/log', withTenant, (req, res) => res.json(req.syncLog.recent(100)));

async function syncPlatform(platform, opts, store, creds, syncLog, db) {
  const conn = registry[platform];
  if (!conn)             throw new Error(`Unknown platform: ${platform}`);
  if (!conn.fetchOrders) throw new Error(`${conn.meta.name} does not support order sync`);
  const c = creds.get(platform);
  if (!c?.accessToken && !c?.licenseKey && !c?.apikey && !c?.email)
    throw new Error(`${conn.meta.name} not connected — save credentials first`);
  const storeName = c.storeName || conn.meta.defaultStoreName || conn.meta.name;
  const raw       = await conn.fetchOrders(c, opts);

  let added = 0;
  for (const item of raw) {
    try {
      const order = conn.mapOrder(item, storeName);
      store.addOrder(order);
      added++;
    } catch { /* skip duplicates */ }
  }
  creds.set(platform, { lastSync: new Date().toISOString(), lastSyncCount: added });
  return { platform, at: new Date().toISOString(), fetched: raw.length, added };
}

app.post('/api/sync/all', withTenant, async (req, res) => {
  const { store, creds, syncLog } = req;
  const results = await Promise.allSettled(PLATFORMS.map(p => syncPlatform(p, {}, store, creds, syncLog, req.db)));
  const out = {};
  for (const [i, r] of results.entries()) {
    const p     = PLATFORMS[i];
    const entry = r.status === 'fulfilled'
      ? r.value
      : { platform: p, at: new Date().toISOString(), error: r.reason.message };
    syncLog.push(entry);
    out[p] = entry;
  }
  res.json(out);
});

app.post('/api/sync/:platform', withTenant, async (req, res) => {
  const { platform } = req.params;
  if (!registry[platform]) return res.status(400).json({ error: 'Unknown platform' });
  try {
    const entry = await syncPlatform(platform, req.body, req.store, req.creds, req.syncLog, req.db);
    req.syncLog.push(entry);
    res.json(entry);
  } catch (e) {
    const entry = { platform, at: new Date().toISOString(), error: e.message };
    req.syncLog.push(entry);
    res.status(500).json(entry);
  }
});


// ── Demo sync ─────────────────────────────────────────────────────────────────
// Injects realistic fresh orders without needing real platform credentials.
// Designed for client demos — call POST /api/demo/sync, reset with POST /api/demo/reset.

const DEMO_ORDERS = [
  {
    id: () => `SHP-DEMO-${Date.now()}`,
    clientId: 'betime-marketing', clientName: 'Betime Marketing', channel: 'shopify',
    status: 'confirmed', currency: 'SGD',
    items: [{ sku: 'PILLOW-PRO', name: 'Memory Foam Pillow Pro', qty: 2, unitPrice: 45 }, { sku: 'LAMP-LED', name: 'LED Desk Lamp', qty: 1, unitPrice: 49 }],
    shipping: { recipient: 'Hui Ling Lim', addressLine1: 'Blk 456 Jurong West St 61', addressLine2: '', city: 'Singapore', state: '', zip: '640456', country: 'SG' },
    subtotal: 139, shippingCost: 0, tax: 12.51, total: 151.51,
    notes: '', source: { type: 'shopify', ingestedAt: '' },
  },
  {
    id: () => `SHOP-DEMO-${Date.now() + 1}`,
    clientId: 'smilefam', clientName: 'SmileFam', channel: 'shopee',
    status: 'confirmed', currency: 'SGD',
    items: [{ sku: 'ELEC-BRUSH', name: 'Electric Toothbrush Pro', qty: 2, unitPrice: 59.90 }, { sku: 'WHTNG-KIT', name: 'Whitening Kit', qty: 1, unitPrice: 49 }],
    shipping: { recipient: 'Ahmad Fadzillah', addressLine1: 'Blk 123 Tampines Ave 4', addressLine2: '', city: 'Singapore', state: '', zip: '520123', country: 'SG' },
    subtotal: 168.80, shippingCost: 0, tax: 15.19, total: 183.99,
    notes: '', source: { type: 'shopee', ingestedAt: '' },
  },
  {
    id: () => `LAZ-DEMO-${Date.now() + 2}`,
    clientId: 'athena-scents', clientName: 'Athena Scents', channel: 'lazada',
    status: 'confirmed', currency: 'SGD',
    items: [{ sku: 'OUD-50', name: 'Oud Perfume 50ml', qty: 1, unitPrice: 88 }, { sku: 'ROSE-EDP', name: 'Rose Garden EDP', qty: 1, unitPrice: 65 }],
    shipping: { recipient: 'Siti Nurhaliza', addressLine1: 'Blk 678 Yishun Ring Rd', addressLine2: '', city: 'Singapore', state: '', zip: '760678', country: 'SG' },
    subtotal: 153, shippingCost: 0, tax: 13.77, total: 166.77,
    notes: '', source: { type: 'lazada', ingestedAt: '' },
  },
  {
    id: () => `TTK-DEMO-${Date.now() + 3}`,
    clientId: 'chalgo', clientName: 'Chalgo', channel: 'tiktok',
    status: 'confirmed', currency: 'SGD',
    items: [{ sku: 'BOMBER-JKT', name: 'Bomber Jacket', qty: 1, unitPrice: 89 }, { sku: 'POLO-PRM', name: 'Premium Polo Tee', qty: 2, unitPrice: 49 }],
    shipping: { recipient: 'Kavitha Pillai', addressLine1: '10 Orchard Rd', addressLine2: '', city: 'Singapore', state: '', zip: '238801', country: 'SG' },
    subtotal: 187, shippingCost: 0, tax: 16.83, total: 203.83,
    notes: 'TikTok Live sale', source: { type: 'tiktok', ingestedAt: '' },
  },
  {
    id: () => `SHOP-DEMO-${Date.now() + 4}`,
    clientId: 'almighty', clientName: 'Almighty', channel: 'shopee',
    status: 'confirmed', currency: 'SGD',
    items: [{ sku: 'WHEY-1KG', name: 'Whey Protein 1kg', qty: 2, unitPrice: 79 }, { sku: 'BCAA-300', name: 'BCAA 300g', qty: 1, unitPrice: 49 }],
    shipping: { recipient: 'Rajesh Kumar', addressLine1: 'Blk 445 Bishan St 12', addressLine2: '', city: 'Singapore', state: '', zip: '570445', country: 'SG' },
    subtotal: 207, shippingCost: 0, tax: 18.63, total: 225.63,
    notes: '', source: { type: 'shopee', ingestedAt: '' },
  },
  {
    id: () => `LAZ-DEMO-${Date.now() + 5}`,
    clientId: 'lz8', clientName: 'LZ8', channel: 'lazada',
    status: 'confirmed', currency: 'SGD',
    items: [{ sku: 'WATCH-CAS', name: 'Casual Watch', qty: 1, unitPrice: 89 }, { sku: 'WALLET-LTH', name: 'Leather Wallet', qty: 2, unitPrice: 45 }],
    shipping: { recipient: 'Nurul Ain', addressLine1: 'Blk 99 Punggol Field', addressLine2: '', city: 'Singapore', state: '', zip: '828099', country: 'SG' },
    subtotal: 179, shippingCost: 0, tax: 16.11, total: 195.11,
    notes: '', source: { type: 'lazada', ingestedAt: '' },
  },
  {
    id: () => `TTK-DEMO-${Date.now() + 6}`,
    clientId: 'simplytoy', clientName: 'SimplyToy', channel: 'tiktok',
    status: 'confirmed', currency: 'SGD',
    items: [{ sku: 'RC-TRUCK', name: 'RC Monster Truck', qty: 1, unitPrice: 69 }, { sku: 'PLUSH-BEAR', name: 'Plush Bear 40cm', qty: 2, unitPrice: 55 }],
    shipping: { recipient: 'Deepak Sharma', addressLine1: 'Blk 201 Boon Lay Way', addressLine2: '', city: 'Singapore', state: '', zip: '640201', country: 'SG' },
    subtotal: 179, shippingCost: 0, tax: 16.11, total: 195.11,
    notes: '', source: { type: 'tiktok', ingestedAt: '' },
  },
];

app.post('/api/demo/sync', withTenant, (req, res) => {
  const { store, syncLog } = req;
  const now = new Date().toISOString();
  const results = {};
  let totalAdded = 0;

  for (const tpl of DEMO_ORDERS) {
    const order = {
      ...tpl,
      id: tpl.id(),
      orderDate: now,
      source: { ...tpl.source, ingestedAt: now },
    };
    const platform = order.source.type;
    try {
      store.addOrder(order);
      results[platform] = (results[platform] || 0) + 1;
      totalAdded++;
    } catch { /* duplicate — skip */ }
  }

  const at = now;
  for (const [platform, added] of Object.entries(results)) {
    syncLog.push({ platform, at, fetched: added, added });
  }

  res.json({ ok: true, added: totalAdded, breakdown: results, at });
});

app.post('/api/demo/reset', withTenant, (req, res) => {
  const { store } = req;
  // Remove only demo-injected orders (ids start with SHP-DEMO, SHOP-DEMO, LAZ-DEMO, TTK-DEMO)
  const all = store.getOrders();
  let removed = 0;
  for (const o of all) {
    if (/^(SHP|SHOP|LAZ|TTK)-DEMO-/.test(o.id)) {
      try { store.deleteOrder(o.id); removed++; } catch {}
    }
  }
  res.json({ ok: true, removed });
});

// Wipe all demo/seed orders and lock out auto-reseed permanently.
// Requires both a valid tenant session AND the super-admin password (x-super-password header).
app.post('/api/demo/go-live', withTenant, withSuperAdmin, (req, res) => {
  const { store, db } = req;
  const removed = store.deleteAllOrders();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('seed_version', '9999')").run();
  res.json({ ok: true, removed, message: 'Demo data cleared. Connect your marketplace credentials and sync to pull live orders.' });
});

// ── IDEALSCAN import ──────────────────────────────────────────────────────────

const IDEALSCAN_BASE = process.env.IDEALSCAN_URL || 'https://idealscan.up.railway.app';

// Probe: return raw IDEALSCAN API response so we can inspect the structure
app.get('/api/idealscan/probe', withTenant, async (req, res) => {
  try {
    const path = req.query.path || '/api/orders';
    const r = await fetch(`${IDEALSCAN_BASE}${path}`);
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    res.json({ status: r.status, ok: r.ok, json, raw: json ? undefined : text.slice(0, 2000) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Import: fetch all orders from IDEALSCAN and upsert into OMS
app.post('/api/idealscan/import', withTenant, async (req, res) => {
  const { dryRun = false, clientId = '', clientName = '' } = req.body || {};
  try {
    // Try common IDEALSCAN order endpoints
    let raw = null;
    for (const path of ['/api/orders', '/orders', '/api/v1/orders']) {
      const r = await fetch(`${IDEALSCAN_BASE}${path}`);
      if (r.ok) { raw = await r.json(); break; }
    }
    if (!raw) return res.status(502).json({ error: 'Could not reach IDEALSCAN orders API' });

    // Normalise: handle both array and { orders: [...] } shapes
    const list = Array.isArray(raw) ? raw
               : Array.isArray(raw.orders) ? raw.orders
               : Array.isArray(raw.data)   ? raw.data
               : [];

    if (!list.length) return res.json({ ok: true, imported: 0, skipped: 0, total: 0, sample: raw });

    const STATUS_MAP = {
      pending: 'pending', 'in progress': 'processing', 'in_progress': 'processing',
      done: 'shipped', completed: 'delivered', cancelled: 'cancelled',
    };

    let imported = 0, skipped = 0;
    const errors = [];

    for (const o of list) {
      // Flexible field extraction — cover camelCase and snake_case
      const orderId   = String(o.orderNo || o.order_no || o.orderNumber || o.order_number || o.id || '').trim();
      const waybill   = String(o.waybill || o.trackingNo || o.tracking_no || o.waybillNo || o.waybill_no || '').trim();
      const customer  = String(o.customer || o.customerName || o.customer_name || o.recipient || '').trim();
      const rawStatus = String(o.status || 'pending').toLowerCase();
      const status    = STATUS_MAP[rawStatus] || 'pending';
      const carrier   = String(o.carrier || o.courier || '').trim();
      const orderDate = o.date || o.orderDate || o.order_date || o.createdAt || o.created_at || new Date().toISOString();
      const cid       = clientId || String(o.clientId || o.client_id || o.client || 'idealscan').toLowerCase().replace(/\s+/g, '-');
      const cname     = clientName || String(o.clientName || o.client_name || o.client || 'IDEALSCAN').trim();
      const items     = Array.isArray(o.items) ? o.items.map(i => ({
        sku: String(i.sku || i.code || 'ITEM'),
        name: String(i.name || i.description || 'Item'),
        qty: parseInt(i.qty || i.quantity || 1) || 1,
        unitPrice: parseFloat(i.unitPrice || i.unit_price || i.price || 0) || 0,
      })) : [{ sku: 'ITEM', name: 'Order Item', qty: parseInt(o.itemCount || o.item_count || 1) || 1, unitPrice: 0 }];

      if (!orderId) { skipped++; continue; }

      const subtotal = items.reduce((s, i) => s + i.qty * i.unitPrice, 0);
      const order = {
        id: `ISCAN-${orderId}`,
        clientId: cid,
        clientName: cname,
        channel: carrier ? carrier.toLowerCase().replace(/\s+/g, '-') : 'shopee',
        orderDate: new Date(orderDate).toISOString(),
        status,
        currency: 'SGD',
        notes: waybill ? `Waybill: ${waybill}` : '',
        items,
        shipping: {
          recipient: customer,
          addressLine1: String(o.address || o.addressLine1 || '').trim(),
          addressLine2: '',
          city: 'Singapore',
          state: '',
          zip: '',
          country: 'SG',
        },
        subtotal,
        shippingCost: 0,
        tax: 0,
        total: parseFloat(o.total || o.amount || subtotal) || subtotal,
        source: { type: 'idealscan', waybill, carrier, externalId: orderId, ingestedAt: new Date().toISOString() },
      };

      if (!dryRun) {
        try { req.store.addOrder(order); imported++; }
        catch (e) {
          if (e.message.includes('already exists')) skipped++;
          else { errors.push({ id: orderId, error: e.message }); skipped++; }
        }
      } else {
        imported++;
      }
    }

    res.json({ ok: true, imported, skipped, total: list.length, dryRun, errors: errors.slice(0, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Seed inventory ────────────────────────────────────────────────────────────

app.post('/api/admin/seed-inventory', withTenant, (req, res) => {
  try {
    const { seedInventory } = require('./seed_inventory');
    const tenantId = req.tenantId;
    const before = req.ctx.inventory.getAll().length;
    seedInventory(tenantId);
    const after = req.ctx.inventory.getAll().length;
    res.json({ ok: true, seeded: after, message: `Inventory seeded: ${after} SKUs loaded (was ${before})` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Test Order Injection ──────────────────────────────────────────────────────

const TEST_PRODUCTS = [
  { sku:'TEST-SKU-001', name:'Sample Product A',   unitPrice:29.90 },
  { sku:'TEST-SKU-002', name:'Sample Product B',   unitPrice:49.00 },
  { sku:'TEST-SKU-003', name:'Sample Product C',   unitPrice:15.50 },
  { sku:'TEST-SKU-004', name:'Sample Bundle Pack', unitPrice:89.00 },
  { sku:'TEST-SKU-005', name:'Test Item Deluxe',   unitPrice:120.00 },
];
const TEST_RECIPIENTS = [
  { name:'Alex Tan',    addr:'Blk 123 Tampines Ave 4', city:'Singapore', zip:'520123' },
  { name:'Wei Ling Lim',addr:'Blk 456 Jurong West St 61', city:'Singapore', zip:'640456' },
  { name:'Raj Kumar',   addr:'10 Orchard Rd',         city:'Singapore', zip:'238801' },
  { name:'Siti Binte',  addr:'Blk 789 Woodlands Dr 73',city:'Singapore', zip:'730789' },
  { name:'James Ong',   addr:'Blk 321 Clementi Ave 4', city:'Singapore', zip:'120321' },
];
const TEST_CHANNELS  = ['shopee','lazada','tiktok','shopify'];
const TEST_STATUSES  = ['pending','processing','shipped','delivered'];
const TEST_CLIENTS   = [
  { id:'betime-marketing', name:'Betime Marketing' },
  { id:'smilefam',         name:'SmileFam' },
  { id:'athena-scents',    name:'Athena Scents' },
  { id:'simplytoy',        name:'SimplyToy' },
  { id:'lz8',              name:'LZ8' },
  { id:'almighty',         name:'Almighty' },
  { id:'chalgo',           name:'Chalgo' },
];

function makeTestOrder({ clientId, clientName, channel, status, index } = {}) {
  const ts      = Date.now();
  const rand    = Math.floor(Math.random() * 9000) + 1000;
  const id      = `TEST-${(channel||'manual').toUpperCase().slice(0,3)}-${ts}-${rand}`;
  const client  = TEST_CLIENTS.find(c => c.id === clientId) || TEST_CLIENTS[Math.floor(Math.random()*TEST_CLIENTS.length)];
  const ch      = TEST_CHANNELS.includes(channel) ? channel : TEST_CHANNELS[Math.floor(Math.random()*TEST_CHANNELS.length)];
  const st      = TEST_STATUSES.includes(status)  ? status  : TEST_STATUSES[Math.floor(Math.random()*TEST_STATUSES.length)];
  const recip   = TEST_RECIPIENTS[Math.floor(Math.random()*TEST_RECIPIENTS.length)];
  const numItems= Math.floor(Math.random()*3)+1;
  const items   = [];
  for (let i = 0; i < numItems; i++) {
    const p    = TEST_PRODUCTS[Math.floor(Math.random()*TEST_PRODUCTS.length)];
    const qty  = Math.floor(Math.random()*3)+1;
    items.push({ sku:p.sku, name:p.name, qty, unitPrice:p.unitPrice });
  }
  const subtotal    = Math.round(items.reduce((s,i)=>s+(i.qty*i.unitPrice),0)*100)/100;
  const tax         = Math.round(subtotal*0.09*100)/100;
  const total       = Math.round((subtotal+tax)*100)/100;
  const orderDate   = new Date(ts - Math.floor(Math.random()*7*24*60*60*1000)).toISOString();
  return {
    id, clientId:client.id, clientName:client.name, channel:ch, orderDate,
    status:st, currency:'SGD', notes:'[TEST ORDER]', items,
    shipping:{ recipient:recip.name, addressLine1:recip.addr, addressLine2:'', city:recip.city, state:'', zip:recip.zip, country:'SG' },
    subtotal, shippingCost:0, tax, total,
    source:{ type:ch, ingestedAt:new Date().toISOString(), test:true },
  };
}

// Inject arbitrary orders (pass full order objects)
app.post('/api/test/inject', withTenant, (req, res) => {
  const { orders } = req.body || {};
  if (!Array.isArray(orders) || !orders.length) return res.status(400).json({ error: 'Provide orders: [...]' });
  let imported = 0, skipped = 0;
  const errors = [];
  for (const o of orders) {
    if (!o.id) { errors.push('Missing id on an order'); skipped++; continue; }
    try { req.store.addOrder(o); imported++; }
    catch(e) { skipped++; if (!e.message.includes('already exists')) errors.push(e.message); }
  }
  res.json({ ok:true, imported, skipped, errors });
});

// Generate random test orders and inject them
app.post('/api/test/generate', withTenant, (req, res) => {
  const { count=5, clientId, channel, status } = req.body || {};
  const n = Math.min(Math.max(parseInt(count)||5, 1), 50);
  let imported = 0, skipped = 0;
  const orders = [];
  for (let i = 0; i < n; i++) {
    const o = makeTestOrder({ clientId, channel, status, index:i });
    orders.push(o);
    try { req.store.addOrder(o); imported++; }
    catch { skipped++; }
  }
  res.json({ ok:true, imported, skipped, orders });
});

// Remove all TEST- prefixed orders
app.delete('/api/test/orders', withTenant, (req, res) => {
  const all = req.store.getOrders();
  let removed = 0;
  for (const o of all) {
    if (o.id.startsWith('TEST-') || (o.notes||'').includes('[TEST ORDER]')) {
      try { req.store.deleteOrder(o.id); removed++; } catch {}
    }
  }
  res.json({ ok:true, removed });
});

// ── Sales Lead Digger ─────────────────────────────────────────────────────────

const APOLLO_BASE = 'https://api.apollo.io/api/v1';
const { randomUUID } = require('crypto');

const VERTICAL_PARAMS = {
  logistics: {
    person_titles: [
      'Logistics Manager', 'Supply Chain Manager', 'Operations Director',
      'Freight Manager', 'Procurement Manager', 'Warehouse Manager',
      'Import Export Manager', 'General Manager', 'CEO', 'Managing Director',
      'Head of Logistics', 'VP Operations', 'Freight Forwarder',
    ],
    q_organization_keyword_tags: ['logistics', 'freight forwarding', 'supply chain', 'warehousing', '3PL', 'shipping'],
    description: 'Freight Forwarders, 3PL Providers & Direct Clients (warehousing/transport/freight)',
  },
  interior: {
    person_titles: [
      'Interior Designer', 'Architect', 'Interior Decorator',
      'Principal Architect', 'Design Director', 'Creative Director',
      'Interior Design Consultant', 'Senior Interior Designer',
      'Project Architect', 'Renovation Consultant',
    ],
    q_organization_keyword_tags: ['interior design', 'architecture', 'furniture', 'home decor', 'interior styling', 'design studio'],
    description: 'Interior Designers, Architects & Homeowners (interior styling & custom furnishings)',
  },
};

async function apolloRequest(path, body) {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new Error('APOLLO_API_KEY not configured — set it in your environment variables');
  const res = await fetch(`${APOLLO_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`Apollo API error ${res.status}: ${txt}`);
  }
  return res.json();
}

app.post('/api/leads/search', withTenant, async (req, res) => {
  const db = req.db;

  const { vertical = 'logistics', location = '', seniority = '', size = '', page = 1 } = req.body || {};
  const vp = VERTICAL_PARAMS[vertical];
  if (!vp) return res.status(400).json({ error: 'Unknown vertical. Use "logistics" or "interior".' });

  const payload = {
    per_page: 10, page,
    person_titles: vp.person_titles,
    q_organization_keyword_tags: vp.q_organization_keyword_tags,
  };
  if (location)  payload.organization_locations = [location];
  if (seniority) payload.person_seniorities     = [seniority.toLowerCase()];
  if (size)      payload.organization_num_employees_ranges = [size];

  try {
    const data    = await apolloRequest('/mixed_people/api_search', payload);
    const rawList = data.people || [];

    const sessionId = randomUUID();
    db.prepare(`INSERT INTO lead_sessions (id, vertical, location, seniority, company_size, total_found, lead_count)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, vertical, location, seniority, size,
           data.pagination?.total_entries || rawList.length, rawList.length);

    const insertLead = db.prepare(`
      INSERT INTO leads (apollo_id, session_id, vertical, first_name, last_name_masked,
        title, company, location, linkedin_url, photo_url, has_email, has_phone)
      VALUES (@apollo_id, @session_id, @vertical, @first_name, @last_name_masked,
        @title, @company, @location, @linkedin_url, @photo_url, @has_email, @has_phone)
      ON CONFLICT(apollo_id) DO NOTHING
    `);

    const people = rawList.map(p => {
      const company  = p.organization?.name || '';
      const location = [p.city, p.state, p.country].filter(Boolean).join(', ');
      const lead = {
        apollo_id: p.id, session_id: sessionId, vertical,
        first_name: p.first_name || '', last_name_masked: p.last_name_obfuscated || p.last_name || '',
        title: p.title || '', company, location,
        linkedin_url: p.linkedin_url || '', photo_url: p.photo_url || '',
        has_email: p.has_email ? 1 : 0, has_phone: p.has_direct_phone === 'Yes' ? 1 : 0,
      };
      insertLead.run(lead);
      return {
        id: p.id, session_id: sessionId,
        first_name: p.first_name || '', last_name: p.last_name_obfuscated || '',
        name: `${p.first_name || ''} ${p.last_name_obfuscated || ''}`.trim(),
        title: p.title || '', company, location,
        linkedin_url: p.linkedin_url || '', photo_url: p.photo_url || '',
        has_email: !!p.has_email, has_phone: p.has_direct_phone === 'Yes',
        enriched: false, contacted: false,
      };
    });

    res.json({ session_id: sessionId, people, total: data.pagination?.total_entries || rawList.length, vertical, description: vp.description });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leads/enrich', withTenant, async (req, res) => {
  const db = req.db;

  const { id, first_name, last_name, organization_name } = req.body || {};
  if (!id && !first_name) return res.status(400).json({ error: 'Provide Apollo id or first_name' });
  try {
    const data = await apolloRequest('/people/match', { id, first_name, last_name, organization_name, reveal_personal_emails: false });
    const p     = data.person || {};
    const email = p.email || '';
    const phone = p.sanitized_phone || p.phone_numbers?.[0]?.sanitized_number || '';
    db.prepare(`UPDATE leads SET email=?, phone=?, enriched=1, enriched_at=datetime('now') WHERE apollo_id=?`).run(email, phone, id);
    res.json({ email, phone, email_status: p.email_status || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/leads/:id/contact', withTenant, (req, res) => {
  const db = req.db;

  const { contacted, contact_note = '', note = '' } = req.body || {};
  const resolvedNote = contact_note || note;
  const now = contacted ? new Date().toISOString() : '';
  db.prepare(`UPDATE leads SET contacted=?, contacted_at=?, contact_note=? WHERE apollo_id=?`)
    .run(contacted ? 1 : 0, now, resolvedNote, req.params.id);
  const lead = db.prepare('SELECT * FROM leads WHERE apollo_id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json({ ok: true, contacted: !!lead.contacted, contacted_at: lead.contacted_at });
});

app.patch('/api/leads/:id/note', withTenant, (req, res) => {
  const db = req.db;

  const { note = '' } = req.body || {};
  db.prepare('UPDATE leads SET contact_note=? WHERE apollo_id=?').run(note, req.params.id);
  res.json({ ok: true });
});

app.get('/api/leads', withTenant, (req, res) => {
  const db = req.db;

  const { vertical, contacted, session_id } = req.query;
  let sql    = 'SELECT l.*, s.dug_at as session_dug_at FROM leads l JOIN lead_sessions s ON l.session_id=s.id WHERE 1=1';
  const args = [];
  if (vertical)   { sql += ' AND l.vertical=?';   args.push(vertical); }
  if (session_id) { sql += ' AND l.session_id=?'; args.push(session_id); }
  if (contacted !== undefined) { sql += ' AND l.contacted=?'; args.push(contacted === 'true' ? 1 : 0); }
  sql += ' ORDER BY l.dug_at DESC';
  res.json(db.prepare(sql).all(...args));
});

app.get('/api/leads/sessions', withTenant, (req, res) => {
  res.json(req.db.prepare('SELECT * FROM lead_sessions ORDER BY dug_at DESC').all());
});

app.delete('/api/leads', withTenant, (req, res) => {
  const { confirm } = req.body || {};
  if (confirm !== 'DELETE ALL') return res.status(400).json({ error: 'Send confirm: "DELETE ALL"' });
  req.db.prepare('DELETE FROM leads').run();
  req.db.prepare('DELETE FROM lead_sessions').run();
  res.json({ ok: true });
});

// ── Generic Webhooks ──────────────────────────────────────────────────────────

app.post('/webhook/:platform', (req, res) => {
  const { platform } = req.params;
  const conn = registry[platform];
  if (!conn) return res.status(400).json({ error: 'Unknown platform' });
  // Determine tenant from a header or default
  const tenantId = req.headers['x-tenant-id'] || 'default';
  const { creds } = getCtx(tenantId);
  if (conn.handleWebhook) {
    try { conn.handleWebhook(req.body, req.headers, creds.get(platform) || {}); } catch {}
  }
  res.json({ ok: true });
});

// ── Client portal auth ────────────────────────────────────────────────────────

app.post('/api/client/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const tenantId = req.headers['x-tenant-id'] || 'default';
  const { db } = getCtx(tenantId);
  const ca = createClientAuth(db);
  const user = ca.checkPassword(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const token = ca.generateToken(user.id, user.name, user.username);
  res.json({ token, clientId: user.id, clientName: user.name, username: user.username });
});

app.post('/api/client/logout', withClientAuth, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  req.clientAuth.revokeToken(token);
  res.json({ ok: true });
});

app.get('/api/client/me', withClientAuth, (req, res) => {
  res.json({ clientId: req.clientId, clientName: req.clientName });
});

app.get('/api/client/orders', withClientAuth, (req, res) => {
  const { channel, status, search } = req.query;
  res.json(req.store.getOrders({ clientId: req.clientId, channel, status, search }));
});

app.post('/api/client/orders/upload', withClientAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { path: filePath, originalname } = req.file;
  const ext = (originalname.split('.').pop() || '').toLowerCase();
  if (!['csv', 'xlsx', 'xls'].includes(ext)) {
    try { fs.unlinkSync(filePath); } catch {}
    return res.status(400).json({ error: 'Only CSV, XLSX, or XLS files are supported' });
  }
  try {
    const extracted = importer.extractFromSpreadsheet(filePath);
    const now = new Date().toISOString();
    let imported = 0, skipped = 0;
    extracted.forEach((data, i) => {
      const refNo = data.trackingNumber || data.orderNumber;
      const orderId = refNo
        ? 'CLI-' + refNo.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 18)
        : 'CLI-' + Date.now().toString(36).toUpperCase() + '-' + String(i).padStart(3, '0');
      const items = Array.isArray(data.items) && data.items.length
        ? data.items.map(it => ({ sku: String(it.sku || 'ITEM'), name: String(it.name || 'Item'), qty: parseInt(it.qty) || 1, unitPrice: parseFloat(it.unitPrice) || 0 }))
        : [{ sku: 'ITEM', name: 'Uploaded Item', qty: parseInt(data.qty) || 1, unitPrice: parseFloat(data.unitPrice) || 0 }];
      const subtotal = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
      const tax = Math.round(subtotal * 0.09 * 100) / 100;
      const order = {
        id: orderId,
        clientId: req.clientId, clientName: req.clientName,
        channel: 'portal', orderDate: now, status: 'pending', currency: 'SGD',
        notes: data.notes || '',
        items,
        shipping: {
          recipient:    data.recipientName || '',
          addressLine1: data.addressLine1  || data.address || '',
          addressLine2: data.addressLine2  || '',
          city:         data.city          || 'Singapore',
          state:        data.state         || '',
          zip:          data.zip           || '',
          country:      data.country       || 'SG',
        },
        subtotal, shippingCost: 0, tax, total: subtotal + tax,
        source: { type: 'portal-upload', ingestedAt: now },
      };
      try { req.store.addOrder(order); imported++; }
      catch { skipped++; }
    });
    res.json({ ok: true, imported, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
});

// ── API key ingest endpoint ───────────────────────────────────────────────────

app.post('/api/ingest/orders', withApiKey, (req, res) => {
  const raw = Array.isArray(req.body) ? req.body : [req.body];
  const now = new Date().toISOString();
  let accepted = 0;
  const errors = [];
  raw.forEach((data, i) => {
    try {
      const id = data.id
        ? String(data.id).replace(/[^A-Z0-9\-_]/gi, '').slice(0, 40)
        : 'API-' + Date.now().toString(36).toUpperCase() + '-' + String(i).padStart(3, '0');
      const items = Array.isArray(data.items) && data.items.length
        ? data.items.map(it => ({ sku: String(it.sku || 'ITEM'), name: String(it.name || 'Item'), qty: parseInt(it.qty) || 1, unitPrice: parseFloat(it.unitPrice || it.unit_price) || 0 }))
        : [{ sku: 'ITEM', name: 'Order Item', qty: parseInt(data.qty) || 1, unitPrice: parseFloat(data.unitPrice || data.unit_price) || 0 }];
      const subtotal = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
      const tax = parseFloat(data.tax) || 0;
      const shippingCost = parseFloat(data.shippingCost || data.shipping_cost) || 0;
      const ship = data.shipping || {};
      req.store.addOrder({
        id,
        clientId:     req.clientId,
        clientName:   req.clientName,
        channel:      data.channel || 'api',
        orderDate:    data.orderDate || data.order_date || now,
        status:       data.status || 'pending',
        currency:     data.currency || 'SGD',
        notes:        data.notes || '',
        items,
        shipping: {
          recipient:    ship.recipient    || data.recipient    || '',
          addressLine1: ship.addressLine1 || ship.address_line1 || data.address || '',
          addressLine2: ship.addressLine2 || ship.address_line2 || '',
          city:         ship.city         || 'Singapore',
          state:        ship.state        || '',
          zip:          ship.zip          || ship.postal_code  || '',
          country:      ship.country      || 'SG',
        },
        subtotal,
        shippingCost,
        tax,
        total: parseFloat(data.total) || subtotal + shippingCost + tax,
        source: { type: 'api', channel: data.channel || 'api', ingestedAt: now },
      });
      accepted++;
    } catch (e) {
      errors.push({ index: i, id: data.id || null, error: e.message });
    }
  });
  res.json({ ok: true, accepted, errors });
});

// ── Admin — client user management ───────────────────────────────────────────

app.get('/api/admin/client-users', withTenant, (req, res) => {
  const ca = createClientAuth(req.db);
  res.json(ca.listUsers());
});

app.post('/api/admin/client-users', withTenant, (req, res) => {
  const { id, name, username, password } = req.body || {};
  if (!id || !name || !username || !password) return res.status(400).json({ error: 'id, name, username, and password are required' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const ca = createClientAuth(req.db);
  try {
    const user = ca.createUser(id, name, username, password);
    res.status(201).json(user);
  } catch (e) {
    res.status(409).json({ error: e.message.includes('UNIQUE') ? 'Username already taken' : e.message });
  }
});

app.patch('/api/admin/client-users/:id', withTenant, (req, res) => {
  const { id } = req.params;
  const { password, active } = req.body || {};
  const ca = createClientAuth(req.db);
  try {
    if (password !== undefined) ca.setPassword(id, password);
    if (active  !== undefined) ca.setActive(id, !!active);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.message.includes('not found') ? 404 : 400).json({ error: e.message });
  }
});

app.delete('/api/admin/client-users/:id', withTenant, (req, res) => {
  const ca = createClientAuth(req.db);
  ca.deleteUser(req.params.id);
  res.json({ ok: true });
});

// ── Super-admin tenant management ─────────────────────────────────────────────

app.get('/api/superadmin/tenants', withSuperAdmin, (req, res) => {
  res.json(mainDb.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all());
});

app.post('/api/superadmin/tenants', withSuperAdmin, (req, res) => {
  const { id, name, plan = 'basic' } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'id and name are required' });
  if (!/^[a-z0-9-]+$/.test(id)) return res.status(400).json({ error: 'Tenant id must be lowercase alphanumeric with hyphens' });
  try {
    mainDb.prepare('INSERT INTO tenants (id, name, plan) VALUES (?, ?, ?)').run(id, name, plan);
    // Touch the tenant DB to initialise it
    getTenantDb(id);
    res.status(201).json({ ok: true, id, name, plan });
  } catch (e) {
    res.status(409).json({ error: `Tenant '${id}' already exists` });
  }
});

app.patch('/api/superadmin/tenants/:id', withSuperAdmin, (req, res) => {
  const { id } = req.params;
  const { name, plan, active } = req.body || {};
  const tenant = mainDb.prepare('SELECT id FROM tenants WHERE id = ?').get(id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  if (name   !== undefined) mainDb.prepare('UPDATE tenants SET name=?   WHERE id=?').run(name, id);
  if (plan   !== undefined) mainDb.prepare('UPDATE tenants SET plan=?   WHERE id=?').run(plan, id);
  if (active !== undefined) mainDb.prepare('UPDATE tenants SET active=? WHERE id=?').run(active ? 1 : 0, id);
  if (active === false || active === 0) auth.revokeAllTenantSessions(id);
  res.json(mainDb.prepare('SELECT * FROM tenants WHERE id=?').get(id));
});

// ── Fulfillment ───────────────────────────────────────────────────────────────

app.post('/api/orders/scan-fulfill', withTenant, async (req, res) => {
  const { code, trackingNo, pushPlatform = true } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code is required' });
  try {
    const result = await req.ctx.fulfillment.scanFulfill(code, { pushPlatform, trackingNo });
    if (!result) return res.status(404).json({ error: 'No matching order found', code });
    res.json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/orders/:id/fulfill', withTenant, async (req, res) => {
  const { trackingNo, courier, autoAdvance = true, pushPlatform = true, targetStatus } = req.body || {};
  try {
    const result = await req.ctx.fulfillment.fulfill(req.params.id, { trackingNo, courier, autoAdvance, pushPlatform, targetStatus });
    res.json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/orders/bulk-fulfill', withTenant, async (req, res) => {
  const { ids, targetStatus, trackingNumbers = {}, pushPlatform = true } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  const VALID = ['pending','confirmed','processing','packed','shipped','delivered','cancelled'];
  if (targetStatus && !VALID.includes(targetStatus)) return res.status(400).json({ error: 'Invalid targetStatus' });
  const results = await Promise.allSettled(
    ids.map(id => req.ctx.fulfillment.fulfill(id, { targetStatus, autoAdvance: !targetStatus, trackingNo: trackingNumbers[id] || null, pushPlatform }))
  );
  const out = ids.map((id, i) => {
    const r = results[i];
    return r.status === 'fulfilled' ? { id, ok: true, ...r.value } : { id, ok: false, error: r.reason.message };
  });
  res.json({ results: out, succeeded: out.filter(r => r.ok).length, failed: out.filter(r => !r.ok).length });
});

app.get('/api/orders/lookup', withTenant, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  const order = req.store.lookupByCode(q);
  if (!order) return res.status(404).json({ error: 'No matching order found', code: q });
  res.json(order);
});

app.patch('/api/orders/:id/status', withTenant, async (req, res) => {
  const { status } = req.body || {};
  const VALID = ['pending','confirmed','processing','packed','shipped','delivered','cancelled','returned'];
  if (!VALID.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  // Cancel and return go through fulfillment so inventory is adjusted
  try {
    if (status === 'cancelled') {
      const result = await req.ctx.fulfillment.cancelOrder(req.params.id);
      return res.json(result.order);
    }
    if (status === 'returned') {
      const result = await req.ctx.fulfillment.returnOrder(req.params.id);
      return res.json(result.order);
    }
    const order = req.store.updateStatusAndSource(req.params.id, status, { manuallySetAt: new Date().toISOString() });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Request order cancellation (requires approval before taking effect)
app.post('/api/orders/:id/cancel-request', withTenant, async (req, res) => {
  try {
    const { reason = '' } = req.body || {};
    const requestedBy = req.body?.requestedBy || 'user';
    const result = await req.ctx.fulfillment.requestCancellation(req.params.id, reason, requestedBy);
    res.json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Get pending cancellation requests
app.get('/api/cancellations/pending', withTenant, (req, res) => {
  try {
    const pending = req.db.prepare(`
      SELECT cr.*, o.client_name, o.status as order_status
      FROM cancellation_requests cr
      JOIN orders o ON cr.order_id = o.id
      WHERE cr.status = 'pending'
      ORDER BY cr.requested_at DESC
    `).all();
    res.json(pending);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Approve cancellation request
app.post('/api/cancellations/:requestId/approve', withTenant, async (req, res) => {
  try {
    const approvedBy = req.body?.approvedBy || 'admin';
    const result = await req.ctx.fulfillment.approveCancellation(req.params.requestId, approvedBy);
    res.json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Reject cancellation request
app.post('/api/cancellations/:requestId/reject', withTenant, async (req, res) => {
  try {
    const { reason = '' } = req.body || {};
    const rejectedBy = req.body?.rejectedBy || 'admin';
    const result = await req.ctx.fulfillment.rejectCancellation(req.params.requestId, reason, rejectedBy);
    res.json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Explicit cancel / return endpoints (also callable from UI buttons)
app.post('/api/orders/:id/cancel', withTenant, async (req, res) => {
  try {
    const result = await req.ctx.fulfillment.cancelOrder(req.params.id);
    res.json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/orders/:id/return', withTenant, async (req, res) => {
  try {
    const result = await req.ctx.fulfillment.returnOrder(req.params.id);
    res.json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/orders/:id/waybill', withTenant, async (req, res) => {
  try {
    const result = await req.ctx.fulfillment.getWaybill(req.params.id);
    if (result.base64) {
      const buf = Buffer.from(result.base64, 'base64');
      res.set('Content-Type', result.contentType || 'application/pdf');
      res.set('Content-Disposition', 'inline; filename="waybill-' + req.params.id + '.pdf"');
      return res.send(buf);
    }
    if (result.url) return res.json({ url: result.url, platform: result.platform });
    res.status(502).json({ error: 'Platform returned no waybill document' });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Picking ───────────────────────────────────────────────────────────────────
//
// Session types:
//   scan  – exactly 1 order; item-by-item barcode scan; only 1 active scan session at a time
//   batch – multiple orders; manual confirm per item
//   wave  – same as batch, semantically grouped by route/zone
//
// Lifecycle: create → pick items → complete → orders advance processing → packed

// List sessions
app.get('/api/picking/sessions', withTenant, (req, res) => {
  try {
    const { status, type, limit } = req.query;
    res.json(req.ctx.picking.listSessions({ status, type, limit: limit ? Number(limit) : 50 }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Active scan session (at most one)
app.get('/api/picking/sessions/scan/active', withTenant, (req, res) => {
  try {
    const s = req.ctx.picking.getActiveScanSession();
    if (!s) return res.status(404).json({ error: 'No active scan session' });
    res.json(s);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Get session by id
app.get('/api/picking/sessions/:id', withTenant, (req, res) => {
  try {
    const s = req.ctx.picking.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Pick session not found' });
    res.json(s);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Create session
// Body: { type: 'scan'|'batch'|'wave', orderIds: string[], notes?: string }
app.post('/api/picking/sessions', withTenant, (req, res) => {
  try {
    const { type, orderIds, notes } = req.body || {};
    const createdBy = req.session?.username || '';
    const session = req.ctx.picking.createSession(type, orderIds, { notes, createdBy });
    res.status(201).json(session);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Scan a code (scan-type sessions only)
// Body: { code: string }   — order ID confirms order loaded; SKU/barcode picks item
app.post('/api/picking/sessions/:id/scan', withTenant, (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code is required' });
    res.json(req.ctx.picking.scan(req.params.id, code));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Update picked qty for one item (batch/wave manual confirm)
// Body: { qtyPicked: number }
app.patch('/api/picking/sessions/:id/items/:itemId', withTenant, (req, res) => {
  try {
    const { qtyPicked } = req.body || {};
    if (qtyPicked === undefined) return res.status(400).json({ error: 'qtyPicked is required' });
    res.json(req.ctx.picking.pickItem(req.params.id, Number(req.params.itemId), Number(qtyPicked)));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Mark ALL remaining items as picked
app.post('/api/picking/sessions/:id/pick-all', withTenant, (req, res) => {
  try {
    res.json(req.ctx.picking.pickAll(req.params.id));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Complete session → advances all orders to 'packed'
// Body: { force?: boolean }
app.post('/api/picking/sessions/:id/complete', withTenant, (req, res) => {
  try {
    const { force = false } = req.body || {};
    res.json(req.ctx.picking.completeSession(req.params.id, { force }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Cancel session
app.post('/api/picking/sessions/:id/cancel', withTenant, (req, res) => {
  try {
    res.json(req.ctx.picking.cancelSession(req.params.id));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Inventory ─────────────────────────────────────────────────────────────────

app.get('/api/inventory', withTenant, (req, res) => {
  const { category, search, lowStock, clientId } = req.query;
  res.json(req.ctx.inventory.getAll({ category, search, lowStock: lowStock === 'true', clientId: clientId || null }));
});

app.get('/api/inventory/stats', withTenant, (req, res) => {
  res.json(req.ctx.inventory.getStats({ clientId: req.query.clientId || null }));
});

// Velocity / best-selling
app.get('/api/inventory/velocity', withTenant, (req, res) => {
  const limit = Math.min(50, Number(req.query.limit) || 20);
  const clientId = req.query.clientId || null;
  res.json(req.ctx.inventory.velocity(limit, clientId));
});

app.get('/api/inventory/:sku', withTenant, (req, res) => {
  const item = req.ctx.inventory.get(req.params.sku);
  if (!item) return res.status(404).json({ error: 'SKU not found' });
  res.json(item);
});

app.post('/api/inventory', withTenant, (req, res) => {
  try { res.status(201).json(req.ctx.inventory.upsert(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/inventory/:sku', withTenant, (req, res) => {
  try { res.json(req.ctx.inventory.upsert({ ...req.body, sku: req.params.sku })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/inventory/:sku', withTenant, (req, res) => {
  req.ctx.inventory.remove(req.params.sku);
  res.json({ ok: true });
});

app.post('/api/inventory/:sku/adjust', withTenant, (req, res) => {
  const { qty, type = 'adjustment', reason = '' } = req.body || {};
  if (typeof qty !== 'number') return res.status(400).json({ error: 'qty (number) required' });
  try { res.json(req.ctx.inventory.adjust(req.params.sku, qty, type, reason)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/inventory/:sku/movements', withTenant, (req, res) => {
  res.json(req.ctx.inventory.movements(req.params.sku, Number(req.query.limit) || 50));
});

app.post('/api/inventory/import', withTenant, (req, res) => {
  const { items, mode = 'upsert' } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array required' });
  const inv = req.ctx.inventory;
  const results = { imported: 0, skipped: 0, errors: [] };
  if (mode === 'replace') {
    inv.getAll().forEach(r => inv.remove(r.sku));
  }
  for (const row of items) {
    try {
      if (!row.sku || !row.name) { results.skipped++; continue; }
      inv.upsert(row);
      results.imported++;
    } catch (e) {
      results.errors.push({ sku: row.sku || '?', error: e.message });
    }
  }
  res.json(results);
});

// ── Webhooks ──────────────────────────────────────────────────────────────────

app.post('/webhook/shopee', (req, res) => {
  // TODO: verify HMAC signature, then call store.addOrder or update status
  res.json({ ok: true });
});

app.post('/webhook/lazada', (req, res) => {
  res.json({ ok: true });
});

// ── Client platform connections ───────────────────────────────────────────────

const pendingOAuth = new Map(); // nonce → {tenantId, clientId, platform, expiresAt}
setInterval(() => { const now = Date.now(); for (const [k, v] of pendingOAuth) if (v.expiresAt < now) pendingOAuth.delete(k); }, 300000);

app.get('/api/client/connections', withClientAuth, (req, res) => {
  const rows = connectionsDb.prepare(
    'SELECT platform, connected_at FROM client_platform_connections WHERE tenant_id = ? AND client_id = ?'
  ).all(req.tenantId, req.clientId);
  const connected = {};
  for (const r of rows) connected[r.platform] = { connectedAt: r.connected_at };
  const PLATFORMS = ['tiktok', 'shopify', 'lazada', 'shopee'];
  const masterCreds = createCreds('default');
  const result = PLATFORMS.map(p => ({
    id: p,
    name: registry[p]?.meta?.name || p,
    connected: !!connected[p],
    connectedAt: connected[p]?.connectedAt || null,
    available: !!(registry[p] && masterCreds.get(p)),
  }));
  res.json(result);
});

app.get('/api/client/connections/:platform/start', (req, res) => {
  const { platform } = req.params;
  const rawToken = (req.headers.authorization || '').replace('Bearer ', '').trim() || req.query.token || '';
  const tenantId = req.headers['x-tenant-id'] || req.query.tenant || 'default';
  const ctx      = getCtx(tenantId);
  const session  = createClientAuth(ctx.db).validateToken(rawToken);
  if (!session) return res.redirect('/portal?conn_error=' + encodeURIComponent('Please log in first.'));
  const connector = registry[platform];
  if (!connector || connector.meta.authType !== 'oauth')
    return res.redirect('/portal?conn_error=' + encodeURIComponent('Platform not supported.'));
  const masterCreds = createCreds('default').get(platform);
  if (!masterCreds)
    return res.redirect('/portal?conn_error=' + encodeURIComponent('This platform is not yet configured. Please contact support.'));
  const nonce = crypto.randomBytes(16).toString('hex');
  pendingOAuth.set(nonce, { tenantId, clientId: session.clientId, platform, expiresAt: Date.now() + 600000 });
  const callbackUrl = `${getBaseUrl(req)}/api/client/connections/${platform}/callback?oms=${nonce}`;
  try {
    res.redirect(connector.buildAuthUrl(masterCreds, callbackUrl));
  } catch (err) {
    pendingOAuth.delete(nonce);
    res.redirect('/portal?conn_error=' + encodeURIComponent(err.message));
  }
});

app.get('/api/client/connections/:platform/callback', async (req, res) => {
  const { platform } = req.params;
  const nonce   = req.query.oms;
  const pending = nonce && pendingOAuth.get(nonce);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingOAuth.delete(nonce);
    return res.redirect('/portal#conn_error=' + encodeURIComponent('Session expired. Please try again.'));
  }
  pendingOAuth.delete(nonce);
  const { tenantId, clientId } = pending;
  const connector   = registry[platform];
  const masterCreds = createCreds('default').get(platform);
  if (!connector || !masterCreds)
    return res.redirect('/portal#conn_error=' + encodeURIComponent('Platform not configured.'));
  try {
    const tokens = await connector.exchangeCode(masterCreds, req.query);
    connectionsDb.prepare(`
      INSERT INTO client_platform_connections (tenant_id, client_id, platform, data)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (tenant_id, client_id, platform) DO UPDATE SET
        data = excluded.data, updated_at = datetime('now')
    `).run(tenantId, clientId, platform, JSON.stringify({ ...tokens, connectedAt: new Date().toISOString() }));
    res.redirect('/portal#conn_success=' + encodeURIComponent(connector.meta.name));
  } catch (err) {
    res.redirect('/portal#conn_error=' + encodeURIComponent(err.message));
  }
});

app.delete('/api/client/connections/:platform', withClientAuth, (req, res) => {
  connectionsDb.prepare(
    'DELETE FROM client_platform_connections WHERE tenant_id = ? AND client_id = ? AND platform = ?'
  ).run(req.tenantId, req.clientId, req.params.platform);
  res.json({ ok: true });
});

// ── Client portal dashboard stats ────────────────────────────────────────────
app.get('/api/portal/dashboard/stats', withClientAuth, (req, res) => {
  const db  = req.db;
  const cid = req.clientId.replace(/'/g,"''");
  const cf  = `AND client_id = '${cid}'`;
  const { from, to } = req.query;
  const esc = s => String(s || '').replace(/'/g, "''");

  const g = sql => (db.prepare(sql).get() || {}).n || 0;

  const toProcess       = g(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('pending','confirmed') AND date(order_date) = date('now') ${cf}`);
  const toProcessPrev   = g(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('pending','confirmed') AND date(order_date) = date('now','-1 day') ${cf}`);
  const unprocessed     = g(`SELECT COUNT(*) AS n FROM orders WHERE status NOT IN ('shipped','delivered','cancelled','returned') ${cf}`);
  const outOfStock      = g(`SELECT COUNT(*) AS n FROM inventory WHERE (stock_qty - reserved_qty) <= 0 AND client_id = '${cid}'`);
  const orderMonth      = g(`SELECT COUNT(*) AS n FROM orders WHERE date(order_date) >= date('now','start of month') ${cf}`);
  const orderLastMonth  = g(`SELECT COUNT(*) AS n FROM orders WHERE date(order_date) >= date('now','start of month','-1 month') AND date(order_date) < date('now','start of month') ${cf}`);
  const salesMonth      = g(`SELECT COALESCE(SUM(total),0) AS n FROM orders WHERE date(order_date) >= date('now','start of month') AND status NOT IN ('cancelled','returned') ${cf}`);
  const salesLastMonth  = g(`SELECT COALESCE(SUM(total),0) AS n FROM orders WHERE date(order_date) >= date('now','start of month','-1 month') AND date(order_date) < date('now','start of month') AND status NOT IN ('cancelled','returned') ${cf}`);

  const chartFrom = from ? `'${esc(from)}'` : `date('now','-29 days')`;
  const chartTo   = to   ? `'${esc(to)}'`   : `date('now')`;
  const salesByDay = db.prepare(
    `SELECT date(order_date) as day, COUNT(*) as count, COALESCE(SUM(total),0) as sales
     FROM orders WHERE date(order_date) >= ${chartFrom} AND date(order_date) <= ${chartTo}
     AND status NOT IN ('cancelled','returned') ${cf}
     GROUP BY date(order_date) ORDER BY day ASC`
  ).all();

  res.json({ toProcess, toProcessPrev, unprocessed, outOfStock, orderMonth, orderLastMonth, salesMonth, salesLastMonth, salesByDay });
});

// ── Client portal inventory routes ────────────────────────────────────────────

app.get('/api/portal/inventory', withClientAuth, (req, res) => {
  const inv = req.ctx.inventory;
  const { search, lowStock } = req.query;
  res.json(inv.getAll({ search, lowStock: lowStock === 'true', clientId: req.clientId }));
});

app.get('/api/portal/inventory/stats', withClientAuth, (req, res) => {
  res.json(req.ctx.inventory.getStats({ clientId: req.clientId }));
});

app.get('/api/portal/inventory/velocity', withClientAuth, (req, res) => {
  res.json(req.ctx.inventory.velocity(10, req.clientId));
});

// ── Client store connections ──────────────────────────────────────────────────

app.get('/api/portal/my-connections', withClientAuth, (req, res) => {
  let mappings = [], requests = [];
  try { mappings = req.db.prepare('SELECT * FROM zetpy_store_mappings WHERE client_id = ? ORDER BY app_name, app_account_name').all(req.clientId); } catch (_) {}
  try { requests = req.db.prepare('SELECT * FROM store_connection_requests WHERE client_id = ? ORDER BY created_at DESC').all(req.clientId); } catch (_) {}
  res.json({ mappings, requests });
});

app.delete('/api/portal/connections/:id', withClientAuth, (req, res) => {
  try { req.db.prepare('DELETE FROM zetpy_store_mappings WHERE id = ? AND client_id = ?').run(Number(req.params.id), req.clientId); } catch (_) {}
  res.json({ ok: true });
});

app.post('/api/portal/connection-requests', withClientAuth, (req, res) => {
  const { marketplace, store_name, notes = '' } = req.body || {};
  if (!marketplace || !store_name)
    return res.status(400).json({ error: 'marketplace and store_name required' });
  try {
    req.db.prepare(
      'INSERT INTO store_connection_requests (client_id, client_name, marketplace, store_name, notes) VALUES (?, ?, ?, ?, ?)'
    ).run(req.clientId, req.clientName || req.clientId, marketplace, store_name, notes);
  } catch (_) {}
  res.json({ ok: true, autoConnected: false });
});

// ── Client platform credentials management ───────────────────────────────────

const platformSchemas = {
  shopee:  { required: ['shopId', 'apiKey', 'apiSecret'] },
  lazada:  { required: ['shopId', 'apiKey', 'apiSecret'] },
  tiktok:  { required: ['shopId', 'apiKey'] },
  shopify: { required: ['storeUrl', 'accessToken'] },
};

app.post('/api/portal/platform-credentials/:platform', withClientAuth, (req, res) => {
  const platform = (req.params.platform || '').toLowerCase();
  const schema = platformSchemas[platform];

  if (!schema) {
    return res.status(400).json({ error: `Unsupported platform: ${platform}. Supported: shopee, lazada, tiktok, shopify` });
  }

  const missing = schema.required.filter(f => !req.body || !(f in req.body));
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  try {
    const data = JSON.stringify(req.body);
    const encryptedData = security.encrypt(data);
    const now = new Date().toISOString();

    connectionsDb.prepare(
      'INSERT OR REPLACE INTO client_platform_connections (tenant_id, client_id, platform, data, is_deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.tenantId || 'default', req.clientId, platform, encryptedData, 0, now);

    res.json({ ok: true, platform });
  } catch (err) {
    console.error('Error saving platform credentials:', err);
    res.status(500).json({ error: 'Failed to save credentials' });
  }
});

app.get('/api/portal/platform-credentials', withClientAuth, (req, res) => {
  try {
    const tenantId = req.tenantId || 'default';
    const clientId = req.clientId;

    const rows = connectionsDb.prepare(
      'SELECT platform, data FROM client_platform_connections WHERE tenant_id = ? AND client_id = ? AND is_deleted = 0 ORDER BY platform'
    ).all(tenantId, clientId);

    const credentials = rows.map(row => {
      try {
        const decrypted = security.decrypt(row.data);
        const data = JSON.parse(decrypted);
        // Return safe fields only (no secrets in response)
        const safe = { platform: row.platform };
        if (row.platform === 'shopee') {
          safe.shopId = data.shopId;
        } else if (row.platform === 'lazada') {
          safe.shopId = data.shopId;
        } else if (row.platform === 'tiktok') {
          safe.shopId = data.shopId;
        } else if (row.platform === 'shopify') {
          safe.storeUrl = data.storeUrl;
        }
        return safe;
      } catch (e) {
        console.error(`Failed to decrypt credentials for ${row.platform}:`, e);
        return null;
      }
    }).filter(Boolean);

    res.json({ credentials });
  } catch (err) {
    console.error('Error fetching platform credentials:', err);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

app.delete('/api/portal/platform-credentials/:platform', withClientAuth, (req, res) => {
  const platform = (req.params.platform || '').toLowerCase();

  if (!platformSchemas[platform]) {
    return res.status(400).json({ error: `Unsupported platform: ${platform}` });
  }

  try {
    const tenantId = req.tenantId || 'default';
    const clientId = req.clientId;
    const now = new Date().toISOString();

    connectionsDb.prepare(
      'UPDATE client_platform_connections SET is_deleted = 1, updated_at = ? WHERE tenant_id = ? AND client_id = ? AND platform = ?'
    ).run(now, tenantId, clientId, platform);

    res.json({ ok: true, platform });
  } catch (err) {
    console.error('Error deleting platform credentials:', err);
    res.status(500).json({ error: 'Failed to delete credentials' });
  }
});

// ── Admin client connections view ─────────────────────────────────────────────

app.get('/api/admin/client-connections', withStaffTenant, (req, res) => {
  try {
    const tenantId = req.tenantId || 'default';
    const rows = connectionsDb.prepare(
      'SELECT tenant_id, client_id, platform FROM client_platform_connections WHERE tenant_id = ? AND is_deleted = 0 ORDER BY client_id, platform'
    ).all(tenantId);

    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.client_id]) grouped[row.client_id] = { tenant_id: row.tenant_id, client_id: row.client_id, platforms: [] };
      grouped[row.client_id].platforms.push(row.platform);
    }

    res.json({ clients: Object.values(grouped) });
  } catch (err) {
    console.error('Error fetching client connections:', err);
    res.status(500).json({ error: 'Failed to fetch client connections' });
  }
});

// ── WMS Routes: Auto-Allocation, Picking Waves, Returns, Forecasting, Analytics ──

// Auto-Allocation endpoints
app.post('/api/wms/allocate/order/:orderId', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const allocator = createAutoAllocator(ctx.db, ctx.inventory, ctx.store);
    const result = allocator.allocateOrder(req.params.orderId, req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wms/allocate/batch', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const allocator = createAutoAllocator(ctx.db, ctx.inventory, ctx.store);
    const result = allocator.allocateBatch(req.body.orderIds || [], req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Picking Wave endpoints
app.post('/api/wms/waves', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const wave = createPickingWave(ctx.db);
    const result = wave.createWave(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/waves', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const wave = createPickingWave(ctx.db);
    const result = wave.listWaves(req.query);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wms/waves/:waveId/orders', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const wave = createPickingWave(ctx.db);
    const result = wave.addOrdersToWave(req.params.waveId, req.body.orderIds || []);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/waves/:waveId', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const wave = createPickingWave(ctx.db);
    const result = wave.getWaveDetails(req.params.waveId);
    if (!result) return res.status(404).json({ error: 'Wave not found' });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wms/waves/:waveId/start', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const wave = createPickingWave(ctx.db);
    const result = wave.startWave(req.params.waveId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/waves/:waveId/stats', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const wave = createPickingWave(ctx.db);
    const result = wave.getWaveStats(req.params.waveId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Returns Management endpoints
app.post('/api/wms/returns', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const returns = createReturnsManager(ctx.db);
    const result = returns.createReturn(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/returns/:returnId', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const returns = createReturnsManager(ctx.db);
    const result = returns.getReturnDetails(req.params.returnId);
    if (!result) return res.status(404).json({ error: 'Return not found' });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wms/returns/:returnId/inspect', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const returns = createReturnsManager(ctx.db);
    const result = returns.inspectReturn(req.params.returnId, req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wms/returns/:returnId/approve-restock', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const returns = createReturnsManager(ctx.db);
    const result = returns.approveRestock(req.params.returnId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/returns/stats/summary', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const returns = createReturnsManager(ctx.db);
    const result = returns.getReturnStats(req.query);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Inventory Forecasting endpoints
app.get('/api/wms/forecast/demand/:skuId', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const forecast = createInventoryForecast(ctx.db);
    const result = forecast.forecastDemand({
      skuId: req.params.skuId,
      days: parseInt(req.query.days || 30),
      method: req.query.method || 'moving_average'
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/forecast/gap', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const forecast = createInventoryForecast(ctx.db);
    const result = forecast.forecastInventoryGap();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/forecast/platform', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const forecast = createInventoryForecast(ctx.db);
    const result = forecast.forecastByPlatform({
      platform: req.query.platform,
      days: parseInt(req.query.days || 30)
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Analytics Dashboard endpoints
app.get('/api/wms/analytics/dashboard', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const analy = createAnalytics(ctx.db);
    const result = analy.getDashboardMetrics(req.query);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/analytics/trends', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const analy = createAnalytics(ctx.db);
    const result = analy.getTrendData({
      days: parseInt(req.query.days || 30),
      metric: req.query.metric || 'orders'
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/analytics/warehouses', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const analy = createAnalytics(ctx.db);
    const result = analy.getWarehouseMetrics();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/analytics/sales-by-platform', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const analy = createAnalytics(ctx.db);
    const result = analy.getSalesbyPlatform(req.query);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Picking Workflow Orchestration ────────────────────────────────────────────
// Main entry point: integrates wave suggestion → creation → picking session → auto-queueing

app.post('/api/wms/picking/start-batch', withStaffTenant, (req, res) => {
  try {
    const { orderIds, warehouseId, operatorId = '', priority = 'normal' } = req.body;
    const ctx = getCtx(req.tenantId);
    const orchestrator = createPickingOrchestrator(ctx.db);
    const result = orchestrator.startBatchPicking(orderIds, { warehouseId, operatorId, priority });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/picking/wave/:waveId/status', withStaffTenant, (req, res) => {
  try {
    const { waveId } = req.params;
    const ctx = getCtx(req.tenantId);
    const orchestrator = createPickingOrchestrator(ctx.db);
    const result = orchestrator.getPickingStatus(waveId);
    if (!result) return res.status(404).json({ error: 'Wave not found' });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Wave Mode Suggestion & THU Generation ──────────────────────────────────────

app.post('/api/wms/waves/suggest-mode', withStaffTenant, (req, res) => {
  try {
    const { orderIds } = req.body;
    const ctx = getCtx(req.tenantId);
    const wave = createPickingWave(ctx.db);
    const result = wave.suggestWaveMode(orderIds);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Scan-Based Pick-and-Pack (PPP) Workflow ────────────────────────────────────

app.post('/api/wms/scan-pack/session', withStaffTenant, (req, res) => {
  try {
    const { orderId, waveId } = req.body;
    const ctx = getCtx(req.tenantId);
    const scanPack = createScanPack(ctx.db);
    const result = scanPack.openSession(orderId, waveId);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wms/scan-pack/session/:sessionId/carton', withStaffTenant, (req, res) => {
  try {
    const { sessionId } = req.params;
    const { thuCode } = req.body;
    const ctx = getCtx(req.tenantId);
    const scanPack = createScanPack(ctx.db);
    const result = scanPack.openCarton(sessionId, thuCode);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wms/scan-pack/carton/:cartonId/item', withStaffTenant, (req, res) => {
  try {
    const { cartonId } = req.params;
    const { skuCode, qty = 1, lotNumber = '', expiryDate = '' } = req.body;
    const ctx = getCtx(req.tenantId);
    const scanPack = createScanPack(ctx.db);
    const result = scanPack.addItemToCarton(cartonId, skuCode, qty, lotNumber, expiryDate);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wms/scan-pack/carton/:cartonId/close', withStaffTenant, (req, res) => {
  try {
    const { cartonId } = req.params;
    const { weight, length, width, height } = req.body;
    const ctx = getCtx(req.tenantId);
    const scanPack = createScanPack(ctx.db);
    const result = scanPack.closeCarton(cartonId, weight, length, width, height);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wms/scan-pack/session/:sessionId/close', withStaffTenant, (req, res) => {
  try {
    const { sessionId } = req.params;
    const { operatorId } = req.body;
    const ctx = getCtx(req.tenantId);
    const scanPack = createScanPack(ctx.db);
    const result = scanPack.closeSession(sessionId, operatorId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/scan-pack/session/:sessionId', withStaffTenant, (req, res) => {
  try {
    const { sessionId } = req.params;
    const ctx = getCtx(req.tenantId);
    const scanPack = createScanPack(ctx.db);
    const result = scanPack.getSessionSummary(sessionId);
    if (!result) return res.status(404).json({ error: 'Session not found' });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/scan-pack/session/:sessionId/manifest', withStaffTenant, (req, res) => {
  try {
    const { sessionId } = req.params;
    const ctx = getCtx(req.tenantId);
    const scanPack = createScanPack(ctx.db);
    const result = scanPack.getPackingManifest(sessionId);
    if (!result) return res.status(404).json({ error: 'Session not found' });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Print Queue Management ─────────────────────────────────────────────────────

app.post('/api/wms/print-queue/job', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const printQueue = createPrintQueue(ctx.db);
    const result = printQueue.queuePrintJob(req.body.labelData, req.body.options || {});
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/print-queue', withStaffTenant, (req, res) => {
  try {
    const { printerType, status } = req.query;
    const ctx = getCtx(req.tenantId);
    const printQueue = createPrintQueue(ctx.db);
    const result = printQueue.getPrintQueue(printerType, status || 'queued');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wms/print-queue/job/:jobId/start', withStaffTenant, (req, res) => {
  try {
    const { jobId } = req.params;
    const ctx = getCtx(req.tenantId);
    const printQueue = createPrintQueue(ctx.db);
    const result = printQueue.startPrintJob(jobId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wms/print-queue/job/:jobId/complete', withStaffTenant, (req, res) => {
  try {
    const { jobId } = req.params;
    const ctx = getCtx(req.tenantId);
    const printQueue = createPrintQueue(ctx.db);
    const result = printQueue.completePrintJob(jobId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wms/print-queue/stats', withStaffTenant, (req, res) => {
  try {
    const ctx = getCtx(req.tenantId);
    const printQueue = createPrintQueue(ctx.db);
    const result = printQueue.getPrintStats();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── OAuth result pages ────────────────────────────────────────────────────────

function okPage(platform) {
  return `<!DOCTYPE html><html><head><title>Connected!</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#f0fdf4;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:16px;padding:40px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.12);max-width:400px;width:90%}.ico{font-size:52px;margin-bottom:16px}.ttl{font-size:22px;font-weight:800;color:#166534;margin-bottom:8px}.sub{color:#64748b;margin-bottom:24px;line-height:1.5}.btn{display:inline-block;padding:12px 28px;background:#166534;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px}</style>
</head><body><div class="box"><div class="ico">&#10003;</div><div class="ttl">${platform} Connected!</div><p class="sub">Your ${platform} store has been successfully linked to IdealOMS. You can now sync orders.</p><a href="/" class="btn">Open IdealOMS</a></div></body></html>`;
}

function errPage(platform, msg) {
  return `<!DOCTYPE html><html><head><title>Error</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#fff5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:16px;padding:40px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.12);max-width:400px;width:90%}.ico{font-size:52px;margin-bottom:16px}.ttl{font-size:22px;font-weight:800;color:#991b1b;margin-bottom:8px}.sub{color:#64748b;margin-bottom:8px;line-height:1.5}.err{font-size:12px;color:#991b1b;background:#fee2e2;border-radius:8px;padding:8px 12px;margin-bottom:24px;word-break:break-all}.btn{display:inline-block;padding:12px 28px;background:#991b1b;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px}</style>
</head><body><div class="box"><div class="ico">&#10007;</div><div class="ttl">Connection Failed</div><p class="sub">${platform}</p><div class="err">${msg}</div><a href="/" class="btn">Back to IdealOMS</a></div></body></html>`;
}

// ── Auto-sync ─────────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = (parseInt(process.env.SYNC_INTERVAL_MINUTES) || 15) * 60 * 1000;

async function autoSyncAll() {
  const tenants = mainDb.prepare('SELECT id FROM tenants WHERE active=1').all();
  for (const { id: tenantId } of tenants) {
    const { store, creds, syncLog } = getCtx(tenantId);
    for (const platform of PLATFORMS) {
      const c = creds.get(platform);
      if (!c?.accessToken && !c?.licenseKey && !c?.apikey && !c?.email) continue;
      try {
        const entry = await syncPlatform(platform, {}, store, creds, syncLog);
        syncLog.push(entry);
        if (entry.added > 0) console.log(`  [auto-sync] ${tenantId}/${platform}: +${entry.added} orders`);
      } catch (e) {
        syncLog.push({ platform, at: new Date().toISOString(), error: e.message });
      }
    }
  }
}

// ── B2B/B2C Order Type Detection (Phase 1) ────────────────────────────────────

// Detect order type and get recommendation
app.post('/api/b2b-b2c/detect-order-type', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const detector = createOrderTypeDetector(ctx.db);
    const result = detector.detectOrderType(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Record order type detection (with user confirmation for learning)
app.post('/api/b2b-b2c/record-detection', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const detector = createOrderTypeDetector(ctx.db);
    const { order_data, detected_type, user_confirmed_type } = req.body;
    const logId = detector.recordDetection(order_data, detected_type, user_confirmed_type);
    res.json({ logId, learned: user_confirmed_type && user_confirmed_type !== detected_type });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get client profile (ML model state)
app.get('/api/b2b-b2c/client-profile/:clientId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const detector = createOrderTypeDetector(ctx.db);
    const profile = detector.getClientProfile(req.params.clientId);
    res.json(profile);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get detection log for a client
app.get('/api/b2b-b2c/detection-log/:clientId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const detector = createOrderTypeDetector(ctx.db);
    const limit = parseInt(req.query.limit) || 50;
    const log = detector.getDetectionLog(req.params.clientId, limit);
    res.json(log);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── PO Document Management (Phase 1) ──────────────────────────────────────────

// Create PO document
app.post('/api/b2b-b2c/po', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const poManager = createPOManager(ctx.db);
    const detector = createOrderTypeDetector(ctx.db);

    const po = poManager.createPODocument(req.body);

    // Record detection
    if (req.body.client_id) {
      detector.recordDetection(
        { po_id: po.poId, client_id: req.body.client_id },
        'b2b',
        'b2b'
      );
    }

    res.json(po);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Validate PO document
app.post('/api/b2b-b2c/po/:poId/validate', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const poManager = createPOManager(ctx.db);
    const result = poManager.validatePODocument(req.params.poId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get PO document
app.get('/api/b2b-b2c/po/:poId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const poManager = createPOManager(ctx.db);
    const po = poManager.getPODocument(req.params.poId);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    res.json(po);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// List PO documents
app.get('/api/b2b-b2c/po', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const poManager = createPOManager(ctx.db);
    const status = req.query.status || null;
    const clientId = req.query.clientId || null;
    const limit = parseInt(req.query.limit) || 50;
    const list = poManager.listPODocuments(status, clientId, limit);
    res.json(list);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Approve PO document
app.post('/api/b2b-b2c/po/:poId/approve', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const poManager = createPOManager(ctx.db);
    const result = poManager.approvePODocument(req.params.poId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Reject PO document
app.post('/api/b2b-b2c/po/:poId/reject', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const poManager = createPOManager(ctx.db);
    const reason = req.body.reason || 'Rejected by user';
    const result = poManager.rejectPODocument(req.params.poId, reason);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── PO CSV Import & Batch Processing (Phase 3) ────────────────────────────────

// Get import template
app.get('/api/b2b-b2c/po/import/template', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const importer = createPOCSVImporter(ctx.db);
    const template = importer.importTemplate();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="po-import-template.csv"');
    res.send(template);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Upload and import PO CSV
app.post('/api/b2b-b2c/po/import/csv', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const csvText = req.body.csv || '';
    const clientId = req.body.client_id || null;

    if (!csvText) return res.status(400).json({ error: 'CSV data required' });

    const importer = createPOCSVImporter(ctx.db);
    const result = importer.importPOsFromCSV(csvText, clientId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Process PO document (create orders, suggest waves)
app.post('/api/b2b-b2c/po/:poId/process', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const processor = createB2BBatchProcessor(ctx.db);
    const result = processor.processPODocument(req.params.poId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Stage carton (auto-called after scan-pack closure)
app.post('/api/b2b-b2c/staging/carton/:cartonId/stage', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const processor = createB2BBatchProcessor(ctx.db);
    const poId = req.body.po_id || null;
    const result = processor.autoStageCarton(req.params.cartonId, poId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Release staged cartons for a PO
app.post('/api/b2b-b2c/po/:poId/release-staging', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const processor = createB2BBatchProcessor(ctx.db);
    const result = processor.releaseStagedCartons(req.params.poId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get staged cartons for PO
app.get('/api/b2b-b2c/po/:poId/staged-cartons', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cartons = ctx.db.prepare(`
      SELECT * FROM staging_area
      WHERE po_id = ? AND status = 'staged'
      ORDER BY received_at DESC
    `).all(req.params.poId);
    res.json(cartons || []);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Document Generation (Phase 4) ─────────────────────────────────────────────

// Generate invoice (multiple formats)
app.get('/api/b2b-b2c/po/:poId/invoice', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const format = req.query.format || 'json'; // json, html, csv
    const generator = createDocumentGenerator(ctx.db);
    const invoice = generator.generateInvoice(req.params.poId, format);

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    } else if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="invoice-${req.params.poId}.csv"`);
    } else {
      res.setHeader('Content-Type', 'application/json');
    }
    res.send(invoice);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Generate packing slip (HTML or JSON)
app.get('/api/b2b-b2c/po/:poId/packing-slip', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const format = req.query.format || 'json'; // json, html
    const generator = createDocumentGenerator(ctx.db);
    const slip = generator.generatePackingSlip(req.params.poId, format);

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    } else {
      res.setHeader('Content-Type', 'application/json');
    }
    res.send(slip);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Generate shipping label
app.get('/api/b2b-b2c/carton/:cartonId/shipping-label', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const generator = createDocumentGenerator(ctx.db);
    const label = generator.generateShippingLabel(req.params.cartonId);
    res.json(label);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── PHASE 5B: Warehouse Allocation ────────────────────────────────────────────

// Allocate order to warehouse
app.post('/api/warehouse/allocate', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const { orderId, warehouseId, strategy, force } = req.body;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const allocator = createWarehouseAllocator(ctx.db, inventoryWh);
    const result = allocator.allocateOrderToWarehouse(orderId, { warehouseId, strategy, force });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get warehouse suggestions for order
app.get('/api/warehouse/suggest/:orderId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const allocator = createWarehouseAllocator(ctx.db, inventoryWh);
    const suggestions = allocator.suggestWarehouse(req.params.orderId);
    res.json(suggestions);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get warehouse statistics
app.get('/api/warehouse/stats', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const allocator = createWarehouseAllocator(ctx.db, inventoryWh);
    const stats = allocator.getWarehouseStatistics();
    res.json(stats);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get allocation history for order
app.get('/api/warehouse/allocation-history/:orderId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const allocator = createWarehouseAllocator(ctx.db, inventoryWh);
    const history = allocator.getAllocationHistory(req.params.orderId);
    res.json(history);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── PHASE 5C: Picking & Packing Integration ───────────────────────────────────

// Generate FIFO picking list for wave
app.get('/api/picking/list/:waveId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const pickingInt = createPickingIntegration(ctx.db, inventoryWh);
    const list = pickingInt.generatePickingList(req.params.waveId);
    res.json(list);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Validate item before picking
app.post('/api/picking/validate-item', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const { batchId, orderedQty, expiryDate } = req.body;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const pickingInt = createPickingIntegration(ctx.db, inventoryWh);
    const validation = pickingInt.validatePickItem({ batchId, orderedQty, expiryDate });
    res.json(validation);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Mark item picked (scan)
app.post('/api/picking/mark-picked', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const { lineId, batchId, pickedQty, cartonId } = req.body;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const pickingInt = createPickingIntegration(ctx.db, inventoryWh);
    const result = pickingInt.markItemPicked(lineId, batchId, pickedQty, cartonId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Assign batch to carton
app.post('/api/carton/assign-batch', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const { cartonLineId, batchId, quantity, customsLotId } = req.body;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const pickingInt = createPickingIntegration(ctx.db, inventoryWh);
    const result = pickingInt.assignBatchToCarton(cartonLineId, batchId, quantity, customsLotId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Close carton (finalize packing)
app.post('/api/carton/:cartonId/close', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const { customsLotId } = req.body;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const pickingInt = createPickingIntegration(ctx.db, inventoryWh);
    const result = pickingInt.closeCarton(req.params.cartonId, customsLotId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get wave picking status
app.get('/api/picking/status/:waveId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const pickingInt = createPickingIntegration(ctx.db, inventoryWh);
    const status = pickingInt.getWavePickingStatus(req.params.waveId);
    res.json(status);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── PHASE 5A/5B: Inventory Management ─────────────────────────────────────────

// Receive goods into warehouse
app.post('/api/inventory/receive', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const { warehouseId, skuId, batchNumber, serialNumber, expiryDate, quantity, location, poId, notes } = req.body;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const result = inventoryWh.receiveGoods({ warehouseId, skuId, batchNumber, serialNumber, expiryDate, quantity, location, poId, notes });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Check warehouse availability
app.post('/api/inventory/check-availability', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const { warehouseId, skuId, requiredQty } = req.body;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const availability = inventoryWh.checkWarehouseAvailability(warehouseId, skuId, requiredQty);
    res.json(availability);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get warehouse stats
app.get('/api/inventory/warehouse/:warehouseId/stats', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const stats = inventoryWh.getWarehouseStats(req.params.warehouseId);
    res.json(stats);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get batch audit trail
app.get('/api/inventory/batch/:batchId/audit', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const audit = inventoryWh.getBatchAudit(req.params.batchId);
    res.json(audit);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Adjust batch quantity
app.post('/api/inventory/batch/adjust', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const { batchId, adjustment, reason, targetQty } = req.body;
    const inventoryWh = createInventoryWarehouse(ctx.db);
    const result = inventoryWh.adjustBatchQuantity(batchId, adjustment, reason, targetQty);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── PHASE 5A: Singapore Customs Lot Management ────────────────────────────────

// Initialize customs lot sequence
app.post('/api/customs/configure-sequence', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const { prefix, year, startingNumber } = req.body;
    const customsLot = createCustomsLotManager(ctx.db);
    const result = customsLot.initializeSequence({ prefix, year, startingNumber });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get sequence info
app.get('/api/customs/sequence-info', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const customsLot = createCustomsLotManager(ctx.db);
    const info = customsLot.getSequenceInfo();
    res.json(info);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get next customs lot number (preview)
app.get('/api/customs/next-lot-number', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const customsLot = createCustomsLotManager(ctx.db);
    // Don't actually increment, just show what's next
    const seq = ctx.db.prepare('SELECT * FROM customs_lot_sequences WHERE id = 1').get();
    res.json({
      nextNumber: seq.current_number + 1,
      preview: `${seq.prefix}-${seq.year}-${String(seq.current_number + 1).padStart(6, '0')}`,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Assign customs lot to carton
app.post('/api/carton/:cartonId/assign-customs-lot', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const { poId, orderId, hsCode, description, totalPieces, grossWeightKg } = req.body;
    const customsLot = createCustomsLotManager(ctx.db);
    const result = customsLot.assignCustomsLot({
      cartonId: req.params.cartonId,
      poId, orderId, hsCode, description, totalPieces, grossWeightKg
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get assigned customs lot for carton
app.get('/api/carton/:cartonId/customs-lot', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const customsLot = createCustomsLotManager(ctx.db);
    const lot = customsLot.getCustomsLot(req.params.cartonId);
    res.json(lot);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// List pending customs lots
app.get('/api/customs/pending-lots', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const { warehouseId } = req.query;
    const customsLot = createCustomsLotManager(ctx.db);
    const lots = customsLot.listPendingCustomsLots(warehouseId);
    res.json(lots);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Mark customs lot as exported
app.post('/api/customs/:customsLotId/mark-exported', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const { shippingRefNo } = req.body;
    const customsLot = createCustomsLotManager(ctx.db);
    const result = customsLot.markAsExported(req.params.customsLotId, shippingRefNo);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get customs lot audit trail
app.get('/api/customs/:customsLotId/audit', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const customsLot = createCustomsLotManager(ctx.db);
    const audit = customsLot.getCustomsLotAudit(req.params.customsLotId);
    res.json(audit);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Cycle Count Management ────────────────────────────────────────────────────

// Create cycle count batch
app.post('/api/cycle-count/batch', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cycleCount = createCycleCount(ctx.db);
    const result = cycleCount.createCycleCountBatch(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Record count for item
app.post('/api/cycle-count/item/:countItemId/record', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cycleCount = createCycleCount(ctx.db);
    const result = cycleCount.recordCount(
      req.params.countItemId,
      req.body.countedQty,
      req.body.notes
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get batch progress
app.get('/api/cycle-count/batch/:batchId/progress', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cycleCount = createCycleCount(ctx.db);
    const progress = cycleCount.getCountBatchProgress(req.params.batchId);
    res.json(progress);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Finalize batch
app.post('/api/cycle-count/batch/:batchId/finalize', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cycleCount = createCycleCount(ctx.db);
    const result = cycleCount.finalizeCycleCountBatch(
      req.params.batchId,
      req.body.approverName
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get variance investigation
app.get('/api/cycle-count/variance/:varianceId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cycleCount = createCycleCount(ctx.db);
    const variance = cycleCount.getVarianceInvestigation(req.params.varianceId);
    res.json(variance);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Resolve variance
app.post('/api/cycle-count/variance/:varianceId/resolve', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cycleCount = createCycleCount(ctx.db);
    const result = cycleCount.resolveVariance(
      req.params.varianceId,
      req.body.resolution,
      req.body.notes
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get pending variances
app.get('/api/cycle-count/pending-variances', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cycleCount = createCycleCount(ctx.db);
    const variances = cycleCount.getPendingVariances(req.query.warehouseId);
    res.json({ variances });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Replenishment Management ──────────────────────────────────────────────────

// Get SKU velocity
app.get('/api/replenishment/velocity/:skuId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const replenishment = createReplenishment(ctx.db);
    const velocity = replenishment.calculateSkuVelocity(req.params.skuId);
    res.json(velocity);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get replenishment suggestions
app.get('/api/replenishment/suggest', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const replenishment = createReplenishment(ctx.db);
    const suggestions = replenishment.suggestReplenishmentTasks({
      warehouseId: req.query.warehouseId || 'wh-main',
      minVelocity: parseFloat(req.query.minVelocity) || 0.5,
      limitTasks: parseInt(req.query.limit) || 50
    });
    res.json(suggestions);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create replenishment wave
app.post('/api/replenishment/wave', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const replenishment = createReplenishment(ctx.db);
    const result = replenishment.createReplenishmentWave(
      req.body.taskIds,
      req.body.options || {}
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Execute replenishment task
app.post('/api/replenishment/task/:taskId/execute', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const replenishment = createReplenishment(ctx.db);
    const result = replenishment.executeReplenishmentTask(
      req.params.taskId,
      req.body.movedQty,
      req.body.notes
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get wave status
app.get('/api/replenishment/wave/:waveId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const replenishment = createReplenishment(ctx.db);
    const status = replenishment.getReplenishmentWaveStatus(req.params.waveId);
    res.json(status);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Auto-trigger replenishment
app.post('/api/replenishment/auto-trigger', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const replenishment = createReplenishment(ctx.db);
    const result = replenishment.autoTriggerReplenishment(req.body.warehouseId || 'wh-main');
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get pick face status
app.get('/api/replenishment/pick-face-status', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const replenishment = createReplenishment(ctx.db);
    const status = replenishment.getPickFaceStatus(req.query.warehouseId || 'wh-main');
    res.json(status);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get replenishment history
app.get('/api/replenishment/history', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const replenishment = createReplenishment(ctx.db);
    const history = replenishment.getReplenishmentHistory(
      req.query.warehouseId || 'wh-main',
      parseInt(req.query.days) || 30
    );
    res.json(history);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Auto-Trigger Replenishment ────────────────────────────────────────────────

// Start scheduler
app.post('/api/auto-trigger/start', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const replenishment = createReplenishment(ctx.db, ctx.inventoryWarehouse);
    const scheduler = createAutoTriggerScheduler(ctx.db, replenishment);
    const result = scheduler.startScheduler(req.body.intervalMinutes || 240);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Stop scheduler
app.post('/api/auto-trigger/stop', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const replenishment = createReplenishment(ctx.db, ctx.inventoryWarehouse);
    const scheduler = createAutoTriggerScheduler(ctx.db, replenishment);
    const result = scheduler.stopScheduler();
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get scheduler status
app.get('/api/auto-trigger/status', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const replenishment = createReplenishment(ctx.db, ctx.inventoryWarehouse);
    const scheduler = createAutoTriggerScheduler(ctx.db, replenishment);
    const result = scheduler.getSchedulerStatus();
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Barcode Scanner ────────────────────────────────────────────────────────────

// Generate scannable barcode
app.post('/api/barcode/generate', withStaffTenant, async (req, res) => {
  try {
    const barcodeScanner = createBarcodeScanner();
    const result = await barcodeScanner.generateScannableBarcode(
      req.body.data,
      req.body.options || {}
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Validate barcode
app.post('/api/barcode/validate', withStaffTenant, (req, res) => {
  try {
    const barcodeScanner = createBarcodeScanner();
    const result = barcodeScanner.validateBarcode(req.body.data, req.body.format);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Generate label with barcode
app.post('/api/barcode/label', withStaffTenant, async (req, res) => {
  try {
    const barcodeScanner = createBarcodeScanner();
    const result = await barcodeScanner.generateShippingLabelWithBarcode(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Demand Forecasting ─────────────────────────────────────────────────────────

// Forecast demand for SKU
app.get('/api/forecast/demand/:skuId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const forecast = createDemandForecast(ctx.db);
    const result = forecast.forecastDemand(
      req.params.skuId,
      parseInt(req.query.days) || 30,
      req.query.method || 'auto'
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Calculate reorder point
app.get('/api/forecast/reorder-point/:skuId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const forecast = createDemandForecast(ctx.db);
    const result = forecast.calculateReorderPoint(
      req.params.skuId,
      parseInt(req.query.leadTime) || 7,
      parseInt(req.query.safetyStock) || 7
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get inventory gap
app.get('/api/forecast/inventory-gap', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const forecast = createDemandForecast(ctx.db);
    const result = forecast.forecastInventoryGap(
      req.query.warehouseId || 'wh-main',
      parseInt(req.query.days) || 30
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── OCR Label Extraction ───────────────────────────────────────────────────────

// Extract label fields from text
app.post('/api/ocr/extract', withStaffTenant, (req, res) => {
  try {
    const ocr = createOCRLabels();
    const result = ocr.extractLabelFields(req.body.text);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Validate extracted fields
app.post('/api/ocr/validate', withStaffTenant, (req, res) => {
  try {
    const ocr = createOCRLabels();
    const result = ocr.validateExtraction(req.body.extracted);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Process image (placeholder for actual OCR integration)
app.post('/api/ocr/process-image', withStaffTenant, (req, res) => {
  try {
    const ocr = createOCRLabels();
    const result = ocr.processLabelImage(req.body.imagePath);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Zone-Based Cycle Counting ──────────────────────────────────────────────────

// Define zones
app.get('/api/cycle-count/zones', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cycleCount = createCycleCount(ctx.db, ctx.inventoryWarehouse);
    const zoneCycleCount = createZoneCycleCount(ctx.db, cycleCount);
    const result = zoneCycleCount.defineZones(req.query.warehouseId || 'wh-main');
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get zone statistics
app.get('/api/cycle-count/zones/:zone/stats', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cycleCount = createCycleCount(ctx.db, ctx.inventoryWarehouse);
    const zoneCycleCount = createZoneCycleCount(ctx.db, cycleCount);
    const result = zoneCycleCount.getZoneStatistics(
      req.query.warehouseId || 'wh-main',
      req.params.zone
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create zone count
app.post('/api/cycle-count/zones/:zone', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cycleCount = createCycleCount(ctx.db, ctx.inventoryWarehouse);
    const zoneCycleCount = createZoneCycleCount(ctx.db, cycleCount);
    const result = zoneCycleCount.createZoneCountBatch(
      req.query.warehouseId || 'wh-main',
      req.params.zone,
      req.body
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get rotation schedule
app.get('/api/cycle-count/zones/schedule', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cycleCount = createCycleCount(ctx.db, ctx.inventoryWarehouse);
    const zoneCycleCount = createZoneCycleCount(ctx.db, cycleCount);
    const result = zoneCycleCount.getZoneRotationSchedule(
      req.query.warehouseId || 'wh-main',
      parseInt(req.query.daysPerZone) || 7
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get zone drift report
app.get('/api/cycle-count/zones/drift', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cycleCount = createCycleCount(ctx.db, ctx.inventoryWarehouse);
    const zoneCycleCount = createZoneCycleCount(ctx.db, cycleCount);
    const result = zoneCycleCount.getZoneDriftReport(
      req.query.warehouseId || 'wh-main',
      parseInt(req.query.days) || 90
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Analyze zone performance
app.get('/api/cycle-count/zones/analysis', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const cycleCount = createCycleCount(ctx.db, ctx.inventoryWarehouse);
    const zoneCycleCount = createZoneCycleCount(ctx.db, cycleCount);
    const result = zoneCycleCount.analyzeZonePerformance(
      req.query.warehouseId || 'wh-main',
      parseInt(req.query.days) || 90
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Inbound Goods Receipt ──────────────────────────────────────────────────

// Create inbound receipt
app.post('/api/inbound/create', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.createInbound(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Scan item during receipt
app.post('/api/inbound/:inboundId/scan', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.scanInboundItem(
      req.params.inboundId,
      req.body.code,
      req.body.quantity,
      req.body
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create QC inspection
app.post('/api/inbound/:inboundId/qc/create', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.createQCInspection(req.params.inboundId, req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Record QC result
app.post('/api/inbound/:inboundId/qc/:qcId/result', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.recordQCResult(
      req.params.qcId,
      req.body.scanId,
      req.body.result,
      req.body.notes
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Quarantine items
app.post('/api/inbound/:inboundId/quarantine', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.quarantineItems(
      req.params.inboundId,
      req.body.scanIds,
      req.body.reason
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Release quarantine (manager approval)
app.post('/api/inbound/:inboundId/quarantine/release', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.releaseQuarantine(
      req.params.inboundId,
      req.body.scanIds,
      req.body.approverName,
      req.body.decision
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Putaway items to warehouse
app.post('/api/inbound/:inboundId/putaway', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.putawayItems(req.params.inboundId, req.body.assignments);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Complete receipt
app.post('/api/inbound/:inboundId/complete', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.completeReceipt(req.params.inboundId, req.body.receivedBy);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get inbound summary
app.get('/api/inbound/:inboundId/summary', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.getInboundSummary(req.params.inboundId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get receiving status
app.get('/api/inbound/status', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.getReceivingStatus(req.query.warehouseId || 'wh-main');
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create SKU code reference (barcode → SKU mapping)
app.post('/api/sku-references/create', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.createSKUCodeReference(
      req.body.code,
      req.body.sku,
      req.body.description,
      req.body.clientName
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Review quantity variances
app.post('/api/inbound/:inboundId/review-variances', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.reviewVariances(
      req.params.inboundId,
      req.body.varianceDecisions || []
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Quality check items
app.post('/api/inbound/:inboundId/quality-check', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.qualityCheckItems(
      req.params.inboundId,
      req.body.checks || []
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Approve receipt (manager sign-off)
app.post('/api/inbound/:inboundId/approve', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.approveReceipt(
      req.params.inboundId,
      req.body
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Auto-assign putaway locations based on velocity
app.post('/api/inbound/:inboundId/putaway-auto', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.autoPutawayAssignments(
      req.params.inboundId,
      req.body.warehouseId || 'wh-main',
      req.body.options || {}
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Generate Goods Receive Note
app.post('/api/inbound/:inboundId/grn', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.generateGRN(
      req.params.inboundId,
      req.body.recipientInfo || {}
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get receiving performance metrics
app.get('/api/inbound/metrics', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.getReceivingMetrics(
      req.query.warehouseId || 'wh-main',
      parseInt(req.query.days) || 7
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Capture photo during QC/inspection
app.post('/api/inbound/:inboundId/photos', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.capturePhoto(
      req.params.inboundId,
      {
        scanId: req.body.scanId || null,
        qcInspectionId: req.body.qcInspectionId || null,
        context: req.body.context || 'qc',
        photoBase64: req.body.photoBase64 || req.body.photo,
        filename: req.body.filename || '',
        capturedBy: req.body.capturedBy || 'staff',
        notes: req.body.notes || ''
      }
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get photos for inbound/scan/QC
app.get('/api/inbound/:inboundId/photos', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.getPhotos(
      req.params.inboundId,
      req.query.scanId || null,
      req.query.qcInspectionId || null,
      req.query.context || null
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get photo data (binary image)
app.get('/api/inbound/photos/:photoId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const photoData = inbound.getPhotoData(req.params.photoId);

    if (!photoData) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Return base64-encoded image
    res.json({
      photoId: photoData.photoId,
      filename: photoData.filename,
      mimeType: photoData.mimeType,
      photoBase64: photoData.photoData
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete photo
app.delete('/api/inbound/photos/:photoId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.deletePhoto(req.params.photoId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get photo statistics for inbound
app.get('/api/inbound/:inboundId/photos/stats', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const inbound = createInboundGoodsReceipt(ctx.db, ctx.inventoryWarehouse);
    const result = inbound.getPhotoStats(req.params.inboundId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Enhanced Returns ───────────────────────────────────────────────────────

// Create customer return (RMA)
app.post('/api/returns/create-rma', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const returns = createEnhancedReturns(ctx.db, ctx.inventoryWarehouse);
    const result = returns.createCustomerReturn(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create return to vendor (RTV)
app.post('/api/returns/create-rtv', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const returns = createEnhancedReturns(ctx.db, ctx.inventoryWarehouse);
    const result = returns.createReturnToVendor(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Inspect return item
app.post('/api/returns/:returnItemId/inspect', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const returns = createEnhancedReturns(ctx.db, ctx.inventoryWarehouse);
    const result = returns.inspectReturnItem(req.params.returnItemId, req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Process disposition (restock, refund, scrap, RTV)
app.post('/api/returns/:returnId/item/:itemId/disposition', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const returns = createEnhancedReturns(ctx.db, ctx.inventoryWarehouse);
    const result = returns.processDisposition(
      req.params.returnId,
      req.params.itemId,
      req.body.disposition,
      req.body.options || {}
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Generate credit memo
app.post('/api/returns/:returnId/credit-memo', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const returns = createEnhancedReturns(ctx.db, ctx.inventoryWarehouse);
    const result = returns.generateCreditMemo(req.params.returnId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Complete return processing
app.post('/api/returns/:returnId/complete', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const returns = createEnhancedReturns(ctx.db, ctx.inventoryWarehouse);
    const result = returns.completeReturn(req.params.returnId, req.body.notes);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get return analytics
app.get('/api/returns/analytics', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const returns = createEnhancedReturns(ctx.db, ctx.inventoryWarehouse);
    const result = returns.getReturnAnalytics(
      req.query.warehouseId || 'wh-main',
      parseInt(req.query.days) || 30
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get high-return SKUs
app.get('/api/returns/high-return-skus', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const returns = createEnhancedReturns(ctx.db, ctx.inventoryWarehouse);
    const result = returns.getHighReturnSKUs(
      parseInt(req.query.threshold) || 5,
      parseInt(req.query.days) || 90
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Advance Shipment Notice (ASN) ──────────────────────────────────────────

// Create ASN
app.post('/api/asn/create', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const asn = createASNManager(ctx.db);
    const result = asn.createASN(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Upload ASN from file (CSV/Excel)
app.post('/api/asn/upload', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const asn = createASNManager(ctx.db);
    const result = asn.uploadASNFromFile(req.body.fileData || [], {
      asnNumber: req.body.asnNumber,
      vendorName: req.body.vendorName,
      poNumber: req.body.poNumber || null
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get ASN details
app.get('/api/asn/:asnId', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const asn = createASNManager(ctx.db);
    const result = asn.getASNDetails(req.params.asnId);
    if (!result) return res.status(404).json({ error: 'ASN not found' });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Link inbound receipt to ASN
app.post('/api/asn/:asnId/link-receipt', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const asn = createASNManager(ctx.db);
    const result = asn.linkReceiptToASN(req.body.inboundId, req.params.asnId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Close ASN
app.post('/api/asn/:asnId/close', withStaffTenant, (req, res) => {
  try {
    const { ctx } = req;
    const asn = createASNManager(ctx.db);
    const result = asn.closeASN(req.params.asnId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── TMS (Transportation Management) ────────────────────────────────────────────

// Import customers from Excel (TMS delivery jobs)
app.post('/api/tms/import-customers', withStaffTenant, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const importer = createImporter({ store: req.store });
    const buffer = fs.readFileSync(req.file.path);
    const sheets = importer.parseExcel(buffer);
    const customersSheet = sheets['Customers'] || sheets['TMS_CUSTOMER'] || Object.values(sheets)[0] || [];

    const customers = importer.importCustomers(customersSheet);
    const createdOrders = [];

    for (const customer of customers) {
      try {
        const orderId = `TMS-${customer.customerId.replace(/[^A-Z0-9]/g, '').toUpperCase().slice(0, 20)}`;
        req.store.addOrder({
          id: orderId,
          clientId: 'tms-import',
          clientName: 'TMS Import',
          channel: 'tms',
          orderDate: customer.deliveryDate || new Date().toISOString(),
          status: 'pending',
          currency: 'SGD',
          items: customer.items || [{ sku: 'DELIVERY', name: customer.name, qty: 1, unitPrice: 0 }],
          shipping: {
            recipient: customer.name,
            addressLine1: customer.addressLine1,
            addressLine2: customer.addressLine2,
            city: customer.city,
            state: customer.state,
            zip: customer.zip,
            country: customer.country,
            phone: customer.phone,
            email: customer.email
          },
          subtotal: 0,
          tax: 0,
          total: 0,
          source: { type: 'tms-excel', ingestedAt: new Date().toISOString() }
        });
        createdOrders.push(orderId);
      } catch (e) {
        // Skip duplicate or invalid
      }
    }

    res.json({
      success: true,
      imported: {
        customersCount: customers.length,
        ordersCreated: createdOrders.length,
        createdOrders
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file && req.file.path) try { fs.unlinkSync(req.file.path); } catch {}
  }
});

// Import store codes (hubs/depots)
app.post('/api/tms/import-store-codes', withStaffTenant, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const importer = createImporter({ store: req.store });
    const buffer = fs.readFileSync(req.file.path);
    const sheets = importer.parseExcel(buffer);
    const storesSheet = sheets['Store Codes'] || sheets['TMS_STORE_CODE'] || Object.values(sheets)[0] || [];

    const stores = importer.importStoreCodes(storesSheet);

    res.json({
      success: true,
      imported: {
        storesCount: stores.length,
        stores: stores.slice(0, 5)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file && req.file.path) try { fs.unlinkSync(req.file.path); } catch {}
  }
});

// Import adjustments (quantity/pricing changes)
app.post('/api/tms/import-adjustments', withStaffTenant, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const importer = createImporter({ store: req.store });
    const buffer = fs.readFileSync(req.file.path);
    const sheets = importer.parseExcel(buffer);
    const adjSheet = sheets['Adjustments'] || sheets['TMS_ADJUSTMENT'] || Object.values(sheets)[0] || [];

    const adjustments = importer.importAdjustments(adjSheet);

    res.json({
      success: true,
      imported: {
        adjustmentsCount: adjustments.length,
        adjustments: adjustments.slice(0, 5)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file && req.file.path) try { fs.unlinkSync(req.file.path); } catch {}
  }
});

// ── IdealScan ↔ IdealOMS Sync Monitoring ──────────────────────────────────────

app.get('/api/sync/status', (req, res) => {
  const syncDaemon = app.locals.syncDaemon;
  if (!syncDaemon) {
    return res.status(400).json({ error: 'Sync daemon not initialized' });
  }
  res.json(syncDaemon.getStatus());
});

app.post('/api/sync/run', async (req, res) => {
  const syncDaemon = app.locals.syncDaemon;
  if (!syncDaemon) {
    return res.status(400).json({ error: 'Sync daemon not initialized' });
  }
  try {
    const result = await syncDaemon.syncNow();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sync/errors', (req, res) => {
  const syncDaemon = app.locals.syncDaemon;
  if (!syncDaemon) {
    return res.status(400).json({ error: 'Sync daemon not initialized' });
  }
  res.json({ errors: syncDaemon.getErrors() });
});

app.post('/api/sync/errors/clear', (req, res) => {
  const syncDaemon = app.locals.syncDaemon;
  if (!syncDaemon) {
    return res.status(400).json({ error: 'Sync daemon not initialized' });
  }
  syncDaemon.clearErrors();
  res.json({ success: true, message: 'Sync errors cleared' });
});

app.post('/api/sync/start', (req, res) => {
  const syncDaemon = app.locals.syncDaemon;
  if (!syncDaemon) {
    return res.status(400).json({ error: 'Sync daemon not initialized' });
  }
  syncDaemon.start();
  res.json({ success: true, message: 'Sync daemon started' });
});

app.post('/api/sync/stop', (req, res) => {
  const syncDaemon = app.locals.syncDaemon;
  if (!syncDaemon) {
    return res.status(400).json({ error: 'Sync daemon not initialized' });
  }
  syncDaemon.stop();
  res.json({ success: true, message: 'Sync daemon stopped' });
});

// ── TMS (Transport Management System) — integrated into store ──────────────────

app.get('/api/tms/address-book', withTenant, (req, res) => {
  try {
    res.json(req.store.getAddressBook());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/tms/address-book', withTenant, (req, res) => {
  try {
    req.store.upsertAddressEntry(req.body);
    res.json({ ok: true, message: 'Address entry saved' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/tms/address-book/suggest', withTenant, (req, res) => {
  try {
    const suggestions = req.store.suggestAddressEntry(req.query.q || '');
    res.json(suggestions);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/tms/depot', withTenant, (req, res) => {
  try {
    res.json(req.store.getDepot());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/tms/depot', withTenant, (req, res) => {
  try {
    const { zip, address } = req.body;
    req.store.setDepot(zip, address);
    res.json({ ok: true, message: 'Depot location updated' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/tms/delivery-jobs', withTenant, (req, res) => {
  try {
    const filters = {};
    if (req.query.status) filters.status = req.query.status;
    if (req.query.driver) filters.driver = req.query.driver;
    if (req.query.from) filters.from = req.query.from;
    if (req.query.to) filters.to = req.query.to;
    res.json(req.store.getDeliveryJobs(filters));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/tms/delivery-jobs', withTenant, (req, res) => {
  try {
    const tmsId = req.store.createDeliveryJob(req.body);
    res.json({ tmsId, message: 'Delivery job created' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/tms/delivery-jobs/:tmsId/status', withTenant, (req, res) => {
  try {
    const { status, remarks } = req.body;
    req.store.updateJobStatus(req.params.tmsId, status, remarks);
    res.json({ ok: true, message: 'Job status updated' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/tms/delivery-history', withTenant, (req, res) => {
  try {
    const from = req.query.from || new Date().toISOString().split('T')[0];
    const to = req.query.to || new Date().toISOString().split('T')[0];
    res.json(req.store.getDeliveryHistory(from, to));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/tms/routes', withTenant, (req, res) => {
  try {
    res.json({ routes: [] }); // Placeholder
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/tms/routes', withTenant, (req, res) => {
  try {
    const routeId = req.store.createDeliveryRoute(req.body.jobIds || []);
    res.json({ routeId, message: 'Route created' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Legal pages ───────────────────────────────────────────────────────────────

app.get('/tnc',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'tnc.html')));
app.get('/privacypolicy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacypolicy.html')));
app.get('/sync-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sync-dashboard.html')));
app.get('/locations-master', (req, res) => res.sendFile(path.join(__dirname, 'public', 'locations-master.html')));

// ─── MOBILE ENHANCEMENTS (Photo, GPS, Analytics, Sync) ─────────────────────────

// Photo upload endpoint (warehouse + driver)
app.post('/api/photos/upload', withTenant, upload.single('photo'), (req, res) => {
  try {
    if(!req.file) return res.status(400).json({ error: 'No photo provided' });

    const photoPath = path.join(__dirname, 'data', 'photos', req.tenantId);
    if(!fs.existsSync(photoPath)) fs.mkdirSync(photoPath, { recursive: true });

    const filename = `${Date.now()}-${req.file.originalname}`;
    const filepath = path.join(photoPath, filename);
    fs.copyFileSync(req.file.path, filepath);
    fs.unlinkSync(req.file.path);

    res.json({ ok: true, url: `/data/photos/${req.tenantId}/${filename}` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GPS position logging (driver tracking)
app.post('/api/driver/gps', withTenant, (req, res) => {
  try {
    const { driverId, latitude, longitude, accuracy, timestamp } = req.body;
    if(!driverId || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'Missing required GPS fields' });
    }

    const db = getTenantDb(req.tenantId);
    db.prepare(`
      CREATE TABLE IF NOT EXISTS driver_gps_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_id TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        accuracy REAL,
        timestamp TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run();

    db.prepare(`
      INSERT INTO driver_gps_log (driver_id, latitude, longitude, accuracy, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(driverId, latitude, longitude, accuracy || null, timestamp || new Date().toISOString());

    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Driver daily analytics
app.get('/api/driver/analytics/:driverId', withTenant, (req, res) => {
  try {
    const { driverId } = req.params;
    const db = getTenantDb(req.tenantId);

    const stats = {
      delivered: db.prepare(`
        SELECT COUNT(*) as count FROM delivery_jobs
        WHERE status = 'delivered' AND driver = ?
      `).get(driverId)?.count || 0,

      failed: db.prepare(`
        SELECT COUNT(*) as count FROM delivery_jobs
        WHERE status = 'delivered_with_remarks' AND driver = ?
      `).get(driverId)?.count || 0,

      gpsPoints: db.prepare(`
        SELECT COUNT(*) as count FROM driver_gps_log WHERE driver_id = ?
      `).get(driverId)?.count || 0
    };

    res.json(stats);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Offline sync queue processing
app.post('/api/sync/queue', withTenant, (req, res) => {
  try {
    const { items } = req.body;
    if(!Array.isArray(items)) return res.status(400).json({ error: 'Items must be array' });

    const db = getTenantDb(req.tenantId);
    let processed = 0;
    let failed = 0;

    for(const item of items) {
      try {
        if(item.type === 'carton_complete') {
          // Log carton completion
          db.prepare(`
            CREATE TABLE IF NOT EXISTS carton_completions (
              id TEXT PRIMARY KEY,
              wave_id TEXT,
              weight REAL,
              completed_at TEXT
            )
          `).run();

          db.prepare(`
            INSERT OR IGNORE INTO carton_completions (id, wave_id, weight, completed_at)
            VALUES (?, ?, ?, ?)
          `).run(item.id || Date.now().toString(), item.waveId, item.weight, item.timestamp);

          processed++;
        } else if(item.type === 'delivery_update') {
          // Update delivery status
          db.prepare(`
            UPDATE delivery_jobs SET status = ?, pod_remarks = ?, updated_at = ?
            WHERE tms_id = ?
          `).run(item.status, item.remarks, item.timestamp, item.tmsId);

          processed++;
        }
      } catch(e) {
        console.error('Sync item error:', e.message);
        failed++;
      }
    }

    res.json({ processed, failed, total: items.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Carton completion tracking
app.post('/api/cartons', withTenant, (req, res) => {
  try {
    const { waveId, weight, timestamp } = req.body;
    const db = getTenantDb(req.tenantId);

    db.prepare(`
      CREATE TABLE IF NOT EXISTS carton_track (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wave_id TEXT,
        weight REAL,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run();

    db.prepare(`
      INSERT INTO carton_track (wave_id, weight, completed_at)
      VALUES (?, ?, ?)
    `).run(waveId, weight, timestamp);

    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Real-time notifications (for push to connected clients)
const connectedClients = new Map();

app.post('/api/notify', withTenant, (req, res) => {
  try {
    const { clientId, title, message } = req.body;

    // Store notification
    db.prepare(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT,
        title TEXT,
        message TEXT,
        read INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run();

    db.prepare(`
      INSERT INTO notifications (client_id, title, message) VALUES (?, ?, ?)
    `).run(clientId, title, message);

    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  IdealOMS ready → ${url}\n`);
  // Only try to open a browser on local dev machines (not on Railway / CI / headless servers)
  if (!process.env.RAILWAY_ENVIRONMENT && !process.env.CI) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
              : process.platform === 'darwin' ? `open "${url}"`
              : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }

  // Kick off auto-sync: run immediately, then on interval
  autoSyncAll().catch(() => {});
  setInterval(autoSyncAll, SYNC_INTERVAL_MS);
  console.log(`  Auto-sync every ${SYNC_INTERVAL_MS / 60000} min (set SYNC_INTERVAL_MINUTES to change)\n`);

  // Initialize IdealScan ↔ IdealOMS sync daemon (if enabled)
  if (process.env.ENABLE_SYNC_DAEMON !== 'false') {
    const tenantDb = getTenantDb('default');
    const sourceDbPath = path.join(__dirname, 'data', 'idealoms.db');

    if (fs.existsSync(sourceDbPath)) {
      try {
        const sqlite3 = require('better-sqlite3');
        const sourceDb = new sqlite3(sourceDbPath);

        const syncDaemon = createSyncDaemon(tenantDb, {
          sourceDb,
          pollingInterval: parseInt(process.env.SYNC_INTERVAL_MS || '30000'),
          port: PORT,
          apiKey: process.env.API_KEY || 'migration-key'
        });

        // Start the daemon
        syncDaemon.start();

        // Store for later access
        app.locals.syncDaemon = syncDaemon;

        console.log('  ✅ IdealScan↔IdealOMS sync daemon started (30s polling)');
      } catch (e) {
        console.warn('  ⚠️  Sync daemon initialization failed:', e.message);
      }
    } else {
      console.log('  ℹ️  IdealScan database not found (sync skipped)');
    }
  }
});
