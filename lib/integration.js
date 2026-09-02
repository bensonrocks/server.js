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
//
// THE KEY CARRIES ITS OWN LOOKUP ID: `iok_<12 hex id>_<32 hex secret>`.
// The id is stored in the CLEAR and the secret is hashed. Two reasons, and the
// second is the one that decided it:
//
//   1. VERIFICATION IS O(1). The first cut hashed the presented key against
//      EVERY stored key until one matched, so the cost of a request grew with
//      the number of keys issued — and with a deliberately slow hash (below)
//      that is a denial-of-service vector rather than a detail.
//   2. IT MAKES THE SLOW HASH AFFORDABLE. One scrypt per request is fine; N
//      per request is not. So the two changes are one change.
//
// SCRYPT, NOT SHA-256 — corrected after CodeQL flagged it, and it was right to.
// The entropy argument (a 128-bit random key is not a guessable password, so a
// fast hash is common practice for tokens) is TRUE and still not the point: this
// codebase already hashes its own passwords with scryptSync, and shipping a
// second, weaker discipline in the same repo is how the weaker one spreads.
// Matching the house standard costs one hash per request and ends the argument.
const KEY_PREFIX = 'iok_';
const KEY_ID_LEN = 12;                 // hex chars of the public, in-the-clear id

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
  const id     = crypto.randomBytes(KEY_ID_LEN / 2).toString('hex');
  // 128 bits of entropy in the secret half — the same strength as the ZORT
  // push token, the other secret in this system that travels in a header.
  const secret = crypto.randomBytes(16).toString('hex');
  return { key: `${KEY_PREFIX}${id}_${secret}`, id, secret };
}

// Splits a presented key into its public id and its secret. Returns null for
// anything not shaped like one of ours, so a malformed header never reaches
// the hash at all.
function parseApiKey(presented) {
  const raw = String(presented || '').trim();
  if (!raw.startsWith(KEY_PREFIX)) return null;
  const rest = raw.slice(KEY_PREFIX.length);
  const i = rest.indexOf('_');
  if (i !== KEY_ID_LEN) return null;
  const id = rest.slice(0, i), secret = rest.slice(i + 1);
  if (!/^[0-9a-f]+$/.test(id) || secret.length < 16) return null;
  return { id, secret };
}

// scryptSync — the SAME function server.js hashes user passwords with. Called
// at most ONCE per request thanks to the id lookup above.
function hashApiKey(secret, salt) {
  return crypto.scryptSync(String(secret), String(salt), 64).toString('hex');
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

// THERE IS DELIBERATELY NO `findApiKey` HERE. Verification lives in exactly
// ONE place — `verifyApiKey` in server.js — because it also owns the cache
// that stops scrypt being paid on every request. A second, cache-less verifier
// used to live here, and the two callers that both need to check a key (tenant
// resolution, which runs before the auth gate, and the auth gate itself) split
// between them, so the cache bought nothing. Do not add one back: give the
// caller the pieces below and let it go through the one verifier.

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
  mintApiKey, parseApiKey, hashApiKey, keyTail, hasScope, sameSecret,
  EVENTS, EVENT_LABEL,
  signPayload, verifySignature, mintHookSecret, deliverOnce,
};
