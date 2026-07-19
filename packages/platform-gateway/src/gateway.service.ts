import type { IMarketplaceAdapter,
              AdapterCredentials,
              FetchOrdersOptions }        from './interfaces/marketplace-adapter.interface';
import type { StandardOrder }             from './models/standard-order';
import type { StandardInventory }         from './models/standard-inventory';
import type { StandardShipment,
              StandardFulfillmentResult } from './models/standard-shipment';

export class MarketplaceGatewayService {
  private readonly adapters = new Map<string, IMarketplaceAdapter>();

  register(adapter: IMarketplaceAdapter): this {
    this.adapters.set(adapter.channel, adapter);
    return this;
  }

  get(channel: string): IMarketplaceAdapter {
    const a = this.adapters.get(channel);
    if (!a) throw new Error(`No adapter registered for channel: "${channel}"`);
    return a;
  }

  has(channel: string): boolean {
    return this.adapters.has(channel);
  }

  channels(): string[] {
    return [...this.adapters.keys()];
  }

  adaptersWithLicense(): string[] {
    return [...this.adapters.values()]
      .filter(a => a.requiresLicense)
      .map(a => a.channel);
  }

  // ── OMS-facing methods — accept/return Standard Models only ─────────────────

  fetchOrders(
    channel: string,
    creds: AdapterCredentials,
    opts?: FetchOrdersOptions,
  ): Promise<StandardOrder[]> {
    return this.get(channel).fetchOrders(creds, opts);
  }

  pushShipment(
    channel: string,
    creds: AdapterCredentials,
    shipment: StandardShipment,
  ): Promise<StandardFulfillmentResult> {
    return this.get(channel).pushShipment(creds, shipment);
  }

  fetchInventory(
    channel: string,
    creds: AdapterCredentials,
  ): Promise<StandardInventory[]> {
    const a = this.get(channel);
    if (!a.fetchInventory) return Promise.resolve([]);
    return a.fetchInventory(creds);
  }

  syncInventory(
    channel: string,
    creds: AdapterCredentials,
    items: StandardInventory[],
  ): Promise<void> {
    const a = this.get(channel);
    if (!a.syncInventory) return Promise.resolve();
    return a.syncInventory(creds, items);
  }

  fetchWaybill(
    channel: string,
    creds: AdapterCredentials,
    externalOrderId: string,
  ): Promise<{ url: string }> {
    const a = this.get(channel);
    if (!a.fetchWaybill) {
      return Promise.reject(new Error(`Channel "${channel}" does not support waybill fetch`));
    }
    return a.fetchWaybill(creds, externalOrderId);
  }
}
