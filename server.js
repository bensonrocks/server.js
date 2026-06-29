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
const { exec }   = require('child_process');
const multer     = require('multer');

const store    = require('./lib/store');
const emailP   = require('./lib/email-parser');
const creds    = require('./lib/credentials');
const syncLog  = require('./lib/sync-log');
const lazada   = require('./lib/marketplace/lazada');
const shopee   = require('./lib/marketplace/shopee');
const tiktok   = require('./lib/marketplace/tiktok');
const shopify  = require('./lib/marketplace/shopify');
const mapper   = require('./lib/marketplace/mapper');
const auth     = require('./lib/auth');
const importer = require('./lib/file-importer');
const db       = require('./lib/db');
const ldb      = require('./lib/leads-db');
const pick     = require('./lib/pick');
const pack     = require('./lib/pack');

const app      = express();
const PORT     = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth — public routes (before middleware) ──────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!auth.checkPassword(password)) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ token: auth.generateToken() });
});

app.post('/api/auth/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  auth.revokeToken(token);
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  res.json({ authenticated: auth.validateToken(token) });
});

// ── Orders ────────────────────────────────────────────────────────────────────

app.get('/api/orders', (req, res) => {
  const { clientId, channel, status, search } = req.query;
  res.json(store.getOrders({ clientId, channel, status, search }));
});

app.get('/api/orders/:id', (req, res) => {
  const order = store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

app.post('/api/orders/ingest-email', (req, res) => {
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

// ── File import — extract orders from an uploaded file ────────────────────────

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

app.get('/api/stats',    (req, res) => res.json(store.getStats()));
app.get('/api/clients',  (req, res) => res.json(store.getClients()));
app.get('/api/channels', (req, res) => res.json(store.getChannels()));

// ── Marketplace Connections ───────────────────────────────────────────────────

const PLATFORMS = ['lazada', 'shopee', 'tiktok', 'shopify'];

// Connection status for all platforms
app.get('/api/connect/status', (req, res) => {
  const all    = creds.getAll();
  const result = {};
  for (const p of PLATFORMS) {
    const c = all[p] || {};
    result[p] = {
      connected:      !!c.accessToken,
      hasCredentials: !!(c.appKey || c.partnerId),
      storeName:      c.storeName  || null,
      connectedAt:    c.connectedAt || null,
      lastSync:       c.lastSync   || null,
      lastSyncCount:  c.lastSyncCount ?? null,
    };
  }
  res.json(result);
});

// Save credentials (app key/secret/token) for a platform
app.post('/api/connect/:platform', (req, res) => {
  const { platform } = req.params;
  if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Unknown platform' });
  const saved = creds.set(platform, req.body);
  // Strip secrets from the response
  const { appSecret, partnerKey, ...safe } = saved;
  res.json({ ok: true, ...safe });
});

// Disconnect a platform
app.delete('/api/connect/:platform', (req, res) => {
  const { platform } = req.params;
  if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Unknown platform' });
  creds.remove(platform);
  res.json({ ok: true });
});

// ── OAuth flows ───────────────────────────────────────────────────────────────

// Lazada
app.get('/api/connect/lazada/oauth-url', (req, res) => {
  const c = creds.get('lazada');
  if (!c?.appKey) return res.status(400).json({ error: 'Save your Lazada App Key first' });
  res.json({ url: lazada.buildAuthUrl(c.appKey, `${BASE_URL}/api/connect/lazada/callback`) });
});

app.get('/api/connect/lazada/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send(errPage('Lazada', 'Missing authorization code'));
  try {
    const c      = creds.get('lazada');
    const tokens = await lazada.exchangeCode(c.appKey, c.appSecret, code);
    creds.set('lazada', { ...tokens, connectedAt: new Date().toISOString() });
    res.send(okPage('Lazada'));
  } catch (e) {
    res.status(500).send(errPage('Lazada', e.message));
  }
});

// Shopee
app.get('/api/connect/shopee/oauth-url', (req, res) => {
  const c = creds.get('shopee');
  if (!c?.partnerId) return res.status(400).json({ error: 'Save your Shopee Partner ID first' });
  res.json({ url: shopee.buildAuthUrl(c.partnerId, c.partnerKey, `${BASE_URL}/api/connect/shopee/callback`) });
});

app.get('/api/connect/shopee/callback', async (req, res) => {
  const { code, shop_id } = req.query;
  if (!code || !shop_id) return res.status(400).send(errPage('Shopee', 'Missing code or shop_id'));
  try {
    const c      = creds.get('shopee');
    const tokens = await shopee.exchangeCode(c.partnerId, c.partnerKey, code, shop_id);
    creds.set('shopee', { ...tokens, connectedAt: new Date().toISOString() });
    res.send(okPage('Shopee'));
  } catch (e) {
    res.status(500).send(errPage('Shopee', e.message));
  }
});

// TikTok Shop
app.get('/api/connect/tiktok/oauth-url', (req, res) => {
  const c = creds.get('tiktok');
  if (!c?.appKey) return res.status(400).json({ error: 'Save your TikTok App Key first' });
  res.json({ url: tiktok.buildAuthUrl(c.appKey, `${BASE_URL}/api/connect/tiktok/callback`) });
});

app.get('/api/connect/tiktok/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send(errPage('TikTok Shop', 'Missing authorization code'));
  try {
    const c      = creds.get('tiktok');
    const tokens = await tiktok.exchangeCode(c.appKey, c.appSecret, code);
    creds.set('tiktok', { ...tokens, connectedAt: new Date().toISOString() });
    res.send(okPage('TikTok Shop'));
  } catch (e) {
    res.status(500).send(errPage('TikTok Shop', e.message));
  }
});

// Shopify
app.get('/api/connect/shopify/oauth-url', (req, res) => {
  const c = creds.get('shopify');
  if (!c?.shopDomain) return res.status(400).json({ error: 'Save your Shopify shop domain first' });
  if (!c?.apiKey) return res.status(400).json({ error: 'Save your Shopify API Key first' });
  res.json({ url: shopify.buildAuthUrl(c.shopDomain, c.apiKey, `${BASE_URL}/api/connect/shopify/callback`) });
});

app.get('/api/connect/shopify/callback', async (req, res) => {
  const { code, shop } = req.query;
  if (!code) return res.status(400).send(errPage('Shopify', 'Missing authorization code'));
  try {
    const c      = creds.get('shopify');
    const tokens = await shopify.exchangeCode(shop || c.shopDomain, c.apiKey, c.apiSecret, code);
    creds.set('shopify', { ...tokens, connectedAt: new Date().toISOString() });
    res.send(okPage('Shopify'));
  } catch (e) {
    res.status(500).send(errPage('Shopify', e.message));
  }
});

// ── Order Sync ────────────────────────────────────────────────────────────────

app.get('/api/sync/log', (req, res) => res.json(syncLog.recent(100)));

async function syncPlatform(platform, fetchFn, mapFn, opts = {}) {
  const c = creds.get(platform);
  if (!c?.accessToken) throw new Error(`${platform} not connected — save credentials first`);
  const storeName = c.storeName || { lazada: 'Lazada Store', shopee: 'Shopee Store', tiktok: 'TikTok Shop' }[platform];
  const raw       = await fetchFn(c, opts);
  let added = 0;
  for (const item of raw) {
    try { store.addOrder(mapFn(item, storeName)); added++; } catch { /* skip duplicates */ }
  }
  creds.set(platform, { lastSync: new Date().toISOString(), lastSyncCount: added });
  return { platform, at: new Date().toISOString(), fetched: raw.length, added };
}

app.post('/api/sync/lazada', async (req, res) => {
  try {
    const entry = await syncPlatform('lazada', lazada.getOrders, mapper.fromLazada, req.body);
    syncLog.push(entry);
    res.json(entry);
  } catch (e) {
    const entry = { platform: 'lazada', at: new Date().toISOString(), error: e.message };
    syncLog.push(entry);
    res.status(500).json(entry);
  }
});

app.post('/api/sync/shopee', async (req, res) => {
  try {
    const entry = await syncPlatform('shopee', shopee.getOrders, mapper.fromShopee, req.body);
    syncLog.push(entry);
    res.json(entry);
  } catch (e) {
    const entry = { platform: 'shopee', at: new Date().toISOString(), error: e.message };
    syncLog.push(entry);
    res.status(500).json(entry);
  }
});

app.post('/api/sync/tiktok', async (req, res) => {
  try {
    const entry = await syncPlatform('tiktok', tiktok.getOrders, mapper.fromTikTok, req.body);
    syncLog.push(entry);
    res.json(entry);
  } catch (e) {
    const entry = { platform: 'tiktok', at: new Date().toISOString(), error: e.message };
    syncLog.push(entry);
    res.status(500).json(entry);
  }
});

app.post('/api/sync/shopify', async (req, res) => {
  try {
    const entry = await syncPlatform('shopify', shopify.getOrders, mapper.fromShopify, req.body);
    syncLog.push(entry);
    res.json(entry);
  } catch (e) {
    const entry = { platform: 'shopify', at: new Date().toISOString(), error: e.message };
    syncLog.push(entry);
    res.status(500).json(entry);
  }
});

// Sync all connected platforms at once
app.post('/api/sync/all', async (req, res) => {
  const results = await Promise.allSettled([
    syncPlatform('lazada', lazada.getOrders, mapper.fromLazada),
    syncPlatform('shopee', shopee.getOrders, mapper.fromShopee),
    syncPlatform('tiktok', tiktok.getOrders, mapper.fromTikTok),
    syncPlatform('shopify', shopify.getOrders, mapper.fromShopify),
  ]);
  const out = {};
  for (const [i, r] of results.entries()) {
    const p = PLATFORMS[i];
    const entry = r.status === 'fulfilled' ? r.value : { platform: p, at: new Date().toISOString(), error: r.reason.message };
    syncLog.push(entry);
    out[p] = entry;
  }
  res.json(out);
});

// ── Sales Lead Digger — Apollo proxy + persistence ────────────────────────────

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

function getApolloKey() {
  const row = ldb.prepare("SELECT value FROM leads_settings WHERE key='apollo_api_key'").get();
  return row?.value || process.env.APOLLO_API_KEY || '';
}

async function apolloRequest(path, body) {
  const key = getApolloKey();
  if (!key) throw new Error('Apollo API key not set. Connect Apollo from the Lead Digger settings.');
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

// Apollo connection — save/get/delete API key
app.get('/api/leads/apollo-status', (req, res) => {
  const key = getApolloKey();
  res.json({ connected: !!key, masked: key ? key.slice(0, 4) + '••••••••' + key.slice(-4) : null });
});

app.post('/api/leads/apollo-connect', (req, res) => {
  const { api_key } = req.body || {};
  if (!api_key || api_key.trim().length < 8) return res.status(400).json({ error: 'Invalid API key' });
  ldb.prepare("INSERT OR REPLACE INTO leads_settings (key, value) VALUES ('apollo_api_key', ?)").run(api_key.trim());
  res.json({ ok: true });
});

app.delete('/api/leads/apollo-connect', (req, res) => {
  ldb.prepare("DELETE FROM leads_settings WHERE key='apollo_api_key'").run();
  res.json({ ok: true });
});

// Search + auto-save session and all leads to DB
app.post('/api/leads/search', async (req, res) => {
  const { vertical = 'logistics', location = '', seniority = '', size = '', page = 1 } = req.body || {};
  const vp = VERTICAL_PARAMS[vertical];
  if (!vp) return res.status(400).json({ error: 'Unknown vertical. Use "logistics" or "interior".' });

  const payload = {
    per_page: 10,
    page,
    person_titles: vp.person_titles,
    q_organization_keyword_tags: vp.q_organization_keyword_tags,
  };
  if (location)  payload.organization_locations = [location];
  if (seniority) payload.person_seniorities     = [seniority.toLowerCase()];
  if (size)      payload.organization_num_employees_ranges = [size];

  try {
    const data    = await apolloRequest('/mixed_people/api_search', payload);
    const rawList = data.people || [];

    // Create session record
    const sessionId = randomUUID();
    ldb.prepare(`INSERT INTO lead_sessions (id, vertical, location, seniority, company_size, total_found, lead_count)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, vertical, location, seniority, size,
           data.pagination?.total_entries || rawList.length, rawList.length);

    // Upsert each lead (skip if already saved from a previous search)
    const insertLead = ldb.prepare(`
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
        apollo_id:       p.id,
        session_id:      sessionId,
        vertical,
        first_name:      p.first_name || '',
        last_name_masked: p.last_name_obfuscated || p.last_name || '',
        title:           p.title || '',
        company,
        location,
        linkedin_url:    p.linkedin_url || '',
        photo_url:       p.photo_url || '',
        has_email:       p.has_email ? 1 : 0,
        has_phone:       p.has_direct_phone === 'Yes' ? 1 : 0,
      };
      insertLead.run(lead);
      return {
        id:           p.id,
        session_id:   sessionId,
        first_name:   p.first_name || '',
        last_name:    p.last_name_obfuscated || '',
        name:         `${p.first_name || ''} ${p.last_name_obfuscated || ''}`.trim(),
        title:        p.title || '',
        company,
        location,
        linkedin_url: p.linkedin_url || '',
        photo_url:    p.photo_url || '',
        has_email:    !!p.has_email,
        has_phone:    p.has_direct_phone === 'Yes',
        enriched:     false,
        contacted:    false,
      };
    });

    res.json({
      session_id: sessionId,
      people,
      total:       data.pagination?.total_entries || rawList.length,
      vertical,
      description: vp.description,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Enrich a lead — saves email/phone to DB
app.post('/api/leads/enrich', async (req, res) => {
  const { id, first_name, last_name, organization_name } = req.body || {};
  if (!id && !first_name) return res.status(400).json({ error: 'Provide Apollo id or first_name' });
  try {
    const data = await apolloRequest('/people/match', {
      id, first_name, last_name, organization_name,
      reveal_personal_emails: false,
    });
    const p     = data.person || {};
    const email = p.email || '';
    const phone = p.sanitized_phone || p.phone_numbers?.[0]?.sanitized_number || '';

    ldb.prepare(`UPDATE leads SET email=?, phone=?, enriched=1, enriched_at=datetime('now')
                WHERE apollo_id=?`).run(email, phone, id);

    res.json({ email, phone, email_status: p.email_status || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mark a lead as contacted (toggle + timestamp + optional note)
app.patch('/api/leads/:id/contact', (req, res) => {
  const { contacted, contact_note = '', note = '' } = req.body || {};
  const resolvedNote = contact_note || note;
  const now = contacted ? new Date().toISOString() : '';
  ldb.prepare(`UPDATE leads SET contacted=?, contacted_at=?, contact_note=? WHERE apollo_id=?`)
    .run(contacted ? 1 : 0, now, resolvedNote, req.params.id);
  const lead = ldb.prepare('SELECT * FROM leads WHERE apollo_id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json({ ok: true, contacted: !!lead.contacted, contacted_at: lead.contacted_at });
});

// Update contact note on a lead
app.patch('/api/leads/:id/note', (req, res) => {
  const { note = '' } = req.body || {};
  ldb.prepare('UPDATE leads SET contact_note=? WHERE apollo_id=?').run(note, req.params.id);
  res.json({ ok: true });
});

// Get all saved leads (optionally filter by vertical / contacted)
app.get('/api/leads', (req, res) => {
  const { vertical, contacted, session_id } = req.query;
  let sql    = 'SELECT l.*, s.dug_at as session_dug_at FROM leads l JOIN lead_sessions s ON l.session_id=s.id WHERE 1=1';
  const args = [];
  if (vertical)   { sql += ' AND l.vertical=?';   args.push(vertical); }
  if (session_id) { sql += ' AND l.session_id=?'; args.push(session_id); }
  if (contacted !== undefined) { sql += ' AND l.contacted=?'; args.push(contacted === 'true' ? 1 : 0); }
  sql += ' ORDER BY l.dug_at DESC';
  res.json(ldb.prepare(sql).all(...args));
});

// Get all past search sessions
app.get('/api/leads/sessions', (req, res) => {
  res.json(ldb.prepare('SELECT * FROM lead_sessions ORDER BY dug_at DESC').all());
});

// ── IDEALPICK ─────────────────────────────────────────────────────────────────

// Stats
app.get('/api/pick/stats', (req, res) => res.json(pick.getPickStats()));

// Inventory
app.get('/api/pick/inventory', (req, res) => res.json(pick.listInventory()));

app.get('/api/pick/inventory/:sku', (req, res) => {
  const item = pick.getInventoryItem(req.params.sku);
  if (!item) return res.status(404).json({ error: 'SKU not found' });
  res.json(item);
});

app.post('/api/pick/inventory', (req, res) => {
  try { res.status(201).json(pick.upsertInventoryItem(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/pick/inventory/:sku/receive', (req, res) => {
  const { qty, location, received_at } = req.body || {};
  if (!qty || qty <= 0) return res.status(400).json({ error: 'qty must be positive' });
  try { res.json(pick.receiveStock(req.params.sku, qty, location, received_at)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/pick/inventory/:sku', (req, res) => {
  try { res.json(pick.upsertInventoryItem({ ...req.body, sku: req.params.sku })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/pick/inventory/:sku', (req, res) => {
  try { pick.removeInventoryItem(req.params.sku); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Market availability check
app.post('/api/pick/availability', (req, res) => {
  const { orderIds } = req.body || {};
  if (!Array.isArray(orderIds) || !orderIds.length) return res.status(400).json({ error: 'orderIds array required' });
  try { res.json(pick.checkAvailability(orderIds)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Waves
app.get('/api/pick/waves', (req, res) => {
  const { status } = req.query;
  res.json(pick.listWaves(status ? { status } : {}));
});

app.get('/api/pick/waves/:id', (req, res) => {
  const wave = pick.getWave(req.params.id);
  if (!wave) return res.status(404).json({ error: 'Wave not found' });
  res.json(wave);
});

app.post('/api/pick/waves', (req, res) => {
  const { orderIds, strategy, notes, skipUnavailable } = req.body || {};
  try { res.status(201).json(pick.createWave({ orderIds, strategy, notes, skipUnavailable })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/pick/waves/:id/complete', (req, res) => {
  try { res.json(pick.completeWave(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/pick/waves/:id', (req, res) => {
  try { pick.cancelWave(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Tasks
app.patch('/api/pick/tasks/:taskId', (req, res) => {
  try { res.json(pick.updateTask(req.params.taskId, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── IDEALPICK — Pack stage ────────────────────────────────────────────────────

app.get('/api/pack/stats', (req, res) => res.json(pack.getPackStats()));

app.get('/api/pack/orders', (req, res) => {
  const { status, waveId } = req.query;
  res.json(pack.listPackOrders({ status, waveId }));
});

app.get('/api/pack/orders/:id', (req, res) => {
  const po = pack.getPackOrder(req.params.id);
  if (!po) return res.status(404).json({ error: 'Pack order not found' });
  res.json(po);
});

app.post('/api/pack/from-wave/:waveId', (req, res) => {
  try { res.status(201).json(pack.createPackOrdersFromWave(req.params.waveId)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/pack/orders/:id/boxes', (req, res) => {
  try { res.status(201).json(pack.addBox(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/pack/boxes/:boxId', (req, res) => {
  try { res.json(pack.updateBox(req.params.boxId, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/pack/boxes/:boxId/items', (req, res) => {
  try { res.status(201).json(pack.addItemToBox(req.params.boxId, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/pack/orders/:id/complete', (req, res) => {
  try { res.json(pack.completePackOrder(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── IDEALPICK — Ship stage ────────────────────────────────────────────────────

app.get('/api/ship/shipments', (req, res) => {
  const { status } = req.query;
  res.json(pack.listShipments({ status }));
});

app.get('/api/ship/shipments/:id', (req, res) => {
  const s = pack.getShipment(req.params.id);
  if (!s) return res.status(404).json({ error: 'Shipment not found' });
  res.json(s);
});

app.post('/api/ship/from-pack/:packOrderId', (req, res) => {
  try { res.status(201).json(pack.createShipment(req.params.packOrderId, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/ship/shipments/:id', (req, res) => {
  try { res.json(pack.updateShipment(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── IDEALPICK — Print templates (server-rendered HTML) ───────────────────────

app.get('/print/pick/:waveId', (req, res) => {
  try {
    const { wave, tasks } = pack.getPickListData(req.params.waveId);
    res.setHeader('Content-Type', 'text/html');
    res.send(renderPickList(wave, tasks));
  } catch (e) { res.status(404).send(e.message); }
});

app.get('/print/packing-slip/:packOrderId', (req, res) => {
  try {
    const po = pack.getPackingSlipData(req.params.packOrderId);
    if (!po) return res.status(404).send('Pack order not found');
    res.setHeader('Content-Type', 'text/html');
    res.send(renderPackingSlip(po));
  } catch (e) { res.status(404).send(e.message); }
});

app.get('/print/delivery-note/:shipmentId', (req, res) => {
  try {
    const s = pack.getDeliveryNoteData(req.params.shipmentId);
    if (!s) return res.status(404).send('Shipment not found');
    res.setHeader('Content-Type', 'text/html');
    res.send(renderDeliveryNote(s));
  } catch (e) { res.status(404).send(e.message); }
});

// ── Print template renderers ──────────────────────────────────────────────────

const PRINT_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#000;background:#fff;padding:20px}
  h1{font-size:18px;font-weight:900;letter-spacing:-.3px}
  h2{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#444;margin-bottom:6px}
  table{width:100%;border-collapse:collapse}
  th{padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;background:#f3f4f6;border-bottom:2px solid #000}
  td{padding:8px 10px;border-bottom:1px solid #e5e7eb;vertical-align:middle}
  .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #000;padding-bottom:14px;margin-bottom:16px}
  .meta-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
  .meta-box{border:1px solid #d1d5db;border-radius:4px;padding:8px 10px}
  .meta-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;margin-bottom:2px}
  .meta-val{font-size:13px;font-weight:700}
  .section{margin-bottom:18px}
  .badge{display:inline-block;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:700;background:#111;color:#fff}
  .badge-ok{background:#16a34a}
  .badge-short{background:#dc2626}
  .check-col{text-align:center;font-size:16px}
  .loc{font-family:monospace;font-weight:700;font-size:12px}
  .sku{font-family:monospace;font-size:11px;color:#374151}
  .footer{border-top:1px solid #e5e7eb;padding-top:10px;font-size:10px;color:#6b7280;display:flex;justify-content:space-between}
  .barcode{font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;background:#f9fafb;border:1px solid #e5e7eb;padding:4px 8px;border-radius:3px;display:inline-block;margin-top:3px}
  .sign-box{border:1px solid #d1d5db;height:40px;border-radius:4px;margin-top:4px}
  .addr-box{border:1px solid #d1d5db;border-radius:4px;padding:10px 12px;line-height:1.7}
  @media print{
    body{padding:12px}
    button{display:none!important}
    .no-print{display:none!important}
  }
`;

function fmtDt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function fmtD(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}

function renderPickList(wave, tasks) {
  const stratLabel = { fifo:'FIFO — First In, First Out', lifo:'LIFO — Last In, First Out', batch:'Batch Pick', wave:'Wave Pick' }[wave.strategy] || wave.strategy;
  const orderIds   = [...new Set(tasks.map(t => t.order_id))];
  const rows = tasks.map((t, i) => `
    <tr>
      <td style="text-align:center;font-weight:700">${i + 1}</td>
      <td class="loc">${t.location || '—'}</td>
      <td class="sku">${t.sku}</td>
      <td>${t.item_name}</td>
      <td style="text-align:center;font-weight:800">${t.qty_required}</td>
      <td style="text-align:center;font-weight:800">${t.qty_picked || ''}</td>
      <td><span class="badge badge-${t.status === 'picked' ? 'ok' : t.status === 'short' ? 'short' : ''}">${t.status}</span></td>
      <td class="sku" style="font-size:10px">${t.order_id.slice(0, 16)}</td>
      <td class="check-col">☐</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Pick List ${wave.wave_number}</title>
<style>${PRINT_CSS}</style></head><body>
<div class="no-print" style="padding:0 0 14px;display:flex;gap:8px">
  <button onclick="window.print()" style="padding:8px 20px;background:#111;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer">Print</button>
  <button onclick="window.close()" style="padding:8px 16px;border:1px solid #d1d5db;background:#fff;border-radius:6px;font-size:13px;cursor:pointer">Close</button>
</div>
<div class="header">
  <div>
    <h1>PICK LIST</h1>
    <div style="font-size:11px;color:#6b7280;margin-top:3px">IDEALPICK · IdealOMS</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:20px;font-weight:900;letter-spacing:-.5px">${wave.wave_number}</div>
    <div class="barcode">${wave.wave_number}</div>
    <div style="font-size:10px;color:#6b7280;margin-top:4px">${fmtDt(wave.created_at)}</div>
  </div>
</div>
<div class="meta-grid">
  <div class="meta-box"><div class="meta-lbl">Strategy</div><div class="meta-val">${stratLabel}</div></div>
  <div class="meta-box"><div class="meta-lbl">Wave Status</div><div class="meta-val">${wave.status.toUpperCase()}</div></div>
  <div class="meta-box"><div class="meta-lbl">Total Lines</div><div class="meta-val">${tasks.length} tasks · ${orderIds.length} orders</div></div>
</div>
<div class="meta-grid">
  <div class="meta-box"><div class="meta-lbl">Picker Name</div><div class="sign-box"></div></div>
  <div class="meta-box"><div class="meta-lbl">Badge / ID</div><div class="sign-box"></div></div>
  <div class="meta-box"><div class="meta-lbl">Start Time</div><div class="sign-box"></div></div>
</div>
<div class="section">
  <table>
    <thead><tr>
      <th style="width:32px">#</th>
      <th>Location</th><th>SKU</th><th>Description</th>
      <th style="text-align:center">Required</th>
      <th style="text-align:center">Picked</th>
      <th>Status</th><th>Order</th>
      <th style="text-align:center">✓</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
<div class="meta-grid">
  <div class="meta-box"><div class="meta-lbl">Picker Signature</div><div class="sign-box"></div></div>
  <div class="meta-box"><div class="meta-lbl">Supervisor Check</div><div class="sign-box"></div></div>
  <div class="meta-box"><div class="meta-lbl">Completed Time</div><div class="sign-box"></div></div>
</div>
<div class="footer"><span>Wave: ${wave.wave_number} · Strategy: ${wave.strategy.toUpperCase()} · Generated: ${fmtDt(new Date().toISOString())}</span><span>IdealOMS · IDEALPICK</span></div>
</body></html>`;
}

function renderPackingSlip(po) {
  const ship   = po.shipping || {};
  const boxes  = po.boxes || [];
  const items  = po.pickedItems || [];

  const boxRows = boxes.map(b => {
    const bItems = (b.items || []).map(i => `${i.qty}× ${i.item_name} (${i.sku})`).join(', ') || '—';
    const dims   = [b.length_cm, b.width_cm, b.height_cm].every(v => v > 0)
      ? `${b.length_cm}×${b.width_cm}×${b.height_cm} cm`
      : '—';
    return `<tr>
      <td style="font-weight:700">Box ${b.box_number}</td>
      <td class="sku">${b.sscc || '—'}</td>
      <td>${dims}</td>
      <td>${b.weight_kg > 0 ? b.weight_kg + ' kg' : '—'}</td>
      <td style="font-size:11px">${bItems}</td>
    </tr>`;
  }).join('');

  const itemRows = items.map(i => `<tr>
    <td class="sku">${i.sku}</td>
    <td>${i.item_name}</td>
    <td style="text-align:center">${i.qty_required}</td>
    <td style="text-align:center">${i.qty_picked}</td>
    <td style="text-align:center">${i.qty_picked >= i.qty_required ? '<span class="badge badge-ok">FULL</span>' : '<span class="badge badge-short">SHORT</span>'}</td>
  </tr>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Packing Slip ${po.pack_number}</title>
<style>${PRINT_CSS}</style></head><body>
<div class="no-print" style="padding:0 0 14px;display:flex;gap:8px">
  <button onclick="window.print()" style="padding:8px 20px;background:#111;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer">Print</button>
  <button onclick="window.close()" style="padding:8px 16px;border:1px solid #d1d5db;background:#fff;border-radius:6px;font-size:13px;cursor:pointer">Close</button>
</div>
<div class="header">
  <div>
    <h1>PACKING SLIP</h1>
    <div style="font-size:11px;color:#6b7280;margin-top:3px">IDEALPICK · IdealOMS</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:18px;font-weight:900">${po.pack_number}</div>
    <div class="barcode">${po.pack_number}</div>
    <div style="font-size:10px;color:#6b7280;margin-top:4px">${fmtDt(po.created_at)}</div>
  </div>
</div>
<div class="meta-grid">
  <div class="meta-box"><div class="meta-lbl">Order Reference</div><div class="meta-val">${po.order_id}</div></div>
  <div class="meta-box"><div class="meta-lbl">Client</div><div class="meta-val">${po.client_name}</div></div>
  <div class="meta-box"><div class="meta-lbl">Status</div><div class="meta-val">${po.status.toUpperCase()}</div></div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
  <div>
    <h2>Ship To</h2>
    <div class="addr-box">
      <strong>${ship.recipient || '—'}</strong><br>
      ${ship.addressLine1 || ''}${ship.addressLine2 ? ', ' + ship.addressLine2 : ''}<br>
      ${[ship.city, ship.state, ship.zip].filter(Boolean).join(', ')}<br>
      ${ship.country || ''}
    </div>
  </div>
  <div>
    <h2>Pack Summary</h2>
    <div class="addr-box">
      <div>Boxes: <strong>${boxes.length}</strong></div>
      <div>Total Weight: <strong>${boxes.reduce((s,b) => s + (b.weight_kg||0), 0).toFixed(2)} kg</strong></div>
      <div>Wave: <strong>${po.wave_id.slice(0, 8)}…</strong></div>
      ${po.packed_at ? `<div>Packed: <strong>${fmtD(po.packed_at)}</strong></div>` : ''}
    </div>
  </div>
</div>
<div class="section">
  <h2>Items Picked</h2>
  <table>
    <thead><tr><th>SKU</th><th>Description</th><th style="text-align:center">Ordered</th><th style="text-align:center">Picked</th><th style="text-align:center">Status</th></tr></thead>
    <tbody>${itemRows || '<tr><td colspan="5" style="text-align:center;color:#6b7280">No items</td></tr>'}</tbody>
  </table>
</div>
${boxes.length ? `<div class="section">
  <h2>Carton / Box Detail (GS1 SSCC)</h2>
  <table>
    <thead><tr><th>Box</th><th>SSCC</th><th>Dimensions</th><th>Weight</th><th>Contents</th></tr></thead>
    <tbody>${boxRows}</tbody>
  </table>
</div>` : ''}
${po.orderNotes ? `<div class="section"><h2>Order Notes</h2><div style="border:1px solid #fde047;background:#fefce8;border-radius:4px;padding:9px 12px;font-size:12px">${po.orderNotes}</div></div>` : ''}
<div class="meta-grid" style="margin-top:14px">
  <div class="meta-box"><div class="meta-lbl">Packer Signature</div><div class="sign-box"></div></div>
  <div class="meta-box"><div class="meta-lbl">QC Check</div><div class="sign-box"></div></div>
  <div class="meta-box"><div class="meta-lbl">Handoff Time</div><div class="sign-box"></div></div>
</div>
<div class="footer"><span>Pack Ref: ${po.pack_number} · Order: ${po.order_id} · ${fmtDt(new Date().toISOString())}</span><span>IdealOMS · IDEALPICK</span></div>
</body></html>`;
}

function renderDeliveryNote(s) {
  const po   = s.packOrder || {};
  const boxes = po.boxes || [];
  const items = po.pickedItems || [];
  const ship  = po.shipping || {};

  const itemRows = items.map(i => `<tr>
    <td class="sku">${i.sku}</td>
    <td>${i.item_name}</td>
    <td style="text-align:center">${i.qty_picked}</td>
  </tr>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Delivery Note ${s.shipment_number}</title>
<style>${PRINT_CSS}</style></head><body>
<div class="no-print" style="padding:0 0 14px;display:flex;gap:8px">
  <button onclick="window.print()" style="padding:8px 20px;background:#111;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer">Print</button>
  <button onclick="window.close()" style="padding:8px 16px;border:1px solid #d1d5db;background:#fff;border-radius:6px;font-size:13px;cursor:pointer">Close</button>
</div>
<div class="header">
  <div>
    <h1>DELIVERY NOTE</h1>
    <div style="font-size:11px;color:#6b7280;margin-top:3px">IDEALPICK · IdealOMS</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:18px;font-weight:900">${s.shipment_number}</div>
    <div class="barcode">${s.shipment_number}</div>
    ${s.tracking_no ? `<div style="margin-top:4px"><span style="font-size:10px;color:#6b7280">Tracking: </span><strong>${s.tracking_no}</strong></div>` : ''}
  </div>
</div>
<div class="meta-grid">
  <div class="meta-box"><div class="meta-lbl">Order Reference</div><div class="meta-val">${s.order_id}</div></div>
  <div class="meta-box"><div class="meta-lbl">Pack Reference</div><div class="meta-val">${s.pack_order_id.slice(0, 8)}…</div></div>
  <div class="meta-box"><div class="meta-lbl">Shipment Date</div><div class="meta-val">${s.shipped_at ? fmtD(s.shipped_at) : 'Pending'}</div></div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
  <div>
    <h2>Deliver To</h2>
    <div class="addr-box">
      <strong>${s.recipient_name || ship.recipient || '—'}</strong><br>
      ${s.address_line1 || ship.addressLine1 || ''}${s.address_line2 ? ', ' + s.address_line2 : ''}<br>
      ${[s.city, s.state_region, s.zip].filter(Boolean).join(', ')}<br>
      ${s.country || ''}
    </div>
  </div>
  <div>
    <h2>Carrier Details</h2>
    <div class="addr-box">
      <div>Carrier: <strong>${s.carrier || '—'}</strong></div>
      <div>Service: <strong>${s.service || '—'}</strong></div>
      <div>Tracking: <strong>${s.tracking_no || '—'}</strong></div>
      <div>Est. Delivery: <strong>${s.est_delivery ? fmtD(s.est_delivery) : '—'}</strong></div>
      <div>Boxes: <strong>${s.box_count}</strong> · Weight: <strong>${s.weight_kg.toFixed(2)} kg</strong></div>
    </div>
  </div>
</div>
<div class="section">
  <h2>Contents</h2>
  <table>
    <thead><tr><th>SKU</th><th>Description</th><th style="text-align:center">Qty</th></tr></thead>
    <tbody>${itemRows || '<tr><td colspan="3" style="text-align:center;color:#6b7280">No items</td></tr>'}</tbody>
  </table>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px">
  <div class="meta-box">
    <div class="meta-lbl">Received By (Customer)</div>
    <div class="sign-box"></div>
    <div style="font-size:10px;color:#6b7280;margin-top:4px">Name &amp; Signature</div>
  </div>
  <div class="meta-box">
    <div class="meta-lbl">Received Date &amp; Time</div>
    <div class="sign-box"></div>
  </div>
</div>
${s.notes ? `<div class="section" style="margin-top:14px"><h2>Notes</h2><div style="border:1px solid #e5e7eb;border-radius:4px;padding:9px 12px">${s.notes}</div></div>` : ''}
<div class="footer"><span>Shipment: ${s.shipment_number} · Order: ${s.order_id} · ${fmtDt(new Date().toISOString())}</span><span>IdealOMS · IDEALPICK</span></div>
</body></html>`;
}

// ── Webhooks (for real-time push from Shopee / Lazada) ────────────────────────

app.post('/webhook/shopee', (req, res) => {
  // TODO: verify HMAC signature before processing
  const { code, data } = req.body || {};
  // code 3 = ORDER_STATUS_UPDATE, 15 = ORDER_TRACKING_NUMBER_UPDATE, etc.
  res.json({ ok: true });
});

app.post('/webhook/lazada', (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  IdealOMS ready → ${url}\n`);
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd);
});
