'use strict';

// ── Status maps ──────────────────────────────────────────────────────────────

const LAZ_STATUS = {
  pending: 'pending', ready_to_ship: 'confirmed', shipped: 'shipped',
  delivered: 'delivered', canceled: 'cancelled',
};
const SHOP_STATUS = {
  UNPAID: 'pending', READY_TO_SHIP: 'confirmed', PROCESSED: 'processing',
  SHIPPED: 'shipped', COMPLETED: 'delivered', CANCELLED: 'cancelled', IN_CANCEL: 'cancelled',
};
const TTK_STATUS = {
  UNPAID: 'pending', ON_HOLD: 'pending', AWAITING_SHIPMENT: 'confirmed',
  PARTIALLY_SHIPPING: 'processing', AWAITING_COLLECTION: 'processing',
  IN_TRANSIT: 'shipped', DELIVERED: 'delivered', COMPLETED: 'delivered', CANCELLED: 'cancelled',
};

function toClientId(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ── Lazada ───────────────────────────────────────────────────────────────────

function fromLazada(order, clientName) {
  const addr  = order.address_shipping || {};
  const items = (order.items || []).map(i => ({
    sku:       i.sku || '',
    name:      i.name || 'Item',
    qty:       Number(i.item_count) || 1,
    unitPrice: Number(i.item_price) || 0,
  }));
  return {
    id:          `LAZ-${order.order_id}`,
    clientId:    toClientId(clientName),
    clientName,
    channel:     'lazada',
    orderDate:   order.created_at
      ? new Date(Number(order.created_at) * 1000).toISOString()
      : new Date().toISOString(),
    status:   LAZ_STATUS[String(order.statuses?.[0]).toLowerCase()] || 'processing',
    currency: 'MYR',
    notes:    order.remarks || '',
    items,
    shipping: {
      recipient:    [addr.first_name, addr.last_name].filter(Boolean).join(' '),
      addressLine1: addr.address  || '',
      addressLine2: addr.address2 || '',
      city:         addr.city     || '',
      state:        addr.state    || '',
      zip:          addr.post_code || '',
      country:      addr.country  || '',
    },
    subtotal:     Number(order.price || 0),
    shippingCost: 0,
    tax:          0,
    total:        Number(order.price || 0),
    source:       { type: 'lazada', externalId: String(order.order_id), ingestedAt: new Date().toISOString() },
  };
}

// ── Shopee ───────────────────────────────────────────────────────────────────

function fromShopee(order, clientName) {
  const addr  = order.recipient_address || {};
  const items = (order.item_list || []).map(i => ({
    sku:       i.item_sku  || '',
    name:      i.item_name || 'Item',
    qty:       Number(i.model_quantity_purchased) || 1,
    unitPrice: Number(i.model_original_price)     || 0,
  }));
  return {
    id:          `SHOP-${order.order_sn}`,
    clientId:    toClientId(clientName),
    clientName,
    channel:     'shopee',
    orderDate:   order.create_time
      ? new Date(Number(order.create_time) * 1000).toISOString()
      : new Date().toISOString(),
    status:   SHOP_STATUS[order.order_status] || 'pending',
    currency: 'MYR',
    notes:    order.message_to_seller || '',
    items,
    shipping: {
      recipient:    addr.name         || '',
      addressLine1: addr.full_address || '',
      addressLine2: '',
      city:         addr.city         || '',
      state:        addr.state        || '',
      zip:          addr.zipcode      || '',
      country:      addr.region       || '',
    },
    subtotal:     Number(order.total_amount || 0),
    shippingCost: 0,
    tax:          0,
    total:        Number(order.total_amount || 0),
    source:       { type: 'shopee', externalId: order.order_sn, ingestedAt: new Date().toISOString() },
  };
}

// ── TikTok Shop ──────────────────────────────────────────────────────────────

function fromTikTok(order, clientName) {
  const addr    = order.recipient_address || {};
  const payment = order.payment           || {};
  const items   = (order.line_items || []).map(i => ({
    sku:       i.seller_sku  || '',
    name:      i.product_name || 'Item',
    qty:       Number(i.quantity)   || 1,
    unitPrice: Number(i.sale_price) || 0,
  }));
  return {
    id:          `TTK-${order.id}`,
    clientId:    toClientId(clientName),
    clientName,
    channel:     'tiktok',
    orderDate:   order.create_time
      ? new Date(Number(order.create_time) * 1000).toISOString()
      : new Date().toISOString(),
    status:   TTK_STATUS[order.status] || 'pending',
    currency: order.currency || 'USD',
    notes:    order.buyer_message || '',
    items,
    shipping: {
      recipient:    addr.name          || '',
      addressLine1: addr.address_line1 || '',
      addressLine2: addr.address_line2 || '',
      city:         addr.city          || '',
      state:        addr.state         || '',
      zip:          addr.zipcode       || '',
      country:      addr.country_code  || '',
    },
    subtotal:     Number(payment.subtotal     || 0),
    shippingCost: Number(payment.shipping_fee || 0),
    tax:          Number(payment.tax          || 0),
    total:        Number(payment.total_amount || 0),
    source:       { type: 'tiktok', externalId: order.id, ingestedAt: new Date().toISOString() },
  };
}

module.exports = { fromLazada, fromShopee, fromTikTok };
