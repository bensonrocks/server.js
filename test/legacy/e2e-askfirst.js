// The reported shape: a 1,236-pc sheet uploaded onto a 2,979-pc position.
// It must ASK, state 2979 -> 4215, and write NOTHING until confirmed.
const B = 'http://localhost:4717', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'x-auth-token': l.token, 'x-master-key': MK };
  const C = 'AskCo' + Date.now();
  const up = async (csv, name, extra = {}) => {
    const fd = new FormData();
    fd.append('file', new Blob([csv], { type: 'text/csv' }), name);
    fd.append('clientId', C);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    const r = await fetch(B + '/api/inventory/import-file', { method: 'POST', headers: H, body: fd });
    return { status: r.status, d: await r.json() };
  };
  const onHand = async () => (await fetch(B + `/api/inventory?clientId=${C}`, { headers: H }).then(r => r.json()))
    .reduce((n, r) => n + (Number(r.stock_qty) || 0), 0);

  // Seed a 2,979-pc position across 3 SKUs (confirm_apply, since it now asks).
  await up('sku,name,stock_qty\nA,Alpha,1000\nB,Bravo,1000\nC,Charlie,979\n', 'seed.csv', { confirm_apply: 'yes' });
  ok(await onHand() === 2979, 'seeded 2979 on hand');

  // THE REPORTED MISTAKE: a 1,236-pc sheet, no confirm.
  const sheet = 'sku,name,stock_qty,Location\nA,Alpha,600,AA-001-001-A\nB,Bravo,636,AA-001-001-B\n';
  let { status, d } = await up(sheet, 'MAYER 1-09-26.csv');
  ok(status === 409 && d.needsApplyConfirm, 'IT ASKS — 409 needsApplyConfirm, not a silent write');
  const p = d.preview || {};
  console.log('  PREVIEW(add):', JSON.stringify({ rows: p.rows, skus: p.skus, units: p.units, currentTotal: p.currentTotal, afterTotal: p.afterTotal, untouched: p.untouchedSkus }));
  ok(p.currentTotal === 2979, 'states ON HAND NOW = 2979');
  ok(p.afterTotal === 4215, 'states AFTER = 4215 — the exact number that surprised the floor');
  ok(await onHand() === 2979, 'NOTHING was written by asking');

  // Cancelling = not resending. Still 2979.
  ok(await onHand() === 2979, 'cancelling changes nothing');

  // REPLACE mode: the file becomes these SKUs figures. C is untouched.
  ({ status, d } = await up(sheet, 'MAYER 1-09-26.csv', { mode: 'set' }));
  const q = d.preview || {};
  console.log('  PREVIEW(set):', JSON.stringify({ currentTotal: q.currentTotal, afterTotal: q.afterTotal, replacing: q.replacing, untouched: q.untouchedSkus }));
  ok(status === 409 && d.mode === 'set', 'supersede mode also asks');
  // THE FILE IS THE POSITION: after a supersede on hand is the sheet's own sum,
  // and the SKU the sheet omits is NAMED as going to zero rather than left
  // standing. (This used to assert 2215 — the per-SKU rule the user rejected.)
  ok(q.afterTotal === 1236, 'supersede states AFTER = 1236 — the file\'s own sum');
  ok(!q.untouchedSkus, 'nothing is left standing');
  ok((q.zeroSkus || []).some(x => x.sku === 'C' && x.was === 979), 'NAMES SKU C (979 pc) as going to ZERO');

  // Confirming applies.
  ({ status, d } = await up(sheet, 'MAYER 1-09-26.csv', { mode: 'set', confirm_apply: 'yes' }));
  ok(status === 200, 'confirming applies');
  ok(await onHand() === 1236, 'on hand is now 1236 exactly as the preview said');
  ok(d.mode === 'set', 'the result reports the mode it ran in');

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
