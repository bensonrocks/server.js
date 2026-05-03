export interface OrderItem {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
}

export interface ShippingAddress {
  recipient: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface OrderSource {
  type: string;
  ingestedAt: string;
  emailFrom?: string;
  emailSubject?: string;
}

export interface Order {
  id: string;
  clientId: string;
  clientName: string;
  channel: string;
  orderDate: string;
  status: string;
  currency: string;
  notes: string;
  items: OrderItem[];
  shipping: ShippingAddress;
  subtotal: number;
  shippingCost: number;
  tax: number;
  total: number;
  source: OrderSource;
}

export interface Stats {
  totalOrders: number;
  totalRevenue: number;
  totalClients: number;
  totalChannels: number;
  byStatus: Record<string, number>;
  byChannel: Record<string, { count: number; revenue: number }>;
  byClient: Array<{ clientId: string; clientName: string; count: number; revenue: number }>;
}

export interface Client {
  id: string;
  name: string;
  orderCount: number;
}

export interface Channel {
  channel: string;
  count: number;
}
