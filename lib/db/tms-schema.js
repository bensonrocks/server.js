'use strict';

/**
 * TMS Schema — Transport Management System tables
 * Extends WMS with delivery tracking, routing, and status management
 */

function initTmsSchema(db) {
  // Address Book — store locations with chain support
  db.exec(`
    CREATE TABLE IF NOT EXISTS address_book (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain TEXT,
      name TEXT NOT NULL UNIQUE,
      code TEXT,
      address TEXT,
      zip TEXT NOT NULL,
      phone TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_address_book_zip ON address_book(zip);
    CREATE INDEX IF NOT EXISTS idx_address_book_name ON address_book(name);
  `);

  // Depot Settings — configurable warehouse start location
  db.exec(`
    CREATE TABLE IF NOT EXISTS depot_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zip TEXT NOT NULL DEFAULT '609216',
      address TEXT NOT NULL DEFAULT '40 Penjuru Lane #04-01',
      updated_at TEXT
    );
  `);

  // Delivery Jobs — individual deliveries with status lifecycle
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tms_id TEXT NOT NULL UNIQUE,
      order_id TEXT,
      store TEXT,
      address TEXT,
      zip TEXT,
      phone TEXT,
      cartons TEXT,
      driver TEXT,
      status TEXT DEFAULT 'preplanned',
      pod_remarks TEXT,
      created_at TEXT,
      updated_at TEXT,
      delivered_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_jobs_status ON delivery_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_delivery_jobs_driver ON delivery_jobs(driver);
    CREATE INDEX IF NOT EXISTS idx_delivery_jobs_delivered_at ON delivery_jobs(delivered_at);
  `);

  // Delivery Routes — batch deliveries assigned to drivers
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id TEXT NOT NULL UNIQUE,
      job_ids TEXT NOT NULL,
      driver TEXT,
      vehicle TEXT,
      status TEXT DEFAULT 'planning',
      estimated_km REAL,
      estimated_mins INTEGER,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_routes_status ON delivery_routes(status);
  `);

  // Note: user feature toggles are stored in mainDb.staff_users, not tenant db

  console.log('[TMS Schema] Initialized: address_book, depot_settings, delivery_jobs, delivery_routes');
}

module.exports = { initTmsSchema };
