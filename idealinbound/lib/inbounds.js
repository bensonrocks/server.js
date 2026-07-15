'use strict';

// IdealInbound — inbound processing for any inbound mode: air freight, LCL,
// FCL, ecommerce returns, or loose/ad-hoc drop-offs.
//
// Cartons are OPT-IN, not mandatory: a scan can be tagged to a labeled
// carton (multi-box PO/FCL/LCL receiving) or left untagged (quick ad-hoc/
// return receiving, where forcing a box-labeling step would just be
// friction). Pass cartonId to receiveItem to use them.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { pool, hasDb } = require('./db');
const { nextInboundSerial } = require('./serials');

const TYPES = ['air', 'lcl', 'fcl', 'return', 'loose'];
const CONDITIONS = ['sellable', 'damaged', 'refurbish', 'dispose', 'kiv', 'unspecified'];

function emptyConditionTotals() {
  return { sellable: 0, damaged: 0, refurbish: 0, dispose: 0, kiv: 0, unspecified: 0 };
}

class InboundError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Only auto-close when there's a manifest to check against — ad-hoc /
// loose receiving has nothing to compare to, so it waits for a manual close.
function computeStatus(items) {
  const planned = items.filter(i => i.expectedQty > 0);
  const anyReceived = items.some(i => i.receivedQty > 0);
  if (!anyReceived) return 'expected';
  if (planned.length > 0 && planned.every(i => i.receivedQty >= i.expectedQty)) return 'completed';
  return 'receiving';
}

function computeMismatches(items) {
  const mismatches = items
    .filter(i => i.expectedQty > 0 && i.receivedQty !== i.expectedQty)
    .map(i => ({ sku: i.sku, expectedQty: i.expectedQty, receivedQty: i.receivedQty, diff: i.receivedQty - i.expectedQty }));
  const extras = items
    .filter(i => i.expectedQty === 0 && i.receivedQty > 0)
    .map(i => ({ sku: i.sku, receivedQty: i.receivedQty }));
  return { mismatches, extras };
}

// ── JSON fallback (no IDEALINBOUND_DATABASE_URL) ───────────────────────
const FILE = path.join(__dirname, '../data/inbounds.json');

function jsonRead() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function jsonWrite(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}
function summarize(s) {
  return {
    id: s.id, serial: s.serial, type: s.type, reference: s.reference, source: s.source,
    expectedDate: s.expectedDate, status: s.status, createdAt: s.createdAt,
    metadata: s.metadata,
    itemCount: s.items.length,
    totalExpected: s.items.reduce((a, i) => a + i.expectedQty, 0),
    totalReceived: s.items.reduce((a, i) => a + i.receivedQty, 0),
    photoCount: (s.photos || []).length,
    cartonCount: (s.cartons || []).length,
    pendingDeletion: s.pendingDeletion || null,
  };
}
function photoMeta(p) {
  return {
    id: p.id, itemId: p.itemId, eventId: p.eventId, caption: p.caption,
    mimeType: p.mimeType, uploadedBy: p.uploadedBy, uploadedAt: p.uploadedAt,
  };
}
function cartonWithCounts(inbound, carton) {
  const events = inbound.events.filter(e => e.cartonId === carton.id);
  return {
    ...carton,
    itemCount: new Set(events.map(e => e.sku)).size,
    totalQty: events.reduce((a, e) => a + e.qty, 0),
  };
}
function withDerived(inbound) {
  return {
    ...inbound,
    photos: (inbound.photos || []).map(photoMeta),
    cartons: (inbound.cartons || []).map(c => cartonWithCounts(inbound, c)),
  };
}

const json = {
  TYPES, CONDITIONS,
  async init() {},

  async listInbounds({ type } = {}) {
    let list = jsonRead().map(summarize);
    if (type) list = list.filter(s => s.type === type);
    return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  async getInbound(id) {
    const inbound = jsonRead().find(s => s.id === id);
    return inbound ? withDerived(inbound) : null;
  },
  async createInbound({ type, reference, source, expectedDate, metadata, items, createdBy }) {
    const list = jsonRead();
    const inbound = {
      id: crypto.randomUUID(),
      serial: await nextInboundSerial(),
      type, reference, source,
      expectedDate: expectedDate || null,
      metadata: metadata || {},
      status: 'expected',
      createdBy: createdBy || null,
      createdAt: new Date().toISOString(),
      activeCartonId: null,
      pendingDeletion: null,
      items: (items || []).map(it => ({
        id: crypto.randomUUID(),
        sku: it.sku,
        description: it.description || '',
        expectedQty: Number(it.expectedQty) || 0,
        receivedQty: 0,
        conditionTotals: emptyConditionTotals(),
      })),
      events: [],
      photos: [],
      cartons: [],
    };
    list.push(inbound);
    jsonWrite(list);
    return withDerived(inbound);
  },
  async receiveItem(inboundId, { sku, qty, condition, description, receivedBy, cartonId }) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    if (cartonId) {
      const carton = inbound.cartons.find(c => c.id === cartonId);
      if (!carton) throw new InboundError('CARTON_NOT_FOUND', 'Carton not found on this inbound');
      if (!carton.labelConfirmed) throw new InboundError('CARTON_NOT_LABELED', 'Confirm this carton\'s label before scanning into it');
      if (carton.status === 'closed') { carton.status = 'open'; carton.closedAt = null; }
    }
    const cond = CONDITIONS.includes(condition) ? condition : 'unspecified';
    let item = inbound.items.find(i => i.sku.toLowerCase() === sku.toLowerCase());
    if (!item) {
      item = {
        id: crypto.randomUUID(), sku, description: description || '',
        expectedQty: 0, receivedQty: 0, conditionTotals: emptyConditionTotals(),
      };
      inbound.items.push(item);
    }
    item.receivedQty += Number(qty);
    item.conditionTotals[cond] += Number(qty);
    const eventId = crypto.randomUUID();
    inbound.events.push({
      id: eventId, itemId: item.id, sku: item.sku, qty: Number(qty), condition: cond,
      cartonId: cartonId || null, receivedBy: receivedBy || null, receivedAt: new Date().toISOString(),
    });
    inbound.status = computeStatus(inbound.items);
    jsonWrite(list);
    return { ...withDerived(inbound), lastEventId: eventId, lastItemId: item.id };
  },
  async closeInbound(inboundId, { force } = {}) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    const { mismatches, extras } = computeMismatches(inbound.items);
    if (!force && (mismatches.length || extras.length)) {
      return { needsConfirm: true, mismatches, extras };
    }
    for (const c of inbound.cartons) { if (c.status === 'open') { c.status = 'closed'; c.closedAt = new Date().toISOString(); } }
    inbound.activeCartonId = null;
    inbound.status = 'completed';
    jsonWrite(list);
    return { ...withDerived(inbound), needsConfirm: false, mismatches, extras };
  },
  async addPhoto(inboundId, { itemId, eventId, caption, buffer, mimeType, uploadedBy }) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    if (!inbound.photos) inbound.photos = [];
    const photo = {
      id: crypto.randomUUID(), itemId: itemId || null, eventId: eventId || null,
      caption: caption || '', mimeType, dataBase64: buffer.toString('base64'),
      uploadedBy: uploadedBy || null, uploadedAt: new Date().toISOString(),
    };
    inbound.photos.push(photo);
    jsonWrite(list);
    return photoMeta(photo);
  },
  async getPhotoData(inboundId, photoId) {
    const inbound = jsonRead().find(s => s.id === inboundId);
    const photo = inbound?.photos?.find(p => p.id === photoId);
    if (!photo) return null;
    return { buffer: Buffer.from(photo.dataBase64, 'base64'), mimeType: photo.mimeType };
  },

  // ── Cartons ────────────────────────────────────────────────────────
  async createCarton(inboundId) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    const cartonNum = (inbound.cartons.reduce((max, c) => Math.max(max, c.cartonNum), 0)) + 1;
    const carton = {
      id: crypto.randomUUID(), cartonNum, status: 'open', labelConfirmed: false,
      startedAt: new Date().toISOString(), closedAt: null,
    };
    inbound.cartons.push(carton);
    jsonWrite(list);
    return cartonWithCounts(inbound, carton);
  },
  async confirmCartonLabel(inboundId, cartonId) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    const carton = inbound.cartons.find(c => c.id === cartonId);
    if (!carton) return null;
    carton.labelConfirmed = true;
    if (!inbound.activeCartonId) inbound.activeCartonId = carton.id;
    jsonWrite(list);
    return cartonWithCounts(inbound, carton);
  },
  async switchCarton(inboundId, cartonId) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    const carton = inbound.cartons.find(c => c.id === cartonId);
    if (!carton) return null;
    if (carton.status === 'closed') { carton.status = 'open'; carton.closedAt = null; }
    inbound.activeCartonId = carton.id;
    jsonWrite(list);
    return withDerived(inbound);
  },
  async closeCarton(inboundId, cartonId) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    const carton = inbound.cartons.find(c => c.id === cartonId);
    if (!carton) return null;
    carton.status = 'closed';
    carton.closedAt = new Date().toISOString();
    if (inbound.activeCartonId === cartonId) inbound.activeCartonId = null;
    jsonWrite(list);
    return cartonWithCounts(inbound, carton);
  },
  async cancelCarton(inboundId, cartonId) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    const hasScans = inbound.events.some(e => e.cartonId === cartonId);
    if (hasScans) throw new InboundError('CARTON_NOT_EMPTY', 'Cannot cancel a carton that already has scans');
    inbound.cartons = inbound.cartons.filter(c => c.id !== cartonId);
    if (inbound.activeCartonId === cartonId) inbound.activeCartonId = null;
    jsonWrite(list);
    return { cancelled: true };
  },
  async getCartonSlip(inboundId, cartonId) {
    const inbound = jsonRead().find(s => s.id === inboundId);
    if (!inbound) return null;
    const carton = inbound.cartons.find(c => c.id === cartonId);
    if (!carton) return null;
    const bySku = new Map();
    for (const e of inbound.events.filter(e => e.cartonId === cartonId)) {
      bySku.set(e.sku, (bySku.get(e.sku) || 0) + e.qty);
    }
    return {
      carton: cartonWithCounts(inbound, carton),
      inbound: { id: inbound.id, serial: inbound.serial, reference: inbound.reference, source: inbound.source, type: inbound.type },
      lines: [...bySku.entries()].map(([sku, qty]) => ({ sku, qty })),
    };
  },

  // ── Deletion workflow ─────────────────────────────────────────────
  async requestDeletion(inboundId, { reason, requestedBy }) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    if (inbound.status === 'completed') throw new InboundError('ALREADY_COMPLETED', 'Completed inbounds cannot be deleted');
    if (inbound.pendingDeletion) throw new InboundError('ALREADY_PENDING', 'A deletion request is already pending for this inbound');
    inbound.pendingDeletion = { reason, requestedBy, requestedAt: new Date().toISOString() };
    jsonWrite(list);
    return summarize(inbound);
  },
  async listPendingDeletions() {
    return jsonRead().filter(s => s.pendingDeletion).map(summarize);
  },
  async approveDeletion(inboundId) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    jsonWrite(list.filter(s => s.id !== inboundId));
    return withDerived(inbound);
  },
  async rejectDeletion(inboundId) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    inbound.pendingDeletion = null;
    jsonWrite(list);
    return summarize(inbound);
  },
  async directDelete(inboundId) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    if (inbound.status === 'completed') throw new InboundError('ALREADY_COMPLETED', 'Completed inbounds cannot be deleted');
    jsonWrite(list.filter(s => s.id !== inboundId));
    return withDerived(inbound);
  },

  // ── Bulk export support ───────────────────────────────────────────
  async listInboundsInRange({ from, to }) {
    let list = jsonRead();
    if (from) list = list.filter(s => s.createdAt >= from);
    if (to) list = list.filter(s => s.createdAt <= to);
    return list.map(withDerived);
  },
};

// ── PostgreSQL backend ─────────────────────────────────────────────────
function rowToInbound(r, items = [], events = [], photos = [], cartons = []) {
  return {
    id: r.id, serial: r.serial, type: r.type, reference: r.reference, source: r.source,
    expectedDate: r.expected_date, status: r.status, metadata: r.metadata || {},
    createdBy: r.created_by, createdAt: r.created_at,
    activeCartonId: r.active_carton_id,
    pendingDeletion: r.pending_deletion || null,
    items: items.map(rowToItem),
    events: events.map(rowToEvent),
    photos: photos.map(rowToPhotoMeta),
    cartons: cartons.map(rowToCarton),
  };
}
function rowToItem(r) {
  return {
    id: r.id, sku: r.sku, description: r.description,
    expectedQty: r.expected_qty, receivedQty: r.received_qty,
    conditionTotals: { ...emptyConditionTotals(), ...(r.condition_totals || {}) },
  };
}
function rowToEvent(r) {
  return {
    id: r.id, itemId: r.item_id, sku: r.sku, qty: r.qty, condition: r.condition,
    cartonId: r.carton_id, receivedBy: r.received_by, receivedAt: r.received_at,
  };
}
function rowToPhotoMeta(r) {
  return {
    id: r.id, itemId: r.item_id, eventId: r.event_id, caption: r.caption,
    mimeType: r.mime_type, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
  };
}
function rowToCarton(r) {
  return {
    id: r.id, cartonNum: r.carton_num, status: r.status, labelConfirmed: r.label_confirmed,
    startedAt: r.started_at, closedAt: r.closed_at,
    itemCount: Number(r.item_count) || 0, totalQty: Number(r.total_qty) || 0,
  };
}

const pg = {
  TYPES, CONDITIONS,
  async init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inbounds (
        id                TEXT PRIMARY KEY,
        serial            TEXT UNIQUE,
        type              TEXT NOT NULL,
        reference         TEXT NOT NULL,
        source            TEXT NOT NULL,
        expected_date     DATE,
        status            TEXT NOT NULL DEFAULT 'expected',
        metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by        TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        active_carton_id  TEXT,
        pending_deletion  JSONB
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inbound_items (
        id                TEXT PRIMARY KEY,
        inbound_id        TEXT NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
        sku               TEXT NOT NULL,
        description       TEXT,
        expected_qty      INTEGER NOT NULL DEFAULT 0,
        received_qty      INTEGER NOT NULL DEFAULT 0,
        condition_totals  JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inbound_cartons (
        id                TEXT PRIMARY KEY,
        inbound_id        TEXT NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
        carton_num        INTEGER NOT NULL,
        status            TEXT NOT NULL DEFAULT 'open',
        label_confirmed   BOOLEAN NOT NULL DEFAULT false,
        started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at         TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inbound_events (
        id            TEXT PRIMARY KEY,
        inbound_id    TEXT NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
        item_id       TEXT NOT NULL REFERENCES inbound_items(id) ON DELETE CASCADE,
        carton_id     TEXT REFERENCES inbound_cartons(id) ON DELETE SET NULL,
        sku           TEXT NOT NULL,
        qty           INTEGER NOT NULL,
        condition     TEXT NOT NULL DEFAULT 'unspecified',
        received_by   TEXT,
        received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inbound_photos (
        id            TEXT PRIMARY KEY,
        inbound_id    TEXT NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
        item_id       TEXT REFERENCES inbound_items(id) ON DELETE SET NULL,
        event_id      TEXT REFERENCES inbound_events(id) ON DELETE SET NULL,
        caption       TEXT,
        mime_type     TEXT NOT NULL,
        data          BYTEA NOT NULL,
        uploaded_by   TEXT,
        uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  },
  async listInbounds({ type } = {}) {
    const params = [];
    let where = '';
    if (type) { params.push(type); where = `WHERE s.type = $${params.length}`; }
    const { rows } = await pool.query(`
      SELECT s.*,
        COALESCE(item_agg.item_count, 0)      AS item_count,
        COALESCE(item_agg.total_expected, 0)  AS total_expected,
        COALESCE(item_agg.total_received, 0)  AS total_received,
        COALESCE(photo_agg.photo_count, 0)    AS photo_count,
        COALESCE(carton_agg.carton_count, 0)  AS carton_count
      FROM inbounds s
      LEFT JOIN (
        SELECT inbound_id, COUNT(*)::int AS item_count,
               COALESCE(SUM(expected_qty),0)::int AS total_expected,
               COALESCE(SUM(received_qty),0)::int AS total_received
        FROM inbound_items GROUP BY inbound_id
      ) item_agg ON item_agg.inbound_id = s.id
      LEFT JOIN (
        SELECT inbound_id, COUNT(*)::int AS photo_count
        FROM inbound_photos GROUP BY inbound_id
      ) photo_agg ON photo_agg.inbound_id = s.id
      LEFT JOIN (
        SELECT inbound_id, COUNT(*)::int AS carton_count
        FROM inbound_cartons GROUP BY inbound_id
      ) carton_agg ON carton_agg.inbound_id = s.id
      ${where}
      ORDER BY s.created_at DESC
    `, params);
    return rows.map(r => ({
      id: r.id, serial: r.serial, type: r.type, reference: r.reference, source: r.source,
      expectedDate: r.expected_date, status: r.status, createdAt: r.created_at,
      metadata: r.metadata || {}, pendingDeletion: r.pending_deletion || null,
      itemCount: r.item_count, totalExpected: r.total_expected, totalReceived: r.total_received,
      photoCount: r.photo_count, cartonCount: r.carton_count,
    }));
  },
  async getInbound(id) {
    const { rows: srows } = await pool.query('SELECT * FROM inbounds WHERE id = $1', [id]);
    if (!srows[0]) return null;
    const { rows: irows } = await pool.query('SELECT * FROM inbound_items WHERE inbound_id = $1 ORDER BY sku', [id]);
    const { rows: erows } = await pool.query('SELECT * FROM inbound_events WHERE inbound_id = $1 ORDER BY received_at', [id]);
    const { rows: prows } = await pool.query(
      'SELECT id, item_id, event_id, caption, mime_type, uploaded_by, uploaded_at FROM inbound_photos WHERE inbound_id = $1 ORDER BY uploaded_at',
      [id]
    );
    const { rows: crows } = await pool.query(`
      SELECT c.*, COALESCE(ce.item_count, 0) AS item_count, COALESCE(ce.total_qty, 0) AS total_qty
      FROM inbound_cartons c
      LEFT JOIN (
        SELECT carton_id, COUNT(DISTINCT sku)::int AS item_count, COALESCE(SUM(qty),0)::int AS total_qty
        FROM inbound_events WHERE carton_id IS NOT NULL GROUP BY carton_id
      ) ce ON ce.carton_id = c.id
      WHERE c.inbound_id = $1 ORDER BY c.carton_num
    `, [id]);
    return rowToInbound(srows[0], irows, erows, prows, crows);
  },
  async createInbound({ type, reference, source, expectedDate, metadata, items, createdBy }) {
    const id = crypto.randomUUID();
    const serial = await nextInboundSerial();
    await pool.query(
      `INSERT INTO inbounds (id, serial, type, reference, source, expected_date, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, serial, type, reference, source, expectedDate || null, JSON.stringify(metadata || {}), createdBy || null]
    );
    for (const it of (items || [])) {
      await pool.query(
        `INSERT INTO inbound_items (id, inbound_id, sku, description, expected_qty) VALUES ($1,$2,$3,$4,$5)`,
        [crypto.randomUUID(), id, it.sku, it.description || '', Number(it.expectedQty) || 0]
      );
    }
    return pg.getInbound(id);
  },
  async receiveItem(inboundId, { sku, qty, condition, description, receivedBy, cartonId }) {
    if (cartonId) {
      const { rows } = await pool.query('SELECT * FROM inbound_cartons WHERE id = $1 AND inbound_id = $2', [cartonId, inboundId]);
      const carton = rows[0];
      if (!carton) throw new InboundError('CARTON_NOT_FOUND', 'Carton not found on this inbound');
      if (!carton.label_confirmed) throw new InboundError('CARTON_NOT_LABELED', 'Confirm this carton\'s label before scanning into it');
      if (carton.status === 'closed') {
        await pool.query(`UPDATE inbound_cartons SET status = 'open', closed_at = NULL WHERE id = $1`, [cartonId]);
      }
    }
    const cond = CONDITIONS.includes(condition) ? condition : 'unspecified';
    const { rows } = await pool.query(
      `SELECT * FROM inbound_items WHERE inbound_id = $1 AND LOWER(sku) = LOWER($2)`,
      [inboundId, sku]
    );
    let item = rows[0];
    if (!item) {
      const insert = await pool.query(
        `INSERT INTO inbound_items (id, inbound_id, sku, description, expected_qty)
         VALUES ($1,$2,$3,$4,0) RETURNING *`,
        [crypto.randomUUID(), inboundId, sku, description || '']
      );
      item = insert.rows[0];
    }
    const totals = { ...emptyConditionTotals(), ...(item.condition_totals || {}) };
    totals[cond] += Number(qty);
    await pool.query(
      'UPDATE inbound_items SET received_qty = received_qty + $1, condition_totals = $2 WHERE id = $3',
      [Number(qty), JSON.stringify(totals), item.id]
    );
    const eventId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO inbound_events (id, inbound_id, item_id, carton_id, sku, qty, condition, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [eventId, inboundId, item.id, cartonId || null, item.sku, Number(qty), cond, receivedBy || null]
    );
    const { rows: allItems } = await pool.query(
      'SELECT expected_qty, received_qty FROM inbound_items WHERE inbound_id = $1', [inboundId]
    );
    const status = computeStatus(allItems.map(r => ({ expectedQty: r.expected_qty, receivedQty: r.received_qty })));
    await pool.query('UPDATE inbounds SET status = $1 WHERE id = $2', [status, inboundId]);
    const inbound = await pg.getInbound(inboundId);
    return { ...inbound, lastEventId: eventId, lastItemId: item.id };
  },
  async closeInbound(inboundId, { force } = {}) {
    const inbound = await pg.getInbound(inboundId);
    if (!inbound) return null;
    const { mismatches, extras } = computeMismatches(inbound.items);
    if (!force && (mismatches.length || extras.length)) {
      return { needsConfirm: true, mismatches, extras };
    }
    await pool.query(`UPDATE inbound_cartons SET status = 'closed', closed_at = NOW() WHERE inbound_id = $1 AND status = 'open'`, [inboundId]);
    await pool.query(`UPDATE inbounds SET status = 'completed', active_carton_id = NULL WHERE id = $1`, [inboundId]);
    const updated = await pg.getInbound(inboundId);
    return { ...updated, needsConfirm: false, mismatches, extras };
  },
  async addPhoto(inboundId, { itemId, eventId, caption, buffer, mimeType, uploadedBy }) {
    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO inbound_photos (id, inbound_id, item_id, event_id, caption, mime_type, data, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, item_id, event_id, caption, mime_type, uploaded_by, uploaded_at`,
      [id, inboundId, itemId || null, eventId || null, caption || '', mimeType, buffer, uploadedBy || null]
    );
    return rowToPhotoMeta(rows[0]);
  },
  async getPhotoData(inboundId, photoId) {
    const { rows } = await pool.query(
      'SELECT data, mime_type FROM inbound_photos WHERE inbound_id = $1 AND id = $2',
      [inboundId, photoId]
    );
    if (!rows[0]) return null;
    return { buffer: rows[0].data, mimeType: rows[0].mime_type };
  },

  // ── Cartons ────────────────────────────────────────────────────────
  async createCarton(inboundId) {
    const { rows: existing } = await pool.query(
      'SELECT COALESCE(MAX(carton_num),0)::int AS max_num FROM inbound_cartons WHERE inbound_id = $1', [inboundId]
    );
    const cartonNum = existing[0].max_num + 1;
    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO inbound_cartons (id, inbound_id, carton_num) VALUES ($1,$2,$3) RETURNING *`,
      [id, inboundId, cartonNum]
    );
    return rowToCarton({ ...rows[0], item_count: 0, total_qty: 0 });
  },
  async confirmCartonLabel(inboundId, cartonId) {
    const { rows } = await pool.query(
      `UPDATE inbound_cartons SET label_confirmed = true WHERE id = $1 AND inbound_id = $2 RETURNING *`,
      [cartonId, inboundId]
    );
    if (!rows[0]) return null;
    await pool.query(
      `UPDATE inbounds SET active_carton_id = $1 WHERE id = $2 AND active_carton_id IS NULL`,
      [cartonId, inboundId]
    );
    return rowToCarton({ ...rows[0], item_count: 0, total_qty: 0 });
  },
  async switchCarton(inboundId, cartonId) {
    const { rows } = await pool.query('SELECT * FROM inbound_cartons WHERE id = $1 AND inbound_id = $2', [cartonId, inboundId]);
    if (!rows[0]) return null;
    if (rows[0].status === 'closed') {
      await pool.query(`UPDATE inbound_cartons SET status = 'open', closed_at = NULL WHERE id = $1`, [cartonId]);
    }
    await pool.query('UPDATE inbounds SET active_carton_id = $1 WHERE id = $2', [cartonId, inboundId]);
    return pg.getInbound(inboundId);
  },
  async closeCarton(inboundId, cartonId) {
    const { rows } = await pool.query(
      `UPDATE inbound_cartons SET status = 'closed', closed_at = NOW() WHERE id = $1 AND inbound_id = $2 RETURNING *`,
      [cartonId, inboundId]
    );
    if (!rows[0]) return null;
    await pool.query(
      `UPDATE inbounds SET active_carton_id = NULL WHERE id = $1 AND active_carton_id = $2`,
      [inboundId, cartonId]
    );
    return rowToCarton({ ...rows[0], item_count: 0, total_qty: 0 });
  },
  async cancelCarton(inboundId, cartonId) {
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM inbound_events WHERE carton_id = $1', [cartonId]
    );
    if (countRows[0].n > 0) throw new InboundError('CARTON_NOT_EMPTY', 'Cannot cancel a carton that already has scans');
    await pool.query('DELETE FROM inbound_cartons WHERE id = $1 AND inbound_id = $2', [cartonId, inboundId]);
    await pool.query(
      `UPDATE inbounds SET active_carton_id = NULL WHERE id = $1 AND active_carton_id = $2`,
      [inboundId, cartonId]
    );
    return { cancelled: true };
  },
  async getCartonSlip(inboundId, cartonId) {
    const { rows: crows } = await pool.query('SELECT * FROM inbound_cartons WHERE id = $1 AND inbound_id = $2', [cartonId, inboundId]);
    if (!crows[0]) return null;
    const { rows: irows } = await pool.query('SELECT id, serial, reference, source, type FROM inbounds WHERE id = $1', [inboundId]);
    const { rows: lrows } = await pool.query(
      `SELECT sku, SUM(qty)::int AS qty FROM inbound_events WHERE carton_id = $1 GROUP BY sku ORDER BY sku`, [cartonId]
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(DISTINCT sku)::int AS item_count, COALESCE(SUM(qty),0)::int AS total_qty FROM inbound_events WHERE carton_id = $1`,
      [cartonId]
    );
    return {
      carton: rowToCarton({ ...crows[0], item_count: countRows[0].item_count, total_qty: countRows[0].total_qty }),
      inbound: { id: irows[0].id, serial: irows[0].serial, reference: irows[0].reference, source: irows[0].source, type: irows[0].type },
      lines: lrows,
    };
  },

  // ── Deletion workflow ─────────────────────────────────────────────
  async requestDeletion(inboundId, { reason, requestedBy }) {
    const { rows } = await pool.query('SELECT status, pending_deletion FROM inbounds WHERE id = $1', [inboundId]);
    if (!rows[0]) return null;
    if (rows[0].status === 'completed') throw new InboundError('ALREADY_COMPLETED', 'Completed inbounds cannot be deleted');
    if (rows[0].pending_deletion) throw new InboundError('ALREADY_PENDING', 'A deletion request is already pending for this inbound');
    const pendingDeletion = { reason, requestedBy, requestedAt: new Date().toISOString() };
    await pool.query('UPDATE inbounds SET pending_deletion = $1 WHERE id = $2', [JSON.stringify(pendingDeletion), inboundId]);
    return pg.getInbound(inboundId);
  },
  async listPendingDeletions() {
    const { rows } = await pool.query('SELECT * FROM inbounds WHERE pending_deletion IS NOT NULL ORDER BY created_at DESC');
    return rows.map(r => ({
      id: r.id, serial: r.serial, type: r.type, reference: r.reference, source: r.source,
      status: r.status, pendingDeletion: r.pending_deletion,
    }));
  },
  async approveDeletion(inboundId) {
    const inbound = await pg.getInbound(inboundId);
    if (!inbound) return null;
    await pool.query('DELETE FROM inbounds WHERE id = $1', [inboundId]);
    return inbound;
  },
  async rejectDeletion(inboundId) {
    const { rows } = await pool.query(
      'UPDATE inbounds SET pending_deletion = NULL WHERE id = $1 RETURNING id', [inboundId]
    );
    if (!rows[0]) return null;
    return pg.getInbound(inboundId);
  },
  async directDelete(inboundId) {
    const inbound = await pg.getInbound(inboundId);
    if (!inbound) return null;
    if (inbound.status === 'completed') throw new InboundError('ALREADY_COMPLETED', 'Completed inbounds cannot be deleted');
    await pool.query('DELETE FROM inbounds WHERE id = $1', [inboundId]);
    return inbound;
  },

  // ── Bulk export support ───────────────────────────────────────────
  async listInboundsInRange({ from, to }) {
    const params = [];
    const clauses = [];
    if (from) { params.push(from); clauses.push(`created_at >= $${params.length}`); }
    if (to) { params.push(to); clauses.push(`created_at <= $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT id FROM inbounds ${where} ORDER BY created_at ASC`, params);
    const full = [];
    for (const r of rows) full.push(await pg.getInbound(r.id));
    return full;
  },
};

const impl = hasDb ? pg : json;
module.exports = { ...impl, TYPES, CONDITIONS, InboundError };
