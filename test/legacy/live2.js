// The two orders actually in dispute, reconstructed from the client's own
// report. The portal prints a cancellation time of 10:31 for both; under the
// build that is live, the ONLY field that could have supplied that time is
// `updated_at` — because if `unprocessed_at` existed, that build would already
// have counted them. So this is their shape, and it is the marketplace-void one.
const fs = require('fs');
const DB = __dirname + '/sup/tenants/default/db.json';
const BASE = 'http://localhost:4636', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sg = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

if (process.argv[2] === 'seed') {
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  db.batches = (db.batches || []).filter(b => !String(b.id).startsWith('live2-'));
  const now = new Date();
  const dayAgo = n => new Date(now.getTime() - n * 86400000).toISOString();
  const at1031 = new Date(now.getTime() - 3 * 3600000).toISOString();  // earlier today
  const rows = [
    ['169982235496068', 4, 'FS041DRXXXDGML',    'LZSGD1015243049'],
    ['171550583209785', 3, '18-90-MDA-HEPA500', 'LZSGD1015243137'],
    // …and one of the three the office already showed, as the control.
    ['170169657956078', 0, 'FD310XXXXXWEML',    ''],
  ];
  for (const [num, daysAgo, sku, wb] of rows) {
    db.batches.unshift({
      id: 'live2-' + num, idealscan_code: 'LV-' + num.slice(-4), filename: 'zort-sync',
      client_name: 'Mayer2026', uploaded_by: 'zort-sync', uploaded_at: dayAgo(daysAgo),
      orders: [{ order_number: num, waybill_number: wb, lines: [{ sku, description: sku, qty: 1 }] }],
      // EXACTLY what handleZortVoid leaves behind: status + updated_at, no
      // unprocessed_at, no reason (hence the report's default "Not processed"),
      // no auto_cancelled (hence "By arrangement").
      orderStates: { [num]: { status: 'unprocessed', scanned: {}, updated_at: at1031 } },
    });
  }
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));
  console.log('seeded the two disputed orders + one control, in the void handler\'s exact shape');
  process.exit(0);
}

(async () => {
  const T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;
  const get = async q => {
    const r = await fetch(BASE + '/api/orders?' + q, { headers: { 'x-auth-token': T, 'x-master-key': MK } });
    const b = await r.json().catch(() => ({}));
    return (Array.isArray(b) ? b : (b.orders || []));
  };
  const want = ['169982235496068', '171550583209785', '170169657956078'];
  const today = (await get('range=today')).filter(o => want.includes(String(o.order_number)));
  ok(today.length === 3, `the office's Today window holds all three (${today.length})`);
  for (const n of want) ok(today.some(o => String(o.order_number) === n), `  ${n} is counted today`);
  ok(today.every(o => o.scan_status === 'unprocessed'), 'all three read as cancelled');
  ok(today.every(o => sg(o.unprocessed_at) === sg(new Date())),
     'each is dated by the day it was cancelled, not the day it arrived');
  ok(!today.some(o => o.client_cancelled), 'and none is mislabelled as a client withdrawal');
  const yest = (await get('range=yesterday')).filter(o => want.includes(String(o.order_number)));
  ok(yest.length === 0, 'none has leaked onto another day');
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
