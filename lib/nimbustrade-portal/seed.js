'use strict';

const db   = require('./db');
const auth = require('./auth');
const { uid } = require('./store');

const CLIENT_ID = 'bwl';

const LOCATIONS = [
  { id: 'loc-ae', country: 'AE', country_name: 'United Arab Emirates', city: 'Dubai',       lat: 25.2048, lng: 55.2708 },
  { id: 'loc-ca', country: 'CA', country_name: 'Canada',                city: 'Toronto',     lat: 43.6532, lng: -79.3832 },
  { id: 'loc-gb', country: 'GB', country_name: 'United Kingdom',       city: 'London',      lat: 51.5072, lng: -0.1276 },
  { id: 'loc-mx', country: 'MX', country_name: 'Mexico',               city: 'Mexico City', lat: 19.4326, lng: -99.1332 },
  { id: 'loc-us', country: 'US', country_name: 'United States',        city: 'Los Angeles',  lat: 34.0522, lng: -118.2437 },
];

// One primary fulfillment vendor per market — invisible to the client, this
// is who NimbusTrade actually routes the order to behind the scenes.
const VENDORS = [
  { id: 'vendor-ae', country: 'AE', name: 'Gulf Fulfillment Partners',    username: 'vendor-ae', password: 'VendorAE@2026' },
  { id: 'vendor-ca', country: 'CA', name: 'Maple Freight Network',        username: 'vendor-ca', password: 'VendorCA@2026' },
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
  'loc-ca': [380, 230, 270, 160, 300],
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
  CA: {
    first: ['Liam', 'Olivia', 'Noah', 'Emma', 'Ethan', 'Charlotte', 'Jacob', 'Chloe', 'William', 'Zoe', 'Logan', 'Alice'],
    last: ['Tremblay', 'Roy', 'Gagnon', 'Martin', 'MacDonald', 'Campbell', 'Wilson', 'Chan', 'Singh', 'Nguyen'],
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

// Order volume weighted roughly by market size: CA > US > GB > AE > MX.
// Three months of history tell a real seasonal story for the demo:
// May peaked, June cooled off, July is the current running month and
// is on track to be the biggest yet (blinking "LIVE" in the dashboard).
const MAY_WEIGHTS = { CA: 300, US: 270, GB: 210, AE: 160, MX: 120 };   // 1,060 — seasonal peak
const JUNE_WEIGHTS = { CA: 210, US: 190, GB: 145, AE: 110, MX: 85 };   //   740 — post-peak dip
const JULY_WEIGHTS = { CA: 340, US: 310, GB: 240, AE: 180, MX: 130 }; // 1,200 — current month, live

// "Today" for this fictional demo dataset — matches the environment's real
// current date, so July reads as genuinely in-progress rather than fabricated
// future activity. Nothing in the seed ever dates past this.
const TODAY_STR = '2026-07-30';

const MONTHS = [
  { month: '05', weights: MAY_WEIGHTS, dayRange: 31, live: false },
  { month: '06', weights: JUNE_WEIGHTS, dayRange: 30, live: false },
  { month: '07', weights: JULY_WEIGHTS, dayRange: 30, live: true },
];

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
  INSERT INTO nt_orders (id, client_id, order_ref, country, country_name, customer_name, sku, product_name, qty, status, issue_note, vendor_id, carrier, waybill_number, order_date, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertEvent = db.prepare(
  'INSERT INTO nt_order_events (id, order_id, status, note, created_at) VALUES (?, ?, ?, ?, ?)'
);
const insertInbound = db.prepare(`
  INSERT INTO nt_inbound_shipments (id, client_id, location_id, reference, carrier, waybill_number, contents, expected_qty, received_qty, status, expected_date, arrived_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Internal reference numbers only — illustrative of the format each carrier
// uses, not real trackable shipments. Only assigned once an order has
// actually left "dropped" (i.e. handed to a carrier).
const CARRIERS = ['DHL', 'FedEx'];
function makeWaybill(carrier, rng) {
  const digits = carrier === 'DHL' ? 10 : 12;
  let n = '';
  for (let i = 0; i < digits; i++) n += Math.floor(rng() * 10);
  return n;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Safety net so no event timestamp — even one computed as orderDate + a few
// days — ever lands after "today" in the fictional demo timeline.
function clampDateTime(dateTimeStr) {
  return dateTimeStr.slice(0, 10) > TODAY_STR ? `${TODAY_STR} 18:00:00` : dateTimeStr;
}

const ISSUE_NOTES = [
  'Customs hold — awaiting import permit confirmation',
  'Address verification failed, contacting customer',
  'Damaged in transit, replacement being arranged',
  'Payment reconciliation mismatch flagged by carrier',
];

function seedLocationOrders(loc, vendorId, rng, startSeq, monthCfg) {
  const names = NAMES_BY_COUNTRY[loc.country];
  const count = monthCfg.weights[loc.country] || 0;
  let orderSeq = startSeq;
  const YEAR = 2026;

  for (let i = 0; i < count; i++) {
    orderSeq += 1;
    const day = 1 + Math.floor(rng() * monthCfg.dayRange);
    const orderDate = `${YEAR}-${monthCfg.month}-${String(day).padStart(2, '0')}`;
    const item = pick(SKUS, rng);
    const qty = 1 + Math.floor(rng() * 3);
    const customerName = `${pick(names.first, rng)} ${pick(names.last, rng)}`;

    const roll = rng();
    let status = 'completed';
    let issueNote = '';

    // Dropped in the last couple of days of a still-running month — too soon
    // to have resolved, so it stays in flight rather than fake-resolving.
    const tooRecentForLiveMonth = monthCfg.live && (monthCfg.dayRange - day) < 2;

    if (tooRecentForLiveMonth) {
      status = roll > 0.55 ? 'dropped' : 'processing';
    } else if (monthCfg.live) {
      // Current running month — a larger live tail than a closed-out month.
      if (roll > 0.97) { status = 'issue'; issueNote = pick(ISSUE_NOTES, rng); }
      else if (roll > 0.90) status = 'dropped';
      else if (roll > 0.74) status = 'processing';
    } else {
      // Closed month — mostly resolved, a small residual tail for realism.
      if (roll > 0.97) { status = 'issue'; issueNote = pick(ISSUE_NOTES, rng); }
      else if (roll > 0.93) status = 'dropped';
      else if (roll > 0.85) status = 'processing';
    }

    const orderRef = `BWL-2026${monthCfg.month}-${String(orderSeq).padStart(4, '0')}`;
    const createdAt = `${orderDate} 09:00:00`;

    let carrier = '';
    let waybill = '';
    if (status !== 'dropped') {
      carrier = pick(CARRIERS, rng);
      waybill = makeWaybill(carrier, rng);
    }

    const id = uid('ord');
    insertOrder.run(
      id, CLIENT_ID, orderRef, loc.country, loc.country_name,
      customerName, item.sku, item.name, qty, status, issueNote,
      vendorId || '', carrier, waybill, orderDate, createdAt
    );

    // Real (if synthetic-dated) status history, not a single flat row, so the
    // tracking timeline has something genuine to show from day one.
    insertEvent.run(uid('evt'), id, 'dropped', '', `${orderDate} 09:00:00`);
    if (status !== 'dropped') {
      insertEvent.run(uid('evt'), id, 'processing', '', clampDateTime(`${addDays(orderDate, 1)} 10:00:00`));
    }
    if (status === 'completed') {
      insertEvent.run(uid('evt'), id, 'completed', '', clampDateTime(`${addDays(orderDate, 2 + Math.floor(rng() * 3))} 16:00:00`));
    } else if (status === 'issue') {
      insertEvent.run(uid('evt'), id, 'issue', issueNote, clampDateTime(`${addDays(orderDate, 2)} 13:00:00`));
    }
  }
  return orderSeq;
}

// Replenishment shipments arriving INTO this DC — restocking from BWL's
// supplier, not customer orders. Mostly arrived (it's reporting on June/July),
// with a couple still moving so "in transit" and "delayed" have real rows too.
function seedInboundForLocation(loc, rng) {
  const shipmentCount = 4 + Math.floor(rng() * 3); // 4-6 per DC
  for (let i = 0; i < shipmentCount; i++) {
    const month = i < shipmentCount - 1 ? '06' : '07';
    const day = 1 + Math.floor(rng() * (month === '07' ? 28 : 27));
    const expectedDate = `2026-${month}-${String(day).padStart(2, '0')}`;

    const lineItems = [];
    let expectedQty = 0;
    const itemCount = 2 + Math.floor(rng() * 3);
    const usedSkus = new Set();
    for (let j = 0; j < itemCount; j++) {
      const item = pick(SKUS, rng);
      if (usedSkus.has(item.sku)) continue;
      usedSkus.add(item.sku);
      const qty = (4 + Math.floor(rng() * 8)) * 10;
      lineItems.push(`${item.name} x${qty}`);
      expectedQty += qty;
    }

    const roll = rng();
    let status = 'arrived';
    let receivedQty = expectedQty;
    let arrivedDate = addDays(expectedDate, Math.floor(rng() * 2));
    if (i === shipmentCount - 1 && roll > 0.55) {
      status = 'in_transit'; receivedQty = 0; arrivedDate = '';
    } else if (roll > 0.92) {
      status = 'delayed'; receivedQty = 0; arrivedDate = '';
    } else if (roll > 0.85) {
      status = 'partial'; receivedQty = Math.round(expectedQty * (0.5 + rng() * 0.3));
    }

    const carrier = pick(CARRIERS, rng);
    const reference = `INB-${loc.country}-${String(i + 1).padStart(3, '0')}`;
    insertInbound.run(
      uid('inb'), CLIENT_ID, loc.id, reference, carrier, makeWaybill(carrier, rng),
      lineItems.join(', '), expectedQty, receivedQty, status, expectedDate, arrivedDate
    );
  }
}

// Location row, starting inventory, vendor, and inbound shipments — everything
// about a DC except its orders, which are seeded separately per month so refs
// number correctly within each month across all locations.
function seedLocationBase(loc, rng) {
  insertLocation.run(loc.id, CLIENT_ID, loc.country, loc.country_name, loc.city, loc.lat, loc.lng);
  const stock = INVENTORY_SEED[loc.id];
  SKUS.forEach((item, i) => {
    insertInventory.run(uid('inv'), loc.id, item.sku, item.name, stock[i], THRESHOLDS[i]);
  });

  const vendor = VENDORS.find((v) => v.country === loc.country);
  if (vendor && !db.prepare('SELECT id FROM nt_vendors WHERE id = ?').get(vendor.id)) {
    insertVendor.run(vendor.id, vendor.country, vendor.name, vendor.username, auth.sha256(vendor.password));
  }

  seedInboundForLocation(loc, rng);
}

function orderCountForMonth(month) {
  return db.prepare("SELECT COUNT(*) AS n FROM nt_orders WHERE client_id = ? AND order_date LIKE ?")
    .get(CLIENT_ID, `2026-${month}-%`).n;
}

function hasMonthData(month) {
  return !!db.prepare("SELECT id FROM nt_orders WHERE client_id = ? AND order_date LIKE ? LIMIT 1")
    .get(CLIENT_ID, `2026-${month}-%`);
}

// Seeds one month's orders across a set of locations, continuing the ref
// sequence from however many orders that month already has — so calling this
// again for just the locations that need it (e.g. one new DC) numbers correctly.
function seedOrdersForMonth(monthCfg, locations, rng) {
  let seq = orderCountForMonth(monthCfg.month);
  for (const loc of locations) {
    const vendor = VENDORS.find((v) => v.country === loc.country);
    seq = seedLocationOrders(loc, vendor && vendor.id, rng, seq, monthCfg);
  }
}

// Orders seeded before carrier/waybill/event-history existed have none of the
// three. Derives a real-shaped (if approximately-dated) history from each
// order's own existing status/date, and assigns carrier+waybill only to
// orders that have actually left "dropped" — never touches order status itself.
function backfillEventsAndCarriers(rng) {
  const orders = db.prepare(`
    SELECT o.id, o.status, o.issue_note, o.order_date, o.carrier
    FROM nt_orders o
    WHERE o.client_id = ? AND NOT EXISTS (SELECT 1 FROM nt_order_events e WHERE e.order_id = o.id)
  `).all(CLIENT_ID);

  for (const o of orders) {
    insertEvent.run(uid('evt'), o.id, 'dropped', '', `${o.order_date} 09:00:00`);
    if (o.status !== 'dropped') {
      insertEvent.run(uid('evt'), o.id, 'processing', '', `${addDays(o.order_date, 1)} 10:00:00`);
    }
    if (o.status === 'completed') {
      insertEvent.run(uid('evt'), o.id, 'completed', '', `${addDays(o.order_date, 2 + Math.floor(rng() * 3))} 16:00:00`);
    } else if (o.status === 'issue') {
      insertEvent.run(uid('evt'), o.id, 'issue', o.issue_note || '', `${addDays(o.order_date, 2)} 13:00:00`);
    }
    if (o.status !== 'dropped' && !o.carrier) {
      const carrier = pick(CARRIERS, rng);
      db.prepare('UPDATE nt_orders SET carrier = ?, waybill_number = ? WHERE id = ?')
        .run(carrier, makeWaybill(carrier, rng), o.id);
    }
  }
  return orders.length;
}

function seedBWLDemo() {
  const exists = db.prepare('SELECT id FROM nt_clients WHERE id = ?').get(CLIENT_ID);

  // Seeded in market-size order so order refs read largest-to-smallest.
  const ordered = ['CA', 'US', 'GB', 'AE', 'MX'].map((code) => LOCATIONS.find((l) => l.country === code));

  if (!exists) {
    const seedAll = db.transaction(() => {
      insertClient.run(CLIENT_ID, 'BWL Online');
      insertUser.run('bwl-ops', CLIENT_ID, 'BWL Operations', 'bwlonline', auth.sha256('BWLOnline@2026'));

      const rng = makeRng(20260601);
      for (const loc of ordered) seedLocationBase(loc, rng);
      for (const monthCfg of MONTHS) seedOrdersForMonth(monthCfg, ordered, rng);
    });
    seedAll();
    return { alreadySeeded: false, ordersSeeded: orderCount() };
  }

  // Client already seeded from an earlier deployment — backfill any markets
  // (e.g. Canada) added to LOCATIONS since, without touching existing data,
  // plus event history / carrier data for any order that predates that feature,
  // plus any month (e.g. May, July) added to MONTHS since the client was seeded.
  const missing = LOCATIONS.filter(
    (loc) => !db.prepare('SELECT id FROM nt_locations WHERE id = ?').get(loc.id)
  );

  const rng = makeRng(20260815);
  let backfilledEvents = 0;
  let backfilledInbound = 0;
  const backfilledMonths = [];
  const backfill = db.transaction(() => {
    for (const loc of missing) seedLocationBase(loc, rng);
    if (missing.length) {
      for (const monthCfg of MONTHS) seedOrdersForMonth(monthCfg, missing, rng);
    }
    backfilledEvents = backfillEventsAndCarriers(rng);

    // Locations that existed before inbound shipments did — seedLocationBase()
    // already handled the newly-added `missing` ones above.
    const missingIds = new Set(missing.map((l) => l.id));
    for (const loc of LOCATIONS) {
      if (missingIds.has(loc.id)) continue;
      const hasInbound = db.prepare('SELECT id FROM nt_inbound_shipments WHERE location_id = ? LIMIT 1').get(loc.id);
      if (!hasInbound) {
        seedInboundForLocation(loc, rng);
        backfilledInbound += 1;
      }
    }

    for (const monthCfg of MONTHS) {
      if (!hasMonthData(monthCfg.month)) {
        seedOrdersForMonth(monthCfg, ordered, rng);
        backfilledMonths.push(monthCfg.month);
      }
    }
  });
  backfill();

  if (!missing.length && !backfilledEvents && !backfilledInbound && !backfilledMonths.length) {
    return { alreadySeeded: true };
  }
  return {
    alreadySeeded: true,
    backfilled: missing.map((l) => l.country),
    backfilledEvents,
    backfilledInbound,
    backfilledMonths,
    ordersSeeded: orderCount(),
  };
}

function orderCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM nt_orders WHERE client_id = ?').get(CLIENT_ID).n;
}

module.exports = { seedBWLDemo, CLIENT_ID };
