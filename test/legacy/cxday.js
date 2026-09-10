// The reported shape: the office read 3 cancellations for today where the
// client's own portal read 5. THREE separate defects could each hide one:
//   1. the office bucketed a cancellation on the day the order was UPLOADED
//   2. an order the CLIENT withdrew was filtered off the office list entirely
//   3. that withdrawal never stamped unprocessed_at, so it had no day at all
// This seeds one of each and asserts the office and the portal agree.
const BASE = 'http://localhost:4636', MK = '201432547E';
const fs = require('fs');
const DB = __dirname + '/sup/tenants/default/db.json';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };

if (process.argv[2] === 'seed') {
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const now = new Date();
  const at = h => new Date(now.getTime() - h * 3600000).toISOString();
  db.batches = (db.batches || []).filter(b => !String(b.id).startsWith('cxday-'));
  // Every one of these was cancelled AN HOUR AGO. What differs is the day the
  // order arrived and how the cancellation was recorded.
  const groups = [
    // uploaded today, cancelled here — the only kind the office ever showed
    [0, [['CX-A', 'ours'], ['CX-B', 'ours'], ['CX-C', 'ours']]],
    // uploaded days ago, cancelled here — defect 1
    [4, [['CX-D', 'ours']]],
    [3, [['CX-E', 'ours']]],
    // withdrawn by the client today — defect 2
    [0, [['CX-F', 'client']]],
    // withdrawn by the client, stored the OLD way with no unprocessed_at,
    // on an order uploaded days ago — defects 2 and 3 together
    [5, [['CX-G', 'client-legacy']]],
    // THE LIVE SHAPE: voided by the marketplace (Lazada via the hub) on an
    // order uploaded days ago. The void handlers set status and updated_at and
    // NOTHING else, so the portal dated it from updated_at and counted it
    // today while the office had nothing to read and fell back to the upload
    // date. This is the pair that was still missing after the first two fixes.
    [6, [['CX-H', 'marketplace-void']]],
    [7, [['CX-I', 'marketplace-void']]],
  ];
  let n = 0;
  for (const [daysAgo, rows] of groups) {
    const states = {};
    for (const [num, how] of rows) {
      const base = { status: 'unprocessed', scanned: {}, scanLog: [] };
      if (how === 'ours') {
        states[num] = { ...base, unprocessed_at: at(1), unprocessed_reason: 'Not processed', updated_at: at(1) };
      } else if (how === 'client') {
        states[num] = { ...base, unprocessed_at: at(1), unprocessed_reason: 'Withdrawn by the client',
                        updated_at: at(1), client_cancelled: { at: at(1), by: 'portal:CxCo', reason: 'no longer needed' } };
      } else if (how === 'marketplace-void') {
        // EXACTLY what handleZortVoid / handleLazadaCancel wrote: status and
        // updated_at, no unprocessed_at, no reason.
        states[num] = { ...base, updated_at: at(1) };
      } else {
        // EXACTLY what the old portal path wrote: the flag and nothing else.
        states[num] = { ...base, client_cancelled: { at: at(1), by: 'portal:CxCo', reason: 'no longer needed' } };
      }
    }
    db.batches.unshift({
      id: 'cxday-' + (n++), idealscan_code: 'CX-' + n, filename: 'cxday.xlsx',
      client_name: 'CxCo', uploaded_by: 'test',
      uploaded_at: new Date(now.getTime() - daysAgo * 86400000).toISOString(),
      orders: rows.map(([num]) => ({ order_number: num, lines: [{ sku: 'CXD-1', description: 'Day test', qty: 1 }] })),
      orderStates: states,
    });
  }
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));
  console.log('seeded 9 cancellations, all an hour old: 3 plain, 2 on older uploads, 1 client withdrawal, 1 legacy withdrawal');
  process.exit(0);
}

(async () => {
  const T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;
  const get = async q => {
    const r = await fetch(BASE + '/api/orders?' + q, { headers: { 'x-auth-token': T, 'x-master-key': MK } });
    const b = await r.json().catch(() => ({}));
    return (Array.isArray(b) ? b : (b.orders || [])).filter(o => String(o.order_number).startsWith('CX-'));
  };
  const nums = rows => rows.map(o => o.order_number).sort().join(',');

  const today = (await get('range=today')).filter(o => o.scan_status === 'unprocessed');
  ok(today.length === 9, `the office counts every cancellation made today (${today.length} of 9)`);
  ok(nums(today) === 'CX-A,CX-B,CX-C,CX-D,CX-E,CX-F,CX-G,CX-H,CX-I', `and it is the right nine (${nums(today)})`);
  ok(['CX-H', 'CX-I'].every(n => today.some(o => o.order_number === n)),
     'INCLUDING the pair the marketplace voided, which had only updated_at to date them by');

  ok(today.some(o => o.order_number === 'CX-D'), 'a cancellation on an order uploaded 4 days ago counts today');
  ok(today.some(o => o.order_number === 'CX-F'), 'a withdrawal the CLIENT made is on the office list at all');
  ok(today.some(o => o.order_number === 'CX-G'),
     'and one stored the old way, with no unprocessed_at, still lands on the right day');

  // WHO did it has to be legible, not inferred.
  const f = today.find(o => o.order_number === 'CX-F');
  ok(!!f?.client_cancelled?.at && /portal:/.test(f.client_cancelled.by || ''),
     'a withdrawal says on the row that the client made it, and when');
  ok(!today.find(o => o.order_number === 'CX-A')?.client_cancelled,
     'and one WE made carries no such mark');

  // Not counted twice, and not dragged onto other days.
  const yest = (await get('range=yesterday')).filter(o => o.scan_status === 'unprocessed');
  ok(yest.length === 0, `none of them counts as yesterday's (${yest.length})`);

  // The admin review view still narrows to just the client's withdrawals.
  const review = await get('range=today&cancelled=1');
  ok(nums(review) === 'CX-F,CX-G', `?cancelled=1 still isolates the client's own withdrawals (${nums(review)})`);
  ok(!review.some(o => ['CX-H', 'CX-I'].includes(o.order_number)),
     'and a marketplace void is not mistaken for something the client did');

  // NOT REGRESSED: cancelled work is never in the Active list.
  const active = (await get('range=today')).filter(o => o.scan_status !== 'unprocessed' && o.scan_status !== 'done');
  ok(active.length === 0, 'and not one of them appears as active work');

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
