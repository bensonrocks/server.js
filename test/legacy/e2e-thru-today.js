// E2E — "today / current to date" throughput.
// Proves: a period ending TODAY genuinely includes an order completed today;
// the sheet SAYS the period is still running; a closed period does not; the
// sheet's shape (header always on row 2) never changes; and the no-default
// guard still refuses a missing date.
const B = 'http://localhost:4731', MK = '201432547E';
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sg = d => (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'x-auth-token': l.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: { ...H, 'Content-Type': 'application/json' }, ...o }).then(r => r.json());

  const TODAY = sg();
  const YEST  = sg(new Date(Date.now() - 86400000));
  const MONTH = TODAY.slice(0, 7) + '-01';
  const YEAR  = TODAY.slice(0, 4) + '-01-01';
  console.log(`  SGT today=${TODAY} month-start=${MONTH} year-start=${YEAR}`);

  // One order, uploaded and completed right now.
  const fd = new FormData();
  fd.append('orderFile', new Blob(['Order Number,SKU,Quantity\nTODAY-1,ANY-SKU,2\n'], { type: 'text/csv' }), 't.csv');
  fd.append('client_name', 'TodayCo'); fd.append('arrange_delivery', 'no');
  const up = await fetch(B + '/api/upload', { method: 'POST', headers: H, body: fd });
  ok(up.ok, 'upload accepted');
  await new Promise(r => setTimeout(r, 1100));
  await J('/api/scan/setqty', { method: 'POST', body: JSON.stringify({ orderNumber: 'TODAY-1', sku: 'ANY-SKU', qty: 2 }) });
  const done = await J('/api/scan/complete', { method: 'POST', body: JSON.stringify({ orderNumber: 'TODAY-1', startTime: new Date().toISOString(), endTime: new Date().toISOString(), operator: 'demo' }) });
  ok(done.ok !== false, 'order completed: ' + JSON.stringify(done).slice(0, 120));

  const sheet = async qs => {
    const r = await fetch(B + '/api/master/report/throughput?' + qs, { headers: H });
    if (r.status !== 200) return { status: r.status, body: await r.json().catch(() => ({})) };
    const wb = XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
    return { status: 200, rows: XLSX.utils.sheet_to_json(wb.Sheets['Throughput'], { header: 1 }) };
  };

  // ── TODAY ────────────────────────────────────────────────────────────────
  const t = await sheet(`from=${TODAY}&to=${TODAY}`);
  ok(t.status === 200, `today period: 200 (got ${t.status})`);
  ok(String(t.rows[1][0]) === 'Order No', 'header is still row 2 on a today-ending period (sheet shape unchanged)');
  const tRow = t.rows.slice(2).find(r => r[0] === 'TODAY-1');
  ok(!!tRow, "an order completed today IS in a from=today&to=today report");
  ok(tRow && tRow[1] === 'TodayCo', 'client column correct');
  ok(tRow && typeof tRow[5] === 'number' && tRow[5] >= 0 && tRow[5] < 1, `real lead time computed (${tRow && tRow[5]} hrs, matching the ~1.1s gap)`);
  const title = String(t.rows[0][0]);
  console.log('  title:', title);
  ok(/STILL RUNNING/.test(title), 'the sheet says the period is still running');
  ok(/SGT/.test(title), 'and states the moment it was taken');
  ok(title.startsWith(`Period: ${TODAY} to ${TODAY}`), 'title still leads with the period it ran');

  // ── MONTH TO DATE and YEAR TO DATE ───────────────────────────────────────
  const m = await sheet(`from=${MONTH}&to=${TODAY}`);
  ok(m.status === 200 && m.rows.slice(2).some(r => r[0] === 'TODAY-1'), 'month-to-date includes it');
  ok(/STILL RUNNING/.test(String(m.rows[0][0])), 'month-to-date also flagged still running');
  const y = await sheet(`from=${YEAR}&to=${TODAY}`);
  ok(y.status === 200 && y.rows.slice(2).some(r => r[0] === 'TODAY-1'), 'year-to-date includes it');

  // ── A CLOSED PERIOD IS NOT FLAGGED ───────────────────────────────────────
  const c = await sheet(`from=2026-01-01&to=${YEST}`);
  ok(c.status === 200, 'closed period: 200');
  ok(!/STILL RUNNING/.test(String(c.rows[0][0])), 'a period that ended yesterday is NOT flagged as running');
  ok(String(c.rows[1][0]) === 'Order No', 'header still row 2 on a closed period too');
  ok(!c.rows.slice(2).some(r => r[0] === 'TODAY-1'), "today's order is correctly absent from a period ending yesterday");

  // ── THE NO-DEFAULT RULE STILL STANDS ─────────────────────────────────────
  for (const [qs, what] of [['', 'no dates'], [`from=${TODAY}`, 'only From'], [`to=${TODAY}`, 'only To']]) {
    const r = await fetch(B + '/api/master/report/throughput?' + qs, { headers: H });
    ok(r.status === 400, `${what}: still refused with 400 (got ${r.status})`);
  }
  const both = await fetch(B + `/api/master/report/throughput?from=${TODAY}&to=${TODAY}`, { headers: H });
  ok(both.status === 200, 'both dates: 200');

  // A SIBLING REPORT KEEPS ITS OWN 30-DAY DEFAULT — untouched by any of this.
  const sib = await fetch(B + '/api/master/report/daily-summary', { headers: H });
  ok(sib.status === 200, 'daily-summary with no dates still 200 (its default is untouched)');

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
