'use strict';

const db   = require('./db');
const auth = require('./auth');
const { uid } = require('./store');

const CLIENT_ID = 'bwl';

const LOCATIONS = [
  { id: 'loc-ae', country: 'AE', country_name: 'United Arab Emirates', city: 'Dubai',       lat: 25.2048, lng: 55.2708 },
  { id: 'loc-gb', country: 'GB', country_name: 'United Kingdom',       city: 'London',      lat: 51.5072, lng: -0.1276 },
  { id: 'loc-mx', country: 'MX', country_name: 'Mexico',               city: 'Mexico City', lat: 19.4326, lng: -99.1332 },
  { id: 'loc-us', country: 'US', country_name: 'United States',        city: 'Los Angeles',  lat: 34.0522, lng: -118.2437 },
];

// One primary fulfillment vendor per market — invisible to the client, this
// is who NimbusTrade actually routes the order to behind the scenes.
const VENDORS = [
  { id: 'vendor-ae', country: 'AE', name: 'Gulf Fulfillment Partners',    username: 'vendor-ae', password: 'VendorAE@2026' },
  { id: 'vendor-gb', country: 'GB', name: 'Albion Logistics Co',          username: 'vendor-gb', password: 'VendorGB@2026' },
  { id: 'vendor-mx', country: 'MX', name: 'Azteca Cargo Solutions',       username: 'vendor-mx', password: 'VendorMX@2026' },
  { id: 'vendor-us', country: 'US', name: 'Pacific Coast Fulfillment',    username: 'vendor-us', password: 'VendorUS@2026' },
];

const SKUS = [
  { sku: 'RAD-SER-30',  name: 'Radiance Serum 30ml' },
  { sku: 'NGT-CRM-50',  name: 'Renewal Night Cream 50ml' },
  { sku: 'BRT-TNR-150', name: 'Brightening Toner 150ml' },
  { sku: 'COL-ESS-30',  name: 'Collagen Essence 30ml' },
  { sku: 'VTC-CLN-100', name: 'Vitamin C Cleanser 100ml' },
];

// Starting stock per location — deliberately leaves a couple of items under
// threshold so the replenishment alert has something real to show.
const INVENTORY_SEED = {
  'loc-ae': [260, 40, 190, 130, 22],
  'loc-gb': [310, 95, 24, 175, 140],
  'loc-mx': [150, 130, 210, 18, 260],
  'loc-us': [420, 260, 300, 190, 350],
};
const THRESHOLDS = [60, 60, 60, 50, 50];

const NAMES_BY_COUNTRY = {
  AE: {
    first: ['Ahmed', 'Fatima', 'Omar', 'Layla', 'Khalid', 'Mariam', 'Youssef', 'Noor', 'Hassan', 'Aisha', 'Sara', 'Rashid'],
    last: ['Al Maktoum', 'Al Suwaidi', 'Haddad', 'Khan', 'Rahman', 'Al Farsi', 'Sharma', 'Iqbal', 'Al Nuaimi', 'Osman'],
  },
  GB: {
    first: ['Oliver', 'Amelia', 'George', 'Isla', 'Harry', 'Ava', 'Jack', 'Freya', 'Charlie', 'Grace', 'Thomas', 'Poppy'],
    last: ['Smith', 'Jones', 'Taylor', 'Brown', 'Wilson', 'Evans', 'Thomas', 'Roberts', 'Walker', 'Wright'],
  },
  MX: {
    first: ['Mateo', 'Valentina', 'Santiago', 'Ximena', 'Sebastian', 'Camila', 'Diego', 'Renata', 'Emiliano', 'Fernanda'],
    last: ['Garcia', 'Hernandez', 'Lopez', 'Martinez', 'Gonzalez', 'Perez', 'Sanchez', 'Ramirez', 'Torres', 'Flores'],
  },
  US: {
    first: ['Liam', 'Olivia', 'Noah', 'Emma', 'James', 'Sophia', 'Benjamin', 'Mia', 'Lucas', 'Charlotte', 'Henry', 'Amelia'],
    last: ['Johnson', 'Williams', 'Davis', 'Miller', 'Anderson', 'Thompson', 'Martinez', 'Clark', 'Lewis', 'Young'],
  },
};

function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }

// Small deterministic PRNG (mulberry32) so the demo dataset is reproducible.
function makeRng(seed) {
  let a = seed;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedBWLDemo() {
  const exists = db.prepare('SELECT id FROM nt_clients WHERE id = ?').get(CLIENT_ID);
  if (exists) return { alreadySeeded: true };

  const insertClient = db.prepare('INSERT INTO nt_clients (id, name) VALUES (?, ?)');
  const insertUser = db.prepare(
    'INSERT INTO nt_users (id, client_id, name, username, password_hash) VALUES (?, ?, ?, ?, ?)'
  );
  const insertLocation = db.prepare(
    'INSERT INTO nt_locations (id, client_id, country, country_name, city, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertInventory = db.prepare(
    'INSERT INTO nt_inventory (id, location_id, sku, product_name, qty_on_hand, replenish_threshold) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertVendor = db.prepare(
    'INSERT INTO nt_vendors (id, country, name, username, password_hash) VALUES (?, ?, ?, ?, ?)'
  );
  const insertOrder = db.prepare(`
    INSERT INTO nt_orders (id, client_id, order_ref, country, country_name, customer_name, sku, product_name, qty, status, issue_note, vendor_id, order_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seedAll = db.transaction(() => {
    insertClient.run(CLIENT_ID, 'BWL Online');
    insertUser.run('bwl-ops', CLIENT_ID, 'BWL Operations', 'bwlonline', auth.sha256('BWLOnline@2026'));

    for (const loc of LOCATIONS) {
      insertLocation.run(loc.id, CLIENT_ID, loc.country, loc.country_name, loc.city, loc.lat, loc.lng);
      const stock = INVENTORY_SEED[loc.id];
      SKUS.forEach((item, i) => {
        insertInventory.run(uid('inv'), loc.id, item.sku, item.name, stock[i], THRESHOLDS[i]);
      });
    }

    const vendorByCountry = {};
    for (const v of VENDORS) {
      insertVendor.run(v.id, v.country, v.name, v.username, auth.sha256(v.password));
      vendorByCountry[v.country] = v.id;
    }

    // 500+ orders across June 2026, weighted roughly by market size:
    // US > GB > AE > MX
    const weights = [
      { loc: LOCATIONS[3], count: 190 }, // US
      { loc: LOCATIONS[1], count: 145 }, // GB
      { loc: LOCATIONS[0], count: 110 }, // AE
      { loc: LOCATIONS[2], count: 85 },  // MX
    ];

    const rng = makeRng(20260601);
    let orderSeq = 0;
    const YEAR = 2026;
    const MONTH = 6; // June

    for (const { loc, count } of weights) {
      const names = NAMES_BY_COUNTRY[loc.country];
      for (let i = 0; i < count; i++) {
        orderSeq += 1;
        const day = 1 + Math.floor(rng() * 30);
        const orderDate = `${YEAR}-06-${String(day).padStart(2, '0')}`;
        const item = pick(SKUS, rng);
        const qty = 1 + Math.floor(rng() * 3);
        const customerName = `${pick(names.first, rng)} ${pick(names.last, rng)}`;

        // Status distribution: mostly resolved by now (report month has closed),
        // a small live tail of processing/dropped/issue to make the dashboard feel real.
        const roll = rng();
        let status = 'completed';
        let issueNote = '';
        if (roll > 0.97) {
          status = 'issue';
          issueNote = pick([
            'Customs hold — awaiting import permit confirmation',
            'Address verification failed, contacting customer',
            'Damaged in transit, replacement being arranged',
            'Payment reconciliation mismatch flagged by carrier',
          ], rng);
        } else if (roll > 0.93) {
          status = 'dropped';
        } else if (roll > 0.85) {
          status = 'processing';
        }

        const orderRef = `BWL-202606-${String(orderSeq).padStart(4, '0')}`;
        const createdAt = `${orderDate} 09:00:00`;

        insertOrder.run(
          uid('ord'), CLIENT_ID, orderRef, loc.country, loc.country_name,
          customerName, item.sku, item.name, qty, status, issueNote,
          vendorByCountry[loc.country] || '', orderDate, createdAt
        );
      }
    }
  });

  seedAll();
  return { alreadySeeded: false, ordersSeeded: orderCount() };
}

function orderCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM nt_orders WHERE client_id = ?').get(CLIENT_ID).n;
}

module.exports = { seedBWLDemo, CLIENT_ID };
