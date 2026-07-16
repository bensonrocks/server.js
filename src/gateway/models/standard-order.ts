export interface StandardOrderLine {
  externalLineId?: string;  // ID in source system
  sku: string;              // Your SKU code (must match inventory)
  quantity: number;         // Ordered quantity
  unitPrice: number;        // Price per unit
  notes?: string;
}

export interface StandardOrder {
  externalOrderId: string;  // ID in source system (must be unique per platform)
  externalOrderNumber?: string;  // Human-readable order number from platform
  platform: string;         // shopee, lazada, tiktok, shopify, zort, etc
  source: string;           // zort, direct, manual, import
  orderDate: string;        // ISO string
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  shippingAddress?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  lines: StandardOrderLine[];  // Order line items
  totalAmount?: number;
  status?: string;          // pending, confirmed, shipped, delivered, cancelled
  notes?: string;
  warehouseId?: string;     // Which warehouse to pick from
  clientId?: string;        // Customer/client in your system
  metadata?: Record<string, unknown>;  // Platform-specific data
}
