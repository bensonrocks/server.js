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
const emailP          = require('./lib/email-parser');
const registry        = require('./lib/connector-registry');
const auth            = require('./lib/auth');
const importer        = require('./lib/file-importer');
const { createClientAuth } = require('./lib/client-auth');
const staffAuth = require('./lib/staff-auth');
const createInventory   = require('./lib/inventory');
const createFulfillment = require('./lib/fulfillment');
const createPicking     = require('./lib/picking');
const createDrivers     = require('./lib/drivers');
const shopifyApp        = require('./lib/shopify-app');
const inventorySync     = require('./lib/inventory-sync');

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

// verify callback stores the raw Buffer on req so webhook HMAC verification can use it
// limit raised for proof-of-delivery photos/signatures posted by the driver app
app.use(express.json({ limit: '8mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
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
    const fulfillment = createFulfillment({ store, creds, inventory });
    const picking     = createPicking({ db, store });
    const drivers     = createDrivers({ db, store });
    tenantCtx.set(tenantId, { db, store, creds, syncLog, inventory, fulfillment, picking, drivers });
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
  const ctx      = getCtx('default');
  req.tenantId   = 'default';
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

// Emergency admin reset — GET /api/staff/emergency — resets administrator password and returns a ready token
app.get('/api/staff/emergency', (req, res) => {
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

// List client portal users (all tenants — for now defaults to 'default')
app.get('/api/staff/client-users', withStaff, (req, res) => {
  const tenantId = req.query.tenantId || 'default';
  const { db } = getCtx(tenantId);
  const ca = createClientAuth(db);
  res.json(ca.listUsers());
});

// Reset a client portal user's password
app.patch('/api/staff/client-users/:clientId', withStaff, (req, res) => {
  const { clientId } = req.params;
  const { password } = req.body || {};
  if (!password || password.length < 1) return res.status(400).json({ error: 'New password required' });
  const tenantId = req.query.tenantId || 'default';
  const { db } = getCtx(tenantId);
  const ca = createClientAuth(db);
  try {
    ca.setPassword(clientId, password);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Toggle client portal user active/inactive
app.patch('/api/staff/client-users/:clientId/active', withStaff, (req, res) => {
  const { clientId } = req.params;
  const { active } = req.body || {};
  const tenantId = req.query.tenantId || 'default';
  const { db } = getCtx(tenantId);
  const ca = createClientAuth(db);
  ca.setActive(clientId, !!active);
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
app.get('/api/staff/api-keys', withStaff, (req, res) => {
  const tenantId = req.headers['x-tenant-id'] || 'default';
  const { db } = getCtx(tenantId);
  res.json(createClientAuth(db).listApiKeys());
});

app.post('/api/staff/api-keys', withStaff, (req, res) => {
  const { clientId, clientName, label } = req.body || {};
  if (!clientId || !clientName) return res.status(400).json({ error: 'clientId and clientName required' });
  const tenantId = req.headers['x-tenant-id'] || 'default';
  const { db } = getCtx(tenantId);
  const key = createClientAuth(db).generateApiKey(clientId, clientName, label || '');
  res.json({ key });
});

app.delete('/api/staff/api-keys/:key', withStaff, (req, res) => {
  const tenantId = req.headers['x-tenant-id'] || 'default';
  const { db } = getCtx(tenantId);
  createClientAuth(db).revokeApiKey(req.params.key);
  res.json({ ok: true });
});

app.patch('/api/staff/api-keys/:key/active', withStaff, (req, res) => {
  const { active } = req.body || {};
  const tenantId = req.headers['x-tenant-id'] || 'default';
  const { db } = getCtx(tenantId);
  createClientAuth(db).setApiKeyActive(req.params.key, !!active);
  res.json({ ok: true });
});

// ── API key middleware (client ingest) ────────────────────────────────────────

function withApiKey(req, res, next) {
  const key      = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const tenantId = req.headers['x-tenant-id'] || 'default';
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

app.get('/api/orders', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const tenantId = session?.tenantId || 'default';
  const { store } = getCtx(tenantId);
  const { clientId, channel, status, search } = req.query;
  res.json(store.getOrders({ clientId, channel, status, search }));
});

app.get('/api/orders/:id', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const tenantId = session?.tenantId || 'default';
  const { store } = getCtx(tenantId);
  const order = store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

app.patch('/api/orders/:id', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const tenantId = session?.tenantId || 'default';
  const { store } = getCtx(tenantId);
  const { status, notes, source, shipping } = req.body || {};
  try {
    const updated = store.updateOrder(req.params.id, { status, notes, source, shipping });
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

app.post('/api/orders/ingest-email', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const tenantId = session?.tenantId || 'default';
  const { store } = getCtx(tenantId);

  const { body, subject, from } = req.body || {};
  if (!body) return res.status(400).json({ error: 'Email body is required' });
  try {
    const order = emailP.parseEmailBody(body);
    if (subject) order.source.emailSubject = subject;
    if (from)    order.source.emailFrom    = from;
    store.addOrder(order);
    res.status(201).json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── File import ───────────────────────────────────────────────────────────────

function extractedToOrder(data, index) {
  const now   = new Date().toISOString();
  const refNo = data.trackingNumber || data.orderNumber;
  const orderId = refNo
    ? 'IMP-' + refNo.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 18)
    : 'IMP-' + Date.now().toString(36).toUpperCase() + String(index).padStart(3, '0');

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

app.post('/api/orders/extract', upload.single('file'), async (req, res) => {
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

app.post('/api/orders/bulk-import', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const tenantId = session?.tenantId || 'default';
  const { store } = getCtx(tenantId);

  const { orders: raw } = req.body || {};
  if (!Array.isArray(raw) || !raw.length) return res.status(400).json({ error: 'No orders provided' });

  let imported = 0, skipped = 0;
  const errors = [];

  raw.forEach((data, i) => {
    try {
      store.addOrder(extractedToOrder(data, i));
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

app.get('/api/stats', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const { store } = getCtx(session?.tenantId || 'default');
  res.json(store.getStats());
});

app.get('/api/clients', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const { store } = getCtx(session?.tenantId || 'default');
  res.json(store.getClients());
});

app.get('/api/channels', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const { store } = getCtx(session?.tenantId || 'default');
  res.json(store.getChannels());
});

// ── Connector registry ────────────────────────────────────────────────────────

const PLATFORMS = Object.keys(registry);

app.get('/api/connect/status', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const { creds } = getCtx(session?.tenantId || 'default');

  const all    = creds.getAll();
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
app.post('/api/connect/:platform/inventory/discover', withStaff, withTenant, (req, res) => {
  const { platform } = req.params;
  if (!inventorySync.SUPPORTED.has(platform)) return res.status(400).json({ error: `Inventory sync not supported for ${platform}` });
  try {
    res.json(inventorySync.discover(platform, req.ctx.db));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List current SKU mappings for a platform
app.get('/api/connect/:platform/inventory/map', withStaff, withTenant, (req, res) => {
  const { platform } = req.params;
  res.json(req.ctx.db.prepare('SELECT * FROM channel_sku_map WHERE platform = ? ORDER BY oms_sku').all(platform));
});

// Add or update a SKU mapping manually
app.post('/api/connect/:platform/inventory/map', withStaff, withTenant, (req, res) => {
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
app.delete('/api/connect/:platform/inventory/map/:sku', withStaff, withTenant, (req, res) => {
  req.ctx.db.prepare('DELETE FROM channel_sku_map WHERE platform = ? AND oms_sku = ?').run(req.params.platform, req.params.sku);
  res.json({ ok: true });
});

// Pull inventory FROM marketplace → update OMS stock
app.post('/api/connect/:platform/inventory/pull', withStaff, withTenant, async (req, res) => {
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
app.post('/api/connect/:platform/inventory/push', withStaff, withTenant, async (req, res) => {
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

  // Resolve tenant from state param or token header (OAuth state carries tenantId)
  const tenantId = req.query.tenantId || 'default';
  const { creds } = getCtx(tenantId);

  try {
    const tokens = await conn.exchangeCode(creds.get(platform) || {}, req.query);
    creds.set(platform, { ...tokens, connectedAt: new Date().toISOString() });
    res.send(okPage(conn.meta.name));
  } catch (e) {
    res.status(500).send(errPage(conn.meta.name, e.message));
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

  // Zetpy: load store→client mappings so each shop's orders route to the right client
  let zetpyMappings = null;
  if (platform === 'zetpy' && db) {
    try {
      const rows = db.prepare('SELECT * FROM zetpy_store_mappings').all();
      zetpyMappings = new Map(rows.map(r => [`${r.app_name}|||${r.app_account_name}`, r]));
    } catch (_) {}
  }

  // Auto-match any pending client store registrations against discovered Zetpy stores
  if (platform === 'zetpy' && db && raw.length) {
    try {
      const pending = db.prepare("SELECT * FROM store_connection_requests WHERE status = 'pending'").all();
      for (const req of pending) {
        const storeNameL   = req.store_name.toLowerCase();
        const marketplaceL = req.marketplace.toLowerCase();
        for (const o of raw) {
          const src = o.source || {};
          const appName     = src.zetpyAppName     || '';
          const accountName = src.zetpyAccountName || '';
          if (!appName || !accountName) continue;
          const accountL = accountName.toLowerCase();
          const appL     = appName.toLowerCase();
          if ((accountL === storeNameL || accountL.includes(storeNameL) || storeNameL.includes(accountL)) &&
              appL.includes(marketplaceL.slice(0, 5))) {
            db.prepare(`
              INSERT INTO zetpy_store_mappings (app_name, app_account_name, client_id, client_name)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(app_name, app_account_name) DO UPDATE SET
                client_id = excluded.client_id, client_name = excluded.client_name
            `).run(appName, accountName, req.client_id, req.client_name);
            db.prepare(`UPDATE store_connection_requests SET status = 'approved', resolved_at = datetime('now') WHERE id = ?`).run(req.id);
            zetpyMappings.set(`${appName}|||${accountName}`, { client_id: req.client_id, client_name: req.client_name });
            break;
          }
        }
      }
    } catch (_) {}
  }

  let added = 0;
  for (const item of raw) {
    try {
      let order = conn.mapOrder(item, storeName);
      if (zetpyMappings) {
        const src = item.source || {};
        const key = `${src.zetpyAppName || ''}|||${src.zetpyAccountName || ''}`;
        const mapped = zetpyMappings.get(key);
        if (mapped) {
          order = { ...order, clientId: mapped.client_id, clientName: mapped.client_name || mapped.client_id };
        }
      }
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

// ── Zetpy Store Management (staff) ───────────────────────────────────────────

// Fetch a page of orders from Zetpy and extract all unique (app_name, app_account_name) pairs
app.get('/api/zetpy/discover', withTenant, async (req, res) => {
  const c = req.creds.get('zetpy');
  if (!c?.email) return res.status(400).json({ error: 'Zetpy not connected — save credentials first' });
  try {
    const raw  = await registry['zetpy'].fetchOrders(c, { pageSize: 200 });
    const seen = new Map();
    for (const o of raw) {
      const src         = o.source || {};
      const appName     = src.zetpyAppName     || '';
      const accountName = src.zetpyAccountName || '';
      if (appName && accountName) {
        const key = `${appName}|||${accountName}`;
        if (!seen.has(key)) seen.set(key, { app_name: appName, app_account_name: accountName });
      }
    }
    res.json(Array.from(seen.values()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/zetpy/mappings', withTenant, (req, res) => {
  res.json(req.db.prepare('SELECT * FROM zetpy_store_mappings ORDER BY app_name, app_account_name').all());
});

app.post('/api/zetpy/mappings', withTenant, (req, res) => {
  const { app_name, app_account_name, client_id, client_name = '' } = req.body || {};
  if (!app_name || !app_account_name || !client_id)
    return res.status(400).json({ error: 'app_name, app_account_name, client_id required' });
  req.db.prepare(`
    INSERT INTO zetpy_store_mappings (app_name, app_account_name, client_id, client_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(app_name, app_account_name) DO UPDATE SET
      client_id = excluded.client_id, client_name = excluded.client_name
  `).run(app_name, app_account_name, client_id, client_name);
  res.json({ ok: true });
});

app.delete('/api/zetpy/mappings/:id', withTenant, (req, res) => {
  req.db.prepare('DELETE FROM zetpy_store_mappings WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/zetpy/requests', withTenant, (req, res) => {
  res.json(req.db.prepare('SELECT * FROM store_connection_requests ORDER BY created_at DESC').all());
});

app.patch('/api/zetpy/requests/:id', withTenant, (req, res) => {
  const row = req.db.prepare('SELECT * FROM store_connection_requests WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Request not found' });
  const { status, app_name, app_account_name } = req.body || {};
  req.db.prepare(`UPDATE store_connection_requests SET status = ?, resolved_at = datetime('now') WHERE id = ?`)
    .run(status, row.id);
  if (status === 'approved' && app_name && app_account_name) {
    req.db.prepare(`
      INSERT INTO zetpy_store_mappings (app_name, app_account_name, client_id, client_name)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(app_name, app_account_name) DO UPDATE SET
        client_id = excluded.client_id, client_name = excluded.client_name
    `).run(app_name, app_account_name, row.client_id, row.client_name);
  }
  res.json({ ok: true });
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

app.post('/api/leads/search', async (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const tenantId = session?.tenantId || 'default';
  const db = getCtx(tenantId).db;

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

app.post('/api/leads/enrich', async (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const db = getCtx(session?.tenantId || 'default').db;

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

app.patch('/api/leads/:id/contact', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const db = getCtx(session?.tenantId || 'default').db;

  const { contacted, contact_note = '', note = '' } = req.body || {};
  const resolvedNote = contact_note || note;
  const now = contacted ? new Date().toISOString() : '';
  db.prepare(`UPDATE leads SET contacted=?, contacted_at=?, contact_note=? WHERE apollo_id=?`)
    .run(contacted ? 1 : 0, now, resolvedNote, req.params.id);
  const lead = db.prepare('SELECT * FROM leads WHERE apollo_id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json({ ok: true, contacted: !!lead.contacted, contacted_at: lead.contacted_at });
});

app.patch('/api/leads/:id/note', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const db = getCtx(session?.tenantId || 'default').db;

  const { note = '' } = req.body || {};
  db.prepare('UPDATE leads SET contact_note=? WHERE apollo_id=?').run(note, req.params.id);
  res.json({ ok: true });
});

app.get('/api/leads', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const db = getCtx(session?.tenantId || 'default').db;

  const { vertical, contacted, session_id } = req.query;
  let sql    = 'SELECT l.*, s.dug_at as session_dug_at FROM leads l JOIN lead_sessions s ON l.session_id=s.id WHERE 1=1';
  const args = [];
  if (vertical)   { sql += ' AND l.vertical=?';   args.push(vertical); }
  if (session_id) { sql += ' AND l.session_id=?'; args.push(session_id); }
  if (contacted !== undefined) { sql += ' AND l.contacted=?'; args.push(contacted === 'true' ? 1 : 0); }
  sql += ' ORDER BY l.dug_at DESC';
  res.json(db.prepare(sql).all(...args));
});

app.get('/api/leads/sessions', (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const db = getCtx(session?.tenantId || 'default').db;
  res.json(db.prepare('SELECT * FROM lead_sessions ORDER BY dug_at DESC').all());
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

// ── Driver tracking ───────────────────────────────────────────────────────────

// Driver-app auth: Bearer token issued by POST /api/driver/login
function withDriver(req, res, next) {
  withTenant(req, res, () => {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const driver = req.ctx.drivers.validateToken(token);
    if (!driver) return res.status(401).json({ error: 'Driver authentication required' });
    req.driver = driver;
    req.driverToken = token;
    next();
  });
}

// — staff/admin side —

app.get('/api/drivers', withTenant, (req, res) => {
  res.json(req.ctx.drivers.listDrivers());
});

// Driver account management is admin-only
app.post('/api/drivers', withAdmin, withTenant, (req, res) => {
  try {
    res.status(201).json(req.ctx.drivers.createDriver(req.body || {}));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/drivers/locations', withTenant, (req, res) => {
  res.json(req.ctx.drivers.latestLocations());
});

app.get('/api/drivers/stats', withTenant, (req, res) => {
  res.json(req.ctx.drivers.stats());
});

app.get('/api/drivers/:id', withTenant, (req, res) => {
  const driver = req.ctx.drivers.getDriver(req.params.id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  res.json({
    ...driver,
    deliveries: req.ctx.drivers.listDeliveries({ driverId: driver.id, limit: 100 }),
    route: req.ctx.drivers.getRoute(driver.id, Number(req.query.route) || 50),
  });
});

app.patch('/api/drivers/:id', withAdmin, withTenant, (req, res) => {
  try {
    res.json(req.ctx.drivers.updateDriver(req.params.id, req.body || {}));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/drivers/:id', withAdmin, withTenant, (req, res) => {
  try {
    req.ctx.drivers.deleteDriver(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/drivers/:id/assign', withTenant, (req, res) => {
  try {
    const { orderIds, assignedBy } = req.body || {};
    res.status(201).json(req.ctx.drivers.assign(req.params.id, orderIds, assignedBy || ''));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/deliveries', withTenant, (req, res) => {
  const { driverId, status, active, limit } = req.query;
  res.json(req.ctx.drivers.listDeliveries({
    driverId, status, activeOnly: active === 'true', limit,
  }));
});

// Full delivery record incl. proof-of-delivery signature/photo (list strips them)
app.get('/api/deliveries/:id', withTenant, (req, res) => {
  const d = req.ctx.drivers.getDeliveryFull(req.params.id);
  if (!d) return res.status(404).json({ error: 'Delivery not found' });
  res.json(d);
});

app.patch('/api/deliveries/:id/status', withTenant, (req, res) => {
  try {
    const { status, reason, podName, podNote } = req.body || {};
    res.json(req.ctx.drivers.updateStatus(req.params.id, status, { reason, podName, podNote }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/deliveries/:id', withTenant, (req, res) => {
  try {
    req.ctx.drivers.unassign(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// — driver app side —

app.post('/api/driver/login', withTenant, (req, res) => {
  const { phone, pin } = req.body || {};
  const result = req.ctx.drivers.login(phone, pin);
  if (!result) return res.status(401).json({ error: 'Invalid phone or PIN' });
  res.json(result);
});

app.post('/api/driver/logout', withDriver, (req, res) => {
  req.ctx.drivers.revokeToken(req.driverToken);
  res.json({ ok: true });
});

app.get('/api/driver/me', withDriver, (req, res) => {
  res.json(req.driver);
});

app.get('/api/driver/deliveries', withDriver, (req, res) => {
  const all = req.ctx.drivers.listDeliveries({ driverId: req.driver.id, limit: 100 });
  // active first, then today's completed
  const today = new Date().toISOString().slice(0, 10);
  res.json(all.filter(d =>
    ['assigned', 'picked_up', 'in_transit'].includes(d.status)
    || (d.delivered_at || d.failed_at || '').slice(0, 10) === today
  ));
});

app.post('/api/driver/deliveries/:id/status', withDriver, (req, res) => {
  try {
    const { status, reason, podName, podNote, lat, lng, podSignature, podPhoto } = req.body || {};
    res.json(req.ctx.drivers.updateStatus(req.params.id, status, {
      driverId: req.driver.id, reason, podName, podNote, lat, lng, podSignature, podPhoto,
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/driver/location', withDriver, (req, res) => {
  try {
    req.ctx.drivers.recordLocation(req.driver.id, req.body || {});
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// — public order tracking (no auth; returns a safe subset only) —

app.get('/api/track/:orderId', withTenant, (req, res) => {
  const info = req.ctx.drivers.track(req.params.orderId);
  if (!info) return res.status(404).json({ error: 'Order not found' });
  res.json(info);
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

// ── Zetpy-based client connections ───────────────────────────────────────────

// Client: view their connected stores (mapped in Zetpy) + their pending requests
app.get('/api/portal/my-connections', withClientAuth, (req, res) => {
  const mappings = req.db.prepare(
    'SELECT * FROM zetpy_store_mappings WHERE client_id = ? ORDER BY app_name, app_account_name'
  ).all(req.clientId);
  const requests = req.db.prepare(
    'SELECT * FROM store_connection_requests WHERE client_id = ? ORDER BY created_at DESC'
  ).all(req.clientId);
  res.json({ mappings, requests });
});

// Client: connect a store — auto-matches against Zetpy, falls back to pending
app.post('/api/portal/connection-requests', withClientAuth, async (req, res) => {
  const { marketplace, store_name, notes = '' } = req.body || {};
  if (!marketplace || !store_name)
    return res.status(400).json({ error: 'marketplace and store_name required' });

  const db          = req.db;
  const zetpyCreds  = createCreds(req.tenantId).get('zetpy');
  const storeNameL  = store_name.toLowerCase();
  const marketplaceL = marketplace.toLowerCase();

  // Attempt immediate auto-match from Zetpy
  let autoConnected = false;
  if (zetpyCreds?.email) {
    try {
      const raw = await registry['zetpy'].fetchOrders(zetpyCreds, { pageSize: 200 });
      for (const o of raw) {
        const src = o.source || {};
        const appName     = src.zetpyAppName     || '';
        const accountName = src.zetpyAccountName || '';
        if (!appName || !accountName) continue;
        const accountL = accountName.toLowerCase();
        const appL     = appName.toLowerCase();
        if ((accountL === storeNameL || accountL.includes(storeNameL) || storeNameL.includes(accountL)) &&
            appL.includes(marketplaceL.slice(0, 5))) {
          db.prepare(`
            INSERT INTO zetpy_store_mappings (app_name, app_account_name, client_id, client_name)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(app_name, app_account_name) DO UPDATE SET
              client_id = excluded.client_id, client_name = excluded.client_name
          `).run(appName, accountName, req.clientId, req.clientName || req.clientId);
          autoConnected = true;
          break;
        }
      }
    } catch (_) {}
  }

  if (!autoConnected) {
    // Store as pending — will be matched on the next Zetpy sync
    db.prepare(
      'INSERT INTO store_connection_requests (client_id, client_name, marketplace, store_name, notes) VALUES (?, ?, ?, ?, ?)'
    ).run(req.clientId, req.clientName || req.clientId, marketplace, store_name, notes);
  }

  res.json({ ok: true, autoConnected });
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

// ── Legal pages ───────────────────────────────────────────────────────────────

app.get('/tnc',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'tnc.html')));
app.get('/privacypolicy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacypolicy.html')));

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
});
