/**
 * Common adapter interfaces for all platform adapters
 * Enables pluggable architecture where any platform (ZORT, Shopee, etc.) can be swapped
 */

export interface AdapterCredentials {
  [key: string]: string;
}

export interface AdapterMeta {
  name: string;
  id: string;
  supportsOrders: boolean;
  supportsInventory: boolean;
}

export interface StandardOrder {
  externalOrderId: string;
  externalOrderNumber?: string;
  platform: string;
  source: string;
  orderDate: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  shippingAddress?: Record<string, any>;
  lines: StandardOrderLine[];
  status: string;
  warehouseId?: string;
  notes?: string;
  clientId?: string;
  metadata?: Record<string, any>;
}

export interface StandardOrderLine {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export interface PlatformAdapter {
  fetchOrders(credentials: AdapterCredentials, filters?: Record<string, any>): Promise<StandardOrder[]>;
  meta: AdapterMeta;
}
