'use strict';
// ── ZORT LABEL RETRY POLICY ────────────────────────────────────────────────
// Two production failures this module exists to end:
//
//  1. A label browser that CRASHED ON START was read as a failed sign-in.
//     Playwright's crash/launch errors carry Chromium's command line, and that
//     line contains `--password-store=basic`, which the old /password/ regex
//     matched. The store's webLoginFailed breaker tripped on 28 Aug 2026 and
//     the browser was never used again. Only a REAL sign-in rejection may trip
//     the breaker now; a launch/crash is a transient browser error.
//
//  2. When ZORT's API hands us its HTML print viewer instead of a PDF, the
//     entry was retried every hour for ever (up to 913 attempts each, ~180
//     failures an hour across ~209 entries). Those now back off exponentially
//     and, after a cap or once they are too old, park in a terminal
//     "needs manual label" state that stops retrying but keeps every field.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const UNUSABLE_BASE_MS = () => num(process.env.ZORT_LABEL_UNUSABLE_BASE_MS, 15 * MIN);
const UNUSABLE_CAP_MS = () => num(process.env.ZORT_LABEL_UNUSABLE_CAP_MS, 6 * HOUR);
const MANUAL_AFTER_ATTEMPTS = () => num(process.env.ZORT_LABEL_MANUAL_AFTER, 8);
const MANUAL_AFTER_AGE_MS = () => num(process.env.ZORT_LABEL_MANUAL_AGE_MS, 3 * DAY);
const PARKED_MS = 365 * DAY;

// ── 1. WHAT KIND OF BROWSER FAILURE WAS IT ─────────────────────────────────
// 'login'   — ZORT's sign-in page rejected the saved credentials.
// 'browser' — Chromium failed to launch, crashed, or the page/context died.
// 'other'   — anything else (no PDF on the page, navigation timeout, …).
const BROWSER_PATTERNS = [
  /chromium could not be launched/i, /browser worker unavailable/i, /playwright is not installed/i,
  /browserType\.launch/i, /failed to launch/i, /crash/i, /has been closed/i, /target closed/i,
  /browser closed/i, /disconnected/i, /protocol error/i, /spawn /i, /ENOENT|EACCES|ENOMEM/,
  /error while loading shared libraries/i, /executable doesn't exist/i, /SIGTRAP|SIGKILL|SIGSEGV|SIGABRT/,
];
// The exact sentences lib/zort-web.js throws when the sign-in page refuses.
const LOGIN_PATTERNS = [
  /the sign-in did not go through/i,
  /still shows a sign-in form/i,
];
function classifyWebError(err) {
  if (err && err.loginRejected === true) return 'login';
  const msg = String((err && err.message) || err || '');
  // Browser failures are checked FIRST: their text can contain words like
  // "password" (Chromium's --password-store flag) that are not about signing in.
  if (err && err.browserFailure === true) return 'browser';
  if (BROWSER_PATTERNS.some(r => r.test(msg))) return 'browser';
  if (LOGIN_PATTERNS.some(r => r.test(msg))) return 'login';
  return 'other';
}
const isRealLoginFailure = err => classifyWebError(err) === 'login';

// ── 2. BACK-OFF AND THE TERMINAL STATE FOR UNUSABLE (HTML) LABELS ──────────
function unusableBackoffMs(fails) {
  const n = Math.max(1, Number(fails) || 1);
  return Math.min(UNUSABLE_CAP_MS(), UNUSABLE_BASE_MS() * Math.pow(2, n - 1));
}
function entryAgeMs(entry, now = Date.now()) {
  const t = Date.parse((entry && entry.createdAt) || '');
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}
// True when a label entry should stop being retried automatically.
function shouldPark(entry, now = Date.now()) {
  if (!entry || entry.kind !== 'label' || entry.needsManualLabel) return false;
  if ((entry.unusableFails || 0) >= MANUAL_AFTER_ATTEMPTS()) return true;
  return entryAgeMs(entry, now) > MANUAL_AFTER_AGE_MS();
}
function parkEntry(entry, reason, now = Date.now()) {
  entry.needsManualLabel = true;
  entry.manualLabelAt = new Date(now).toISOString();
  entry.manualLabelReason = String(reason || 'Label could not be fetched automatically').slice(0, 300);
  entry.stalled = true;
  entry.nextAttemptAt = new Date(now + PARKED_MS).toISOString();
  delete entry.webDeferredAt;
  return entry;
}
function unparkEntry(entry) {
  if (!entry) return entry;
  delete entry.needsManualLabel; delete entry.manualLabelAt; delete entry.manualLabelReason;
  entry.unusableFails = 0;
  return entry;
}
// One sweep that parks every label entry already past the age/attempt cap —
// how the backlog from 28 Aug goes straight to the terminal state on the first
// pass after deploy instead of being retried once more. Idempotent; deletes
// nothing. Old entries with a huge `attempts` count from the hourly ladder are
// parked on attempts too (>= 20 meant "stalled" under the old policy).
function parkStaleLabels(outbox, now = Date.now()) {
  const parked = [];
  for (const e of outbox || []) {
    if (!e || e.kind !== 'label' || e.needsManualLabel) continue;
    const old = entryAgeMs(e, now) > MANUAL_AFTER_AGE_MS();
    const worn = (e.attempts || 0) >= 20 || (e.unusableFails || 0) >= MANUAL_AFTER_ATTEMPTS();
    if (!old && !worn) continue;
    parkEntry(e, old ? 'Older than the auto-fetch window — print it from ZORT and upload the PDF on the Labels tab'
                     : 'Too many failed automatic fetches — print it from ZORT and upload the PDF on the Labels tab', now);
    parked.push(e);
  }
  return parked;
}

module.exports = {
  classifyWebError, isRealLoginFailure, unusableBackoffMs, shouldPark, parkEntry, unparkEntry,
  parkStaleLabels, entryAgeMs,
  _limits: () => ({ base: UNUSABLE_BASE_MS(), cap: UNUSABLE_CAP_MS(), attempts: MANUAL_AFTER_ATTEMPTS(), ageMs: MANUAL_AFTER_AGE_MS() }),
};
