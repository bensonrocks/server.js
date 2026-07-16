/**
 * Unit tests for OrderSync service
 */

const createOrderSync = require('../../lib/order-sync');

// Mock database
class MockDb {
  constructor() {
    this.data = {
      orders: [],
      orderLines: [],
      syncLog: [],
      skus: [
        { id: 'sku-1', code: 'SKU-001', tenantId: 'tenant-1' },
        { id: 'sku-2', code: 'SKU-002', tenantId: 'tenant-1' },
      ],
      clients: [],
    };
  }

  prepare(sql) {
    return {
      run: (...params) => {
        if (sql.includes('INSERT INTO orders')) {
          // Store orders with their field values for duplicate detection
          // Parameters match the INSERT statement in order-sync.js line 146-162
          this.data.orders.push({
            id: params[0],           // orderId
            tenant_id: params[1],    // tenantId
            external_order_id: params[4],   // order.externalOrderId
            external_order_source: params[6], // source
            params,
            sql,
          });
          return { changes: 1 };
        }
        if (sql.includes('INSERT INTO order_lines')) {
          this.data.orderLines.push({ params, sql });
          return { changes: 1 };
        }
        if (sql.includes('INSERT INTO sync_log')) {
          this.data.syncLog.push({ params, sql });
          return { changes: 1 };
        }
        if (sql.includes('INSERT INTO clients')) {
          this.data.clients.push({
            id: params[0],
            tenant_id: params[1],
            params,
          });
          return { changes: 1 };
        }
        return { changes: 0 };
      },
      get: (...params) => {
        if (sql.includes('FROM orders') && sql.includes('external_order_id')) {
          return this.data.orders.find(
            (o) => o.tenant_id === params[0] && o.external_order_id === params[1] && o.external_order_source === params[2]
          );
        }
        if (sql.includes('FROM skus')) {
          return this.data.skus.find((s) => s.code === params[1]);
        }
        if (sql.includes('FROM clients')) {
          return this.data.clients.find((c) => c.tenant_id === params[0] && (c.params[2] === params[1] || c.params[3] === params[1]));
        }
        return null;
      },
      all: (...params) => {
        if (sql.includes('FROM order_lines')) {
          return this.data.orderLines;
        }
        return [];
      },
    };
  }
}

describe('OrderSync Service', () => {
  let orderSync;
  let mockDb;

  beforeEach(() => {
    mockDb = new MockDb();
    orderSync = createOrderSync(mockDb);
  });

  describe('syncOrders', () => {
    it('should require tenantId, source, and orders[]', async () => {
      await expect(
        orderSync.syncOrders({
          // Missing tenantId
          source: 'zort',
          orders: [],
        })
      ).rejects.toThrow();

      await expect(
        orderSync.syncOrders({
          tenantId: 'tenant-1',
          // Missing source
          orders: [],
        })
      ).rejects.toThrow();

      await expect(
        orderSync.syncOrders({
          tenantId: 'tenant-1',
          source: 'zort',
          // Missing orders or not array
        })
      ).rejects.toThrow();
    });

    it('should return result structure with counters', async () => {
      const result = await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders: [],
        userId: 'user-1',
      });

      expect(result).toHaveProperty('created');
      expect(result).toHaveProperty('updated');
      expect(result).toHaveProperty('failed');
      expect(result).toHaveProperty('errors');
      expect(result).toHaveProperty('orders');
      expect(Array.isArray(result.orders)).toBe(true);
    });

    it('should handle empty orders array', async () => {
      const result = await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders: [],
        userId: 'user-1',
      });

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.orders).toHaveLength(0);
    });

    it('should process valid orders', async () => {
      const order = {
        externalOrderId: 'ZORT-12345',
        externalOrderNumber: 'ORD-001',
        platform: 'zort',
        source: 'zort',
        orderDate: '2024-01-15T10:00:00Z',
        customerName: 'Test Customer',
        customerEmail: 'test@example.com',
        lines: [
          {
            sku: 'SKU-001',
            quantity: 2,
            unitPrice: 99.99,
          },
        ],
        status: 'confirmed',
        warehouseId: 'WH-001',
      };

      const result = await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders: [order],
        userId: 'user-1',
      });

      expect(result.created).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockDb.data.orders.length).toBeGreaterThan(0);
    });

    it('should reject orders with missing SKU', async () => {
      const order = {
        externalOrderId: 'ZORT-12346',
        externalOrderNumber: 'ORD-002',
        platform: 'zort',
        source: 'zort',
        orderDate: '2024-01-15T10:00:00Z',
        customerName: 'Test Customer',
        lines: [
          {
            sku: 'SKU-NONEXISTENT', // This SKU doesn't exist
            quantity: 2,
            unitPrice: 99.99,
          },
        ],
      };

      const result = await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders: [order],
        userId: 'user-1',
      });

      expect(result.failed).toBe(1);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toMatch(/SKU not found/);
    });

    it('should detect duplicate orders', async () => {
      const order = {
        externalOrderId: 'ZORT-DUPLICATE',
        externalOrderNumber: 'ORD-DUP',
        platform: 'zort',
        source: 'zort',
        orderDate: '2024-01-15T10:00:00Z',
        customerName: 'Test Customer',
        lines: [
          {
            sku: 'SKU-001',
            quantity: 1,
            unitPrice: 99.99,
          },
        ],
      };

      // First sync
      const result1 = await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders: [order],
        userId: 'user-1',
      });

      expect(result1.created).toBe(1);

      // Second sync (should detect duplicate)
      const result2 = await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders: [order],
        userId: 'user-1',
      });

      expect(result2.created).toBe(0); // No new orders created
      expect(result2.orders[0].status).toBe('duplicate_skipped');
    });

    it('should handle multiple orders in batch', async () => {
      const orders = [
        {
          externalOrderId: 'ZORT-001',
          platform: 'zort',
          source: 'zort',
          orderDate: '2024-01-15T10:00:00Z',
          customerName: 'Customer 1',
          lines: [{ sku: 'SKU-001', quantity: 1, unitPrice: 100 }],
        },
        {
          externalOrderId: 'ZORT-002',
          platform: 'zort',
          source: 'zort',
          orderDate: '2024-01-15T10:00:00Z',
          customerName: 'Customer 2',
          lines: [{ sku: 'SKU-002', quantity: 2, unitPrice: 50 }],
        },
      ];

      const result = await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders,
        userId: 'user-1',
      });

      expect(result.created).toBe(2);
      expect(result.failed).toBe(0);
    });
  });

  describe('syncSingleOrder', () => {
    it('should create order record in database', async () => {
      const order = {
        externalOrderId: 'ZORT-TEST',
        platform: 'zort',
        source: 'zort',
        orderDate: '2024-01-15T10:00:00Z',
        customerName: 'Test Customer',
        lines: [{ sku: 'SKU-001', quantity: 1, unitPrice: 99.99 }],
      };

      const result = await orderSync.syncSingleOrder({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        order,
        userId: 'user-1',
      });

      expect(result.created).toBe(true);
      expect(result.orderId).toBeDefined();
      expect(mockDb.data.orders.length).toBeGreaterThan(0);
    });

    it('should create order lines for each line item', async () => {
      const order = {
        externalOrderId: 'ZORT-LINES',
        platform: 'zort',
        source: 'zort',
        orderDate: '2024-01-15T10:00:00Z',
        customerName: 'Test Customer',
        lines: [
          { sku: 'SKU-001', quantity: 2, unitPrice: 50 },
          { sku: 'SKU-002', quantity: 1, unitPrice: 75 },
        ],
      };

      const initialLineCount = mockDb.data.orderLines.length;

      await orderSync.syncSingleOrder({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        order,
        userId: 'user-1',
      });

      const newLineCount = mockDb.data.orderLines.length;
      expect(newLineCount - initialLineCount).toBe(2);
    });

    it('should store sync metadata in audit log', async () => {
      const order = {
        externalOrderId: 'ZORT-AUDIT',
        platform: 'zort',
        source: 'zort',
        orderDate: '2024-01-15T10:00:00Z',
        customerName: 'Test Customer',
        lines: [{ sku: 'SKU-001', quantity: 1, unitPrice: 99.99 }],
        metadata: { test_field: 'test_value' },
      };

      await orderSync.syncSingleOrder({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        order,
        userId: 'user-1',
      });

      expect(mockDb.data.syncLog.length).toBeGreaterThan(0);
    });
  });

  describe('autoAllocateNewOrders', () => {
    it('should be callable (full test in integration)', async () => {
      // Unit test: just verify the method exists and can be called
      const result = await orderSync.autoAllocateNewOrders('tenant-1', 'zort');

      expect(result).toHaveProperty('allocated');
      expect(typeof result.allocated).toBe('number');
    });
  });
});
