// lib/portal-order-entry.js — parsing, validation and CSV rules (no server).
const test = require('node:test');
const assert = require('assert');
const XLSX = require('xlsx');
const e = require('../lib/portal-order-entry');
const items = new Map([['SKU-A', { sku: 'SKU-A', name: 'A' }], ['SKU-B', { sku: 'SKU-B', name: 'B' }]]);
for (const [k, v] of [...items]) items.set(k.toUpperCase(), v);
const H = e.TEMPLATE_HEADERS;

test('groups rows by Order No and keeps sheet row numbers', () => {
  const { orders, fileErrors } = e.parseSheetRows([H, ['O1', 'Shopee', 'N', '91234567', 'Addr', '123456', '', 'SKU-A', 1], ['O1', '', '', '', '', '', '', 'SKU-B', 2], ['O2', '', 'M', '91234567', 'Addr', '123456', '', 'SKU-A', 3]]);
  assert.deepStrictEqual(fileErrors, []);
  assert.strictEqual(orders.length, 2);
  assert.deepStrictEqual(orders[0].rows, [2, 3]);
  assert.strictEqual(orders[0].channel, 'Shopee');
  assert.strictEqual(orders[0].lines.length, 2);
});
test('missing columns and empty file are file-level errors', () => {
  assert.match(e.parseSheetRows([['Order No', 'Name']]).fileErrors[0], /SKU, Qty/);
  assert.match(e.parseSheetRows([]).fileErrors[0], /empty/);
});
test('same Order No after another order = duplicate in file; conflicting recipient flagged', () => {
  const { orders } = e.parseSheetRows([H, ['O1', '', 'N', '91234567', 'A', '123456', '', 'SKU-A', 1], ['O2', '', 'N', '91234567', 'A', '123456', '', 'SKU-A', 1], ['O1', '', 'X', '91234567', 'A', '123456', '', 'SKU-A', 1]]);
  const v = e.validateOrders(orders, { items });
  assert.match(v[0].errors.join(' '), /duplicate order no in this file/);
  assert.match(v[0].errors.join(' '), /differs/);
  assert.ok(v[1].ok);
});
test('validation: required fields, postal, phone, unknown SKU, bad qty, existing dup, SKU case + merge', () => {
  const [a, b, c] = e.validateOrders([
    { order_number: 'X1', recipient_name: 'N', phone: '91234567', address: 'A', postal_code: '123456', lines: [{ sku: 'sku-a', qty: '2' }, { sku: 'SKU-A', qty: 3 }] },
    { order_number: 'X2', recipient_name: '', phone: 'abc', address: '', postal_code: '12', lines: [{ sku: 'NOPE', qty: 1 }, { sku: 'SKU-B', qty: 1.5 }] },
    { order_number: 'TAKEN', recipient_name: 'N', phone: '91234567', address: 'A', postal_code: '123456', lines: [] },
  ], { items, taken: n => n === 'TAKEN' });
  assert.ok(a.ok); assert.deepStrictEqual(a.lines.map(l => [l.sku, l.qty]), [['SKU-A', 5]]);
  const be = b.errors.join(' ');
  for (const re of [/Recipient name is required/, /Phone must be/, /Address is required/, /Postal code must be 6/, /Unknown SKU NOPE/, /whole number/]) assert.match(be, re);
  assert.match(c.errors.join(' '), /already exists/); assert.match(c.errors.join(' '), /at least one item/);
});
test('form mode allows blank order no; file mode requires it; bad characters refused', () => {
  const base = { recipient_name: 'N', phone: '91234567', address: 'A', postal_code: '123456', lines: [{ sku: 'SKU-A', qty: 1 }] };
  assert.ok(e.validateOrders([{ ...base, order_number: '' }], { items, mode: 'form' })[0].ok);
  assert.match(e.validateOrders([{ ...base, order_number: '' }], { items })[0].errors[0], /Order No is required/);
  assert.match(e.validateOrders([{ ...base, order_number: 'a b<' }], { items })[0].errors[0], /letters, digits/);
});
test('toIntakeOrder maps to the intake record shape; postal appended to address', () => {
  const [o] = e.validateOrders([{ order_number: 'X1', channel: 'Lazada', recipient_name: 'N', phone: '91234567', address: '1 Rd', postal_code: '123456', lines: [{ sku: 'SKU-A', qty: 1 }] }], { items });
  assert.deepStrictEqual(e.toIntakeOrder(o), { order_number: 'X1', customer_name: 'N', tel: '91234567', delivery_address: '1 Rd S(123456)', platform: 'Lazada', lines: [{ sku: 'SKU-A', qty: 1, description: 'A' }] });
  assert.strictEqual(e.intakeExtras(o).order_source, 'portal');
});
test('failed rows CSV: template layout + Error, original lines kept, formula injection neutralised', () => {
  const [o] = e.validateOrders([{ order_number: '=HYPERLINK("x")', recipient_name: 'N', phone: '91234567', address: 'A', postal_code: '123456', lines: [{ sku: 'NOPE', qty: 1 }] }], { items });
  const csv = e.failedRowsCsv([o]);
  assert.ok(csv.startsWith('\uFEFFOrder No,Channel'));
  assert.ok(csv.includes(',Error'));
  assert.ok(csv.includes('NOPE'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
});
test('template: xlsx has Orders + Instructions sheets; csv round-trips through the parser', () => {
  const wb = XLSX.read(e.templateBuffer('xlsx'));
  assert.deepStrictEqual(wb.SheetNames, ['Orders', 'Instructions']);
  const parsed = e.parseSheetRows(e.readSheet(e.templateBuffer('csv'), 't.csv'));
  assert.deepStrictEqual(parsed.orders.map(o => o.order_number), ['SO-1001', 'SO-1002']);
  assert.strictEqual(parsed.orders[0].lines.length, 2);
});
