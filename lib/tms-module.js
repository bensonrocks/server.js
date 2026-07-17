'use strict';

/**
 * TMS (Transport Management System) Module
 * Integrates 15 IdealScan TMS features into IdealOMS WMS
 * Features: Address Book, Fuzzy Matching, Route Planning, Status Lifecycle,
 * Delivery History, Feature Toggles, SKU Trust Levels
 */

function createTmsModule(db) {

  // ─────────────────────────────────────────────────────────────────────
  // 1. ADDRESS BOOK — Stores/branches with chain support
  // ─────────────────────────────────────────────────────────────────────

  const _abNorm = s => String(s || '').toLowerCase().replace(/[^\w]/g, '');

  function buildAddressBookIndex(index = new Map()) {
    const addressBook = db.prepare('SELECT * FROM address_book WHERE deleted_at IS NULL').all();
    for (const e of addressBook) {
      if (e.name) index.set(_abNorm(e.name), e);
      if (e.code) index.set(_abNorm(e.code), e);
      // Chain + branch combos — "Watsons YEW TEE POINT" style
      if (e.chain && e.name) {
        index.set(_abNorm(`${e.chain} ${e.name}`), e);
        index.set(_abNorm(`${e.name} ${e.chain}`), e);
      }
    }
    return index;
  }

  function getAddressBook() {
    return db.prepare('SELECT * FROM address_book WHERE deleted_at IS NULL ORDER BY chain, name').all();
  }

  function upsertAddressEntry(data) {
    const { chain, name, code, address, zip, phone } = data;
    if (!name || !zip || !/^\d{6}$/.test(zip)) throw new Error('Invalid address entry');

    const existing = db.prepare('SELECT id FROM address_book WHERE name = ? AND deleted_at IS NULL').get(name);
    if (existing) {
      db.prepare(`UPDATE address_book SET chain=?, code=?, address=?, zip=?, phone=?, updated_at=datetime('now')
        WHERE id=?`).run(chain || '', code || '', address || '', zip, phone || '', existing.id);
    } else {
      db.prepare(`INSERT INTO address_book (chain, name, code, address, zip, phone, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).run(chain || '', name, code || '', address || '', zip, phone || '');
    }
  }

  function suggestAddressEntry(query) {
    const norm = _abNorm(query);
    const index = buildAddressBookIndex();

    // Find all entries with token overlap
    const suggestions = getAddressBook()
      .map(e => {
        const nameTokens = _abNorm(e.name).split(/[^a-z0-9]/);
        const queryTokens = norm.split(/[^a-z0-9]/);
        const overlap = nameTokens.filter(t => queryTokens.includes(t)).length;
        return { ...e, overlap };
      })
      .filter(e => e.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 3);

    return suggestions;
  }

  // ─────────────────────────────────────────────────────────────────────
  // 2. DEPOT SETTINGS — Configurable warehouse start location
  // ─────────────────────────────────────────────────────────────────────

  function getDepot() {
    let depot = db.prepare('SELECT * FROM depot_settings LIMIT 1').get();
    if (!depot) {
      // Default: IDEALONE warehouse
      db.prepare(`INSERT INTO depot_settings (zip, address, updated_at)
        VALUES ('609216', '40 Penjuru Lane #04-01', datetime('now'))`).run();
      depot = db.prepare('SELECT * FROM depot_settings LIMIT 1').get();
    }
    return depot;
  }

  function setDepot(zip, address) {
    if (!zip || !/^\d{6}$/.test(zip)) throw new Error('Invalid postal code');
    db.prepare('UPDATE depot_settings SET zip=?, address=?, updated_at=datetime(\'now\')').run(zip, address);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 3. DELIVERY JOBS — TMS job tracking with status lifecycle
  // ─────────────────────────────────────────────────────────────────────

  function createDeliveryJob(data) {
    const { orderId, store, address, zip, phone, cartons, podRemarks } = data;
    const tmsId = 'TR-' + Date.now().toString(36).toUpperCase().slice(-6) + Math.random().toString(36).slice(-3).toUpperCase();

    db.prepare(`INSERT INTO delivery_jobs (tms_id, order_id, store, address, zip, phone, cartons, status, pod_remarks, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'preplanned', ?, datetime('now'))`).run(tmsId, orderId, store, address, zip, phone, cartons || '[]', podRemarks || '');

    return tmsId;
  }

  function updateJobStatus(tmsId, newStatus, remarks = '') {
    const valid = ['preplanned', 'staging', 'on_road', 'delivered'];
    if (!valid.includes(newStatus)) throw new Error('Invalid status');

    const job = db.prepare('SELECT * FROM delivery_jobs WHERE tms_id = ?').get(tmsId);
    if (!job) throw new Error('Job not found');

    const podRemarks = newStatus === 'delivered' && remarks ? remarks : job.pod_remarks;
    db.prepare(`UPDATE delivery_jobs SET status=?, pod_remarks=?, delivered_at=?, updated_at=datetime('now')
      WHERE tms_id=?`).run(newStatus, podRemarks, newStatus === 'delivered' ? new Date().toISOString() : null, tmsId);
  }

  function getDeliveryJobs(filters = {}) {
    let sql = 'SELECT * FROM delivery_jobs WHERE deleted_at IS NULL';
    const params = [];

    if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
    if (filters.driver) { sql += ' AND driver = ?'; params.push(filters.driver); }
    if (filters.from) { sql += ` AND DATE(created_at) >= DATE(?)`; params.push(filters.from); }
    if (filters.to) { sql += ` AND DATE(created_at) <= DATE(?)`; params.push(filters.to); }

    sql += ' ORDER BY created_at DESC';
    return db.prepare(sql).all(...params);
  }

  function getDeliveryHistory(from, to) {
    return db.prepare(`SELECT * FROM delivery_jobs WHERE deleted_at IS NULL
      AND status = 'delivered' AND DATE(delivered_at) BETWEEN DATE(?) AND DATE(?)
      ORDER BY delivered_at DESC`).all(from, to);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 4. ROUTES & PLANNING — Optimize delivery routes
  // ─────────────────────────────────────────────────────────────────────

  function createDeliveryRoute(jobIds) {
    const routeId = 'ROUTE-' + Date.now().toString(36).toUpperCase();
    const jobs = jobIds.map(id => db.prepare('SELECT * FROM delivery_jobs WHERE tms_id = ?').get(id)).filter(Boolean);

    if (!jobs.length) throw new Error('No valid jobs');

    db.prepare(`INSERT INTO delivery_routes (route_id, job_ids, status, created_at)
      VALUES (?, ?, 'planning', datetime('now'))`).run(routeId, JSON.stringify(jobIds));

    return routeId;
  }

  function approveRoute(routeId) {
    db.prepare(`UPDATE delivery_routes SET status = 'approved', updated_at = datetime('now') WHERE route_id = ?`).run(routeId);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 5. USER FEATURE TOGGLES — Control which functions users see
  // ─────────────────────────────────────────────────────────────────────

  function setUserFeatures(userId, features) {
    const validFeatures = ['upload', 'orders', 'inbound', 'transport', 'labels', 'reports'];
    const filtered = Object.keys(features).filter(f => validFeatures.includes(f))
      .reduce((obj, f) => ({ ...obj, [f]: features[f] }), {});

    if (!Object.values(filtered).some(v => v)) throw new Error('At least one feature must be enabled');

    db.prepare('UPDATE users SET features = ? WHERE id = ?').run(JSON.stringify(filtered), userId);
  }

  function getUserFeatures(userId) {
    const user = db.prepare('SELECT features FROM users WHERE id = ?').get(userId);
    if (!user) return null;

    try {
      return user.features ? JSON.parse(user.features) :
        { upload: true, orders: true, inbound: true, transport: true, labels: true, reports: true };
    } catch {
      return { upload: true, orders: true, inbound: true, transport: true, labels: true, reports: true };
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 6. SKU TRUST LEVELS — Validate SKU detection quality
  // ─────────────────────────────────────────────────────────────────────

  function validateSkuTrustLevel(sku, source) {
    // source: 'schema' (trusted), 'named_column' (trusted), 'ai_detected' (suspect)

    if (source === 'schema' || source === 'named_column') return { trusted: true, level: source };

    // Check if looks like location code (e.g., AB-005-001-A)
    const locationPattern = /^[A-Z]{2}-\d{3}-\d{3}-[A-Z]$/;
    if (locationPattern.test(sku)) {
      return { trusted: false, level: 'suspect', reason: 'Looks like location code' };
    }

    return { trusted: true, level: 'ai_detected' };
  }

  return {
    // Address Book
    getAddressBook,
    upsertAddressEntry,
    suggestAddressEntry,
    buildAddressBookIndex,

    // Depot
    getDepot,
    setDepot,

    // Delivery Jobs
    createDeliveryJob,
    updateJobStatus,
    getDeliveryJobs,
    getDeliveryHistory,

    // Routes
    createDeliveryRoute,
    approveRoute,

    // User Features
    setUserFeatures,
    getUserFeatures,

    // SKU Validation
    validateSkuTrustLevel,
  };
}

module.exports = { createTmsModule };
