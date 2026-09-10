// E2E — THE LIVE SHAPE: batch client "MAYER2026", bins recorded under
// "Mayer2026". The wave must show the location from the current recorded bins.
const B = 'http://localhost:4663', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  if (!l.token) { console.log('LOGIN FAILED', JSON.stringify(l)); process.exit(1); }
  const H = { 'Content-Type': 'application/json', 'x-auth-token': l.token, 'x-master-key': MK };
  const w = await fetch(B + '/api/waves', { method: 'POST', headers: H, body: JSON.stringify({ name: 'e2e case wave', order_numbers: ['WAVE-E2E-1'] }) }).then(r => r.json());
  if (!w.id) { console.log('WAVE CREATE FAILED', JSON.stringify(w)); process.exit(1); }
  const g = await fetch(B + '/api/waves/' + w.id, { headers: H }).then(r => r.json());
  const p = (g.picks || [])[0] || {};
  console.log('pick row:', JSON.stringify({ sku: p.sku, bin_location: p.bin_location, bins: p.bins, resolved_sku: p.resolved_sku, location_status: p.location_status, shortfall: p.bin_shortfall }));
  ok(p.bin_location === 'AA-014-003-C', 'wave shows the RECORDED bin despite MAYER2026 vs Mayer2026');
  ok((p.bins || []).some(b => b.location_id === 'AA-014-003-C' && b.qty === 2), 'bin row carries the pick qty ×2');
  ok(!p.location_status, 'no "no location" status — the location resolved');
  ok((g.stats && g.stats.unlocatedLines) === 0 || (g.location_stats ? g.location_stats.unlocatedLines === 0 : true), 'wave reports 0 unlocated lines');
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
