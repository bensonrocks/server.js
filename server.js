'use strict';

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const session = require('express-session');
const Stripe  = require('stripe');

const { analyze }                    = require('./lib/trading/ictAnalysis');
const { fetchDailyCandles, SYMBOLS } = require('./lib/trading/marketData');
const users                          = require('./lib/users');
const hunter                         = require('./lib/hunter/store');
const hunterStaff                    = require('./lib/hunter/staff');
const { init: initDb, hasDb, pool }  = require('./lib/db');
const hitpay                         = require('./lib/hitpay');

const app  = express();
const PORT = process.env.PORT || 3000;

const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// HitPay takes priority over Stripe when configured
const useHitPay = hitpay.configured;

// ── Stripe webhook — must receive raw body ─────────────────────────────
app.post('/api/payment/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) return res.status(400).send('Stripe not configured');
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const uid = s.metadata?.userId;
      if (uid) await users.update(uid, {
        stripeCustomerId: s.customer,
        stripeSubscriptionId: s.subscription,
        subscriptionStatus: 'active',
      });
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const user = await users.findByStripeCustomer(sub.customer);
      if (user) await users.update(user.id, { subscriptionStatus: 'inactive' });
    }

    res.json({ received: true });
  }
);

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
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  next();
}

async function requireSubscriptionAPI(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const user = await users.findById(req.session.userId);
  if (!user || user.subscriptionStatus !== 'active')
    return res.status(403).json({ ok: false, error: 'Active subscription required' });
  next();
}

async function requireSubscriptionPage(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  const user = await users.findById(req.session.userId);
  if (!user || user.subscriptionStatus !== 'active') return res.redirect('/signup?reason=payment');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

function requireHunterStaffAPI(req, res, next) {
  if (!req.session.hunterStaffId) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  next();
}

function requireHunterStaffPage(req, res, next) {
  if (!req.session.hunterStaffId) return res.redirect('/hunter/login');
  next();
}

function requireHunterAdmin(req, res, next) {
  const staff = hunterStaff.findById(req.session.hunterStaffId);
  if (!staff || !staff.isAdmin) return res.status(403).json({ ok: false, error: 'Admin only' });
  next();
}

// ── SEO ────────────────────────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /settings\nDisallow: /vaultkeepers\nDisallow: /api/\nSitemap: ${base}/sitemap.xml`
  );
});

app.get('/sitemap.xml', (req, res) => {
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const today = new Date().toISOString().split('T')[0];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><lastmod>${today}</lastmod><priority>1.0</priority></url>
  <url><loc>${base}/tutorial.html</loc><lastmod>${today}</lastmod><priority>0.8</priority></url>
  <url><loc>${base}/signup</loc><lastmod>${today}</lastmod><priority>0.7</priority></url>
</urlset>`);
});

// ── HTML page routes (defined before static so / is not hijacked) ──────
// HUNTER_HOME=1 turns a deployment into the IdealOne.Hunter CRM: / serves
// the CRM instead of the VaultSignals landing page.
const hunterHome = ['1', 'true', 'yes'].includes(String(process.env.HUNTER_HOME || '').toLowerCase());
app.get('/', (req, res) => {
  if (!hunterHome) return res.sendFile(path.join(__dirname, 'public', 'landing.html'));
  if (!req.session.hunterStaffId) return res.redirect('/hunter/login');
  res.sendFile(path.join(__dirname, 'public', 'hunter.html'));
});
app.get('/login',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/dashboard',    requireSubscriptionPage, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'))
);
app.get('/settings',     requireSubscriptionPage, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'settings.html'))
);
app.get('/vaultkeepers', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'vaultkeepers.html'))
);
app.get('/hunter', requireHunterStaffPage, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'hunter.html'))
);
app.get('/hunter/login', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'hunter-login.html'))
);

// ── Static assets (tutorial.html, images, etc.) ────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth API ───────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ ok: false, error: 'All fields required' });
  if (password.length < 8)
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  if (await users.findByEmail(email))
    return res.status(409).json({ ok: false, error: 'Email already registered — please sign in' });

  const passwordHash = await bcrypt.hash(password, 12);
  // Dev mode (no payment gateway): activate immediately
  const subscriptionStatus = (useHitPay || stripe) ? 'pending' : 'active';
  const user = await users.create({ name, email, passwordHash, subscriptionStatus });
  req.session.userId = user.id;
  res.json({ ok: true, user: safeUser(user) });
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
  // Dev mode: auto-activate accounts that are still pending
  if (!useHitPay && !stripe && user.subscriptionStatus === 'pending') {
    const activated = await users.update(user.id, { subscriptionStatus: 'active' });
    return res.json({ ok: true, user: safeUser(activated) });
  }
  res.json({ ok: true, user: safeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.json({ ok: true, user: null });
  const user = await users.findById(req.session.userId);
  res.json({ ok: true, user: user ? safeUser(user) : null });
});

function safeUser(u) {
  return { id: u.id, name: u.name, email: u.email, subscriptionStatus: u.subscriptionStatus };
}

// ── Payment API ────────────────────────────────────────────────────────
app.post('/api/payment/create-checkout', requireAuth, async (req, res) => {
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

  // Dev mode — no gateway configured
  if (!useHitPay && !stripe) {
    await users.update(req.session.userId, { subscriptionStatus: 'active' });
    return res.json({ ok: true, url: '/dashboard' });
  }

  const user = await users.findById(req.session.userId);
  if (!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  // ── HitPay ──────────────────────────────────────────────────────────
  if (useHitPay) {
    try {
      const billing = await hitpay.createRecurringBilling({
        userId:      user.id,
        name:        user.name,
        email:       user.email,
        redirectUrl: `${base}/payment/success`,
        webhookUrl:  `${base}/api/payment/hitpay-webhook`,
      });
      return res.json({ ok: true, url: billing.url });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ── Stripe fallback ──────────────────────────────────────────────────
  try {
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: user.email,
      metadata: { userId: user.id },
      success_url: `${base}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${base}/signup?reason=cancelled`,
    });
    res.json({ ok: true, url: checkout.url });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── HitPay webhook ─────────────────────────────────────────────────────
app.post('/api/payment/hitpay-webhook',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const { hmac, status, reference, payment_id } = req.body;

    if (!hitpay.verifyWebhook(req.body, hmac)) {
      return res.status(400).send('Invalid signature');
    }

    if (status === 'succeeded' && reference) {
      await users.update(reference, {
        subscriptionStatus:   'active',
        stripeSubscriptionId: payment_id, // reuse field for HitPay billing ID
      });
    }

    if ((status === 'failed' || status === 'cancelled') && reference) {
      const user = await users.findById(reference);
      if (user && user.subscriptionStatus === 'active') {
        await users.update(reference, { subscriptionStatus: 'inactive' });
      }
    }

    res.status(200).send('OK');
  }
);

app.get('/payment/success', async (req, res) => {
  // HitPay redirects with ?status=completed&reference={userId}
  if (useHitPay && req.query.status === 'completed' && req.query.reference) {
    await users.update(req.query.reference, { subscriptionStatus: 'active' });
    if (req.session) req.session.userId = req.query.reference;
  }

  // Stripe redirects with ?session_id=xxx
  if (stripe && req.session.userId && req.query.session_id) {
    try {
      const s = await stripe.checkout.sessions.retrieve(req.query.session_id);
      if (s.payment_status === 'paid') {
        await users.update(req.session.userId, {
          stripeCustomerId:    s.customer,
          stripeSubscriptionId: s.subscription,
          subscriptionStatus:  'active',
        });
      }
    } catch { /* webhook will handle it */ }
  }

  res.redirect('/dashboard');
});

// ── Subscription cancel ────────────────────────────────────────────────
app.post('/api/subscription/cancel', requireAuth, async (req, res) => {
  const user = await users.findById(req.session.userId);
  if (!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  if (user.subscriptionStatus !== 'active')
    return res.status(400).json({ ok: false, error: 'No active subscription to cancel' });

  // Cancel with payment gateway
  try {
    if (useHitPay && user.stripeSubscriptionId) {
      await hitpay.cancelBilling(user.stripeSubscriptionId);
    } else if (stripe && user.stripeSubscriptionId) {
      await stripe.subscriptions.cancel(user.stripeSubscriptionId);
    }
  } catch (err) {
    console.warn('Gateway cancel error (proceeding anyway):', err.message);
  }

  await users.update(user.id, { subscriptionStatus: 'cancelled' });
  req.session.destroy(() => res.json({ ok: true }));
});

// ── Admin API (VaultKeepers) ───────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const secret = process.env.VAULTKEEPERS_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: 'Admin not configured' });
  if (req.body.password !== secret)
    return res.status(401).json({ ok: false, error: 'Wrong password' });
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const all = await users.findAll();
  // Strip password hashes before sending
  const safe = all.map(u => ({
    id: u.id, name: u.name, email: u.email,
    subscriptionStatus: u.subscriptionStatus, createdAt: u.createdAt,
  }));
  res.json({ ok: true, users: safe });
});

app.post('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  const allowed = ['active', 'inactive', 'pending', 'cancelled'];
  if (!allowed.includes(status))
    return res.status(400).json({ ok: false, error: 'Invalid status' });
  const updated = await users.update(req.params.id, { subscriptionStatus: status });
  if (!updated) return res.status(404).json({ ok: false, error: 'User not found' });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  await users.deleteUser(req.params.id);
  res.json({ ok: true });
});

// ── IdealOne.Hunter CRM API (staff only) ───────────────────────────────
function hunterStaffName(req) {
  const staff = hunterStaff.findById(req.session.hunterStaffId);
  return staff ? staff.name : 'staff';
}

app.post('/api/hunter/auth/login', (req, res) => {
  const staff = hunterStaff.verify(req.body.email, req.body.password);
  if (!staff) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
  req.session.hunterStaffId = staff.id;
  hunterStaff.logEvent(staff.id, 'login');
  res.json({ ok: true, staff: hunterStaff.safe(staff) });
});

app.post('/api/hunter/auth/logout', (req, res) => {
  if (req.session.hunterStaffId) hunterStaff.logEvent(req.session.hunterStaffId, 'logout');
  delete req.session.hunterStaffId;
  res.json({ ok: true });
});

app.get('/api/hunter/auth/me', (req, res) => {
  res.json({ ok: true, staff: hunterStaff.safe(hunterStaff.findById(req.session.hunterStaffId)) });
});

// Presence trail: the page sends a heartbeat every minute and a leave
// beacon on close; sessions() folds these into time-on-page.
app.post('/api/hunter/track', requireHunterStaffAPI, (req, res) => {
  const event = req.body && req.body.event;
  if (!['heartbeat', 'leave'].includes(event))
    return res.status(400).json({ ok: false, error: 'Invalid event' });
  hunterStaff.logEvent(req.session.hunterStaffId, event);
  res.json({ ok: true });
});

app.get('/api/hunter/activity', requireHunterStaffAPI, (req, res) => {
  res.json({ ok: true, sessions: hunterStaff.sessions() });
});

app.get('/api/hunter/staff', requireHunterStaffAPI, requireHunterAdmin, (req, res) => {
  res.json({ ok: true, staff: hunterStaff.listSafe() });
});

app.post('/api/hunter/staff', requireHunterStaffAPI, requireHunterAdmin, (req, res) => {
  const { name, email, password, isAdmin } = req.body;
  const result = hunterStaff.create({ name, email, password, isAdmin });
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  res.json({ ok: true, staff: hunterStaff.safe(result.staff) });
});

app.get('/api/hunter/leads', requireHunterStaffAPI, (req, res) => {
  res.json({ ok: true, leads: hunter.all(), stats: hunter.stats(),
             followups: hunter.followups() });
});

app.post('/api/hunter/leads/:id/status', requireHunterStaffAPI, (req, res) => {
  const result = hunter.setStatus(req.params.id, req.body.status, hunterStaffName(req));
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  res.json({ ok: true, lead: result.lead });
});

app.post('/api/hunter/leads/:id/activity', requireHunterStaffAPI, (req, res) => {
  const { type, text } = req.body;
  const result = hunter.addActivity(req.params.id, { type, text, by: hunterStaffName(req) });
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  res.json({ ok: true, lead: result.lead });
});

app.post('/api/hunter/leads/:id/draft', requireHunterStaffAPI, (req, res) => {
  const { subject, body } = req.body;
  if (typeof subject !== 'string' || typeof body !== 'string')
    return res.status(400).json({ ok: false, error: 'subject and body required' });
  const result = hunter.updateDraft(req.params.id, { subject, body });
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  res.json({ ok: true, lead: result.lead });
});

// ── Trading API (subscriber-only) ──────────────────────────────────────
app.get('/api/analysis', requireSubscriptionAPI, async (req, res) => {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  const results = {};
  try {
    for (const key of Object.keys(SYMBOLS)) {
      const candles = await fetchDailyCandles(key, { apiKey });
      results[key] = analyze(candles, key);
    }
    res.json({ ok: true, data: results, live: !!apiKey });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/demo', requireSubscriptionAPI, (req, res) => {
  const { generateCandles } = require('./lib/trading/demoData');
  const results = {
    GOLD:   analyze(generateCandles(2330, 0.1,  100, 'bull'), 'GOLD'),
    SILVER: analyze(generateCandles(32.5, 0.01, 100, 'bull'), 'SILVER'),
  };
  res.json({ ok: true, data: results, live: false });
});

// ── Start ──────────────────────────────────────────────────────────────
hunterStaff.ensureSeed();
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`VaultSignals running on port ${PORT}`);
      console.log(`DB: ${hasDb ? 'PostgreSQL' : 'JSON file'}`);
      console.log(`Payment: ${useHitPay ? 'HitPay' : stripe ? 'Stripe' : 'dev mode (no payment)'}`);
      console.log(`Live data: ${process.env.ALPHA_VANTAGE_API_KEY ? 'YES' : 'NO — demo mode'}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialise database:', err.message);
    process.exit(1);
  });
