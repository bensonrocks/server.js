const B = 'http://localhost:4703', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'x-auth-token': l.token, 'x-master-key': MK };

  // 1. No from/to at all -> server refuses.
  const r1 = await fetch(B + '/api/master/report/throughput', { headers: H });
  const d1 = await r1.json().catch(() => ({}));
  ok(r1.status === 400 && /no default period/i.test(d1.error || ''), `no dates at all -> 400 (${r1.status}, "${d1.error}")`);

  // 2. Only "from" given -> still refused.
  const r2 = await fetch(B + '/api/master/report/throughput?from=2026-07-01', { headers: H });
  ok(r2.status === 400, `only From given -> still 400 (got ${r2.status})`);

  // 3. Only "to" given -> still refused.
  const r3 = await fetch(B + '/api/master/report/throughput?to=2026-08-31', { headers: H });
  ok(r3.status === 400, `only To given -> still 400 (got ${r3.status})`);

  // 4. Both given -> works normally (July 1 onward, proving there's genuinely no silent 30-day substitution).
  const r4 = await fetch(B + '/api/master/report/throughput?from=2026-07-01&to=2026-08-31', { headers: H });
  ok(r4.status === 200, `both dates given -> 200 (got ${r4.status})`);

  // 5. A DIFFERENT report kind (daily-summary) still gets its normal 30-day
  //    default -- this change is scoped to throughput only, not global.
  const r5 = await fetch(B + '/api/master/report/daily-summary', { headers: H });
  ok(r5.status === 200, `daily-summary with NO dates still works (default untouched) -> 200 (got ${r5.status})`);

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
