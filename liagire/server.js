'use strict';
require('dotenv').config();
const express = require('express');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { db, DATA_DIR } = require('./lib/db');
const auth = require('./lib/auth');
const jobsLib = require('./lib/jobs');
const { publicJobView } = require('./lib/public-view');
const { STAGE_ORDER, STAGE_LABELS } = require('./lib/stages');

const PORT = Number(process.env.LIAGIRE_PORT || process.env.PORT || 4100);
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

const app = express();
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Every /api/ route gets a general ceiling — the public token-gated routes
// especially, since they take no login and a client's token is the only
// thing standing between a request and that one job's data. Login gets a
// second, much tighter limiter on top, since guessing a password is the
// one thing worth slowing down hard.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
});
app.use('/api/', apiLimiter);

// ---------------------------------------------------------------------------
// Boot: seed a first admin account if the database has nobody in it yet, so
// a fresh deploy is usable without a separate manual step. Credentials are
// printed once to the boot log — never stored in plaintext anywhere else.
// ---------------------------------------------------------------------------
(function seedAdminIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count > 0) return;
  const username = process.env.LIAGIRE_ADMIN_USER || 'admin';
  const password = process.env.LIAGIRE_ADMIN_PASSWORD || crypto.randomBytes(6).toString('hex');
  const { salt, hash } = auth.hashPassword(password);
  db.prepare(
    'INSERT INTO users (id, username, name, role, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), username, 'Administrator', 'admin', salt, hash, new Date().toISOString());
  console.log('='.repeat(60));
  console.log('[liagire] First run — created an admin account:');
  console.log(`[liagire]   username: ${username}`);
  console.log(`[liagire]   password: ${password}`);
  console.log('[liagire] Sign in and change this from Users, or set');
  console.log('[liagire] LIAGIRE_ADMIN_USER / LIAGIRE_ADMIN_PASSWORD before first boot.');
  console.log('='.repeat(60));
})();

// ---------------------------------------------------------------------------
// Uploads — memory storage so every route decides for itself which job the
// file belongs to (a vendor-cost payment route only has a vendor_cost id,
// not a job id, in its URL), then writes to data/uploads/<jobId>/<name>.
// ---------------------------------------------------------------------------
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 12 },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(jobsLib.httpError(400, `Unsupported file type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// Derived ONLY from file.mimetype — which multer's fileFilter above already
// restricts to ALLOWED_MIME — and NEVER from file.originalname. The
// original filename is entirely attacker-controlled (it's a multipart
// Content-Disposition header the browser sends verbatim from the picked
// file's name), and letting it feed the extension used to build a
// server-side storage path was a second, easy-to-miss taint source
// alongside the job id itself: a client can name a file anything at all.
const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/heic': '.heic', 'image/heif': '.heif', 'application/pdf': '.pdf',
};
function safeExt(mimetype) {
  return MIME_EXT[mimetype] || '';
}

// Every job/vendor-cost id we ever hand out is our own crypto.randomUUID()
// output, so this shape is never too strict for a legitimate caller — but
// jobId here can arrive straight from a URL path param, so it must be
// checked BEFORE it is joined into a filesystem path. Skipping this (or
// only checking existence in the database afterward) leaves the join
// itself walkable with ../ sequences.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function saveUpload(jobId, file, prefix) {
  if (!ID_RE.test(jobId)) throw jobsLib.httpError(400, 'Invalid job reference');
  // path.basename() strips any directory component from the value that
  // actually reaches path.join() — the recognized sanitizer for this
  // exact class of finding, applied directly to the tainted value itself
  // (not to a value merely derived from it), so a static analyzer sees
  // the sanitizing call sitting right in the tainted flow. A no-op for
  // any real id (they never contain a separator to begin with, having
  // already passed the UUID check above), but it is what closes the
  // finding rather than merely reasoning that it should.
  const safeId = path.basename(jobId);
  if (!safeId || safeId !== jobId) throw jobsLib.httpError(400, 'Invalid job reference');
  const dir = path.join(UPLOAD_DIR, safeId);
  fs.mkdirSync(dir, { recursive: true });
  const ext = safeExt(file.mimetype);
  const safeName = path.basename(
    `${Date.now()}-${prefix}-${crypto.randomBytes(4).toString('hex')}${ext}`
  );
  fs.writeFileSync(path.join(dir, safeName), file.buffer);
  return `${safeId}/${safeName}`;
}

// A form/query field can arrive as an array instead of a string simply by
// repeating its name (multer parses duplicate multipart fields that way;
// qs does the same for repeated query keys) — nothing here ever means to
// send one, so a caller doing it is either a mistake or HTTP parameter
// pollution. Collapsing to the last value at this ONE choke point (every
// route goes through wrap()) means no field anywhere downstream can reach
// a DB write or a path join as an array/object when a string was assumed.
function flattenArrayFields(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v)) obj[k] = v.length ? String(v[v.length - 1]) : '';
    else if (v && typeof v === 'object') obj[k] = '';
  }
}

function wrap(fn) {
  return (req, res) => {
    try {
      flattenArrayFields(req.body);
      flattenArrayFields(req.query);
      const result = fn(req, res);
      if (result && typeof result.then === 'function') {
        result.then(v => { if (!res.headersSent) res.json(v); }).catch(err => onError(err, res));
      } else if (!res.headersSent) {
        res.json(result);
      }
    } catch (err) {
      onError(err, res);
    }
  };
}

function onError(err, res) {
  const status = err.status || 500;
  if (status >= 500) console.error('[liagire] error:', err);
  res.status(status).json({ error: err.message || 'Internal error' });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post('/api/auth/login', loginLimiter, wrap((req) => {
  const { username, password } = req.body || {};
  if (!username || !password) throw jobsLib.httpError(400, 'Username and password are required');
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username).trim());
  if (!user || user.disabled || !auth.verifyPassword(password, user.salt, user.password_hash)) {
    throw jobsLib.httpError(401, 'Incorrect username or password');
  }
  const token = auth.createSession(user);
  return { token, user: { id: user.id, username: user.username, name: user.name, role: user.role } };
}));

app.post('/api/auth/logout', auth.requireAuth, wrap((req) => {
  const token = req.headers['x-auth-token'];
  auth.destroySession(token);
  return { ok: true };
}));

app.get('/api/me', auth.requireAuth, wrap((req) => ({ user: req.session })));

// ---------------------------------------------------------------------------
// Users (admin only)
// ---------------------------------------------------------------------------
app.get('/api/users', auth.requireAuth, auth.requireAdmin, wrap(() => {
  return db.prepare('SELECT id, username, name, role, disabled, created_at FROM users ORDER BY created_at ASC').all();
}));

app.post('/api/users', auth.requireAuth, auth.requireAdmin, wrap((req) => {
  const { username, name, password, role } = req.body || {};
  if (!username || !name || !password) throw jobsLib.httpError(400, 'username, name and password are required');
  if (password.length < 6) throw jobsLib.httpError(400, 'Password must be at least 6 characters');
  const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(String(username).trim());
  if (existing) throw jobsLib.httpError(409, 'That username is already taken');
  const { salt, hash } = auth.hashPassword(password);
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO users (id, username, name, role, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, String(username).trim(), String(name).trim(), role === 'admin' ? 'admin' : 'staff', salt, hash, new Date().toISOString());
  return db.prepare('SELECT id, username, name, role, disabled, created_at FROM users WHERE id = ?').get(id);
}));

app.patch('/api/users/:id', auth.requireAuth, auth.requireAdmin, wrap((req) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) throw jobsLib.httpError(404, 'User not found');
  const { role, disabled, password } = req.body || {};
  if (role !== undefined) {
    if (role !== 'admin' && role !== 'staff') throw jobsLib.httpError(400, 'role must be admin or staff');
    if (target.id === req.session.userId && role !== 'admin') {
      const otherAdmins = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND id != ?").get(target.id).c;
      if (otherAdmins === 0) throw jobsLib.httpError(409, 'At least one administrator must remain');
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
  }
  if (disabled !== undefined) {
    if (target.id === req.session.userId && disabled) throw jobsLib.httpError(400, 'You cannot disable your own account');
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, target.id);
  }
  if (password) {
    if (password.length < 6) throw jobsLib.httpError(400, 'Password must be at least 6 characters');
    const { salt, hash } = auth.hashPassword(password);
    db.prepare('UPDATE users SET salt = ?, password_hash = ? WHERE id = ?').run(salt, hash, target.id);
  }
  return db.prepare('SELECT id, username, name, role, disabled, created_at FROM users WHERE id = ?').get(target.id);
}));

app.delete('/api/users/:id', auth.requireAuth, auth.requireAdmin, wrap((req) => {
  if (req.params.id === req.session.userId) throw jobsLib.httpError(400, 'You cannot delete your own account');
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) throw jobsLib.httpError(404, 'User not found');
  if (target.role === 'admin') {
    const otherAdmins = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND id != ?").get(target.id).c;
    if (otherAdmins === 0) throw jobsLib.httpError(409, 'At least one administrator must remain');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  return { ok: true };
}));

// ---------------------------------------------------------------------------
// Stats / dashboard tiles
// ---------------------------------------------------------------------------
app.get('/api/stats', auth.requireAuth, wrap(() => ({
  ...jobsLib.stats(),
  stage_order: STAGE_ORDER,
  stage_labels: STAGE_LABELS,
})));

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
app.get('/api/jobs', auth.requireAuth, wrap((req) => jobsLib.listJobs(req.query)));

app.post('/api/jobs', auth.requireAuth, wrap((req) =>
  jobsLib.createJob(req.body || {}, req.session.username)));

app.get('/api/jobs/:id', auth.requireAuth, wrap((req) => jobsLib.jobDetail(req.params.id)));

app.post('/api/jobs/:id/quote', auth.requireAuth, upload.single('doc'), wrap((req) => {
  const doc_path = req.file ? saveUpload(req.params.id, req.file, 'quote') : null;
  return jobsLib.sendQuote(req.params.id, { ...req.body, doc_path }, req.session.username);
}));

app.post('/api/jobs/:id/accept', auth.requireAuth, upload.single('proof'), wrap((req) => {
  const proof_path = req.file ? saveUpload(req.params.id, req.file, 'acceptance') : null;
  return jobsLib.recordAcceptance(req.params.id, { ...req.body, proof_path }, req.session.username);
}));

app.post('/api/jobs/:id/collect', auth.requireAuth, upload.array('photos', 12), wrap((req) => {
  const jobId = req.params.id;
  for (const file of req.files || []) {
    const file_path = saveUpload(jobId, file, 'collection');
    jobsLib.addPhoto(jobId, { stage: 'collection', file_path, caption: req.body.caption }, req.session.username);
  }
  return jobsLib.recordCollection(jobId, req.body, req.session.username, (req.files || []).length);
}));

app.post('/api/jobs/:id/ship', auth.requireAuth, wrap((req) =>
  jobsLib.recordShipment(req.params.id, req.body || {}, req.session.username)));

app.post('/api/jobs/:id/tracking-update', auth.requireAuth, wrap((req) =>
  jobsLib.addTrackingUpdate(req.params.id, req.body || {}, req.session.username)));

app.post('/api/jobs/:id/deliver', auth.requireAuth, upload.array('photos', 12), wrap((req) => {
  const jobId = req.params.id;
  for (const file of req.files || []) {
    const file_path = saveUpload(jobId, file, 'delivery');
    jobsLib.addPhoto(jobId, { stage: 'delivery', file_path, caption: req.body.caption }, req.session.username);
  }
  return jobsLib.recordDelivery(jobId, req.body, req.session.username, (req.files || []).length);
}));

app.post('/api/jobs/:id/photos', auth.requireAuth, upload.array('photos', 12), wrap((req) => {
  const jobId = req.params.id;
  const stage = ['collection', 'delivery', 'other'].includes(req.body.stage) ? req.body.stage : 'other';
  const ids = (req.files || []).map(file => {
    const file_path = saveUpload(jobId, file, stage);
    return jobsLib.addPhoto(jobId, { stage, file_path, caption: req.body.caption }, req.session.username);
  });
  return { added: ids.length, job: jobsLib.jobDetail(jobId) };
}));

app.post('/api/jobs/:id/invoice', auth.requireAuth, upload.single('doc'), wrap((req) => {
  const doc_path = req.file ? saveUpload(req.params.id, req.file, 'invoice') : null;
  return jobsLib.issueInvoice(req.params.id, { ...req.body, doc_path }, req.session.username);
}));

app.post('/api/jobs/:id/payment', auth.requireAuth, upload.single('proof'), wrap((req) => {
  const proof_path = req.file ? saveUpload(req.params.id, req.file, 'payment') : null;
  return jobsLib.recordPayment(req.params.id, { ...req.body, proof_path }, req.session.username);
}));

app.delete('/api/jobs/:id/payment/:paymentId', auth.requireAuth, wrap((req) =>
  jobsLib.deletePayment(req.params.id, req.params.paymentId, req.session.username)));

app.post('/api/jobs/:id/cancel', auth.requireAuth, wrap((req) =>
  jobsLib.cancelJob(req.params.id, req.body || {}, req.session.username)));

app.post('/api/jobs/:id/reactivate', auth.requireAuth, wrap((req) =>
  jobsLib.reactivateJob(req.params.id, req.session.username)));

// ---------------------------------------------------------------------------
// Vendor costs (never exposed on the client-facing token view)
// ---------------------------------------------------------------------------
app.post('/api/jobs/:id/vendor-costs', auth.requireAuth, upload.single('doc'), wrap((req) => {
  const doc_path = req.file ? saveUpload(req.params.id, req.file, 'vendor-invoice') : null;
  return jobsLib.addVendorCost(req.params.id, { ...req.body, doc_path }, req.session.username);
}));

app.post('/api/vendor-costs/:vcId/payment', auth.requireAuth, upload.single('proof'), wrap((req) => {
  const vc = db.prepare('SELECT job_id FROM vendor_costs WHERE id = ?').get(req.params.vcId);
  if (!vc) throw jobsLib.httpError(404, 'Vendor cost not found');
  const proof_path = req.file ? saveUpload(vc.job_id, req.file, 'vendor-payment') : null;
  return jobsLib.recordVendorPayment(req.params.vcId, { ...req.body, proof_path }, req.session.username);
}));

app.delete('/api/vendor-costs/:vcId', auth.requireAuth, wrap((req) => {
  jobsLib.deleteVendorCost(req.params.vcId, req.session.username);
  return { ok: true };
}));

// ---------------------------------------------------------------------------
// Files — internal (authenticated) and public (token-gated, restricted set)
// ---------------------------------------------------------------------------
function safeJoinUpload(rel) {
  const p = path.normalize(path.join(UPLOAD_DIR, rel));
  if (!p.startsWith(UPLOAD_DIR)) return null;
  return p;
}

app.get('/api/files/:jobId/:filename', auth.requireAuth, (req, res) => {
  const p = safeJoinUpload(path.join(req.params.jobId, req.params.filename));
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(p);
});

// Only the specific proof/quote/invoice files a client is entitled to see —
// never a vendor-cost document, never by guessing a filename outside the
// handful this route itself looks up from the job row.
app.get('/api/public/:token/files/:kind', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE client_token = ?').get(req.params.token);
  if (!job) return res.status(404).json({ error: 'Not found' });
  const map = {
    quote: job.quote_doc_path,
    acceptance: job.acceptance_proof_path,
    invoice: job.invoice_doc_path,
  };
  const rel = map[req.params.kind];
  if (!rel) return res.status(404).json({ error: 'Not found' });
  const p = safeJoinUpload(rel);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(p);
});

app.get('/api/public/:token/photo/:photoId', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE client_token = ?').get(req.params.token);
  if (!job) return res.status(404).json({ error: 'Not found' });
  const photo = db.prepare(
    "SELECT * FROM job_photos WHERE id = ? AND job_id = ? AND stage IN ('collection','delivery')"
  ).get(req.params.photoId, job.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  const p = safeJoinUpload(photo.file_path);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(p);
});

app.get('/api/public/:token', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE client_token = ?').get(req.params.token);
  if (!job) return res.status(404).json({ error: 'We could not find that link. Please check the URL your contact sent you.' });
  res.json(publicJobView(job));
});

// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, at: new Date().toISOString() }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => onError(err, res)); // eslint-disable-line no-unused-vars

app.listen(PORT, () => {
  console.log(`[liagire] listening on :${PORT}`);
});
