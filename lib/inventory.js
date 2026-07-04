'use strict';

module.exports = function createInventory(db) {

  function getAll({ category, search, lowStock } = {}) {
    let rows = db.prepare('SELECT * FROM inventory ORDER BY name ASC').all();
    if (category) rows = rows.filter(r => r.category === category);
    if (search)   { const q = search.toLowerCase(); rows = rows.filter(r => r.sku.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)); }
    if (lowStock) rows = rows.filter(r => r.stock_qty <= r.reorder_point);
    return rows;
  }

  function get(sku) {
    return db.prepare('SELECT * FROM inventory WHERE sku = ?').get(sku) || null;
  }

  function upsert(data) {
    const { sku, name, description='', category='', unit='pcs', location='', stock_qty=0, reserved_qty=0, reorder_point=10, cost_price=0, sell_price=0 } = data;
    if (!sku || !name) throw new Error('sku and name are required');
    db.prepare(`INSERT INTO inventory (sku,name,description,category,unit,location,stock_qty,reserved_qty,reorder_point,cost_price,sell_price,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(sku) DO UPDATE SET name=excluded.name,description=excluded.description,category=excluded.category,
        unit=excluded.unit,location=excluded.location,stock_qty=excluded.stock_qty,reserved_qty=excluded.reserved_qty,
        reorder_point=excluded.reorder_point,cost_price=excluded.cost_price,sell_price=excluded.sell_price,updated_at=datetime('now')`
    ).run(sku, name, description, category, unit, location, Number(stock_qty), Number(reserved_qty), Number(reorder_point), Number(cost_price), Number(sell_price));
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

  function deductOrder(order) {
    return db.transaction(() => {
      const results = [];
      for (const item of (order.items || [])) {
        if (!item.sku) continue;
        try {
          const updated = adjust(item.sku, -item.qty, 'outbound', 'Order ' + order.id, order.id);
          results.push({ sku: item.sku, ok: true, newQty: updated.stock_qty });
        } catch (e) {
          results.push({ sku: item.sku, ok: false, error: e.message });
        }
      }
      return results;
    })();
  }

  function movements(sku, limit = 50) {
    return db.prepare('SELECT * FROM stock_movements WHERE sku = ? ORDER BY at DESC LIMIT ?').all(sku, limit);
  }

  function getStats() {
    const rows = db.prepare('SELECT * FROM inventory').all();
    const lowStock   = rows.filter(r => r.stock_qty <= r.reorder_point && r.stock_qty > 0);
    const outOfStock = rows.filter(r => r.stock_qty === 0);
    const totalValue = rows.reduce((s, r) => s + r.stock_qty * r.cost_price, 0);
    const categories = [...new Set(rows.map(r => r.category).filter(Boolean))];
    return { totalSKUs: rows.length, lowStock: lowStock.length, outOfStock: outOfStock.length, totalValue, categories };
  }

  return { getAll, get, upsert, remove, adjust, deductOrder, movements, getStats };
};
