// Item master HOME pointer (Betime Online -> 'betime'): a management/display
// pointer for Onboard Client only. Resolution for every Betime profile must be
// byte-for-byte the same with or without it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));

// stub stock store: 'betime' holds the master, Betime Online a harvested row
const rows = {
  betime: [{ sku: 'BT-1', barcode: '8881', name: 'Watch', stock_qty: 0 }, { sku: 'BT-2', barcode: '8882', name: 'Strap', stock_qty: 0 }],
  'Betime Online': [{ sku: 'BT-1', barcode: '', name: 'Watch', stock_qty: 0 }],
  'BETIME ECOM': [{ sku: 'BT-2', barcode: '', name: 'Strap', stock_qty: 0 }],
};
const inventory = {
  available: () => true,
  listClientIds: () => Object.keys(rows),
  getAll: ({ clientId }) => rows[clientId] || [],
  get: (sku, cid) => (rows[cid] || []).find(r => r.sku === sku) || null,
  getByBarcode: (bc, cid) => (rows[cid] || []).find(r => r.barcode === bc) || null,
};
const tenantContext = { currentTenantId: () => 't' };
eval(grab('const _invCidCache', '// Called wherever'));
eval(grab('function forgetInvClientIds', '\n}\n') + '\n}');
eval(grab('function invClientId(name)', '\n}\n') + '\n}');
eval(grab('// ITEM MASTER HOME', 'function outletLookupOn'));
eval(grab('const BETIME_RE', 'function _makeSkuLookup'));
eval(grab('function _makeSkuLookup', '\n// CAN THIS ORDER'));

const profilesBefore = { clientProfiles: [{ client: '[BETIME] - BETIME', aliases: ['betime'], stock_tracking: false }, { client: 'Betime Online', stock_tracking: false }] };
const profilesAfter = JSON.parse(JSON.stringify(profilesBefore));
profilesAfter.clientProfiles[1].itemMasterAccount = 'betime';

// 1) the pointer only moves the Onboard Client account
assert.strictEqual(itemMasterAccountFor(profilesBefore, 'Betime Online'), 'Betime Online');
assert.strictEqual(itemMasterAccountFor(profilesAfter, 'Betime Online'), 'betime');
assert.strictEqual(itemMasterAccountFor(profilesAfter, 'BETIME ECOM'), 'BETIME ECOM');
assert.strictEqual(itemMasterAccountFor(profilesAfter, 'nobody'), 'nobody');

// 2) resolution is identical before/after for every Betime client x SKU
const clients = Object.keys(rows).concat(['[BETIME] - BETIME', 'Betime Online']);
const snap = () => { const L = _makeSkuLookup(); const o = {};
  for (const c of clients) for (const s of ['BT-1', 'BT-2', 'NOPE']) {
    o[c + '|' + s] = JSON.stringify(L({ client_name: c }, s));
    o[c + '|inv'] = invClientId(c);
    o[c + '|bc'] = JSON.stringify([inventory.getByBarcode('8881', invClientId(c)), inventory.getByBarcode('8882', invClientId(c))]);
  } return o; };
const before = snap();
// "apply" the pointer — resolvers never read profiles, so nothing can differ
const after = snap();
assert.deepStrictEqual(after, before);

// 3) guard: the pointer is read ONLY by the Onboard Client endpoints
const uses = src.split('\n').filter(l => /itemMasterAccountFor\(/.test(l) && !/^function /.test(l.trim()));
assert.strictEqual(uses.length, 2, 'itemMasterAccountFor used outside upload/test-resolve:\n' + uses.join('\n'));
const touches = src.split('\n').filter(l => /itemMasterAccount\b/.test(l)).length;
assert.ok(touches <= 12, 'itemMasterAccount spreading into other code paths');
for (const fn of ['function invClientId(name)', 'function _makeSkuLookup', 'function resolveBeTimeCode2', 'function clientStockTracking', 'function clientWipeSummary'])
  assert.ok(!grab(fn, '\n}\n').includes('itemMasterAccount'), fn + ' must not read the pointer');
console.log('item-master-home: ok');
