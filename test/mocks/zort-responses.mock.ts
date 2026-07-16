/**
 * Mock ZORT API responses for testing
 */

export const mockZortOrdersResponse = [
  {
    id: 'ZORT-12345',
    order_number: 'ORD-20240115-001',
    customer_name: 'John Doe',
    customer_email: 'john@example.com',
    customer_phone: '+1234567890',
    status: 'confirmed',
    created_at: '2024-01-15T10:30:00Z',
    total: '199.98',
    items: [
      {
        id: 'ITEM-001',
        sku: 'SKU-001',
        product_code: 'SKU-001',
        quantity: '2',
        price: '99.99',
        notes: 'Test item 1',
      },
    ],
    shipping_address: {
      street: '123 Main St',
      city: 'Bangkok',
      state: 'Bangkok',
      postal_code: '10110',
      country: 'Thailand',
    },
    notes: 'Test order from ZORT',
    warehouse_id: 'WH-001',
    source_platform: 'shopee',
    tracking_number: 'TRACK-12345',
    payment_status: 'paid',
  },
  {
    id: 'ZORT-12346',
    order_number: 'ORD-20240115-002',
    customer_name: 'Jane Smith',
    customer_email: 'jane@example.com',
    customer_phone: '+9876543210',
    status: 'pending',
    created_at: '2024-01-15T11:45:00Z',
    total: '299.97',
    items: [
      {
        id: 'ITEM-002',
        sku: 'SKU-002',
        product_code: 'SKU-002',
        quantity: '3',
        price: '99.99',
        notes: null,
      },
    ],
    shipping_address: {
      street: '456 Sukhumvit Rd',
      city: 'Bangkok',
      state: 'Bangkok',
      postal_code: '10110',
      country: 'Thailand',
    },
    notes: null,
    warehouse_id: 'WH-001',
    source_platform: 'lazada',
    tracking_number: null,
    payment_status: 'pending',
  },
];

export const mockZortCredentials = {
  storename: 'test-store@example.com',
  apikey: 'test-api-key-12345',
  apisecret: 'test-api-secret-67890',
};

export const mockStandardOrders = [
  {
    externalOrderId: 'ZORT-12345',
    externalOrderNumber: 'ORD-20240115-001',
    platform: 'zort',
    source: 'zort',
    orderDate: '2024-01-15T10:30:00Z',
    customerName: 'John Doe',
    customerEmail: 'john@example.com',
    customerPhone: '+1234567890',
    shippingAddress: {
      street: '123 Main St',
      city: 'Bangkok',
      state: 'Bangkok',
      postalCode: '10110',
      country: 'Thailand',
    },
    lines: [
      {
        sku: 'SKU-001',
        quantity: 2,
        unitPrice: 99.99,
      },
    ],
    totalAmount: 199.98,
    status: 'confirmed',
    notes: 'Test order from ZORT',
    warehouseId: 'WH-001',
    metadata: {
      zort_id: 'ZORT-12345',
      zort_source: 'shopee',
      zort_tracking: 'TRACK-12345',
      zort_payment_status: 'paid',
    },
  },
];
