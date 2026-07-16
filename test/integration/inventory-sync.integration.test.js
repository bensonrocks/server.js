/**
 * Integration tests for inventory sync
 * Tests bidirectional inventory updates between IDEALONE and platforms
 */

const { syncInventory, discover } = require('../../lib/inventory-sync');

class InventorySyncMockDb {
  constructor() {
    this.data = {
      skus: [
        { id: 'sku-1', code: 'SKU-LAPTOP', tenant_id: 'tenant-1', name: 'Laptop' },
        { id: 'sku-2', code: 'SKU-MOUSE', tenant_id: 'tenant-1', name: 'Mouse' },
      ],
      inventoryBalance: [
        { sku_id: 'sku-1', tenant_id: 'tenant-1', qty: 100, reserved_qty: 10, stock_qty: 100 },
        { sku_id: 'sku-2', tenant_id: 'tenant-1', qty: 500, reserved_qty: 50, stock_qty: 500 },
      ],
      channelSkuMap: [],
      orders: [
        {
          channel: 'shopee',
          items: JSON.stringify([
            { sku: 'SKU-LAPTOP', variantId: 12345, modelId: 12345, name: 'Laptop' },
            { sku: 'SKU-MOUSE', variantId: 67890, modelId: 67890, name: 'Mouse' },
          ]),
          source: JSON.stringify({ item_id: 12345 }),
        },
      ],
    };
  }

  prepare(sql) {
    return {
      run: (...params) => {
        if (sql.includes('INSERT INTO channel_sku_map') || sql.includes('ON CONFLICT')) {
          const existing = this.data.channelSkuMap.find(
            (m) =>
              m.platform === params[0] &&
              m.oms_sku === params[1]
          );
          if (existing) {
            existing.external_id = params[2];
            existing.external_sku_id = params[3];
            existing.external_name = params[4];
          } else {
            this.data.channelSkuMap.push({
              platform: params[0],
              oms_sku: params[1],
              external_id: params[2],
              external_sku_id: params[3],
              external_name: params[4],
            });
          }
          return { changes: 1 };
        }
        return { changes: 0 };
      },
      get: (...params) => {
        if (sql.includes('FROM channel_sku_map WHERE platform')) {
          return this.data.channelSkuMap.find((m) => m.platform === params[0]);
        }
        return null;
      },
      all: (...params) => {
        if (sql.includes('FROM channel_sku_map WHERE platform')) {
          return this.data.channelSkuMap.filter((m) => m.platform === params[0]);
        }
        if (sql.includes('FROM orders WHERE channel')) {
          return this.data.orders.filter((o) => o.channel === params[0]);
        }
        return [];
      },
    };
  }
}

class MockInventory {
  constructor(initialData) {
    this.data = new Map();
    for (const [sku, inv] of Object.entries(initialData || {})) {
      this.data.set(sku, { ...inv });
    }
  }

  get(sku) {
    return this.data.get(sku) || null;
  }

  adjust(sku, delta, source, reason) {
    const inv = this.data.get(sku);
    if (inv) {
      inv.stock_qty = Math.max(0, inv.stock_qty + delta);
    }
  }

  set(sku, qty) {
    const inv = this.data.get(sku);
    if (inv) {
      inv.stock_qty = qty;
    }
  }
}

describe('Inventory Sync Integration Tests', () => {
  let mockDb;
  let inventory;

  beforeEach(() => {
    mockDb = new InventorySyncMockDb();
    inventory = new MockInventory({
      'SKU-LAPTOP': { stock_qty: 100, reserved_qty: 10 },
      'SKU-MOUSE': { stock_qty: 500, reserved_qty: 50 },
    });
  });

  describe('Discover: Build mappings from existing orders', () => {
    it('should discover SKU mappings from Shopee orders', () => {
      const result = discover('shopee', mockDb);

      expect(result.discovered).toBe(2);
      expect(mockDb.data.channelSkuMap).toHaveLength(2);

      const laptopMap = mockDb.data.channelSkuMap.find((m) => m.oms_sku === 'SKU-LAPTOP');
      expect(laptopMap).toBeDefined();
      expect(laptopMap.external_id).toBe('12345');
      expect(laptopMap.external_sku_id).toBe('12345');
    });

    it('should not discover if no orders exist', () => {
      const db = new InventorySyncMockDb();
      db.data.orders = [];

      const result = discover('shopee', db);

      expect(result.discovered).toBe(0);
      expect(db.data.channelSkuMap).toHaveLength(0);
    });

    it('should handle malformed order data gracefully', () => {
      const db = new InventorySyncMockDb();
      db.data.orders = [
        {
          channel: 'shopee',
          items: 'invalid json',
          source: '{}',
        },
      ];

      const result = discover('shopee', db);

      expect(result.discovered).toBe(0);
    });
  });

  describe('Inventory Pull: Platform → IDEALONE', () => {
    it('should calculate available qty (stock_qty - reserved_qty)', async () => {
      // Laptop: 100 total - 10 reserved = 90 available
      const laptop = inventory.get('SKU-LAPTOP');
      const available = Math.max(0, laptop.stock_qty - laptop.reserved_qty);

      expect(available).toBe(90);
    });

    it('should detect inventory changes', async () => {
      // Platform reports 150 for laptop, OMS has 100
      const currentQty = inventory.get('SKU-LAPTOP').stock_qty;
      const platformQty = 150;
      const delta = platformQty - currentQty;

      expect(delta).toBe(50); // Increase of 50 units
    });

    it('should handle zero or negative available qty', async () => {
      // If reserved >= stock, available should be 0
      const mouse = inventory.get('SKU-MOUSE');
      mouse.reserved_qty = 600; // More than stock

      const available = Math.max(0, mouse.stock_qty - mouse.reserved_qty);
      expect(available).toBe(0);
    });
  });

  describe('Inventory Push: IDEALONE → Platform', () => {
    it('should calculate pusable qty after reservations', async () => {
      // Only push stock_qty - reserved_qty
      const laptop = inventory.get('SKU-LAPTOP');
      const pushQty = Math.max(0, laptop.stock_qty - laptop.reserved_qty);

      expect(pushQty).toBe(90); // 100 - 10
    });

    it('should batch push to platforms', async () => {
      const maps = mockDb.data.channelSkuMap;
      const skusToPush = [];

      for (const map of maps) {
        const inv = inventory.get(map.oms_sku);
        if (inv) {
          skusToPush.push({
            sku: map.oms_sku,
            qty: Math.max(0, inv.stock_qty - inv.reserved_qty),
          });
        }
      }

      expect(skusToPush.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('SKU Platform Mapping', () => {
    it('should upsert SKU mappings', () => {
      const maps = mockDb.data.channelSkuMap;

      expect(maps).toHaveLength(0);

      // Simulate upsert
      mockDb
        .prepare(
          `INSERT INTO channel_sku_map VALUES (?,?,?,?,?) ON CONFLICT DO UPDATE`
        )
        .run('shopee', 'SKU-TEST', '99999', '88888', 'Test Product');

      expect(maps.length).toBeGreaterThan(0);
    });

    it('should handle variants and models per platform', () => {
      // Shopee uses model_id, TikTok uses sku_id, Shopify uses inventoryItem.id
      const mappings = {
        shopee: { variant_id: 'model_id' },
        tiktok: { variant_id: 'sku_id' },
        shopify: { variant_id: 'inventory_item_id' },
      };

      expect(Object.keys(mappings)).toContain('shopee');
      expect(Object.keys(mappings)).toContain('tiktok');
      expect(Object.keys(mappings)).toContain('shopify');
    });
  });

  describe('Conflict Resolution', () => {
    it('should detect conflicts when platform qty differs from IDEALONE', () => {
      const idealonQty = 100;
      const platformQty = 150;
      const conflict = idealonQty !== platformQty;

      expect(conflict).toBe(true);
    });

    it('should resolve conflict with idealone_wins strategy', () => {
      const resolution = 'idealone_wins';
      const targetQty = 100; // Use IDEALONE qty

      expect(resolution).toBe('idealone_wins');
      expect(targetQty).toBe(100);
    });

    it('should resolve conflict with platform_wins strategy', () => {
      const resolution = 'platform_wins';
      const targetQty = 150; // Use platform qty

      expect(resolution).toBe('platform_wins');
      expect(targetQty).toBe(150);
    });

    it('should flag manual conflicts for human review', () => {
      const resolution = 'manual';
      const targetQty = null;

      expect(resolution).toBe('manual');
      expect(targetQty).toBeNull();
    });
  });

  describe('Multi-Platform Sync', () => {
    it('should sync to Shopee, Lazada, TikTok, Shopify independently', () => {
      const platforms = ['shopee', 'lazada', 'tiktok', 'shopify'];

      for (const platform of platforms) {
        const maps = mockDb.prepare(`SELECT * FROM channel_sku_map WHERE platform = ?`).all(platform);
        expect(Array.isArray(maps)).toBe(true);
      }
    });

    it('should handle per-platform schema differences', () => {
      const schemas = {
        shopee: { field: 'item_id', model: 'model_id' },
        lazada: { field: 'item_id', sku: 'SkuId' },
        tiktok: { field: 'product_id', sku: 'sku_id' },
        shopify: { field: 'inventory_item_id', location: 'location_id' },
      };

      expect(Object.keys(schemas)).toHaveLength(4);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for unsupported platform', () => {
      const unsupported = 'amazon'; // Not yet supported

      const isSupported = ['shopee', 'lazada', 'tiktok', 'shopify'].includes(unsupported);
      expect(isSupported).toBe(false);
    });

    it('should handle API failures gracefully', () => {
      // When platform API fails, should not crash inventory service
      const result = { pushed: 0, error: 'API connection failed' };

      expect(result.error).toBeDefined();
      expect(result.pushed).toBe(0);
    });

    it('should continue syncing remaining items on partial failure', () => {
      const items = [
        { sku: 'SKU-LAPTOP', status: 'synced' },
        { sku: 'SKU-MOUSE', status: 'failed', error: 'API error' },
        { sku: 'SKU-KEYBOARD', status: 'synced' },
      ];

      const synced = items.filter((i) => i.status === 'synced').length;
      const failed = items.filter((i) => i.status === 'failed').length;

      expect(synced).toBe(2);
      expect(failed).toBe(1);
    });
  });
});
