'use strict';

// Scan-based Pick-and-Pack (PPP), ported from IDEALPICK (branch
// claude/idealpick-subfunction-8kdzj1, lib/ppp.js) onto the per-client
// warehouse schema. Operator opens a package by scanning its HU (Handling
// Unit) barcode, scans products into it, then closes the package by scanning
// the same HU again. Repeats for as many cartons as needed. Item-name lookups
// use this client's own inventory_items instead of the legacy flat table;
// order lookups go through `ordersApi`, scoped to this client.

const crypto = require('crypto');

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

module.exports = function createPPP(db, ordersApi) {
  function getSession(sessionId) {
    const s = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
    if (!s) return null;
    const cartons = db.prepare('SELECT * FROM scan_cartons WHERE session_id = ? ORDER BY carton_seq').all(sessionId);
    for (const c of cartons) {
      c.items = db.prepare('SELECT * FROM scan_carton_items WHERE carton_id = ? ORDER BY scanned_at').all(c.id);
      c.item_count = c.items.reduce((sum, i) => sum + i.qty, 0);
    }
    const order = ordersApi.getOrder(s.order_id);
    return { ...s, cartons, order: order ? { id: order.id, clientName: order.clientName, status: order.status, shipping: order.shipping } : null };
  }

  function getOpenCarton(sessionId) {
    return db.prepare("SELECT * FROM scan_cartons WHERE session_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1").get(sessionId);
  }

  // ── Session lifecycle ────────────────────────────────────────────────────────

  function openSession(orderId, operatorId = '') {
    const order = ordersApi.getOrder(orderId);
    if (!order) throw new Error('Order not found');

    const existing = db.prepare("SELECT id FROM scan_sessions WHERE order_id = ? AND status = 'open'").get(orderId);
    if (existing) return getSession(existing.id);

    const id = newId('sess');
    db.prepare('INSERT INTO scan_sessions (id, order_id, operator_id) VALUES (?, ?, ?)').run(id, orderId, operatorId);
    return getSession(id);
  }

  function closeSession(sessionId) {
    const s = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
    if (!s) throw new Error('Session not found');
    if (getOpenCarton(sessionId)) throw new Error('Close the current carton before closing the session');

    db.prepare("UPDATE scan_sessions SET status='closed', closed_at=datetime('now') WHERE id=?").run(sessionId);
    return getSession(sessionId);
  }

  function listSessions({ status, orderId } = {}) {
    let sql = `
      SELECT s.*,
        (SELECT COUNT(*) FROM scan_cartons WHERE session_id = s.id) AS carton_count,
        (SELECT COUNT(*) FROM scan_carton_items WHERE session_id = s.id) AS item_count
      FROM scan_sessions s WHERE 1=1
    `;
    const params = [];
    if (status)  { sql += ' AND s.status = ?';   params.push(status); }
    if (orderId) { sql += ' AND s.order_id = ?'; params.push(orderId); }
    sql += ' ORDER BY s.created_at DESC';
    return db.prepare(sql).all(...params).map(r => {
      const order = ordersApi.getOrder(r.order_id);
      return { ...r, clientName: order ? order.clientName : '' };
    });
  }

  // ── System-generated HU — open a new carton without an external label ───────

  function openCarton(sessionId) {
    const s = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
    if (!s) throw new Error('Session not found');
    if (s.status === 'closed') throw new Error('Session is already closed');
    if (getOpenCarton(sessionId)) throw new Error('Close the current carton before opening a new one');

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const { n: daySeq } = db.prepare("SELECT COUNT(*) AS n FROM scan_cartons WHERE hu_code LIKE ?").get(`HU${today}%`);
    const huCode = `HU${today}${String(daySeq + 1).padStart(4, '0')}`;

    const { n: seq } = db.prepare('SELECT COUNT(*) AS n FROM scan_cartons WHERE session_id = ?').get(sessionId);
    const cartonId = newId('ctn');
    db.prepare('INSERT INTO scan_cartons (id, session_id, order_id, hu_code, carton_seq) VALUES (?, ?, ?, ?, ?)')
      .run(cartonId, sessionId, s.order_id, huCode, seq + 1);
    const carton = db.prepare('SELECT * FROM scan_cartons WHERE id=?').get(cartonId);
    carton.items = [];
    carton.item_count = 0;
    return { action: 'opened', carton, generated: true };
  }

  // ── HU scan — open or close a carton ────────────────────────────────────────

  function scanHU(sessionId, huCode) {
    const s = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
    if (!s) throw new Error('Session not found');
    if (s.status === 'closed') throw new Error('Session is already closed');

    const openCarton = getOpenCarton(sessionId);

    if (openCarton) {
      if (openCarton.hu_code !== huCode) {
        throw new Error(`Wrong HU code. Expected "${openCarton.hu_code}" to close current carton, or close it first`);
      }
      db.prepare("UPDATE scan_cartons SET status='closed', closed_at=datetime('now') WHERE id=?").run(openCarton.id);
      const closed = db.prepare('SELECT * FROM scan_cartons WHERE id=?').get(openCarton.id);
      closed.items = db.prepare('SELECT * FROM scan_carton_items WHERE carton_id=?').all(openCarton.id);
      closed.item_count = closed.items.reduce((sum, i) => sum + i.qty, 0);
      return { action: 'closed', carton: closed };
    }

    const { n: seq } = db.prepare('SELECT COUNT(*) AS n FROM scan_cartons WHERE session_id = ?').get(sessionId);
    const cartonId = newId('ctn');
    db.prepare('INSERT INTO scan_cartons (id, session_id, order_id, hu_code, carton_seq) VALUES (?, ?, ?, ?, ?)')
      .run(cartonId, sessionId, s.order_id, huCode, seq + 1);
    const carton = db.prepare('SELECT * FROM scan_cartons WHERE id=?').get(cartonId);
    carton.items = [];
    carton.item_count = 0;
    return { action: 'opened', carton };
  }

  // ── Product scan — add item to open carton ──────────────────────────────────
  //
  // Mis-pick protection: a scanned SKU must be one of the order's line items
  // unless the caller explicitly overrides with allowUnlisted (e.g. a
  // legitimate substitution). Exceeding the ordered quantity is a soft
  // warning, not a block — over-picking (replacing a damaged unit, etc.) is
  // sometimes intentional.

  function scanItem(sessionId, { sku, qty = 1, item_name = '', lot_number = '', expiry_date = '', allowUnlisted = false }) {
    const s = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
    if (!s) throw new Error('Session not found');

    const openCarton = getOpenCarton(sessionId);
    if (!openCarton) throw new Error('No open carton. Scan a HU label first to open a carton');
    if (!sku) throw new Error('SKU is required');

    const order = ordersApi.getOrder(s.order_id);
    const orderLine = order ? order.items.find(i => i.sku.toUpperCase() === sku.toUpperCase()) : null;
    if (order && !orderLine && !allowUnlisted) {
      throw new Error(`SKU not on this order: ${sku}. Confirm and scan again to add it anyway.`);
    }

    let warning = null;
    if (orderLine) {
      const { total: alreadyScanned } = db.prepare(
        "SELECT COALESCE(SUM(qty),0) AS total FROM scan_carton_items WHERE session_id = ? AND sku = ?"
      ).get(sessionId, sku);
      if (alreadyScanned + qty > orderLine.qty) {
        warning = `Exceeds ordered qty for ${sku}: ${alreadyScanned + qty} scanned vs ${orderLine.qty} ordered`;
      }
    }

    if (!item_name) {
      const item = db.prepare('SELECT name FROM inventory_items WHERE sku = ?').get(sku);
      item_name = item ? item.name : (orderLine ? orderLine.name : sku);
    }

    const existing = db.prepare('SELECT * FROM scan_carton_items WHERE carton_id = ? AND sku = ? AND lot_number = ?')
      .get(openCarton.id, sku, lot_number);

    let item;
    if (existing) {
      db.prepare('UPDATE scan_carton_items SET qty = qty + ? WHERE id = ?').run(qty, existing.id);
      item = db.prepare('SELECT * FROM scan_carton_items WHERE id = ?').get(existing.id);
    } else {
      const itemId = newId('sci');
      db.prepare(`
        INSERT INTO scan_carton_items (id, carton_id, session_id, order_id, sku, item_name, qty, lot_number, expiry_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(itemId, openCarton.id, sessionId, s.order_id, sku, item_name, qty, lot_number, expiry_date);
      item = db.prepare('SELECT * FROM scan_carton_items WHERE id = ?').get(itemId);
    }

    const cartonItems = db.prepare('SELECT * FROM scan_carton_items WHERE carton_id = ?').all(openCarton.id);
    return { item, warning, carton: { ...openCarton, items: cartonItems, item_count: cartonItems.reduce((sum, i) => sum + i.qty, 0) } };
  }

  function removeItem(itemId) {
    const item = db.prepare('SELECT * FROM scan_carton_items WHERE id = ?').get(itemId);
    if (!item) throw new Error('Item not found');
    const carton = db.prepare('SELECT * FROM scan_cartons WHERE id = ?').get(item.carton_id);
    if (carton && carton.status !== 'open') throw new Error('Cannot remove items from a closed carton');
    db.prepare('DELETE FROM scan_carton_items WHERE id = ?').run(itemId);
    return { removed: true, itemId };
  }

  function updateCartonDimensions(cartonId, { weight_kg, length_cm, width_cm, height_cm, notes }) {
    db.prepare(`
      UPDATE scan_cartons SET
        weight_kg = COALESCE(?, weight_kg), length_cm = COALESCE(?, length_cm),
        width_cm  = COALESCE(?, width_cm),  height_cm = COALESCE(?, height_cm),
        notes     = COALESCE(?, notes)
      WHERE id = ?
    `).run(weight_kg ?? null, length_cm ?? null, width_cm ?? null, height_cm ?? null, notes ?? null, cartonId);
    return db.prepare('SELECT * FROM scan_cartons WHERE id = ?').get(cartonId);
  }

  // ── Print data ───────────────────────────────────────────────────────────────

  function getCartonPackingListData(cartonId) {
    const c = db.prepare('SELECT * FROM scan_cartons WHERE id = ?').get(cartonId);
    if (!c) throw new Error('Carton not found');
    c.items = db.prepare('SELECT * FROM scan_carton_items WHERE carton_id = ? ORDER BY sku').all(cartonId);
    const session = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(c.session_id);
    const order = ordersApi.getOrder(c.order_id);
    const totalCartons = db.prepare('SELECT COUNT(*) AS n FROM scan_cartons WHERE session_id = ?').get(c.session_id).n;
    return { carton: c, session, order: order || {}, totalCartons };
  }

  function getMasterPackingListData(sessionId) {
    const s = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
    if (!s) throw new Error('Session not found');
    const cartons = db.prepare('SELECT * FROM scan_cartons WHERE session_id = ? ORDER BY carton_seq').all(sessionId);
    for (const c of cartons) {
      c.items = db.prepare('SELECT * FROM scan_carton_items WHERE carton_id = ? ORDER BY sku').all(c.id);
      c.item_count = c.items.reduce((sum, i) => sum + i.qty, 0);
    }
    const order = ordersApi.getOrder(s.order_id);
    return { session: s, cartons, totalCartons: cartons.length, order: order || {} };
  }

  return {
    openSession, closeSession, listSessions, getSession,
    openCarton, scanHU, scanItem, removeItem, updateCartonDimensions,
    getCartonPackingListData, getMasterPackingListData,
  };
};
