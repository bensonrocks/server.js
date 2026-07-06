'use strict';

// IdealInbound — inbound processing for any inbound mode: air freight, LCL,
// FCL, ecommerce returns, or loose/ad-hoc drop-offs.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { pool, hasDb } = require('./db');

const TYPES = ['air', 'lcl', 'fcl', 'return', 'loose'];
const CONDITIONS = ['sellable', 'damaged', 'refurbish', 'dispose', 'unspecified'];

function emptyConditionTotals() {
  return { sellable: 0, damaged: 0, refurbish: 0, dispose: 0, unspecified: 0 };
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
    id: s.id, type: s.type, reference: s.reference, source: s.source,
    expectedDate: s.expectedDate, status: s.status, createdAt: s.createdAt,
    metadata: s.metadata,
    itemCount: s.items.length,
    totalExpected: s.items.reduce((a, i) => a + i.expectedQty, 0),
    totalReceived: s.items.reduce((a, i) => a + i.receivedQty, 0),
    photoCount: (s.photos || []).length,
  };
}
function photoMeta(p) {
  return {
    id: p.id, itemId: p.itemId, eventId: p.eventId, caption: p.caption,
    mimeType: p.mimeType, uploadedBy: p.uploadedBy, uploadedAt: p.uploadedAt,
  };
}
function withPhotoMeta(inbound) {
  return { ...inbound, photos: (inbound.photos || []).map(photoMeta) };
}

const json = {
  async init() {},
  async listInbounds({ type } = {}) {
    let list = jsonRead().map(summarize);
    if (type) list = list.filter(s => s.type === type);
    return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  async getInbound(id) {
    const inbound = jsonRead().find(s => s.id === id);
    return inbound ? withPhotoMeta(inbound) : null;
  },
  async createInbound({ type, reference, source, expectedDate, metadata, items, createdBy }) {
    const list = jsonRead();
    const inbound = {
      id: crypto.randomUUID(),
      type,
      reference,
      source,
      expectedDate: expectedDate || null,
      metadata: metadata || {},
      status: 'expected',
      createdBy: createdBy || null,
      createdAt: new Date().toISOString(),
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
    };
    list.push(inbound);
    jsonWrite(list);
    return withPhotoMeta(inbound);
  },
  async receiveItem(inboundId, { sku, qty, condition, description, receivedBy }) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    const cond = CONDITIONS.includes(condition) ? condition : 'unspecified';
    let item = inbound.items.find(i => i.sku.toLowerCase() === sku.toLowerCase());
    if (!item) {
      item = {
        id: crypto.randomUUID(),
        sku,
        description: description || '',
        expectedQty: 0,
        receivedQty: 0,
        conditionTotals: emptyConditionTotals(),
      };
      inbound.items.push(item);
    }
    item.receivedQty += Number(qty);
    item.conditionTotals[cond] += Number(qty);
    const eventId = crypto.randomUUID();
    inbound.events.push({
      id: eventId,
      itemId: item.id,
      sku: item.sku,
      qty: Number(qty),
      condition: cond,
      receivedBy: receivedBy || null,
      receivedAt: new Date().toISOString(),
    });
    inbound.status = computeStatus(inbound.items);
    jsonWrite(list);
    return { ...withPhotoMeta(inbound), lastEventId: eventId, lastItemId: item.id };
  },
  async closeInbound(inboundId) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    inbound.status = 'completed';
    jsonWrite(list);
    return withPhotoMeta(inbound);
  },
  async addPhoto(inboundId, { itemId, eventId, caption, buffer, mimeType, uploadedBy }) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return null;
    if (!inbound.photos) inbound.photos = [];
    const photo = {
      id: crypto.randomUUID(),
      itemId: itemId || null,
      eventId: eventId || null,
      caption: caption || '',
      mimeType,
      dataBase64: buffer.toString('base64'),
      uploadedBy: uploadedBy || null,
      uploadedAt: new Date().toISOString(),
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
};

// ── PostgreSQL backend ─────────────────────────────────────────────────
function rowToInbound(r, items = [], events = [], photos = []) {
  return {
    id: r.id, type: r.type, reference: r.reference, source: r.source,
    expectedDate: r.expected_date, status: r.status, metadata: r.metadata || {},
    createdBy: r.created_by, createdAt: r.created_at,
    items: items.map(rowToItem),
    events: events.map(rowToEvent),
    photos: photos.map(rowToPhotoMeta),
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
    receivedBy: r.received_by, receivedAt: r.received_at,
  };
}
function rowToPhotoMeta(r) {
  return {
    id: r.id, itemId: r.item_id, eventId: r.event_id, caption: r.caption,
    mimeType: r.mime_type, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
  };
}

const pg = {
  async init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inbounds (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL,
        reference     TEXT NOT NULL,
        source        TEXT NOT NULL,
        expected_date DATE,
        status        TEXT NOT NULL DEFAULT 'expected',
        metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      CREATE TABLE IF NOT EXISTS inbound_events (
        id            TEXT PRIMARY KEY,
        inbound_id    TEXT NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
        item_id       TEXT NOT NULL REFERENCES inbound_items(id) ON DELETE CASCADE,
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
        COALESCE(photo_agg.photo_count, 0)    AS photo_count
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
      ${where}
      ORDER BY s.created_at DESC
    `, params);
    return rows.map(r => ({
      id: r.id, type: r.type, reference: r.reference, source: r.source,
      expectedDate: r.expected_date, status: r.status, createdAt: r.created_at,
      metadata: r.metadata || {},
      itemCount: r.item_count, totalExpected: r.total_expected, totalReceived: r.total_received,
      photoCount: r.photo_count,
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
    return rowToInbound(srows[0], irows, erows, prows);
  },
  async createInbound({ type, reference, source, expectedDate, metadata, items, createdBy }) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO inbounds (id, type, reference, source, expected_date, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, type, reference, source, expectedDate || null, JSON.stringify(metadata || {}), createdBy || null]
    );
    for (const it of (items || [])) {
      await pool.query(
        `INSERT INTO inbound_items (id, inbound_id, sku, description, expected_qty) VALUES ($1,$2,$3,$4,$5)`,
        [crypto.randomUUID(), id, it.sku, it.description || '', Number(it.expectedQty) || 0]
      );
    }
    return pg.getInbound(id);
  },
  async receiveItem(inboundId, { sku, qty, condition, description, receivedBy }) {
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
      `INSERT INTO inbound_events (id, inbound_id, item_id, sku, qty, condition, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [eventId, inboundId, item.id, item.sku, Number(qty), cond, receivedBy || null]
    );
    const { rows: allItems } = await pool.query(
      'SELECT expected_qty, received_qty FROM inbound_items WHERE inbound_id = $1', [inboundId]
    );
    const status = computeStatus(allItems.map(r => ({ expectedQty: r.expected_qty, receivedQty: r.received_qty })));
    await pool.query('UPDATE inbounds SET status = $1 WHERE id = $2', [status, inboundId]);
    const inbound = await pg.getInbound(inboundId);
    return { ...inbound, lastEventId: eventId, lastItemId: item.id };
  },
  async closeInbound(inboundId) {
    await pool.query(`UPDATE inbounds SET status = 'completed' WHERE id = $1`, [inboundId]);
    return pg.getInbound(inboundId);
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
};

const impl = hasDb ? pg : json;
module.exports = { ...impl, TYPES, CONDITIONS };
