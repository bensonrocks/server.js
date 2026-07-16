/**
 * Global test setup and utilities
 */

// Set test environment
process.env.NODE_ENV = 'test';

// Global test utilities
global.testUtils = {
  /**
   * Create mock ZORT credentials
   */
  mockZortCreds: () => ({
    storename: 'test@example.com',
    apikey: 'test-key-123',
    apisecret: 'test-secret-456',
  }),

  /**
   * Create mock StandardOrder
   */
  mockStandardOrder: (overrides = {}) => ({
    externalOrderId: 'TEST-001',
    externalOrderNumber: 'ORD-001',
    platform: 'zort',
    source: 'zort',
    orderDate: new Date().toISOString(),
    customerName: 'Test Customer',
    customerEmail: 'test@example.com',
    lines: [
      {
        sku: 'SKU-TEST',
        quantity: 1,
        unitPrice: 99.99,
      },
    ],
    status: 'confirmed',
    ...overrides,
  }),

  /**
   * Sleep for given milliseconds
   */
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

  /**
   * Wait for condition to be true
   */
  waitFor: async (condition, timeout = 5000, interval = 100) => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (condition()) {
        return true;
      }
      await global.testUtils.sleep(interval);
    }
    throw new Error(`Timeout waiting for condition after ${timeout}ms`);
  },
};

// Jest timeout for integration tests
jest.setTimeout(30000);
