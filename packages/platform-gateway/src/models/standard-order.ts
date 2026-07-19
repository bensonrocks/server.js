import type { StandardCustomer } from './standard-customer';

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'packed'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'returned';

export interface StandardOrderItem {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
  discount: number;
  total: number;
  variantId?: string;
  barcode?: string;
}

export interface StandardShippingAddress {
  recipient: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface StandardOrderSource {
  connector: string;
  rawId: string;
  auditRef?: string;
  fetchedAt: string;
}

export interface StandardOrder {
  id: string;
  externalId: string;
  externalRef: string;
  channel: string;
  clientId: string;
  clientName: string;
  status: OrderStatus;
  orderedAt: string;
  currency: string;
  subtotal: number;
  shippingCost: number;
  tax: number;
  discount: number;
  total: number;
  items: StandardOrderItem[];
  customer: StandardCustomer;
  shipping: StandardShippingAddress;
  notes: string;
  tags: string[];
  source: StandardOrderSource;
}
