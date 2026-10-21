'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Synthetic demo dataset for the IdealOne DEMO environment.
//  100% fake: invented client names, example.invalid emails, fake phones.
//  Contains NO real client, customer or order data.
//
//  Usage:
//    node scripts/seed-demo.js [--force]      (uses DATA_DIR / RAILWAY_VOLUME_MOUNT_PATH)
//  server.js also calls seedIfEmpty() at boot when DEMO_MODE=true, so a fresh
//  demo volume is seeded exactly once. Refuses to run unless DEMO_MODE=true.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TENANT = 'default';
const CLIENTS = [
  { client: 'ACME GADGETS', type: 'E-commerce', commodity: 'Electronics accessories' },
  { client: 'BLUEBIRD BEAUTY', type: 'E-commerce', commodity: 'Cosmetics' },
  { client: 'NORTHWIND PANTRY', type: 'B2B', commodity: 'Dry foods' },
  { client: 'ZEPHYR SPORTS', type: 'E-commerce', commodity: 'Sporting goods' },
];
const PLATFORMS = ['Shopee', 'Lazada', 'TikTok Shop', 'Website'];
const CARRIERS = ['DEMO-EXPRESS', 'DEMO-COURIER'];
const STATUSES = ['pending', 'pending', 'in_progress', 'completed', 'completed', 'on_hold'];
const STREETS = ['Demo Avenue', 'Sample Road', 'Example Street', 'Placeholder Lane', 'Mock Crescent'];
const FIRST = ['Alex', 'Sam', 'Jordan', 'Casey', 'Riley', 'Morgan', 'Taylor', 'Jamie', 'Quinn', 'Avery'];
const LAST = ['Tan', 'Lim', 'Ng', 'Lee', 'Wong', 'Ong', 'Goh', 'Chua', 'Koh', 'Teo'];

function hashPass(p, salt) { return crypto.scryptSync(p, salt, 64).toString('hex'); }
function rng(seed) { let x = seed; return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

function skusFor(ci) {
  const prefix = ['ACM', 'BLB', 'NWP', 'ZPH'][ci];
  return Array.from({ length: 8 }, (_, i) => ({
    sku: `${prefix}-${String(100 + i)}`,
    name: `${CLIENTS[ci].client.split(' ')[0]} Demo Item ${i + 1}`,
    barcode: `0000${ci}${String(10000 + i)}`,
  }));
}

function buildDb(now = Date.now()) {
  const r = rng(42);
  const iso = ms => new Date(ms).toISOString();
  const day = 86400000;
  const db = { batches: [], auditLog: [], inbound: [], drivers: [], transport: [], clientProfiles: [], demo: { seededAt: iso(now), synthetic: true } };

  CLIENTS.forEach((c, ci) => {
    const profile = { ...c, instructions: [{ id: `ins-${ci}`, text: 'Demo instruction: pack fragile items with bubble wrap.', status: 'active', createdAt: iso(now - 30 * day) }],
      status: 'active', itemCount: 8, createdAt: iso(now - 60 * day), updatedAt: iso(now - day), barcodeSearch: true };
    if (ci === 0) {
      const salt = crypto.randomBytes(16).toString('hex');
      profile.portal = { enabled: true, email: 'portal@example.invalid' };
      profile.portalUsers = [{ id: 'demo-portal', name: 'Demo Portal User', email: 'portal@example.invalid', salt,
        passwordHash: hashPass(crypto.randomBytes(12).toString('hex'), salt), access: 'view', enabled: true, created_at: iso(now - 20 * day) }];
    }
    db.clientProfiles.push(profile);
  });

  let o = 0;
  for (let b = 0; b < 8; b++) {
    const ci = b % CLIENTS.length, skus = skusFor(ci), orders = [], states = {};
    const uploaded = now - (8 - b) * day;
    const n = 6 + Math.floor(r() * 8);
    for (let i = 0; i < n; i++, o++) {
      const on = `DEMO-${String(10000 + o)}`;
      const s1 = skus[o % skus.length], s2 = skus[(o + 3) % skus.length];
      orders.push({ order_number: on, customer_name: `${FIRST[o % 10]} ${LAST[(o * 3) % 10]} (demo)`,
        delivery_address: `${1 + (o % 99)} ${STREETS[o % STREETS.length]}, Demo City 0${String(10000 + o).slice(-5)}`,
        tel: `0000${String(1000 + o)}`, carrier: CARRIERS[o % 2], waybill_number: `DEMOWB${100000 + o}`,
        platform: PLATFORMS[o % PLATFORMS.length], total_qty: 3,
        lines: [{ sku: s1.sku, description: s1.name, qty: 2, location: `A-0${o % 9}` }, { sku: s2.sku, description: s2.name, qty: 1, location: `B-0${o % 9}` }] });
      const st = b < 4 ? 'completed' : STATUSES[o % STATUSES.length];
      states[on] = { status: st, scanned: st === 'completed' ? { [s1.sku]: 2, [s2.sku]: 1 } : {}, operator: 'kenkuntest' };
      if (st === 'completed') db.auditLog.push({ type: 'order_completed', at: iso(uploaded + 3600000 + i * 60000), order: on, client: CLIENTS[ci].client, pieces: 3, operator: 'kenkuntest' });
    }
    db.batches.push({ id: crypto.randomUUID(), filename: `demo-batch-${b + 1}.xlsx`, client_name: CLIENTS[ci].client, uploaded_at: iso(uploaded), orders, orderStates: states });
    db.auditLog.push({ type: 'upload', at: iso(uploaded), orders: n, lines: n * 2, client: CLIENTS[ci].client });
  }

  for (let i = 0; i < 5; i++) {
    const ci = i % CLIENTS.length, s = skusFor(ci)[i];
    db.inbound.push({ id: `IB-DEMO-${i + 1}`, type: 'inbound', reference: `ASN-DEMO-${1000 + i}`, client_name: CLIENTS[ci].client,
      status: i < 2 ? 'received' : 'pending', created_at: iso(now - (5 - i) * day), lines: [{ sku: s.sku, description: s.name, qty: 50 + i * 10 }] });
  }

  const drv = [['DRV-DEMO-1', 'Demo Driver One', 'Van', 'DEMO 1001'], ['DRV-DEMO-2', 'Demo Driver Two', 'Lorry', 'DEMO 2002']];
  for (const [id, name, vehicle, plate] of drv) {
    const pinSalt = crypto.randomBytes(16).toString('hex');
    db.drivers.push({ id, name, phone: '00000000', vehicle, plate, capacity: 40, capacityM3: 12, status: 'active',
      pinSalt, pinHash: hashPass(crypto.randomBytes(12).toString('hex'), pinSalt) });
  }

  const tStatuses = ['pending', 'pending', 'assigned', 'in_transit', 'delivered', 'pending'];
  for (let i = 0; i < 10; i++) {
    const ci = i % CLIENTS.length, s = skusFor(ci)[i % 8], st = tStatuses[i % tStatuses.length];
    const driver = st === 'pending' ? null : drv[i % 2];
    const poExp = now + (i - 3) * day; // some expired, some soon, some later
    db.transport.push({ id: `TRN-DEMO-${1000 + i}`, referenceId: `PO-DEMO-${5000 + i}`, clientName: CLIENTS[ci].client, status: st,
      poExpiry: new Date(poExp).toISOString().slice(0, 10), poExpiryMatch: '', createdAt: iso(now - (10 - i) * day),
      items: [{ sku: s.sku, description: s.name, qty: 5 + i }],
      shipping: { name: `${FIRST[i]} ${LAST[i]} (demo)`, address: `${10 + i} ${STREETS[i % 5]}`, city: 'Demo City', zip: `0${String(10000 + i * 7)}`.slice(-6), phone: '00000000' },
      assignedDriver: driver ? driver[0] : '', assignedDriverName: driver ? driver[1] : '', packages: 1 + (i % 3),
      plannedAt: iso(now + (i % 3) * day), deliveredAt: st === 'delivered' ? iso(now - day) : null, source: { demo: true } });
  }
  return db;
}

function seedInventory(inventory) {
  if (!inventory || !inventory.available || !inventory.available()) return 0;
  let n = 0;
  CLIENTS.forEach((c, ci) => skusFor(ci).forEach((s, i) => {
    inventory.upsert({ sku: s.sku, name: s.name, clientId: c.client, description: 'Synthetic demo item', category: c.commodity,
      stock_qty: 20 + i * 15, reserved_qty: i % 3, reorder_point: 25, cost_price: 1 + i, barcode: s.barcode });
    n++;
  }));
  return n;
}

// Seeds only when the tenant has no business data yet. Returns true if seeded.
function seedIfEmpty(dataDir, { force = false, inventory = null, tenantContext = null } = {}) {
  if (!/^(1|true|yes)$/i.test(String(process.env.DEMO_MODE || ''))) throw new Error('seed-demo refuses to run unless DEMO_MODE=true');
  const dir = path.join(dataDir, 'tenants', TENANT);
  const file = path.join(dir, 'db.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const hasData = (existing.batches || []).length || (existing.clientProfiles || []).length || (existing.transport || []).length;
  if (hasData && !force) return false;
  fs.mkdirSync(dir, { recursive: true });
  const db = { ...existing, ...buildDb() };
  fs.writeFileSync(file + '.tmp', JSON.stringify(db));
  fs.renameSync(file + '.tmp', file);
  let inv = 0;
  if (inventory && tenantContext) inv = tenantContext.run(TENANT, () => seedInventory(inventory));
  console.log(`[seed-demo] seeded ${db.batches.length} batches, ${db.transport.length} transport jobs, ${db.clientProfiles.length} clients, ${inv} inventory items`);
  return true;
}

module.exports = { buildDb, seedIfEmpty, seedInventory, CLIENTS };

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
  let inventory = null, tenantContext = null;
  try { inventory = require('../lib/inventory-store'); tenantContext = require('../lib/tenant-context'); } catch {}
  const ok = seedIfEmpty(dataDir, { force: process.argv.includes('--force'), inventory, tenantContext });
  if (!ok) console.log('[seed-demo] tenant already has data — nothing done (use --force to overwrite)');
}
