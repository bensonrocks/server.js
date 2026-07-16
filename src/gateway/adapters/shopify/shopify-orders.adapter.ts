import { AdapterCredentials, AdapterMeta } from '../adapter.interface';
import { StandardOrder } from '../../models/standard-order';

export class ShopifyOrdersAdapter {
  static readonly meta: AdapterMeta = {
    name: 'Shopify',
    id: 'shopify',
    supportsOrders: true,
    supportsInventory: true,
  };

  async fetchOrders(
    creds: AdapterCredentials,
    filters?: { since?: Date; statuses?: string[] }
  ): Promise<StandardOrder[]> {
    if (!creds.storeurl || !creds.accesstoken) {
      throw new Error('Shopify credentials incomplete: storeurl, accesstoken required');
    }

    try {
      const orders = await this.callShopifyApi(creds, '/orders.json', {
        status: filters?.statuses?.join(',') || 'any',
        limit: '250',
      });

      return orders.map((order: any) => this.mapShopifyOrderToStandard(order));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`Shopify order fetch failed: ${errorMessage}`);
    }
  }

  private mapShopifyOrderToStandard(shopifyOrder: any): StandardOrder {
    return {
      externalOrderId: String(shopifyOrder.id),
      externalOrderNumber: shopifyOrder.order_number.toString(),
      platform: 'shopify',
      source: 'shopify',
      orderDate: shopifyOrder.created_at,
      customerName: shopifyOrder.customer?.first_name + ' ' + (shopifyOrder.customer?.last_name || ''),
      customerEmail: shopifyOrder.customer?.email,
      customerPhone: shopifyOrder.customer?.phone,
      shippingAddress: {
        street: shopifyOrder.shipping_address?.address1,
        city: shopifyOrder.shipping_address?.city,
        state: shopifyOrder.shipping_address?.province,
        postalCode: shopifyOrder.shipping_address?.zip,
        country: shopifyOrder.shipping_address?.country,
      },
      lines: shopifyOrder.line_items.map((item: any) => ({
        sku: item.sku,
        quantity: parseInt(item.quantity) || 0,
        unitPrice: parseFloat(item.price) || 0,
      })),
      status: this.mapShopifyStatus(shopifyOrder.fulfillment_status, shopifyOrder.financial_status),
      notes: shopifyOrder.note || shopifyOrder.customer_note,
      warehouseId: shopifyOrder.fulfillments?.[0]?.location_id?.toString(),
      metadata: {
        shopify_id: shopifyOrder.id,
        shopify_name: shopifyOrder.name,
        shopify_fulfillment_status: shopifyOrder.fulfillment_status,
        shopify_financial_status: shopifyOrder.financial_status,
        shopify_currency: shopifyOrder.currency,
      },
    };
  }

  private mapShopifyStatus(fulfillmentStatus: string, financialStatus: string): string {
    // Map based on fulfillment status first
    const fulfillmentMap: Record<string, string> = {
      fulfilled: 'shipped',
      partial: 'shipping',
      unshipped: 'confirmed',
      voided: 'cancelled',
      cancelled: 'cancelled',
      restocked: 'returned',
    };

    if (fulfillmentMap[fulfillmentStatus || '']) {
      return fulfillmentMap[fulfillmentStatus];
    }

    // Fall back to financial status
    const financialMap: Record<string, string> = {
      authorized: 'pending',
      pending: 'pending',
      paid: 'confirmed',
      voided: 'cancelled',
      refunded: 'returned',
    };

    return financialMap[financialStatus || ''] || 'pending';
  }

  private async callShopifyApi(
    creds: AdapterCredentials,
    endpoint: string,
    params?: Record<string, any>
  ): Promise<any[]> {
    const storeUrl = (creds.storeurl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const accessToken = creds.accesstoken || '';

    try {
      const queryParams = new URLSearchParams();
      if (params) {
        Object.entries(params).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            queryParams.append(key, String(value));
          }
        });
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      };

      const url = `https://${storeUrl}/admin/api/2024-01${endpoint}${
        queryParams.toString() ? '?' + queryParams.toString() : ''
      }`;

      console.log(`[Shopify] Fetching: ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({ message: response.statusText }))) as Record<
          string,
          any
        >;
        throw new Error(`Shopify API error (${response.status}): ${error.message || error.error}`);
      }

      const data = (await response.json()) as Record<string, any>;

      if (Array.isArray(data)) {
        return data;
      }

      if (data.orders && Array.isArray(data.orders)) {
        return data.orders;
      }

      console.warn(`[Shopify] Unexpected response format:`, data);
      return [];
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[Shopify] API call failed:`, errorMessage);
      throw err;
    }
  }
}

export const shopifyOrdersAdapter = new ShopifyOrdersAdapter();
