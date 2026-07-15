'use strict';

const crypto = require('crypto');

const DEFAULT_CONFIG = {
  featureToggles: { lotTracking: false, barcodeScanning: false, cycleCounts: false },
  terminology:    { facility: 'Warehouse', location: 'Location', item: 'Item' },
  workflowMode:   'both', // 'b2b' | 'b2c' | 'both'
  // Module-level selections — gate whole workflows on/off per client, set by
  // the tenant or staff. inventory/clientVisible default on; the operational
  // workflows default off until a tenant explicitly turns them on for a client.
  modules: {
    inventory:     true,
    picking:       false,
    packShip:      false,
    scanStation:   false,
    clientVisible: true,
  },
};

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

module.exports = function createWarehouse(db) {
  // ── Settings / branding / feature toggles / terminology / workflow mode ────

  function getConfig() {
    const row = db.prepare("SELECT value FROM warehouse_settings WHERE key = 'config'").get();
    if (!row) return { ...DEFAULT_CONFIG, modules: { ...DEFAULT_CONFIG.modules } };
    try {
      const stored = JSON.parse(row.value);
      return {
        featureToggles: { ...DEFAULT_CONFIG.featureToggles, ...(stored.featureToggles || {}) },
        terminology:    { ...DEFAULT_CONFIG.terminology,    ...(stored.terminology    || {}) },
        workflowMode:   stored.workflowMode || DEFAULT_CONFIG.workflowMode,
        modules:        { ...DEFAULT_CONFIG.modules, ...(stored.modules || {}) },
      };
    } catch {
      return { ...DEFAULT_CONFIG, modules: { ...DEFAULT_CONFIG.modules } };
    }
  }

  function updateConfig(patch) {
    const current = getConfig();
    const merged = {
      featureToggles: { ...current.featureToggles, ...(patch.featureToggles || {}) },
      terminology:    { ...current.terminology,    ...(patch.terminology    || {}) },
      workflowMode:   patch.workflowMode || current.workflowMode,
      modules:        { ...current.modules, ...(patch.modules || {}) },
    };
    db.prepare(`
      INSERT INTO warehouse_settings (key, value) VALUES ('config', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(merged));
    return merged;
  }

  // ── Custom field definitions ────────────────────────────────────────────────

  function listCustomFields(entityType) {
    return db.prepare('SELECT * FROM custom_field_defs WHERE entity_type = ? ORDER BY sort_order, label')
      .all(entityType)
      .map(r => ({ ...r, options: JSON.parse(r.options || '[]') }));
  }

  function addCustomField({ entityType, fieldKey, label, fieldType = 'text', options = [], sortOrder = 0 }) {
    if (!entityType || !fieldKey || !label) throw new Error('entityType, fieldKey, and label are required');
    const id = newId('fld');
    db.prepare(`
      INSERT INTO custom_field_defs (id, entity_type, field_key, label, field_type, options, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, entityType, fieldKey, label, fieldType, JSON.stringify(options), sortOrder);
    return { id, entityType, fieldKey, label, fieldType, options, sortOrder };
  }

  function deleteCustomField(id) {
    db.prepare('DELETE FROM custom_field_defs WHERE id = ?').run(id);
  }

  // ── Facilities ───────────────────────────────────────────────────────────────

  function listFacilities({ activeOnly = false } = {}) {
    const sql = activeOnly ? 'SELECT * FROM facilities WHERE active = 1 ORDER BY name' : 'SELECT * FROM facilities ORDER BY name';
    return db.prepare(sql).all();
  }

  function addFacility({ name, address = '' }) {
    if (!name) throw new Error('name is required');
    const id = newId('fac');
    db.prepare('INSERT INTO facilities (id, name, address) VALUES (?, ?, ?)').run(id, name, address);
    return { id, name, address, active: 1 };
  }

  function updateFacility(id, { name, address, active } = {}) {
    const existing = db.prepare('SELECT * FROM facilities WHERE id = ?').get(id);
    if (!existing) throw new Error('Facility not found');
    db.prepare('UPDATE facilities SET name = ?, address = ?, active = ? WHERE id = ?').run(
      name !== undefined ? name : existing.name,
      address !== undefined ? address : existing.address,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      id,
    );
  }

  // ── Locations ────────────────────────────────────────────────────────────────

  function listLocations({ facilityId, activeOnly = false } = {}) {
    let sql = 'SELECT * FROM facility_locations WHERE 1=1';
    const params = [];
    if (facilityId) { sql += ' AND facility_id = ?'; params.push(facilityId); }
    if (activeOnly) sql += ' AND active = 1';
    sql += ' ORDER BY code';
    return db.prepare(sql).all(...params).map(r => ({ ...r, custom_fields: JSON.parse(r.custom_fields || '{}') }));
  }

  function addLocation({ facilityId, code, zone = '', type = 'bin', customFields = {} }) {
    if (!facilityId || !code) throw new Error('facilityId and code are required');
    const facility = db.prepare('SELECT id FROM facilities WHERE id = ?').get(facilityId);
    if (!facility) throw new Error('Facility not found');
    const id = newId('loc');
    db.prepare(`
      INSERT INTO facility_locations (id, facility_id, code, zone, type, custom_fields)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, facilityId, code, zone, type, JSON.stringify(customFields));
    return { id, facilityId, code, zone, type, customFields };
  }

  // ── Inventory items ────────────────────────────────────────────────────────

  function listItems({ search, activeOnly = false } = {}) {
    let sql = 'SELECT * FROM inventory_items WHERE 1=1';
    const params = [];
    if (activeOnly) sql += ' AND active = 1';
    sql += ' ORDER BY name';
    let rows = db.prepare(sql).all(...params).map(r => ({ ...r, custom_fields: JSON.parse(r.custom_fields || '{}') }));
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(i => i.sku.toLowerCase().includes(q) || i.name.toLowerCase().includes(q));
    }
    return rows;
  }

  function getItem(idOrSku) {
    const row = db.prepare('SELECT * FROM inventory_items WHERE id = ? OR sku = ?').get(idOrSku, idOrSku);
    return row ? { ...row, custom_fields: JSON.parse(row.custom_fields || '{}') } : null;
  }

  function addItem({ sku, name, description = '', uom = 'unit', customFields = {}, reorderPoint = 0, reorderQty = 0, unitCost = 0, lengthCm = 0, widthCm = 0, heightCm = 0, weightKg = 0 }) {
    if (!sku || !name) throw new Error('sku and name are required');
    const id = newId('item');
    try {
      db.prepare(`
        INSERT INTO inventory_items (id, sku, name, description, uom, custom_fields, reorder_point, reorder_qty, unit_cost, length_cm, width_cm, height_cm, weight_kg)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, sku, name, description, uom, JSON.stringify(customFields), reorderPoint, reorderQty, unitCost, lengthCm, widthCm, heightCm, weightKg);
    } catch (e) {
      throw new Error(e.message.includes('UNIQUE') ? `SKU ${sku} already exists` : e.message);
    }
    return { id, sku, name, description, uom, customFields, reorderPoint, reorderQty, unitCost, lengthCm, widthCm, heightCm, weightKg };
  }

  function updateItem(id, { name, description, reorderPoint, reorderQty, active, lengthCm, widthCm, heightCm, weightKg } = {}) {
    const existing = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
    if (!existing) throw new Error('Item not found');
    db.prepare(`
      UPDATE inventory_items SET
        name = ?, description = ?, reorder_point = ?, reorder_qty = ?, active = ?,
        length_cm = ?, width_cm = ?, height_cm = ?, weight_kg = ?
      WHERE id = ?
    `).run(
      name !== undefined ? name : existing.name,
      description !== undefined ? description : existing.description,
      reorderPoint !== undefined ? reorderPoint : existing.reorder_point,
      reorderQty !== undefined ? reorderQty : existing.reorder_qty,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      lengthCm !== undefined ? lengthCm : existing.length_cm,
      widthCm !== undefined ? widthCm : existing.width_cm,
      heightCm !== undefined ? heightCm : existing.height_cm,
      weightKg !== undefined ? weightKg : existing.weight_kg,
      id,
    );
    return getItem(id);
  }

  // Items whose available qty (on hand minus reserved, summed across all
  // locations) has fallen below their reorder point. reorder_point = 0 means
  // "not tracked" and is excluded, not treated as "always low."
  function getLowStock() {
    return db.prepare(`
      SELECT i.id, i.sku, i.name, i.reorder_point, i.reorder_qty,
        COALESCE(SUM(s.quantity), 0) AS on_hand,
        COALESCE(SUM(s.reserved_quantity), 0) AS reserved,
        COALESCE(SUM(s.quantity - s.reserved_quantity), 0) AS available
      FROM inventory_items i LEFT JOIN inventory_stock s ON s.item_id = i.id
      WHERE i.active = 1 AND i.reorder_point > 0
      GROUP BY i.id
      HAVING available < i.reorder_point
      ORDER BY available ASC
    `).all();
  }

  // ── Stock levels & moves ──────────────────────────────────────────────────────

  function getStockLevels({ itemId, locationId } = {}) {
    let sql = 'SELECT * FROM inventory_stock WHERE 1=1';
    const params = [];
    if (itemId)     { sql += ' AND item_id = ?';     params.push(itemId); }
    if (locationId) { sql += ' AND location_id = ?'; params.push(locationId); }
    return db.prepare(sql).all(...params);
  }

  function _upsertStock(itemId, locationId, deltaQty, deltaReserved = 0) {
    const row = db.prepare('SELECT * FROM inventory_stock WHERE item_id = ? AND location_id = ?').get(itemId, locationId);
    const quantity = (row ? row.quantity : 0) + deltaQty;
    const reserved = (row ? row.reserved_quantity : 0) + deltaReserved;
    if (quantity < 0) throw new Error('Insufficient stock at location');
    if (reserved < 0) throw new Error('Cannot un-reserve more than is reserved');
    db.prepare(`
      INSERT INTO inventory_stock (item_id, location_id, quantity, reserved_quantity, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(item_id, location_id) DO UPDATE SET
        quantity = excluded.quantity, reserved_quantity = excluded.reserved_quantity, updated_at = excluded.updated_at
    `).run(itemId, locationId, quantity, reserved);
  }

  function _recordMove({ itemId, fromLocationId = null, toLocationId = null, quantity, moveType, reference = '', note = '', createdBy = '', unitCostAtTime = null, cogsAtTime = null }) {
    const id = newId('mov');
    db.prepare(`
      INSERT INTO inventory_moves (id, item_id, from_location_id, to_location_id, quantity, move_type, reference, note, created_by, unit_cost_at_time, cogs_at_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, itemId, fromLocationId, toLocationId, quantity, moveType, reference, note, createdBy, unitCostAtTime, cogsAtTime);
    return id;
  }

  // Weighted-average costing: each priced receipt blends into a single
  // running unit_cost — not per-batch cost layers, so this isn't true
  // FIFO/LIFO *costing* (FIFO/LIFO in this system governs physical picking
  // order only — see lib/warehouse-pick.js). Receiving with no unitCost
  // (e.g. a correction) leaves the existing cost untouched.
  function _applyWeightedAverageCost(itemId, incomingQty, unitCost) {
    if (unitCost == null) return null;
    const item = db.prepare('SELECT unit_cost FROM inventory_items WHERE id = ?').get(itemId);
    const { onHand } = db.prepare('SELECT COALESCE(SUM(quantity),0) AS onHand FROM inventory_stock WHERE item_id = ?').get(itemId);
    const priorQty = Math.max(0, onHand); // stock *before* this receipt's _upsertStock call
    const newCost = priorQty + incomingQty > 0
      ? ((priorQty * item.unit_cost) + (incomingQty * unitCost)) / (priorQty + incomingQty)
      : unitCost;
    db.prepare('UPDATE inventory_items SET unit_cost = ? WHERE id = ?').run(newCost, itemId);
    return newCost;
  }

  const receiveStock = db.transaction(({ itemId, locationId, quantity, reference = '', note = '', createdBy = '', unitCost = null }) => {
    if (!itemId || !locationId || !(quantity > 0)) throw new Error('itemId, locationId, and a positive quantity are required');
    const costAfter = _applyWeightedAverageCost(itemId, quantity, unitCost);
    _upsertStock(itemId, locationId, quantity);
    return _recordMove({ itemId, toLocationId: locationId, quantity, moveType: 'receive', reference, note, createdBy, unitCostAtTime: costAfter });
  });

  const shipStock = db.transaction(({ itemId, locationId, quantity, reference = '', note = '', createdBy = '' }) => {
    if (!itemId || !locationId || !(quantity > 0)) throw new Error('itemId, locationId, and a positive quantity are required');
    const { unit_cost } = db.prepare('SELECT unit_cost FROM inventory_items WHERE id = ?').get(itemId);
    _upsertStock(itemId, locationId, -quantity);
    return _recordMove({ itemId, fromLocationId: locationId, quantity, moveType: 'ship', reference, note, createdBy, cogsAtTime: quantity * unit_cost });
  });

  const transferStock = db.transaction(({ itemId, fromLocationId, toLocationId, quantity, reference = '', note = '', createdBy = '' }) => {
    if (!itemId || !fromLocationId || !toLocationId || !(quantity > 0)) throw new Error('itemId, fromLocationId, toLocationId, and a positive quantity are required');
    _upsertStock(itemId, fromLocationId, -quantity);
    _upsertStock(itemId, toLocationId, quantity);
    return _recordMove({ itemId, fromLocationId, toLocationId, quantity, moveType: 'transfer', reference, note, createdBy });
  });

  const adjustStock = db.transaction(({ itemId, locationId, delta, reference = '', note = '', createdBy = '' }) => {
    if (!itemId || !locationId || !delta) throw new Error('itemId, locationId, and a non-zero delta are required');
    const { unit_cost } = db.prepare('SELECT unit_cost FROM inventory_items WHERE id = ?').get(itemId);
    _upsertStock(itemId, locationId, delta);
    return _recordMove({
      itemId, toLocationId: delta > 0 ? locationId : null, fromLocationId: delta < 0 ? locationId : null,
      quantity: Math.abs(delta), moveType: 'adjust', reference, note, createdBy,
      cogsAtTime: delta < 0 ? Math.abs(delta) * unit_cost : null,
    });
  });

  // Current stock value — quantity on hand (not net of reservations, since
  // reserved stock is still owned) times each item's weighted-average cost.
  function getValuation() {
    const rows = db.prepare(`
      SELECT i.id, i.sku, i.name, i.unit_cost, COALESCE(SUM(s.quantity), 0) AS quantity
      FROM inventory_items i LEFT JOIN inventory_stock s ON s.item_id = i.id
      WHERE i.active = 1
      GROUP BY i.id
      HAVING quantity > 0
      ORDER BY (i.unit_cost * quantity) DESC
    `).all().map(r => ({ ...r, value: r.unit_cost * r.quantity }));
    return { totalValue: rows.reduce((s, r) => s + r.value, 0), items: rows };
  }

  function listMoves({ itemId, limit = 100 } = {}) {
    let sql = 'SELECT * FROM inventory_moves WHERE 1=1';
    const params = [];
    if (itemId) { sql += ' AND item_id = ?'; params.push(itemId); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params);
  }

  return {
    getConfig, updateConfig,
    listCustomFields, addCustomField, deleteCustomField,
    listFacilities, addFacility, updateFacility,
    listLocations, addLocation,
    listItems, getItem, addItem, updateItem, getLowStock,
    getStockLevels, receiveStock, shipStock, transferStock, adjustStock, listMoves, getValuation,
  };
};
