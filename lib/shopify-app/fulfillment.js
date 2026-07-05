'use strict';

const { query } = require('./db');
const { gql }   = require('./graphql');

const FULFILLMENT_ORDERS_QUERY = `
  query GetFulfillmentOrders($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 10) {
        nodes {
          id
          status
        }
      }
    }
  }
`;

const CREATE_FULFILLMENT_MUTATION = `
  mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        trackingInfo { company number url }
      }
      userErrors { field message }
    }
  }
`;

// Push fulfillment + tracking to Shopify for a given order.
// shopifyOrderId is the numeric Shopify order ID.
async function pushFulfillment(shopDomain, accessToken, ideaOrderId, shopifyOrderId, tracking = {}) {
  const orderGid = `gid://shopify/Order/${shopifyOrderId}`;

  // Get open fulfillment orders
  const data = await gql(shopDomain, accessToken, FULFILLMENT_ORDERS_QUERY, { orderId: orderGid });
  const openFOs = (data.order?.fulfillmentOrders?.nodes || []).filter(fo => fo.status === 'OPEN');
  if (!openFOs.length) {
    await _upsertRecord(shopDomain, ideaOrderId, shopifyOrderId, null, tracking, 'skipped');
    return { skipped: true, reason: 'no open fulfillment orders' };
  }

  const fulfillmentInput = {
    lineItemsByFulfillmentOrder: openFOs.map(fo => ({ fulfillmentOrderId: fo.id })),
    notifyCustomer: true,
    ...(tracking.number && {
      trackingInfo: {
        number: tracking.number,
        ...(tracking.company && { company: tracking.company }),
        ...(tracking.url     && { url: tracking.url }),
      },
    }),
    message: 'Shipped via IdealOne OMS',
  };

  const result = await gql(shopDomain, accessToken, CREATE_FULFILLMENT_MUTATION, { fulfillment: fulfillmentInput });
  const errs = result.fulfillmentCreate?.userErrors || [];
  if (errs.length) throw new Error(errs[0].message);

  const fulfillment = result.fulfillmentCreate?.fulfillment;
  const fulfillmentId = fulfillment?.id ? Number(fulfillment.id.split('/').pop()) : null;

  await _upsertRecord(shopDomain, ideaOrderId, shopifyOrderId, fulfillmentId, tracking, 'ok');
  return { ok: true, fulfillmentId };
}

async function _upsertRecord(shopDomain, orderId, shopifyOrderId, fulfillmentId, tracking, status) {
  await query(
    `INSERT INTO shopify_fulfillments
       (shop_domain, order_id, shopify_order_id, fulfillment_id, tracking_number, carrier, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING`,
    [shopDomain, orderId, Number(shopifyOrderId), fulfillmentId,
     tracking.number || null, tracking.company || null, status]
  );
}

module.exports = { pushFulfillment };
