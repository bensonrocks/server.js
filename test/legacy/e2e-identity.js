// E2E — the identity check, through the REAL GET /api/label-imports/:id.
const B = 'http://localhost:4741';
const fs = require('fs');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };

(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'x-auth-token': l.token };
  const imp = await fetch(B + '/api/label-imports/imp-idtest', { headers: H }).then(r => r.json());
  ok(!!imp && imp.pages && imp.pages.length === 3, 'the import comes back with its 3 pages');

  // ── PAGE 1 — the reported screenshot ──────────────────────────────────────
  const p1 = imp.pages[0].identity || {};
  const f1 = p1.fields || {};
  ok(f1.trackingNumber && f1.trackingNumber.verdict === 'agrees',
     `tracking agrees with the order (${f1.trackingNumber && f1.trackingNumber.verdict})`);
  ok(f1.orderNumber && f1.orderNumber.verdict === 'misread',
     `the order number is called a MISREAD, not a mismatch (${f1.orderNumber && f1.orderNumber.verdict})`);
  ok(f1.orderNumber && f1.orderNumber.chars === 1,
     `and says how far out it is: ${f1.orderNumber && f1.orderNumber.chars} character`);
  ok(f1.orderNumber && f1.orderNumber.orderValue === '172429924275375',
     `naming what this order's number actually is (${f1.orderNumber && f1.orderNumber.orderValue})`);
  ok(f1.orderNumber && f1.orderNumber.field === 'order number',
     `and which field of the order it compared against ("${f1.orderNumber && f1.orderNumber.field}")`);

  // ── PAGE 2 — a GI page, everything agreeing ───────────────────────────────
  const f2 = (imp.pages[1].identity || {}).fields || {};
  ok(f2.giNumber && f2.giNumber.verdict === 'agrees', 'the GI page: its GI agrees with the order');
  ok(f2.giNumber && f2.giNumber.field === 'GI / issue no',
     `matched against the order's issue_no, named as such ("${f2.giNumber && f2.giNumber.field}")`);
  ok(!f2.orderNumber && !f2.trackingNumber, 'and no note is raised for fields the label does not carry');

  // ── PAGE 3 — a number belonging to nothing here ───────────────────────────
  const f3 = (imp.pages[2].identity || {}).fields || {};
  ok(f3.orderNumber && f3.orderNumber.verdict === 'foreign',
     `a wholly unrelated number is "foreign", not passed off as a misread (${f3.orderNumber && f3.orderNumber.verdict})`);

  // ── The order's own identifiers travel with it, for the note to name ──────
  ok(p1.order && p1.order.waybill_number && p1.order.waybill_number.value === 'LZSGD1015379600',
     "the matched order's own identifiers are returned alongside");

  // ── NOTHING WAS WRITTEN. `imp` is a live db object; a field stamped on it
  //    here would be persisted as though it were stored data.
  await fetch(B + '/api/label-imports/imp-idtest', { headers: H }).then(r => r.json());
  await new Promise(r => setTimeout(r, 1200));
  const raw = fs.readFileSync(process.env.DDIR + '/tenants/default/db.json', 'utf8');
  ok(!raw.includes('"identity"'), 'reading it stamped no identity block onto the stored import');
  ok(!raw.includes('"verdict"'), 'and no verdict either');

  // ── An unmatched page is left exactly as it was ───────────────────────────
  const un = await fetch(B + '/api/label-imports', { headers: H }).then(r => r.json());
  ok(Array.isArray(un) && un.length === 1, 'the list endpoint is unchanged (bare array, 1 import)');

  // ── The CSV export carries the GI column ──────────────────────────────────
  const csv = await fetch(B + '/api/label-imports/imp-idtest/export.csv', { headers: H }).then(r => r.text());
  ok(/GI Number/.test(csv), 'the OCR-results CSV has a GI Number column');
  ok(/GI-9931/.test(csv), 'and the GI is in it');

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
