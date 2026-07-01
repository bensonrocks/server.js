'use strict';

const { randomUUID } = require('crypto');
const db = require('./db');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS inventory (
    sku          TEXT PRIMARY KEY,
    name         TEXT NOT NULL DEFAULT '',
    qty_on_hand  REAL NOT NULL DEFAULT 0,
    qty_reserved REAL NOT NULL DEFAULT 0,
    location     TEXT DEFAULT '',
    received_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pick_waves (
    id           TEXT PRIMARY KEY,
    wave_number  TEXT NOT NULL,
    strategy     TEXT NOT NULL DEFAULT 'fifo',
    status       TEXT NOT NULL DEFAULT 'open',
    notes        TEXT DEFAULT '',
    thu_code     TEXT DEFAULT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS pick_tasks (
    id           TEXT PRIMARY KEY,
    wave_id      TEXT NOT NULL,
    order_id     TEXT NOT NULL,
    sku          TEXT NOT NULL,
    item_name    TEXT NOT NULL DEFAULT '',
    qty_required REAL NOT NULL DEFAULT 0,
    qty_picked   REAL NOT NULL DEFAULT 0,
    location     TEXT DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'pending',
    picker_id    TEXT DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    picked_at    TEXT DEFAULT NULL,
    FOREIGN KEY (wave_id) REFERENCES pick_waves(id)
  );
`);

// ── Seed inventory to match demo orders ───────────────────────────────────────

const { n: invCount } = db.prepare('SELECT COUNT(*) AS n FROM inventory').get();
if (invCount === 0) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO inventory (sku, name, qty_on_hand, location, received_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const seed = [
    ['WIDGET-BLU',  'Blue Widget',           50, 'A-01-01', '2026-04-01T00:00:00Z'],
    ['CASE-LRG',    'Large Carry Case',       30, 'A-01-02', '2026-04-05T00:00:00Z'],
    ['GADGET-RED',  'Red Gadget Pro',         25, 'B-02-01', '2026-04-10T00:00:00Z'],
    ['DESK-PAD',    'Desk Pad XL',            40, 'B-02-02', '2026-04-08T00:00:00Z'],
    ['HEADPH-PRO',  'Pro Headphones',         20, 'C-03-01', '2026-03-15T00:00:00Z'],
    ['KEYBOARD-MEC','Mechanical Keyboard',    15, 'C-03-02', '2026-03-20T00:00:00Z'],
    ['MOUSE-WRL',   'Wireless Mouse',         35, 'C-03-03', '2026-04-12T00:00:00Z'],
    ['CHARGER-65W', '65W USB-C Charger',      60, 'D-04-01', '2026-04-15T00:00:00Z'],
    ['DRESS-SUM',   'Summer Dress',           18, 'E-05-01', '2026-03-25T00:00:00Z'],
    ['SCARF-SLK',   'Silk Scarf',             22, 'E-05-02', '2026-04-02T00:00:00Z'],
    ['SHIRT-CAS',   'Casual Shirt',           45, 'E-05-03', '2026-04-18T00:00:00Z'],
    ['PANTS-SLM',   'Slim Fit Pants',         28, 'E-05-04', '2026-04-20T00:00:00Z'],
    ['BLENDER-PRO', 'Pro Blender',            12, 'F-06-01', '2026-03-10T00:00:00Z'],
    ['CUTTING-BRD', 'Bamboo Cutting Board',   55, 'F-06-02', '2026-04-22T00:00:00Z'],
    ['KNIFE-SET',   '8-Piece Knife Set',      10, 'F-06-03', '2026-04-05T00:00:00Z'],
    ['TOWEL-SET',   'Bath Towel Set',         32, 'F-06-04', '2026-04-14T00:00:00Z'],
    ['TENT-2P',     '2-Person Tent',           8, 'G-07-01', '2026-03-01T00:00:00Z'],
    ['SLEEPING-BAG','Sleeping Bag -10C',      15, 'G-07-02', '2026-03-05T00:00:00Z'],
    ['BACKPACK-45L','45L Hiking Backpack',    20, 'G-07-03', '2026-03-28T00:00:00Z'],
    ['WATER-BTL',   'Insulated Water Bottle', 75, 'G-07-04', '2026-04-25T00:00:00Z'],
  ];
  db.transaction(rows => rows.forEach(r => ins.run(...r)))(seed);
}

// Migration: add thu_code to existing databases that predate this column
try { db.exec("ALTER TABLE pick_waves ADD COLUMN thu_code TEXT DEFAULT NULL"); } catch (_) {}

// ── Wave number / THU code ────────────────────────────────────────────────────

function nextWaveNumber() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM pick_waves WHERE wave_number LIKE ?`).get(`W${today}%`);
  return `W${today}-${String(n + 1).padStart(3, '0')}`;
}

function nextThuCode() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM pick_waves WHERE thu_code LIKE ?").get(`THU${today}%`);
  return `THU${today}${String(n + 1).padStart(4, '0')}`;
}

// ── Inventory ─────────────────────────────────────────────────────────────────

function listInventory() {
  return db.prepare('SELECT * FROM inventory ORDER BY location, sku').all().map(r => ({
    ...r,
    qty_available: Math.max(0, r.qty_on_hand - r.qty_reserved),
  }));
}

function getInventoryItem(sku) {
  const r = db.prepare('SELECT * FROM inventory WHERE sku = ?').get(sku);
  if (!r) return null;
  return { ...r, qty_available: Math.max(0, r.qty_on_hand - r.qty_reserved) };
}

function upsertInventoryItem({ sku, name, qty_on_hand, location, received_at }) {
  if (!sku) throw new Error('sku is required');
  const existing = db.prepare('SELECT sku FROM inventory WHERE sku = ?').get(sku);
  if (existing) {
    db.prepare(`
      UPDATE inventory SET name=COALESCE(?,name), qty_on_hand=COALESCE(?,qty_on_hand),
        location=COALESCE(?,location), updated_at=datetime('now') WHERE sku=?
    `).run(name || null, qty_on_hand != null ? qty_on_hand : null, location || null, sku);
  } else {
    db.prepare(`
      INSERT INTO inventory (sku, name, qty_on_hand, location, received_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sku, name || sku, qty_on_hand || 0, location || '', received_at || new Date().toISOString());
  }
  return getInventoryItem(sku);
}

function receiveStock(sku, qty, location, received_at) {
  if (!sku || qty <= 0) throw new Error('sku and positive qty required');
  const existing = db.prepare('SELECT sku FROM inventory WHERE sku = ?').get(sku);
  if (!existing) throw new Error(`SKU not found: ${sku}`);
  db.prepare(`
    UPDATE inventory SET qty_on_hand = qty_on_hand + ?,
      location = COALESCE(?, location),
      received_at = COALESCE(?, received_at),
      updated_at = datetime('now')
    WHERE sku = ?
  `).run(qty, location || null, received_at || null, sku);
  return getInventoryItem(sku);
}

function removeInventoryItem(sku) {
  const r = db.prepare('SELECT * FROM inventory WHERE sku = ?').get(sku);
  if (!r) throw new Error(`SKU not found: ${sku}`);
  if (r.qty_reserved > 0) throw new Error(`Cannot remove ${sku} — ${r.qty_reserved} units are reserved`);
  db.prepare('DELETE FROM inventory WHERE sku = ?').run(sku);
}

function _qtyAvailable(sku) {
  const r = db.prepare('SELECT qty_on_hand, qty_reserved FROM inventory WHERE sku = ?').get(sku);
  if (!r) return 0;
  return Math.max(0, r.qty_on_hand - r.qty_reserved);
}

function _reserveStock(sku, qty) {
  db.prepare(`UPDATE inventory SET qty_reserved = qty_reserved + ?, updated_at = datetime('now') WHERE sku = ?`).run(qty, sku);
}

function _releaseStock(sku, qty) {
  db.prepare(`UPDATE inventory SET qty_reserved = MAX(0, qty_reserved - ?), updated_at = datetime('now') WHERE sku = ?`).run(qty, sku);
}

function _consumeStock(sku, qty) {
  db.prepare(`
    UPDATE inventory
    SET qty_on_hand   = MAX(0, qty_on_hand - ?),
        qty_reserved  = MAX(0, qty_reserved - ?),
        updated_at    = datetime('now')
    WHERE sku = ?
  `).run(qty, qty, sku);
}

// ── Market Availability ───────────────────────────────────────────────────────

function checkAvailability(orderIds) {
  const store = require('./store');
  const results = {};
  let allAvailable = true;

  for (const orderId of orderIds) {
    const order = store.getOrder(orderId);
    if (!order) { results[orderId] = { error: 'Order not found' }; allAvailable = false; continue; }

    const items = order.items.map(item => {
      const avail = _qtyAvailable(item.sku);
      const sufficient = avail >= item.qty;
      if (!sufficient) allAvailable = false;
      return {
        sku:       item.sku,
        name:      item.name,
        required:  item.qty,
        available: avail,
        sufficient,
        shortfall: sufficient ? 0 : item.qty - avail,
      };
    });

    results[orderId] = {
      orderId,
      clientName: order.clientName,
      channel:    order.channel,
      available:  items.every(i => i.sufficient),
      items,
    };
  }

  return { allAvailable, orders: results };
}

// ── Wave / Task helpers ───────────────────────────────────────────────────────

function _sortTasks(tasks, strategy) {
  const inv = {};
  const skus = [...new Set(tasks.map(t => t.sku))];
  for (const sku of skus) {
    inv[sku] = db.prepare('SELECT location, received_at FROM inventory WHERE sku = ?').get(sku) || {};
  }

  if (strategy === 'fifo') {
    // oldest inventory first, then by location
    return tasks.sort((a, b) => {
      const ra = inv[a.sku]?.received_at || '';
      const rb = inv[b.sku]?.received_at || '';
      return ra.localeCompare(rb) || (inv[a.sku]?.location || '').localeCompare(inv[b.sku]?.location || '');
    });
  }

  if (strategy === 'lifo') {
    // newest inventory first, then by location
    return tasks.sort((a, b) => {
      const ra = inv[a.sku]?.received_at || '';
      const rb = inv[b.sku]?.received_at || '';
      return rb.localeCompare(ra) || (inv[a.sku]?.location || '').localeCompare(inv[b.sku]?.location || '');
    });
  }

  if (strategy === 'batch') {
    // sort by location then sku — minimises picker travel across orders
    return tasks.sort((a, b) => {
      const la = inv[a.sku]?.location || '';
      const lb = inv[b.sku]?.location || '';
      return la.localeCompare(lb) || a.sku.localeCompare(b.sku);
    });
  }

  // wave: preserve order grouping (tasks stay in order_id order)
  return tasks;
}

// ── Create Wave ───────────────────────────────────────────────────────────────
//
// strategy:
//   fifo  — tasks ordered by inventory received_at ASC (consume oldest stock first)
//   lifo  — tasks ordered by inventory received_at DESC (consume newest stock first)
//   batch — tasks sorted by location/SKU across orders (one picker, minimal travel)
//   wave  — tasks grouped by order, all lines per order together (multi-picker friendly)

function createWave({ orderIds, strategy = 'fifo', notes = '', skipUnavailable = false }) {
  if (!Array.isArray(orderIds) || !orderIds.length) throw new Error('orderIds required');
  const allowed = ['fifo', 'lifo', 'wave', 'batch'];
  if (!allowed.includes(strategy)) throw new Error(`Unknown strategy "${strategy}". Use: ${allowed.join(', ')}`);

  const store = require('./store');

  // Load orders and check availability
  const orders = [];
  const skipped = [];
  for (const id of orderIds) {
    const order = store.getOrder(id);
    if (!order) throw new Error(`Order not found: ${id}`);

    const avail = checkAvailability([id]);
    if (!avail.orders[id].available && !skipUnavailable) {
      const shorts = avail.orders[id].items.filter(i => !i.sufficient)
        .map(i => `${i.sku} (need ${i.required}, have ${i.available})`).join('; ');
      throw new Error(`Insufficient stock for order ${id}: ${shorts}`);
    }
    if (!avail.orders[id].available && skipUnavailable) {
      skipped.push(id);
      continue;
    }
    orders.push(order);
  }

  if (!orders.length) throw new Error('No orders with sufficient stock to pick');

  // Build raw task list — one entry per order line
  let rawTasks = [];
  for (const order of orders) {
    for (const item of order.items) {
      const loc = db.prepare('SELECT location FROM inventory WHERE sku = ?').get(item.sku)?.location || '';
      rawTasks.push({ order_id: order.id, sku: item.sku, item_name: item.name, qty_required: item.qty, location: loc });
    }
  }

  rawTasks = _sortTasks(rawTasks, strategy);

  // Persist wave and tasks inside a transaction
  const waveId     = randomUUID();
  const waveNumber = nextWaveNumber();
  // Any wave covering more than one order gets a THU so picker drops items
  // into a shared tote; the packing station then sorts by order.
  const thuCode = orders.length > 1 ? nextThuCode() : null;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO pick_waves (id, wave_number, strategy, status, notes, thu_code)
      VALUES (?, ?, ?, 'open', ?, ?)
    `).run(waveId, waveNumber, strategy, notes, thuCode);

    const ins = db.prepare(`
      INSERT INTO pick_tasks (id, wave_id, order_id, sku, item_name, qty_required, location)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of rawTasks) {
      ins.run(randomUUID(), waveId, t.order_id, t.sku, t.item_name, t.qty_required, t.location);
      _reserveStock(t.sku, t.qty_required);
    }
  })();

  return { waveId, waveNumber, strategy, thuCode, orderCount: orders.length, taskCount: rawTasks.length, skippedOrders: skipped };
}

// ── Wave reads ────────────────────────────────────────────────────────────────

function listWaves({ status } = {}) {
  let sql = `
    SELECT w.*,
      COUNT(t.id)                                AS task_count,
      SUM(CASE WHEN t.status='picked' THEN 1 ELSE 0 END) AS picked_count,
      SUM(CASE WHEN t.status='short'  THEN 1 ELSE 0 END) AS short_count
    FROM pick_waves w
    LEFT JOIN pick_tasks t ON t.wave_id = w.id
  `;
  const params = [];
  if (status) { sql += ' WHERE w.status = ?'; params.push(status); }
  sql += ' GROUP BY w.id ORDER BY w.created_at DESC';
  return db.prepare(sql).all(...params);
}

function getWave(id) {
  const wave = db.prepare('SELECT * FROM pick_waves WHERE id = ?').get(id);
  if (!wave) return null;
  const tasks = db.prepare('SELECT * FROM pick_tasks WHERE wave_id = ? ORDER BY created_at').all(id);
  return { ...wave, tasks };
}

// ── Task update ───────────────────────────────────────────────────────────────

function updateTask(taskId, { qty_picked, status, picker_id }) {
  const task = db.prepare('SELECT * FROM pick_tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error('Task not found');

  const newQty    = qty_picked != null ? qty_picked : task.qty_picked;
  const newStatus = status || (newQty >= task.qty_required ? 'picked' : newQty > 0 ? 'short' : task.status);
  const pickedAt  = (newStatus === 'picked' || newStatus === 'short') && !task.picked_at ? new Date().toISOString() : task.picked_at;

  db.prepare(`
    UPDATE pick_tasks SET qty_picked=?, status=?, picker_id=COALESCE(?,picker_id), picked_at=? WHERE id=?
  `).run(newQty, newStatus, picker_id || null, pickedAt, taskId);

  return db.prepare('SELECT * FROM pick_tasks WHERE id = ?').get(taskId);
}

// ── Complete wave — consume reserved stock ────────────────────────────────────

function completeWave(waveId) {
  const wave = db.prepare('SELECT * FROM pick_waves WHERE id = ?').get(waveId);
  if (!wave) throw new Error('Wave not found');
  if (wave.status === 'completed') throw new Error('Wave already completed');
  if (wave.status === 'cancelled') throw new Error('Wave is cancelled');

  const tasks = db.prepare('SELECT * FROM pick_tasks WHERE wave_id = ?').all(waveId);

  db.transaction(() => {
    for (const t of tasks) {
      if (t.status === 'pending') {
        // auto-mark remaining as skipped; release their reservation
        db.prepare(`UPDATE pick_tasks SET status='skipped', picked_at=datetime('now') WHERE id=?`).run(t.id);
        _releaseStock(t.sku, t.qty_required);
      } else {
        // consume the actually-picked qty; release the rest
        const picked = Math.min(t.qty_picked, t.qty_required);
        _consumeStock(t.sku, picked);
        if (t.qty_required > picked) _releaseStock(t.sku, t.qty_required - picked);
      }
    }
    db.prepare(`
      UPDATE pick_waves SET status='completed', completed_at=datetime('now') WHERE id=?
    `).run(waveId);
  })();

  return getWave(waveId);
}

// ── Cancel wave — release all reservations ────────────────────────────────────

function cancelWave(waveId) {
  const wave = db.prepare('SELECT * FROM pick_waves WHERE id = ?').get(waveId);
  if (!wave) throw new Error('Wave not found');
  if (wave.status === 'completed') throw new Error('Cannot cancel a completed wave');

  const tasks = db.prepare('SELECT * FROM pick_tasks WHERE wave_id = ? AND status != ?').all(waveId, 'skipped');
  db.transaction(() => {
    for (const t of tasks) _releaseStock(t.sku, t.qty_required);
    db.prepare(`UPDATE pick_tasks SET status='skipped' WHERE wave_id=?`).run(waveId);
    db.prepare(`UPDATE pick_waves SET status='cancelled', completed_at=datetime('now') WHERE id=?`).run(waveId);
  })();
}

// ── Wave mode suggestion ──────────────────────────────────────────────────────

function suggestWaveMode(orderIds) {
  if (!Array.isArray(orderIds) || !orderIds.length) throw new Error('orderIds required');
  const store = require('./store');
  const orders = orderIds.map(id => store.getOrder(id)).filter(Boolean);
  if (!orders.length) throw new Error('No valid orders found');

  if (orders.length === 1) {
    return {
      suggestion: 'single',
      orderCount: 1,
      totalLines: orders[0].items.length,
      uniqueSkus: orders[0].items.length,
      sharedSkus: 0,
      savedTrips: 0,
      thuRequired: false,
      reason: 'Single order — picker goes directly to packing station with items',
    };
  }

  const skuCounts = {};
  let totalLines = 0;
  for (const order of orders) {
    for (const item of order.items) {
      skuCounts[item.sku] = (skuCounts[item.sku] || 0) + 1;
      totalLines++;
    }
  }

  const uniqueSkus  = Object.keys(skuCounts).length;
  const sharedSkus  = Object.values(skuCounts).filter(c => c > 1).length;
  const savedTrips  = Object.values(skuCounts).reduce((s, c) => s + (c - 1), 0);
  const overlapPct  = uniqueSkus > 0 ? Math.round((sharedSkus / uniqueSkus) * 100) : 0;

  const reason = sharedSkus > 0
    ? `Batch saves ${savedTrips} redundant shelf trip${savedTrips === 1 ? '' : 's'} — ${sharedSkus} SKU${sharedSkus === 1 ? '' : 's'} shared across orders (${overlapPct}% overlap)`
    : `Batch consolidates ${orders.length} pick lists into one run — THU assigned for sort at packing station`;

  return { suggestion: 'batch', orderCount: orders.length, totalLines, uniqueSkus, sharedSkus, savedTrips, overlapPct, thuRequired: true, reason };
}

// ── THU manifest (packing station sort guide) ─────────────────────────────────

function getThuManifest(waveId) {
  const wave = db.prepare('SELECT * FROM pick_waves WHERE id = ?').get(waveId);
  if (!wave) throw new Error('Wave not found');
  if (!wave.thu_code) throw new Error('This wave has no THU — it is a single-order wave');

  const tasks = db.prepare(`
    SELECT t.*, o.client_name, o.shipping
    FROM pick_tasks t JOIN orders o ON o.id = t.order_id
    WHERE t.wave_id = ? ORDER BY t.order_id, t.location, t.sku
  `).all(waveId);

  const orderMap = {};
  for (const t of tasks) {
    if (!orderMap[t.order_id]) {
      let shipping = {};
      try { shipping = JSON.parse(t.shipping || '{}'); } catch (_) {}
      orderMap[t.order_id] = { orderId: t.order_id, clientName: t.client_name, shipping, items: [] };
    }
    orderMap[t.order_id].items.push(t);
  }

  return {
    wave,
    thuCode: wave.thu_code,
    orders: Object.values(orderMap),
    totalItems: tasks.reduce((s, t) => s + t.qty_required, 0),
  };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function getPickStats() {
  const waves = db.prepare(`SELECT status, COUNT(*) AS n FROM pick_waves GROUP BY status`).all();
  const tasks  = db.prepare(`SELECT status, COUNT(*) AS n FROM pick_tasks  GROUP BY status`).all();
  const inv    = db.prepare(`SELECT COUNT(*) AS skus, SUM(qty_on_hand) AS total_on_hand, SUM(qty_reserved) AS total_reserved FROM inventory`).get();

  const waveMap = {}, taskMap = {};
  for (const r of waves) waveMap[r.status] = r.n;
  for (const r of tasks)  taskMap[r.status]  = r.n;

  return {
    waves: { open: waveMap.open || 0, in_progress: waveMap.in_progress || 0, completed: waveMap.completed || 0, cancelled: waveMap.cancelled || 0 },
    tasks: { pending: taskMap.pending || 0, picking: taskMap.picking || 0, picked: taskMap.picked || 0, short: taskMap.short || 0, skipped: taskMap.skipped || 0 },
    inventory: { skus: inv.skus || 0, total_on_hand: inv.total_on_hand || 0, total_reserved: inv.total_reserved || 0 },
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  listInventory, getInventoryItem, upsertInventoryItem, receiveStock, removeInventoryItem,
  checkAvailability,
  createWave, listWaves, getWave, suggestWaveMode, getThuManifest,
  updateTask,
  completeWave, cancelWave,
  getPickStats,
};
