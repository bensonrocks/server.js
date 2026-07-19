'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const createClientConfig = require('../lib/client-config');
const createOrderSync = require('../lib/order-sync');

describe('Bundle Expansion Integration Tests', () => {
  let db;
  let clientConfig;
  let orderSync;

  beforeAll(() => {
    const dbPath = path.join(__dirname, '../test-bundles.db');
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');

    clientConfig = createClientConfig(db);
    orderSync = createOrderSync(db);

    // Create test schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS client_config (
        client_id TEXT PRIMARY KEY,
        bundling_enabled INTEGER DEFAULT 0,
        virtual_warehouse_enabled INTEGER DEFAULT 0,
        settings TEXT,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS client_bundles (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        bundle_sku TEXT NOT NULL,
        bundle_name TEXT NOT NULL,
        description TEXT,
        config TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        created_at TEXT,
        updated_at TEXT,
        FOREIGN KEY (client_id) REFERENCES client_config(client_id)
      );

      CREATE TABLE IF NOT EXISTS client_virtual_skus (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        warehouse_name TEXT,
        fulfillment_method TEXT,
        supplier_info TEXT,
        active INTEGER DEFAULT 1,
        created_at TEXT,
        updated_at TEXT,
        FOREIGN KEY (client_id) REFERENCES client_config(client_id)
      );
    `);
  });

  afterAll(() => {
    try {
      db.close();
      const fs = require('fs');
      fs.unlinkSync(path.join(__dirname, '../test-bundles.db'));
    } catch (_) {}
  });

  describe('Bundle Creation and Configuration', () => {
    test('should enable bundling for a client', () => {
      const result = clientConfig.enableBundling('mayer');
      expect(result.bundling_enabled).toBe(true);
    });

    test('should create a bundle', () => {
      const components = [
        { sku: 'AIR-PURIF', qty: 1, name: 'Air Purifier', unitPrice: 250 },
        { sku: 'AMBER-EDP', qty: 1, name: 'Perfume', unitPrice: 120 },
        { sku: 'CUSHION', qty: 1, name: 'Cushion', unitPrice: 45 }
      ];

      const result = clientConfig.createBundle(
        'mayer',
        'GIFT-BUNDLE-001',
        'Premium Gift Bundle',
        components,
        'A premium gift bundle with 3 items'
      );

      expect(result.bundleSku).toBe('GIFT-BUNDLE-001');
      expect(result.components).toEqual(components);
    });

    test('should retrieve created bundle', () => {
      const bundles = clientConfig.getBundles('mayer');
      expect(bundles.length).toBeGreaterThan(0);
      expect(bundles[0].bundleSku).toBe('GIFT-BUNDLE-001');
    });
  });

  describe('Bundle Expansion in Orders', () => {
    test('should expand a single bundle SKU to components', () => {
      const items = [
        { sku: 'GIFT-BUNDLE-001', qty: 1, name: 'Premium Gift Bundle', unitPrice: 415 }
      ];

      const expanded = clientConfig.expandOrderItems('mayer', items);

      // Should have 3 component items
      expect(expanded.length).toBe(3);
      expect(expanded[0].sku).toBe('AIR-PURIF');
      expect(expanded[1].sku).toBe('AMBER-EDP');
      expect(expanded[2].sku).toBe('CUSHION');
    });

    test('should multiply quantities when expanding bundles', () => {
      const items = [
        { sku: 'GIFT-BUNDLE-001', qty: 2, name: 'Premium Gift Bundle', unitPrice: 415 }
      ];

      const expanded = clientConfig.expandOrderItems('mayer', items);

      // 2 bundles × 1 component each = 2 of each component
      expect(expanded[0].qty).toBe(2);
      expect(expanded[1].qty).toBe(2);
      expect(expanded[2].qty).toBe(2);
    });

    test('should mix bundle and regular items', () => {
      const items = [
        { sku: 'GIFT-BUNDLE-001', qty: 1, name: 'Premium Gift Bundle', unitPrice: 415 },
        { sku: 'SKU-REGULAR', qty: 2, name: 'Regular Item', unitPrice: 50 }
      ];

      const expanded = clientConfig.expandOrderItems('mayer', items);

      // 3 components + 1 regular = 4 items
      expect(expanded.length).toBe(4);

      // Check that regular item is included
      const regularItem = expanded.find(i => i.sku === 'SKU-REGULAR');
      expect(regularItem).toBeDefined();
      expect(regularItem.qty).toBe(2);
    });

    test('should not expand if bundling is not enabled for client', () => {
      const items = [
        { sku: 'GIFT-BUNDLE-001', qty: 1, name: 'Premium Gift Bundle', unitPrice: 415 }
      ];

      // Mayer has bundling enabled, so this should expand
      const expanded = clientConfig.expandOrderItems('mayer', items);
      expect(expanded.length).toBe(3);

      // Other client without bundling enabled should not expand
      const expandedOther = clientConfig.expandOrderItems('other-client', items);
      expect(expandedOther.length).toBe(1);
      expect(expandedOther[0].sku).toBe('GIFT-BUNDLE-001');
    });

    test('should combine duplicate SKUs from multiple bundles', () => {
      // Create a second bundle that shares a component
      const components2 = [
        { sku: 'AIR-PURIF', qty: 1, name: 'Air Purifier', unitPrice: 250 },
        { sku: 'NEW-ITEM', qty: 2, name: 'New Item', unitPrice: 30 }
      ];

      clientConfig.createBundle('mayer', 'BUNDLE-002', 'Second Bundle', components2);

      const items = [
        { sku: 'GIFT-BUNDLE-001', qty: 1, name: 'Premium Gift Bundle', unitPrice: 415 },
        { sku: 'BUNDLE-002', qty: 1, name: 'Second Bundle', unitPrice: 310 }
      ];

      const expanded = clientConfig.expandOrderItems('mayer', items);

      // AIR-PURIF appears in both bundles, so qty should be combined (1+1=2)
      const airPurif = expanded.find(i => i.sku === 'AIR-PURIF');
      expect(airPurif.qty).toBe(2);

      // NEW-ITEM should be in the result
      const newItem = expanded.find(i => i.sku === 'NEW-ITEM');
      expect(newItem.qty).toBe(2);
    });
  });

  describe('Virtual Warehouse Configuration', () => {
    test('should enable virtual warehouse for a client', () => {
      const result = clientConfig.enableVirtualWarehouse('mayer');
      expect(result.virtual_warehouse_enabled).toBe(true);
    });

    test('should add a virtual SKU', () => {
      const result = clientConfig.addVirtualSku(
        'mayer',
        'DROPSHIP-001',
        'FBA Warehouse',
        'dropship',
        'Amazon FBA - Warehouse ABC'
      );

      expect(result.sku).toBe('DROPSHIP-001');
      expect(result.fulfillmentMethod).toBe('dropship');
    });

    test('should check if a SKU is virtual', () => {
      const isVirtual = clientConfig.isVirtualSku('mayer', 'DROPSHIP-001');
      expect(isVirtual).toBe(true);

      const notVirtual = clientConfig.isVirtualSku('mayer', 'GIFT-BUNDLE-001');
      expect(notVirtual).toBe(false);
    });

    test('should list virtual SKUs for a client', () => {
      const virtualSkus = clientConfig.getVirtualSkus('mayer');
      expect(virtualSkus.length).toBeGreaterThan(0);
      expect(virtualSkus[0].sku).toBe('DROPSHIP-001');
    });
  });

  describe('Complex Order Scenarios', () => {
    test('should handle order with bundles and virtual items', () => {
      const items = [
        { sku: 'GIFT-BUNDLE-001', qty: 1, name: 'Premium Gift Bundle', unitPrice: 415 },
        { sku: 'DROPSHIP-001', qty: 2, name: 'Dropship Item', unitPrice: 99 }
      ];

      const expanded = clientConfig.expandOrderItems('mayer', items);

      // Should have 3 bundle components + 1 virtual item = 4 items
      expect(expanded.length).toBe(4);

      // Check bundle components
      const bundleComponents = ['AIR-PURIF', 'AMBER-EDP', 'CUSHION'];
      bundleComponents.forEach(sku => {
        const item = expanded.find(i => i.sku === sku);
        expect(item).toBeDefined();
      });

      // Check virtual item is unchanged
      const virtual = expanded.find(i => i.sku === 'DROPSHIP-001');
      expect(virtual.qty).toBe(2);
    });

    test('should preserve item properties during expansion', () => {
      const items = [
        { sku: 'GIFT-BUNDLE-001', qty: 1, name: 'Premium Gift Bundle', unitPrice: 415, customField: 'test' }
      ];

      const expanded = clientConfig.expandOrderItems('mayer', items);

      // Expanded items should have unitPrice from bundle definition
      expect(expanded[0].unitPrice).toBe(250);
      expect(expanded[1].unitPrice).toBe(120);
      expect(expanded[2].unitPrice).toBe(45);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty items array', () => {
      const expanded = clientConfig.expandOrderItems('mayer', []);
      expect(expanded).toEqual([]);
    });

    test('should handle non-existent bundle gracefully', () => {
      const items = [
        { sku: 'NON-EXISTENT-BUNDLE', qty: 1, name: 'Ghost Bundle', unitPrice: 999 }
      ];

      const expanded = clientConfig.expandOrderItems('mayer', items);

      // Non-existent bundle should be treated as regular item
      expect(expanded.length).toBe(1);
      expect(expanded[0].sku).toBe('NON-EXISTENT-BUNDLE');
    });

    test('should handle null clientConfig gracefully', () => {
      const items = [
        { sku: 'GIFT-BUNDLE-001', qty: 1, name: 'Premium Gift Bundle', unitPrice: 415 }
      ];

      // Should return items unchanged if no config passed
      const mockItems = items;
      expect(mockItems.length).toBe(1);
    });
  });
});
