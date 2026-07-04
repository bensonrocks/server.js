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

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Tenant context cache ──────────────────────────────────────────────────────

const tenantCtx = new Map();

function getCtx(tenantId) {
  if (!tenantCtx.has(tenantId)) {
    const db = getTenantDb(tenantId);
    tenantCtx.set(tenantId, {
      db,
      store:   createStore(db),
      creds:   createCreds(tenantId),
      syncLog: createSyncLog(db),
    });
  }
  return tenantCtx.get(tenantId);
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function withTenant(req, res, next) {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  if (!session) return res.status(401).json({ error: 'Authentication required' });

  const tenant = mainDb.prepare('SELECT id, active FROM tenants WHERE id = ?').get(session.tenantId);
  if (!tenant || !tenant.active) return res.status(403).json({ error: 'Tenant not found or suspended' });

  const ctx      = getCtx(session.tenantId);
  req.tenantId   = session.tenantId;
  req.db         = ctx.db;
  req.store      = ctx.store;
  req.creds      = ctx.creds;
  req.syncLog    = ctx.syncLog;
  next();
}

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
  next();
}

// ── Staff portal routes ───────────────────────────────────────────────────────

app.post('/api/staff/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const user = staffAuth.checkPassword(username, password || '');
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  res.json({ token: staffAuth.generateToken(username), username });
});

app.post('/api/staff/logout', withStaff, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  staffAuth.revokeToken(token);
  res.json({ ok: true });
});

app.get('/api/staff/me', withStaff, (req, res) => {
  res.json({ username: req.staffUsername });
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

app.get('/api/orders/:id/waybill', async (req, res) => {
  const token   = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const session = auth.validateToken(token);
  const tenantId = session?.tenantId || 'default';
  const { store, creds } = getCtx(tenantId);

  const order = store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { type, externalId } = order.source || {};
  const conn = registry[type];
  if (!conn?.fetchWaybill) return res.status(404).json({ error: 'Waybill not available for this order type' });

  const c = creds.get(type);
  if (!c?.accessToken) return res.status(400).json({ error: `${conn.meta.name} not connected — check Connections page` });

  try {
    const result = await conn.fetchWaybill(c, externalId, order);
    if (result.url) store.updateOrder(order.id, { source: { waybillUrl: result.url } });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
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
      connected:      !!c.accessToken,
      hasCredentials: !!(c.appKey || c.partnerId || c.apiKey),
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

app.get('/api/connect/:platform/oauth-url', withTenant, (req, res) => {
  const { platform } = req.params;
  const conn = registry[platform];
  if (!conn)              return res.status(400).json({ error: 'Unknown platform' });
  if (!conn.buildAuthUrl) return res.status(400).json({ error: `${conn.meta.name} does not use OAuth` });
  const c = req.creds.get(platform) || {};
  for (const field of conn.meta.requiredForOAuth || []) {
    if (!c[field]) return res.status(400).json({ error: `Save your ${conn.meta.name} ${field} first` });
  }
  res.json({ url: conn.buildAuthUrl(c, `${BASE_URL}/api/connect/${platform}/callback`) });
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

async function syncPlatform(platform, opts, store, creds, syncLog) {
  const conn = registry[platform];
  if (!conn)             throw new Error(`Unknown platform: ${platform}`);
  if (!conn.fetchOrders) throw new Error(`${conn.meta.name} does not support order sync`);
  const c = creds.get(platform);
  if (!c?.accessToken)   throw new Error(`${conn.meta.name} not connected — save credentials first`);
  const storeName = c.storeName || conn.meta.defaultStoreName || conn.meta.name;
  const raw       = await conn.fetchOrders(c, opts);
  let added = 0;
  for (const item of raw) {
    try { store.addOrder(conn.mapOrder(item, storeName)); added++; } catch { /* skip duplicates */ }
  }
  creds.set(platform, { lastSync: new Date().toISOString(), lastSyncCount: added });
  return { platform, at: new Date().toISOString(), fetched: raw.length, added };
}

app.post('/api/sync/all', withTenant, async (req, res) => {
  const { store, creds, syncLog } = req;
  const results = await Promise.allSettled(PLATFORMS.map(p => syncPlatform(p, {}, store, creds, syncLog)));
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
    const entry = await syncPlatform(platform, req.body, req.store, req.creds, req.syncLog);
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
  const callbackUrl = `${BASE_URL}/api/client/connections/${platform}/callback?oms=${nonce}`;
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
      if (!c?.accessToken) continue;
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
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd);

  // Kick off auto-sync: run immediately, then on interval
  autoSyncAll().catch(() => {});
  setInterval(autoSyncAll, SYNC_INTERVAL_MS);
  console.log(`  Auto-sync every ${SYNC_INTERVAL_MS / 60000} min (set SYNC_INTERVAL_MINUTES to change)\n`);
});
