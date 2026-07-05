'use strict';

module.exports = function createInventory(db) {

  // Statuses at which inventory was reserved (processing or packed)
  const RESERVED_STATUSES = new Set(['processing', 'packed']);
  // Statuses at which inventory was already fully deducted (physically shipped)
  const DEDUCTED_STATUSES = new Set(['shipped', 'delivered']);

  function getAll({ category, search, lowStock, clientId } = {}) {
    let rows = db.prepare('SELECT * FROM inventory ORDER BY name ASC').all();
    rows = rows.map(r => ({ ...r, available_qty: Math.max(0, r.stock_qty - r.reserved_qty) }));
    if (category) rows = rows.filter(r => r.category === category);
    if (search)   { const q = search.toLowerCase(); rows = rows.filter(r => r.sku.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)); }
    if (lowStock) rows = rows.filter(r => r.available_qty <= r.reorder_point);
    if (clientId) rows = rows.filter(r => r.client_id === clientId);
    return rows;
  }

  function get(sku) {
    const r = db.prepare('SELECT * FROM inventory WHERE sku = ?').get(sku) || null;
    if (!r) return null;
    return { ...r, available_qty: Math.max(0, r.stock_qty - r.reserved_qty) };
  }

  function upsert(data) {
    const { sku, name, description='', category='', unit='pcs', location='', stock_qty=0, reserved_qty=0, reorder_point=10, cost_price=0, sell_price=0, client_id='' } = data;
    if (!sku || !name) throw new Error('sku and name are required');
    db.prepare(`INSERT INTO inventory (sku,name,description,category,unit,location,stock_qty,reserved_qty,reorder_point,cost_price,sell_price,client_id,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(sku) DO UPDATE SET name=excluded.name,description=excluded.description,category=excluded.category,
        unit=excluded.unit,location=excluded.location,stock_qty=excluded.stock_qty,reserved_qty=excluded.reserved_qty,
        reorder_point=excluded.reorder_point,cost_price=excluded.cost_price,sell_price=excluded.sell_price,client_id=excluded.client_id,updated_at=datetime('now')`
    ).run(sku, name, description, category, unit, location, Number(stock_qty), Number(reserved_qty), Number(reorder_point), Number(cost_price), Number(sell_price), client_id);
    return get(sku);
  }

  function remove(sku) {
    db.prepare('DELETE FROM inventory WHERE sku = ?').run(sku);
  }

  function adjust(sku, qty, type = 'adjustment', reason = '', orderId = null) {
    const item = get(sku);
    if (!item) throw new Error('SKU ' + sku + ' not found');
    const newQty = Math.max(0, item.stock_qty + qty);
    db.prepare("UPDATE inventory SET stock_qty=?, updated_at=datetime('now') WHERE sku=?").run(newQty, sku);
    db.prepare('INSERT INTO stock_movements (sku,type,qty,reason,order_id) VALUES (?,?,?,?,?)').run(sku, type, qty, reason, orderId);
    return get(sku);
  }

  // Called when order → 'processing': moves qty into reserved (unavailable for other orders)
  function reserveOrder(order) {
    return db.transaction(() => {
      const results = [];
      for (const item of (order.items || [])) {
        if (!item.sku) continue;
        const inv = get(item.sku);
        if (!inv) { results.push({ sku: item.sku, ok: false, error: 'SKU not found in inventory' }); continue; }
        const newReserved = inv.reserved_qty + Number(item.qty);
        db.prepare("UPDATE inventory SET reserved_qty=?, updated_at=datetime('now') WHERE sku=?")
          .run(newReserved, item.sku);
        db.prepare('INSERT INTO stock_movements (sku,type,qty,reason,order_id) VALUES (?,?,?,?,?)')
          .run(item.sku, 'reserve', Number(item.qty), 'Reserved for order ' + order.id, order.id);
        results.push({ sku: item.sku, ok: true, reservedQty: newReserved, availableQty: Math.max(0, inv.stock_qty - newReserved) });
      }
      return results;
    })();
  }

  // Called when order → 'shipped': clears reservation AND deducts physical stock
  function deductOrder(order) {
    return db.transaction(() => {
      const results = [];
      for (const item of (order.items || [])) {
        if (!item.sku) continue;
        const inv = get(item.sku);
        if (!inv) { results.push({ sku: item.sku, ok: false, error: 'SKU not found in inventory' }); continue; }
        const qty         = Number(item.qty);
        const newQty      = Math.max(0, inv.stock_qty - qty);
        const newReserved = Math.max(0, inv.reserved_qty - qty);
        db.prepare("UPDATE inventory SET stock_qty=?, reserved_qty=?, updated_at=datetime('now') WHERE sku=?")
          .run(newQty, newReserved, item.sku);
        db.prepare('INSERT INTO stock_movements (sku,type,qty,reason,order_id) VALUES (?,?,?,?,?)')
          .run(item.sku, 'outbound', -qty, 'Shipped order ' + order.id, order.id);
        results.push({ sku: item.sku, ok: true, newQty, newReserved });
      }
      return results;
    })();
  }

  // Called on cancel or return.
  // previousStatus tells us how far along the order was, so we know what to undo:
  //   processing / packed  → release reservation only (items never left warehouse)
  //   shipped / delivered  → inbound return (items physically returning to stock)
  //   pending / confirmed  → nothing to undo
  function releaseOrder(order, previousStatus) {
    const wasReserved = RESERVED_STATUSES.has(previousStatus);
    const wasShipped  = DEDUCTED_STATUSES.has(previousStatus);

    if (!wasReserved && !wasShipped) return [];

    return db.transaction(() => {
      const results = [];
      for (const item of (order.items || [])) {
        if (!item.sku) continue;
        const inv = get(item.sku);
        if (!inv) { results.push({ sku: item.sku, ok: false, error: 'SKU not found in inventory' }); continue; }
        const qty = Number(item.qty);

        if (wasShipped) {
          // Items physically returning: add back to stock
          const newQty = inv.stock_qty + qty;
          db.prepare("UPDATE inventory SET stock_qty=?, updated_at=datetime('now') WHERE sku=?")
            .run(newQty, item.sku);
          db.prepare('INSERT INTO stock_movements (sku,type,qty,reason,order_id) VALUES (?,?,?,?,?)')
            .run(item.sku, 'inbound_return', qty, 'Returned order ' + order.id, order.id);
          results.push({ sku: item.sku, ok: true, action: 'inbound_return', newQty });
        } else {
          // Reservation cancelled — just free the reserved slots
          const newReserved = Math.max(0, inv.reserved_qty - qty);
          db.prepare("UPDATE inventory SET reserved_qty=?, updated_at=datetime('now') WHERE sku=?")
            .run(newReserved, item.sku);
          db.prepare('INSERT INTO stock_movements (sku,type,qty,reason,order_id) VALUES (?,?,?,?,?)')
            .run(item.sku, 'release', qty, 'Cancelled order ' + order.id, order.id);
          results.push({ sku: item.sku, ok: true, action: 'release', newReserved });
        }
      }
      return results;
    })();
  }

  function movements(sku, limit = 50) {
    return db.prepare('SELECT * FROM stock_movements WHERE sku = ? ORDER BY at DESC LIMIT ?').all(sku, limit);
  }

  function getStats({ clientId } = {}) {
    let rows = db.prepare('SELECT * FROM inventory').all();
    if (clientId) rows = rows.filter(r => r.client_id === clientId);
    rows = rows.map(r => ({ ...r, available_qty: Math.max(0, r.stock_qty - r.reserved_qty) }));
    const lowStock   = rows.filter(r => r.available_qty <= r.reorder_point && r.available_qty > 0);
    const outOfStock = rows.filter(r => r.available_qty === 0);
    const totalValue = rows.reduce((s, r) => s + r.available_qty * r.cost_price, 0);
    const totalReserved = rows.reduce((s, r) => s + r.reserved_qty, 0);
    const categories = [...new Set(rows.map(r => r.category).filter(Boolean))];
    return { totalSKUs: rows.length, lowStock: lowStock.length, outOfStock: outOfStock.length, totalValue, totalReserved, categories, clientId };
  }

  function velocity(limit = 20, clientId = null) {
    let sql = `SELECT sm.sku, SUM(ABS(sm.qty)) as total_out, i.name, i.category, i.client_id
      FROM stock_movements sm
      LEFT JOIN inventory i ON i.sku = sm.sku
      WHERE sm.type = 'outbound'`;
    if (clientId) sql += ` AND i.client_id = '${clientId.replace(/'/g,"''")}'`;
    sql += ` GROUP BY sm.sku ORDER BY total_out DESC LIMIT ${Number(limit)}`;
    return db.prepare(sql).all();
  }

  return { getAll, get, upsert, remove, adjust, reserveOrder, deductOrder, releaseOrder, movements, getStats, velocity,
           RESERVED_STATUSES, DEDUCTED_STATUSES };
};
