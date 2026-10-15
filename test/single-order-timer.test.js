// 15 Oct: order rows showed two timers (old Handover-KPI pill + #78 24h timer).
// Only the 24h timer renders on the row; the Handover KPI tiles stay.
const assert = require('assert');
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
const calls = src.split('\n').filter(l => /fulfilmentChip\(ord\)/.test(l) && !/function fulfilmentChip/.test(l));
assert.deepStrictEqual(calls, [], 'Handover-KPI pill no longer rendered on order rows');
assert.ok(/\n\s+slaPill\(ord\),/.test(src), '24h timer pill still rendered');
assert.ok(src.includes('HANDOVER') && src.includes("tile('overdue'"), 'Handover KPI tiles kept');
console.log('single-order-timer: ok');
