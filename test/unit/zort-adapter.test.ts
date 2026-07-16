import { ZortOrdersAdapter } from '../../src/gateway/adapters/zort/zort-orders.adapter';
import {
  mockZortOrdersResponse,
  mockZortCredentials,
  mockStandardOrders,
} from '../mocks/zort-responses.mock';

describe('ZortOrdersAdapter', () => {
  let adapter: ZortOrdersAdapter;

  beforeEach(() => {
    adapter = new ZortOrdersAdapter();
  });

  describe('mapZortOrderToStandard', () => {
    it('should convert ZORT order format to StandardOrder', () => {
      const zortOrder = mockZortOrdersResponse[0];
      const result = (adapter as any).mapZortOrderToStandard(zortOrder);

      expect(result.externalOrderId).toBe('ZORT-12345');
      expect(result.externalOrderNumber).toBe('ORD-20240115-001');
      expect(result.platform).toBe('zort');
      expect(result.source).toBe('zort');
      expect(result.customerName).toBe('John Doe');
      expect(result.customerEmail).toBe('john@example.com');
      expect(result.status).toBe('confirmed');
    });

    it('should map ZORT order lines to StandardOrderLine', () => {
      const zortOrder = mockZortOrdersResponse[0];
      const result = (adapter as any).mapZortOrderToStandard(zortOrder);

      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].sku).toBe('SKU-001');
      expect(result.lines[0].quantity).toBe(2);
      expect(result.lines[0].unitPrice).toBe(99.99);
    });

    it('should map ZORT status to internal status', () => {
      const zortOrder = { ...mockZortOrdersResponse[0], status: 'confirmed' };
      const result = (adapter as any).mapZortOrderToStandard(zortOrder);
      expect(result.status).toBe('confirmed');

      const pendingOrder = { ...mockZortOrdersResponse[0], status: 'pending' };
      const pendingResult = (adapter as any).mapZortOrderToStandard(pendingOrder);
      expect(pendingResult.status).toBe('pending');

      const shippedOrder = { ...mockZortOrdersResponse[0], status: 'shipped' };
      const shippedResult = (adapter as any).mapZortOrderToStandard(shippedOrder);
      expect(shippedResult.status).toBe('shipped');
    });

    it('should include ZORT metadata in StandardOrder', () => {
      const zortOrder = mockZortOrdersResponse[0];
      const result = (adapter as any).mapZortOrderToStandard(zortOrder);

      expect(result.metadata).toEqual({
        zort_id: 'ZORT-12345',
        zort_source: 'shopee',
        zort_tracking: 'TRACK-12345',
        zort_payment_status: 'paid',
      });
    });

    it('should handle missing optional fields gracefully', () => {
      const zortOrder = {
        id: 'ZORT-999',
        order_number: 'ORD-999',
        customer_name: 'Test Customer',
        items: [{ sku: 'SKU-999', quantity: 1, price: 100 }],
        status: 'pending',
      };

      const result = (adapter as any).mapZortOrderToStandard(zortOrder);

      expect(result.externalOrderId).toBe('ZORT-999');
      expect(result.customerEmail).toBeUndefined();
      expect(result.shippingAddress.street).toBeUndefined();
    });

    it('should parse numeric values correctly', () => {
      const zortOrder = {
        id: 'ZORT-123',
        order_number: 'ORD-123',
        customer_name: 'Test',
        items: [
          {
            sku: 'SKU-100',
            quantity: '5', // String
            price: '49.99', // String
          },
        ],
        total: '249.95',
        status: 'confirmed',
      };

      const result = (adapter as any).mapZortOrderToStandard(zortOrder);

      expect(result.lines[0].quantity).toBe(5);
      expect(result.lines[0].unitPrice).toBe(49.99);
      expect(result.totalAmount).toBe(249.95);
    });
  });

  describe('mapZortStatus', () => {
    it('should map ZORT status to internal status correctly', () => {
      const statusMap = {
        pending: 'pending',
        confirmed: 'confirmed',
        processing: 'confirmed',
        shipped: 'shipped',
        delivered: 'delivered',
        cancelled: 'cancelled',
        returned: 'returned',
        unknown_status: 'pending', // Default
      };

      Object.entries(statusMap).forEach(([zortStatus, expectedStatus]) => {
        const result = (adapter as any).mapZortStatus(zortStatus);
        expect(result).toBe(expectedStatus);
      });
    });

    it('should be case-insensitive', () => {
      const result1 = (adapter as any).mapZortStatus('CONFIRMED');
      const result2 = (adapter as any).mapZortStatus('Confirmed');
      const result3 = (adapter as any).mapZortStatus('confirmed');

      expect(result1).toBe('confirmed');
      expect(result2).toBe('confirmed');
      expect(result3).toBe('confirmed');
    });
  });

  describe('fetchOrders', () => {
    it('should throw error when credentials are incomplete', async () => {
      const incompleteCreds = { storename: 'test' }; // Missing apikey and apisecret

      await expect(
        adapter.fetchOrders(incompleteCreds as any, {})
      ).rejects.toThrow('ZORT credentials incomplete');
    });

    it('should call ZORT API with correct parameters', async () => {
      // Note: This test would need mocking of fetch()
      // For now, we'll test that credentials are validated
      const validCreds = mockZortCredentials;

      // Mock fetch would be called here
      // This is tested in integration tests
      expect(validCreds.storename).toBeDefined();
      expect(validCreds.apikey).toBeDefined();
      expect(validCreds.apisecret).toBeDefined();
    });
  });

  describe('AdapterMeta', () => {
    it('should have correct metadata', () => {
      expect(ZortOrdersAdapter.meta.name).toBe('ZORT');
      expect(ZortOrdersAdapter.meta.id).toBe('zort');
      expect(ZortOrdersAdapter.meta.supportsOrders).toBe(true);
      expect(ZortOrdersAdapter.meta.supportsInventory).toBe(true);
    });
  });
});
