'use strict';

// IdealOne OMS — inbound processing (ASN receiving) for warehouses.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { pool, hasDb } = require('./db');

function computeStatus(items) {
  if (items.every(i => i.receivedQty === 0)) return 'expected';
  if (items.every(i => i.receivedQty >= i.expectedQty)) return 'completed';
  return 'receiving';
}

// ── JSON fallback (no DATABASE_URL) ───────────────────────────────────
const FILE = path.join(__dirname, '../data/oms-shipments.json');

function jsonRead() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function jsonWrite(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}
function summarize(s) {
  return {
    id: s.id, reference: s.reference, supplier: s.supplier,
    expectedDate: s.expectedDate, status: s.status, createdAt: s.createdAt,
    itemCount: s.items.length,
    totalExpected: s.items.reduce((a, i) => a + i.expectedQty, 0),
    totalReceived: s.items.reduce((a, i) => a + i.receivedQty, 0),
  };
}

const json = {
  async init() {},
  async listShipments() {
    return jsonRead().map(summarize).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  async getShipment(id) {
    return jsonRead().find(s => s.id === id) || null;
  },
  async createShipment({ reference, supplier, expectedDate, items, createdBy }) {
    const list = jsonRead();
    const shipment = {
      id: crypto.randomUUID(),
      reference,
      supplier,
      expectedDate: expectedDate || null,
      status: 'expected',
      createdBy: createdBy || null,
      createdAt: new Date().toISOString(),
      items: items.map(it => ({
        id: crypto.randomUUID(),
        sku: it.sku,
        description: it.description || '',
        expectedQty: Number(it.expectedQty) || 0,
        receivedQty: 0,
      })),
      events: [],
    };
    list.push(shipment);
    jsonWrite(list);
    return shipment;
  },
  async receiveItem(shipmentId, { sku, qty, receivedBy }) {
    const list = jsonRead();
    const shipment = list.find(s => s.id === shipmentId);
    if (!shipment) return null;
    const item = shipment.items.find(i => i.sku.toLowerCase() === sku.toLowerCase());
    if (!item) return null;
    item.receivedQty += Number(qty);
    shipment.events.push({
      id: crypto.randomUUID(),
      itemId: item.id,
      sku: item.sku,
      qty: Number(qty),
      receivedBy: receivedBy || null,
      receivedAt: new Date().toISOString(),
    });
    shipment.status = computeStatus(shipment.items);
    jsonWrite(list);
    return shipment;
  },
};

// ── PostgreSQL backend ─────────────────────────────────────────────────
function rowToShipment(r, items = [], events = []) {
  return {
    id: r.id, reference: r.reference, supplier: r.supplier,
    expectedDate: r.expected_date, status: r.status,
    createdBy: r.created_by, createdAt: r.created_at,
    items: items.map(rowToItem),
    events: events.map(rowToEvent),
  };
}
function rowToItem(r) {
  return { id: r.id, sku: r.sku, description: r.description, expectedQty: r.expected_qty, receivedQty: r.received_qty };
}
function rowToEvent(r) {
  return { id: r.id, itemId: r.item_id, sku: r.sku, qty: r.qty, receivedBy: r.received_by, receivedAt: r.received_at };
}

const pg = {
  async init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS oms_shipments (
        id            TEXT PRIMARY KEY,
        reference     TEXT NOT NULL,
        supplier      TEXT NOT NULL,
        expected_date DATE,
        status        TEXT NOT NULL DEFAULT 'expected',
        created_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS oms_shipment_items (
        id            TEXT PRIMARY KEY,
        shipment_id   TEXT NOT NULL REFERENCES oms_shipments(id) ON DELETE CASCADE,
        sku           TEXT NOT NULL,
        description   TEXT,
        expected_qty  INTEGER NOT NULL,
        received_qty  INTEGER NOT NULL DEFAULT 0
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS oms_receiving_events (
        id            TEXT PRIMARY KEY,
        shipment_id   TEXT NOT NULL REFERENCES oms_shipments(id) ON DELETE CASCADE,
        item_id       TEXT NOT NULL REFERENCES oms_shipment_items(id) ON DELETE CASCADE,
        sku           TEXT NOT NULL,
        qty           INTEGER NOT NULL,
        received_by   TEXT,
        received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  },
  async listShipments() {
    const { rows } = await pool.query(`
      SELECT s.*,
        COUNT(i.id)::int AS item_count,
        COALESCE(SUM(i.expected_qty),0)::int AS total_expected,
        COALESCE(SUM(i.received_qty),0)::int AS total_received
      FROM oms_shipments s
      LEFT JOIN oms_shipment_items i ON i.shipment_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);
    return rows.map(r => ({
      id: r.id, reference: r.reference, supplier: r.supplier,
      expectedDate: r.expected_date, status: r.status, createdAt: r.created_at,
      itemCount: r.item_count, totalExpected: r.total_expected, totalReceived: r.total_received,
    }));
  },
  async getShipment(id) {
    const { rows: srows } = await pool.query('SELECT * FROM oms_shipments WHERE id = $1', [id]);
    if (!srows[0]) return null;
    const { rows: irows } = await pool.query('SELECT * FROM oms_shipment_items WHERE shipment_id = $1 ORDER BY sku', [id]);
    const { rows: erows } = await pool.query('SELECT * FROM oms_receiving_events WHERE shipment_id = $1 ORDER BY received_at', [id]);
    return rowToShipment(srows[0], irows, erows);
  },
  async createShipment({ reference, supplier, expectedDate, items, createdBy }) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO oms_shipments (id, reference, supplier, expected_date, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [id, reference, supplier, expectedDate || null, createdBy || null]
    );
    for (const it of items) {
      await pool.query(
        `INSERT INTO oms_shipment_items (id, shipment_id, sku, description, expected_qty) VALUES ($1,$2,$3,$4,$5)`,
        [crypto.randomUUID(), id, it.sku, it.description || '', Number(it.expectedQty) || 0]
      );
    }
    return pg.getShipment(id);
  },
  async receiveItem(shipmentId, { sku, qty, receivedBy }) {
    const { rows } = await pool.query(
      `SELECT * FROM oms_shipment_items WHERE shipment_id = $1 AND LOWER(sku) = LOWER($2)`,
      [shipmentId, sku]
    );
    const item = rows[0];
    if (!item) return null;
    await pool.query('UPDATE oms_shipment_items SET received_qty = received_qty + $1 WHERE id = $2', [Number(qty), item.id]);
    await pool.query(
      `INSERT INTO oms_receiving_events (id, shipment_id, item_id, sku, qty, received_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [crypto.randomUUID(), shipmentId, item.id, item.sku, Number(qty), receivedBy || null]
    );
    const { rows: allItems } = await pool.query(
      'SELECT expected_qty, received_qty FROM oms_shipment_items WHERE shipment_id = $1', [shipmentId]
    );
    const status = computeStatus(allItems.map(r => ({ expectedQty: r.expected_qty, receivedQty: r.received_qty })));
    await pool.query('UPDATE oms_shipments SET status = $1 WHERE id = $2', [status, shipmentId]);
    return pg.getShipment(shipmentId);
  },
};

module.exports = hasDb ? pg : json;
