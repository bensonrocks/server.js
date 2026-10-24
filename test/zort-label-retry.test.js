'use strict';
const test = require('node:test');
const assert = require('node:assert');
const r = require('../lib/zort-label-retry.js');

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-24T00:00:00Z');

test('a browser crash whose text contains --password-store is NOT a login failure', () => {
  const crash = new Error('browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n<launching> /nix/store/chromium --disable-gpu --password-store=basic --use-mock-keychain\n[pid=123] <process did exit: exitCode=null, signal=SIGTRAP>');
  assert.strictEqual(r.classifyWebError(crash), 'browser');
  assert.strictEqual(r.isRealLoginFailure(crash), false);
});

test('launch failures and closed pages are browser errors', () => {
  for (const m of ['Chromium could not be launched — playwright download: Executable doesn\'t exist',
                   'browser worker unavailable — Chromium could not be launched',
                   'page.goto: Target closed', 'Protocol error (Page.navigate): Session closed',
                   'error while loading shared libraries: libnss3.so']) {
    assert.strictEqual(r.classifyWebError(new Error(m)), 'browser', m);
  }
  const tagged = new Error('anything about the password'); tagged.browserFailure = true;
  assert.strictEqual(r.classifyWebError(tagged), 'browser');
});

test('only a real sign-in rejection is a login failure', () => {
  const tagged = new Error('x'); tagged.loginRejected = true;
  assert.strictEqual(r.isRealLoginFailure(tagged), true);
  assert.strictEqual(r.isRealLoginFailure(new Error('the sign-in did not go through — check the web email/password on the store form')), true);
  assert.strictEqual(r.isRealLoginFailure(new Error('signed in, but the page still shows a sign-in form — check the ZORT web password on the store form')), true);
  assert.strictEqual(r.classifyWebError(new Error('signed in, but the label page produced no PDF — see the debug screenshot')), 'other');
  assert.strictEqual(r.classifyWebError(new Error('no ZORT web login on the store — add it on the store form')), 'other');
});

test('zort-web tags its sign-in rejections and launch failures', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../lib/zort-web.js'), 'utf8');
  assert.match(src, /loginRejected = true/);
  assert.match(src, /browserFailure = true/);
});

test('HTML-instead-of-PDF back-off is exponential and capped', () => {
  const l = r._limits();
  assert.strictEqual(r.unusableBackoffMs(1), l.base);
  assert.strictEqual(r.unusableBackoffMs(2), l.base * 2);
  assert.strictEqual(r.unusableBackoffMs(3), l.base * 4);
  assert.strictEqual(r.unusableBackoffMs(50), l.cap);
  assert.ok(r.unusableBackoffMs(4) <= l.cap);
});

test('entries park after N unusable attempts or once older than the window', () => {
  const fresh = { kind: 'label', createdAt: new Date(NOW - 3600e3).toISOString(), unusableFails: 1 };
  assert.strictEqual(r.shouldPark(fresh, NOW), false);
  assert.strictEqual(r.shouldPark({ ...fresh, unusableFails: r._limits().attempts }, NOW), true);
  assert.strictEqual(r.shouldPark({ kind: 'label', createdAt: new Date(NOW - 4 * DAY).toISOString() }, NOW), true);
  assert.strictEqual(r.shouldPark({ kind: 'stock', createdAt: new Date(NOW - 40 * DAY).toISOString() }, NOW), false);
});

test('one-time sweep parks the Aug backlog without deleting anything, and is idempotent', () => {
  const ob = [
    { id: 'a', kind: 'label', orderNumber: 'A1', createdAt: '2026-08-28T03:00:00Z', attempts: 913, lastError: 'ZORT has the label…', labelUrl: 'https://secure.zortout.com/x' },
    { id: 'b', kind: 'label', orderNumber: 'B1', createdAt: new Date(NOW - 3600e3).toISOString(), attempts: 25 },
    { id: 'c', kind: 'label', orderNumber: 'C1', createdAt: new Date(NOW - 3600e3).toISOString(), attempts: 2 },
    { id: 'd', kind: 'stock', sku: 'S', createdAt: '2026-08-01T00:00:00Z', attempts: 99 },
  ];
  const before = JSON.parse(JSON.stringify(ob));
  const parked = r.parkStaleLabels(ob, NOW);
  assert.deepStrictEqual(parked.map(e => e.id), ['a', 'b']);
  assert.strictEqual(ob.length, 4);
  for (const e of parked) {
    assert.strictEqual(e.needsManualLabel, true);
    assert.strictEqual(e.stalled, true);
    assert.ok(Date.parse(e.nextAttemptAt) > NOW + 300 * DAY);
  }
  // original data kept
  assert.strictEqual(ob[0].lastError, before[0].lastError);
  assert.strictEqual(ob[0].labelUrl, before[0].labelUrl);
  assert.strictEqual(ob[0].attempts, 913);
  assert.deepStrictEqual(ob[2], before[2]);
  assert.deepStrictEqual(ob[3], before[3]);
  assert.strictEqual(r.parkStaleLabels(ob, NOW).length, 0);
});

test('unpark clears the terminal state for an explicit operator retry', () => {
  const e = r.parkEntry({ kind: 'label', unusableFails: 9 }, 'x', NOW);
  r.unparkEntry(e);
  assert.strictEqual(e.needsManualLabel, undefined);
  assert.strictEqual(e.unusableFails, 0);
});

test('server.js no longer trips the login breaker on a bare /password/ match', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../server.js'), 'latin1');
  assert.doesNotMatch(src, /sign\.\?in\|password\|web email\|web login/);
  assert.match(src, /zortLabelRetry\.classifyWebError\(e\)/);
  assert.match(src, /zortLabelRetry\.parkStaleLabels\(ob, now\)/);
});

test('zort-web strips crash text so no caller can read it as a sign-in failure', () => {
  const zw = require('../lib/zort-web.js');
  const crash = new Error('page.goto: Target page, context or browser has been closed\nBrowser logs:\n<launching> chromium --password-store=basic --use-mock-keychain');
  const out = zw._sanitiseBrowserError(crash);
  assert.strictEqual(out.browserFailure, true);
  assert.doesNotMatch(out.message, /sign.?in|password|web login/i);   // the web-label test route's check
  assert.strictEqual(r.isRealLoginFailure(out), false);
  const login = new Error('the sign-in did not go through'); login.loginRejected = true;
  assert.strictEqual(zw._sanitiseBrowserError(login), login);
  const own = new Error('no ZORT web login on the store — add it on the store form');
  assert.strictEqual(zw._sanitiseBrowserError(own), own);
});
