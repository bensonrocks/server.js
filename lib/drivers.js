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

module.exports = function createDrivers({ db, store }) {

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
    };
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
    return {
      ...enrichDelivery(row),
      pod_signature: row.pod_signature || null,
      pod_photo: row.pod_photo || null,
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
  function assign(driverId, orderIds, assignedBy = '', { loads = {}, force = false } = {}) {
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
      `INSERT INTO deliveries (id, order_id, driver_id, assigned_by, load_m3, load_kg, load_pallets)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      for (const orderId of orderIds) {
        const id = shortId('DLV');
        const l = loads[orderId] || {};
        insert.run(id, orderId, driverId, assignedBy,
          num(l.m3) || null, num(l.kg) || null, num(l.pallets) || null);
        store.updateSource(orderId, {
          deliveryId: id,
          driverId,
          driverName: driver.name,
          driverAssignedAt: new Date().toISOString(),
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
  function track(orderId) {
    const order = store.getOrder(orderId);
    if (!order) return null;
    const delivery = db.prepare(
      'SELECT * FROM deliveries WHERE order_id = ? ORDER BY assigned_at DESC LIMIT 1'
    ).get(order.id);
    const driver = delivery ? getDriver(delivery.driver_id) : null;
    return {
      orderId: order.id,
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
    stats, track,
    ACTIVE_STATUSES, TERMINAL_STATUSES,
  };
};
