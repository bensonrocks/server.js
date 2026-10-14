// DRIVER: RECEIVER SIGNS THE DO BEFORE SCAN-TO-CLOSE (lib/driver-sign.js,
// lib/driver-scan.js proofCheck, server routes, signed DO PDF).
'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), crypto = require('crypto');
const { spawn } = require('child_process');
const sign = require('../lib/driver-sign');
const ds = require('../lib/driver-scan');
const { buildDeliveryOrderPdf } = require('../lib/delivery-order');

let PNG;
before(async () => { PNG = await require('bwip-js').toBuffer({ bcid: 'code128', text: 'SIGNATURE', scale: 2, height: 8 }); });
const dataUrl = b => 'data:image/png;base64,' + b.toString('base64');
const images = buf => (buf.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length;

describe('lib/driver-sign', () => {
  test('flag off by default; proof mode defaults to signature', () => {
    assert.equal(sign.signRequiredOn({}), false); assert.equal(sign.signRequiredOn({ DRIVER_SIGN_REQUIRED: 'on' }), true);
    assert.equal(sign.proofMode({}), 'signature'); assert.equal(sign.proofMode({ DRIVER_POD_PROOF: 'Either' }), 'either'); assert.equal(sign.proofMode({ DRIVER_POD_PROOF: 'x' }), 'signature');
  });
  test('proofMissing per mode', () => {
    const none = {}, sig = { podSignature: { file: 'a.png' } }, pho = { podPhotos: [{}] }, both = { ...sig, ...pho };
    assert.equal(sign.proofMissing(none), 'Get the receiver to sign the DO first.');
    assert.equal(sign.proofMissing(pho), 'Get the receiver to sign the DO first.');
    assert.equal(sign.proofMissing(sig), null);
    assert.equal(sign.proofMissing(sig, 'photo'), 'Take a photo of the signed DO first.'); assert.equal(sign.proofMissing(pho, 'photo'), null);
    assert.equal(sign.proofMissing(pho, 'either'), null); assert.equal(sign.proofMissing(none, 'either'), 'Get the receiver to sign the DO first.');
    assert.equal(sign.proofMissing(sig, 'both'), 'Take a photo of the signed DO too.'); assert.equal(sign.proofMissing(both, 'both'), null);
  });
  test('validateSignature: name, PNG, size cap', () => {
    assert.equal(sign.validateSignature({ dataUrl: dataUrl(PNG), receiverName: ' Tan  Mei Ling ' }).name, 'Tan Mei Ling');
    assert.match(sign.validateSignature({ dataUrl: dataUrl(PNG), receiverName: 'x' }).error, /name/);
    assert.match(sign.validateSignature({ dataUrl: 'data:image/jpeg;base64,AAAA', receiverName: 'Tan' }).error, /No signature/);
    assert.match(sign.validateSignature({ dataUrl: dataUrl(Buffer.alloc(500, 1)), receiverName: 'Tan' }).error, /not a valid PNG/);
    assert.match(sign.validateSignature({ dataUrl: dataUrl(Buffer.concat([PNG, Buffer.alloc(70000)])), receiverName: 'Tan' }).error, /too large/);
  });
  test('scanClose refuses without proof and changes nothing; closes once signed', () => {
    const t = [{ id: 'T1', referenceId: 'ORD-1', assignedDriver: 'D1', routeNum: 1, status: 'in-transit' }, { id: 'T2', referenceId: 'ORD-2', assignedDriver: 'D1', routeNum: 1, status: 'in-transit' }];
    const run = () => ds.scanClose({ transport: t, driverId: 'D1', anchorJobId: 'T1', code: 'IO-DLV:ORD-2', orderFor: () => null, proofCheck: j => sign.proofMissing(j) });
    const before = JSON.stringify(t); let r = run();
    assert.equal(r.result, 'needs_signature'); assert.equal(r.status, 409); assert.match(r.message, /^Get the receiver to sign the DO first\./); assert.equal(r.job.id, 'T2');
    assert.equal(JSON.stringify(t), before);
    t[0].podSignature = { file: 'x.png' };            // signing ORD-1 does not unlock ORD-2 (per DO)
    assert.equal(run().result, 'needs_signature');
    t[1].podSignature = { file: 'y.png' }; r = run(); assert.equal(r.result, 'closed'); assert.equal(t[1].status, 'delivered');
  });
  test('signed DO PDF stamps the signature image; unsigned has only the QR', async () => {
    const order = { order_number: 'ORD-1', lines: [{ sku: 'A', qty: 1 }] };
    const plain = await buildDeliveryOrderPdf({ order, clientName: 'T' });
    const signed = await buildDeliveryOrderPdf({ order, clientName: 'T', signature: { png: PNG, receiverName: 'Tan Mei Ling', signedAt: '2026-10-15T02:05:00Z' } });
    assert.ok(images(signed) > images(plain));
    assert.ok(signed.toString('latin1').includes('E-SIGNED ON DRIVER APP') || signed.length > plain.length);
  });
});

// ── booted server ──
const SERVER = path.join(__dirname, '..', 'server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
async function boot(DDIR, env) {
  const PORT = await freePort(); const B = `http://127.0.0.1:${PORT}`;
  const log = fs.openSync(path.join(DDIR, 'server.log'), 'a');
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR, MASTER_KEY: 'mk-sign', ...env }, stdio: ['ignore', log, log] });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/ping')).ok) return { B, child }; } catch {} await sleep(500); }
  child.kill(); throw new Error('server did not start');
}
const stop = c => new Promise(r => { c.once('exit', r); c.kill('SIGTERM'); setTimeout(r, 5000); });
const J = { 'Content-Type': 'application/json' };

async function seeded(env) {
  const DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idealone-dsign-'));
  const first = await boot(DDIR, {}); await sleep(800); await stop(first.child);
  const f = path.join(DDIR, 'tenants', 'default', 'db.json');
  const db = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  const salt = crypto.randomBytes(16).toString('hex');
  db.drivers = [{ id: 'DRV-T', name: 'Test Driver', status: 'active', pinSalt: salt, pinHash: crypto.scryptSync('4321', salt, 64).toString('hex') }];
  db.transport = ['ORD-1', 'ORD-2'].map((r, i) => ({ id: 'T' + (i + 1), referenceId: r, assignedDriver: 'DRV-T', routeNum: 1, stopSeq: i + 1, status: 'in-transit', driverAcceptedAt: 'x', shipping: { addressLine1: '1 Test Rd', zip: '123456' } }));
  db.batches = [{ id: 'B1', client_name: 'T', uploaded_at: new Date().toISOString(), orders: [{ order_number: 'ORD-1', lines: [{ sku: 'A', qty: 1 }] }] }];
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(db));
  const srv = await boot(DDIR, env);
  const lg = await (await fetch(srv.B + '/api/driver/login', { method: 'POST', headers: J, body: JSON.stringify({ id: 'DRV-T', pin: '4321' }) })).json();
  return { DDIR, srv, H: { ...J, 'x-auth-token': lg.token } };
}

describe('server: signature required before scan-to-close (flag on)', () => {
  let ctx;
  before(async () => { ctx = await seeded({ DRIVER_SCAN_CLOSE: '1', DRIVER_SIGN_REQUIRED: '1' }); });
  after(async () => { if (ctx) { await stop(ctx.srv.child); fs.rmSync(ctx.DDIR, { recursive: true, force: true }); } });

  test('refused unsigned → sign → closes; per order; stored on disk not in db; signed DO', async () => {
    const { srv, H, DDIR } = ctx;
    const feats = (await (await fetch(srv.B + '/api/driver/jobs', { headers: H })).json()).features;
    assert.equal(feats.signRequired, true); assert.equal(feats.proofMode, 'signature');
    const scan = c => fetch(srv.B + '/api/driver/scan-close', { method: 'POST', headers: H, body: JSON.stringify({ jobId: 'T1', code: 'IO-DLV:' + c }) });
    let r = await scan('ORD-1'); assert.equal(r.status, 409);
    let d = await r.json(); assert.equal(d.result, 'needs_signature'); assert.match(d.message, /Get the receiver to sign the DO first/); assert.equal(d.jobId, 'T1');
    const sig = (id, b) => fetch(srv.B + `/api/driver/jobs/${id}/signature`, { method: 'POST', headers: H, body: JSON.stringify(b) });
    assert.equal((await sig('T1', { dataUrl: dataUrl(PNG), receiverName: '' })).status, 400);
    assert.equal((await sig('T1', { dataUrl: 'data:image/png;base64,AAAA', receiverName: 'Tan' })).status, 400);
    r = await sig('T1', { dataUrl: dataUrl(PNG), receiverName: 'Tan Mei Ling', lat: 1.35, lng: 103.94 }); assert.equal(r.status, 200);
    r = await scan('ORD-2'); assert.equal((await r.json()).result, 'needs_signature');     // per DO
    r = await scan('ORD-1'); assert.equal(r.status, 200); assert.equal((await r.json()).result, 'closed');
    assert.equal((await sig('T1', { dataUrl: dataUrl(PNG), receiverName: 'Late Change' })).status, 409);   // locked after delivery
    const files = fs.readdirSync(path.join(DDIR, 'pod_photos', 'T1')).filter(n => /^sig-.*\.png$/.test(n));
    assert.equal(files.length, 1);                                   // on disk, not in db
    const img = await fetch(srv.B + '/api/driver/jobs/T1/signature', { headers: H }); assert.equal(img.status, 200);
    assert.ok(Buffer.from(await img.arrayBuffer()).equals(PNG));
    assert.equal((await fetch(srv.B + '/api/driver/jobs/T1/signature')).status, 401);
    // manual Mark Delivered is held to the same rule
    await fetch(srv.B + '/api/driver/jobs/T2/photo', { method: 'POST', headers: { 'x-auth-token': H['x-auth-token'] }, body: (() => { const f = new FormData(); f.append('photo', new Blob([PNG], { type: 'image/png' }), 'p.png'); return f; })() });
    r = await fetch(srv.B + '/api/driver/jobs/T2/deliver', { method: 'POST', headers: H, body: '{}' });
    assert.equal(r.status, 409); assert.match((await r.json()).error, /sign the DO/);
    // office DO for ORD-1 now carries the signature
    assert.ok((await fetch(srv.B + '/api/master/users', { method: 'POST', headers: { ...J, 'x-master-key': 'mk-sign' }, body: JSON.stringify({ id: 'ofc', password: 'pw-ofc-123', role: 'admin', name: 'O' }) })).ok);
    const tok = (await (await fetch(srv.B + '/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ id: 'ofc', password: 'pw-ofc-123' }) })).json()).token;
    const tj = (await (await fetch(srv.B + '/api/transport', { headers: { 'x-auth-token': tok } })).json());
    const ps = (tj.transportRequests || tj.jobs || tj).find(t => t.id === 'T1').podSignature;
    assert.equal(ps.receiverName, 'Tan Mei Ling'); assert.equal(ps.driver, 'DRV-T'); assert.deepEqual(ps.location, { lat: 1.35, lng: 103.94, accuracy: null });
    const pdf = Buffer.from(await (await fetch(srv.B + '/api/orders/ORD-1/do', { headers: { 'x-auth-token': tok } })).arrayBuffer());
    assert.equal(pdf.slice(0, 5).toString(), '%PDF-'); assert.ok(images(pdf) >= 2);
  });
});

describe('server: flag off — nothing changes', () => {
  let ctx;
  before(async () => { ctx = await seeded({ DRIVER_SCAN_CLOSE: '1' }); });
  after(async () => { if (ctx) { await stop(ctx.srv.child); fs.rmSync(ctx.DDIR, { recursive: true, force: true }); } });
  test('scan closes without a signature; signature route is off', async () => {
    const { srv, H } = ctx;
    const r = await fetch(srv.B + '/api/driver/scan-close', { method: 'POST', headers: H, body: JSON.stringify({ jobId: 'T1', code: 'IO-DLV:ORD-1' }) });
    assert.equal((await r.json()).result, 'closed');
    assert.equal((await fetch(srv.B + '/api/driver/jobs/T2/signature', { method: 'POST', headers: H, body: JSON.stringify({ dataUrl: dataUrl(PNG), receiverName: 'Tan' }) })).status, 404);
  });
});

// ── OFFICE OVERRIDE ──
describe('lib: office override', () => {
  test('reasons, Other needs text, override satisfies proof', () => {
    assert.equal(sign.validateOverride({}).ok, false);
    assert.equal(sign.validateOverride({ reason: 'refused' }).text, 'Receiver refused to sign');
    assert.equal(sign.validateOverride({ reason: 'security', note: 'Guard Ahmad' }).text, 'Receiver not present - left with security/guard (Guard Ahmad)');
    assert.match(sign.validateOverride({ reason: 'other', note: '' }).error, /Other/);
    assert.equal(sign.validateOverride({ reason: 'other', note: 'Shop closed, manager phoned' }).text, 'Shop closed, manager phoned');
    assert.equal(sign.proofMissing({ podOverride: { reason: 'x' } }), null);
    assert.equal(sign.overrideLine({ reason: 'Left at door per instruction', byName: 'Office', at: '2026-10-15T00:30:00Z' }), 'NOT SIGNED - office override: Left at door per instruction (Office, 15/10/2026 08:30 SGT)');
  });
  test('DO prints the override text instead of a signature', async () => {
    const buf = await buildDeliveryOrderPdf({ order: { order_number: 'O', lines: [{ sku: 'A', qty: 1 }] }, clientName: 'T', signature: { override: 'NOT SIGNED - office override: Receiver refused to sign (Office, 15/10/2026 08:30 SGT)' } });
    const plain = await buildDeliveryOrderPdf({ order: { order_number: 'O', lines: [{ sku: 'A', qty: 1 }] }, clientName: 'T' });
    assert.equal(images(buf), images(plain));
    assert.ok(buf.length > plain.length);
  });
});

describe('server: office override', () => {
  let ctx, mk;
  const MK = { ...J, 'x-master-key': 'mk-sign' };
  const staff = async (id, role) => {
    const c = await fetch(ctx.srv.B + '/api/master/users', { method: 'POST', headers: MK, body: JSON.stringify({ id, password: 'pw-' + id + '-123', role, name: id.toUpperCase() }) });
    if (role === 'driver' && !c.ok) return null;          // roster may not allow driver-role staff logins
    assert.ok(c.ok);
    return (await (await fetch(ctx.srv.B + '/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ id, password: 'pw-' + id + '-123' }) })).json()).token;
  };
  before(async () => { ctx = await seeded({ DRIVER_SCAN_CLOSE: '1', DRIVER_SIGN_REQUIRED: '1' }); });
  after(async () => { if (ctx) { if (ctx.srv) await stop(ctx.srv.child); fs.rmSync(ctx.DDIR, { recursive: true, force: true }); } });

  test('driver requests; only office roles override; then scan closes; DO + orders show it', async () => {
    const { srv, H } = ctx;
    const ov = (tok, id, b) => fetch(srv.B + `/api/transport/${id}/sign-override`, { method: 'POST', headers: { ...J, 'x-auth-token': tok }, body: JSON.stringify(b) });
    assert.equal((await fetch(srv.B + '/api/driver/jobs/T1/override-request', { method: 'POST', headers: H, body: JSON.stringify({ note: 'Receiver refused' }) })).status, 200);
    // driver token cannot override
    assert.ok([401, 403].includes((await ov(H['x-auth-token'], 'T1', { reason: 'refused' })).status));
    const drvRole = await staff('drvstaff', 'driver');
    if (drvRole) assert.equal((await ov(drvRole, 'T1', { reason: 'refused' })).status, 403);
    const wh = await staff('wh', 'warehouse'), adm = await staff('adm', 'admin');
    assert.equal((await ov(adm, 'T1', {})).status, 400);
    assert.equal((await ov(adm, 'T1', { reason: 'other' })).status, 400);
    let r = await ov(wh, 'T1', { reason: 'security', note: 'Guard Ahmad' }); assert.equal(r.status, 200);
    const po = (await r.json()).podOverride; assert.equal(po.by, 'wh'); assert.match(po.reason, /security\/guard \(Guard Ahmad\)/);
    // T2 still blocked (per order); T1 closes by scan
    const scan = c => fetch(srv.B + '/api/driver/scan-close', { method: 'POST', headers: H, body: JSON.stringify({ jobId: 'T1', code: 'IO-DLV:' + c }) });
    assert.equal((await (await scan('ORD-2')).json()).result, 'needs_signature');
    assert.equal((await (await scan('ORD-1')).json()).result, 'closed');
    assert.equal((await ov(adm, 'T1', { reason: 'refused' })).status, 409);           // already delivered
    // office views
    const tj = await (await fetch(srv.B + '/api/transport', { headers: { 'x-auth-token': adm } })).json();
    const t1 = (tj.transportRequests || tj.jobs || tj).find(t => t.id === 'T1');
    assert.equal(t1.podOverride.by, 'wh'); assert.ok(t1.podOverrideRequest.resolvedAt);
    const ord = await (await fetch(srv.B + '/api/orders', { headers: { 'x-auth-token': adm } })).json();
    const o1 = (ord.orders || ord).find(o => o.order_number === 'ORD-1');
    assert.match(o1.delivery_proof.override.reason, /security/);
    const pdf = Buffer.from(await (await fetch(srv.B + '/api/orders/ORD-1/do', { headers: { 'x-auth-token': adm } })).arrayBuffer());
    assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
    // audit
    await stop(srv.child); ctx.srv = null;                                  // flush, then read the audit log
    const db = JSON.parse(fs.readFileSync(path.join(ctx.DDIR, 'tenants', 'default', 'db.json'), 'utf8'));
    const a = (db.auditLog || []).find(x => x.type === 'driver_sign_override');
    assert.ok(a, 'audit recorded'); assert.equal(a.by, 'wh'); assert.equal(a.order, 'ORD-1'); assert.match(a.reason, /Guard Ahmad/);
    assert.ok((db.auditLog || []).some(x => x.type === 'driver_sign_override_requested'));
  });
});
