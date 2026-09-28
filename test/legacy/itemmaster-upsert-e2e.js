// Item master re-upload must not reset stock or wipe barcodes.
//
// Asked as "how do I add a new SKU?": the answer was "upload the item master"
// — and re-uploading a FULL item master to add one SKU used to set every
// existing SKU's on-hand to 0 (a blank / missing Qty became `?? 0`) and blank
// its barcode, with no movement row and no undo. Now a blank cell means "not
// given", and a quantity the file DOES give moves on-hand through the ledger.
//
//   SERVER_JS=<path> boots another build (a pre-fix comparison).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('xlsx');

const S = __dirname;
const PORT = 4993;
const B = `http://localhost:${PORT}`;
const DDIR = path.join(S, 'itemmaster-upsert-data');
const LOG = path.join(S, 'itemmaster-upsert-server.log');
const MASTER = process.env.MASTER_KEY || '201432547E';
const SERVER = process.env.SERVER_JS || path.join(__dirname, '../../server.js');
const CLIENT = 'ImUpsertCo';

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let kid;
async function portFree(url) { try { await fetch(url); return false; } catch { return true; } }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up: ' + url); }
async function stopAll() { if (kid) { try { process.kill(-kid.pid, 'SIGTERM'); } catch {} } await sleep(1000); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t, _status: r.status }; } };
async function login(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); if (!d.token) throw new Error('login ' + JSON.stringify(d)); return d.token; }

function xlsxOf(header, rows) {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
async function uploadMaster(tok, buf, name) {
  const fd = new FormData(); fd.append('file', new Blob([buf]), name);
  const r = await fetch(B + `/api/master/client-profiles/${encodeURIComponent(CLIENT)}/item-master`,
    { method: 'POST', headers: { 'x-auth-token': tok, 'x-master-key': MASTER }, body: fd });
  return { status: r.status, body: await J(r) };
}
async function stock(tok) {
  const d = await J(await fetch(B + '/api/inventory?clientId=' + encodeURIComponent(CLIENT), { headers: { 'x-auth-token': tok } }));
  const rows = Array.isArray(d) ? d : (d.items || d.rows || []);
  const m = {}; for (const r of rows) m[r.sku] = r; return m;
}

(async () => {
  if (!(await portFree(B + '/api/version'))) throw new Error(`port ${PORT} already answering — a stray server; refusing to measure the wrong process`);
  fs.rmSync(DDIR, { recursive: true, force: true });
  kid = spawn('node', [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
    stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')], detached: true });
  try {
    await waitUp(B + '/api/version');
    await sleep(2500);
    const tok = await login('demo', 'demo');

    // 1. First load: two SKUs with barcodes and stock.
    let r = await uploadMaster(tok, xlsxOf(['SKU', 'Product Name', 'Barcode', 'Qty'], [
      ['IMU-AAA', 'Alpha widget', '9550000000011', 40],
      ['IMU-BBB', 'Bravo widget', '9550000000028', 25],
    ]), 'master-v1.xlsx');
    ok(r.status === 200 && r.body.created === 2, `first upload creates 2 (got ${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);
    let s = await stock(tok);
    ok(s['IMU-AAA']?.stock_qty === 40 && s['IMU-BBB']?.stock_qty === 25, `opening stock 40/25 (got ${s['IMU-AAA']?.stock_qty}/${s['IMU-BBB']?.stock_qty})`);

    // 2. The reported shape: the WHOLE item master re-uploaded to add ONE new
    // SKU, with no Qty column at all and a blank barcode on an existing row.
    r = await uploadMaster(tok, xlsxOf(['SKU', 'Product Name', 'Barcode'], [
      ['IMU-AAA', 'Alpha widget (renamed)', ''],
      ['IMU-BBB', 'Bravo widget', '9550000000028'],
      ['IMU-CCC', 'Charlie widget', '9550000000035'],
    ]), 'master-v2.xlsx');
    ok(r.status === 200 && r.body.created === 1 && r.body.updated === 2, `re-upload: 1 new, 2 existing (got ${JSON.stringify(r.body).slice(0, 160)})`);
    ok(r.body.stockSet === 0, `no quantity column → no on-hand changed (stockSet=${r.body.stockSet})`);
    s = await stock(tok);
    ok(s['IMU-AAA']?.stock_qty === 40, `IMU-AAA keeps its 40 (got ${s['IMU-AAA']?.stock_qty})`);
    ok(s['IMU-BBB']?.stock_qty === 25, `IMU-BBB keeps its 25 (got ${s['IMU-BBB']?.stock_qty})`);
    ok(s['IMU-AAA']?.barcode === '9550000000011', `a blank barcode cell does not wipe the barcode (got "${s['IMU-AAA']?.barcode}")`);
    ok(s['IMU-AAA']?.name === 'Alpha widget (renamed)', `the name still updates (got "${s['IMU-AAA']?.name}")`);
    ok(s['IMU-CCC'] && s['IMU-CCC'].stock_qty === 0 && s['IMU-CCC'].barcode === '9550000000035', `new SKU created at 0 with its barcode`);

    // 3. A Qty column present but BLANK on a row is still "not given".
    r = await uploadMaster(tok, xlsxOf(['SKU', 'Product Name', 'Qty'], [
      ['IMU-AAA', 'Alpha widget (renamed)', ''],
      ['IMU-BBB', 'Bravo widget', 30],
    ]), 'master-v3.xlsx');
    s = await stock(tok);
    ok(s['IMU-AAA']?.stock_qty === 40, `blank Qty cell leaves IMU-AAA at 40 (got ${s['IMU-AAA']?.stock_qty})`);
    ok(s['IMU-BBB']?.stock_qty === 30, `a GIVEN quantity is still applied: IMU-BBB 25 → 30 (got ${s['IMU-BBB']?.stock_qty})`);
    ok(r.body.stockSet === 1 && r.body.stockSetSkus?.[0]?.from === 25 && r.body.stockSetSkus?.[0]?.to === 30, `the change is reported with from/to`);

    // 4. …and it went through the ledger, not a silent overwrite.
    const mv = await J(await fetch(B + `/api/inventory/IMU-BBB/movements?clientId=${encodeURIComponent(CLIENT)}`, { headers: { 'x-auth-token': tok } }));
    const mvRows = Array.isArray(mv) ? mv : (mv.movements || mv.rows || []);
    if (mvRows.length || mv._status !== 404) {
      ok(mvRows.some(m => Number(m.qty) === 5 && /item master/i.test(m.reason || '')), `a +5 movement names the item master upload`);
    } else console.log('SKIP - no movements route to read the ledger from');
  } catch (e) { ok(false, 'threw: ' + e.message); }
  finally { await stopAll(); }
  console.log(`\n${fails.length ? 'FAILED' : 'ALL PASSED'} (${fails.length} failure(s))`);
  process.exit(fails.length ? 1 : 0);
})();
