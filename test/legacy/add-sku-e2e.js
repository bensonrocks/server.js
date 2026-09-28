// + Add SKU — one product typed in, for a client picked from the list.
//
// Asked as "what do I suggest if my admin needs to add a new SKU?" — the only
// door was a spreadsheet. The route is admin-or-master, creates at 0 on hand,
// folds the client onto the spelling in use, and refuses in words: an existing
// SKU (any case), a barcode another SKU of the same client carries, a blank
// name. Warehouse gets a real 403.
//
//   SERVER_JS=<path> boots another build.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('xlsx');

const S = __dirname;
const PORT = 4994;
const B = `http://localhost:${PORT}`;
const DDIR = path.join(S, 'add-sku-data');
const LOG = path.join(S, 'add-sku-server.log');
const MASTER = process.env.MASTER_KEY || '201432547E';
const SERVER = process.env.SERVER_JS || path.join(__dirname, '../../server.js');
const CLIENT = 'AddSkuCo';

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let kid;
async function portFree(url) { try { await fetch(url); return false; } catch { return true; } }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up: ' + url); }
async function stopAll() { if (kid) { try { process.kill(-kid.pid, 'SIGTERM'); } catch {} } await sleep(1000); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t, _status: r.status }; } };
async function login(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); if (!d.token) throw new Error('login ' + JSON.stringify(d)); return d.token; }
const H = tok => ({ 'Content-Type': 'application/json', 'x-auth-token': tok });
async function add(tok, body) { const r = await fetch(B + '/api/inventory/add-sku', { method: 'POST', headers: H(tok), body: JSON.stringify(body) }); return { status: r.status, body: await J(r) }; }
async function stock(tok, client) {
  const d = await J(await fetch(B + '/api/inventory?clientId=' + encodeURIComponent(client), { headers: { 'x-auth-token': tok } }));
  const rows = Array.isArray(d) ? d : (d.items || []); const m = {}; for (const r of rows) m[r.sku] = r; return m;
}

(async () => {
  if (!(await portFree(B + '/api/version'))) throw new Error(`port ${PORT} already answering — a stray server; refusing to measure the wrong process`);
  fs.rmSync(DDIR, { recursive: true, force: true });
  kid = spawn('node', [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
    stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')], detached: true });
  try {
    await waitUp(B + '/api/version');
    await sleep(2500);
    let admin = await login('demo', 'demo');
    await fetch(B + '/api/master/users', { method: 'POST', headers: { ...H(admin), 'x-master-key': MASTER },
      body: JSON.stringify({ id: 'whguy', name: 'Floor', password: 'whpass1', role: 'warehouse' }) });

    // Seed the client's item master with one product carrying a barcode.
    const ws = XLSX.utils.aoa_to_sheet([['SKU', 'Product Name', 'Barcode'], ['EXIST-1', 'Existing widget', '9550000000999']]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const fd = new FormData(); fd.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'master.xlsx');
    await fetch(B + `/api/master/client-profiles/${CLIENT}/item-master`, { method: 'POST', headers: { 'x-auth-token': admin, 'x-master-key': MASTER }, body: fd });

    // Warehouse is refused and nothing is created.
    const wh = await login('whguy', 'whpass1');
    let r = await add(wh, { clientId: CLIENT, sku: 'WH-TRY', name: 'Should not exist' });
    ok(r.status === 403, `warehouse refused (${r.status})`);
    admin = await login('demo', 'demo');   // one device per user — re-take the seat
    ok(!(await stock(admin, CLIENT))['WH-TRY'], 'warehouse attempt created nothing');

    // Refusals, each in words.
    r = await add(admin, { sku: 'X-1', name: 'x' });
    ok(r.status === 400 && r.body.field === 'client', `no client refused (${r.status} ${r.body.field})`);
    r = await add(admin, { clientId: CLIENT, sku: 'X-1', name: '' });
    ok(r.status === 400 && r.body.field === 'name', `blank name refused (${r.status})`);
    r = await add(admin, { clientId: CLIENT, sku: 'exist-1', name: 'Dup in another case' });
    ok(r.status === 409 && r.body.exists === 'EXIST-1' && /already exists/.test(r.body.error), `existing SKU refused case-insensitively (${r.status} ${r.body.error})`);
    r = await add(admin, { clientId: CLIENT, sku: 'NEW-2', name: 'Clashing barcode', barcode: '9550000000999' });
    ok(r.status === 409 && r.body.field === 'barcode' && (r.body.barcodeHolders || []).includes('EXIST-1'), `barcode already on EXIST-1 refused (${r.status})`);
    ok(!(await stock(admin, CLIENT))['NEW-2'], 'refused barcode created nothing');

    // The good case — typed with a different case of the client name.
    r = await add(admin, { clientId: 'addskuco', sku: 'NEW-1', name: 'Brand new widget', barcode: '9550000000111', brand: 'Acme' });
    ok(r.status === 201 && r.body.client === CLIENT, `created and folded onto "${CLIENT}" (${r.status} ${r.body.client})`);
    const s = await stock(admin, CLIENT);
    ok(s['NEW-1'] && s['NEW-1'].stock_qty === 0, `NEW-1 is in ${CLIENT}'s stock list at 0 on hand`);
    ok(s['NEW-1']?.name === 'Brand new widget' && s['NEW-1']?.barcode === '9550000000111' && s['NEW-1']?.brand === 'Acme', 'name, barcode and brand stored');
    ok(s['EXIST-1']?.barcode === '9550000000999', 'the existing SKU is untouched');
    const lower = await stock(admin, 'addskuco');
    ok(!!lower['NEW-1'] && Object.keys(lower).length === Object.keys(s).length, `no second account minted under the lower-case spelling (${Object.keys(lower)} vs ${Object.keys(s)})`);

    // A stock figure sent in the body is ignored — the SKU starts at 0.
    r = await add(admin, { clientId: CLIENT, sku: 'NEW-3', name: 'Sneaky stock', stock_qty: 500 });
    ok(r.status === 201 && (await stock(admin, CLIENT))['NEW-3']?.stock_qty === 0, 'a stock_qty in the request is ignored (still 0)');

    // The barcode resolves when scanned (what the floor will actually do).
    const tr = await J(await fetch(B + `/api/master/client-profiles/${CLIENT}/test-resolve?code=9550000000111`, { headers: { 'x-auth-token': admin, 'x-master-key': MASTER } }));
    ok(tr.scansAs === 'NEW-1' || tr.sku === 'NEW-1', `scanning its barcode resolves to NEW-1 (${JSON.stringify(tr).slice(0, 120)})`);

    // On the trail with who.
    await sleep(600);
    const db = JSON.parse(fs.readFileSync(path.join(DDIR, 'tenants', 'default', 'db.json'), 'utf8'));
    const log = (db.auditLog || []).filter(e => e.type === 'inventory_sku_added');
    ok(log.some(e => e.sku === 'NEW-1' && e.by === 'demo' && e.client === CLIENT), 'audited inventory_sku_added with client and who');
  } catch (e) { ok(false, 'threw: ' + e.message); }
  finally { await stopAll(); }
  console.log(`\n${fails.length ? 'FAILED' : 'ALL PASSED'} (${fails.length} failure(s))`);
  process.exit(fails.length ? 1 : 0);
})();
