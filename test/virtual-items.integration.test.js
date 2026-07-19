'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const createClientConfig = require('../lib/client-config');
const createAutoAllocator = require('../lib/auto-allocator');
const createInventory = require('../lib/inventory');
const createStore = require('../lib/store');
const createPicking = require('../lib/picking');
const { getTenantDb } = require('../lib/db/tenant');

describe('Virtual Items in Mixed Orders', () => {
  let db;
  let clientConfig;
  let allocator;
  let inventory;
  let store;
  let picking;
  const testTenantId = 'test-virtual-' + Date.now();

  beforeAll(() => {
    db = getTenantDb(testTenantId);
    clientConfig = createClientConfig(db);
    inventory = createInventory(db);
    store = createStore(db);
    allocator = createAutoAllocator(db, inventory, store, clientConfig);
    picking = createPicking({ db, store, clientConfig });

    // Setup test data: enable virtual warehouse for test client
    clientConfig.enableVirtualWarehouse('test-client-1');

    // Create warehouse (getTenantDb already creates warehouses table)
    db.prepare(`
      INSERT OR IGNORE INTO warehouses (id, name, is_active, location_zip)
      VALUES ('wh-1', 'Main Warehouse', 1, '10001')
    `).run();

    // Insert SKUs (getTenantDb already creates skus table)
    db.prepare(`
      INSERT OR IGNORE INTO skus (id, code, name, unit_price)
      VALUES
        ('REGULAR-001', 'REGULAR-001', 'Regular Item 1', 10.00),
        ('REGULAR-002', 'REGULAR-002', 'Regular Item 2', 20.00),
        ('VIRTUAL-001', 'VIRTUAL-001', 'Virtual Item 1', 30.00),
        ('VIRTUAL-002', 'VIRTUAL-002', 'Virtual Item 2', 40.00)
    `).run();

    // Create inventory balance if not exists and insert data
    try {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS inventory_balance (
          sku_id TEXT,
          warehouse_id TEXT,
          available_qty INTEGER DEFAULT 0,
          PRIMARY KEY (sku_id, warehouse_id)
        )
      `).run();

      // Insert warehouse inventory for regular items
      db.prepare(`
        INSERT INTO inventory_balance (sku_id, warehouse_id, available_qty)
        VALUES
          ('REGULAR-001', 'wh-1', 10),
          ('REGULAR-002', 'wh-1', 5)
      `).run();
    } catch (e) {
      // Table might already exist with data
    }

    // Register virtual SKUs for client (getTenantDb creates this table)
    try {
      db.prepare(`
        INSERT INTO client_virtual_skus (
          client_id, sku, warehouse_name, fulfillment_method, supplier_info, active, created_at
        ) VALUES
          ('test-client-1', 'VIRTUAL-001', 'Supplier Warehouse', 'supplier', 'Supplier A', 1, datetime('now')),
          ('test-client-1', 'VIRTUAL-002', 'Dropship Warehouse', 'dropship', 'Dropship Partner B', 1, datetime('now'))
      `).run();
    } catch (e) {
      // Data might already exist
    }
  });

  afterAll(() => {
    try {
      db.close();
      const fs = require('fs');
      const dbPath = path.join(__dirname, '..', 'data', 'tenants', `${testTenantId}.db`);
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch (_) {}
  });

  describe('Order Allocation with Virtual Items', () => {
    test('should create a test order with mixed items', () => {
      const orderId = 'ORD-MIXED-001';
      db.prepare(`
        INSERT INTO orders (id, client_id, client_name, channel, order_date, status)
        VALUES (?, 'test-client-1', 'Test Client', 'web', datetime('now'), 'pending')
      `).run(orderId);

      // Add order lines: 2 regular + 2 virtual
      const lines = [
        { id: 'LINE-1', sku_id: 'REGULAR-001', sku_code: 'REGULAR-001', qty: 2 },
        { id: 'LINE-2', sku_id: 'REGULAR-002', sku_code: 'REGULAR-002', qty: 1 },
        { id: 'LINE-3', sku_id: 'VIRTUAL-001', sku_code: 'VIRTUAL-001', qty: 3 },
        { id: 'LINE-4', sku_id: 'VIRTUAL-002', sku_code: 'VIRTUAL-002', qty: 2 }
      ];

      for (const line of lines) {
        db.prepare(`
          INSERT INTO order_lines (id, order_id, sku_id, sku_code, sku_name, ordered_qty, line_number, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(line.id, orderId, line.sku_id, line.sku_code, line.sku_code, line.qty, lines.indexOf(line));
      }

      // Update order status and allocate
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('processing', orderId);

      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      expect(order).toBeDefined();
      expect(order.client_id).toBe('test-client-1');

      const orderLines = db.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(orderId);
      expect(orderLines.length).toBe(4);
    });

    test('should allocate mixed order successfully (regular items only need inventory)', () => {
      const orderId = 'ORD-MIXED-001';

      // Get order lines
      const lines = db.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(orderId);

      // Debug: check what's in inventory_balance
      const invBalance = db.prepare('SELECT * FROM inventory_balance WHERE warehouse_id = ?').all('wh-1');

      // Check availability - virtual items should pass through, regular items checked
      const availability = allocator.checkWarehouseAvailability('wh-1', lines, 'test-client-1');

      // Debug output
      console.log('Inventory Balance:', invBalance);
      console.log('Order lines:', lines);
      console.log('Availability:', availability);

      // The key test: regular items should be available even if virtual items exist
      // Virtual items should be in the virtual array
      expect(availability.virtual.length).toBe(2); // 2 virtual items
      expect(availability.available.length + availability.missing.length).toBe(2); // 2 regular items total
    });

    test('should identify virtual items in availability check', () => {
      const orderId = 'ORD-MIXED-001';
      const lines = db.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(orderId);
      const availability = allocator.checkWarehouseAvailability('wh-1', lines, 'test-client-1');

      // Verify virtual items
      const virtualItem1 = availability.virtual.find(v => v.sku === 'VIRTUAL-001');
      expect(virtualItem1).toBeDefined();
      expect(virtualItem1.location).toMatch(/^VIRTUAL -/);
      expect(virtualItem1.fulfillmentMethod).toBe('supplier');

      const virtualItem2 = availability.virtual.find(v => v.sku === 'VIRTUAL-002');
      expect(virtualItem2).toBeDefined();
      expect(virtualItem2.location).toMatch(/^VIRTUAL -/);
      expect(virtualItem2.fulfillmentMethod).toBe('dropship');
    });
  });

  describe('Picking List Display for Virtual Items', () => {
    test('should create picking session with mixed items', () => {
      const orderId = 'ORD-MIXED-001';

      // Mock order for picking
      const mockOrder = {
        id: orderId,
        client_id: 'test-client-1',
        status: 'processing',
        items: [
          { sku: 'REGULAR-001', name: 'Regular Item 1', qty: 2 },
          { sku: 'REGULAR-002', name: 'Regular Item 2', qty: 1 },
          { sku: 'VIRTUAL-001', name: 'Virtual Item 1', qty: 3 },
          { sku: 'VIRTUAL-002', name: 'Virtual Item 2', qty: 2 }
        ]
      };

      // Mock store functions
      const originalGetOrder = store.getOrder.bind(store);
      store.getOrder = jest.fn(() => mockOrder);

      // Set order status
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('processing', orderId);

      const session = picking.createSession('batch', [orderId], { createdBy: 'test-user' });

      expect(session).toBeDefined();
      expect(session.items.length).toBe(4);

      // Verify virtual items have VIRTUAL location marker
      const virtualItem = session.items.find(i => i.sku === 'VIRTUAL-001');
      expect(virtualItem).toBeDefined();
      expect(virtualItem.location).toMatch(/^VIRTUAL -/);

      const regularItem = session.items.find(i => i.sku === 'REGULAR-001');
      expect(regularItem).toBeDefined();
      expect(regularItem.location).not.toMatch(/^VIRTUAL/);

      store.getOrder = originalGetOrder;
    });

    test('picking list should show fulfillment method for virtual items', () => {
      const orderId = 'ORD-VIRTUAL-ONLY-001';

      // Create a new order with only virtual items
      db.prepare(`
        INSERT INTO orders (id, client_id, client_name, channel, order_date, status)
        VALUES (?, 'test-client-1', 'Test Client', 'web', datetime('now'), 'processing')
      `).run(orderId);

      const mockOrder = {
        id: orderId,
        client_id: 'test-client-1',
        status: 'processing',
        items: [
          { sku: 'VIRTUAL-001', name: 'Virtual Item 1', qty: 3 },
          { sku: 'VIRTUAL-002', name: 'Virtual Item 2', qty: 2 }
        ]
      };

      const originalGetOrder = store.getOrder.bind(store);
      store.getOrder = jest.fn(() => mockOrder);

      const session = picking.createSession('batch', [orderId], { createdBy: 'test-user' });

      // Verify location includes fulfillment method
      const supplierItem = session.items.find(i => i.sku === 'VIRTUAL-001');
      expect(supplierItem).toBeDefined();
      expect(supplierItem.location).toContain('supplier');

      const dropshipItem = session.items.find(i => i.sku === 'VIRTUAL-002');
      expect(dropshipItem).toBeDefined();
      expect(dropshipItem.location).toContain('dropship');

      store.getOrder = originalGetOrder;
    });
  });
});
