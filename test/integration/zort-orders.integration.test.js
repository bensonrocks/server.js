/**
 * Integration tests for ZORT order sync
 * Tests full end-to-end flow: ZORT API → StandardOrder → OrderSync → Database
 */

const createOrderSync = require('../../lib/order-sync');

// Mock database that simulates IDEALONE schema
class IntegrationMockDb {
  constructor() {
    this.data = {
      orders: [],
      orderLines: [],
      syncLog: [],
      skus: [
        { id: 'sku-1', code: 'SKU-LAPTOP', tenantId: 'tenant-1', name: 'Laptop' },
        { id: 'sku-2', code: 'SKU-MOUSE', tenantId: 'tenant-1', name: 'Mouse' },
        { id: 'sku-3', code: 'SKU-KEYBOARD', tenantId: 'tenant-1', name: 'Keyboard' },
      ],
      clients: [],
      inventoryBalance: [
        { sku_id: 'sku-1', tenant_id: 'tenant-1', qty: 100, allocated_qty: 0, available_qty: 100 },
        { sku_id: 'sku-2', tenant_id: 'tenant-1', qty: 500, allocated_qty: 0, available_qty: 500 },
        { sku_id: 'sku-3', tenant_id: 'tenant-1', qty: 200, allocated_qty: 0, available_qty: 200 },
      ],
    };
  }

  prepare(sql) {
    return {
      run: (...params) => {
        if (sql.includes('INSERT INTO orders')) {
          this.data.orders.push({
            id: params[0],
            tenant_id: params[1],
            external_order_id: params[4],
            external_order_source: params[6],
            status: params[7],
            params,
          });
          return { changes: 1 };
        }
        if (sql.includes('INSERT INTO order_lines')) {
          this.data.orderLines.push({
            id: params[0],
            order_id: params[2],
            sku_id: params[4],
            ordered_qty: params[7], // line.quantity is at index 7
            params,
          });
          return { changes: 1 };
        }
        if (sql.includes('INSERT INTO sync_log')) {
          this.data.syncLog.push({ params });
          return { changes: 1 };
        }
        if (sql.includes('INSERT INTO clients')) {
          this.data.clients.push({
            id: params[0],
            tenant_id: params[1],
            name: params[2],
            email: params[3],
            params,
          });
          return { changes: 1 };
        }
        if (sql.includes('UPDATE inventory_balance')) {
          // UPDATE inventory_balance SET allocated_qty = ?, available_qty = ?, updated_at = ? WHERE tenant_id = ? AND sku_id = ?
          const newAllocated = params[0];
          const newAvailable = params[1];
          const tenantId = params[3];
          const skuId = params[4];
          const inv = this.data.inventoryBalance.find((i) => i.sku_id === skuId && i.tenant_id === tenantId);
          if (inv) {
            inv.allocated_qty = newAllocated;
            inv.available_qty = newAvailable;
          }
          return { changes: 1 };
        }
        if (sql.includes('UPDATE orders') && sql.includes('status')) {
          // UPDATE orders SET status = 'allocated', updated_at = ? WHERE id = ?
          const orderId = params[1];
          const order = this.data.orders.find((o) => o.id === orderId);
          if (order) {
            order.status = 'allocated';
          }
          return { changes: 1 };
        }
        return { changes: 0 };
      },
      get: (...params) => {
        if (sql.includes('FROM orders') && sql.includes('external_order_id')) {
          return this.data.orders.find(
            (o) =>
              o.tenant_id === params[0] &&
              o.external_order_id === params[1] &&
              o.external_order_source === params[2]
          );
        }
        if (sql.includes('FROM skus')) {
          return this.data.skus.find((s) => s.code === params[1]);
        }
        if (sql.includes('FROM clients')) {
          return this.data.clients.find((c) => c.tenant_id === params[0]);
        }
        if (sql.includes('FROM inventory_balance')) {
          return this.data.inventoryBalance.find((i) => i.sku_id === params[1]);
        }
        return null;
      },
      all: (...params) => {
        if (sql.includes('FROM order_lines')) {
          return this.data.orderLines.filter((l) => l.order_id === params[0]);
        }
        if (sql.includes('FROM orders') && sql.includes('status')) {
          // Query: SELECT id, warehouse_id FROM orders WHERE tenant_id = ? AND external_order_source = ? AND status = 'pending'
          return this.data.orders.filter(
            (o) => o.tenant_id === params[0] && o.external_order_source === params[1] && o.status === 'pending'
          );
        }
        return [];
      },
    };
  }
}

// Mock ZORT API response
const mockZortApiResponse = {
  data: [
    {
      id: 'ZORT-INT-001',
      order_number: 'ORD-20240120-001',
      created_at: '2024-01-20T10:00:00Z',
      customer_name: 'Alice Johnson',
      customer_email: 'alice@example.com',
      customer_phone: '+1234567890',
      shipping_address: {
        street: '123 Main St',
        city: 'San Francisco',
        state: 'CA',
        postal_code: '94102',
        country: 'USA',
      },
      items: [
        {
          id: 'item-1',
          sku: 'SKU-LAPTOP',
          product_code: 'SKU-LAPTOP',
          quantity: '1',
          price: '999.99',
          notes: 'High-performance laptop',
        },
        {
          id: 'item-2',
          sku: 'SKU-MOUSE',
          product_code: 'SKU-MOUSE',
          quantity: '2',
          price: '29.99',
          notes: 'Wireless mouse',
        },
      ],
      total: '1059.97',
      status: 'confirmed',
      tracking_number: 'TRACK-12345',
      payment_status: 'paid',
      notes: 'Expedited shipping requested',
      warehouse_id: 'WH-001',
    },
    {
      id: 'ZORT-INT-002',
      order_number: 'ORD-20240120-002',
      created_at: '2024-01-20T11:00:00Z',
      customer_name: 'Bob Smith',
      customer_email: 'bob@example.com',
      customer_phone: '+1987654321',
      shipping_address: {
        street: '456 Oak Ave',
        city: 'New York',
        state: 'NY',
        postal_code: '10001',
        country: 'USA',
      },
      items: [
        {
          id: 'item-3',
          sku: 'SKU-KEYBOARD',
          product_code: 'SKU-KEYBOARD',
          quantity: '3',
          price: '89.99',
          notes: 'Mechanical keyboard',
        },
      ],
      total: '269.97',
      status: 'pending',
      tracking_number: null,
      payment_status: 'pending',
      notes: null,
      warehouse_id: 'WH-002',
    },
  ],
  total: 2,
  page: 1,
};

describe('ZORT Integration Tests', () => {
  let orderSync;
  let mockDb;

  beforeEach(() => {
    mockDb = new IntegrationMockDb();
    orderSync = createOrderSync(mockDb);
  });

  describe('End-to-End: Fetch ZORT Orders and Sync to Database', () => {
    it('should sync multiple ZORT orders successfully', async () => {
      // Simulate converting ZORT API response to StandardOrder[]
      const standardOrders = mockZortApiResponse.data.map((zortOrder) => ({
        externalOrderId: String(zortOrder.id),
        externalOrderNumber: zortOrder.order_number,
        platform: 'zort',
        source: 'zort',
        orderDate: zortOrder.created_at,
        customerName: zortOrder.customer_name,
        customerEmail: zortOrder.customer_email,
        customerPhone: zortOrder.customer_phone,
        shippingAddress: zortOrder.shipping_address,
        lines: zortOrder.items.map((item) => ({
          sku: item.sku,
          quantity: parseInt(item.quantity),
          unitPrice: parseFloat(item.price),
        })),
        status: zortOrder.status,
        warehouseId: zortOrder.warehouse_id,
        notes: zortOrder.notes,
        metadata: {
          zort_id: zortOrder.id,
          zort_tracking: zortOrder.tracking_number,
          zort_payment_status: zortOrder.payment_status,
        },
      }));

      const result = await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders: standardOrders,
        userId: 'user-1',
      });

      expect(result.created).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.orders).toHaveLength(2);
      expect(mockDb.data.orders).toHaveLength(2);
      expect(mockDb.data.orderLines).toHaveLength(3); // 1 + 2 line items
    });

    it('should create customers from ZORT order data', async () => {
      const standardOrders = [mockZortApiResponse.data[0]].map((zortOrder) => ({
        externalOrderId: String(zortOrder.id),
        externalOrderNumber: zortOrder.order_number,
        platform: 'zort',
        source: 'zort',
        orderDate: zortOrder.created_at,
        customerName: zortOrder.customer_name,
        customerEmail: zortOrder.customer_email,
        shippingAddress: zortOrder.shipping_address,
        lines: zortOrder.items.map((item) => ({
          sku: item.sku,
          quantity: parseInt(item.quantity),
          unitPrice: parseFloat(item.price),
        })),
        status: zortOrder.status,
      }));

      await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders: standardOrders,
        userId: 'user-1',
      });

      expect(mockDb.data.clients).toHaveLength(1);
      expect(mockDb.data.clients[0].name).toBe('Alice Johnson');
      expect(mockDb.data.clients[0].email).toBe('alice@example.com');
    });

    it('should preserve ZORT metadata in sync_log', async () => {
      const standardOrders = [mockZortApiResponse.data[0]].map((zortOrder) => ({
        externalOrderId: String(zortOrder.id),
        platform: 'zort',
        source: 'zort',
        orderDate: zortOrder.created_at,
        customerName: zortOrder.customer_name,
        lines: zortOrder.items.map((item) => ({
          sku: item.sku,
          quantity: parseInt(item.quantity),
          unitPrice: parseFloat(item.price),
        })),
        status: zortOrder.status,
        metadata: {
          zort_tracking: zortOrder.tracking_number,
          zort_payment_status: zortOrder.payment_status,
        },
      }));

      await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders: standardOrders,
        userId: 'user-1',
      });

      expect(mockDb.data.syncLog).toHaveLength(1);
      const syncLog = mockDb.data.syncLog[0];
      expect(syncLog.params[4]).toBe('zort'); // source_system
      expect(syncLog.params[5]).toBe('ZORT-INT-001'); // external_order_id
    });

    it('should map ZORT status values correctly', async () => {
      const orders = [
        {
          externalOrderId: 'ZORT-CONFIRMED',
          platform: 'zort',
          source: 'zort',
          orderDate: '2024-01-20T10:00:00Z',
          customerName: 'Customer 1',
          lines: [{ sku: 'SKU-LAPTOP', quantity: 1, unitPrice: 999.99 }],
          status: 'confirmed',
        },
        {
          externalOrderId: 'ZORT-PENDING',
          platform: 'zort',
          source: 'zort',
          orderDate: '2024-01-20T10:00:00Z',
          customerName: 'Customer 2',
          lines: [{ sku: 'SKU-MOUSE', quantity: 1, unitPrice: 29.99 }],
          status: 'pending',
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
      expect(mockDb.data.orders[0].status).toBe('confirmed');
      expect(mockDb.data.orders[1].status).toBe('pending');
    });

    it('should handle concurrent sync of same orders without duplication', async () => {
      const standardOrder = {
        externalOrderId: 'ZORT-CONCURRENT',
        platform: 'zort',
        source: 'zort',
        orderDate: '2024-01-20T10:00:00Z',
        customerName: 'Concurrent Test',
        lines: [{ sku: 'SKU-LAPTOP', quantity: 1, unitPrice: 999.99 }],
      };

      // Sync 1
      const result1 = await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders: [standardOrder],
        userId: 'user-1',
      });

      // Sync 2 (concurrent/duplicate)
      const result2 = await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders: [standardOrder],
        userId: 'user-1',
      });

      expect(result1.created).toBe(1);
      expect(result2.created).toBe(0);
      expect(result2.orders[0].status).toBe('duplicate_skipped');
      expect(mockDb.data.orders).toHaveLength(1); // Only 1 order in database
    });

    it('should isolate orders by tenant_id', async () => {
      const order = {
        externalOrderId: 'ZORT-TENANT-TEST',
        platform: 'zort',
        source: 'zort',
        orderDate: '2024-01-20T10:00:00Z',
        customerName: 'Multi-tenant Test',
        lines: [{ sku: 'SKU-LAPTOP', quantity: 1, unitPrice: 999.99 }],
      };

      // Sync for tenant 1
      await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders: [order],
        userId: 'user-1',
      });

      // Sync for tenant 2
      await orderSync.syncOrders({
        tenantId: 'tenant-2',
        source: 'zort',
        platform: 'zort',
        orders: [order],
        userId: 'user-2',
      });

      // Both should be created (different tenants)
      expect(mockDb.data.orders).toHaveLength(2);
      expect(mockDb.data.orders[0].tenant_id).toBe('tenant-1');
      expect(mockDb.data.orders[1].tenant_id).toBe('tenant-2');
    });
  });

  describe('Inventory Queries', () => {
    it('should verify SKU availability before allocation', async () => {
      const orders = [
        {
          externalOrderId: 'ZORT-INV-001',
          platform: 'zort',
          source: 'zort',
          orderDate: '2024-01-20T10:00:00Z',
          customerName: 'Inventory Test',
          lines: [{ sku: 'SKU-LAPTOP', quantity: 50, unitPrice: 999.99 }], // 50 available
        },
      ];

      const result = await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders,
        userId: 'user-1',
      });

      expect(result.created).toBe(1);
      const inv = mockDb.data.inventoryBalance.find((i) => i.sku_id === 'sku-1');
      expect(inv.available_qty).toBe(100); // Not allocated in this phase
    });
  });

  describe('Auto-Allocation (Phase 3)', () => {
    it('should auto-allocate inventory when called', async () => {
      const orders = [
        {
          externalOrderId: 'ZORT-ALLOC-001',
          platform: 'zort',
          source: 'zort',
          orderDate: '2024-01-20T10:00:00Z',
          customerName: 'Auto-Alloc Test',
          lines: [{ sku: 'SKU-LAPTOP', quantity: 10, unitPrice: 999.99 }],
          status: 'pending',
        },
      ];

      // Sync order
      await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders,
        userId: 'user-1',
      });

      // Auto-allocate
      const result = await orderSync.autoAllocateNewOrders('tenant-1', 'zort');

      expect(result.allocated).toBe(1);
      expect(result.failed).toBe(0);

      // Verify inventory was updated
      const inv = mockDb.data.inventoryBalance.find((i) => i.sku_id === 'sku-1');
      expect(inv.allocated_qty).toBe(10);
      expect(inv.available_qty).toBe(90); // 100 - 10
    });

    it('should fail allocation if insufficient inventory', async () => {
      const orders = [
        {
          externalOrderId: 'ZORT-ALLOC-002',
          platform: 'zort',
          source: 'zort',
          orderDate: '2024-01-20T10:00:00Z',
          customerName: 'Insufficient Inventory',
          lines: [{ sku: 'SKU-LAPTOP', quantity: 150, unitPrice: 999.99 }], // Only 100 available
          status: 'pending',
        },
      ];

      // Sync order
      await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders,
        userId: 'user-1',
      });

      // Auto-allocate (should fail)
      const result = await orderSync.autoAllocateNewOrders('tenant-1', 'zort');

      expect(result.allocated).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toMatch(/Insufficient inventory/);
    });

    it('should allocate multiple line items per order', async () => {
      const orders = [
        {
          externalOrderId: 'ZORT-ALLOC-003',
          platform: 'zort',
          source: 'zort',
          orderDate: '2024-01-20T10:00:00Z',
          customerName: 'Multi-line Order',
          lines: [
            { sku: 'SKU-LAPTOP', quantity: 5, unitPrice: 999.99 },
            { sku: 'SKU-MOUSE', quantity: 20, unitPrice: 29.99 },
          ],
          status: 'pending',
        },
      ];

      // Sync order
      await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders,
        userId: 'user-1',
      });

      // Auto-allocate
      const result = await orderSync.autoAllocateNewOrders('tenant-1', 'zort');

      expect(result.allocated).toBe(1);

      // Verify both SKUs allocated
      const laptop = mockDb.data.inventoryBalance.find((i) => i.sku_id === 'sku-1');
      const mouse = mockDb.data.inventoryBalance.find((i) => i.sku_id === 'sku-2');

      expect(laptop.allocated_qty).toBe(5);
      expect(laptop.available_qty).toBe(95);
      expect(mouse.allocated_qty).toBe(20);
      expect(mouse.available_qty).toBe(480);
    });

    it('should prevent over-allocation across multiple orders', async () => {
      const orders = [
        {
          externalOrderId: 'ZORT-ALLOC-004',
          platform: 'zort',
          source: 'zort',
          orderDate: '2024-01-20T10:00:00Z',
          customerName: 'Order 1',
          lines: [{ sku: 'SKU-LAPTOP', quantity: 60, unitPrice: 999.99 }],
          status: 'pending',
        },
        {
          externalOrderId: 'ZORT-ALLOC-005',
          platform: 'zort',
          source: 'zort',
          orderDate: '2024-01-20T10:00:00Z',
          customerName: 'Order 2',
          lines: [{ sku: 'SKU-LAPTOP', quantity: 50, unitPrice: 999.99 }], // Total 110 > 100
          status: 'pending',
        },
      ];

      // Sync both orders
      await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders,
        userId: 'user-1',
      });

      // Auto-allocate
      const result = await orderSync.autoAllocateNewOrders('tenant-1', 'zort');

      // First order allocated, second failed
      expect(result.allocated).toBe(1);
      expect(result.failed).toBe(1);

      const laptop = mockDb.data.inventoryBalance.find((i) => i.sku_id === 'sku-1');
      expect(laptop.allocated_qty).toBe(60); // Only first order allocated
      expect(laptop.available_qty).toBe(40);
    });
  });

  describe('Error Scenarios', () => {
    it('should skip orders with invalid SKU', async () => {
      const orders = [
        {
          externalOrderId: 'ZORT-INVALID-SKU',
          platform: 'zort',
          source: 'zort',
          orderDate: '2024-01-20T10:00:00Z',
          customerName: 'Invalid SKU Test',
          lines: [{ sku: 'SKU-NONEXISTENT', quantity: 1, unitPrice: 99.99 }],
        },
      ];

      const result = await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders,
        userId: 'user-1',
      });

      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toMatch(/SKU not found/);
      expect(mockDb.data.orders).toHaveLength(0);
    });

    it('should handle mixed valid and invalid orders', async () => {
      const orders = [
        {
          externalOrderId: 'ZORT-VALID',
          platform: 'zort',
          source: 'zort',
          orderDate: '2024-01-20T10:00:00Z',
          customerName: 'Valid Order',
          lines: [{ sku: 'SKU-LAPTOP', quantity: 1, unitPrice: 999.99 }],
        },
        {
          externalOrderId: 'ZORT-INVALID',
          platform: 'zort',
          source: 'zort',
          orderDate: '2024-01-20T10:00:00Z',
          customerName: 'Invalid Order',
          lines: [{ sku: 'SKU-BADSKU', quantity: 1, unitPrice: 99.99 }],
        },
      ];

      const result = await orderSync.syncOrders({
        tenantId: 'tenant-1',
        source: 'zort',
        platform: 'zort',
        orders,
        userId: 'user-1',
      });

      expect(result.created).toBe(1);
      expect(result.failed).toBe(1);
      expect(mockDb.data.orders).toHaveLength(1);
    });
  });
});
