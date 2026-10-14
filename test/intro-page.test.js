// Public /intro landing page: 200 with no auth, and / (login) still served.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const SERVER = process.env.IDEALONE_SERVER || path.join(__dirname, '..', 'server.js');
let DDIR, B, child;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
before(async () => {
  DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idealone-intro-'));
  const PORT = await freePort(); B = `http://127.0.0.1:${PORT}`;
  const log = fs.openSync(path.join(DDIR, 'server.log'), 'a');
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR }, stdio: ['ignore', log, log] });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/ping')).ok) return; } catch {} await sleep(500); }
  throw new Error('server did not come up');
});
after(async () => {
  if (child) { child.kill('SIGTERM'); await new Promise(r => { child.once('exit', r); setTimeout(r, 5000); }); }
  try { fs.rmSync(DDIR, { recursive: true, force: true }); } catch {}
});
test('GET /intro returns 200 without auth', async () => {
  const r = await fetch(B + '/intro');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /IdealOne/);
  assert.match(html, /href="\/portal"/);
  assert.doesNotMatch(html, /www\.idealone\.tech/);
  assert.match(html, /<link rel="canonical" href="https:\/\/idealone\.tech\/intro">/);
  assert.match(html, /property="og:url" content="https:\/\/idealone\.tech\/intro"/);
  assert.doesNotMatch(html, /nimbustrade/i, 'recipient address must not be exposed');
  assert.match(html, /Built for operations, by operations/);
  assert.match(html, /SGD 80/); assert.match(html, /SGD 500/); assert.match(html, /SGD 76/); assert.match(html, /SGD 73\.60/); assert.match(html, /SGD 72/);
  assert.doesNotMatch(html, /Contact for pricing/);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const app = ld.find(x => x['@type'] === 'SoftwareApplication');
  assert.deepEqual(app.offers.map(o => [o.price, o.priceCurrency]), [['80', 'SGD'], ['76', 'SGD'], ['73.60', 'SGD'], ['72', 'SGD'], ['500', 'SGD']]);
  assert.doesNotMatch(html, /zort|onecart|keyfields|shopee|lazada|tiktok/i, 'no named integration partners');
});
test('GET / still serves the login app', async () => {
  const r = await fetch(B + '/');
  assert.equal(r.status, 200);
});
test('POST /api/public/enquiry: no auth, validates, honeypot, stores', async () => {
  const post = b => fetch(B + '/api/public/enquiry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  let r = await post({ name: '', email: 'bad' });
  assert.equal(r.status, 400);
  r = await post({ name: 'Bot', company: 'Bot Co', email: 'b@b.co', website: 'spam' });
  assert.equal(r.status, 200);
  r = await post({ name: 'Ann Tan', company: 'Acme', email: 'ann@acme.sg' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true); assert.ok(j.id);
  await sleep(300);
  const g = JSON.parse(fs.readFileSync(path.join(DDIR, 'global.json'), 'utf8'));
  assert.equal(g.enquiries.length, 1);
  assert.equal(g.enquiries[0].company, 'Acme');
});
test('robots.txt allows /intro only', async () => {
  const t = await (await fetch(B + '/robots.txt')).text();
  assert.match(t, /Allow: \/intro/); assert.match(t, /Disallow: \/$/m);
});
test('robots.txt and sitemap.xml point at the apex idealone.tech', async () => {
  const robots = await (await fetch(B + '/robots.txt')).text();
  const sm = await (await fetch(B + '/sitemap.xml')).text();
  assert.doesNotMatch(robots, /www\.idealone\.tech/); assert.doesNotMatch(sm, /www\.idealone\.tech/);
  assert.match(robots, /^Sitemap: https:\/\/idealone\.tech\/sitemap\.xml$/m);
  assert.match(sm, /<loc>https:\/\/idealone\.tech\/intro<\/loc>/);
});
