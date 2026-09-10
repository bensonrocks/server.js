// E2E for POST /api/orders/backfill-gi through the REAL server.
// Seeds the exact stored shape the old parser left behind (BETIME orders keyed
// by 18-digit marketplace ids with issue_no BLANK), re-supplies the file, and
// asserts: only the blank GI is filled, state/scan counts/batches untouched, a
// differing stored GI is reported not overwritten, warehouse is refused, a PDF
// is refused, a GI-less file is refused, the scan bar finds the order by GI,
// the trail names it, and a second run is a no-op.
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('/home/user/server.js/node_modules/xlsx');

const S     = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const PORT  = 4744;
const B     = `http://localhost:${PORT}`;
const DDIR  = path.join(S, 'gib');
const DBP   = path.join(DDIR, 'tenants', 'default', 'db.json');
const MASTER = process.env.MASTER_KEY || '201432547E';

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let child = null;
async function boot() {
  child = spawn('node', ['/home/user/server.js/server.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
    stdio: ['ignore', fs.openSync(path.join(S, 'gib.log'), 'a'), fs.openSync(path.join(S, 'gib.log'), 'a')],
    detached: true,
  });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(B + '/api/version'); if (r.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error('server did not boot — see gib.log');
}
async function stop() {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  child = null;
  await sleep(1500);
}

const ORD = (order_number, issue_no, extra = {}) => ({
  order_number, issue_no, waybill_number: '', po_number: '', pick_ticket: '',
  customer_name: 'Buyer', carrier: 'TikTok', total_qty: 1, platform: 'TikTok',
  lines: [{ sku: '8006', description: 'Koli Pain Relief Plaster', qty: 1 }], ...extra,
});

function seed() {
  const db = JSON.parse(fs.readFileSync(DBP, 'utf8'));
  db.batches = [
    {
      id: 'batch-betime-old', idealscan_code: 'IS-260907-01', client_name: 'BETIME',
      filename: 'GI_Analysis_260907.xlsx', uploaded_at: new Date(Date.now() - 3600e3).toISOString(), uploaded_by: 'demo',
      orders: [
        ORD('585836014589150279', ''),            // blank — mid-pick, must be filled, state untouched
        ORD('585835366510593147', ''),            // blank — pending, must be filled
        ORD('GI-141032', ''),                     // GI-only row: file gives GI-141032 both ways
        ORD('585835424563889658', 'GI-999999'),   // CONFLICT — stored differs from file
        ORD('585835428307699034', 'GI-141041'),   // already had it
      ],
      orderStates: {
        '585836014589150279': { status: 'processing', scanned: { '8006': 1 }, startTime: new Date().toISOString(), claimedBy: 'demo', claimedAt: new Date().toISOString() },
      },
    },
    {
      id: 'batch-other', idealscan_code: 'IS-260907-02', client_name: 'OTHERCO',
      filename: 'other.xlsx', uploaded_at: new Date().toISOString(), uploaded_by: 'demo',
      orders: [ORD('X-1', '')], orderStates: {},
    },
  ];
  db.orderLabels = {}; db.labelImports = [];
  fs.writeFileSync(DBP, JSON.stringify(db, null, 2));
}

function xlsxOf(rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
// THE REPORTED SHAPE: "GI No" + a populated "Reference" (marketplace order id).
const FILE = xlsxOf([
  { 'GI No': 'GI-141037', 'Reference': '585836014589150279', 'Account': 'BETIME', 'SKU Code': '8006', 'Quantity': 1 },
  { 'GI No': 'GI-141038', 'Reference': '585835366510593147', 'Account': 'BETIME', 'SKU Code': '8006', 'Quantity': 1 },
  // A genuinely BLANK Reference cell (no key → no cell). An empty-STRING cell is
  // a different thing: the ?? chain takes '' as a value and the row's order
  // number comes out blank — such a row was refused at upload, so there is no
  // order for it to heal. Pre-existing mapper behaviour, noted, out of scope.
  { 'GI No': 'GI-141032',                                    'Account': 'BETIME', 'SKU Code': '8006', 'Quantity': 1 },
  { 'GI No': 'GI-141040', 'Reference': '585835424563889658', 'Account': 'BETIME', 'SKU Code': '8006', 'Quantity': 1 },
  { 'GI No': 'GI-141041', 'Reference': '585835428307699034', 'Account': 'BETIME', 'SKU Code': '8006', 'Quantity': 1 },
  { 'GI No': 'GI-141050', 'Reference': '585835500000000000', 'Account': 'BETIME', 'SKU Code': '8006', 'Quantity': 1 },
  { 'GI No': '',          'Reference': '585835518223680576', 'Account': 'BETIME', 'SKU Code': '8006', 'Quantity': 1 },
]);
const NO_GI_FILE = xlsxOf([
  { 'Order No': '585836014589150279', 'SKU Code': '8006', 'Quantity': 1 },
]);

async function login(id, password) {
  const r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password }) });
  const d = await r.json(); if (!d.token) throw new Error('login failed for ' + id + ': ' + JSON.stringify(d)); return d.token;
}
async function backfill(token, buf, name) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  const r = await fetch(B + '/api/orders/backfill-gi', { method: 'POST', headers: { 'x-auth-token': token }, body: fd });
  return { status: r.status, body: await r.json() };
}
async function orders(token) {
  const r = await fetch(B + '/api/orders?range=all', { headers: { 'x-auth-token': token } });
  const d = await r.json();
  return Array.isArray(d) ? d : (d.orders || []);
}
const byNo = (list, n) => list.find(o => o.order_number === n);

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true });
  await boot();            // scaffold a fresh data dir
  await stop();
  seed();                  // server STOPPED — it re-persists its in-memory db otherwise
  await boot();

  const admin = await login('demo', 'demo');
  // A warehouse login, to prove the guard is server-side.
  const mk = await fetch(B + '/api/master/users', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-master-key': MASTER, 'x-auth-token': admin },
    body: JSON.stringify({ id: 'whguy', name: 'WH Guy', password: 'whguy123', role: 'warehouse' }) });
  ok(mk.ok, `warehouse user created (${mk.status})`);
  const wh = await login('whguy', 'whguy123');

  console.log('\n=== refusals change nothing ===');
  {
    const r = await backfill(wh, FILE, 'GI_Analysis.xlsx');
    ok(r.status === 403, `warehouse is refused (${r.status}: ${r.body.error})`);
    const r2 = await backfill(admin, Buffer.from('%PDF-1.4 fake'), 'picklist.pdf');
    ok(r2.status === 400 && /PDF/.test(r2.body.error), `a PDF is refused with a reason (${r2.status})`);
    const r3 = await backfill(admin, NO_GI_FILE, 'no-gi.xlsx');
    ok(r3.status === 422, `a file with no GI column is refused (${r3.status}: ${r3.body.error})`);
    const list = await orders(admin);
    ok(byNo(list, '585836014589150279').issue_no === '' && byNo(list, '585835366510593147').issue_no === '',
       'and after all three refusals the blank GIs are STILL blank');
  }

  console.log('\n=== the backfill ===');
  const before = await orders(admin);
  const r = await backfill(admin, FILE, 'GI_Analysis_260907.xlsx');
  ok(r.status === 200 && r.body.ok, `200 (${r.body.summary})`);
  const filledMap = Object.fromEntries((r.body.filled || []).map(f => [f.order, f.gi]));
  ok(filledMap['585836014589150279'] === 'GI-141037', 'the mid-pick order got GI-141037');
  ok(filledMap['585835366510593147'] === 'GI-141038', 'the pending order got GI-141038');
  ok(filledMap['GI-141032'] === 'GI-141032', 'the GI-only order got its own GI as issue_no (pill will suppress the echo)');
  ok((r.body.filled || []).length === 3, `exactly 3 filled (${(r.body.filled || []).length})`);
  ok((r.body.alreadyHad || []).length === 1 && r.body.alreadyHad[0].order === '585835428307699034', 'the one that already had it is reported as such');
  const cf = (r.body.conflicts || [])[0];
  ok((r.body.conflicts || []).length === 1 && cf.order === '585835424563889658' && cf.stored === 'GI-999999' && cf.inFile === 'GI-141040',
     `the conflict is reported with both values (${JSON.stringify(cf)})`);
  ok((r.body.notInSystem || []).includes('585835500000000000'), 'an order in the file but not in IdealOne is named');
  ok((r.body.noGiInFile || []).includes('585835518223680576'), 'an order in the file with no GI value is named');
  ok((r.body.filled || []).find(f => f.order === '585836014589150279')?.status === 'processing', 'the filled row reports the order status it found');

  console.log('\n=== what it did NOT touch ===');
  const after = await orders(admin);
  ok(byNo(after, '585836014589150279').issue_no === 'GI-141037', 'GI-141037 is now on the stored order');
  ok(byNo(after, '585835366510593147').issue_no === 'GI-141038', 'GI-141038 is now on the stored order');
  ok(byNo(after, '585835424563889658').issue_no === 'GI-999999', 'the CONFLICT order kept its stored GI — never overwritten');
  ok(byNo(after, 'X-1').issue_no === '', "another client's blank order is untouched");
  const a = byNo(after, '585836014589150279'), b = byNo(before, '585836014589150279');
  ok(a.scan_status === 'processing' && b.scan_status === 'processing', `scan status untouched (${a.scan_status})`);
  ok(JSON.stringify(a.scanned ?? a.items?.map?.(i => i.scanned)) === JSON.stringify(b.scanned ?? b.items?.map?.(i => i.scanned)), 'scan counts untouched');
  ok(after.length === before.length, `same number of orders (${after.length})`);
  ok(new Set(after.map(o => o.idealscan_code || o.batchId)).size === new Set(before.map(o => o.idealscan_code || o.batchId)).size, 'no new batch created');

  console.log('\n=== the picking-list barcode now finds the order ===');
  for (const [scan, want] of [['GI-141037', '585836014589150279'], ['gi-141038', '585835366510593147'], ['GI-141032', 'GI-141032']]) {
    const lr = await fetch(B + '/api/waybill-lookup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': admin }, body: JSON.stringify({ waybill: scan }) });
    const ld = await lr.json();
    const hit = ld.order_number || ld.order?.order_number || ld.orderNumber;
    ok(lr.ok && hit === want, `scanning "${scan}" opens ${want} (got ${hit ?? JSON.stringify(ld).slice(0, 80)})`);
  }
  {
    const lr = await fetch(B + '/api/waybill-lookup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': admin }, body: JSON.stringify({ waybill: 'GI-141040' }) });
    const ld = await lr.json();
    const hit = ld.order_number || ld.order?.order_number || ld.orderNumber;
    ok(hit !== '585835424563889658', 'the conflicting GI from the FILE does NOT open the order (it was never written)');
  }

  console.log('\n=== persisted, and on the trail ===');
  await sleep(1500);
  const disk = JSON.parse(fs.readFileSync(DBP, 'utf8'));
  const dOrd = disk.batches.flatMap(x => x.orders).find(o => o.order_number === '585836014589150279');
  ok(dOrd && dOrd.issue_no === 'GI-141037', 'the GI is on disk');
  ok(disk.batches.length === 2, `still 2 batches on disk (${disk.batches.length})`);
  const ev = (disk.auditLog || []).find(e => e.type === 'orders_gi_backfilled');
  ok(!!ev && ev.filled === 3 && ev.conflicts === 1 && ev.by === 'demo', `audit orders_gi_backfilled names 3 filled, 1 conflict, by demo (${JSON.stringify(ev && { filled: ev.filled, conflicts: ev.conflicts, by: ev.by })})`);
  ok(disk.batches[0].orderStates['585836014589150279'].scanned['8006'] === 1, 'the scanned count on disk is still 1');

  console.log('\n=== a second run is a no-op ===');
  const r2 = await backfill(admin, FILE, 'GI_Analysis_260907.xlsx');
  ok(r2.status === 200 && r2.body.filled.length === 0 && r2.body.alreadyHad.length === 4 && r2.body.conflicts.length === 1,
     `nothing filled, 4 already had, 1 conflict still reported (${r2.body.summary})`);
  await sleep(800);
  const disk2 = JSON.parse(fs.readFileSync(DBP, 'utf8'));
  ok((disk2.auditLog || []).filter(e => e.type === 'orders_gi_backfilled').length === 1, 'and the no-op run wrote no second audit entry');

  await stop();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error(e); await stop(); process.exit(1); });
