// Profile aliases: an order filed under 'betime' takes the PRINT/LABEL settings
// (outletLookup) of [BETIME] - BETIME when that profile lists 'betime' as an
// alias. Nothing else resolves through aliases.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
eval(grab('function _abNorm', '// Fuzzy similarity'));
const outletLookup = require('../lib/outlet-lookup');
eval(grab('// PROFILE ALIASES', '// ADDRESS BOOK → ORDERS.'));

const db = {
  addressBook: [{ code: 'BUJ (050)', name: 'BUGIS JUNCTION', chain: 'Watsons', zip: '188021' }],
  clientProfiles: [
    { client: '[BETIME] - BETIME', outletLookup: true, aliases: ['betime'] },
    { client: 'Betime Online' },
    { client: 'Own', outletLookup: false, aliases: [] },
  ],
};
// resolver: exact name first, then alias (case/space-insensitive), else null
assert.strictEqual(profileForClient(db, '[BETIME] - BETIME').client, '[BETIME] - BETIME');
assert.strictEqual(profileForClient(db, ' BETIME ').client, '[BETIME] - BETIME');
assert.strictEqual(profileForClient(db, 'Betime Online').client, 'Betime Online');
assert.strictEqual(profileForClient(db, 'nobody'), null);
// an exact profile beats an alias pointing elsewhere
assert.strictEqual(profileForClient({ clientProfiles: [{ client: 'A', aliases: ['B'] }, { client: 'B' }] }, 'b').client, 'B');

// outlet lookup follows the alias
const order = { order_number: '26516084', customer_name: 'BUJ (050)', postal_code: '' };
assert.strictEqual(outletViewFor(db, order, 'betime').customer_name, 'Watsons – BUGIS JUNCTION (BUJ 050)');
assert.strictEqual(outletViewFor(db, order, 'betime').postal_code, '188021');
assert.strictEqual(outletViewFor(db, order, 'Betime Online').customer_name, 'BUJ (050)');
assert.strictEqual(order.customer_name, 'BUJ (050)');            // stored order untouched

// normalising: trimmed, deduped, self-name dropped, comma/newline strings accepted
assert.deepStrictEqual(normalizeProfileAliases(' betime, BETIME ,[BETIME] - BETIME,,x', '[BETIME] - BETIME'), ['betime', 'x']);
assert.deepStrictEqual(normalizeProfileAliases(['a', 'A', ''], 'z'), ['a']);

// profile save validates aliases before changing anything; clashes are refused
const save = grab("app.post('/api/master/client-profiles', express.json()", "app.delete('/api/master/client-profiles/:client'");
assert.ok(save.indexOf('aliasesNext = normalizeProfileAliases') < save.indexOf('if (!p) {'), 'validated before mutation');
assert.ok(/Already a profile or another profile's alias/.test(save));

// ONLY print/label settings use the resolver — stock, item master, billing,
// portal and reports must stay keyed on the order's own client name.
const uses = src.split('\n').filter(l => /profileForClient\(/.test(l) && !/^function profileForClient/.test(l.trim()));
assert.deepStrictEqual(uses.map(l => l.trim()), ['const p = profileForClient(db, clientName);']);
assert.ok(/function outletLookupOn\(db, clientName\) \{\s*const p = profileForClient/.test(src));
console.log('profile-aliases: ok');
