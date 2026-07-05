import type { StandardOrder }                         from '../models/standard-order';
import type { StandardInventory }                     from '../models/standard-inventory';
import type { StandardShipment,
              StandardFulfillmentResult }             from '../models/standard-shipment';

// ── Credentials bag ───────────────────────────────────────────────────────────
// Each adapter picks the fields it needs; unused fields are ignored.

export interface AdapterCredentials {
  storeName?:    string;   // display name / IDEALone label

  // ZORT
  storename?:    string;   // ZORT store name (header)
  apikey?:       string;   // ZORT API key  (header)
  apisecret?:    string;   // ZORT API secret (header)

  // Generic paid-connector key (API2Cart, …)
  licenseKey?:   string;

  // Email + password auth (Zetpy)
  email?:        string;
  password?:     string;

  // OAuth — per-shop token (Shopee, Lazada, TikTok, Shopify)
  accessToken?:  string;
  refreshToken?: string;
  shopId?:       string;

  // OAuth — app-level credentials (stored server-side, not per client)
  appKey?:       string;
  appSecret?:    string;
  partnerId?:    string;
  partnerKey?:   string;

  // Shopify
  shopDomain?:   string;
  apiKey?:       string;
  apiSecret?:    string;
}

export interface FetchOrdersOptions {
  since?:    string;   // ISO 8601 — fetch orders created after this datetime
  status?:   string;   // platform-native status string to filter by
  pageSize?: number;
  page?:     number;
}

// ── Adapter contract ──────────────────────────────────────────────────────────

export interface IMarketplaceAdapter {
  /** Unique channel key, e.g. 'zort', 'shopee_direct' */
  readonly channel: string;

  /** true = adapter requires a paid subscription key */
  readonly requiresLicense?: boolean;

  /**
   * Pull orders from the platform.
   * Must return StandardOrder[] — never leak internal platform types.
   */
  fetchOrders(
    credentials: AdapterCredentials,
    options?: FetchOrdersOptions,
  ): Promise<StandardOrder[]>;

  /**
   * Push a tracking number back to the platform after packing.
   * Receives a StandardShipment — must not accept platform-specific objects.
   */
  pushShipment(
    credentials: AdapterCredentials,
    shipment: StandardShipment,
  ): Promise<StandardFulfillmentResult>;

  /** Pull inventory levels from the platform (optional). */
  fetchInventory?(
    credentials: AdapterCredentials,
  ): Promise<StandardInventory[]>;

  /** Push IDEALone stock levels to the platform (optional). */
  syncInventory?(
    credentials: AdapterCredentials,
    items: StandardInventory[],
  ): Promise<void>;
}
