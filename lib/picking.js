'use strict';

const { randomUUID } = require('crypto');

module.exports = function createPicking({ db, store, clientConfig }) {

  // ── helpers ──────────────────────────────────────────────────────────────

  function _sessionRow(row) {
    if (!row) return null;
    return {
      ...row,
      order_ids: JSON.parse(row.order_ids || '[]'),
    };
  }

  function _getVirtualFulfillmentMethod(clientId, sku) {
    if (!clientConfig) return 'virtual';
    const skuObj = db.prepare(`
      SELECT fulfillment_method FROM client_virtual_skus
      WHERE client_id = ? AND sku = ? AND active = 1
    `).get(clientId, sku);
    return skuObj?.fulfillment_method || 'virtual';
  }

  function _isVirtualSku(clientId, skuCode) {
    if (!clientConfig) return false;
    return clientConfig.isVirtualSku(clientId, skuCode);
  }

  function _enrichSession(session) {
    if (!session) return null;
    const items = db.prepare(
      'SELECT * FROM pick_items WHERE session_id = ? ORDER BY location ASC, sku ASC'
    ).all(session.id);
    const totalItems   = items.reduce((s, i) => s + i.qty_required, 0);
    const pickedItems  = items.reduce((s, i) => s + i.qty_picked, 0);
    const allPicked    = totalItems > 0 && pickedItems >= totalItems;
    return { ...session, items, totalItems, pickedItems, allPicked };
  }

  // ── session creation ──────────────────────────────────────────────────────

  // type: 'scan' | 'batch' | 'wave'
  // orderIds: string[]   (scan → exactly 1)
  function createSession(type, orderIds, { notes = '', createdBy = '' } = {}) {
    if (!['scan', 'batch', 'wave'].includes(type)) {
      throw Object.assign(new Error('type must be scan, batch, or wave'), { status: 400 });
    }
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      throw Object.assign(new Error('At least one order is required'), { status: 400 });
    }
    if (type === 'scan' && orderIds.length !== 1) {
      throw Object.assign(new Error('Scan sessions allow exactly one order'), { status: 400 });
    }

    // Scan: enforce single active scan session globally
    if (type === 'scan') {
      const existing = db.prepare(
        "SELECT id FROM pick_sessions WHERE type = 'scan' AND status = 'active' LIMIT 1"
      ).get();
      if (existing) {
        throw Object.assign(
          new Error('A scan session is already active (id: ' + existing.id + '). Complete or cancel it first.'),
          { status: 409, activeSessionId: existing.id }
        );
      }
    }

    // Validate orders: must exist and be in 'processing' status
    const validated = [];
    for (const orderId of orderIds) {
      const order = store.getOrder(orderId);
      if (!order) throw Object.assign(new Error('Order not found: ' + orderId), { status: 404 });
      if (order.status !== 'processing') {
        throw Object.assign(
          new Error(`Order ${orderId} is '${order.status}' — only 'processing' orders can be picked`),
          { status: 400 }
        );
      }
      // Check not already in an active session
      const inSession = db.prepare(
        `SELECT ps.id FROM pick_sessions ps
         JOIN pick_items pi ON pi.session_id = ps.id
         WHERE pi.order_id = ? AND ps.status = 'active' LIMIT 1`
      ).get(orderId);
      if (inSession) {
        throw Object.assign(
          new Error(`Order ${orderId} is already in active pick session ${inSession.id}`),
          { status: 409 }
        );
      }
      validated.push(order);
    }

    const id = 'PK-' + Date.now().toString(36).toUpperCase() + '-' + randomUUID().slice(0, 4).toUpperCase();

    db.transaction(() => {
      db.prepare(
        `INSERT INTO pick_sessions (id, type, status, order_ids, notes, created_by)
         VALUES (?, ?, 'active', ?, ?, ?)`
      ).run(id, type, JSON.stringify(orderIds), notes, createdBy);

      for (const order of validated) {
        for (const item of (order.items || [])) {
          if (!item.sku) continue;
          let location = '';

          // Check if this SKU is virtual (dropship/supplier/affiliate)
          const isVirtual = _isVirtualSku(order.client_id, item.sku);
          if (isVirtual) {
            const method = _getVirtualFulfillmentMethod(order.client_id, item.sku);
            location = `VIRTUAL - ${method}`;
          } else {
            // Look up warehouse location from inventory
            const inv = db.prepare('SELECT location FROM inventory WHERE sku = ?').get(item.sku);
            location = inv?.location || '';
          }

          db.prepare(
            `INSERT INTO pick_items (session_id, order_id, sku, name, location, qty_required, qty_picked)
             VALUES (?, ?, ?, ?, ?, ?, 0)`
          ).run(id, order.id, item.sku, item.name || item.sku, location, Number(item.qty) || 1);
        }
      }
    })();

    return _enrichSession(_sessionRow(db.prepare('SELECT * FROM pick_sessions WHERE id = ?').get(id)));
  }

  // ── getters ───────────────────────────────────────────────────────────────

  function getSession(id) {
    return _enrichSession(_sessionRow(db.prepare('SELECT * FROM pick_sessions WHERE id = ?').get(id)));
  }

  function listSessions({ status, type, limit = 50 } = {}) {
    let sql = 'SELECT * FROM pick_sessions';
    const params = [];
    const where  = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (type)   { where.push('type = ?');   params.push(type); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params).map(r => _sessionRow(r));
  }

  function getActiveScanSession() {
    const row = db.prepare("SELECT * FROM pick_sessions WHERE type = 'scan' AND status = 'active' LIMIT 1").get();
    return row ? _enrichSession(_sessionRow(row)) : null;
  }

  // ── scan ─────────────────────────────────────────────────────────────────

  // For scan-type sessions only.
  // code can be: order ID (returns session info) OR item SKU/barcode (increments qty_picked by 1)
  function scan(sessionId, code) {
    const session = _sessionRow(db.prepare('SELECT * FROM pick_sessions WHERE id = ?').get(sessionId));
    if (!session) throw Object.assign(new Error('Pick session not found'), { status: 404 });
    if (session.type !== 'scan') throw Object.assign(new Error('scan() is only valid for scan-type sessions'), { status: 400 });
    if (session.status !== 'active') throw Object.assign(new Error('Session is ' + session.status), { status: 400 });

    const normalised = (code || '').trim();

    // Code matches the order ID → just return session state (confirmation scan)
    if (session.order_ids.some(id => id.toLowerCase() === normalised.toLowerCase())) {
      return { matched: 'order', item: null, session: _enrichSession(session) };
    }

    // Try to match as SKU against unpicked items
    const item = db.prepare(
      `SELECT * FROM pick_items
       WHERE session_id = ? AND LOWER(sku) = LOWER(?) AND qty_picked < qty_required
       LIMIT 1`
    ).get(sessionId, normalised);

    if (!item) {
      // Already fully picked?
      const done = db.prepare(
        `SELECT * FROM pick_items WHERE session_id = ? AND LOWER(sku) = LOWER(?) LIMIT 1`
      ).get(sessionId, normalised);
      if (done) return { matched: 'already_picked', item: done, session: _enrichSession(session) };
      throw Object.assign(new Error('Code "' + normalised + '" not found in this session'), { status: 404 });
    }

    const newQty = item.qty_picked + 1;
    const now    = new Date().toISOString();
    db.prepare(
      `UPDATE pick_items SET qty_picked = ?, picked_at = ? WHERE id = ?`
    ).run(newQty, now, item.id);

    const updated = db.prepare('SELECT * FROM pick_items WHERE id = ?').get(item.id);
    const enriched = _enrichSession(session);
    return {
      matched:    'item',
      item:       updated,
      complete:   updated.qty_picked >= updated.qty_required,
      session:    enriched,
      allPicked:  enriched.allPicked,
    };
  }

  // ── manual pick ───────────────────────────────────────────────────────────

  // Confirm qty picked for one item (batch/wave or manual override)
  function pickItem(sessionId, itemId, qtyPicked) {
    const session = db.prepare('SELECT * FROM pick_sessions WHERE id = ?').get(sessionId);
    if (!session) throw Object.assign(new Error('Pick session not found'), { status: 404 });
    if (session.status !== 'active') throw Object.assign(new Error('Session is ' + session.status), { status: 400 });

    const item = db.prepare('SELECT * FROM pick_items WHERE id = ? AND session_id = ?').get(itemId, sessionId);
    if (!item) throw Object.assign(new Error('Item not found in session'), { status: 404 });

    const newQty = Math.min(Math.max(0, Number(qtyPicked)), item.qty_required);
    db.prepare(
      `UPDATE pick_items SET qty_picked = ?, picked_at = ? WHERE id = ?`
    ).run(newQty, newQty > 0 ? new Date().toISOString() : null, item.id);

    return _enrichSession(_sessionRow(db.prepare('SELECT * FROM pick_sessions WHERE id = ?').get(sessionId)));
  }

  // Mark ALL remaining items in session as fully picked
  function pickAll(sessionId) {
    const session = db.prepare('SELECT * FROM pick_sessions WHERE id = ?').get(sessionId);
    if (!session) throw Object.assign(new Error('Pick session not found'), { status: 404 });
    if (session.status !== 'active') throw Object.assign(new Error('Session is ' + session.status), { status: 400 });

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE pick_items SET qty_picked = qty_required, picked_at = ?
       WHERE session_id = ? AND qty_picked < qty_required`
    ).run(now, sessionId);

    return _enrichSession(_sessionRow(db.prepare('SELECT * FROM pick_sessions WHERE id = ?').get(sessionId)));
  }

  // ── complete ──────────────────────────────────────────────────────────────

  // Advances all orders in the session from processing → packed, closes session.
  // force=true skips the allPicked check (partial pick override).
  function completeSession(sessionId, { force = false } = {}) {
    const session = _sessionRow(db.prepare('SELECT * FROM pick_sessions WHERE id = ?').get(sessionId));
    if (!session) throw Object.assign(new Error('Pick session not found'), { status: 404 });
    if (session.status !== 'active') throw Object.assign(new Error('Session is already ' + session.status), { status: 400 });

    const enriched = _enrichSession(session);
    if (!force && !enriched.allPicked) {
      throw Object.assign(
        new Error(`Not all items picked (${enriched.pickedItems}/${enriched.totalItems}). Use force=true to override.`),
        { status: 400 }
      );
    }

    const now     = new Date().toISOString();
    const results = [];

    db.transaction(() => {
      for (const orderId of session.order_ids) {
        const order = store.getOrder(orderId);
        if (!order || order.status !== 'processing') {
          results.push({ orderId, ok: false, reason: order ? 'status is ' + order.status : 'not found' });
          continue;
        }
        store.updateStatusAndSource(orderId, 'packed', { packedAt: now, pickSessionId: sessionId });
        results.push({ orderId, ok: true, newStatus: 'packed' });
      }

      db.prepare(
        `UPDATE pick_sessions SET status = 'completed', completed_at = ? WHERE id = ?`
      ).run(now, sessionId);
    })();

    return { session: getSession(sessionId), orderResults: results };
  }

  // ── cancel ────────────────────────────────────────────────────────────────

  function cancelSession(sessionId) {
    const session = db.prepare('SELECT * FROM pick_sessions WHERE id = ?').get(sessionId);
    if (!session) throw Object.assign(new Error('Pick session not found'), { status: 404 });
    if (session.status !== 'active') throw Object.assign(new Error('Session is already ' + session.status), { status: 400 });

    db.prepare(`UPDATE pick_sessions SET status = 'cancelled' WHERE id = ?`).run(sessionId);
    return getSession(sessionId);
  }

  return { createSession, getSession, listSessions, getActiveScanSession, scan, pickItem, pickAll, completeSession, cancelSession };
};
