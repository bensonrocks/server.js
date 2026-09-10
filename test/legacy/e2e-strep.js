// E2E — Station Throughput REPORT (annual / month / day / station) and the
// per-day total row's arithmetic. Phase 1 completes real orders through the
// real endpoints; phase 2 (after a seeded restart) reads the report back.
const B = 'http://localhost:4735', MK = '201432547E';
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sg = d => (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const PHASE = process.argv[2] || '1';

(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'x-auth-token': l.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: { ...H, 'Content-Type': 'application/json' }, ...o }).then(r => r.json());
  const TODAY = sg();

  if (PHASE === '1') {
    // Two real completions today, by the signed-in packer.
    for (const n of ['STR-A', 'STR-B']) {
      const fd = new FormData();
      fd.append('orderFile', new Blob([`Order Number,SKU,Quantity\n${n},SK-1,2\n${n},SK-2,3\n`], { type: 'text/csv' }), 's.csv');
      fd.append('client_name', 'StrCo'); fd.append('arrange_delivery', 'no');
      const up = await fetch(B + '/api/upload', { method: 'POST', headers: H, body: fd });
      ok(up.ok, `${n}: uploaded`);
      await J('/api/scan/setqty', { method: 'POST', body: JSON.stringify({ orderNumber: n, sku: 'SK-1', qty: 2 }) });
      await J('/api/scan/setqty', { method: 'POST', body: JSON.stringify({ orderNumber: n, sku: 'SK-2', qty: 3 }) });
      const d = await J('/api/scan/complete', { method: 'POST', body: JSON.stringify({ orderNumber: n, startTime: new Date().toISOString(), endTime: new Date().toISOString(), operator: 'demo' }) });
      ok(d.ok !== false, `${n}: completed (${JSON.stringify(d).slice(0, 60)})`);
    }
    console.log('\nPHASE 1 DONE — stop the server, seed history, restart, run phase 2');
    process.exit(fails.length ? 1 : 0);
  }

  // ── PHASE 2 ──────────────────────────────────────────────────────────────
  const sheets = async qs => {
    const r = await fetch(B + '/api/master/report/station-throughput?' + qs, { headers: H });
    if (r.status !== 200) return { status: r.status };
    const wb = XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
    const out = { status: 200, names: wb.SheetNames };
    for (const n of wb.SheetNames) out[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 });
    return out;
  };
  const rowsAfterHead = s => s.slice(2);   // title line + header

  // A wide period covering both the seeded history and today.
  const WIDE = `from=2024-01-01&to=${TODAY}`;
  const w = await sheets(WIDE);
  ok(w.status === 200, `report: 200 (got ${w.status})`);
  ok(['By Station', 'By Day', 'By Month', 'By Year'].every(n => w.names.includes(n)),
     `all four grains present: ${w.names.join(', ')}`);

  // ── BY STATION ───────────────────────────────────────────────────────────
  const st = rowsAfterHead(w['By Station']);
  const demo = st.find(r => r[0] === 'Demo' || r[0] === 'demo');
  const kim  = st.find(r => String(r[0]).toLowerCase() === 'kim');
  ok(!!demo && !!kim, `both stations listed: ${JSON.stringify(st.map(r => r[0]))}`);
  // demo: 2 today (2 lines, 5 pcs each) + 3 seeded = 5 orders
  ok(demo && demo[1] === 5, `demo's orders across the whole period (${demo && demo[1]} — expected 5)`);
  ok(demo && demo[4] >= 3, `demo worked on several DAYS, counted distinctly (${demo && demo[4]})`);
  ok(kim && kim[1] === 2, `kim's orders (${kim && kim[1]} — expected 2)`);
  const avg = demo && demo[5];
  ok(typeof avg === 'number' && Math.abs(avg - demo[1] / demo[4]) < 0.06,
     `avg orders/day is orders÷days, not invented (${avg})`);

  // ── BY DAY / MONTH / YEAR — the same orders, three grains ────────────────
  const dayRows   = rowsAfterHead(w['By Day']);
  const monthRows = rowsAfterHead(w['By Month']);
  const yearRows  = rowsAfterHead(w['By Year']);
  const sum = rows => rows.reduce((n, r) => n + (Number(r[2]) || 0), 0);
  ok(sum(dayRows) === sum(monthRows) && sum(monthRows) === sum(yearRows),
     `every grain totals the SAME orders (day ${sum(dayRows)} / month ${sum(monthRows)} / year ${sum(yearRows)})`);
  ok(sum(dayRows) === 7, `seven orders in all (got ${sum(dayRows)})`);
  ok(dayRows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r[0])), 'By Day keys are calendar days');
  ok(monthRows.every(r => /^\d{4}-\d{2}$/.test(r[0])), 'By Month keys are months');
  ok(yearRows.every(r => /^\d{4}$/.test(r[0])), 'By Year keys are years');
  ok(yearRows.some(r => r[0] === '2024') && yearRows.some(r => r[0] === String(new Date().getFullYear())),
     `ANNUAL really spans years: ${JSON.stringify(yearRows.map(r => r[0] + '/' + r[1]))}`);
  const m2024 = monthRows.filter(r => r[0].startsWith('2024'));
  ok(m2024.length >= 2, `and months within a year are separate rows (${JSON.stringify(m2024.map(r => r[0]))})`);

  // Lines and pieces carry through, not just an order count.
  const todayDemo = dayRows.find(r => r[0] === TODAY && String(r[1]).toLowerCase().startsWith('demo'));
  ok(todayDemo && todayDemo[3] === 4, `lines counted (${todayDemo && todayDemo[3]} — 2 orders × 2 lines)`);
  ok(todayDemo && todayDemo[4] === 10, `pieces counted (${todayDemo && todayDemo[4]} — 2 orders × 5 pcs)`);

  // ── THE PERIOD IS REAL ───────────────────────────────────────────────────
  const narrow = await sheets(`from=${TODAY}&to=${TODAY}`);
  const nDay = rowsAfterHead(narrow['By Day']);
  ok(sum(nDay) === 2, `a one-day period returns only that day's work (${sum(nDay)})`);
  ok(nDay.every(r => r[0] === TODAY), 'and no other day leaks in');

  // ── THE STATION FILTER ───────────────────────────────────────────────────
  const only = await sheets(`${WIDE}&station=kim`);
  const oSt = rowsAfterHead(only['By Station']);
  ok(oSt.length === 1 && String(oSt[0][0]).toLowerCase() === 'kim', `station filter narrows to one (${JSON.stringify(oSt.map(r => r[0]))})`);
  ok(sum(rowsAfterHead(only['By Day'])) === 2, 'and its day rows carry only that station');

  // ── IT AGREES WITH THE MODAL ─────────────────────────────────────────────
  const dash = await fetch(B + '/api/master/dashboard/station-throughput', { headers: H }).then(r => r.json());
  const dashToday = dash.totalsByDay?.[TODAY] ?? -1;
  ok(dashToday === sum(nDay), `the modal and the report agree on today (${dashToday} vs ${sum(nDay)})`);
  const dashDemoToday = (dash.stations || []).find(s => s.station === 'demo')?.byDay?.[TODAY]?.lines;
  ok(dashDemoToday === (todayDemo && todayDemo[3]), `and on the LINES for that station (${dashDemoToday} vs ${todayDemo && todayDemo[3]})`);

  // ── NOTHING WAS WRITTEN INTO THE AUDIT LOG BY READING IT ─────────────────
  const raw = require('fs').readFileSync(process.env.DDIR + '/db.json', 'utf8');
  ok(!raw.includes('"_day"'), 'reading the report stamped no scratch field onto the live audit entries');

  // ── ACCESS ───────────────────────────────────────────────────────────────
  const noTok = await fetch(B + '/api/master/report/station-throughput?' + WIDE);
  ok(noTok.status === 401 || noTok.status === 403, `no token refused (${noTok.status})`);

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
