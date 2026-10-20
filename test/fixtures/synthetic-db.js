'use strict';
// Synthetic db.json shaped like prod (batches with orders + orderStates, a long
// auditLog, a few other keys). targetMB is approximate.
function makeSyntheticDb(targetMB, seed = 1) {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const db = { batches: [], auditLog: [], inbound: [], drivers: [], transport: [], settings: { a: 1 } };
  const target = targetMB * 1048576;
  let bytes = 0, b = 0, o = 0;
  const day0 = Date.parse('2026-09-21T00:00:00Z');
  while (bytes < target * 0.72) {
    const orders = [], states = {};
    const n = 200 + Math.floor(rnd() * 400);
    for (let i = 0; i < n; i++, o++) {
      const on = 'GI-' + String(900000 + o);
      orders.push({ order_number: on, customer_name: 'Customer ' + o, delivery_address: (o % 97) + ' Jurong West Street ' + (o % 13) + ', Singapore ' + (600000 + o % 9999), tel: '9' + String(1000000 + o).slice(-7), carrier: 'SPX', waybill_number: 'SPXSG' + (100000000 + o), platform: 'Shopee', total_qty: 2, lines: [{ sku: 'SKU' + (o % 500), description: 'Item ' + (o % 500) + ' description text', qty: 1, location: 'A-' + (o % 40) }, { sku: 'SKU' + ((o + 7) % 500), description: 'Item ' + ((o + 7) % 500), qty: 1 }], zort_label: { status: 'ok', at: new Date(day0).toISOString() } });
      states[on] = { status: rnd() < 0.8 ? 'completed' : 'pending', scanned: { ['SKU' + (o % 500)]: 1 }, scanLog: [{ sku: 'SKU' + (o % 500), at: new Date(day0 + o * 1000).toISOString() }], operator: 'u' + (o % 7) };
    }
    const batch = { id: 'b' + b, filename: 'batch-' + b + '.xlsx', client_name: 'CLIENT' + (b % 9), uploaded_at: new Date(day0 + b * 3600000).toISOString(), orders, orderStates: states };
    db.batches.push(batch);
    bytes += JSON.stringify(batch).length;
    b++;
  }
  let a = 0;
  while (bytes < target) {
    const at = new Date(day0 + a * 6000).toISOString();
    const e = a % 3 === 0
      ? { type: 'order_completed', at, order: 'GI-' + (900000 + a), client: 'CLIENT' + (a % 9), pieces: 2, operator: 'u' + (a % 7), startTime: at, endTime: new Date(day0 + a * 6000 + 90000).toISOString() }
      : a % 50 === 1 ? { type: 'upload', at, orders: 300, lines: 600, client: 'CLIENT' + (a % 9) }
      : { type: 'scan', at, order: 'GI-' + (900000 + a), sku: 'SKU' + (a % 500), operator: 'u' + (a % 7) };
    db.auditLog.push(e);
    bytes += JSON.stringify(e).length + 1;
    a++;
  }
  for (let i = 0; i < 3000; i++) db.inbound.push({ id: 'IB-' + i, lines: [{ sku: 'SKU' + (i % 500), qty: i % 9 }] });
  return db;
}
module.exports = { makeSyntheticDb };
