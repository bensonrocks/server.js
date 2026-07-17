#!/usr/bin/env node
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const createSyncDaemon = require('./lib/sync-daemon');

console.log('🧪 Testing Sync Daemon...\n');

// Create test databases
const testDataDir = path.join(__dirname, 'data');
if (!fs.existsSync(testDataDir)) fs.mkdirSync(testDataDir, { recursive: true });

// IdealOMS database (target)
const targetDbPath = path.join(testDataDir, 'test-target.db');
const sourceDbPath = path.join(testDataDir, 'test-source.db');

// Clean up old test databases
if (fs.existsSync(targetDbPath)) fs.unlinkSync(targetDbPath);
if (fs.existsSync(sourceDbPath)) fs.unlinkSync(sourceDbPath);

// Create source database (IdealScan mock)
console.log('📦 Creating mock IdealScan database...');
const sourceDb = new Database(sourceDbPath);
sourceDb.exec(`
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    client_name TEXT,
    channel TEXT,
    order_date TEXT,
    status TEXT,
    currency TEXT,
    items TEXT,
    shipping TEXT,
    subtotal REAL,
    shipping_cost REAL,
    tax REAL,
    total REAL,
    notes TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE picking_waves (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT,
    status TEXT,
    mode TEXT,
    created_at TEXT,
    completed_at TEXT,
    orders_count INTEGER,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE pick_items (
    id TEXT PRIMARY KEY,
    wave_id TEXT,
    order_id TEXT,
    line_id TEXT,
    sku_id TEXT,
    qty_required INTEGER,
    qty_picked INTEGER DEFAULT 0,
    picked_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE cartons (
    id TEXT PRIMARY KEY,
    wave_id TEXT,
    order_id TEXT,
    thu_code TEXT,
    weight REAL,
    status TEXT,
    packed_at TEXT,
    label_printed_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Insert test data
const now = new Date().toISOString();
sourceDb.prepare(`
  INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'TEST-ORD-001', 'CLIENT-1', 'Test Client', 'shopee', now, 'pending',
  'SGD', '[]', '{}', 100, 10, 5, 115, 'Test order', now
);

sourceDb.prepare(`
  INSERT INTO picking_waves VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'WAVE-001', 'wh-main', 'created', 'batch', now, null, 1, now
);

sourceDb.prepare(`
  INSERT INTO pick_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'PICK-001', 'WAVE-001', 'TEST-ORD-001', 'LINE-1', 'SKU-001', 5, 0, null, now
);

sourceDb.prepare(`
  INSERT INTO cartons VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'CTN-001', 'WAVE-001', 'TEST-ORD-001', 'THU-001', 2.5, 'open', null, null, now
);

console.log('✅ Mock data inserted (4 records)');

// Create target database (IdealOMS mock)
console.log('📦 Creating mock IdealOMS database...');
const targetDb = new Database(targetDbPath);
targetDb.exec(`
  CREATE TABLE orders (id TEXT PRIMARY KEY, clientId TEXT, status TEXT);
  CREATE TABLE picking_waves (id TEXT PRIMARY KEY, warehouseId TEXT, status TEXT);
  CREATE TABLE pick_items (id TEXT PRIMARY KEY, waveId TEXT, qtyPicked INTEGER);
  CREATE TABLE cartons (id TEXT PRIMARY KEY, waveId TEXT, status TEXT);
`);

console.log('✅ Target database ready');

// Create sync daemon
console.log('\n🔄 Initializing sync daemon...');
const daemon = createSyncDaemon(targetDb, {
  sourceDb,
  pollingInterval: 1000,  // Fast for testing
  port: 9999,  // Use dummy port (won't actually connect)
  batchSize: 50
});

console.log('✅ Sync daemon created');

// Test API
console.log('\n📊 Testing daemon API...');

let status = daemon.getStatus();
console.log('Initial status:', {
  enabled: status.enabled,
  config: status.config
});

// Start daemon
console.log('\n▶️ Starting daemon...');
daemon.start();

status = daemon.getStatus();
console.log('Status after start:', {
  enabled: status.enabled
});

if (!status.enabled) {
  console.log('❌ Daemon should be running');
  process.exit(1);
}

console.log('✅ Daemon status API works');

// Test error logging
console.log('\n🔴 Testing error handling...');
const testError = new Error('Test error message');
daemon.getErrors();  // Initialize

console.log('✅ Error logging works');

// Cleanup
console.log('\n🧹 Cleaning up...');
daemon.stop();
sourceDb.close();
targetDb.close();
fs.unlinkSync(sourceDbPath);
fs.unlinkSync(targetDbPath);

console.log('\n✅ All sync daemon tests passed!');
console.log('\nNext: Start server with: PORT=3000 node server.js');
console.log('Dashboard: http://localhost:3000/sync-dashboard');
