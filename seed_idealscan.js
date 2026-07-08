'use strict';
const { getTenantDb } = require('./lib/db/tenant');
const db = getTenantDb('default');

// ── Clear existing orders ─────────────────────────────────────────────────────
db.prepare('DELETE FROM orders').run();

// ── Data ──────────────────────────────────────────────────────────────────────
const CLIENTS = [
  { id: 'betime-marketing', name: 'Betime Marketing' },
  { id: 'smilefam',         name: 'SmileFam' },
  { id: 'athena-scents',    name: 'Athena Scents' },
  { id: 'simplytoy',        name: 'SimplyToy' },
  { id: 'lz8',              name: 'LZ8' },
  { id: 'almighty',         name: 'Almighty' },
  { id: 'chalgo',           name: 'Chalgo' },
];

const CHANNELS = ['shopee', 'tiktok', 'lazada', 'shopify'];

const PRODUCTS = [
  { sku: 'SKU-001', name: 'Memory Foam Pillow Pro',    price: 45.00 },
  { sku: 'SKU-002', name: 'LED Desk Lamp',             price: 49.00 },
  { sku: 'SKU-003', name: 'Electric Toothbrush Pro',   price: 59.90 },
  { sku: 'SKU-004', name: 'Whey Protein 1kg',          price: 79.00 },
  { sku: 'SKU-005', name: 'RC Monster Truck',          price: 69.00 },
  { sku: 'SKU-006', name: 'Oud Perfume 50ml',          price: 88.00 },
  { sku: 'SKU-007', name: 'Casual Watch',              price: 89.00 },
  { sku: 'SKU-008', name: 'Bomber Jacket',             price: 89.00 },
  { sku: 'SKU-009', name: 'Plush Bear 40cm',           price: 55.00 },
  { sku: 'SKU-010', name: 'Rose Garden EDP',           price: 65.00 },
  { sku: 'SKU-011', name: 'BCAA 300g',                 price: 49.00 },
  { sku: 'SKU-012', name: 'Leather Wallet',            price: 45.00 },
  { sku: 'SKU-013', name: 'Premium Polo Tee',          price: 49.00 },
  { sku: 'SKU-014', name: 'Whitening Kit',             price: 49.00 },
];

const RECIPIENTS = [
  'Hui Ling Lim', 'Ahmad Fadzillah', 'Siti Nurhaliza', 'Kavitha Pillai',
  'Rajesh Kumar',  'Nurul Ain',       'Deepak Sharma',  'Wei Ling Tan',
  'James Ong',     'Priya Nair',      'Bryan Chua',     'Fatimah Binte',
];

const rnd    = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick   = arr => arr[rnd(0, arr.length - 1)];

const insert = db.prepare(`
  INSERT INTO orders
    (id, client_id, client_name, channel, order_date, status, currency, notes,
     items, shipping, subtotal, shipping_cost, tax, total, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Total = 118: 117 pending + 1 processing
// Order IDs: ORD-SG-1 through ORD-SG-118
const TOTAL = 118;
const now   = new Date('2026-07-08T10:00:00.000Z');

for (let i = 1; i <= TOTAL; i++) {
  const orderId  = `ORD-SG-${i}`;
  const client   = CLIENTS[(i - 1) % CLIENTS.length];
  const channel  = CHANNELS[(i - 1) % CHANNELS.length];
  const status   = i === TOTAL ? 'processing' : 'pending';

  // Spread over last 7 days, more orders today
  const daysAgo  = i <= 30 ? 0 : i <= 60 ? 1 : i <= 80 ? 2 : i <= 95 ? 3 : i <= 105 ? 4 : i <= 112 ? 5 : 6;
  const hourOff  = rnd(0, 23);
  const orderDate = new Date(now - daysAgo * 86400000 - hourOff * 3600000).toISOString();

  // Pick 1-2 products
  const numItems = rnd(1, 2);
  const items = [];
  for (let j = 0; j < numItems; j++) {
    const p = pick(PRODUCTS);
    const qty = rnd(1, 3);
    items.push({ sku: p.sku, name: p.name, qty, unitPrice: p.price });
  }
  const subtotal = Math.round(items.reduce((s, it) => s + it.qty * it.unitPrice, 0) * 100) / 100;
  const tax      = Math.round(subtotal * 0.09 * 100) / 100;
  const total    = Math.round((subtotal + tax) * 100) / 100;
  const recipient = pick(RECIPIENTS);

  insert.run(
    orderId,
    client.id,
    client.name,
    channel,
    orderDate,
    status,
    'SGD',
    '',
    JSON.stringify(items),
    JSON.stringify({
      recipient,
      addressLine1: '',
      addressLine2: '',
      city: 'Singapore',
      state: '',
      zip: '',
      country: 'SG',
    }),
    subtotal, 0, tax, total,
    JSON.stringify({ type: channel, ingestedAt: now.toISOString() })
  );
}

const stats = db.prepare("SELECT status, COUNT(*) as n FROM orders GROUP BY status").all();
const total_count = db.prepare("SELECT COUNT(*) as n FROM orders").get().n;
console.log(`Seeded ${total_count} orders`);
console.log('Status breakdown:', stats);
console.log('ID sample:', db.prepare("SELECT id, client_name, channel, status FROM orders ORDER BY ROWID DESC LIMIT 5").all());
