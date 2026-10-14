// Public sales enquiry: validation, honeypot, store-before-mail, mail mocked.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const enq = require('../lib/enquiry');
const good = { name: 'Ann Tan', company: 'Acme Pte Ltd', email: 'Ann@Acme.sg', phone: '+65 6123 4567',
  company_type: 'E-commerce brand', monthly_orders: '1,000 - 5,000', modules: ['Core OMS', 'WMS scan', 'bogus'], message: 'Hi\r\nthere <b>x</b>' };

test('validation rejects missing/invalid fields', () => {
  const v = enq.validateEnquiry({ name: '', company: '', email: 'nope', phone: 'abc', company_type: 'Alien' });
  assert.ok(v.errors.length >= 5);
});
test('sanitises input', () => {
  const { enquiry } = enq.validateEnquiry({ ...good, name: 'Ann\r\nBcc: evil@x.com' });
  assert.ok(!/[\r\n]/.test(enquiry.name));
  assert.equal(enquiry.email, 'ann@acme.sg');
  assert.deepEqual(enquiry.modules, ['Core OMS', 'WMS scan']);
  assert.ok(!/[<>]/.test(enquiry.message));
});
test('honeypot: accepted silently, nothing stored or mailed', async () => {
  let stored = 0, mailed = 0;
  const r = await enq.handleEnquiry({ ...good, website: 'http://spam' }, { store: () => stored++, sendMail: async () => mailed++ });
  assert.equal(r.status, 200); assert.equal(stored, 0); assert.equal(mailed, 0);
});
test('valid enquiry is stored and mailed to info@nimbustrade.co (mocked)', async () => {
  const saved = []; const sent = [];
  const r = await enq.handleEnquiry(good, { from: 'ops@x.sg', store: e => saved.push({ ...e }), sendMail: async m => sent.push(m) });
  assert.equal(r.status, 200); assert.equal(r.body.emailed, true);
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'info@nimbustrade.co'); assert.equal(sent[0].replyTo, 'ann@acme.sg');
  assert.match(sent[0].text, /Acme Pte Ltd/);
  assert.equal(saved[0].mail_status, 'pending'); assert.equal(saved.at(-1).mail_status, 'sent');
});
test('mail failure still stores the enquiry', async () => {
  const saved = [];
  const r = await enq.handleEnquiry(good, { store: e => saved.push({ ...e }), sendMail: async () => { throw new Error('smtp down'); } });
  assert.equal(r.status, 200); assert.equal(r.body.emailed, false);
  assert.equal(saved.at(-1).mail_status, 'failed');
});
test('invalid enquiry: 400, nothing stored', async () => {
  let stored = 0;
  const r = await enq.handleEnquiry({ name: 'x' }, { store: () => stored++, sendMail: null });
  assert.equal(r.status, 400); assert.equal(stored, 0);
});
