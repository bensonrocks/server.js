# @idealone/platform-gateway

A **portable, zero-runtime-dependency** marketplace integration layer. One unified
API over **ZORT** and the major selling platforms — **Shopee, Lazada, TikTok Shop,
Shopify** — that always returns normalised **Standard Models**, so the app that
consumes it never has to know a single platform-specific payload shape.

Drop the folder into any Node ≥ 18 project, `npm install`, `npm run build`, and
call it. No database, no HTTP library, no framework — it uses the built-in
`fetch` and nothing else.

---

## Why this exists

Each marketplace speaks a different dialect (different auth, field names, status
codes, pagination). This package hides all of that behind one interface:

```
your app ──▶ gateway.fetchOrders('zort', creds) ──▶ StandardOrder[]
             gateway.pushShipment('zort', creds, shipment)
             gateway.fetchInventory('zort', creds)
```

Swap `'zort'` for any registered channel and the shapes you handle never change.

---

## Install (copy-paste into another app)

1. Copy the whole `platform-gateway/` folder into your project (e.g. under
   `packages/` or `vendor/`).
2. Build it:

   ```bash
   cd platform-gateway
   npm install      # installs only devDeps: typescript + @types/node
   npm run build    # emits dist/ (JS + .d.ts)
   ```

3. Import from it:

   ```ts
   import { gateway } from './packages/platform-gateway/dist';
   ```

   Or, if your app itself is TypeScript, import straight from source:

   ```ts
   import { gateway } from './packages/platform-gateway/src';
   ```

> **Zero runtime dependencies.** `dependencies` is empty. TypeScript and
> `@types/node` are dev-only (compile time). The audit log is in-memory by
> default — see [Audit log](#audit-log-raw-payload-capture).

---

## Quick start

```ts
import { gateway } from '@idealone/platform-gateway';
import type { AdapterCredentials, StandardShipment } from '@idealone/platform-gateway';

const creds: AdapterCredentials = {
  storeName: 'My Shop',                    // display label
  storename: process.env.ZORT_STORENAME,   // ZORT header
  apikey:    process.env.ZORT_APIKEY,      // ZORT header
  apisecret: process.env.ZORT_APISECRET,   // ZORT header
};

// Pull orders — normalised StandardOrder[]
const orders = await gateway.fetchOrders('zort', creds, { since: '2026-01-01T00:00:00Z' });

// Push a tracking number back after packing
const shipment: StandardShipment = {
  externalOrderId: orders[0].externalId,
  trackingNumber:  'TRACK123456789',
  carrier:         'J&T Express',
  notifyCustomer:  true,
};
const result = await gateway.pushShipment('zort', creds, shipment);
```

There is a full runnable example in [`examples/basic-usage.ts`](examples/basic-usage.ts):

```bash
ZORT_STORENAME=... ZORT_APIKEY=... ZORT_APISECRET=... \
  npx tsx examples/basic-usage.ts
```

---

## The gateway API

`gateway` is a pre-wired `MarketplaceGatewayService` singleton. Every method
takes a `channel` string plus credentials and returns Standard Models.

| Method | Returns | Notes |
|---|---|---|
| `gateway.channels()` | `string[]` | Registered channel keys |
| `gateway.has(channel)` | `boolean` | Is a channel registered? |
| `gateway.fetchOrders(channel, creds, opts?)` | `Promise<StandardOrder[]>` | `opts`: `since`, `until`, `status`, `page`, `pageSize` |
| `gateway.pushShipment(channel, creds, shipment)` | `Promise<StandardFulfillmentResult>` | Attach tracking after packing |
| `gateway.fetchInventory(channel, creds)` | `Promise<StandardInventory[]>` | `[]` if the adapter doesn't support it |
| `gateway.syncInventory(channel, creds, items)` | `Promise<void>` | Push your stock levels out |
| `gateway.fetchWaybill(channel, creds, externalOrderId)` | `Promise<{ url }>` | Shipping-label PDF, if supported |

Build your own service instead of the singleton:

```ts
import { MarketplaceGatewayService, zortAdapter } from '@idealone/platform-gateway';

const gw = new MarketplaceGatewayService().register(zortAdapter);
```

---

## Channels

| Channel key | Status | Auth | Credentials fields |
|---|---|---|---|
| `zort` | **✅ Production-ready** | Header keys | `storename`, `apikey`, `apisecret`, `baseUrl?` |
| `shopee_direct` | 🚧 Scaffold | OAuth (partner) | `partnerId`, `partnerKey`, `accessToken`, `shopId` |
| `lazada_direct` | 🚧 Scaffold | OAuth (HMAC-SHA256) | `appKey`, `appSecret`, `accessToken` |
| `tiktok_direct` | 🚧 Scaffold | OAuth | `appKey`, `appSecret`, `accessToken`, `shopId` |
| `shopify_direct` | 🚧 Scaffold | OAuth (per-shop token) | `shopDomain`, `accessToken` |

**ZORT** is fully implemented (orders, shipment push, inventory pull/push,
products, customers, webhooks). Because ZORT already aggregates Shopee, Lazada,
TikTok and Shopify behind one API, wiring ZORT alone gives you multi-channel
coverage out of the box.

The `*_direct` adapters are **scaffolds** — the interface, registration, and
credential wiring are done; each `fetchOrders`/`pushShipment` currently throws
`"pending …"`. Complete them once you have the platform's developer account.
The exact application URL is in the TODO header of each adapter file:

| Platform | Apply at |
|---|---|
| Shopee | <https://open.shopee.com> |
| Lazada | <https://open.lazada.com> |
| TikTok Shop | TikTok Shop Partner Center |
| Shopify | <https://partners.shopify.com> → Create App (Public) |

---

## Standard Models

The only types your app should touch. Full definitions in `src/models/`.

```ts
type OrderStatus =
  | 'pending' | 'confirmed' | 'processing' | 'packed'
  | 'shipped' | 'delivered' | 'cancelled' | 'returned';

interface StandardOrder {
  id: string;                   // your namespaced id, e.g. 'ZORT-1042'
  externalId: string;           // id in the source system
  externalRef: string;          // platform reference / order number
  channel: string;              // 'zort' | 'shopee_direct' | …
  clientId: string;
  clientName: string;
  status: OrderStatus;
  orderedAt: string;            // ISO 8601
  currency: string;
  subtotal: number; shippingCost: number; tax: number; discount: number; total: number;
  items: StandardOrderItem[];
  customer: StandardCustomer;
  shipping: StandardShippingAddress;
  notes: string;
  tags: string[];
  source: StandardOrderSource;  // { connector, rawId, auditRef?, fetchedAt }
}

interface StandardOrderItem { sku: string; name: string; qty: number; unitPrice: number; discount: number; total: number; variantId?: string; barcode?: string; }
interface StandardShippingAddress { recipient: string; phone: string; addressLine1: string; addressLine2: string; city: string; state: string; zip: string; country: string; }
interface StandardShipment { externalOrderId: string; trackingNumber: string; carrier?: string; notifyCustomer?: boolean; shippedAt?: string; }
interface StandardFulfillmentResult { ok: boolean; externalId?: string; message?: string; skipped?: boolean; }
interface StandardInventory { sku: string; name: string; qty: number; reserved?: number; available?: number; location?: string; warehouse?: string; externalId?: string; channel: string; }
interface StandardCustomer { name: string; email?: string; phone?: string; }
```

---

## Audit log (raw-payload capture)

Before any adapter maps a platform response to a Standard Model, it records the
**untouched raw payload** via `auditLogService.save(...)` — invaluable for
debugging a bad mapping or a compliance trail.

By default this is an **in-memory ring buffer** (last 2000 entries) so the
package runs with zero setup. To persist, plug in your own sink:

```ts
import { auditLogService } from '@idealone/platform-gateway';
import type { AuditSink } from '@idealone/platform-gateway';

const sqliteSink: AuditSink = {
  save(entry)             { db.prepare('INSERT INTO gateway_audit ...').run(entry); },
  findByChannel(ch, n)    { return db.prepare('SELECT ... WHERE channel=? LIMIT ?').all(ch, n); },
  findByExternalId(id)    { return db.prepare('SELECT ... WHERE external_id=?').all(id); },
  findById(id)            { return db.prepare('SELECT ... WHERE id=?').get(id) ?? null; },
};

auditLogService.setSink(sqliteSink);   // call once at startup
```

Query it anytime:

```ts
auditLogService.findByChannel('zort', 20);
auditLogService.findByExternalId('ORDER-123');
```

---

## Writing a new adapter

Implement `IMarketplaceAdapter`, then register it:

```ts
import type { IMarketplaceAdapter } from '@idealone/platform-gateway';

class MyAdapter implements IMarketplaceAdapter {
  readonly channel = 'my_channel';
  async fetchOrders(creds, opts)      { /* fetch → map to StandardOrder[] */ return []; }
  async pushShipment(creds, shipment) { /* attach tracking */ return { ok: true }; }
  // optional: fetchInventory, syncInventory, fetchWaybill
}

gateway.register(new MyAdapter());
```

**Golden rule:** platform-specific types (raw JSON shapes) must never cross the
adapter boundary. Convert to Standard Models inside the adapter, and record the
raw payload to the audit log first.

---

## Layout

```
platform-gateway/
├── package.json          # zero runtime deps; build + typecheck scripts
├── tsconfig.json
├── README.md
├── examples/
│   └── basic-usage.ts
└── src/
    ├── index.ts                     # public barrel — import only from here
    ├── gateway.service.ts           # MarketplaceGatewayService
    ├── interfaces/                  # IMarketplaceAdapter, AdapterCredentials
    ├── models/                      # Standard Models (Order, Inventory, Shipment, Customer)
    ├── audit/                       # pluggable audit log (in-memory default)
    └── adapters/
        ├── zort/                    # ✅ full implementation (client, mapper, types, webhooks)
        ├── shopee-direct/           # 🚧 scaffold
        ├── lazada-direct/           # 🚧 scaffold
        ├── tiktok-direct/           # 🚧 scaffold
        └── shopify-direct/          # 🚧 scaffold
```

---

## Requirements

- **Node ≥ 18** (uses the built-in global `fetch`).
- TypeScript ≥ 5 to build (dev-only).
