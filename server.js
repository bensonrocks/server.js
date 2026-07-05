'use strict';

const express = require('express');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const session = require('express-session');

const users                         = require('./lib/users');
const orders                        = require('./lib/orders');
const organizations                 = require('./lib/organizations');
const { PROVIDERS }                 = require('./lib/providers');
const { init: initDb, hasDb, pool } = require('./lib/db');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionStore = hasDb
  ? new (require('connect-pg-simple')(session))({ pool, createTableIfMissing: true })
  : undefined;

if (!process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET not set — sessions will not survive restarts. Set it in Railway env vars.');
}

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'dev-only-secret-set-SESSION_SECRET-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

// ── Auth helpers ───────────────────────────────────────────────────────
// Every authenticated request is scoped to req.session.organizationId (the
// tenant) — orders/billing/team all read and write against that, never the
// individual user id, so any teammate in the org sees the same data.
function requireAuth(req, res, next) {
  if (!req.session.userId || !req.session.organizationId)
    return res.status(401).json({ ok: false, error: 'Not authenticated' });
  next();
}

function requireAuthPage(req, res, next) {
  if (!req.session.userId || !req.session.organizationId) return res.redirect('/login');
  next();
}

async function requireOwner(req, res, next) {
  const user = await users.findById(req.session.userId);
  if (!user || user.role !== 'owner')
    return res.status(403).json({ ok: false, error: 'Only the organization owner can do this' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ── SEO ────────────────────────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /billing\nDisallow: /settings\nDisallow: /ops-console\nDisallow: /api/\nSitemap: ${base}/sitemap.xml`
  );
});

app.get('/sitemap.xml', (req, res) => {
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const today = new Date().toISOString().split('T')[0];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><lastmod>${today}</lastmod><priority>1.0</priority></url>
  <url><loc>${base}/signup</loc><lastmod>${today}</lastmod><priority>0.7</priority></url>
</urlset>`);
});

// ── HTML page routes (defined before static so / is not hijacked) ──────
app.get('/',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/login',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/dashboard',   requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/billing',     requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'billing.html')));
app.get('/settings',    requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/ops-console', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ops.html')));

// ── Static assets ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth API ───────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password, company } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ ok: false, error: 'All fields required' });
  if (password.length < 8)
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  if (await users.findByEmail(email))
    return res.status(409).json({ ok: false, error: 'Email already registered — please sign in' });

  const org = await organizations.create(company || `${name}'s Organization`);
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await users.create({
    name, email, passwordHash, company,
    organizationId: org.id, role: 'owner',
  });
  req.session.userId = user.id;
  req.session.organizationId = org.id;
  res.json({ ok: true, user: safeUser(user), organization: org });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ ok: false, error: 'Email and password required' });
  const user = await users.findByEmail(email);
  if (!user) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
  req.session.userId = user.id;
  req.session.organizationId = user.organizationId;
  res.json({ ok: true, user: safeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.json({ ok: true, user: null });
  const user = await users.findById(req.session.userId);
  if (!user) return res.json({ ok: true, user: null });
  const org = await organizations.findById(user.organizationId);
  res.json({ ok: true, user: safeUser(user), organization: org });
});

app.post('/api/account/update', requireAuth, async (req, res) => {
  const { name } = req.body;
  const patch = {};
  if (name) patch.name = name;
  const updated = await users.update(req.session.userId, patch);
  if (!updated) return res.status(404).json({ ok: false, error: 'Account not found' });
  res.json({ ok: true, user: safeUser(updated) });
});

function safeUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, organizationId: u.organizationId, createdAt: u.createdAt };
}

// ── Organization / Team API ──────────────────────────────────────────────
app.patch('/api/organization', requireAuth, requireOwner, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'Organization name is required' });
  const updated = await organizations.update(req.session.organizationId, { name });
  if (!updated) return res.status(404).json({ ok: false, error: 'Organization not found' });
  res.json({ ok: true, organization: updated });
});

app.get('/api/team', requireAuth, async (req, res) => {
  const [org, members, me] = await Promise.all([
    organizations.findById(req.session.organizationId),
    users.listByOrganization(req.session.organizationId),
    users.findById(req.session.userId),
  ]);
  res.json({
    ok: true,
    organization: org,
    members: members.map(m => ({ id: m.id, name: m.name, email: m.email, role: m.role, createdAt: m.createdAt })),
    isOwner: me?.role === 'owner',
  });
});

app.post('/api/team', requireAuth, requireOwner, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ ok: false, error: 'Name, email and password are required' });
  if (password.length < 8)
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  if (await users.findByEmail(email))
    return res.status(409).json({ ok: false, error: 'That email is already registered' });

  const passwordHash = await bcrypt.hash(password, 12);
  const member = await users.create({
    name, email, passwordHash,
    organizationId: req.session.organizationId, role: 'member',
  });
  res.json({ ok: true, member: { id: member.id, name: member.name, email: member.email, role: member.role, createdAt: member.createdAt } });
});

app.delete('/api/team/:id', requireAuth, requireOwner, async (req, res) => {
  if (req.params.id === req.session.userId)
    return res.status(400).json({ ok: false, error: "You can't remove yourself" });
  const target = await users.findById(req.params.id);
  if (!target || target.organizationId !== req.session.organizationId)
    return res.status(404).json({ ok: false, error: 'Team member not found' });
  if (target.role === 'owner')
    return res.status(400).json({ ok: false, error: "The organization owner can't be removed" });
  await users.deleteUser(req.params.id);
  res.json({ ok: true });
});

// ── Providers / network API ─────────────────────────────────────────────
app.get('/api/providers', requireAuth, (req, res) => {
  res.json({ ok: true, providers: PROVIDERS });
});

// ── Orders API (client) ──────────────────────────────────────────────────
app.post('/api/orders', requireAuth, async (req, res) => {
  const { recipientName, addressLine1, city, region, postalCode, country, items, serviceLevel, notes } = req.body;
  if (!recipientName || !addressLine1 || !city || !country)
    return res.status(400).json({ ok: false, error: 'Recipient name, address, city and country are required' });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ ok: false, error: 'At least one order item is required' });
  for (const it of items) {
    if (!it.description || !it.weightKg || Number(it.weightKg) <= 0)
      return res.status(400).json({ ok: false, error: 'Each item needs a description and weight in kg' });
  }

  try {
    const order = await orders.create(req.session.organizationId, req.session.userId, {
      recipientName, addressLine1, city, region, postalCode, country, items, serviceLevel, notes,
    });
    res.json({ ok: true, order });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/orders', requireAuth, async (req, res) => {
  const list = await orders.listByOrganization(req.session.organizationId);
  res.json({ ok: true, orders: list });
});

app.get('/api/orders/:id', requireAuth, async (req, res) => {
  const order = await orders.findById(req.params.id);
  if (!order || order.organizationId !== req.session.organizationId)
    return res.status(404).json({ ok: false, error: 'Order not found' });
  res.json({ ok: true, order });
});

// ── Billing API (client) ─────────────────────────────────────────────────
app.get('/api/billing/summary', requireAuth, async (req, res) => {
  const list = await orders.listByOrganization(req.session.organizationId);
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const byMonth = {};
  for (const o of list) {
    const d = new Date(o.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth[key]) byMonth[key] = { month: key, total: 0, count: 0 };
    byMonth[key].total += o.priceTotal;
    byMonth[key].count += 1;
  }

  const months = Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month));
  const current = byMonth[currentMonthKey] || { month: currentMonthKey, total: 0, count: 0 };
  const lifetimeTotal = list.reduce((sum, o) => sum + o.priceTotal, 0);

  res.json({
    ok: true,
    currentMonth: { month: current.month, total: Math.round(current.total * 100) / 100, count: current.count },
    lifetime: { total: Math.round(lifetimeTotal * 100) / 100, count: list.length },
    months: months.map(m => ({ ...m, total: Math.round(m.total * 100) / 100 })),
    currency: 'USD',
  });
});

app.get('/api/billing/invoice/:month', requireAuth, async (req, res) => {
  const month = req.params.month; // YYYY-MM
  if (!/^\d{4}-\d{2}$/.test(month))
    return res.status(400).json({ ok: false, error: 'Invalid month format, expected YYYY-MM' });

  const list = await orders.listByOrganization(req.session.organizationId);
  const filtered = list.filter(o => {
    const d = new Date(o.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return key === month;
  });
  const total = filtered.reduce((sum, o) => sum + o.priceTotal, 0);

  res.json({ ok: true, month, orders: filtered, total: Math.round(total * 100) / 100, currency: 'USD' });
});

// ── Ops console API (staff) ──────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const secret = process.env.OPS_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: 'Ops console not configured' });
  if (req.body.password !== secret)
    return res.status(401).json({ ok: false, error: 'Wrong access key' });
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});

app.get('/api/admin/organizations', requireAdmin, async (req, res) => {
  const [allUsers, allOrders] = await Promise.all([users.findAll(), orders.listAll()]);

  const byOrg = {};
  for (const u of allUsers) {
    if (!u.organizationId) continue;
    if (!byOrg[u.organizationId]) byOrg[u.organizationId] = { members: [], totalOrders: 0, totalSpend: 0 };
    byOrg[u.organizationId].members.push({ id: u.id, name: u.name, email: u.email, role: u.role });
  }
  for (const o of allOrders) {
    if (!byOrg[o.organizationId]) byOrg[o.organizationId] = { members: [], totalOrders: 0, totalSpend: 0 };
    byOrg[o.organizationId].totalOrders += 1;
    byOrg[o.organizationId].totalSpend += o.priceTotal;
  }

  const orgIds = Object.keys(byOrg);
  const orgRecords = await Promise.all(orgIds.map(id => organizations.findById(id)));
  const result = orgIds.map((id, i) => ({
    id,
    name: orgRecords[i]?.name || 'Unknown',
    createdAt: orgRecords[i]?.createdAt,
    members: byOrg[id].members,
    totalOrders: byOrg[id].totalOrders,
    totalSpend: Math.round(byOrg[id].totalSpend * 100) / 100,
  })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ ok: true, organizations: result });
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const allOrders = await orders.listAll();
  const orgIds = [...new Set(allOrders.map(o => o.organizationId))];
  const orgRecords = await Promise.all(orgIds.map(id => organizations.findById(id)));
  const orgsById = Object.fromEntries(orgIds.map((id, i) => [id, orgRecords[i]]));

  const enriched = allOrders.map(o => ({
    ...o,
    organizationName: orgsById[o.organizationId]?.name || 'Unknown',
  }));
  res.json({ ok: true, orders: enriched });
});

app.post('/api/admin/orders/:id/status', requireAdmin, async (req, res) => {
  const { status, trackingNumber, carrier, note } = req.body;
  if (status && !orders.STATUSES.includes(status))
    return res.status(400).json({ ok: false, error: 'Invalid status' });
  const updated = await orders.updateStatus(req.params.id, { status, trackingNumber, carrier, note });
  if (!updated) return res.status(404).json({ ok: false, error: 'Order not found' });
  res.json({ ok: true, order: updated });
});

// ── Start ──────────────────────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CirroSys running on port ${PORT}`);
      console.log(`DB: ${hasDb ? 'PostgreSQL' : 'JSON file'}`);
      console.log(`Ops console: ${process.env.OPS_SECRET ? 'configured' : 'NOT configured — set OPS_SECRET'}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialise database:', err.message);
    process.exit(1);
  });
