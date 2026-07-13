'use strict';

const express = require('express');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const session = require('express-session');
const multer  = require('multer');

const staff                         = require('./lib/users');
const { init: initDb, hasDb, pool } = require('./lib/db');
const inbounds                      = require('./lib/inbounds');

const app  = express();
const PORT = process.env.IDEALINBOUND_PORT || 4000;

// ── Photo upload (in-memory, persisted to Postgres/JSON as bytes) ──────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image uploads are allowed'));
    cb(null, true);
  },
});
function uploadPhoto(fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, err => {
      if (err) return res.status(400).json({ ok: false, error: err.message });
      next();
    });
  };
}

// ── Middleware ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionStore = hasDb
  ? new (require('connect-pg-simple')(session))({
      pool,
      tableName: 'idealinbound_sessions',
      createTableIfMissing: true,
    })
  : undefined;

if (!process.env.IDEALINBOUND_SESSION_SECRET) {
  console.warn('WARNING: IDEALINBOUND_SESSION_SECRET not set — sessions will not survive restarts.');
}

app.use(session({
  name: 'idealinbound.sid',
  store: sessionStore,
  secret: process.env.IDEALINBOUND_SESSION_SECRET || 'dev-only-secret-set-IDEALINBOUND_SESSION_SECRET-in-prod',
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
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  next();
}

function requireAuthPage(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function safeUser(u) {
  return { id: u.id, name: u.name, email: u.email };
}

// ── Pages ──────────────────────────────────────────────────────────────
app.get('/',        (req, res) => res.redirect(req.session.userId ? '/inbound' : '/login'));
app.get('/login',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/inbound', requireAuthPage, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'inbound.html'))
);

app.use(express.static(path.join(__dirname, 'public')));

// ── Auth API ───────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ ok: false, error: 'All fields required' });
  if (password.length < 8)
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  if (await staff.findByEmail(email))
    return res.status(409).json({ ok: false, error: 'Email already registered — please sign in' });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await staff.create({ name, email, passwordHash });
  req.session.userId = user.id;
  res.json({ ok: true, user: safeUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ ok: false, error: 'Email and password required' });
  const user = await staff.findByEmail(email);
  if (!user) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
  req.session.userId = user.id;
  res.json({ ok: true, user: safeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.json({ ok: true, user: null });
  const user = await staff.findById(req.session.userId);
  res.json({ ok: true, user: user ? safeUser(user) : null });
});

// ── Inbound processing API ───────────────────────────────────────────
app.get('/api/inbound-types', requireAuth, (req, res) => {
  res.json({ ok: true, types: inbounds.TYPES, conditions: inbounds.CONDITIONS });
});

app.get('/api/inbounds', requireAuth, async (req, res) => {
  const { type } = req.query;
  if (type && !inbounds.TYPES.includes(type))
    return res.status(400).json({ ok: false, error: 'Invalid type filter' });
  const list = await inbounds.listInbounds({ type });
  res.json({ ok: true, inbounds: list });
});

app.post('/api/inbounds', requireAuth, async (req, res) => {
  const { type, reference, source, expectedDate, metadata, items } = req.body;
  if (!inbounds.TYPES.includes(type))
    return res.status(400).json({ ok: false, error: `Type must be one of: ${inbounds.TYPES.join(', ')}` });
  if (!reference || !source)
    return res.status(400).json({ ok: false, error: 'Reference and source are required' });
  const lines = Array.isArray(items) ? items : [];
  for (const it of lines) {
    if (!it.sku || !Number(it.expectedQty) || Number(it.expectedQty) <= 0)
      return res.status(400).json({ ok: false, error: 'Each pre-declared line needs a SKU and expected quantity > 0' });
  }
  const inbound = await inbounds.createInbound({
    type, reference, source, expectedDate,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    items: lines, createdBy: req.session.userId,
  });
  res.json({ ok: true, inbound });
});

app.get('/api/inbounds/:id', requireAuth, async (req, res) => {
  const inbound = await inbounds.getInbound(req.params.id);
  if (!inbound) return res.status(404).json({ ok: false, error: 'Inbound not found' });
  res.json({ ok: true, inbound });
});

app.post('/api/inbounds/:id/receive', requireAuth, uploadPhoto('photo'), async (req, res) => {
  const { sku, qty, condition, description, caption } = req.body;
  if (!sku || !Number(qty) || Number(qty) <= 0)
    return res.status(400).json({ ok: false, error: 'SKU and quantity > 0 are required' });
  const result = await inbounds.receiveItem(req.params.id, {
    sku, qty, condition, description, receivedBy: req.session.userId,
  });
  if (!result) return res.status(404).json({ ok: false, error: 'Inbound not found' });
  if (req.file) {
    await inbounds.addPhoto(req.params.id, {
      itemId: result.lastItemId,
      eventId: result.lastEventId,
      caption,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      uploadedBy: req.session.userId,
    });
  }
  const inbound = await inbounds.getInbound(req.params.id);
  res.json({ ok: true, inbound });
});

app.post('/api/inbounds/:id/close', requireAuth, async (req, res) => {
  const inbound = await inbounds.closeInbound(req.params.id);
  if (!inbound) return res.status(404).json({ ok: false, error: 'Inbound not found' });
  res.json({ ok: true, inbound });
});

// ── Cartons — a shipment or return often arrives across more than one box ──
const CARTON_ERROR_STATUS = { not_found: 404, empty_carton: 400, carton_not_found: 404, not_split: 400 };
const CARTON_ERROR_MESSAGE = {
  not_found: 'Inbound not found',
  empty_carton: 'Current carton is empty — receive at least one item before starting a new one.',
  carton_not_found: 'Carton not found',
  not_split: 'This inbound was never split into multiple cartons.',
};
function cartonResult(res, result) {
  if (result.error) return res.status(CARTON_ERROR_STATUS[result.error] || 400).json({ ok: false, error: CARTON_ERROR_MESSAGE[result.error] });
  res.json({ ok: true, inbound: result.inbound });
}

app.post('/api/inbounds/:id/new-carton', requireAuth, async (req, res) => {
  cartonResult(res, await inbounds.startNewCarton(req.params.id));
});
app.post('/api/inbounds/:id/carton/switch', requireAuth, async (req, res) => {
  const num = parseInt(req.body.num, 10);
  if (!num || num < 1) return res.status(400).json({ ok: false, error: 'num required' });
  cartonResult(res, await inbounds.switchCarton(req.params.id, num));
});
app.post('/api/inbounds/:id/carton/cancel-multi', requireAuth, async (req, res) => {
  cartonResult(res, await inbounds.cancelMultiCarton(req.params.id));
});
app.post('/api/inbounds/:id/carton/label-confirmed', requireAuth, async (req, res) => {
  const num = parseInt(req.body.num, 10) || 1;
  cartonResult(res, await inbounds.confirmCartonLabel(req.params.id, num));
});

app.get('/api/inbounds/:id/report', requireAuth, async (req, res) => {
  const inbound = await inbounds.getInbound(req.params.id);
  if (!inbound) return res.status(404).json({ ok: false, error: 'Inbound not found' });
  const items = inbound.items.map(i => ({ ...i, variance: i.receivedQty - i.expectedQty }));
  res.json({ ok: true, report: { ...inbound, items } });
});

// ── Photos ─────────────────────────────────────────────────────────────
app.post('/api/inbounds/:id/photos', requireAuth, uploadPhoto('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Photo file is required' });
  const existing = await inbounds.getInbound(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Inbound not found' });
  const photo = await inbounds.addPhoto(req.params.id, {
    itemId: req.body.itemId || null,
    caption: req.body.caption,
    buffer: req.file.buffer,
    mimeType: req.file.mimetype,
    uploadedBy: req.session.userId,
  });
  res.json({ ok: true, photo });
});

app.get('/api/inbounds/:id/photos/:photoId', requireAuth, async (req, res) => {
  const photo = await inbounds.getPhotoData(req.params.id, req.params.photoId);
  if (!photo) return res.status(404).send('Not found');
  res.set('Content-Type', photo.mimeType);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(photo.buffer);
});

// ── Start ──────────────────────────────────────────────────────────────
initDb()
  .then(() => inbounds.init())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`IdealInbound running on port ${PORT}`);
      console.log(`DB: ${hasDb ? 'PostgreSQL' : 'JSON file'}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialise database:', err.message);
    process.exit(1);
  });
