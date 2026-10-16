'use strict';
const test = require('node:test');
const assert = require('node:assert');
const push = require('../lib/push');
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/x1234567', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0', auth: 'tBHItJI5svbpez7KI4CCXg' } };
test('push is off without VAPID keys', () => {
  delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;
  assert.strictEqual(push.enabled(), false);
  assert.strictEqual(push.publicKey(), null);
});
test('rejects non-https / malformed subscriptions', () => {
  assert.strictEqual(push.cleanSubscription({ endpoint: 'http://x/abcdefghij', keys: SUB.keys }), null);
  assert.strictEqual(push.cleanSubscription({ endpoint: SUB.endpoint, keys: { p256dh: 'x', auth: 'y' } }), null);
  assert.ok(push.cleanSubscription(SUB));
});
test('upsert replaces by endpoint, defaults portal alerts on, remove scoped to user', () => {
  const db = {};
  push.upsert(db, { surface: 'portal', client: 'A', userId: 'u1', subscription: SUB });
  const r = push.upsert(db, { surface: 'portal', client: 'A', userId: 'u1', subscription: SUB, alerts: { low_stock: false, bogus: true } });
  assert.strictEqual(db.push_subscriptions.length, 1);
  assert.deepStrictEqual(r.alerts, { low_stock: false });
  assert.strictEqual(push.forUser(db, 'portal', 'u1', 'a').length, 1);
  assert.strictEqual(push.remove(db, SUB.endpoint, 'someone-else'), false);
  assert.strictEqual(push.remove(db, SUB.endpoint, 'u1'), true);
});
test('sendToSubscribers is a no-op when push is off', async () => {
  const out = await push.sendToSubscribers([{ ...SUB, alerts: { low_stock: true } }], 'low_stock', { title: 't' });
  assert.deepStrictEqual(out, { sent: 0, failed: 0, gone: [] });
});
