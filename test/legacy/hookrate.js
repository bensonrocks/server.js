// The per-IP ceiling, on its own — with it at its real value, so this measures
// the ceiling rather than the write guard that hides behind it.
const BASE = 'http://localhost:4637';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const push = tok => fetch(`${BASE}/api/zort/webhook/${tok}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"number":"Z"}' }).then(r => r.status);
(async () => {
  const codes = [];
  for (let i = 0; i < 40; i++) codes.push(await push('e'.repeat(32)));
  ok(codes.every(c => c === 200), 'every push is acknowledged, over the ceiling or not — a hub must never see an error from us');
  const health = await fetch(BASE + '/api/version').then(r => r.status);
  ok(health === 200, 'and the server is healthy after a burst well past the ceiling');
  const fs = require('fs');
  const log = JSON.parse(fs.readFileSync(__dirname + '/rate/tenants/default/db.json', 'utf8')).zortPushLog || [];
  ok(log.length <= 2, `a 40-push burst against a ceiling of 5 writes almost nothing (${log.length} rows)`);
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
