import type {
  IMarketplaceAdapter,
  MarketplaceChannel,
  AdapterCredentials,
  OmsOrder,
  OmsFulfillment,
  FulfillmentResult,
  WaybillInfo,
  OmsInventoryItem,
  InventorySyncResult,
  FetchOrdersOptions,
  OAuthMeta,
} from './marketplace.types';

// ─────────────────────────────────────────────────────────────────────────────
//  MarketplaceGatewayService
//
//  Central registry that routes all marketplace operations to the right adapter.
//  - Free adapters (Shopify direct, Lazada, Shopee, TikTok) are auto-registered.
//  - Paid adapters (API2Cart, Zetpy, ChannelEngine) require a licenseKey credential.
// ─────────────────────────────────────────────────────────────────────────────

export class MarketplaceGatewayService {
  private readonly adapters = new Map<MarketplaceChannel, IMarketplaceAdapter>();
  private readonly oauthMeta = new Map<MarketplaceChannel, OAuthMeta>();

  register(adapter: IMarketplaceAdapter, meta?: OAuthMeta): this {
    this.adapters.set(adapter.channel, adapter);
    if (meta) this.oauthMeta.set(adapter.channel, meta);
    return this;
  }

  has(channel: MarketplaceChannel): boolean {
    return this.adapters.has(channel);
  }

  get(channel: MarketplaceChannel): IMarketplaceAdapter {
    const a = this.adapters.get(channel);
    if (!a) throw Object.assign(new Error(`No adapter registered for channel: ${channel}`), { status: 400 });
    return a;
  }

  getMeta(channel: MarketplaceChannel): OAuthMeta | undefined {
    return this.oauthMeta.get(channel);
  }

  channels(): MarketplaceChannel[] {
    return [...this.adapters.keys()];
  }

  allMeta(): Array<OAuthMeta & { channel: MarketplaceChannel; requiresLicense?: boolean }> {
    return this.channels().map(ch => {
      const meta    = this.oauthMeta.get(ch);
      const adapter = this.adapters.get(ch)!;
      return {
        channel:          ch,
        requiresLicense:  adapter.requiresLicense,
        id:               meta?.id   ?? ch,
        name:             meta?.name ?? ch,
        type:             meta?.type ?? 'ecommerce',
        authType:         meta?.authType ?? 'token',
        requiredForOAuth: meta?.requiredForOAuth,
        regions:          meta?.regions,
        defaultStoreName: meta?.defaultStoreName,
      };
    });
  }

  // ── Business operations ──────────────────────────────────────────────────

  async fetchOrders(
    channel: MarketplaceChannel,
    creds: AdapterCredentials,
    opts?: FetchOrdersOptions,
  ): Promise<OmsOrder[]> {
    return this.get(channel).fetchOrders(creds, opts);
  }

  async pushFulfillment(
    channel: MarketplaceChannel,
    creds: AdapterCredentials,
    fulfillment: OmsFulfillment,
  ): Promise<FulfillmentResult> {
    const a = this.get(channel);
    if (!a.pushFulfillment) {
      return { ok: false, skipped: true, reason: `${channel} does not support fulfillment push` };
    }
    return a.pushFulfillment(creds, fulfillment);
  }

  async fetchWaybill(
    channel: MarketplaceChannel,
    creds: AdapterCredentials,
    externalId: string,
  ): Promise<WaybillInfo> {
    const a = this.get(channel);
    if (!a.fetchWaybill) {
      throw Object.assign(new Error(`${channel} does not support waybill fetch`), { status: 400 });
    }
    return a.fetchWaybill(creds, externalId);
  }

  async syncInventoryToMarketplace(
    channel: MarketplaceChannel,
    creds: AdapterCredentials,
    items: OmsInventoryItem[],
  ): Promise<InventorySyncResult> {
    const a = this.get(channel);
    if (!a.syncInventoryToMarketplace) {
      return { pushed: 0, errors: [`${channel} does not support inventory push`] };
    }
    return a.syncInventoryToMarketplace(creds, items);
  }

  async syncInventoryFromMarketplace(
    channel: MarketplaceChannel,
    creds: AdapterCredentials,
  ): Promise<OmsInventoryItem[]> {
    const a = this.get(channel);
    if (!a.syncInventoryFromMarketplace) return [];
    return a.syncInventoryFromMarketplace(creds);
  }
}

export const gatewayService = new MarketplaceGatewayService();
