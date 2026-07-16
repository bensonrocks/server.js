import { AdapterCredentials, AdapterMeta } from '../adapter.interface';
import { StandardOrder } from '../../models/standard-order';

export class ShopeeOrdersAdapter {
  static readonly meta: AdapterMeta = {
    name: 'Shopee',
    id: 'shopee',
    supportsOrders: true,
    supportsInventory: true,
  };

  async fetchOrders(
    creds: AdapterCredentials,
    filters?: { since?: Date; statuses?: string[] }
  ): Promise<StandardOrder[]> {
    if (!creds.shopid || !creds.apikey || !creds.apisecret) {
      throw new Error('Shopee credentials incomplete: shopid, apikey, apisecret required');
    }

    try {
      const orders = await this.callShopeeApi(creds, '/orders', {
        status: filters?.statuses?.join(',') || 'READY_TO_SHIP,SHIPPED',
        since: filters?.since?.toISOString(),
      });

      return orders.map((order: any) => this.mapShopeeOrderToStandard(order));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`Shopee order fetch failed: ${errorMessage}`);
    }
  }

  private mapShopeeOrderToStandard(shopeeOrder: any): StandardOrder {
    return {
      externalOrderId: String(shopeeOrder.order_sn),
      externalOrderNumber: shopeeOrder.order_sn,
      platform: 'shopee',
      source: 'shopee',
      orderDate: new Date(shopeeOrder.create_time * 1000).toISOString(),
      customerName: shopeeOrder.buyer_user_name,
      customerEmail: shopeeOrder.buyer_email,
      customerPhone: shopeeOrder.recipient_phone,
      shippingAddress: {
        street: shopeeOrder.recipient_address,
        city: shopeeOrder.recipient_city,
        state: shopeeOrder.recipient_district,
        postalCode: shopeeOrder.recipient_postal_code,
        country: shopeeOrder.recipient_country,
      },
      lines: shopeeOrder.item_list.map((item: any) => ({
        sku: item.sku,
        quantity: parseInt(item.model_quantity_purchased) || 0,
        unitPrice: parseFloat(item.model_original_price) || 0,
      })),
      status: this.mapShopeeStatus(shopeeOrder.order_status),
      notes: shopeeOrder.note,
      warehouseId: shopeeOrder.warehouse_id,
      metadata: {
        shopee_order_sn: shopeeOrder.order_sn,
        shopee_shop_id: shopeeOrder.shop_id,
        shopee_order_status: shopeeOrder.order_status,
        shopee_logistics: shopeeOrder.logistics_status,
      },
    };
  }

  private mapShopeeStatus(status: string): string {
    const statusMap: Record<string, string> = {
      READY_TO_SHIP: 'confirmed',
      SHIPPED: 'shipped',
      DELIVERED: 'delivered',
      CANCELLED: 'cancelled',
      RETURNED: 'returned',
      LOST: 'lost',
    };
    return statusMap[status] || 'pending';
  }

  private async callShopeeApi(
    creds: AdapterCredentials,
    endpoint: string,
    params?: Record<string, any>
  ): Promise<any[]> {
    const baseUrl = 'https://partner.shopeemobile.com/api/v2';
    const shopId = creds.shopid || '';
    const apiKey = creds.apikey || '';
    const apiSecret = creds.apisecret || '';

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
        'Authorization': `${apiKey}`,
        'X-Shopee-Shop-Id': shopId,
      };

      const url = `${baseUrl}${endpoint}${queryParams.toString() ? '?' + queryParams.toString() : ''}`;

      console.log(`[Shopee] Fetching: ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({ message: response.statusText }))) as Record<
          string,
          any
        >;
        throw new Error(`Shopee API error (${response.status}): ${error.message || error.error}`);
      }

      const data = (await response.json()) as Record<string, any>;

      if (Array.isArray(data)) {
        return data;
      }

      if (data.response && Array.isArray(data.response)) {
        return data.response;
      }

      console.warn(`[Shopee] Unexpected response format:`, data);
      return [];
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[Shopee] API call failed:`, errorMessage);
      throw err;
    }
  }
}

export const shopeeOrdersAdapter = new ShopeeOrdersAdapter();
