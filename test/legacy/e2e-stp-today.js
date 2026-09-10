// E2E — Station Throughput / Activity Overview now INCLUDE today.
// The reported shape: the modal showed Tue/Wed/Thu with today (Fri) absent, so
// an order packed this morning was nowhere on the board.
const B = 'http://localhost:4733', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sg = d => (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'x-auth-token': l.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: { ...H, 'Content-Type': 'application/json' }, ...o }).then(r => r.json());

  const TODAY = sg();
  const D = n => sg(new Date(Date.now() - n * 86400000));

  // Upload and complete an order RIGHT NOW — i.e. today.
  const fd = new FormData();
  fd.append('orderFile', new Blob(['Order Number,SKU,Quantity\nSTP-TODAY-1,ANY-SKU,2\n'], { type: 'text/csv' }), 's.csv');
  fd.append('client_name', 'StpCo'); fd.append('arrange_delivery', 'no');
  const up = await fetch(B + '/api/upload', { method: 'POST', headers: H, body: fd });
  ok(up.ok, 'upload accepted');
  await J('/api/scan/setqty', { method: 'POST', body: JSON.stringify({ orderNumber: 'STP-TODAY-1', sku: 'ANY-SKU', qty: 2 }) });
  const done = await J('/api/scan/complete', { method: 'POST', body: JSON.stringify({ orderNumber: 'STP-TODAY-1', startTime: new Date().toISOString(), endTime: new Date().toISOString(), operator: 'demo' }) });
  ok(done.ok !== false, 'order completed today');

  // ── STATION THROUGHPUT ───────────────────────────────────────────────────
  const st = await fetch(B + '/api/master/dashboard/station-throughput', { headers: H }).then(r => r.json());
  console.log('  days:', JSON.stringify(st.days), 'today:', st.today);
  ok(Array.isArray(st.days) && st.days.length === 4, `four day columns, not three (got ${st.days?.length})`);
  ok(st.days[st.days.length - 1] === TODAY, `TODAY is the LAST column (${st.days?.[3]} === ${TODAY})`);
  ok(st.days[0] === D(3) && st.days[1] === D(2) && st.days[2] === D(1),
     'the three full days before it are all still there, oldest first — nothing was traded away');
  ok(st.today === TODAY, `the server NAMES today (${st.today}) so the browser never has to work it out`);
  ok((st.totalsByDay?.[TODAY] || 0) >= 1, `today's total counts the order just packed (${st.totalsByDay?.[TODAY]})`);
  const me = (st.stations || []).find(s => s.station === 'demo');
  ok(!!me, 'the packer appears as a station');
  ok(me && me.byDay[TODAY]?.orders >= 1, `and their TODAY column carries it (${me && me.byDay[TODAY]?.orders} order(s))`);
  ok(me && me.byDay[TODAY]?.lines >= 1, `lines counted for today too (${me && me.byDay[TODAY]?.lines})`);
  ok(st.days.every(d => me && me.byDay[d]), 'every station carries a bucket for every day incl. today (no undefined cells)');

  // ── ACTIVITY OVERVIEW — the twin, fed by the same helper ─────────────────
  const ov = await fetch(B + '/api/master/dashboard/activity-overview', { headers: H }).then(r => r.json());
  ok(Array.isArray(ov.days) && ov.days.length === 4, `overview also four days (got ${ov.days?.length})`);
  ok(ov.days[ov.days.length - 1]?.date === TODAY, 'overview: today is the last row');
  ok(ov.today === TODAY, 'overview names today too');
  const row = ov.days.find(d => d.date === TODAY);
  ok(row && row.totalOrders >= 1, `overview's today row counts the order (${row && row.totalOrders})`);
  ok(row && row.largestBySize && row.largestBySize.order === 'STP-TODAY-1',
     "and today's largest order is named, not left blank");

  // ── ACCESS IS UNCHANGED ──────────────────────────────────────────────────
  const noTok = await fetch(B + '/api/master/dashboard/station-throughput');
  ok(noTok.status === 401 || noTok.status === 403, `no token is still refused (${noTok.status})`);

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
