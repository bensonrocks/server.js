import { AdapterCredentials, AdapterMeta } from '../adapter.interface';
import { StandardOrder } from '../../models/standard-order';

export class LazadaOrdersAdapter {
  static readonly meta: AdapterMeta = {
    name: 'Lazada',
    id: 'lazada',
    supportsOrders: true,
    supportsInventory: true,
  };

  async fetchOrders(
    creds: AdapterCredentials,
    filters?: { since?: Date; statuses?: string[] }
  ): Promise<StandardOrder[]> {
    if (!creds.shopid || !creds.apikey || !creds.apisecret) {
      throw new Error('Lazada credentials incomplete: shopid, apikey, apisecret required');
    }

    try {
      const orders = await this.callLazadaApi(creds, '/order/get', {
        status: filters?.statuses?.join(',') || 'ready_to_ship,shipped',
        limit: '100',
      });

      return orders.map((order: any) => this.mapLazadaOrderToStandard(order));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`Lazada order fetch failed: ${errorMessage}`);
    }
  }

  private mapLazadaOrderToStandard(lazadaOrder: any): StandardOrder {
    return {
      externalOrderId: String(lazadaOrder.order_id),
      externalOrderNumber: lazadaOrder.order_number,
      platform: 'lazada',
      source: 'lazada',
      orderDate: new Date(lazadaOrder.create_time).toISOString(),
      customerName: lazadaOrder.customer_first_name + ' ' + lazadaOrder.customer_last_name,
      customerEmail: lazadaOrder.customer_email,
      customerPhone: lazadaOrder.customer_phone,
      shippingAddress: {
        street: lazadaOrder.delivery_info.address,
        city: lazadaOrder.delivery_info.city,
        state: lazadaOrder.delivery_info.state,
        postalCode: lazadaOrder.delivery_info.post_code,
        country: lazadaOrder.delivery_info.country,
      },
      lines: lazadaOrder.items.map((item: any) => ({
        sku: item.sku,
        quantity: parseInt(item.quantity) || 0,
        unitPrice: parseFloat(item.purchase_price) || 0,
      })),
      status: this.mapLazadaStatus(lazadaOrder.order_status),
      notes: lazadaOrder.customer_message,
      warehouseId: lazadaOrder.warehouse_id,
      metadata: {
        lazada_order_id: lazadaOrder.order_id,
        lazada_seller_id: lazadaOrder.seller_id,
        lazada_payment_method: lazadaOrder.payment_method,
        lazada_fulfillment_type: lazadaOrder.fulfillment_type,
      },
    };
  }

  private mapLazadaStatus(status: string): string {
    const statusMap: Record<string, string> = {
      ready_to_ship: 'confirmed',
      shipped: 'shipped',
      delivered: 'delivered',
      cancelled: 'cancelled',
      returned: 'returned',
      lost_dispute: 'lost',
    };
    return statusMap[status] || 'pending';
  }

  private async callLazadaApi(
    creds: AdapterCredentials,
    endpoint: string,
    params?: Record<string, any>
  ): Promise<any[]> {
    const baseUrl = 'https://api.lazada.com/v2';
    const shopId = creds.shopid || '';
    const apiKey = creds.apikey || '';
    const apiSecret = creds.apisecret || '';

    try {
      const queryParams = new URLSearchParams();
      queryParams.append('shop_id', shopId);
      if (params) {
        Object.entries(params).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            queryParams.append(key, String(value));
          }
        });
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      };

      const url = `${baseUrl}${endpoint}${queryParams.toString() ? '?' + queryParams.toString() : ''}`;

      console.log(`[Lazada] Fetching: ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({ message: response.statusText }))) as Record<
          string,
          any
        >;
        throw new Error(`Lazada API error (${response.status}): ${error.message || error.error}`);
      }

      const data = (await response.json()) as Record<string, any>;

      if (Array.isArray(data)) {
        return data;
      }

      if (data.data && Array.isArray(data.data)) {
        return data.data;
      }

      console.warn(`[Lazada] Unexpected response format:`, data);
      return [];
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[Lazada] API call failed:`, errorMessage);
      throw err;
    }
  }
}

export const lazadaOrdersAdapter = new LazadaOrdersAdapter();
