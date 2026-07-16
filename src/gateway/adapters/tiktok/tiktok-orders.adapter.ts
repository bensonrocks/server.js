import { AdapterCredentials, AdapterMeta } from '../adapter.interface';
import { StandardOrder } from '../../models/standard-order';

export class TikTokOrdersAdapter {
  static readonly meta: AdapterMeta = {
    name: 'TikTok Shop',
    id: 'tiktok',
    supportsOrders: true,
    supportsInventory: true,
  };

  async fetchOrders(
    creds: AdapterCredentials,
    filters?: { since?: Date; statuses?: string[] }
  ): Promise<StandardOrder[]> {
    if (!creds.shopid || !creds.apikey) {
      throw new Error('TikTok credentials incomplete: shopid, apikey required');
    }

    try {
      const orders = await this.callTikTokApi(creds, '/order/search', {
        order_status: filters?.statuses?.join(',') || 'ORDER_PROCESSING,ORDER_PARTIALLY_SHIPPING',
      });

      return orders.map((order: any) => this.mapTikTokOrderToStandard(order));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`TikTok order fetch failed: ${errorMessage}`);
    }
  }

  private mapTikTokOrderToStandard(tiktokOrder: any): StandardOrder {
    return {
      externalOrderId: String(tiktokOrder.order_id),
      externalOrderNumber: tiktokOrder.order_id,
      platform: 'tiktok',
      source: 'tiktok',
      orderDate: new Date(tiktokOrder.create_time).toISOString(),
      customerName: tiktokOrder.buyer_name || 'TikTok Buyer',
      customerEmail: tiktokOrder.buyer_email,
      customerPhone: tiktokOrder.recipient_phone,
      shippingAddress: {
        street: tiktokOrder.recipient_address.address_detail,
        city: tiktokOrder.recipient_address.city,
        state: tiktokOrder.recipient_address.state,
        postalCode: tiktokOrder.recipient_address.postal_code,
        country: tiktokOrder.recipient_address.country,
      },
      lines: tiktokOrder.line_items.map((item: any) => ({
        sku: item.sku || item.product_id,
        quantity: parseInt(item.quantity) || 0,
        unitPrice: parseFloat(item.sale_price) || 0,
      })),
      status: this.mapTikTokStatus(tiktokOrder.order_status),
      notes: tiktokOrder.buyer_message,
      warehouseId: tiktokOrder.warehouse_id,
      metadata: {
        tiktok_order_id: tiktokOrder.order_id,
        tiktok_seller_id: tiktokOrder.seller_id,
        tiktok_shop_id: tiktokOrder.shop_id,
        tiktok_order_status: tiktokOrder.order_status,
      },
    };
  }

  private mapTikTokStatus(status: string): string {
    const statusMap: Record<string, string> = {
      ORDER_PROCESSING: 'confirmed',
      ORDER_PARTIALLY_SHIPPING: 'shipping',
      ORDER_SHIPPED: 'shipped',
      ORDER_DELIVERED: 'delivered',
      ORDER_CANCELLED: 'cancelled',
      ORDER_RETURN_PROCESSING: 'returning',
      ORDER_RETURNED: 'returned',
    };
    return statusMap[status] || 'pending';
  }

  private async callTikTokApi(
    creds: AdapterCredentials,
    endpoint: string,
    params?: Record<string, any>
  ): Promise<any[]> {
    const baseUrl = 'https://open-api.tiktokshop.com/api';
    const shopId = creds.shopid || '';
    const accessToken = creds.apikey || '';

    try {
      const queryParams = new URLSearchParams();
      queryParams.append('shop_id', shopId);
      queryParams.append('app_key', creds.appid || '');
      if (params) {
        Object.entries(params).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            queryParams.append(key, String(value));
          }
        });
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'x-shop-id': shopId,
      };

      const url = `${baseUrl}${endpoint}${queryParams.toString() ? '?' + queryParams.toString() : ''}`;

      console.log(`[TikTok] Fetching: ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({ message: response.statusText }))) as Record<
          string,
          any
        >;
        throw new Error(`TikTok API error (${response.status}): ${error.message || error.error}`);
      }

      const data = (await response.json()) as Record<string, any>;

      if (Array.isArray(data)) {
        return data;
      }

      if (data.data && Array.isArray(data.data)) {
        return data.data;
      }

      if (data.data && data.data.orders && Array.isArray(data.data.orders)) {
        return data.data.orders;
      }

      console.warn(`[TikTok] Unexpected response format:`, data);
      return [];
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[TikTok] API call failed:`, errorMessage);
      throw err;
    }
  }
}

export const tiktokOrdersAdapter = new TikTokOrdersAdapter();
