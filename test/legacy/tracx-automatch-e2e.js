// "AUTO MATCH AGAIN" — THE 36 TRACXLOGIS PAGES THAT NOTHING COULD RESOLVE.
//
// Reported from the floor (17 Sep 2026) with three screenshots: a 36-page
// TracXLogis label import where EVERY page read "unmatched · No key fields
// recognized"; the enlarged label, whose human-readable caption under the
// barcode reads `QSP22214 1513`; and the Match-to-Order picker finding
// GI-143992 / BETIME ECOM the moment `1513` was typed — so the order was in
// the system all along, carrying `QSP222141513` as its waybill.
//
// TWO ways that number was unreachable, and this suite covers both:
//   1. THE CAPTION IS TYPESET IN GROUPS, so the text layer yields it as two
//      positioned runs. Every tracking pattern wanted 9+ CONTIGUOUS digits, so
//      the extraction came back completely blank, and the blind whole-page
//      scan is deliberately confined to one token and could not see it either.
//   2. WHEN THE CAPTION IS DRAWN AS AN IMAGE the page still has a real text
//      layer (heading, address, service line) — so the OCR gate, which read
//      "no text layer at all", never fired on it. A page with text and no
//      identifier was simply never read.
//
// The state proved here is the one the floor is actually in: THE IMPORT IS
// ALREADY UPLOADED and its pages are stored unmatched with no extracted
// fields. Nothing is re-uploaded — the suite presses ⚡ Auto Match Unmatched
// (POST /api/label-imports/:id/rematch) and that alone has to resolve them.
//
// The fixture is printed through headless Chromium (pdf-lib documents are
// unreadable by this repo's pdf-parse) and carries invented consignees — a
// real carrier label carries a customer's name and address and is never
// committed.
//
// PRE-FIX: pages 1 and 2 stay unmatched however many times Auto Match is
// pressed, which is the reported screenshot exactly.
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { buildTracxPdf } = require('./tracx-fixture.js');

const S      = __dirname;
const PORT   = 4796;
const B      = `http://localhost:${PORT}`;
const DDIR   = path.join(S, 'tracx-data');
const DBP    = path.join(DDIR, 'tenants', 'default', 'db.json');
const LOG    = path.join(S, 'tracx.log');
const PDF    = path.join(S, 'tracx-fixture.pdf');
const SERVER = process.env.SERVER_JS || path.join(S, '../../server.js');
const MASTER = process.env.MASTER_KEY || '201432547E';

const CLIENT = 'BETIME ECOM';
// One order per page. The waybills are what the captions spell out.
const ORDERS = [
  { n: 'GI-143992', wb: 'QSP222141513', page: 1 },   // caption split across a space
  { n: 'GI-143993', wb: 'QSP222147788', page: 2 },   // caption drawn as a bitmap
  { n: 'GI-143994', wb: 'QSP222149999', page: 3 },   // plain contiguous — the control
];

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };

let child = null;
let _bootedAt = null;
async function boot() {
  // ANSWER THE QUESTION "IS THIS SERVER MINE?" BEFORE TRUSTING A SINGLE
  // ASSERTION. A server left behind on this port by another run happily
  // answers every request from ITS data dir — so the suite goes red with
  // things like "label import accepted (409)", which reads as an app fault
  // and is not one. (Cost a confusing run; the standing gotcha in CLAUDE.md
  // says the harness must assert `bootedAt` MOVED on every boot, and this
  // suite did not.) Fail loudly here instead of measuring the wrong process.
  // WAIT FOR THE PORT, THEN JUDGE. The first cut threw the moment the port
  // answered, which fired on the suite's OWN just-stopped server — the socket
  // can outlive the SIGTERM by a moment — and crashed a legitimate run at the
  // second boot(). A flaky guard is worse than the hole it closes. So: give a
  // dying server a few seconds to go, and only call it foreign if it is STILL
  // answering after that.
  let before = null;
  for (let i = 0; i < 20; i++) {
    before = await fetch(B + '/api/version').then(r => r.json()).catch(() => null);
    if (!before) break;
    await sleep(500);
  }
  if (before) throw new Error(
    `port ${PORT} is still serving a server this suite did not start `
    + `(booted ${before.bootedAt}) after 10s. Stop it before running — otherwise `
    + `every assertion below measures the wrong process.`);
  child = spawn('node', [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
    stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')],
    detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try {
      const v = await fetch(B + '/api/version');
      if (v.ok) {
        const { bootedAt } = await v.json();
        if (bootedAt && bootedAt === _bootedAt) throw new Error('same process — the old server never died');
        _bootedAt = bootedAt;
        return;
      }
    } catch (e) { if (/never died/.test(e.message)) throw e; }
    await sleep(500);
  }
  throw new Error('server did not boot');
}
async function stop() {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  child = null;
  // db.json is written on a DEFERRED timer — stopping the instant a request
  // returns can lose what it just wrote. (Standing gotcha in CLAUDE.md.)
  await sleep(2000);
}
async function login(id, pw) {
  const d = await J(await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, password: pw }),
  }));
  if (!d.token) throw new Error('login ' + id + ': ' + JSON.stringify(d));
  return d.token;
}
const H = t => ({ 'x-auth-token': t });

async function uploadLabels(tok, file, name) {
  const fd = new FormData();
  fd.append('labelPdf', new Blob([fs.readFileSync(file)], { type: 'application/pdf' }), name);
  const r = await fetch(B + '/api/label-imports', { method: 'POST', headers: H(tok), body: fd });
  return { status: r.status, data: await J(r) };
}
// The LIST route returns counts only — the review screen reads the pages from
// the per-import route, so that is what the assertions read.
async function review(tok, id) {
  return await J(await fetch(`${B}/api/label-imports/${id}`, { headers: H(tok) }));
}
async function autoMatch(tok, id) {
  const r = await fetch(`${B}/api/label-imports/${id}/rematch`, {
    method: 'POST', headers: { ...H(tok), 'Content-Type': 'application/json' },
    body: JSON.stringify({}),                 // ⚡ Auto Match Unmatched — not "all"
  });
  return { status: r.status, data: await J(r) };
}
const readDb  = () => JSON.parse(fs.readFileSync(DBP, 'utf8'));
const writeDb = d => fs.writeFileSync(DBP, JSON.stringify(d, null, 2));
const pageOf  = (imp, n) => (imp.pages || []).find(p => p.pageIndex === n - 1);

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true });
  fs.rmSync(LOG, { force: true });
  // THE FIXTURE IS COMMITTED, like the two perf PDFs, so this suite runs in CI
  // — which is pure Node and installs no browser. It is only rebuilt when it
  // is missing, and rebuilding needs Chromium (see tracx-fixture.js for why a
  // pdf-lib document would not do).
  if (!fs.existsSync(PDF)) await buildTracxPdf(PDF);
  ok(fs.existsSync(PDF) && fs.statSync(PDF).size > 5000, 'the TracXLogis-shaped label PDF is available');

  // ── 1. THE IMPORT ARRIVES BEFORE THE ORDERS DO ──────────────────────────
  // Uploaded against an empty system, so nothing can match and the pages are
  // stored exactly as the floor's are: unmatched.
  await boot();
  const tok = await login('demo', 'demo');
  const up = await uploadLabels(tok, PDF, 'TracXLogis_labels.pdf');
  ok(up.status === 200, `label import accepted (${up.status})`);
  const impId = up.data.import?.id || up.data.id;
  ok(!!impId, 'import id returned');
  const after = await review(tok, impId);
  ok(after?.pages?.length === 3, `3 pages split out (${after?.pages?.length})`);
  ok((after.pages || []).length === 3 && after.pages.every(p => p.matchStatus === 'unmatched'),
     'every page unmatched — there are no orders yet');
  await stop();

  // ── 2. SEED THE STATE THE FLOOR IS IN ───────────────────────────────────
  // The orders exist and carry the waybills the captions spell out, and the
  // import's pages hold NO extracted fields — which is what the pre-fix
  // extraction stored for these pages, and what the review screen was
  // reporting as "No key fields recognized". The cached extraction is what
  // rematchLabelImport rebuilds from page.rawText, so this is the honest
  // reproduction of an import uploaded under the old rules.
  {
    const db = readDb();
    db.batches = [{
      id: 'batch-tracx', idealscan_code: 'IS-260917-01', client_name: CLIENT,
      filename: 'gi-analysis.xlsx', uploaded_at: new Date().toISOString(), uploaded_by: 'demo',
      orders: ORDERS.map(o => ({
        order_number: o.n, waybill_number: o.wb, issue_no: o.n,
        date: new Date().toISOString().slice(0, 10), total_qty: 1,
        lines: [{ sku: 'TRX-SKU', description: 'Test item', qty: 1 }],
      })),
      orderStates: Object.fromEntries(ORDERS.map(o => [o.n, { status: 'pending', scanned: {} }])),
    }];
    const imp = (db.labelImports || []).find(i => i.id === impId);
    let hadText = 0;
    for (const p of imp.pages) {
      if ((p.rawText || '').trim()) hadText++;
      p.extracted = {};                 // the pre-fix cache: nothing recognised
      p.matchStatus = 'unmatched';
      p.matchedOrderNumber = null;
      p.matchMethod = null;
      p.matchConfidence = null;
      delete p.ocr;
    }
    db.orderLabels = {};
    writeDb(db);
    ok(hadText === 3,
       'all three pages have a REAL text layer — this is not an image-only PDF, ' +
       'which is why the old OCR gate never fired on any of them');
  }

  // ── 3. ONE PRESS OF ⚡ AUTO MATCH UNMATCHED ─────────────────────────────
  await boot();
  const tok2 = await login('demo', 'demo');
  const t0 = Date.now();
  const rm = await autoMatch(tok2, impId);
  ok(rm.status === 200, `Auto Match ran (${rm.status})`);
  ok(rm.data.newMatches === 3, `it resolved all 3 pages (newMatches=${rm.data.newMatches})`);
  console.log(`      (Auto Match took ${Math.round((Date.now() - t0) / 1000)}s — page 2 goes through OCR)`);

  const imp2 = await review(tok2, impId);
  for (const o of ORDERS) {
    const p = pageOf(imp2, o.page);
    ok(p?.matchStatus === 'matched', `page ${o.page} is matched (${p?.matchStatus})`);
    ok(p?.matchedOrderNumber === o.n, `page ${o.page} went to ${o.n} (${p?.matchedOrderNumber})`);
    ok(String(p?.extracted?.trackingNumber || '') === o.wb,
       `page ${o.page} now reads its tracking number as ${o.wb} (${p?.extracted?.trackingNumber || '—'})`);
    ok(String(p?.matchMethod || '').includes('waybill') || String(p?.matchMethod || '').includes('tracking'),
       `page ${o.page} matched on the WAYBILL, an exact lookup — not the blind scan (via ${p?.matchMethod})`);
    ok(p?.matchConfidence === 'exact', `page ${o.page} is exact, not a guess (${p?.matchConfidence})`);
  }

  // The split caption is the reported page, and it must NOT have needed OCR —
  // the number was on the text layer the whole time.
  ok(!pageOf(imp2, 1).ocr, 'page 1 resolved from its own TEXT LAYER, with no OCR at all');
  ok(pageOf(imp2, 2).ocr === true,
     'page 2 was read by OCR — its caption is a bitmap, and the page has text everywhere else');
  ok(!pageOf(imp2, 3).ocr, 'page 3, the plain contiguous control, needed no OCR either');

  // ── 4. THE LABEL IS REALLY ON THE ORDER ─────────────────────────────────
  // Matched on the review screen is not the same as printable at the bench.
  for (const o of ORDERS) {
    const r = await fetch(`${B}/api/order-label/${encodeURIComponent(o.n)}/pdf`, { headers: H(tok2) });
    const buf = Buffer.from(await r.arrayBuffer());
    ok(r.status === 200 && buf.slice(0, 4).toString() === '%PDF',
       `${o.n} prints its label at the bench (${r.status}, ${buf.length}b)`);
  }
  await sleep(2500);                    // db.json is written on a deferred timer
  const db2 = readDb();
  for (const o of ORDERS) {
    ok(!!db2.orderLabels?.[o.n], `${o.n} holds its label on disk, not just in memory`);
  }

  // ── 4b. A RESOLVED IMPORT RAISES NO ALARM ───────────────────────────────
  // The health signal must be SILENT on a healthy import, or it is noise
  // people learn to scroll past — which is exactly how the next unreadable
  // shape would go unnoticed again. Page 2 went through OCR and resolved, so
  // "read by everything" alone must not be enough to count it.
  const h1 = await J(await fetch(B + '/api/system-health', { headers: H(tok2) }));
  ok(h1.labelPagesUnreadable === 0,
     `a fully-resolved import reports NO unreadable pages (${h1.labelPagesUnreadable})`);

  // ── 5. A SECOND PRESS IS A NO-OP ────────────────────────────────────────
  const rm2 = await autoMatch(tok2, impId);
  ok(rm2.data.newMatches === 0, `pressing Auto Match again changes nothing (newMatches=${rm2.data.newMatches})`);
  const imp3 = await review(tok2, impId);
  ok(ORDERS.every(o => pageOf(imp3, o.page).matchedOrderNumber === o.n),
     'and every page is still on the order it was matched to');

  // ── 6. A FRESH UPLOAD OF THIS SHAPE NEEDS NO PRESS AT ALL ───────────────
  // The import pass carries the same re-read, so a label like this arriving
  // tomorrow matches on its own. Same PDF, so the earlier import is removed
  // first — otherwise the same-file check asks before replacing it.
  const del = await fetch(`${B}/api/label-imports/${impId}`, {
    method: 'DELETE', headers: { ...H(tok2), 'x-master-key': MASTER },
  });
  ok(del.status === 200, `the first import is removed (${del.status})`);
  const up2 = await uploadLabels(tok2, PDF, 'TracXLogis_labels.pdf');
  ok(up2.status === 200, `the same labels uploaded again, orders now present (${up2.status})`);
  const impId2 = up2.data.import?.id || up2.data.id;
  // The split caption and the contiguous one resolve in the upload pass
  // itself; the image caption is picked up by the background OCR it kicks off.
  let imp4 = null;
  for (let i = 0; i < 40; i++) {
    imp4 = await review(tok2, impId2);
    if ((imp4.pages || []).every(p => p.matchStatus === 'matched')) break;
    await sleep(500);
  }
  ok((imp4.pages || []).length === 3 && imp4.pages.every(p => p.matchStatus === 'matched'),
     'all 3 pages matched themselves on upload, with nobody pressing anything');
  ok(ORDERS.every(o => pageOf(imp4, o.page).matchedOrderNumber === o.n),
     'and each went to the right order');

  // ── 7. THE ORDINARY LABELS ARE UNTOUCHED ────────────────────────────────
  // The join is a LAST RESORT, consulted only when the contiguous patterns
  // found nothing, so nothing that already extracted can change. These read
  // the repo's own extractor directly, so they assert the NEW rules even when
  // the suite is pointed at a pre-fix server with SERVER_JS — which is right:
  // they are the "nothing else moved" checks for this change.
  const { extractLabelFields } = require('../../lib/label-extract.js');
  const unchanged = [
    ['Lazada',  'LZSGD1015082878\nOrder No: 169103066792054\n', 'LZSGD1015082878', '169103066792054'],
    ['Shopee',  'SPXSG123456789012\nOrder ID: 260726PNCVDSYK\n', 'SPXSG123456789012', '260726PNCVDSYK'],
    ['Postal',  'RR123456789SG\n',                               'RR123456789SG',    ''],
    ['TRACX',   'TXSGD03800975\n',                               'TXSGD03800975',    ''],
  ];
  for (const [name, text, wantT, wantO] of unchanged) {
    const f = extractLabelFields(text);
    ok(f.trackingNumber === wantT && f.orderNumber === wantO,
       `${name} label extraction is byte-for-byte what it was (${f.trackingNumber}/${f.orderNumber || '—'})`);
  }
  // And the join can never re-open the wrong-order bug the token rule closed:
  // a printed DATE next to a letter once became the recycled order number
  // 20260716-H and claimed somebody else's page.
  ok(extractLabelFields('Printed 2026-07-16 H\nDeliver To: X\n').trackingNumber === '',
     'a printed date is still not glued into a tracking number');
  ok(extractLabelFields('SG 312139 3104\n').trackingNumber === '',
     'a word followed by two numbers is not a tracking number — the head must be letters+digits');
  ok(extractLabelFields('QSP22214\n1513\n').trackingNumber === '',
     'two runs on DIFFERENT LINES are never joined — only a same-line caption is');

  // ── 8. THE NEXT UNREADABLE SHAPE ANNOUNCES ITSELF ───────────────────────
  // The fix above handles the two shapes that were REPORTED. The next one will
  // be a shape nobody has seen, so the durable guard is the end-state being
  // countable: read by the text layer AND by OCR, still no identifier. Seeded
  // directly, because that is the only way to hold the boundary still — the
  // point is which pages count and which deliberately do not.
  await stop();
  {
    const db = readDb();
    const imp = (db.labelImports || []).find(i => i.id === impId2);
    const p = n => imp.pages.find(x => x.pageIndex === n - 1);
    // READ BY EVERYTHING, STILL NOTHING → counts.
    Object.assign(p(1), {
      matchStatus: 'unmatched', matchedOrderNumber: null, extracted: {},
      ocrForFieldsStrategy: 'full-page-render-v1',        // the fields retry ran
    });
    // NOT YET RE-READ → does NOT count. This is a button press away, not a gap
    // in what we can read, and counting it would make the signal noise.
    Object.assign(p(3), {
      matchStatus: 'unmatched', matchedOrderNumber: null, extracted: {},
    });
    delete p(3).ocrForFieldsStrategy; delete p(3).ocr;
    // AN OLD IMPORT IN THE SAME STATE → aged out, so the count cannot become a
    // permanent red number nobody can clear.
    db.labelImports.push({
      id: 'imp-ancient', filename: 'old-labels.pdf', pageCount: 1,
      uploadedAt: new Date(Date.now() - 60 * 86400000).toISOString(), uploadedBy: 'demo',
      pages: [{ pageIndex: 0, matchStatus: 'unmatched', rawText: 'something',
                extracted: {}, ocrForFieldsStrategy: 'full-page-render-v1' }],
    });
    writeDb(db);
  }
  await boot();
  const tok3 = await login('demo', 'demo');
  const h2 = await J(await fetch(B + '/api/system-health', { headers: H(tok3) }));
  ok(h2.labelPagesUnreadable === 1,
     `exactly the page read by everything is counted (${h2.labelPagesUnreadable}) — `
     + 'not the one still waiting for Auto Match, and not the 60-day-old import');
  ok((h2.labelUnreadableImports || []).some(i => i.filename === 'TracXLogis_labels.pdf'),
     'and the alarm NAMES the file, so it can be found');
  ok(!(h2.labelUnreadableImports || []).some(i => i.id === 'imp-ancient'),
     'the aged-out import is not named either');

  // Matching it by hand is what clears it — the count follows the real state
  // rather than needing anyone to dismiss it.
  const mm = await fetch(`${B}/api/label-imports/${impId2}/pages/0/match`, {
    method: 'POST', headers: { ...H(tok3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderNumber: ORDERS[0].n }),
  });
  ok(mm.status === 200, `the page is matched by hand (${mm.status})`);
  const h3 = await J(await fetch(B + '/api/system-health', { headers: H(tok3) }));
  ok(h3.labelPagesUnreadable === 0,
     `and the alarm clears itself (${h3.labelPagesUnreadable}) — no dismiss button to forget`);

  await stop();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASSED'));
  fails.forEach(f => console.log('  x ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stop(); process.exit(2); });
