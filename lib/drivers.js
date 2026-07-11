'use strict';

const crypto = require('crypto');

const DRIVER_TOKEN_TTL = 12 * 60 * 60 * 1000; // 12 hours
const LOCATION_HISTORY_LIMIT = 200;           // pings kept per driver

const ACTIVE_STATUSES   = new Set(['assigned', 'picked_up', 'in_transit']);
const TERMINAL_STATUSES = new Set(['delivered', 'failed']);

// Legal lifecycle transitions. Staff can additionally retry a failed
// delivery back to 'assigned' (handled explicitly below).
const TRANSITIONS = {
  assigned:   new Set(['picked_up', 'in_transit', 'failed']),
  picked_up:  new Set(['in_transit', 'delivered', 'failed']),
  in_transit: new Set(['delivered', 'failed']),
  delivered:  new Set([]),
  failed:     new Set([]),
};

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function shortId(prefix) {
  return prefix + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Customer-facing tracking number: unguessable, unambiguous alphabet
// (no 0/O/1/I/L) so it survives being read out over the phone.
const TRACK_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function newTrackingCode() {
  let s = '';
  const bytes = crypto.randomBytes(9);
  for (let i = 0; i < 9; i++) s += TRACK_ALPHABET[bytes[i] % TRACK_ALPHABET.length];
  return 'IDL-' + s.slice(0, 4) + '-' + s.slice(4);
}

module.exports = function createDrivers({ db, store, geocoder = null }) {

  db.exec(`
    CREATE TABLE IF NOT EXISTS drivers (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      phone      TEXT NOT NULL UNIQUE,
      vehicle    TEXT DEFAULT '',
      plate      TEXT DEFAULT '',
      pin_hash   TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS driver_sessions (
      token      TEXT PRIMARY KEY,
      driver_id  TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id            TEXT PRIMARY KEY,
      order_id      TEXT NOT NULL,
      driver_id     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'assigned',
      assigned_by   TEXT DEFAULT '',
      assigned_at   TEXT NOT NULL DEFAULT (datetime('now')),
      picked_up_at  TEXT,
      in_transit_at TEXT,
      delivered_at  TEXT,
      failed_at     TEXT,
      failed_reason TEXT DEFAULT '',
      pod_name      TEXT DEFAULT '',
      pod_note      TEXT DEFAULT '',
      pod_lat       REAL,
      pod_lng       REAL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_driver ON deliveries(driver_id, status);
    CREATE INDEX IF NOT EXISTS idx_deliveries_order  ON deliveries(order_id);
  `);

  // Migrate: proof-of-delivery media on existing DBs
  for (const col of ['pod_signature TEXT', 'pod_photo TEXT']) {
    try { db.exec(`ALTER TABLE deliveries ADD COLUMN ${col}`); } catch (_) {}
  }

  // Migrate: truck capacity (drivers) and job load (deliveries).
  // Capacity semantics: NULL or 0 = no limit for that dimension.
  for (const col of ['capacity_m3 REAL', 'capacity_kg REAL', 'capacity_pallets REAL']) {
    try { db.exec(`ALTER TABLE drivers ADD COLUMN ${col}`); } catch (_) {}
  }
  for (const col of ['load_m3 REAL', 'load_kg REAL', 'load_pallets REAL']) {
    try { db.exec(`ALTER TABLE deliveries ADD COLUMN ${col}`); } catch (_) {}
  }

  // Migrate: route planning — destination coords + optimized stop order
  for (const col of ['dest_lat REAL', 'dest_lng REAL', 'stop_seq INTEGER']) {
    try { db.exec(`ALTER TABLE deliveries ADD COLUMN ${col}`); } catch (_) {}
  }

  // Migrate: recorded justification for mid-schedule job insertions
  try { db.exec('ALTER TABLE deliveries ADD COLUMN assign_note TEXT'); } catch (_) {}

  // Migrate: fixed schedule — when set, the driver's stop order is dispatcher-
  // defined and survives replanning until explicitly re-optimized (amended)
  try { db.exec('ALTER TABLE drivers ADD COLUMN route_fixed INTEGER NOT NULL DEFAULT 0'); } catch (_) {}

  db.exec(`

    CREATE TABLE IF NOT EXISTS driver_locations (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id TEXT NOT NULL,
      lat       REAL NOT NULL,
      lng       REAL NOT NULL,
      accuracy  REAL,
      speed     REAL,
      heading   REAL,
      at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_driver_locations ON driver_locations(driver_id, id);
  `);

  function httpError(message, status) {
    return Object.assign(new Error(message), { status });
  }

  // ── drivers ────────────────────────────────────────────────────────────────

  function publicDriver(row) {
    if (!row) return null;
    const { pin_hash, ...rest } = row;
    return rest;
  }

  function activeLoad(driverId) {
    const r = db.prepare(
      `SELECT COUNT(*) AS n,
              SUM(COALESCE(load_m3,0)) AS m3,
              SUM(COALESCE(load_kg,0)) AS kg,
              SUM(COALESCE(load_pallets,0)) AS pallets
       FROM deliveries WHERE driver_id = ? AND status IN ('assigned','picked_up','in_transit')`
    ).get(driverId);
    return { n: r.n || 0, m3: r.m3 || 0, kg: r.kg || 0, pallets: r.pallets || 0 };
  }

  function listDrivers() {
    const drivers = db.prepare('SELECT * FROM drivers ORDER BY name').all().map(publicDriver);
    const lastSeen = db.prepare(
      'SELECT driver_id, MAX(at) AS at FROM driver_locations GROUP BY driver_id'
    ).all();
    const seenMap = Object.fromEntries(lastSeen.map(l => [l.driver_id, l.at]));
    return drivers.map(d => {
      const load = activeLoad(d.id);
      return {
        ...d,
        activeDeliveries: load.n,
        currentLoad: { m3: load.m3, kg: load.kg, pallets: load.pallets },
        lastSeenAt: seenMap[d.id] || null,
      };
    });
  }

  function getDriver(id) {
    return publicDriver(db.prepare('SELECT * FROM drivers WHERE id = ?').get(id));
  }

  const cap = v => { const n = +v; return Number.isFinite(n) && n > 0 ? n : null; };

  function createDriver({ name, phone, vehicle = '', plate = '', pin, capacityM3, capacityKg, capacityPallets }) {
    name  = String(name || '').trim();
    phone = String(phone || '').replace(/\s+/g, '');
    pin   = String(pin || '').trim();
    if (!name) throw httpError('Driver name is required', 400);
    if (!phone) throw httpError('Driver phone is required', 400);
    if (!/^\d{4,8}$/.test(pin)) throw httpError('PIN must be 4-8 digits', 400);
    const exists = db.prepare('SELECT id FROM drivers WHERE phone = ?').get(phone);
    if (exists) throw httpError('A driver with this phone already exists', 409);
    const id = shortId('DRV');
    db.prepare(
      `INSERT INTO drivers (id, name, phone, vehicle, plate, pin_hash, capacity_m3, capacity_kg, capacity_pallets)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, name, phone, String(vehicle || '').trim(), String(plate || '').trim(), sha256(pin),
      cap(capacityM3), cap(capacityKg), cap(capacityPallets));
    return getDriver(id);
  }

  function updateDriver(id, { name, phone, vehicle, plate, pin, active, capacityM3, capacityKg, capacityPallets } = {}) {
    const d = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);
    if (!d) throw httpError('Driver not found', 404);
    if (phone !== undefined) {
      phone = String(phone).replace(/\s+/g, '');
      const clash = db.prepare('SELECT id FROM drivers WHERE phone = ? AND id != ?').get(phone, id);
      if (clash) throw httpError('A driver with this phone already exists', 409);
    }
    if (pin !== undefined && !/^\d{4,8}$/.test(String(pin).trim())) {
      throw httpError('PIN must be 4-8 digits', 400);
    }
    db.prepare(
      `UPDATE drivers SET
         name     = COALESCE(?, name),
         phone    = COALESCE(?, phone),
         vehicle  = COALESCE(?, vehicle),
         plate    = COALESCE(?, plate),
         pin_hash = COALESCE(?, pin_hash),
         active   = COALESCE(?, active)
       WHERE id = ?`
    ).run(
      name !== undefined ? String(name).trim() : null,
      phone !== undefined ? phone : null,
      vehicle !== undefined ? String(vehicle).trim() : null,
      plate !== undefined ? String(plate).trim() : null,
      pin !== undefined ? sha256(String(pin).trim()) : null,
      active !== undefined ? (active ? 1 : 0) : null,
      id
    );
    // capacity: settable and clearable (0/empty = no limit)
    if (capacityM3 !== undefined || capacityKg !== undefined || capacityPallets !== undefined) {
      const cur = db.prepare('SELECT capacity_m3, capacity_kg, capacity_pallets FROM drivers WHERE id = ?').get(id);
      db.prepare('UPDATE drivers SET capacity_m3 = ?, capacity_kg = ?, capacity_pallets = ? WHERE id = ?').run(
        capacityM3 !== undefined ? cap(capacityM3) : cur.capacity_m3,
        capacityKg !== undefined ? cap(capacityKg) : cur.capacity_kg,
        capacityPallets !== undefined ? cap(capacityPallets) : cur.capacity_pallets,
        id
      );
    }
    if (active !== undefined && !active) {
      db.prepare('DELETE FROM driver_sessions WHERE driver_id = ?').run(id);
    }
    return getDriver(id);
  }

  function deleteDriver(id) {
    const d = db.prepare('SELECT id FROM drivers WHERE id = ?').get(id);
    if (!d) throw httpError('Driver not found', 404);
    const active = db.prepare(
      "SELECT COUNT(*) AS n FROM deliveries WHERE driver_id = ? AND status IN ('assigned','picked_up','in_transit')"
    ).get(id);
    if (active.n > 0) throw httpError('Driver has active deliveries — reassign or complete them first', 409);
    db.prepare('DELETE FROM driver_sessions WHERE driver_id = ?').run(id);
    db.prepare('DELETE FROM driver_locations WHERE driver_id = ?').run(id);
    db.prepare('DELETE FROM drivers WHERE id = ?').run(id);
  }

  // ── driver auth ────────────────────────────────────────────────────────────

  function login(phone, pin) {
    phone = String(phone || '').replace(/\s+/g, '');
    const d = db.prepare('SELECT * FROM drivers WHERE phone = ? AND active = 1').get(phone);
    if (!d || d.pin_hash !== sha256(String(pin || '').trim())) return null;
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO driver_sessions (token, driver_id, expires_at) VALUES (?, ?, ?)')
      .run(token, d.id, Date.now() + DRIVER_TOKEN_TTL);
    db.prepare('DELETE FROM driver_sessions WHERE expires_at < ?').run(Date.now());
    return { token, driver: publicDriver(d) };
  }

  function validateToken(token) {
    if (!token) return null;
    const row = db.prepare(
      `SELECT s.expires_at, d.* FROM driver_sessions s
       JOIN drivers d ON d.id = s.driver_id
       WHERE s.token = ? AND d.active = 1`
    ).get(token);
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      db.prepare('DELETE FROM driver_sessions WHERE token = ?').run(token);
      return null;
    }
    const { expires_at, ...driver } = row;
    return publicDriver(driver);
  }

  function revokeToken(token) {
    if (token) db.prepare('DELETE FROM driver_sessions WHERE token = ?').run(token);
  }

  // ── deliveries ─────────────────────────────────────────────────────────────

  function orderSummary(orderId) {
    const o = store.getOrder(orderId);
    if (!o) return null;
    const s = o.shipping || {};
    const address = [s.addressLine1, s.addressLine2, s.city, s.state, s.zip, s.country]
      .filter(Boolean).join(', ');
    return {
      orderId: o.id,
      orderStatus: o.status,
      clientName: o.clientName,
      channel: o.channel,
      recipient: s.recipient || '',
      phone: s.phone || '',
      address,
      itemCount: (o.items || []).reduce((n, i) => n + (i.qty || 0), 0),
      total: o.total,
      currency: o.currency,
      trackingNo: (o.source || {}).trackingNo || null,
      trackingCode: (o.source || {}).trackingCode || null,
    };
  }

  // Get (or lazily create) the customer-facing tracking number for an order
  function ensureTrackingCode(orderId) {
    const order = store.getOrder(orderId);
    if (!order) throw httpError('Order not found', 404);
    const existing = (order.source || {}).trackingCode;
    if (existing) return existing;
    const code = newTrackingCode();
    store.updateSource(orderId, { trackingCode: code });
    return code;
  }

  // List/summary shape — POD media is stripped (can be hundreds of KB per row)
  // and replaced with has* flags; fetch the full row via getDeliveryFull.
  function enrichDelivery(row) {
    if (!row) return null;
    const driver = getDriver(row.driver_id);
    const { pod_signature, pod_photo, ...rest } = row;
    return {
      ...rest,
      hasSignature: !!pod_signature,
      hasPhoto: !!pod_photo,
      driverName: driver ? driver.name : row.driver_id,
      order: orderSummary(row.order_id),
    };
  }

  function getDelivery(id) {
    return enrichDelivery(db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id));
  }

  function getDeliveryFull(id) {
    const row = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id);
    if (!row) return null;
    const driver = getDriver(row.driver_id);
    return {
      ...enrichDelivery(row),
      pod_signature: row.pod_signature || null,
      pod_photo: row.pod_photo || null,
      driver: driver ? { name: driver.name, vehicle: driver.vehicle, plate: driver.plate, phone: driver.phone } : null,
    };
  }

  function activeDeliveryForOrder(orderId) {
    return db.prepare(
      "SELECT * FROM deliveries WHERE order_id = ? AND status IN ('assigned','picked_up','in_transit') LIMIT 1"
    ).get(orderId);
  }

  // loads: { [orderId]: { m3, kg, pallets } } — job size data entered at dispatch.
  // Capacity is enforced per dimension the truck defines; force=true overrides
  // (admin accepts an overload / plans a second trip).
  function assign(driverId, orderIds, assignedBy = '', { loads = {}, force = false, note = '' } = {}) {
    const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
    if (!driver) throw httpError('Driver not found', 404);
    if (!driver.active) throw httpError('Driver is deactivated', 400);
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      throw httpError('At least one order is required', 400);
    }

    // Validate everything first so assignment is all-or-nothing
    for (const orderId of orderIds) {
      const order = store.getOrder(orderId);
      if (!order) throw httpError('Order not found: ' + orderId, 404);
      if (['cancelled', 'returned', 'delivered'].includes(order.status)) {
        throw httpError(`Order ${orderId} is '${order.status}' — cannot assign for delivery`, 400);
      }
      const existing = activeDeliveryForOrder(orderId);
      if (existing) {
        throw httpError(`Order ${orderId} already has an active delivery (${existing.id})`, 409);
      }
    }

    // ── capacity check ────────────────────────────────────────────────────────
    const num = v => { const n = +v; return Number.isFinite(n) && n > 0 ? n : 0; };
    const adding = { m3: 0, kg: 0, pallets: 0 };
    for (const orderId of orderIds) {
      const l = loads[orderId] || {};
      adding.m3 += num(l.m3); adding.kg += num(l.kg); adding.pallets += num(l.pallets);
    }
    const current = activeLoad(driverId);
    const over = [];
    for (const [dim, capCol, unit] of [['m3', 'capacity_m3', 'm³'], ['kg', 'capacity_kg', 'kg'], ['pallets', 'capacity_pallets', 'pallets']]) {
      const capV = driver[capCol];
      if (capV > 0 && current[dim] + adding[dim] > capV + 1e-9) {
        over.push(`${unit}: ${(current[dim] + adding[dim]).toFixed(1)} of ${capV} (already carrying ${current[dim].toFixed(1)}, adding ${adding[dim].toFixed(1)})`);
      }
    }
    if (over.length && !force) {
      const err = httpError(`Load exceeds ${driver.name}'s truck capacity — ` + over.join('; '), 409);
      err.capacityExceeded = true;
      throw err;
    }

    const created = [];
    const insert = db.prepare(
      `INSERT INTO deliveries (id, order_id, driver_id, assigned_by, load_m3, load_kg, load_pallets, assign_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      for (const orderId of orderIds) {
        const id = shortId('DLV');
        const l = loads[orderId] || {};
        insert.run(id, orderId, driverId, assignedBy,
          num(l.m3) || null, num(l.kg) || null, num(l.pallets) || null,
          String(note || '').trim() || null);
        const order = store.getOrder(orderId);
        store.updateSource(orderId, {
          deliveryId: id,
          driverId,
          driverName: driver.name,
          driverAssignedAt: new Date().toISOString(),
          ...((order.source || {}).trackingCode ? {} : { trackingCode: newTrackingCode() }),
          ...(num(l.m3) ? { loadM3: num(l.m3) } : {}),
          ...(num(l.kg) ? { loadKg: num(l.kg) } : {}),
          ...(num(l.pallets) ? { loadPallets: num(l.pallets) } : {}),
        });
        created.push(id);
      }
    });
    tx();
    return created.map(getDelivery);
  }

  function listDeliveries({ driverId, status, activeOnly, limit = 200 } = {}) {
    const where = [], params = [];
    if (driverId) { where.push('driver_id = ?'); params.push(driverId); }
    if (status)   { where.push('status = ?');    params.push(status); }
    if (activeOnly) where.push("status IN ('assigned','picked_up','in_transit')");
    const sql = 'SELECT * FROM deliveries'
      + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ' ORDER BY assigned_at DESC LIMIT ?';
    params.push(Math.min(Number(limit) || 200, 500));
    return db.prepare(sql).all(...params).map(enrichDelivery);
  }

  // Advance a delivery through its lifecycle, syncing the order status:
  //   picked_up / in_transit → order 'shipped'   (package left with driver)
  //   delivered              → order 'delivered' (+ proof-of-delivery fragment)
  //   failed                 → order keeps status, failure noted on source
  // POD media arrives as data-URL strings from the driver app; cap sizes so a
  // hostile or buggy client can't balloon the DB (signature ~10s of KB,
  // downscaled photo a few hundred KB).
  function cleanImage(v, maxLen) {
    if (typeof v !== 'string' || !v.startsWith('data:image/')) return null;
    if (v.length > maxLen) throw httpError('Image too large — please retry', 400);
    return v;
  }

  function updateStatus(deliveryId, newStatus, {
    driverId = null, reason = '', podName = '', podNote = '', lat = null, lng = null,
    podSignature = null, podPhoto = null,
  } = {}) {
    const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);
    if (!delivery) throw httpError('Delivery not found', 404);
    if (driverId && delivery.driver_id !== driverId) {
      throw httpError('This delivery belongs to another driver', 403);
    }

    const retry = delivery.status === 'failed' && newStatus === 'assigned' && !driverId;
    if (!retry && !TRANSITIONS[delivery.status]?.has(newStatus)) {
      throw httpError(`Cannot move delivery from '${delivery.status}' to '${newStatus}'`, 400);
    }
    if (newStatus === 'failed' && !String(reason).trim()) {
      throw httpError('A reason is required when marking a delivery failed', 400);
    }

    const now = new Date().toISOString();
    const sets = ['status = ?'];
    const params = [newStatus];
    if (newStatus === 'picked_up')  { sets.push("picked_up_at = datetime('now')"); }
    if (newStatus === 'in_transit') {
      sets.push("in_transit_at = datetime('now')");
      if (!delivery.picked_up_at) sets.push("picked_up_at = datetime('now')");
    }
    if (newStatus === 'delivered') {
      sets.push("delivered_at = datetime('now')", 'pod_name = ?', 'pod_note = ?', 'pod_lat = ?', 'pod_lng = ?',
        'pod_signature = ?', 'pod_photo = ?');
      params.push(String(podName || '').trim(), String(podNote || '').trim(),
        Number.isFinite(+lat) && lat !== null ? +lat : null,
        Number.isFinite(+lng) && lng !== null ? +lng : null,
        cleanImage(podSignature, 300 * 1024),
        cleanImage(podPhoto, 3 * 1024 * 1024));
    }
    if (newStatus === 'failed') {
      sets.push("failed_at = datetime('now')", 'failed_reason = ?');
      params.push(String(reason).trim());
    }
    if (retry) {
      sets.push('failed_at = NULL', "failed_reason = ''", "assigned_at = datetime('now')");
    }
    params.push(deliveryId);
    db.prepare(`UPDATE deliveries SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    // ── sync the order ────────────────────────────────────────────────────────
    const order = store.getOrder(delivery.order_id);
    if (order) {
      // Re-stamp the delivery link on every write — the order's source may have
      // been recreated (e.g. re-imported) since assignment.
      const drv = getDriver(delivery.driver_id);
      const link = { deliveryId: delivery.id, driverId: delivery.driver_id, driverName: drv ? drv.name : '' };
      if ((newStatus === 'picked_up' || newStatus === 'in_transit')
          && !['shipped', 'delivered'].includes(order.status)) {
        store.updateStatusAndSource(order.id, 'shipped', { ...link, outForDeliveryAt: now });
      } else if (newStatus === 'delivered' && order.status !== 'delivered') {
        store.updateStatusAndSource(order.id, 'delivered', {
          ...link,
          deliveredAt: now,
          podName: String(podName || '').trim(),
        });
      } else if (newStatus === 'failed') {
        store.updateSource(order.id, { ...link, deliveryFailedAt: now, deliveryFailedReason: String(reason).trim() });
      }
    }

    return getDelivery(deliveryId);
  }

  function unassign(deliveryId) {
    const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);
    if (!delivery) throw httpError('Delivery not found', 404);
    if (delivery.status === 'delivered') throw httpError('Cannot remove a completed delivery', 400);
    db.prepare('DELETE FROM deliveries WHERE id = ?').run(deliveryId);
    store.updateSource(delivery.order_id, {
      deliveryId: null, driverId: null, driverName: null,
    });
  }

  // ── locations ──────────────────────────────────────────────────────────────

  function recordLocation(driverId, { lat, lng, accuracy = null, speed = null, heading = null } = {}) {
    lat = +lat; lng = +lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw httpError('Valid lat/lng required', 400);
    }
    const num = v => (v == null || !Number.isFinite(+v)) ? null : +v;
    db.prepare(
      'INSERT INTO driver_locations (driver_id, lat, lng, accuracy, speed, heading) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(driverId, lat, lng, num(accuracy), num(speed), num(heading));
    // prune history
    db.prepare(
      `DELETE FROM driver_locations WHERE driver_id = ? AND id NOT IN (
         SELECT id FROM driver_locations WHERE driver_id = ? ORDER BY id DESC LIMIT ?)`
    ).run(driverId, driverId, LOCATION_HISTORY_LIMIT);
  }

  function latestLocations() {
    return db.prepare(
      `SELECT l.driver_id, l.lat, l.lng, l.accuracy, l.speed, l.heading, l.at,
              d.name, d.vehicle, d.plate, d.active,
              (SELECT COUNT(*) FROM deliveries dv
                WHERE dv.driver_id = d.id AND dv.status IN ('assigned','picked_up','in_transit')) AS activeDeliveries
       FROM driver_locations l
       JOIN (SELECT driver_id, MAX(id) AS max_id FROM driver_locations GROUP BY driver_id) last
         ON last.max_id = l.id
       JOIN drivers d ON d.id = l.driver_id
       ORDER BY l.at DESC`
    ).all();
  }

  function getRoute(driverId, limit = 50) {
    return db.prepare(
      'SELECT lat, lng, accuracy, speed, heading, at FROM driver_locations WHERE driver_id = ? ORDER BY id DESC LIMIT ?'
    ).all(driverId, Math.min(Number(limit) || 50, LOCATION_HISTORY_LIMIT)).reverse();
  }

  // ── route planning ─────────────────────────────────────────────────────────

  const EARTH_KM = 6371;
  function haversineKm(a, b) {
    const rad = x => x * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2
      + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.sqrt(s));
  }

  // Nearest-neighbour tour from `start`, improved with 2-opt passes.
  function optimizeOrder(start, points) {
    if (points.length <= 1) return points.slice();
    const remaining = points.slice();
    const tour = [];
    let cur = start;
    while (remaining.length) {
      let bi = 0, bd = Infinity;
      remaining.forEach((p, i) => { const d = haversineKm(cur, p); if (d < bd) { bd = d; bi = i; } });
      cur = remaining.splice(bi, 1)[0];
      tour.push(cur);
    }
    const tourKm = t => t.reduce((s, p, i) => s + haversineKm(i ? t[i - 1] : start, p), 0);
    let improved = true, guard = 0;
    while (improved && guard++ < 25) {
      improved = false;
      for (let i = 0; i < tour.length - 1; i++) {
        for (let j = i + 1; j < tour.length; j++) {
          const cand = tour.slice(0, i).concat(tour.slice(i, j + 1).reverse(), tour.slice(j + 1));
          if (tourKm(cand) + 1e-9 < tourKm(tour)) { tour.splice(0, tour.length, ...cand); improved = true; }
        }
      }
    }
    return tour;
  }

  async function geocodeDelivery(row) {
    if (row.dest_lat != null && row.dest_lng != null) return true;
    if (!geocoder) return false;
    const o = orderSummary(row.order_id);
    if (!o || !o.address) return false;
    const hit = await geocoder.geocode(o.address);
    if (!hit) return false;
    db.prepare('UPDATE deliveries SET dest_lat = ?, dest_lng = ? WHERE id = ?').run(hit.lat, hit.lng, row.id);
    row.dest_lat = hit.lat; row.dest_lng = hit.lng;
    return true;
  }

  // Plan the visiting order for a driver's active jobs. Distances are
  // straight-line estimates; ETA assumes ~25 km/h urban average + 6 min/stop.
  // When the driver's schedule is FIXED, the dispatcher-defined order is kept:
  // only brand-new (unsequenced) stops are spliced in at their cheapest
  // position, and nothing else moves. force=true re-optimizes from scratch
  // and clears the fixed flag (the explicit "amend" action).
  async function planRoute(driverId, { startLat = null, startLng = null, force = false } = {}) {
    const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
    if (!driver) throw httpError('Driver not found', 404);
    const rows = db.prepare(
      "SELECT * FROM deliveries WHERE driver_id = ? AND status IN ('assigned','picked_up','in_transit') ORDER BY assigned_at"
    ).all(driverId);
    if (!rows.length) throw httpError('Driver has no active deliveries to route', 400);

    for (const row of rows) await geocodeDelivery(row);
    const located = rows.filter(r => r.dest_lat != null && r.dest_lng != null)
      .map(r => ({ ...r, lat: r.dest_lat, lng: r.dest_lng }));
    const unlocated = rows.filter(r => r.dest_lat == null || r.dest_lng == null);

    // start point: explicit → driver's latest GPS ping → first located stop
    let start = null, startSource = null;
    if (Number.isFinite(+startLat) && Number.isFinite(+startLng) && startLat !== null) {
      start = { lat: +startLat, lng: +startLng }; startSource = 'manual';
    } else {
      const ping = db.prepare('SELECT lat, lng FROM driver_locations WHERE driver_id = ? ORDER BY id DESC LIMIT 1').get(driverId);
      if (ping) { start = { lat: ping.lat, lng: ping.lng }; startSource = 'driver_gps'; }
      else if (located.length) { start = { lat: located[0].lat, lng: located[0].lng }; startSource = 'first_stop'; }
    }

    const isFixed = !!driver.route_fixed && !force;
    let ordered;
    if (isFixed) {
      ordered = located.filter(r => r.stop_seq != null).sort((a, b) => a.stop_seq - b.stop_seq);
      const newcomers = located.filter(r => r.stop_seq == null);
      for (const nc of newcomers) {
        let best = Infinity, bestI = ordered.length;
        for (let i = 0; i <= ordered.length; i++) {
          const prev = i === 0 ? start : ordered[i - 1];
          const next = ordered[i] || null;
          if (!prev && !next) continue;
          const d = prev && next ? haversineKm(prev, nc) + haversineKm(nc, next) - haversineKm(prev, next)
            : prev ? haversineKm(prev, nc) : haversineKm(nc, next);
          if (d < best) { best = d; bestI = i; }
        }
        ordered.splice(bestI, 0, nc);
      }
    } else {
      ordered = start ? optimizeOrder(start, located) : located;
      if (force && driver.route_fixed) {
        db.prepare('UPDATE drivers SET route_fixed = 0 WHERE id = ?').run(driverId);
      }
    }

    // persist the optimized sequence (unlocated stops keep tail positions)
    const setSeq = db.prepare('UPDATE deliveries SET stop_seq = ? WHERE id = ?');
    const tx = db.transaction(() => {
      ordered.forEach((r, i) => setSeq.run(i + 1, r.id));
      unlocated.forEach((r, i) => setSeq.run(ordered.length + i + 1, r.id));
    });
    tx();

    let totalKm = 0, prev = start;
    const stops = ordered.map((r, i) => {
      const legKm = prev ? haversineKm(prev, r) : 0;
      totalKm += legKm;
      prev = { lat: r.lat, lng: r.lng };
      const o = orderSummary(r.order_id) || {};
      return {
        seq: i + 1, deliveryId: r.id, orderId: r.order_id, status: r.status,
        lat: r.lat, lng: r.lng, legKm: +legKm.toFixed(2),
        recipient: o.recipient || '', address: o.address || '',
      };
    });
    const estMin = Math.round(totalKm / 25 * 60 + stops.length * 6);

    return {
      driverId, driverName: driver.name,
      fixed: isFixed,
      start: start ? { ...start, source: startSource } : null,
      stops,
      unlocated: unlocated.map(r => {
        const o = orderSummary(r.order_id) || {};
        return { deliveryId: r.id, orderId: r.order_id, address: o.address || '', seq: ordered.length + unlocated.indexOf(r) + 1 };
      }),
      totalKm: +totalKm.toFixed(1),
      estMin,
      note: 'Distances are straight-line estimates; sequence optimized with nearest-neighbour + 2-opt.',
    };
  }

  // Save a dispatcher-defined stop order as the driver's FIXED schedule.
  // It stays exactly as entered until the user amends it (manual re-save or a
  // forced re-optimize). Active deliveries not listed keep their tail order.
  function setRouteOrder(driverId, deliveryIds) {
    const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
    if (!driver) throw httpError('Driver not found', 404);
    if (!Array.isArray(deliveryIds) || !deliveryIds.length) {
      throw httpError('deliveryIds array is required', 400);
    }
    const active = db.prepare(
      "SELECT id FROM deliveries WHERE driver_id = ? AND status IN ('assigned','picked_up','in_transit') ORDER BY COALESCE(stop_seq, 999), assigned_at"
    ).all(driverId).map(r => r.id);
    const activeSet = new Set(active);
    for (const id of deliveryIds) {
      if (!activeSet.has(id)) throw httpError(`Delivery ${id} is not an active job of this driver`, 400);
    }
    const rest = active.filter(id => !deliveryIds.includes(id));
    const finalOrder = [...deliveryIds, ...rest];
    const setSeq = db.prepare('UPDATE deliveries SET stop_seq = ? WHERE id = ?');
    const tx = db.transaction(() => {
      finalOrder.forEach((id, i) => setSeq.run(i + 1, id));
      db.prepare('UPDATE drivers SET route_fixed = 1 WHERE id = ?').run(driverId);
    });
    tx();
  }

  // Mid-schedule insertion: for a new order, evaluate every active driver's
  // current route and find the cheapest place to slot the job in. Returns
  // candidates ranked by marginal cost, each with an on-paper justification
  // (detour km, added minutes, position in the run, remaining capacity).
  async function suggestInsertion(orderId) {
    const order = store.getOrder(orderId);
    if (!order) throw httpError('Order not found', 404);
    if (activeDeliveryForOrder(orderId)) throw httpError('Order already has an active delivery', 409);

    const s = order.shipping || {};
    const address = [s.addressLine1, s.addressLine2, s.city, s.state, s.zip, s.country].filter(Boolean).join(', ');
    const point = geocoder ? await geocoder.geocode(address) : null;

    const src = order.source || {};
    const jobLoad = { m3: +src.loadM3 || 0, kg: +src.loadKg || 0, pallets: +src.loadPallets || 0 };

    const drivers = db.prepare('SELECT * FROM drivers WHERE active = 1').all();
    const candidates = [];
    for (const drv of drivers) {
      const stops = db.prepare(
        `SELECT * FROM deliveries WHERE driver_id = ? AND status IN ('assigned','picked_up','in_transit')
         ORDER BY COALESCE(stop_seq, 999), assigned_at`
      ).all(drv.id);
      const ping = db.prepare('SELECT lat, lng FROM driver_locations WHERE driver_id = ? ORDER BY id DESC LIMIT 1').get(drv.id);

      // capacity headroom (dimensions the truck defines)
      const cur = activeLoad(drv.id);
      const capOk = [];
      let fits = true;
      for (const [dim, capCol, unit] of [['m3', 'capacity_m3', 'm³'], ['kg', 'capacity_kg', 'kg'], ['pallets', 'capacity_pallets', 'plt']]) {
        const capV = drv[capCol];
        if (capV > 0) {
          const after = cur[dim] + jobLoad[dim];
          if (after > capV + 1e-9) fits = false;
          capOk.push(`${(+after.toFixed(1))}/${capV} ${unit}`);
        }
      }

      // cheapest insertion into the existing run
      let detourKm = null, insertAt = stops.length + 1, noFix = false;
      const located = stops.filter(r => r.dest_lat != null && r.dest_lng != null)
        .map(r => ({ lat: r.dest_lat, lng: r.dest_lng }));
      if (point) {
        const route = [];
        if (ping) route.push({ lat: ping.lat, lng: ping.lng });
        route.push(...located);
        if (route.length === 0) {
          insertAt = 1; noFix = true;                 // idle, never pinged — distance honestly unknown
        } else if (route.length === 1) {
          detourKm = haversineKm(route[0], point); insertAt = stops.length + 1;
        } else {
          let best = Infinity, bestI = route.length;
          for (let i = 1; i <= route.length; i++) {
            const prev = route[i - 1], next = route[i] || null;
            const d = next
              ? haversineKm(prev, point) + haversineKm(point, next) - haversineKm(prev, next)
              : haversineKm(prev, point);              // append at the end
            if (d < best) { best = d; bestI = i; }
          }
          detourKm = best;
          insertAt = ping ? bestI : bestI + 1;         // position among stops (1-based)
          if (insertAt > stops.length + 1) insertAt = stops.length + 1;
        }
      }
      const addedMin = detourKm != null ? Math.round(detourKm / 25 * 60 + 6) : null;

      const parts = [];
      parts.push(stops.length ? `currently ${stops.length} stop(s) in the run` : 'currently idle');
      if (detourKm != null) parts.push(`insert as stop ${insertAt}: +${detourKm.toFixed(1)} km detour, ~+${addedMin} min incl. handover`);
      else if (noFix) parts.push('no GPS position yet — travel distance not evaluated');
      else parts.push('destination not locatable — distance not evaluated');
      if (capOk.length) parts.push(`truck after job: ${capOk.join(', ')}${fits ? '' : ' — OVER CAPACITY'}`);

      candidates.push({
        driverId: drv.id, driverName: drv.name,
        vehicle: [drv.vehicle, drv.plate].filter(Boolean).join(' · '),
        activeStops: stops.length,
        insertAt, detourKm: detourKm != null ? +detourKm.toFixed(2) : null, addedMin,
        capacityFits: fits, capacityAfter: capOk.join(', ') || null,
        hasGps: !!ping,
        justification: parts.join('; '),
      });
    }

    // rank: capacity fit first, then lowest detour (unknown detour last), then lightest workload
    candidates.sort((a, b) =>
      (b.capacityFits - a.capacityFits)
      || ((a.detourKm ?? 1e9) - (b.detourKm ?? 1e9))
      || (a.activeStops - b.activeStops));

    return {
      orderId: order.id,
      address,
      located: !!point,
      jobLoad,
      candidates,
    };
  }

  // ── stats / tracking ───────────────────────────────────────────────────────

  function stats() {
    const one = sql => db.prepare(sql).get().n;
    return {
      drivers:        one('SELECT COUNT(*) AS n FROM drivers'),
      activeDrivers:  one('SELECT COUNT(*) AS n FROM drivers WHERE active = 1'),
      out:            one("SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('assigned','picked_up','in_transit')"),
      deliveredToday: one("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'delivered' AND date(delivered_at) = date('now')"),
      failedToday:    one("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'failed' AND date(failed_at) = date('now')"),
    };
  }

  // Public order tracking — safe subset only (no customer address/phone,
  // no exact courier position beyond "out for delivery").
  // Accepts a tracking number (IDL-XXXX-XXXXX, the customer-facing reference)
  // or an exact order id.
  function track(ref) {
    ref = String(ref || '').trim();
    let order = null;
    if (/^IDL-/i.test(ref)) {
      // tracking-number lookup: orders.source is JSON text — scan for the code
      const found = db.prepare('SELECT id FROM orders WHERE source LIKE ? LIMIT 1')
        .get('%"trackingCode":"' + ref.toUpperCase() + '"%');
      if (found) order = store.getOrder(found.id);
    } else {
      order = store.getOrder(ref);
    }
    if (!order) return null;
    const delivery = db.prepare(
      'SELECT * FROM deliveries WHERE order_id = ? ORDER BY assigned_at DESC LIMIT 1'
    ).get(order.id);
    const driver = delivery ? getDriver(delivery.driver_id) : null;
    return {
      orderId: order.id,
      trackingCode: (order.source || {}).trackingCode || null,
      orderStatus: order.status,
      orderDate: order.orderDate,
      channel: order.channel,
      delivery: delivery ? {
        status:       delivery.status,
        assignedAt:   delivery.assigned_at,
        pickedUpAt:   delivery.picked_up_at,
        inTransitAt:  delivery.in_transit_at,
        deliveredAt:  delivery.delivered_at,
        failedAt:     delivery.failed_at,
        failedReason: delivery.failed_reason,
        podName:      delivery.pod_name,
        driver: driver ? {
          firstName: driver.name.split(/\s+/)[0],
          vehicle: driver.vehicle,
          plate: driver.plate,
        } : null,
      } : null,
    };
  }

  return {
    listDrivers, getDriver, createDriver, updateDriver, deleteDriver,
    login, validateToken, revokeToken,
    assign, listDeliveries, getDelivery, getDeliveryFull, updateStatus, unassign,
    recordLocation, latestLocations, getRoute,
    planRoute, setRouteOrder, suggestInsertion, ensureTrackingCode,
    stats, track,
    ACTIVE_STATUSES, TERMINAL_STATUSES,
  };
};
