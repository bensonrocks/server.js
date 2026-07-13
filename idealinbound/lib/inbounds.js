'use strict';

// IdealInbound — inbound processing for any inbound mode: air freight, LCL,
// FCL, ecommerce returns, or loose/ad-hoc drop-offs.
//
// Multi-carton: a shipment/return often arrives across more than one
// physical box or pallet. Rather than storing per-carton contents
// redundantly, each receiving event is tagged with the carton it landed in
// (`cartonNum`) and per-carton totals are DERIVED from the event log —
// events are already the permanent record here (unlike a capped audit log),
// so deriving avoids a second source of truth that could drift out of sync.

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

// ── Cartons — derived from the event log, never stored redundantly ────
// `cartons` metadata (num/startedAt/closedAt/labelConfirmed) IS persisted
// (it can't be derived — nothing else records when a box was opened or
// whether its label was confirmed), but each carton's CONTENTS are always
// computed fresh from events tagged with that cartonNum.
function defaultCartons(createdAt) {
  return [{ num: 1, startedAt: createdAt, closedAt: null, labelConfirmed: false }];
}
function withCartonScans(cartons, events) {
  return cartons.map(c => {
    const scans = {};
    for (const e of events) {
      if (e.cartonNum !== c.num) continue;
      scans[e.sku] = (scans[e.sku] || 0) + e.qty;
    }
    return { ...c, scans };
  });
}
function cartonHasScans(cartons, events, num) {
  return events.some(e => e.cartonNum === num);
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
  const cartons = s.cartons && s.cartons.length ? s.cartons : defaultCartons(s.createdAt);
  return {
    id: s.id, type: s.type, reference: s.reference, source: s.source,
    expectedDate: s.expectedDate, status: s.status, createdAt: s.createdAt,
    metadata: s.metadata,
    itemCount: s.items.length,
    totalExpected: s.items.reduce((a, i) => a + i.expectedQty, 0),
    totalReceived: s.items.reduce((a, i) => a + i.receivedQty, 0),
    photoCount: (s.photos || []).length,
    cartonCount: cartons.length,
  };
}
function photoMeta(p) {
  return {
    id: p.id, itemId: p.itemId, eventId: p.eventId, caption: p.caption,
    mimeType: p.mimeType, uploadedBy: p.uploadedBy, uploadedAt: p.uploadedAt,
  };
}
function withPhotoMeta(inbound) {
  const cartons = inbound.cartons && inbound.cartons.length ? inbound.cartons : defaultCartons(inbound.createdAt);
  return {
    ...inbound,
    photos: (inbound.photos || []).map(photoMeta),
    cartons: withCartonScans(cartons, inbound.events || []),
    activeCartonNum: inbound.activeCartonNum || 1,
  };
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
      cartons: [],          // lazily created on first receive — zero friction
      activeCartonNum: 1,   // for jobs that never split, this is the only carton
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
    if (!inbound.cartons || !inbound.cartons.length) {
      inbound.cartons = defaultCartons(inbound.createdAt);
      inbound.activeCartonNum = 1;
    }
    const cartonNum = inbound.activeCartonNum || 1;
    const eventId = crypto.randomUUID();
    inbound.events.push({
      id: eventId,
      itemId: item.id,
      sku: item.sku,
      qty: Number(qty),
      condition: cond,
      cartonNum,
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
    if (inbound.cartons && inbound.cartons.length) {
      const closeTime = new Date().toISOString();
      const last = inbound.cartons[inbound.cartons.length - 1];
      // Drop a still-empty trailing carton (e.g. an accidental "New Carton"
      // tap right before closing) rather than leave a phantom empty box.
      if (inbound.cartons.length > 1 && !cartonHasScans(inbound.cartons, inbound.events, last.num)) {
        inbound.cartons.pop();
      }
      for (const c of inbound.cartons) if (!c.closedAt) c.closedAt = closeTime;
    }
    jsonWrite(list);
    return withPhotoMeta(inbound);
  },
  async startNewCarton(inboundId) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return { error: 'not_found' };
    if (!inbound.cartons || !inbound.cartons.length) inbound.cartons = defaultCartons(inbound.createdAt);
    const current = inbound.cartons.find(c => c.num === (inbound.activeCartonNum || 1)) || inbound.cartons[inbound.cartons.length - 1];
    if (!cartonHasScans(inbound.cartons, inbound.events, current.num)) {
      return { error: 'empty_carton' };
    }
    current.closedAt = new Date().toISOString();
    const nextNum = Math.max(...inbound.cartons.map(c => c.num)) + 1;
    inbound.cartons.push({ num: nextNum, startedAt: new Date().toISOString(), closedAt: null, labelConfirmed: false });
    inbound.activeCartonNum = nextNum;
    jsonWrite(list);
    return { inbound: withPhotoMeta(inbound) };
  },
  async switchCarton(inboundId, num) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return { error: 'not_found' };
    if (!inbound.cartons || !inbound.cartons.find(c => c.num === num)) return { error: 'carton_not_found' };
    inbound.activeCartonNum = num;
    jsonWrite(list);
    return { inbound: withPhotoMeta(inbound) };
  },
  async cancelMultiCarton(inboundId) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return { error: 'not_found' };
    if (!inbound.cartons || inbound.cartons.length <= 1) return { error: 'not_split' };
    const earliest = inbound.cartons.reduce((a, c) => (c.startedAt < a ? c.startedAt : a), inbound.cartons[0].startedAt);
    for (const e of inbound.events) e.cartonNum = 1;
    inbound.cartons = [{ num: 1, startedAt: earliest, closedAt: null, labelConfirmed: true }];
    inbound.activeCartonNum = 1;
    jsonWrite(list);
    return { inbound: withPhotoMeta(inbound) };
  },
  async confirmCartonLabel(inboundId, num) {
    const list = jsonRead();
    const inbound = list.find(s => s.id === inboundId);
    if (!inbound) return { error: 'not_found' };
    if (!inbound.cartons || !inbound.cartons.length) inbound.cartons = defaultCartons(inbound.createdAt);
    let carton = inbound.cartons.find(c => c.num === num);
    if (!carton) { carton = { num, startedAt: new Date().toISOString(), closedAt: null, labelConfirmed: false }; inbound.cartons.push(carton); }
    carton.labelConfirmed = true;
    jsonWrite(list);
    return { inbound: withPhotoMeta(inbound) };
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
function rowToInbound(r, items = [], events = [], photos = [], cartonRows = []) {
  const cartons = cartonRows.length
    ? cartonRows.map(c => ({ num: c.num, startedAt: c.started_at, closedAt: c.closed_at, labelConfirmed: c.label_confirmed }))
    : defaultCartons(r.created_at);
  const rowEvents = events.map(rowToEvent);
  return {
    id: r.id, type: r.type, reference: r.reference, source: r.source,
    expectedDate: r.expected_date, status: r.status, metadata: r.metadata || {},
    createdBy: r.created_by, createdAt: r.created_at,
    items: items.map(rowToItem),
    events: rowEvents,
    photos: photos.map(rowToPhotoMeta),
    cartons: withCartonScans(cartons, rowEvents),
    activeCartonNum: r.active_carton_num || 1,
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
    cartonNum: r.carton_num || 1,
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
    await pool.query(`ALTER TABLE inbounds ADD COLUMN IF NOT EXISTS active_carton_num INTEGER NOT NULL DEFAULT 1`);
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
    await pool.query(`ALTER TABLE inbound_events ADD COLUMN IF NOT EXISTS carton_num INTEGER NOT NULL DEFAULT 1`);
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inbound_cartons (
        id              TEXT PRIMARY KEY,
        inbound_id      TEXT NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
        num             INTEGER NOT NULL,
        started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at       TIMESTAMPTZ,
        label_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE (inbound_id, num)
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
        COALESCE(carton_agg.carton_count, 1)  AS carton_count
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
      id: r.id, type: r.type, reference: r.reference, source: r.source,
      expectedDate: r.expected_date, status: r.status, createdAt: r.created_at,
      metadata: r.metadata || {},
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
    const { rows: crows } = await pool.query('SELECT * FROM inbound_cartons WHERE inbound_id = $1 ORDER BY num', [id]);
    return rowToInbound(srows[0], irows, erows, prows, crows);
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
    // Cartons are lazily created on first receive (see receiveItem) — a
    // job that never splits never gets an inbound_cartons row at all;
    // getInbound()/rowToInbound() falls back to a virtual carton 1.
    return pg.getInbound(id);
  },
  // Ensures an inbound_cartons row exists for the inbound's current active
  // carton, creating carton 1 on first call — mirrors the JSON backend's
  // lazy `defaultCartons()` init exactly.
  async _ensureActiveCartonRow(inboundId, activeCartonNum) {
    const { rows } = await pool.query(
      'SELECT * FROM inbound_cartons WHERE inbound_id = $1 AND num = $2', [inboundId, activeCartonNum]
    );
    if (rows[0]) return rows[0];
    const { rows: inserted } = await pool.query(
      `INSERT INTO inbound_cartons (id, inbound_id, num) VALUES ($1,$2,$3) RETURNING *`,
      [crypto.randomUUID(), inboundId, activeCartonNum]
    );
    return inserted[0];
  },
  async receiveItem(inboundId, { sku, qty, condition, description, receivedBy }) {
    const cond = CONDITIONS.includes(condition) ? condition : 'unspecified';
    const { rows: srows } = await pool.query('SELECT active_carton_num FROM inbounds WHERE id = $1', [inboundId]);
    if (!srows[0]) return null;
    const activeCartonNum = srows[0].active_carton_num || 1;
    await pg._ensureActiveCartonRow(inboundId, activeCartonNum);

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
      `INSERT INTO inbound_events (id, inbound_id, item_id, sku, qty, condition, carton_num, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [eventId, inboundId, item.id, item.sku, Number(qty), cond, activeCartonNum, receivedBy || null]
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
    const { rows: crows } = await pool.query('SELECT * FROM inbound_cartons WHERE inbound_id = $1 ORDER BY num', [inboundId]);
    if (crows.length > 1) {
      const last = crows[crows.length - 1];
      const { rows: lastEvents } = await pool.query(
        'SELECT 1 FROM inbound_events WHERE inbound_id = $1 AND carton_num = $2 LIMIT 1', [inboundId, last.num]
      );
      // Drop a still-empty trailing carton rather than leave a phantom empty box.
      if (!lastEvents.length) await pool.query('DELETE FROM inbound_cartons WHERE id = $1', [last.id]);
    }
    await pool.query(`UPDATE inbound_cartons SET closed_at = NOW() WHERE inbound_id = $1 AND closed_at IS NULL`, [inboundId]);
    await pool.query(`UPDATE inbounds SET status = 'completed' WHERE id = $1`, [inboundId]);
    return pg.getInbound(inboundId);
  },
  async startNewCarton(inboundId) {
    const { rows: srows } = await pool.query('SELECT active_carton_num FROM inbounds WHERE id = $1', [inboundId]);
    if (!srows[0]) return { error: 'not_found' };
    const currentNum = srows[0].active_carton_num || 1;
    await pg._ensureActiveCartonRow(inboundId, currentNum);
    const { rows: currentEvents } = await pool.query(
      'SELECT 1 FROM inbound_events WHERE inbound_id = $1 AND carton_num = $2 LIMIT 1', [inboundId, currentNum]
    );
    if (!currentEvents.length) return { error: 'empty_carton' };
    await pool.query('UPDATE inbound_cartons SET closed_at = NOW() WHERE inbound_id = $1 AND num = $2', [inboundId, currentNum]);
    const { rows: maxRow } = await pool.query('SELECT COALESCE(MAX(num),0) AS max FROM inbound_cartons WHERE inbound_id = $1', [inboundId]);
    const nextNum = maxRow[0].max + 1;
    await pool.query('INSERT INTO inbound_cartons (id, inbound_id, num) VALUES ($1,$2,$3)', [crypto.randomUUID(), inboundId, nextNum]);
    await pool.query('UPDATE inbounds SET active_carton_num = $1 WHERE id = $2', [nextNum, inboundId]);
    return { inbound: await pg.getInbound(inboundId) };
  },
  async switchCarton(inboundId, num) {
    const { rows } = await pool.query('SELECT 1 FROM inbound_cartons WHERE inbound_id = $1 AND num = $2', [inboundId, num]);
    if (!rows.length) return { error: 'carton_not_found' };
    await pool.query('UPDATE inbounds SET active_carton_num = $1 WHERE id = $2', [num, inboundId]);
    return { inbound: await pg.getInbound(inboundId) };
  },
  async cancelMultiCarton(inboundId) {
    const { rows: crows } = await pool.query('SELECT * FROM inbound_cartons WHERE inbound_id = $1 ORDER BY num', [inboundId]);
    if (crows.length <= 1) return { error: 'not_split' };
    const earliest = crows.reduce((a, c) => (c.started_at < a ? c.started_at : a), crows[0].started_at);
    await pool.query('UPDATE inbound_events SET carton_num = 1 WHERE inbound_id = $1', [inboundId]);
    await pool.query('DELETE FROM inbound_cartons WHERE inbound_id = $1', [inboundId]);
    await pool.query(
      'INSERT INTO inbound_cartons (id, inbound_id, num, started_at, label_confirmed) VALUES ($1,$2,1,$3,TRUE)',
      [crypto.randomUUID(), inboundId, earliest]
    );
    await pool.query('UPDATE inbounds SET active_carton_num = 1 WHERE id = $1', [inboundId]);
    return { inbound: await pg.getInbound(inboundId) };
  },
  async confirmCartonLabel(inboundId, num) {
    await pg._ensureActiveCartonRow(inboundId, num);
    await pool.query('UPDATE inbound_cartons SET label_confirmed = TRUE WHERE inbound_id = $1 AND num = $2', [inboundId, num]);
    return { inbound: await pg.getInbound(inboundId) };
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
