'use strict';

const db = require('./db');

// ── Seed stock on first run ───────────────────────────────────────────────────
const { n } = db.prepare('SELECT COUNT(*) AS n FROM inventory').get();
if (n === 0) {
  const ins = db.prepare(`INSERT OR IGNORE INTO inventory (sku,name,category,unit,stock_qty,reserved_qty,reorder_point,cost_price,sell_price)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    ins.run('WIDGET-BLU','Blue Widget','Widgets','pcs',120,5,20,12.00,29.99);
    ins.run('GADGET-RED','Red Gadget Pro','Gadgets','pcs',45,2,15,22.00,49.99);
    ins.run('CASE-LRG','Large Carry Case','Accessories','pcs',80,0,25,5.50,12.50);
    ins.run('DESK-PAD','Desk Pad XL','Accessories','pcs',60,1,20,10.00,24.99);
    ins.run('HEADPH-PRO','Pro Headphones','Electronics','pcs',30,4,10,38.00,89.99);
    ins.run('KEYBOARD-MEC','Mechanical Keyboard','Electronics','pcs',18,1,8,55.00,129.99);
    ins.run('MOUSE-WRL','Wireless Mouse','Electronics','pcs',25,3,10,22.00,59.99);
    ins.run('CHARGER-65W','65W USB-C Charger','Electronics','pcs',90,0,30,12.00,34.99);
    ins.run('DRESS-SUM','Summer Dress','Fashion','pcs',35,2,12,28.00,79.99);
    ins.run('SCARF-SLK','Silk Scarf','Fashion','pcs',50,0,15,18.00,44.99);
    ins.run('SHIRT-CAS','Casual Shirt','Fashion','pcs',65,1,20,14.00,34.99);
    ins.run('PANTS-SLM','Slim Fit Pants','Fashion','pcs',40,2,15,24.00,59.99);
    ins.run('BLENDER-PRO','Pro Blender','Kitchen','pcs',22,1,8,28.00,69.99);
    ins.run('CUTTING-BRD','Bamboo Cutting Board','Kitchen','pcs',110,4,30,8.00,24.99);
    ins.run('KNIFE-SET','8-Piece Knife Set','Kitchen','pcs',15,0,5,35.00,89.99);
    ins.run('TOWEL-SET','Bath Towel Set','Home','pcs',55,2,20,16.00,39.99);
    ins.run('TENT-2P','2-Person Tent','Outdoor','pcs',8,1,5,75.00,199.99);
    ins.run('SLEEPING-BAG','Sleeping Bag -10C','Outdoor','pcs',12,2,6,45.00,119.99);
    ins.run('BACKPACK-45L','45L Hiking Backpack','Outdoor','pcs',20,4,8,35.00,89.99);
    ins.run('WATER-BTL','Insulated Water Bottle','Outdoor','pcs',85,4,25,8.00,24.99);
  })();
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

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
  const { sku, name, description='', category='', unit='pcs', stock_qty=0, reserved_qty=0, reorder_point=10, cost_price=0, sell_price=0 } = data;
  if (!sku || !name) throw new Error('sku and name are required');
  db.prepare(`INSERT INTO inventory (sku,name,description,category,unit,stock_qty,reserved_qty,reorder_point,cost_price,sell_price,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(sku) DO UPDATE SET name=excluded.name,description=excluded.description,category=excluded.category,
      unit=excluded.unit,stock_qty=excluded.stock_qty,reserved_qty=excluded.reserved_qty,reorder_point=excluded.reorder_point,
      cost_price=excluded.cost_price,sell_price=excluded.sell_price,updated_at=datetime('now')`
  ).run(sku, name, description, category, unit, Number(stock_qty), Number(reserved_qty), Number(reorder_point), Number(cost_price), Number(sell_price));
  return get(sku);
}

function remove(sku) {
  db.prepare('DELETE FROM inventory WHERE sku = ?').run(sku);
}

// ── Stock adjustment ──────────────────────────────────────────────────────────
function adjust(sku, qty, type = 'adjustment', reason = '', orderId = null) {
  const item = get(sku);
  if (!item) throw new Error(`SKU ${sku} not found`);
  const newQty = Math.max(0, item.stock_qty + qty);
  db.prepare("UPDATE inventory SET stock_qty=?, updated_at=datetime('now') WHERE sku=?").run(newQty, sku);
  db.prepare("INSERT INTO stock_movements (sku,type,qty,reason,order_id) VALUES (?,?,?,?,?)").run(sku, type, qty, reason, orderId);
  return get(sku);
}

// Decrement stock for all items in an order (called when order is packed)
function deductOrder(order) {
  return db.transaction(() => {
    const results = [];
    for (const item of (order.items || [])) {
      if (!item.sku) continue;
      try {
        const updated = adjust(item.sku, -item.qty, 'outbound', `Order ${order.id}`, order.id);
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
  const lowStock = rows.filter(r => r.stock_qty <= r.reorder_point && r.stock_qty > 0);
  const outOfStock = rows.filter(r => r.stock_qty === 0);
  const totalValue = rows.reduce((s, r) => s + r.stock_qty * r.cost_price, 0);
  const categories = [...new Set(rows.map(r => r.category).filter(Boolean))];
  return { totalSKUs: rows.length, lowStock: lowStock.length, outOfStock: outOfStock.length, totalValue, categories };
}

module.exports = { getAll, get, upsert, remove, adjust, deductOrder, movements, getStats };
