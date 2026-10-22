'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  DEMO_MODE guard. When DEMO_MODE=true this process is a sandboxed demo:
//   • MASTER_KEY must be set (no built-in fallback) — otherwise exit.
//   • ALL outbound network from Node (fetch, http/https, raw net/tls sockets)
//     is refused unless the target is loopback. That covers marketplace OAuth
//     token exchange, Zort/OneCart/Shopify APIs, OneMap, webhooks, Slack, SMTP
//     and the MySQL TMS pool.
//   • nodemailer transports are replaced with a stub that never sends.
//   • Integration / OAuth / webhook routes answer 403.
// Must be required BEFORE any other module opens a connection.
// ─────────────────────────────────────────────────────────────────────────────
const ENABLED = /^(1|true|yes)$/i.test(String(process.env.DEMO_MODE || ''));

function isLoopback(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h.startsWith('127.') || h === '' ;
}
function blockedError(what) {
  const e = new Error(`[DEMO_MODE] outbound ${what} blocked`);
  e.code = 'EDEMOBLOCKED';
  return e;
}

function install() {
  if (!ENABLED) return false;
  if (!process.env.MASTER_KEY || String(process.env.MASTER_KEY).length < 16) {
    console.error('[DEMO_MODE] MASTER_KEY must be set (>=16 chars) in demo mode — refusing to start.');
    process.exit(1);
  }
  const net = require('net'), tls = require('tls'), http = require('http'), https = require('https');

  const origFetch = globalThis.fetch;
  if (origFetch) {
    globalThis.fetch = async (input, init) => {
      let host = '';
      try { host = new URL(typeof input === 'string' ? input : (input && input.url) || String(input)).hostname; } catch {}
      if (!isLoopback(host)) { console.warn(`[DEMO_MODE] blocked fetch -> ${host}`); throw blockedError(`fetch to ${host}`); }
      return origFetch(input, init);
    };
  }
  for (const mod of [http, https]) {
    for (const fn of ['request', 'get']) {
      const orig = mod[fn];
      mod[fn] = function (...args) {
        let host = '';
        const a = args[0];
        try {
          if (typeof a === 'string' || a instanceof URL) host = new URL(String(a)).hostname;
          else if (a) host = a.hostname || a.host || '';
          if (!host && args[1] && typeof args[1] === 'object') host = args[1].hostname || args[1].host || '';
        } catch {}
        if (!isLoopback(host)) { console.warn(`[DEMO_MODE] blocked ${fn} -> ${host}`); throw blockedError(`http to ${host}`); }
        return orig.apply(this, args);
      };
    }
  }
  const wrapConnect = (mod, name) => {
    const orig = mod[name];
    mod[name] = function (...args) {
      const a = args[0];
      let host = (a && typeof a === 'object') ? (a.host || a.hostname || (a.path ? 'localhost' : '')) : (typeof args[1] === 'string' ? args[1] : 'localhost');
      if (typeof a === 'string') host = 'localhost'; // unix socket path
      if (!isLoopback(host)) { console.warn(`[DEMO_MODE] blocked socket -> ${host}`); throw blockedError(`socket to ${host}`); }
      return orig.apply(this, args);
    };
  };
  wrapConnect(net, 'connect'); wrapConnect(net, 'createConnection'); wrapConnect(tls, 'connect');

  try {
    const nodemailer = require('nodemailer');
    nodemailer.createTransport = () => ({
      sendMail: async () => { console.warn('[DEMO_MODE] email suppressed'); throw blockedError('email'); },
      verify: async () => { throw blockedError('email'); },
      close() {},
    });
  } catch {}
  console.log('[DEMO_MODE] enabled — outbound network, email and integrations are disabled.');
  return true;
}

// Routes that connect or configure real integrations. Reads stay allowed so
// the UI renders (empty lists); anything that would create/connect is 403.
const BLOCK_ALL = [/^\/api\/connect\//, /^\/oauth2callback/, /^\/api\/zort\/webhook\//, /^\/api\/master\/gmail\/(connect|test)/];
const BLOCK_WRITES = [/^\/api\/master\/(zort|shopify|onecart|marketplace|webhooks|gmail|email-settings|smtp)\b/];
function middleware(req, res, next) {
  if (!ENABLED) return next();
  const p = req.path;
  const write = req.method !== 'GET' && req.method !== 'HEAD';
  if (BLOCK_ALL.some(r => r.test(p)) || (write && BLOCK_WRITES.some(r => r.test(p)))) {
    return res.status(403).json({ error: 'Disabled in demo mode' });
  }
  next();
}

module.exports = { ENABLED, install, middleware, isLoopback };
