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

const app  = express();
const PORT = process.env.PORT || 3000;

const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

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
      if (uid) users.update(uid, {
        stripeCustomerId: s.customer,
        stripeSubscriptionId: s.subscription,
        subscriptionStatus: 'active',
      });
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const user = users.findByStripeCustomer(sub.customer);
      if (user) users.update(user.id, { subscriptionStatus: 'inactive' });
    }

    res.json({ received: true });
  }
);

// ── Middleware ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

// ── Auth helpers ───────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  next();
}

function requireSubscriptionAPI(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const user = users.findById(req.session.userId);
  if (!user || user.subscriptionStatus !== 'active')
    return res.status(403).json({ ok: false, error: 'Active subscription required' });
  next();
}

function requireSubscriptionPage(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  const user = users.findById(req.session.userId);
  if (!user || user.subscriptionStatus !== 'active') return res.redirect('/signup?reason=payment');
  next();
}

// ── HTML page routes (defined before static so / is not hijacked) ──────
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/login',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/dashboard', requireSubscriptionPage, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'))
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
  if (users.findByEmail(email))
    return res.status(409).json({ ok: false, error: 'Email already registered — please sign in' });

  const passwordHash = await bcrypt.hash(password, 12);
  // No Stripe = dev mode: activate immediately, no payment step needed
  const subscriptionStatus = stripe ? 'pending' : 'active';
  const user = users.create({ name, email, passwordHash, subscriptionStatus });
  req.session.userId = user.id;
  res.json({ ok: true, user: safeUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ ok: false, error: 'Email and password required' });
  const user = users.findByEmail(email);
  if (!user) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
  req.session.userId = user.id;
  // Dev mode: auto-activate accounts that are still pending (e.g. created before the fix)
  if (!stripe && user.subscriptionStatus === 'pending') {
    const activated = users.update(user.id, { subscriptionStatus: 'active' });
    return res.json({ ok: true, user: safeUser(activated) });
  }
  res.json({ ok: true, user: safeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ ok: true, user: null });
  const user = users.findById(req.session.userId);
  res.json({ ok: true, user: user ? safeUser(user) : null });
});

function safeUser(u) {
  return { id: u.id, name: u.name, email: u.email, subscriptionStatus: u.subscriptionStatus };
}

// ── Payment API ────────────────────────────────────────────────────────
app.post('/api/payment/create-checkout', requireAuth, async (req, res) => {
  if (!stripe) {
    // Dev mode: skip payment, activate immediately
    users.update(req.session.userId, { subscriptionStatus: 'active' });
    return res.json({ ok: true, url: '/dashboard' });
  }
  const user = users.findById(req.session.userId);
  if (!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  try {
    const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
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

app.get('/payment/success', async (req, res) => {
  if (stripe && req.session.userId && req.query.session_id) {
    try {
      const s = await stripe.checkout.sessions.retrieve(req.query.session_id);
      if (s.payment_status === 'paid') {
        users.update(req.session.userId, {
          stripeCustomerId: s.customer,
          stripeSubscriptionId: s.subscription,
          subscriptionStatus: 'active',
        });
      }
    } catch { /* webhook will handle it */ }
  }
  res.redirect('/dashboard');
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

app.listen(PORT, () => {
  console.log(`VaultSignals running on port ${PORT}`);
  console.log(`Stripe: ${stripe ? 'configured' : 'NOT configured — dev mode (no payment required)'}`);
  console.log(`Live data: ${process.env.ALPHA_VANTAGE_API_KEY ? 'YES' : 'NO — demo mode'}`);
});
