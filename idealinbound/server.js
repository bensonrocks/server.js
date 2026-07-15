'use strict';

const express = require('express');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const session = require('express-session');
const multer  = require('multer');
const ExcelJS = require('exceljs');

const staff                         = require('./lib/users');
const { init: initDb, hasDb, pool } = require('./lib/db');
const inbounds                      = require('./lib/inbounds');
const { initSerials }               = require('./lib/serials');
const auditLog                      = require('./lib/auditLog');
const photoToken                    = require('./lib/photoToken');
const { parseInboundFile, findDuplicateLineWarnings } = require('./lib/fileParser');

const app  = express();
const PORT = process.env.IDEALINBOUND_PORT || 4000;
const { InboundError } = inbounds;

// ── Uploads (in-memory) ─────────────────────────────────────────────────
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

const uploadFileMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (!['csv', 'xlsx', 'xls', 'pdf'].includes(ext)) return cb(new Error('Upload an XLSX, CSV, or PDF file'));
    cb(null, true);
  },
});
function uploadInboundFile(fieldName) {
  return (req, res, next) => {
    uploadFileMw.single(fieldName)(req, res, err => {
      if (err) return res.status(400).json({ ok: false, error: err.message });
      next();
    });
  };
}

function parseJsonField(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
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
if (!process.env.IDEALINBOUND_MASTER_SECRET) {
  console.warn('WARNING: IDEALINBOUND_MASTER_SECRET not set — master-level deletion approval is disabled.');
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

async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const user = await staff.findById(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin role required' });
  next();
}

function requireMaster(req, res, next) {
  if (!req.session.isMaster) return res.status(401).json({ ok: false, error: 'Master login required' });
  next();
}

function safeUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

function handleInboundError(res, err, fallbackMsg) {
  if (err instanceof InboundError) {
    const statusByCode = { ALREADY_COMPLETED: 409, ALREADY_PENDING: 409 };
    return res.status(statusByCode[err.code] || 400).json({ ok: false, error: err.message, code: err.code });
  }
  console.error(fallbackMsg, err);
  return res.status(500).json({ ok: false, error: fallbackMsg });
}

// ── Pages ──────────────────────────────────────────────────────────────
app.get('/',        (req, res) => res.redirect(req.session.userId ? '/inbound' : '/login'));
app.get('/login',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/inbound', requireAuthPage, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'inbound.html'))
);
app.get('/admin', requireAuthPage, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);
app.get('/master', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'master.html'))
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

app.get('/api/photo-token', requireAuth, (req, res) => {
  res.json({ ok: true, token: photoToken.sign(req.session.userId) });
});

// ── Admin: staff / roles ─────────────────────────────────────────────
app.get('/api/admin/staff', requireAuth, requireAdmin, async (req, res) => {
  res.json({ ok: true, staff: await staff.listAll() });
});

app.post('/api/admin/staff/:id/role', requireAuth, requireAdmin, async (req, res) => {
  const { role } = req.body;
  if (!['admin', 'warehouse'].includes(role))
    return res.status(400).json({ ok: false, error: "Role must be 'admin' or 'warehouse'" });
  const updated = await staff.updateRole(req.params.id, role);
  if (!updated) return res.status(404).json({ ok: false, error: 'Staff member not found' });
  res.json({ ok: true, staff: updated });
});

// ── Master login (approves inbound deletion requests) ──────────────────
app.post('/api/master/login', (req, res) => {
  const secret = process.env.IDEALINBOUND_MASTER_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: 'Master login not configured' });
  if (req.body.secret !== secret) return res.status(401).json({ ok: false, error: 'Wrong master secret' });
  req.session.isMaster = true;
  res.json({ ok: true });
});
app.post('/api/master/logout', (req, res) => {
  req.session.isMaster = false;
  res.json({ ok: true });
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

app.post('/api/inbounds', requireAuth, uploadInboundFile('file'), async (req, res) => {
  const { type, reference, source, expectedDate } = req.body;
  const metadata = parseJsonField(req.body.metadata, {});
  if (!inbounds.TYPES.includes(type))
    return res.status(400).json({ ok: false, error: `Type must be one of: ${inbounds.TYPES.join(', ')}` });
  if (!reference || !source)
    return res.status(400).json({ ok: false, error: 'Reference and source are required' });

  let lines = [];
  let warnings = [];
  if (req.file) {
    try {
      lines = await parseInboundFile(req.file.buffer, req.file.originalname);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    warnings = findDuplicateLineWarnings(lines);
  } else {
    lines = parseJsonField(req.body.items, []);
    if (!Array.isArray(lines)) lines = [];
    for (const it of lines) {
      if (!it.sku || !Number(it.expectedQty) || Number(it.expectedQty) <= 0)
        return res.status(400).json({ ok: false, error: 'Each pre-declared line needs a SKU and expected quantity > 0' });
    }
    warnings = findDuplicateLineWarnings(lines);
  }

  const inbound = await inbounds.createInbound({
    type, reference, source, expectedDate,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    items: lines, createdBy: req.session.userId,
  });
  await auditLog.logAudit('inbound_created', {
    inboundId: inbound.id, actor: req.session.userId,
    serial: inbound.serial, type, reference, source, lineCount: lines.length, viaFile: !!req.file,
  });
  res.json({ ok: true, inbound, warnings });
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
  await auditLog.logAudit('inbound_scan', {
    inboundId: req.params.id, actor: req.session.userId,
    sku, qty: Number(qty), condition: condition || 'unspecified',
  });
  const inbound = await inbounds.getInbound(req.params.id);
  res.json({ ok: true, inbound });
});

app.post('/api/inbounds/:id/close', requireAuth, async (req, res) => {
  const force = req.body.force === true || req.body.force === 'true';
  const result = await inbounds.closeInbound(req.params.id, { force });
  if (!result) return res.status(404).json({ ok: false, error: 'Inbound not found' });
  if (result.needsConfirm) {
    return res.status(409).json({ ok: false, needsConfirm: true, mismatches: result.mismatches, extras: result.extras });
  }
  await auditLog.logAudit('inbound_end_receipt', {
    inboundId: req.params.id, actor: req.session.userId,
    forced: force, mismatches: result.mismatches, extras: result.extras,
  });
  res.json({ ok: true, inbound: result });
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
  const result = await inbounds.startNewCarton(req.params.id);
  if (!result.error) await auditLog.logAudit('inbound_carton_started', { inboundId: req.params.id, actor: req.session.userId });
  cartonResult(res, result);
});
app.post('/api/inbounds/:id/carton/switch', requireAuth, async (req, res) => {
  const num = parseInt(req.body.num, 10);
  if (!num || num < 1) return res.status(400).json({ ok: false, error: 'num required' });
  const result = await inbounds.switchCarton(req.params.id, num);
  if (!result.error) await auditLog.logAudit('inbound_carton_switched', { inboundId: req.params.id, actor: req.session.userId, cartonNum: num });
  cartonResult(res, result);
});
app.post('/api/inbounds/:id/carton/cancel-multi', requireAuth, async (req, res) => {
  const result = await inbounds.cancelMultiCarton(req.params.id);
  if (!result.error) await auditLog.logAudit('inbound_carton_cancel_multi', { inboundId: req.params.id, actor: req.session.userId });
  cartonResult(res, result);
});
app.post('/api/inbounds/:id/carton/label-confirmed', requireAuth, async (req, res) => {
  const num = parseInt(req.body.num, 10) || 1;
  const result = await inbounds.confirmCartonLabel(req.params.id, num);
  if (!result.error) await auditLog.logAudit('inbound_carton_label_confirmed', { inboundId: req.params.id, actor: req.session.userId, cartonNum: num });
  cartonResult(res, result);
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
  await auditLog.logAudit('inbound_photo_added', { inboundId: req.params.id, actor: req.session.userId, photoId: photo.id });
  res.json({ ok: true, photo });
});

// Registered with token-OR-cookie auth so plain <img src="...?token="> works.
app.get('/api/inbounds/:id/photos/:photoId', async (req, res) => {
  let authed = !!req.session.userId;
  if (!authed && req.query.token) authed = !!photoToken.verify(req.query.token);
  if (!authed) return res.status(401).send('Not authenticated');
  const photo = await inbounds.getPhotoData(req.params.id, req.params.photoId);
  if (!photo) return res.status(404).send('Not found');
  res.set('Content-Type', photo.mimeType);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(photo.buffer);
});

// ── Deletion workflow ────────────────────────────────────────────────
app.post('/api/inbounds/:id/deletion-request', requireAuth, requireAdmin, async (req, res) => {
  const { reason, password } = req.body;
  if (!reason || !password) return res.status(400).json({ ok: false, error: 'Reason and your password are required' });
  const user = await staff.findById(req.session.userId);
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(403).json({ ok: false, error: 'Wrong password' });
  try {
    const inbound = await inbounds.requestDeletion(req.params.id, { reason, requestedBy: req.session.userId });
    if (!inbound) return res.status(404).json({ ok: false, error: 'Inbound not found' });
    await auditLog.logAudit('inbound_deletion_requested', { inboundId: req.params.id, actor: req.session.userId, reason });
    res.json({ ok: true, inbound });
  } catch (err) {
    handleInboundError(res, err, 'Failed to request deletion');
  }
});

app.get('/api/master/deletion-requests', requireMaster, async (req, res) => {
  res.json({ ok: true, requests: await inbounds.listPendingDeletions() });
});

app.post('/api/master/inbounds/:id/approve-deletion', requireMaster, async (req, res) => {
  const inbound = await inbounds.approveDeletion(req.params.id);
  if (!inbound) return res.status(404).json({ ok: false, error: 'Inbound not found' });
  await auditLog.logAudit('inbound_deletion_approved', {
    inboundId: req.params.id, actor: 'master', serial: inbound.serial, reference: inbound.reference,
  });
  res.json({ ok: true, deleted: true });
});

app.post('/api/master/inbounds/:id/reject-deletion', requireMaster, async (req, res) => {
  const inbound = await inbounds.rejectDeletion(req.params.id);
  if (!inbound) return res.status(404).json({ ok: false, error: 'Inbound not found' });
  await auditLog.logAudit('inbound_deletion_rejected', { inboundId: req.params.id, actor: 'master' });
  res.json({ ok: true, inbound });
});

app.delete('/api/master/inbounds/:id', requireMaster, async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ ok: false, error: 'Reason is required' });
  try {
    const inbound = await inbounds.directDelete(req.params.id);
    if (!inbound) return res.status(404).json({ ok: false, error: 'Inbound not found' });
    await auditLog.logAudit('inbound_direct_delete', { inboundId: req.params.id, actor: 'master', reason });
    res.json({ ok: true, deleted: true });
  } catch (err) {
    handleInboundError(res, err, 'Failed to delete inbound');
  }
});

// ── Reporting / export ───────────────────────────────────────────────
app.get('/api/audit-log', requireAuth, requireAdmin, async (req, res) => {
  const { from, to, inboundId, limit } = req.query;
  res.json({ ok: true, entries: await auditLog.listAuditLog({ from, to, inboundId, limit: Number(limit) || undefined }) });
});

app.get('/api/inbounds/report/export', requireAuth, requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  const list = await inbounds.listInboundsInRange({ from, to });

  const wb = new ExcelJS.Workbook();
  const jobsSheet = wb.addWorksheet('Inbound Jobs');
  jobsSheet.columns = [
    { header: 'Serial', key: 'serial', width: 16 },
    { header: 'Type', key: 'type', width: 10 },
    { header: 'Reference', key: 'reference', width: 18 },
    { header: 'Source', key: 'source', width: 22 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Expected Qty', key: 'expected', width: 14 },
    { header: 'Received Qty', key: 'received', width: 14 },
    { header: 'Carton Count', key: 'cartons', width: 14 },
    { header: 'Created At', key: 'createdAt', width: 22 },
  ];
  const linesSheet = wb.addWorksheet('Inbound Lines');
  linesSheet.columns = [
    { header: 'Serial', key: 'serial', width: 16 },
    { header: 'Reference', key: 'reference', width: 18 },
    { header: 'SKU', key: 'sku', width: 20 },
    { header: 'Description', key: 'description', width: 26 },
    { header: 'Expected Qty', key: 'expected', width: 14 },
    { header: 'Received Qty', key: 'received', width: 14 },
    { header: 'Sellable', key: 'sellable', width: 10 },
    { header: 'Damaged', key: 'damaged', width: 10 },
    { header: 'Refurbish', key: 'refurbish', width: 10 },
    { header: 'Dispose', key: 'dispose', width: 10 },
  ];

  for (const inb of list) {
    jobsSheet.addRow({
      serial: inb.serial, type: inb.type, reference: inb.reference, source: inb.source, status: inb.status,
      expected: inb.items.reduce((a, i) => a + i.expectedQty, 0),
      received: inb.items.reduce((a, i) => a + i.receivedQty, 0),
      cartons: (inb.cartons || []).length,
      createdAt: inb.createdAt,
    });
    for (const item of inb.items) {
      linesSheet.addRow({
        serial: inb.serial, reference: inb.reference, sku: item.sku, description: item.description,
        expected: item.expectedQty, received: item.receivedQty,
        sellable: item.conditionTotals.sellable, damaged: item.conditionTotals.damaged,
        refurbish: item.conditionTotals.refurbish, dispose: item.conditionTotals.dispose,
      });
    }
  }

  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="inbound-receiving-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ── Start ──────────────────────────────────────────────────────────────
initDb()
  .then(() => inbounds.init())
  .then(() => initSerials())
  .then(() => auditLog.initAuditLog())
  .then(() => auditLog.runAuditArchive())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`IdealInbound running on port ${PORT}`);
      console.log(`DB: ${hasDb ? 'PostgreSQL' : 'JSON file'}`);
      console.log(`Master deletion approval: ${process.env.IDEALINBOUND_MASTER_SECRET ? 'enabled' : 'disabled'}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialise database:', err.message);
    process.exit(1);
  });
