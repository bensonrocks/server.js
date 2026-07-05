'use strict';

const { query }         = require('./db');
const { getIdealoneSku } = require('./skumap');

// financial_status → IDEALONE status
const STATUS_MAP = {
  paid: 'processing', authorized: 'confirmed', pending: 'pending',
  voided: 'cancelled', refunded: 'cancelled',
};

async function mapShopifyOrder(shopDomain, order, storeName) {
  const addr  = order.shipping_address || order.billing_address || {};
  const items = [];

  for (const i of (order.line_items || [])) {
    const sku = (await getIdealoneSku(shopDomain, i.variant_id)) || i.sku || '';
    items.push({ sku, name: i.name || 'Item', qty: Number(i.quantity) || 1, unitPrice: Number(i.price) || 0 });
  }

  let status = STATUS_MAP[order.financial_status] || 'pending';
  if (order.fulfillment_status === 'fulfilled') status = 'delivered';
  else if (order.fulfillment_status === 'partial') status = 'processing';
  if (order.cancelled_at) status = 'cancelled';

  const clientId  = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const recipient = addr.name || [addr.first_name, addr.last_name].filter(Boolean).join(' ');

  return {
    id:         `SHP-${order.id}`,
    clientId,
    clientName: storeName,
    channel:    'shopify',
    orderDate:  order.created_at || new Date().toISOString(),
    status,
    currency:   order.currency || 'USD',
    notes:      order.note || '',
    items,
    shipping: {
      recipient,
      name:         recipient,
      addressLine1: addr.address1      || '',
      addressLine2: addr.address2      || '',
      city:         addr.city          || '',
      state:        addr.province_code || addr.province || '',
      zip:          addr.zip           || '',
      country:      addr.country_code  || addr.country || '',
      phone:        addr.phone         || '',
    },
    subtotal:     Number(order.subtotal_price || 0),
    shippingCost: Number(order.total_shipping_price_set?.shop_money?.amount || 0),
    tax:          Number(order.total_tax   || 0),
    total:        Number(order.total_price || 0),
    source: {
      type:         'shopify',
      externalId:   String(order.id),
      orderName:    order.name || '',
      shippingName: recipient,
      ingestedAt:   new Date().toISOString(),
    },
  };
}

async function handleOrderCreate(shopDomain, payload, getCtx) {
  const shopRow  = await query('SELECT tenant_id, shop_domain FROM shopify_shops WHERE shop_domain=$1', [shopDomain]);
  if (!shopRow.rows.length) return;
  const tenantId = shopRow.rows[0].tenant_id;
  const { store } = getCtx(tenantId);

  const mapped = await mapShopifyOrder(shopDomain, payload, shopDomain);

  // Avoid duplicates
  const existing = store.getOrder(mapped.id);
  if (existing) return;

  store.addOrder(mapped);
  await query(
    `INSERT INTO shopify_order_map (shop_domain, shopify_order_id, idealone_order_id)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [shopDomain, Number(payload.id), mapped.id]
  );
}

async function handleOrderUpdated(shopDomain, payload, getCtx) {
  const shopRow = await query('SELECT tenant_id FROM shopify_shops WHERE shop_domain=$1', [shopDomain]);
  if (!shopRow.rows.length) return;
  const tenantId = shopRow.rows[0].tenant_id;
  const { store } = getCtx(tenantId);

  const orderId = `SHP-${payload.id}`;
  const existing = store.getOrder(orderId);
  if (!existing) {
    // Order not yet in system — treat as a create
    return handleOrderCreate(shopDomain, payload, getCtx);
  }

  const mapped = await mapShopifyOrder(shopDomain, payload, shopDomain);
  // Only advance status if the new mapped status is a forward step
  const STATUS_ORDER = ['pending','confirmed','processing','packed','shipped','delivered','cancelled'];
  const curIdx = STATUS_ORDER.indexOf(existing.status);
  const newIdx = STATUS_ORDER.indexOf(mapped.status);
  const newStatus = newIdx > curIdx ? mapped.status : existing.status;

  store.updateStatusAndSource(orderId, newStatus, { lastSyncedAt: new Date().toISOString() });
}

async function handleOrderCancelled(shopDomain, payload, getCtx) {
  const shopRow = await query('SELECT tenant_id FROM shopify_shops WHERE shop_domain=$1', [shopDomain]);
  if (!shopRow.rows.length) return;
  const tenantId = shopRow.rows[0].tenant_id;
  const { store } = getCtx(tenantId);

  const orderId = `SHP-${payload.id}`;
  const existing = store.getOrder(orderId);
  if (!existing) return;

  store.updateStatusAndSource(orderId, 'cancelled', { cancelledAt: payload.cancelled_at || new Date().toISOString() });
}

module.exports = { handleOrderCreate, handleOrderUpdated, handleOrderCancelled };
