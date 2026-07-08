'use strict';
const Database = require('better-sqlite3');
const path     = require('path');
const db       = new Database(path.join(__dirname, 'data/tenants/default.db'));

// ── Clear existing orders ─────────────────────────────────────────────────────
db.prepare('DELETE FROM orders').run();
console.log('Cleared existing orders');

// ── Helpers ───────────────────────────────────────────────────────────────────
const pad  = (n, len) => String(n).padStart(len, '0');
const rnd  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const CLIENTS = [
  { id: 'betime-marketing', name: 'Betime Marketing' },
  { id: 'smilefam',         name: 'SmileFam' },
  { id: 'athena-scents',    name: 'Athena Scents' },
  { id: 'simplytoy',        name: 'SimplyToy' },
  { id: 'lz8',              name: 'LZ8' },
  { id: 'almighty',         name: 'Almighty' },
  { id: 'chalgo',           name: 'Chalgo' },
];

const PRODUCTS = [
  { sku: 'SKU-001', name: 'Premium Pillow', price: 45 },
  { sku: 'SKU-002', name: 'LED Desk Lamp',  price: 49 },
  { sku: 'SKU-003', name: 'Electric Toothbrush Pro', price: 59.90 },
  { sku: 'SKU-004', name: 'Whey Protein 1kg', price: 79 },
  { sku: 'SKU-005', name: 'RC Monster Truck', price: 69 },
  { sku: 'SKU-006', name: 'Oud Perfume 50ml', price: 88 },
  { sku: 'SKU-007', name: 'Casual Watch',    price: 89 },
  { sku: 'SKU-008', name: 'Bomber Jacket',   price: 89 },
];

const NAMES = ['B***u','G***h','P**m','R***g','C***y','N***l','J***8','S***a','K***i','T***n',
               'W***g','M***h','F***a','D***p','Z***i','A***n','H***g','E***r','V***k','L***u'];

const insert = db.prepare(`
  INSERT INTO orders
    (id, client_id, client_name, channel, order_date, status, currency, notes,
     items, shipping, subtotal, shipping_cost, tax, total, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const now = new Date();

let count = 0;

const insertOrder = (i, status) => {
  const shopeeOrderNo = `260707${pad(rnd(1000000, 9999999), 7)}${String.fromCharCode(65 + rnd(0,25))}${String.fromCharCode(65 + rnd(0,25))}${String.fromCharCode(48 + rnd(0,9))}`;
  const waybill       = `SPXSG0${pad(rnd(100000000, 999999999), 9)}`;
  const client        = CLIENTS[i % CLIENTS.length];
  const product       = PRODUCTS[rnd(0, PRODUCTS.length - 1)];
  const qty           = rnd(1, 4);
  const subtotal      = Math.round(product.price * qty * 100) / 100;
  const total         = subtotal;
  const customer      = NAMES[i % NAMES.length];

  // Spread orders over today and the past 2 days so dashboard shows today's data
  const offsetHours   = rnd(0, 48);
  const orderDate     = new Date(now - offsetHours * 3600000).toISOString();

  insert.run(
    `ISCAN-${shopeeOrderNo}`,
    client.id,
    client.name,
    'shopee',
    orderDate,
    status,
    'SGD',
    `Waybill: ${waybill}`,
    JSON.stringify([{ sku: product.sku, name: product.name, qty, unitPrice: product.price }]),
    JSON.stringify({ recipient: customer, addressLine1: '', addressLine2: '', city: 'Singapore', state: '', zip: '', country: 'SG' }),
    subtotal, 0, 0, total,
    JSON.stringify({ type: 'shopee', waybill, carrier: 'SPX', externalId: shopeeOrderNo, ingestedAt: now.toISOString() })
  );
  count++;
};

// 117 pending, 1 processing (matches IDEALSCAN: 117 PENDING, 1 IN PROGRESS)
for (let i = 0; i < 117; i++) insertOrder(i, 'pending');
insertOrder(117, 'processing');

console.log(`Seeded ${count} orders (117 pending + 1 processing)`);
const stats = db.prepare("SELECT status, COUNT(*) as n FROM orders GROUP BY status").all();
console.log('Status breakdown:', stats);
db.close();
