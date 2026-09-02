'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// THE BROWSER-AUTOMATION WORKER — marketplace labels ZORT keeps behind its
// web login.
//
// Proven live (28 Aug 2026, per-hop diagnostics): the v4 API does NOT expose
// the Lazada shipping-label PDF. `GetShipmentLabels` hands out a link to
// secure.zortout.com's print-viewer page — a script-shell browser app whose
// PDF loads only inside a signed-in session; the order carries no files and
// no other endpoint serves the bytes. So, per the user ("proceed with the
// browser-automation worker"), this module does what a person at a browser
// does: signs in ONCE with the store's ZORT WEB credentials (webEmail /
// webPassword on the store record — a different secret from the API keys),
// keeps the session on disk, opens the label page, and captures the PDF the
// page loads.
//
// HONEST FRAGILITY, stated up front: this automates a web page ZORT can
// change without notice. Every failure therefore reports itself in words
// (and a debug screenshot on disk) instead of retrying silently — and if
// ZORT ever answers the support question with a real API endpoint, this
// whole module becomes deletable.
//
// Discipline:
//  • ONE browser, launched lazily, closed after ZORT_WEB_IDLE_MS of quiet —
//    Chromium is the heaviest thing in this process and must never idle hot.
//  • The session (cookies/storage) persists at DATA_DIR/zort-web/<storeId>.json
//    so a restart does not re-login, and re-login happens only when the saved
//    session stops working.
//  • Credentials go ONLY to secure.zortout.com pages inside the sandboxed
//    browser context. They are never logged, never in an error message, never
//    in a screenshot filename.
//  • A LOGIN FAILURE TRIPS A BREAKER (store.webLoginFailed set by the caller):
//    wrong credentials must not be hammered — ZORT would lock the account.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const ZORT_WEB_BASE = process.env.ZORT_WEB_BASE || 'https://secure.zortout.com';
const ZORT_WEB_IDLE_MS = Number(process.env.ZORT_WEB_IDLE_MS || 60000);
const ZORT_WEB_NAV_TIMEOUT = Number(process.env.ZORT_WEB_NAV_TIMEOUT || 45000);
const ZORT_WEB_PDF_WAIT_MS = Number(process.env.ZORT_WEB_PDF_WAIT_MS || 25000);

let _pw = null, _pwErr = '';
function _playwright() {
  if (_pw || _pwErr) return _pw;
  try { _pw = require('playwright'); }
  catch (e) { _pwErr = e.message; }
  return _pw;
}

// Is the worker usable at all on this deployment?
function available() {
  if (process.env.ZORT_BROWSER_DISABLED === 'true') return { ok: false, why: 'disabled by ZORT_BROWSER_DISABLED' };
  if (!_playwright()) return { ok: false, why: `playwright is not installed (${_pwErr})` };
  return { ok: true };
}

let _browser = null, _idleTimer = null, _launching = null;
async function _getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_launching) return _launching;
  const pw = _playwright();
  if (!pw) throw new Error(`playwright is not installed (${_pwErr})`);
  _launching = (async () => {
    const opts = {
      headless: true,
      // Containers have no sandbox user namespace and a tiny /dev/shm.
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    };
    if (process.env.ZORT_BROWSER_PATH) opts.executablePath = process.env.ZORT_BROWSER_PATH;
    _browser = await pw.chromium.launch(opts);
    return _browser;
  })();
  try { return await _launching; } finally { _launching = null; }
}
function _touchIdle() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    const b = _browser; _browser = null;
    if (b) b.close().catch(() => {});
  }, ZORT_WEB_IDLE_MS);
  if (_idleTimer.unref) _idleTimer.unref();
}

function _stateDir() {
  const dir = path.join(process.env.DATA_DIR || '.', 'zort-web');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}
const _statePath = storeId => path.join(_stateDir(), `${storeId}.json`);
const _shotPath  = storeId => path.join(_stateDir(), `debug-${storeId}.png`);

// The login form's selectors are NOT verifiable from the build sandbox
// (secure.zortout.com is egress-blocked there), so the fill is deliberately
// generic — first email/text input, first password input, then submit — and
// success is judged by OUTCOME (the label page serving its PDF), never by
// guessing what the dashboard looks like. A failure leaves a screenshot.
async function _tryLogin(page, store) {
  await page.goto(`${ZORT_WEB_BASE}/login`, { waitUntil: 'domcontentloaded', timeout: ZORT_WEB_NAV_TIMEOUT })
    .catch(() => page.goto(ZORT_WEB_BASE, { waitUntil: 'domcontentloaded', timeout: ZORT_WEB_NAV_TIMEOUT }));
  await page.waitForTimeout(1500);   // give a script-shell login screen time to render
  const user = page.locator('input[type="email"], input[type="text"], input[name*="mail" i], input[name*="user" i]').first();
  const pass = page.locator('input[type="password"]').first();
  if (!(await pass.count())) throw new Error('no password field found on the sign-in page — ZORT may have changed their login');
  await user.fill(String(store.webEmail || ''), { timeout: 8000 });
  await pass.fill(String(store.webPassword || ''), { timeout: 8000 });
  const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")').first();
  if (await submit.count()) await submit.click({ timeout: 8000 }).catch(() => {});
  else await pass.press('Enter').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: ZORT_WEB_NAV_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(2000);
  // Still on a page with a password box = the login did not take.
  if (await page.locator('input[type="password"]').count()) {
    throw new Error('the sign-in did not go through — check the web email/password on the store form (an OTP or captcha on the account would also stop it)');
  }
}

// Open one label page and capture the PDF its scripts load. Returns
// { pdf } or throws with a reason in words. `firstAttempt` controls whether a
// failed session is retried with a fresh login (once, never a loop).
async function fetchLabelPdfViaBrowser(store, pageUrl, { _retried } = {}) {
  const avail = available();
  if (!avail.ok) throw new Error(`browser worker unavailable — ${avail.why}`);
  if (!store.webEmail || !store.webPassword) throw new Error('no ZORT web login on the store — add it on the store form');
  if (!/^https?:\/\//i.test(String(pageUrl))) throw new Error('no label page URL to open');

  const browser = await _getBrowser();
  _touchIdle();
  const statePath = _statePath(store.id);
  const hasState = fs.existsSync(statePath);
  const context = await browser.newContext({
    ...(hasState ? { storageState: statePath } : {}),
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  try {
    // THE CAPTURE IS NETWORK-LEVEL, not screen-level: whatever request the
    // viewer makes that answers a PDF IS the label, pixel-identical to what a
    // person would download.
    //
    // It is done by ROUTING, not by listening: a page's own script consumes
    // the response body stream, so `response.body()` on a listener came back
    // EMPTY (0 bytes — caught in testing). Routing lets US fetch the response,
    // keep the bytes, and hand the same bytes on to the page, so nothing is
    // raced away. A download event is caught too, for viewers that save.
    let pdfBuf = null;
    let resolvePdf; const gotPdf = new Promise(r => { resolvePdf = r; });
    await context.route('**/*', async (route) => {
      const req = route.request();
      const looksPdf = /\.pdf(\?|$)|label|shippinglabel|documenttype=shippinglabel/i.test(req.url());
      if (pdfBuf || (!looksPdf && req.resourceType() !== 'document')) { return route.continue().catch(() => {}); }
      try {
        const resp = await route.fetch();
        const ct = String(resp.headers()['content-type'] || '');
        if (!pdfBuf && (/pdf|octet-stream/i.test(ct) || /\.pdf(\?|$)/i.test(req.url()))) {
          const body = await resp.body();
          if (body && body.slice(0, 1024).includes('%PDF')) { pdfBuf = body; resolvePdf(); }
          return route.fulfill({ response: resp, body }).catch(() => {});
        }
        return route.fulfill({ response: resp }).catch(() => route.continue().catch(() => {}));
      } catch (_) { return route.continue().catch(() => {}); }
    });
    page.on('download', async (dl) => {
      try {
        if (pdfBuf) return;
        const p = await dl.path();
        if (p) { const body = fs.readFileSync(p); if (body.slice(0, 1024).includes('%PDF')) { pdfBuf = body; resolvePdf(); } }
      } catch (_) {}
    });

    const openAndWait = async () => {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: ZORT_WEB_NAV_TIMEOUT }).catch(() => {});
      await Promise.race([gotPdf, page.waitForTimeout(ZORT_WEB_PDF_WAIT_MS)]);
    };

    await openAndWait();
    if (!pdfBuf) {
      // Maybe the session is stale or was never made — sign in and try once
      // more. ONE re-login, never a loop: a wrong password hammered at their
      // login is how the account gets locked.
      if (_retried) throw new Error('signed in, but the label page produced no PDF — see the debug screenshot');
      const looksSignedOut = (await page.locator('input[type="password"]').count()) > 0;
      await _tryLogin(page, store);
      await context.storageState({ path: statePath });
      await openAndWait();
      if (!pdfBuf) {
        try { await page.screenshot({ path: _shotPath(store.id), fullPage: false }); } catch (_) {}
        throw new Error(looksSignedOut
          ? 'signed in, but the label page still produced no PDF — see the debug screenshot on the server'
          : 'the label page loaded but produced no PDF within the wait — see the debug screenshot on the server');
      }
    }
    // A good session is worth keeping — refresh it on every success too.
    await context.storageState({ path: statePath }).catch(() => {});
    return { pdf: pdfBuf };
  } finally {
    await context.close().catch(() => {});
    _touchIdle();
  }
}

// ── CAPTURE ONE PAGE, SO THE NEXT STEP IS BUILT ON EVIDENCE ────────────────
// The worker above can only open a label page that ALREADY EXISTS. For a
// Lazada marketplace order that page only comes into being once somebody
// presses ZORT's own Marketplace → "Print shipping label (PDF)", which spawns
// an async "Lazada Label" task — and no route in their v4 collection triggers
// it. So the one manual step left in the daily run is the one thing nothing
// here can do, and closing it means driving that button the way a person does.
//
// WHICH REQUIRES SEEING THE PAGE FIRST. secure.zortout.com is egress-blocked
// from the build sandbox, so writing a click against a guessed DOM would be
// `Order/PackOrder` all over again — an interface invented rather than
// observed, reporting success while changing nothing. This captures the real
// thing instead: sign in, open the page the operator is standing on, and save
// the HTML and a screenshot, plus a digest of every control that looks like it
// prints a label.
//
// READ-ONLY BY CONSTRUCTION — it navigates and reads. It clicks NOTHING, so it
// can never print, RTS, or alter an order while we are only looking.
const _CTRL_PAT = /print|label|awb|waybill|shipping|ship|marketplace|task/i;
async function capturePage(store, pageUrl, { _retried } = {}) {
  const avail = available();
  if (!avail.ok) throw new Error(`browser worker unavailable — ${avail.why}`);
  if (!store.webEmail || !store.webPassword) throw new Error('no ZORT web login on the store — add it on the store form');
  if (!/^https?:\/\//i.test(String(pageUrl))) throw new Error('give the full https URL of the ZORT page you press Print on');

  const browser = await _getBrowser();
  _touchIdle();
  const statePath = _statePath(store.id);
  const hasState = fs.existsSync(statePath);
  const context = await browser.newContext({
    ...(hasState ? { storageState: statePath } : {}),
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: ZORT_WEB_NAV_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: ZORT_WEB_NAV_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(2500);           // a script shell needs time to paint

    // A password box means the saved session is gone or was never made. Sign in
    // ON THIS CONTEXT — a login done in a throwaway context sets its cookie in
    // a jar we then discard, so the re-navigation lands right back on the login
    // screen and we capture THAT, which is worse than useless: it looks like a
    // page with no print button on it. Persist the state, then go back.
    // ONE re-login, never a loop — a hammered wrong password locks the account
    // — and the login's own error is allowed OUT, so a bad password says so
    // rather than silently returning a screenshot of the sign-in form.
    if (await page.locator('input[type="password"]').count()) {
      if (_retried) throw new Error('signed in, but the page still shows a sign-in form — check the ZORT web password on the store form');
      await _tryLogin(page, store);
      await context.storageState({ path: statePath });
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: ZORT_WEB_NAV_TIMEOUT });
      await page.waitForLoadState('networkidle', { timeout: ZORT_WEB_NAV_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(2500);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const htmlPath = path.join(_stateDir(), `capture-${store.id}-${stamp}.html`);
    const shotPath = path.join(_stateDir(), `capture-${store.id}-${stamp}.png`);
    const html = await page.content();
    fs.writeFileSync(htmlPath, html);
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

    // Every clickable thing whose words suggest it prints a label — with a
    // selector that would actually find it again. This is the list the click
    // gets written against.
    const controls = await page.evaluate((patSrc) => {
      const pat = new RegExp(patSrc, 'i');
      const out = [];
      const els = document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], li, span[onclick], div[onclick]');
      for (const el of els) {
        const text = (el.innerText || el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        if (!text || !pat.test(text)) continue;
        const sel = el.id ? `#${el.id}`
          : el.getAttribute('data-testid') ? `[data-testid="${el.getAttribute('data-testid')}"]`
          : el.className && typeof el.className === 'string' ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
          : el.tagName.toLowerCase();
        out.push({ tag: el.tagName.toLowerCase(), text, selector: sel, href: el.getAttribute?.('href') || '' });
        if (out.length >= 40) break;
      }
      return out;
    }, _CTRL_PAT.source).catch(() => []);

    await context.storageState({ path: statePath }).catch(() => {});
    return {
      url: page.url(), title: await page.title().catch(() => ''),
      bytes: html.length, htmlPath, shotPath, controls,
      frames: page.frames().length,
    };
  } finally {
    await context.close().catch(() => {});
    _touchIdle();
  }
}

// The breaker's other half: forget a saved session (called when credentials
// are re-saved on the store form, so the next attempt starts clean).
function forgetSession(storeId) {
  try { fs.unlinkSync(_statePath(storeId)); } catch (_) {}
}

module.exports = { available, fetchLabelPdfViaBrowser, capturePage, forgetSession, ZORT_WEB_BASE };
