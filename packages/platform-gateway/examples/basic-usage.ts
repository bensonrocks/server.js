// ─────────────────────────────────────────────────────────────────────────────
//  Platform Gateway — basic usage
//
//  Run it:
//    ZORT_STORENAME=... ZORT_APIKEY=... ZORT_APISECRET=... \
//      npx tsx packages/platform-gateway/examples/basic-usage.ts
//
//  (or `npm run build` then import from the compiled `dist/`.)
// ─────────────────────────────────────────────────────────────────────────────

import { gateway, auditLogService } from '../src';
import type { AdapterCredentials, StandardShipment } from '../src';

async function main() {
  // 1. Which channels are wired up right now?
  console.log('Registered channels:', gateway.channels());
  //   → [ 'zort', 'shopee_direct', 'lazada_direct', 'tiktok_direct', 'shopify_direct' ]

  // 2. Credentials come from your own secret store — here, env vars.
  const zortCreds: AdapterCredentials = {
    storeName: 'My Shop',                       // display label in your app
    storename: process.env.ZORT_STORENAME,      // ZORT header
    apikey:    process.env.ZORT_APIKEY,         // ZORT header
    apisecret: process.env.ZORT_APISECRET,      // ZORT header
    // baseUrl: 'https://open.zortout.com',     // optional override
  };

  if (!zortCreds.storename) {
    console.log('\nSet ZORT_STORENAME / ZORT_APIKEY / ZORT_APISECRET to make live calls.');
    return;
  }

  // 3. Pull orders — always returns normalised StandardOrder[].
  const orders = await gateway.fetchOrders('zort', zortCreds, {
    since:    '2026-01-01T00:00:00Z',
    pageSize: 50,
    page:     1,
  });
  console.log(`\nFetched ${orders.length} orders.`);
  for (const o of orders.slice(0, 3)) {
    console.log(`  ${o.externalId}  ${o.status}  ${o.items.length} item(s)  ${o.customer.name}`);
  }

  // 4. Push a tracking number back after you pack it.
  if (orders[0]) {
    const shipment: StandardShipment = {
      externalOrderId: orders[0].externalId,
      trackingNumber:  'TRACK123456789',
      carrier:         'J&T Express',
      notifyCustomer:  true,
    };
    const result = await gateway.pushShipment('zort', zortCreds, shipment);
    console.log('\nPush shipment:', result);
  }

  // 5. Every raw platform payload was captured for audit/debugging.
  const trail = auditLogService.findByChannel('zort', 5);
  console.log(`\nAudit entries captured this run: ${trail.length}`);
}

main().catch((err) => {
  console.error('Gateway example failed:', err);
  process.exit(1);
});
