'use strict';

// Wave picking, ported from IDEALPICK (branch claude/idealpick-subfunction-8kdzj1,
// lib/pick.js) onto the per-client warehouse schema: the flat single-location
// "inventory" table becomes inventory_items + inventory_stock (multi-location),
// and orders are no longer local — they live in the tenant's shared orders
// table, reached via `ordersApi` (bound to one client's orders).

const crypto = require('crypto');

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

module.exports = function createPicking(db, ordersApi) {
  function nextWaveNumber() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM pick_waves WHERE wave_number LIKE ?').get(`W${today}%`);
    return `W${today}-${String(n + 1).padStart(3, '0')}`;
  }

  function nextThuCode() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM pick_waves WHERE thu_code LIKE ?").get(`THU${today}%`);
    return `THU${today}${String(n + 1).padStart(4, '0')}`;
  }

  // ── Item / stock helpers (multi-location aware) ─────────────────────────────

  function _itemBySku(sku) {
    return db.prepare('SELECT * FROM inventory_items WHERE sku = ?').get(sku);
  }

  function _qtyAvailable(itemId) {
    const r = db.prepare('SELECT SUM(quantity) AS qty, SUM(reserved_quantity) AS reserved FROM inventory_stock WHERE item_id = ?').get(itemId);
    return Math.max(0, (r.qty || 0) - (r.reserved || 0));
  }

  function _primaryLocation(itemId) {
    return db.prepare(`
      SELECT s.location_id, l.code, (s.quantity - s.reserved_quantity) AS available
      FROM inventory_stock s JOIN facility_locations l ON l.id = s.location_id
      WHERE s.item_id = ? ORDER BY available DESC LIMIT 1
    `).get(itemId);
  }

  function _receivedAtRange(itemId) {
    const r = db.prepare(`
      SELECT MIN(created_at) AS earliest, MAX(created_at) AS latest
      FROM inventory_moves WHERE item_id = ? AND move_type = 'receive'
    `).get(itemId);
    return { earliest: r.earliest || '', latest: r.latest || '' };
  }

  // Reserves qty across as many locations as needed (most-available first) and
  // records exactly what was reserved from where, so it can be released or
  // consumed deterministically later.
  function _reserveAcrossLocations(taskId, itemId, qty) {
    const locations = db.prepare(`
      SELECT location_id, (quantity - reserved_quantity) AS available
      FROM inventory_stock WHERE item_id = ? AND (quantity - reserved_quantity) > 0
      ORDER BY available DESC
    `).all(itemId);

    let remaining = qty;
    for (const loc of locations) {
      if (remaining <= 0) break;
      const take = Math.min(loc.available, remaining);
      db.prepare(`
        UPDATE inventory_stock SET reserved_quantity = reserved_quantity + ?, updated_at = datetime('now')
        WHERE item_id = ? AND location_id = ?
      `).run(take, itemId, loc.location_id);
      db.prepare(`
        INSERT INTO pick_task_reservations (id, task_id, location_id, quantity) VALUES (?, ?, ?, ?)
      `).run(newId('rsv'), taskId, loc.location_id, take);
      remaining -= take;
    }
    if (remaining > 0.0001) throw new Error('Insufficient stock to reserve');
  }

  // Releases a task's full reservation without consuming any stock (skip / cancel).
  function _releaseTaskReservations(taskId) {
    const rows = db.prepare('SELECT * FROM pick_task_reservations WHERE task_id = ?').all(taskId);
    for (const r of rows) {
      db.prepare(`
        UPDATE inventory_stock SET reserved_quantity = MAX(0, reserved_quantity - ?), updated_at = datetime('now')
        WHERE item_id = (SELECT item_id FROM pick_tasks WHERE id = ?) AND location_id = ?
      `).run(r.quantity, taskId, r.location_id);
    }
    db.prepare('DELETE FROM pick_task_reservations WHERE task_id = ?').run(taskId);
  }

  // Settles a task's reservation on wave completion: consumes `pickedQty` worth
  // of stock (in the order it was reserved) and releases anything left over.
  function _settleTaskReservations(task, pickedQty) {
    const rows = db.prepare('SELECT * FROM pick_task_reservations WHERE task_id = ?').all(task.id);
    let remaining = Math.max(0, pickedQty);
    for (const r of rows) {
      const consume = Math.min(r.quantity, remaining);
      remaining -= consume;
      db.prepare(`
        UPDATE inventory_stock SET
          quantity = quantity - ?, reserved_quantity = reserved_quantity - ?, updated_at = datetime('now')
        WHERE item_id = ? AND location_id = ?
      `).run(consume, r.quantity, task.item_id, r.location_id);
      if (consume > 0) {
        db.prepare(`
          INSERT INTO inventory_moves (id, item_id, from_location_id, quantity, move_type, reference, created_by)
          VALUES (?, ?, ?, ?, 'pick', ?, ?)
        `).run(newId('mov'), task.item_id, r.location_id, consume, task.order_id, task.picker_id || '');
      }
    }
    db.prepare('DELETE FROM pick_task_reservations WHERE task_id = ?').run(task.id);
  }

  // ── Availability ─────────────────────────────────────────────────────────────

  function checkAvailability(orderIds) {
    const results = {};
    let allAvailable = true;

    for (const orderId of orderIds) {
      const order = ordersApi.getOrder(orderId);
      if (!order) { results[orderId] = { error: 'Order not found' }; allAvailable = false; continue; }

      const items = order.items.map(line => {
        const item = _itemBySku(line.sku);
        const avail = item ? _qtyAvailable(item.id) : 0;
        const sufficient = avail >= line.qty;
        if (!sufficient) allAvailable = false;
        return {
          sku: line.sku, name: line.name, required: line.qty, available: avail,
          sufficient, shortfall: sufficient ? 0 : line.qty - avail,
          knownSku: !!item,
        };
      });

      results[orderId] = {
        orderId, clientName: order.clientName, channel: order.channel,
        available: items.every(i => i.sufficient), items,
      };
    }

    return { allAvailable, orders: results };
  }

  // ── Wave / task sort strategies ───────────────────────────────────────────────

  function _sortTasks(tasks, strategy) {
    const itemMeta = {};
    for (const t of tasks) {
      if (itemMeta[t.sku]) continue;
      const item = _itemBySku(t.sku);
      const loc = item ? _primaryLocation(item.id) : null;
      itemMeta[t.sku] = { ...(item ? _receivedAtRange(item.id) : { earliest: '', latest: '' }), code: loc ? loc.code : '' };
    }

    if (strategy === 'fifo') {
      return tasks.sort((a, b) =>
        itemMeta[a.sku].earliest.localeCompare(itemMeta[b.sku].earliest) ||
        itemMeta[a.sku].code.localeCompare(itemMeta[b.sku].code));
    }
    if (strategy === 'lifo') {
      return tasks.sort((a, b) =>
        itemMeta[b.sku].latest.localeCompare(itemMeta[a.sku].latest) ||
        itemMeta[a.sku].code.localeCompare(itemMeta[b.sku].code));
    }
    if (strategy === 'batch') {
      return tasks.sort((a, b) =>
        itemMeta[a.sku].code.localeCompare(itemMeta[b.sku].code) || a.sku.localeCompare(b.sku));
    }
    return tasks; // 'wave' — preserve order grouping
  }

  // ── Create wave ────────────────────────────────────────────────────────────

  function createWave({ orderIds, strategy = 'fifo', notes = '', skipUnavailable = false }) {
    if (!Array.isArray(orderIds) || !orderIds.length) throw new Error('orderIds required');
    const allowed = ['fifo', 'lifo', 'wave', 'batch'];
    if (!allowed.includes(strategy)) throw new Error(`Unknown strategy "${strategy}". Use: ${allowed.join(', ')}`);

    const orders = [];
    const skipped = [];
    for (const id of orderIds) {
      const order = ordersApi.getOrder(id);
      if (!order) throw new Error(`Order not found: ${id}`);

      const avail = checkAvailability([id]);
      if (!avail.orders[id].available && !skipUnavailable) {
        const shorts = avail.orders[id].items.filter(i => !i.sufficient)
          .map(i => `${i.sku} (need ${i.required}, have ${i.available})`).join('; ');
        throw new Error(`Insufficient stock for order ${id}: ${shorts}`);
      }
      if (!avail.orders[id].available && skipUnavailable) { skipped.push(id); continue; }
      orders.push(order);
    }
    if (!orders.length) throw new Error('No orders with sufficient stock to pick');

    let rawTasks = [];
    for (const order of orders) {
      for (const line of order.items) {
        const item = _itemBySku(line.sku);
        if (!item) throw new Error(`SKU not found in this warehouse: ${line.sku}`);
        rawTasks.push({ order_id: order.id, item_id: item.id, sku: line.sku, item_name: line.name, qty_required: line.qty });
      }
    }
    rawTasks = _sortTasks(rawTasks, strategy);

    const waveId     = newId('wave');
    const waveNumber = nextWaveNumber();
    const thuCode    = orders.length > 1 ? nextThuCode() : null;

    db.transaction(() => {
      db.prepare(`INSERT INTO pick_waves (id, wave_number, strategy, status, notes, thu_code) VALUES (?, ?, ?, 'open', ?, ?)`)
        .run(waveId, waveNumber, strategy, notes, thuCode);

      for (const t of rawTasks) {
        const taskId = newId('task');
        const primary = _primaryLocation(t.item_id);
        db.prepare(`
          INSERT INTO pick_tasks (id, wave_id, order_id, item_id, sku, item_name, qty_required, location_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(taskId, waveId, t.order_id, t.item_id, t.sku, t.item_name, t.qty_required, primary ? primary.location_id : null);
        _reserveAcrossLocations(taskId, t.item_id, t.qty_required);
      }
    })();

    return { waveId, waveNumber, strategy, thuCode, orderCount: orders.length, taskCount: rawTasks.length, skippedOrders: skipped };
  }

  // ── Wave reads ─────────────────────────────────────────────────────────────

  function listWaves({ status } = {}) {
    let sql = `
      SELECT w.*,
        COUNT(t.id)                                          AS task_count,
        SUM(CASE WHEN t.status='picked' THEN 1 ELSE 0 END)   AS picked_count,
        SUM(CASE WHEN t.status='short'  THEN 1 ELSE 0 END)   AS short_count
      FROM pick_waves w LEFT JOIN pick_tasks t ON t.wave_id = w.id
    `;
    const params = [];
    if (status) { sql += ' WHERE w.status = ?'; params.push(status); }
    sql += ' GROUP BY w.id ORDER BY w.created_at DESC';
    return db.prepare(sql).all(...params);
  }

  function getWave(id) {
    const wave = db.prepare('SELECT * FROM pick_waves WHERE id = ?').get(id);
    if (!wave) return null;
    const tasks = db.prepare(`
      SELECT t.*, l.code AS location_code
      FROM pick_tasks t LEFT JOIN facility_locations l ON l.id = t.location_id
      WHERE t.wave_id = ? ORDER BY t.created_at
    `).all(id);
    return { ...wave, tasks };
  }

  // ── Task update ────────────────────────────────────────────────────────────

  function updateTask(taskId, { qty_picked, status, picker_id }) {
    const task = db.prepare('SELECT * FROM pick_tasks WHERE id = ?').get(taskId);
    if (!task) throw new Error('Task not found');

    const newQty    = qty_picked != null ? qty_picked : task.qty_picked;
    const newStatus = status || (newQty >= task.qty_required ? 'picked' : newQty > 0 ? 'short' : task.status);
    const pickedAt  = (newStatus === 'picked' || newStatus === 'short') && !task.picked_at ? new Date().toISOString() : task.picked_at;

    db.prepare(`UPDATE pick_tasks SET qty_picked=?, status=?, picker_id=COALESCE(?,picker_id), picked_at=? WHERE id=?`)
      .run(newQty, newStatus, picker_id || null, pickedAt, taskId);

    return db.prepare('SELECT * FROM pick_tasks WHERE id = ?').get(taskId);
  }

  // ── Complete / cancel wave ─────────────────────────────────────────────────

  function completeWave(waveId) {
    const wave = db.prepare('SELECT * FROM pick_waves WHERE id = ?').get(waveId);
    if (!wave) throw new Error('Wave not found');
    if (wave.status === 'completed') throw new Error('Wave already completed');
    if (wave.status === 'cancelled') throw new Error('Wave is cancelled');

    const tasks = db.prepare('SELECT * FROM pick_tasks WHERE wave_id = ?').all(waveId);

    db.transaction(() => {
      for (const t of tasks) {
        if (t.status === 'pending') {
          db.prepare(`UPDATE pick_tasks SET status='skipped', picked_at=datetime('now') WHERE id=?`).run(t.id);
          _releaseTaskReservations(t.id);
        } else {
          const picked = Math.min(t.qty_picked, t.qty_required);
          _settleTaskReservations(t, picked);
        }
      }
      db.prepare(`UPDATE pick_waves SET status='completed', completed_at=datetime('now') WHERE id=?`).run(waveId);
    })();

    return getWave(waveId);
  }

  function cancelWave(waveId) {
    const wave = db.prepare('SELECT * FROM pick_waves WHERE id = ?').get(waveId);
    if (!wave) throw new Error('Wave not found');
    if (wave.status === 'completed') throw new Error('Cannot cancel a completed wave');

    const tasks = db.prepare(`SELECT * FROM pick_tasks WHERE wave_id = ? AND status != 'skipped'`).all(waveId);
    db.transaction(() => {
      for (const t of tasks) _releaseTaskReservations(t.id);
      db.prepare(`UPDATE pick_tasks SET status='skipped' WHERE wave_id=?`).run(waveId);
      db.prepare(`UPDATE pick_waves SET status='cancelled', completed_at=datetime('now') WHERE id=?`).run(waveId);
    })();
  }

  // ── Wave mode suggestion ───────────────────────────────────────────────────

  function suggestWaveMode(orderIds) {
    if (!Array.isArray(orderIds) || !orderIds.length) throw new Error('orderIds required');
    const orders = orderIds.map(id => ordersApi.getOrder(id)).filter(Boolean);
    if (!orders.length) throw new Error('No valid orders found');

    if (orders.length === 1) {
      return {
        suggestion: 'single', orderCount: 1, totalLines: orders[0].items.length,
        uniqueSkus: orders[0].items.length, sharedSkus: 0, savedTrips: 0, thuRequired: false,
        reason: 'Single order — picker goes directly to packing station with items',
      };
    }

    const skuCounts = {};
    let totalLines = 0;
    for (const order of orders) {
      for (const line of order.items) { skuCounts[line.sku] = (skuCounts[line.sku] || 0) + 1; totalLines++; }
    }

    const uniqueSkus = Object.keys(skuCounts).length;
    const sharedSkus = Object.values(skuCounts).filter(c => c > 1).length;
    const savedTrips = Object.values(skuCounts).reduce((s, c) => s + (c - 1), 0);
    const overlapPct = uniqueSkus > 0 ? Math.round((sharedSkus / uniqueSkus) * 100) : 0;

    const reason = sharedSkus > 0
      ? `Batch saves ${savedTrips} redundant shelf trip${savedTrips === 1 ? '' : 's'} — ${sharedSkus} SKU${sharedSkus === 1 ? '' : 's'} shared across orders (${overlapPct}% overlap)`
      : `Batch consolidates ${orders.length} pick lists into one run — THU assigned for sort at packing station`;

    return { suggestion: 'batch', orderCount: orders.length, totalLines, uniqueSkus, sharedSkus, savedTrips, overlapPct, thuRequired: true, reason };
  }

  // ── THU manifest ───────────────────────────────────────────────────────────

  function getThuManifest(waveId) {
    const wave = db.prepare('SELECT * FROM pick_waves WHERE id = ?').get(waveId);
    if (!wave) throw new Error('Wave not found');
    if (!wave.thu_code) throw new Error('This wave has no THU — it is a single-order wave');

    const tasks = db.prepare(`SELECT * FROM pick_tasks WHERE wave_id = ? ORDER BY order_id, sku`).all(waveId);
    const orderMap = {};
    for (const t of tasks) {
      if (!orderMap[t.order_id]) {
        const order = ordersApi.getOrder(t.order_id);
        orderMap[t.order_id] = { orderId: t.order_id, clientName: order ? order.clientName : '', shipping: order ? order.shipping : {}, items: [] };
      }
      orderMap[t.order_id].items.push(t);
    }

    return { wave, thuCode: wave.thu_code, orders: Object.values(orderMap), totalItems: tasks.reduce((s, t) => s + t.qty_required, 0) };
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  function getPickStats() {
    const waves = db.prepare('SELECT status, COUNT(*) AS n FROM pick_waves GROUP BY status').all();
    const tasks = db.prepare('SELECT status, COUNT(*) AS n FROM pick_tasks GROUP BY status').all();
    const inv   = db.prepare('SELECT COUNT(*) AS skus, SUM(quantity) AS total_on_hand, SUM(reserved_quantity) AS total_reserved FROM inventory_stock').get();

    const waveMap = {}, taskMap = {};
    for (const r of waves) waveMap[r.status] = r.n;
    for (const r of tasks) taskMap[r.status] = r.n;

    return {
      waves: { open: waveMap.open || 0, in_progress: waveMap.in_progress || 0, completed: waveMap.completed || 0, cancelled: waveMap.cancelled || 0 },
      tasks: { pending: taskMap.pending || 0, picking: taskMap.picking || 0, picked: taskMap.picked || 0, short: taskMap.short || 0, skipped: taskMap.skipped || 0 },
      inventory: { skus: inv.skus || 0, total_on_hand: inv.total_on_hand || 0, total_reserved: inv.total_reserved || 0 },
    };
  }

  return {
    checkAvailability,
    createWave, listWaves, getWave, suggestWaveMode, getThuManifest,
    updateTask, completeWave, cancelWave,
    getPickStats,
  };
};
