// ── THE PARTNER INTEGRATION LAYER — both directions ─────────────────────────
//
// Until now the only way another system could talk to IdealOne was to sign in
// as a member of STAFF and carry their session token. That is wrong in three
// separate ways: a session is one-per-user, so the integration and the human
// kick each other out all day; a staff token unlocks EVERYTHING, so a partner
// that only needs to read stock can also cancel orders; and there is no record
// of which system did what, because the trail names a person who was asleep.
//
// So: an API KEY is its own identity, carrying only the scopes it was granted,
// and every call it makes is attributable to it by name.
//
// And nothing pushed OUTWARD at all — a partner could only find out an order
// had shipped by asking again and again. An outbound webhook is the other half
// of the same feature, and is deliberately built with the lesson this codebase
// learned the hard way on the ZORT outbox: a delivery that fails is RETRIED on
// a ladder, is never silently dropped, and says in words why it stopped.
const crypto = require('crypto');

// ── API KEYS ────────────────────────────────────────────────────────────────
// The key is shown ONCE, at creation, and stored only as a salted hash — the
// same discipline as a user password, and for the same reason: db.json is
// backed up nightly, gzipped and EMAILED, so a key stored in the clear would
// travel by email and sit on disk for ever.
const KEY_PREFIX = 'iok_';

// Deliberately COARSE, and deliberately not a matrix. Four things a partner
// system might be allowed to do; a key carries the ones it needs and nothing
// else. A permission matrix invites half-configured keys nobody can reason
// about later — the same argument the portal's two access levels settled.
const SCOPES = ['read', 'orders:write', 'inventory:write', 'inbound:write'];

const SCOPE_LABEL = {
  'read':            'Read orders, stock, inbound and transport',
  'orders:write':    'Send orders in, and cancel them',
  'inventory:write': 'Adjust stock and load an item master',
  'inbound:write':   'Create and receive inbound shipments',
};

function mintApiKey() {
  // 32 hex characters of entropy after the prefix. Same shape as the ZORT push
  // token, which is the other secret in this system that lives in a URL/header.
  return KEY_PREFIX + crypto.randomBytes(16).toString('hex');
}

function hashApiKey(key, salt) {
  return crypto.createHash('sha256').update(String(salt) + ':' + String(key)).digest('hex');
}

// The last four characters, shown on the admin screen so a key can be told
// apart from its siblings without ever storing enough to use one.
function keyTail(key) { return String(key || '').slice(-4); }

// CONSTANT-TIME, and length-checked first so a correct PREFIX is rejected too
// — the same discipline the ZORT webhook token compare already uses. Both
// sides are fixed-length hex here, so a mismatch in length is itself a miss.
function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length || !x.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch { return false; }
}

// Returns the matching key RECORD, or null. Never throws on a malformed store.
function findApiKey(keys, presented) {
  const raw = String(presented || '').trim();
  if (!raw.startsWith(KEY_PREFIX)) return null;
  for (const k of keys || []) {
    if (!k || k.enabled === false || !k.salt || !k.hash) continue;
    if (sameSecret(hashApiKey(raw, k.salt), k.hash)) return k;
  }
  return null;
}

function hasScope(keyRec, scope) {
  return Array.isArray(keyRec?.scopes) && keyRec.scopes.includes(scope);
}

// ── OUTBOUND WEBHOOKS ───────────────────────────────────────────────────────
// What a partner can be told about. Each is a fact that has ALREADY happened
// here — never an instruction, never a request for an answer. A receiver that
// is down costs a retry, never a stuck order.
const EVENTS = [
  'order.completed',    // picked, packed, scanned off
  'order.cancelled',    // will not be picked (by us, the client, or the channel)
  'order.picked_up',    // the parcel physically left
  'inbound.received',   // a receipt was closed — what actually arrived
  'stock.adjusted',     // an on-hand figure moved with no order behind it
];

const EVENT_LABEL = {
  'order.completed': 'An order finished picking and packing',
  'order.cancelled': 'An order was cancelled',
  'order.picked_up': 'A parcel left the building',
  'inbound.received': 'An inbound receipt was closed',
  'stock.adjusted':  'Stock was adjusted by hand',
};

// SIGNED, so the receiver can prove the call came from us and not from anyone
// who learned the URL. Stripe's shape, because it is the one most partners have
// already implemented: `t=<unix>,v1=<hex>` over `<t>.<raw body>`.
//
// The TIMESTAMP is inside the signed string on purpose — without it a captured
// delivery could be replayed against the receiver for ever.
function signPayload(secret, rawBody, tsSec) {
  const t = tsSec || Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', String(secret || ''))
    .update(`${t}.${rawBody}`).digest('hex');
  return { t, header: `t=${t},v1=${mac}` };
}

// Exported so a partner's own verification can be tested against the exact
// code that signs — and so our test suite proves the signature rather than
// asserting that a header merely exists.
function verifySignature(secret, rawBody, header, toleranceSec = 300) {
  const m = /t=(\d+),v1=([0-9a-f]+)/.exec(String(header || ''));
  if (!m) return false;
  const t = Number(m[1]);
  if (!Number.isFinite(t)) return false;
  if (toleranceSec && Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
  const mine = crypto.createHmac('sha256', String(secret || '')).update(`${t}.${rawBody}`).digest('hex');
  return sameSecret(mine, m[2]);
}

function mintHookSecret() { return 'whsec_' + crypto.randomBytes(24).toString('hex'); }

// ONE delivery attempt. Never throws — the caller is a background drain and a
// receiver being unreachable is not this process's problem to crash over.
// Returns what actually happened, in enough detail to put on the screen: a
// partner debugging their endpoint needs the status and the first bytes of the
// reply, not "failed".
async function deliverOnce(url, secret, event, payload, { timeoutMs = 10000, deliveryId = '' } = {}) {
  const body = JSON.stringify({ event, at: new Date().toISOString(), id: deliveryId, data: payload });
  const { header } = signPayload(secret, body);
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IdealOne-Event': event,
        'X-IdealOne-Delivery': deliveryId,
        'X-IdealOne-Signature': header,
        'User-Agent': 'IdealOne-Webhook/1',
      },
      body,
      signal: ctrl.signal,
    });
    // A 2xx is the ONLY success. Anything else is the receiver telling us it
    // did not take it, and is retried — the "a 200 is not a success" lesson
    // from the hub, applied in the other direction.
    const text = await r.text().catch(() => '');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      ms: Date.now() - started,
      reply: text.slice(0, 200),
      error: (r.status >= 200 && r.status < 300) ? '' : `HTTP ${r.status}`,
    };
  } catch (e) {
    return {
      ok: false, status: 0, ms: Date.now() - started, reply: '',
      error: e.name === 'AbortError' ? `no reply within ${Math.round(timeoutMs / 1000)}s` : e.message,
    };
  } finally { clearTimeout(timer); }
}

module.exports = {
  KEY_PREFIX, SCOPES, SCOPE_LABEL,
  mintApiKey, hashApiKey, keyTail, findApiKey, hasScope, sameSecret,
  EVENTS, EVENT_LABEL,
  signPayload, verifySignature, mintHookSecret, deliverOnce,
};
