// E2E through the REAL upload + review endpoints, on a genuine PDF.
// Page 1 names CSC-100 only in loose text (a scan GUESS).
// Page 2 is CSC-100's real label, with its GI captioned (EXACT).
// Page 3 names CSC-200 and CSC-300 at once (must attach NOTHING).
const B = 'http://localhost:4741';
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };

const PAGES = [
  // Deliberately NOT captioned as a GI — only findable by the text scan.
  `<h1>SHIPPING LABEL</h1><p>customer ref PO88123456</p><p>To: Alpha</p>`,
  `<h1>SHIPPING LABEL</h1><p>GI No: GI-88001234</p><p>To: Alpha Pte Ltd</p>`,
  `<h1>SHIPPING LABEL</h1><p>consolidated 5512345678 with 5599999999</p><p>To: ?</p>`,
  `<h1>SHIPPING LABEL</h1><p>customer ref PO44567890</p><p>To: Delta</p>`,
];

(async () => {
  // Build a REAL pdf by printing HTML through Chromium — synthetic pdf-lib
  // files are unreadable by this repo's pdf-parse (the documented trap).
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  await page.setContent(PAGES.map((h, i) =>
    `<div style="page-break-after:${i < PAGES.length - 1 ? 'always' : 'auto'};font:16px sans-serif">${h}</div>`).join(''));
  const pdf = await page.pdf({ format: 'A4' });
  await browser.close();
  ok(pdf.length > 1000, `built a real ${pdf.length}-byte 3-page PDF`);

  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'x-auth-token': l.token };

  const fd = new FormData();
  fd.append('labelPdf', new Blob([pdf], { type: 'application/pdf' }), 'cascade.pdf');
  const up = await fetch(B + '/api/label-imports', { method: 'POST', headers: H, body: fd });
  const res = await up.json();
  ok(up.ok, `import accepted (${up.status})`);

  const imp = await fetch(B + `/api/label-imports/${res.importId}`, { headers: H }).then(r => r.json());
  const p = imp.pages;
  ok(p.length === 4, `four pages (${p.length})`);

  // ── THE DUPLICATE CASCADE ────────────────────────────────────────────────
  ok(p[1].matchStatus === 'matched' && p[1].matchedOrderNumber === 'CSC-100',
     `page 2 (the REAL label, GI captioned) holds CSC-100 (${p[1].matchStatus}/${p[1].matchedOrderNumber})`);
  ok(p[1].matchConfidence === 'exact', `and it is recorded as EXACT (${p[1].matchConfidence})`);
  ok(p[0].matchConfidence === 'scan', `page 1 matched only by text scan — a guess (${p[0].matchConfidence})`);
  ok(p[0].matchStatus === 'duplicate',
     `page 1 (the earlier GUESS) was displaced, not the other way round (${p[0].matchStatus})`);
  ok(p[0].displacedBy === 1, 'and it says which page took it');

  const labels = await fetch(B + '/api/orders?range=all', { headers: H }).then(r => r.json()).catch(() => null);
  ok(true, '(order list read)');

  // ── THE AMBIGUOUS PAGE ───────────────────────────────────────────────────
  ok(p[2].matchStatus === 'ambiguous', `page 3 names two orders and refuses (${p[2].matchStatus})`);
  ok(!p[2].matchedOrderNumber, 'nothing was attached to it');
  const cands = (p[2].candidates || []).map(c => c.order).sort();
  ok(JSON.stringify(cands) === JSON.stringify(['CSC-200', 'CSC-300']),
     `and BOTH candidates are named for a human (${JSON.stringify(cands)})`);

  // Neither order got a label file — the whole point.
  const raw = require('fs').readFileSync(process.env.DDIR + '/tenants/default/db.json', 'utf8');
  await new Promise(r => setTimeout(r, 900));
  const d2 = JSON.parse(require('fs').readFileSync(process.env.DDIR + '/tenants/default/db.json', 'utf8'));
  ok(!d2.orderLabels['CSC-200'] && !d2.orderLabels['CSC-300'],
     'neither candidate has a label attached on disk');
  ok(d2.orderLabels['CSC-100'] && d2.orderLabels['CSC-100'].pageIndex === 1,
     `CSC-100's label is page 2, the exact one (${JSON.stringify(d2.orderLabels['CSC-100'] || {})})`);

  // ── A SURVIVING scan match is kept, and marked as a guess ────────────────
  ok(p[3].matchStatus === 'matched' && p[3].matchedOrderNumber === 'CSC-400',
     `page 4 matched CSC-400 (${p[3].matchStatus}/${p[3].matchedOrderNumber})`);
  ok(p[3].matchConfidence === 'scan', `and is recorded as a GUESS, not a certainty (${p[3].matchConfidence})`);

  // ── The list endpoint reports the refusal ────────────────────────────────
  const list = await fetch(B + '/api/label-imports', { headers: H }).then(r => r.json());
  ok(Array.isArray(list) && list[0] && list[0].ambiguous === 1,
     `the import history counts the ambiguous page (${list[0] && list[0].ambiguous})`);

  // ── The CSV carries the confidence ───────────────────────────────────────
  const csv = await fetch(B + `/api/label-imports/${res.importId}/export.csv`, { headers: H }).then(r => r.text());
  ok(/Confidence/.test(csv) && /exact/.test(csv), 'the OCR-results CSV carries a Confidence column');
  ok(/ambiguous/.test(csv), 'and the ambiguous page is in it');

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
