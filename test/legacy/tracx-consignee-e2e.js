// "TRACX LABELS ALWAYS HAVING ISSUES" — the picking list hid the waybill.
//
// Reported from the floor with a photo of a Betime picking list. Keyfields
// prints the TracX waybill in the "Consignee" box and the buyer's name in
// "Consignee Address" — swapped — so every parser filed the waybill as the
// customer's NAME. The PDF parser then put the Reference (the marketplace id)
// in waybill_number and never read the Consignee box at all. A TracX label
// prints exactly that waybill and that marketplace id; neither had a home on
// the GI order, and the label sat unmatched. Every TracX label, every time.
//
// Through the REAL endpoints: the Keyfields-style picking-list PDF is uploaded,
// the GI order is read back carrying the waybill AND the marketplace id, and a
// 3-page TracX label PDF then matches page 1 by tracking number and page 2 by
// the marketplace id — both EXACT, neither a blind-scan guess — while page 3,
// a waybill nothing holds, stays unmatched.
//
// SERVER_JS=<path> points it at another build. The pre-fix build stores the
// marketplace id as the waybill, no tracking number anywhere, and pages 1–2
// never match.
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PICK, LABEL_STRAY } = require('./tracx-consignee-fixture.js');

const S      = __dirname;
const PORT   = 4795;
const B      = `http://localhost:${PORT}`;
const DDIR   = path.join(S, 'tracxc-data');
const LOG    = path.join(S, 'tracxc.log');
const PICKPDF  = path.join(S, 'tracx-picklist-fixture.pdf');
const LABELPDF = path.join(S, 'tracx-label2-fixture.pdf');
const SERVER = process.env.SERVER_JS || path.join(S, '../../server.js');
const MASTER = process.env.MASTER_KEY || '201432547E';

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };

let child = null, _bootedAt = null;
async function boot() {
  // Refuse a foreign server on the port, but give our own dying one a moment
  // (the standing gotcha, and its own gotcha).
  let before = null;
  for (let i = 0; i < 20; i++) {
    before = await fetch(B + '/api/version').then(r => r.json()).catch(() => null);
    if (!before) break;
    await sleep(500);
  }
  if (before) throw new Error(`port ${PORT} is serving a server this suite did not start (booted ${before.bootedAt})`);
  fs.rmSync(DDIR, { recursive: true, force: true }); fs.mkdirSync(DDIR, { recursive: true });
  child = spawn('node', [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
    stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')], detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try {
      const v = await fetch(B + '/api/version');
      if (v.ok) {
        const { bootedAt } = await v.json();
        if (bootedAt && bootedAt === _bootedAt) throw new Error('same process — the old server never died');
        _bootedAt = bootedAt; return;
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
  child = null; await sleep(2000);
}
let tok = '';
const H = () => ({ 'x-auth-token': tok, 'x-master-key': MASTER });
async function login() {
  const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) }));
  tok = d.token;
}
async function order(n) {
  const d = await J(await fetch(B + '/api/orders?range=all', { headers: H() }));
  return (Array.isArray(d) ? d : (d.orders || [])).find(o => o.order_number === n) || null;
}

(async () => {
  if (!fs.existsSync(PICKPDF) || !fs.existsSync(LABELPDF)) throw new Error('fixtures missing — run tracx-consignee-fixture.js');
  await boot(); await login();

  // ── 1. THE PICKING LIST, uploaded the way the office uploads it. ──────────
  const fd = new FormData();
  fd.append('orderFile', new Blob([fs.readFileSync(PICKPDF)], { type: 'application/pdf' }), 'GI-900001_picklist.pdf');
  fd.append('client_name', PICK.account);
  fd.append('direction', 'Outbound');
  fd.append('arrange_delivery', 'no');
  const up = await J(await fetch(B + '/api/upload', { method: 'POST', headers: H(), body: fd }));
  ok(!up.error, `the picking-list PDF uploads (${up.error || 'ok'})`);
  await sleep(2500);
  const o = await order(PICK.gi);
  ok(!!o, `the GI order is on the books as ${PICK.gi}`);
  ok((o?.waybill_number || '') === PICK.waybill,
     `its waybill is the TracX number from the Consignee box (got "${o?.waybill_number}")`);
  ok((o?.po_number || '') === PICK.ref,
     `and the marketplace id from the Reference box rides as po_number (got "${o?.po_number}")`);
  ok((o?.issue_no || '') === PICK.gi, 'the GI still lands in issue_no');
  ok((o?.customer_name || '') !== PICK.waybill, 'a waybill is never the customer\'s name');
  ok((o?.lines || o?.items || []).length === PICK.lines.length,
     `both lines parsed (${(o?.lines || o?.items || []).length})`);

  // ── 2. THE TRACX LABEL. ─────────────────────────────────────────────────
  const fd2 = new FormData();
  fd2.append('labelPdf', new Blob([fs.readFileSync(LABELPDF)], { type: 'application/pdf' }), 'tracx_labels.pdf');
  const imp = await J(await fetch(B + '/api/label-imports', { method: 'POST', headers: H(), body: fd2 }));
  ok(!imp.error && imp.importId, `the label PDF imports (${imp.error || 'ok'})`);
  const impId = imp.importId;
  await sleep(4000);   // the post-upload OCR/rematch pass runs on setImmediate
  const det = await J(await fetch(`${B}/api/label-imports/${impId}`, { headers: H() }));
  const pages = det.pages || det.import?.pages || [];
  ok(pages.length === 3, `three pages (${pages.length})`);
  const p1 = pages[0] || {}, p2 = pages[1] || {}, p3 = pages[2] || {};
  ok(p1.matchStatus === 'matched' && p1.matchedOrderNumber === PICK.gi,
     `page 1 (waybill printed) matches ${PICK.gi} (${p1.matchStatus} → ${p1.matchedOrderNumber})`);
  ok(/tracking/.test(p1.matchMethod || ''), `via the tracking number (${p1.matchMethod})`);
  ok((p1.matchConfidence || '') === 'exact', `an EXACT hit, not a blind-scan guess (${p1.matchConfidence})`);
  // Page 2 prints ONLY the marketplace id. It RESOLVES to the same order —
  // which is the fix — and is then filed `duplicate` of page 1, because it
  // carries no tracking number of its own (the documented parcel rule: a
  // second page is another parcel only when its tracking number differs).
  ok(['matched', 'duplicate'].includes(p2.matchStatus) && p2.matchedOrderNumber === PICK.gi,
     `page 2 (marketplace id only) resolves to ${PICK.gi} too (${p2.matchStatus} → ${p2.matchedOrderNumber})`);
  ok(/order_number/.test(p2.matchMethod || ''), `via the order number the label prints (${p2.matchMethod})`);
  ok((p2.matchConfidence || '') === 'exact', `also exact (${p2.matchConfidence})`);
  ok(p3.matchStatus !== 'matched', `page 3 (a waybill nothing holds, ${LABEL_STRAY}) stays unmatched (${p3.matchStatus})`);

  // ── 3. AND IT PRINTS AT THE BENCH. ──────────────────────────────────────
  const pdf = await fetch(`${B}/api/order-label/${encodeURIComponent(PICK.gi)}/pdf`, { headers: H() });
  ok(pdf.status === 200 && /pdf/i.test(pdf.headers.get('content-type') || ''), `the label is served for ${PICK.gi} (${pdf.status})`);

  console.log('\n' + (fails.length ? `FAILED ${fails.length}` : 'ALL PASSED'));
  await stop();
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stop(); process.exit(2); });
