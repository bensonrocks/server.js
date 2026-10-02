'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const dbPath = path.join(os.tmpdir(), `nt-portal-queue-${process.pid}-${Date.now()}.db`);
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(dbPath + ext); } catch (_) { /* fresh file */ }
}
process.env.NT_DB_PATH = dbPath;
delete process.env.DATABASE_URL;

const store = require('../lib/nimbustrade-portal/store');
const tpl = require('../lib/nimbustrade-portal/order-template');

function dayBefore(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

describe('NimbusTrade upload queue', () => {
  test('BWL template round-trips into two lines of one order number', () => {
    const parsed = tpl.parseOrdersWorkbook(tpl.buildBwlTemplate());
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].orderRef, 'BWL-DEMO-1001');
    assert.equal(parsed.rows[0].customerName, 'Aisha Rahman');
    assert.equal(parsed.rows[0].country, 'SG');
    assert.equal(parsed.rows[0].sku, 'RAD-SER-30');
    assert.equal(parsed.rows[0].qty, 2);
    assert.equal(parsed.rows[0].detail.email, 'aisha.demo@example.com');
    assert.equal(parsed.rows[0].detail.address1, '12 Harbour Walk');

    const grid = [
      ['Order Number', 'Recipient Name', 'Country', 'Product Sku', 'Product Quantity'],
      ['BWL-DEMO-2002', 'Noah Chen', 'Singapore', 'RAD-SER-30', 1],
      ['BWL-DEMO-2002', 'Noah Chen', 'Singapore', 'NGT-CRM-50', 3],
    ];
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), 'Orders');
    const multi = tpl.parseOrdersWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    assert.equal(multi.errors.length, 0);
    assert.equal(multi.rows.length, 2);
    assert.equal(multi.rows[0].orderRef, 'BWL-DEMO-2002');
    assert.equal(multi.rows[1].orderRef, 'BWL-DEMO-2002');
    assert.equal(multi.rows[1].sku, 'NGT-CRM-50');
    assert.equal(multi.rows[1].qty, 3);
  });

  test('approve writes live rows; a bad row rolls the whole upload back', () => {
    const client = store.createClient('Harbour Demo');
    const other = store.createClient('Other Co');

    const queued = store.queueUpload(client.id, 'orders', 'bwl-demo.xlsx', [
      {
        customerName: 'Aisha Rahman', country: 'SG', sku: 'RAD-SER-30', qty: 2,
        orderRef: 'BWL-DEMO-1001',
        detail: { address1: '12 Harbour Walk', city: 'Singapore', postal: '018956', email: 'aisha.demo@example.com', phone: '+65 6000 0000' },
      },
    ]);
    const pending = store.listPendingUploadsForAdmin();
    const preview = pending.find((u) => u.id === queued.id);
    assert.ok(preview);
    assert.equal(preview.preview[0].orderRef, 'BWL-DEMO-1001');
    assert.equal(preview.preview[0].customerName, 'Aisha Rahman');
    assert.equal(JSON.stringify(preview.preview[0]).includes('018956'), false);
    assert.equal(JSON.stringify(preview.preview[0]).includes('aisha.demo'), false);
    assert.equal(JSON.stringify(preview.preview[0]).includes('Harbour'), false);
    assert.equal(JSON.stringify(preview.preview[0]).includes('6000'), false);

    const applied = store.decideUpload(queued.id, { action: 'approve', decidedBy: 'staff' });
    assert.equal(applied.status, 'approved');
    assert.equal(applied.applied, 1);
    const mine = store.listOrders(client.id, { search: 'BWL-DEMO-1001' });
    assert.equal(mine.total, 1);
    assert.equal(mine.rows[0].status, 'processing');
    assert.equal(mine.rows[0].detail.email, 'aisha.demo@example.com');
    assert.equal(store.listOrders(other.id).total, 0);

    assert.throws(
      () => store.decideUpload(queued.id, { action: 'approve' }),
      (e) => e.status === 409 && /already been decided/.test(e.message)
    );

    const bad = store.queueUpload(client.id, 'orders', 'bad.xlsx', [
      { customerName: 'A', country: 'SG', sku: 'RAD-SER-30', qty: 1, orderRef: 'OK-1' },
      { customerName: 'B', country: 'ZZ', sku: 'RAD-SER-30', qty: 1, orderRef: 'BAD-1' },
    ]);
    assert.throws(
      () => store.decideUpload(bad.id, { action: 'approve' }),
      (e) => e.status === 400 && /Country is not one we ship to/.test(e.message)
    );
    assert.equal(store.listOrders(client.id, { search: 'OK-1' }).total, 0);
    assert.equal(store.listOrders(client.id, { search: 'BAD-1' }).total, 0);
    assert.equal(store.listUploadsForClient(client.id).find((u) => u.id === bad.id).status, 'pending');

    const rejected = store.queueUpload(client.id, 'orders', 'skip.xlsx', [
      { customerName: 'C', country: 'SG', sku: 'RAD-SER-30', qty: 1, orderRef: 'SKIP-1' },
    ]);
    const rej = store.decideUpload(rejected.id, { action: 'reject', note: 'Not this week', decidedBy: 'staff' });
    assert.equal(rej.status, 'rejected');
    assert.equal(store.listOrders(client.id, { search: 'SKIP-1' }).total, 0);
  });

  test('staff advances one step, then Shipped refuses another move', () => {
    const client = store.createClient('Advance Co');
    const order = store.createOrder(client.id, {
      customerName: 'Lee Tan', country: 'SG', sku: 'RAD-SER-30', qty: 1, orderRef: 'ADV-1',
    });
    assert.equal(order.next_status, 'ready_to_ship');
    const ready = store.advanceOrderForAdmin(order.id);
    assert.equal(ready.status, 'ready_to_ship');
    const shipped = store.advanceOrderForAdmin(order.id);
    assert.equal(shipped.status, 'shipped');
    assert.throws(
      () => store.advanceOrderForAdmin(order.id),
      (e) => e.status === 400 && e.message === 'This order is already Shipped'
    );
    assert.throws(
      () => store.advanceOrderForAdmin('ord_missing'),
      (e) => e.status === 404 && e.message === 'Order not found'
    );
  });

  test('today counts only orders dated today', () => {
    const client = store.createClient('Today Co');
    store.createOrder(client.id, {
      customerName: 'Today Buyer', country: 'MY', sku: 'COL-ESS-30', qty: 1, orderRef: 'TODAY-1',
    });
    const snap = store.todaySnapshot(client.id);
    store.createOrder(client.id, {
      customerName: 'Yesterday Buyer', country: 'SG', sku: 'RAD-SER-30', qty: 1,
      orderRef: 'YDAY-1', orderDate: dayBefore(snap.day),
    });
    const after = store.todaySnapshot(client.id);
    assert.equal(after.counts.total, 1);
    assert.equal(after.counts.processing, 1);
    assert.equal(after.orders.length, 1);
    assert.equal(after.orders[0].order_ref, 'TODAY-1');
    assert.equal(store.listOrders(client.id).total, 2);
  });

  test('item master upserts on client and sku, remarks optional', () => {
    const client = store.createClient('Catalogue Co');
    const other = store.createClient('Catalogue Other');
    const queued = store.queueUpload(client.id, 'items', 'items.xlsx', [
      { sku: 'RAD-SER-30', description: 'Radiance Serum 30ml', batch: 'BATCH-DEMO-01', serial: 'SN-DEMO-0001' },
    ]);
    const preview = store.listPendingUploadsForAdmin().find((u) => u.id === queued.id);
    assert.deepEqual(preview.preview[0], { sku: 'RAD-SER-30', description: 'Radiance Serum 30ml' });
    store.decideUpload(queued.id, { action: 'approve' });
    store.applyItemMaster(client.id, [
      { sku: 'RAD-SER-30', description: 'Radiance Serum renamed', batch: 'BATCH-2', serial: 'SN-2', remark1: 'cool chain', remark2: '' },
    ]);
    const rows = store.listItemMaster(client.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].description, 'Radiance Serum renamed');
    assert.equal(rows[0].batch_details, 'BATCH-2');
    assert.equal(rows[0].remark_1, 'cool chain');
    assert.equal(rows[0].remark_2, '');
    assert.equal(store.listItemMaster(other.id).length, 0);
    const sheet = tpl.parseItemMasterWorkbook(tpl.buildItemMasterTemplate());
    assert.equal(sheet.errors.length, 0);
    assert.equal(sheet.rows[0].sku, 'RAD-SER-30');
    assert.equal(sheet.rows[0].remark1, '');
  });

  test('inbound approval creates a location and stays on that company', () => {
    const client = store.createClient('Inbound Co');
    const parsed = tpl.parseInboundWorkbook(tpl.buildInboundTemplate());
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.rows[0].country, 'SG');
    const queued = store.queueUpload(client.id, 'inbound', 'inbound.xlsx', parsed.rows);
    const done = store.decideUpload(queued.id, { action: 'approve' });
    assert.equal(done.applied, 1);
    const list = store.listInboundForClient(client.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].reference, 'INB-DEMO-1');
    assert.equal(list[0].contents, 'Radiance Serum 30ml');
    assert.equal(list[0].country, 'SG');
    assert.equal(store.listInboundForClient(store.createClient('Empty inbound').id).length, 0);
  });

  test('rows that share an order number become one order with product lines', () => {
    const client = store.createClient('Combine Co');
    const flat = [
      { rowNumber: 1, customerName: 'Nina Cole', country: 'SG', sku: 'SKU-A', productName: 'Serum A', qty: 1, orderRef: 'BWL-COMBO-1', detail: { address1: '1 Combine Walk', price: 12 } },
      { rowNumber: 2, customerName: 'Nina Cole', country: 'SG', sku: 'SKU-A', productName: 'Serum A later', qty: 2, orderRef: 'BWL-COMBO-1', detail: { price: 99 } },
      { rowNumber: 3, customerName: 'Nina Cole', country: 'SG', sku: 'SKU-B', productName: 'Cream B', qty: 3, orderRef: 'BWL-COMBO-1' },
      { rowNumber: 4, customerName: 'Omar Shah', country: 'MY', sku: 'SKU-C', productName: 'Toner C', qty: 1, orderRef: 'BWL-COMBO-2' },
    ];
    const once = store.combineOrderRows(flat);
    assert.equal(once.errors.length, 0);
    assert.equal(once.rows.length, 2);
    assert.equal(once.rows[0].detail.lines.length, 2);
    assert.equal(once.rows[0].detail.lines[0].sku, 'SKU-A');
    assert.equal(once.rows[0].detail.lines[0].qty, 3);
    assert.equal(once.rows[0].detail.lines[0].productName, 'Serum A');
    assert.equal(once.rows[0].detail.lines[0].price, 12);
    assert.equal(once.rows[0].qty, 6);
    const twice = store.combineOrderRows(once.rows);
    assert.equal(twice.rows.length, 2);
    assert.equal(twice.rows[0].detail.lines.length, 2);
    assert.equal(twice.rows[0].qty, 6);

    const before = store.pendingOrderSummary(client.id);
    assert.equal(before.orders, 0);
    const queued = store.queueUpload(client.id, 'orders', 'delivery-adv.xlsx', flat);
    const waiting = store.pendingOrderSummary(client.id);
    assert.equal(waiting.orders, 2);
    assert.equal(waiting.lines, 3);
    assert.deepEqual(waiting.files, ['delivery-adv.xlsx']);
    const preview = store.listPendingUploadsForAdmin().find((u) => u.id === queued.id);
    assert.equal(preview.row_count, 2);
    assert.equal(preview.line_count, 3);
    const shown = preview.preview.find((r) => r.orderRef === 'BWL-COMBO-1');
    assert.equal(shown.lines.length, 2);
    assert.equal(shown.lines[1].sku, 'SKU-B');
    assert.equal(JSON.stringify(shown).includes('Combine Walk'), false);
    assert.equal(JSON.stringify(shown).includes('price'), false);

    const applied = store.decideUpload(queued.id, { action: 'approve', decidedBy: 'staff' });
    assert.equal(applied.applied, 2);
    assert.equal(store.pendingOrderSummary(client.id).orders, 0);
    const found = store.listOrders(client.id, { search: 'SKU-B' });
    assert.equal(found.total, 1);
    assert.equal(found.rows[0].order_ref, 'BWL-COMBO-1');
    assert.equal(found.rows[0].qty, 6);
    assert.equal(found.rows[0].detail.lines.length, 2);
    assert.equal(found.rows[0].detail.lines[0].qty, 3);
    const today = store.todaySnapshot(client.id);
    assert.equal(today.counts.processing, 2);
    assert.equal(today.counts.total, 2);
    assert.equal(store.listOrders(client.id, { search: 'BWL-COMBO-1' }).total, 1);
    const adminHit = store.listAllOrders({ clientId: client.id, search: 'SKU-B' });
    assert.equal(adminHit.total, 1);

    const clash = store.queueUpload(client.id, 'orders', 'clash.xlsx', [
      { rowNumber: 4, customerName: 'Ann Lee', country: 'SG', sku: 'SKU-A', qty: 1, orderRef: 'BWL-CLASH' },
      { rowNumber: 5, customerName: 'Bob Lee', country: 'MY', sku: 'SKU-A', qty: 1, orderRef: 'BWL-CLASH' },
    ]);
    assert.throws(
      () => store.decideUpload(clash.id, { action: 'approve' }),
      (e) => e.status === 400 && /Row 5:/.test(e.message) && /BWL-CLASH/.test(e.message)
    );
    assert.equal(store.listOrders(client.id, { search: 'BWL-CLASH' }).total, 0);
    assert.equal(store.listUploadsForClient(client.id).find((u) => u.id === clash.id).status, 'pending');

    const generic = store.combineOrderRows([
      { rowNumber: 1, customerName: 'G1', country: 'SG', sku: 'SKU-G1', qty: 1 },
      { rowNumber: 2, customerName: 'G2', country: 'SG', sku: 'SKU-G2', qty: 1 },
    ]);
    assert.equal(generic.rows.length, 2);
    assert.equal(generic.errors.length, 0);
  });
});
