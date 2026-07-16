import { AdapterCredentials, AdapterMeta } from '../../adapter.interface';
import { StandardOrder } from '../../models/standard-order';

export class ZortOrdersAdapter {
  static readonly meta: AdapterMeta = {
    name: 'ZORT',
    id: 'zort',
    supportsOrders: true,
    supportsInventory: true,
  };

  /**
   * Fetch orders from ZORT and convert to standard format
   * Filters to only confirmed/pending orders (not cancelled/delivered)
   */
  async fetchOrders(
    creds: AdapterCredentials,
    filters?: { since?: Date; statuses?: string[] }
  ): Promise<StandardOrder[]> {
    if (!creds.storename || !creds.apikey || !creds.apisecret) {
      throw new Error('ZORT credentials incomplete: storename, apikey, apisecret required');
    }

    try {
      // ZORT API call to fetch orders
      // This would call: https://api.zort.com/v1/orders
      // For now, returning empty array as placeholder
      // You'll replace this with actual ZORT API call
      const orders = await this.callZortApi(creds, '/v1/orders', {
        status: filters?.statuses?.join(',') || 'pending,confirmed',
        since: filters?.since?.toISOString(),
      });

      return orders.map((order: any) => this.mapZortOrderToStandard(order));
    } catch (err) {
      throw new Error(`ZORT order fetch failed: ${err.message}`);
    }
  }

  /**
   * Convert ZORT order format to standard format
   */
  private mapZortOrderToStandard(zortOrder: any): StandardOrder {
    return {
      externalOrderId: String(zortOrder.id),
      externalOrderNumber: zortOrder.order_number,
      platform: 'zort',
      source: 'zort',
      orderDate: zortOrder.created_at || new Date().toISOString(),
      customerName: zortOrder.customer_name,
      customerEmail: zortOrder.customer_email,
      customerPhone: zortOrder.customer_phone,
      shippingAddress: {
        street: zortOrder.shipping_address?.street,
        city: zortOrder.shipping_address?.city,
        state: zortOrder.shipping_address?.state,
        postalCode: zortOrder.shipping_address?.postal_code,
        country: zortOrder.shipping_address?.country,
      },
      lines: (zortOrder.items || []).map((item: any) => ({
        externalLineId: String(item.id),
        sku: item.sku || item.product_code,
        quantity: parseInt(item.quantity) || 0,
        unitPrice: parseFloat(item.price) || 0,
        notes: item.notes,
      })),
      totalAmount: parseFloat(zortOrder.total) || 0,
      status: this.mapZortStatus(zortOrder.status),
      notes: zortOrder.notes || zortOrder.special_instructions,
      warehouseId: zortOrder.warehouse_id,
      clientId: zortOrder.customer_id,
      metadata: {
        zort_id: zortOrder.id,
        zort_source: zortOrder.source_platform, // which marketplace this came from
        zort_tracking: zortOrder.tracking_number,
        zort_payment_status: zortOrder.payment_status,
      },
    };
  }

  /**
   * Map ZORT status to internal status
   */
  private mapZortStatus(zortStatus: string): string {
    const statusMap: Record<string, string> = {
      pending: 'pending',
      confirmed: 'confirmed',
      processing: 'confirmed',
      shipped: 'shipped',
      delivered: 'delivered',
      cancelled: 'cancelled',
      returned: 'returned',
    };
    return statusMap[zortStatus?.toLowerCase()] || 'pending';
  }

  /**
   * Placeholder for ZORT API calls
   * In production, you'd use fetch() or axios here
   */
  private async callZortApi(
    creds: AdapterCredentials,
    endpoint: string,
    params?: Record<string, any>
  ): Promise<any[]> {
    // TODO: Implement actual ZORT API call
    // For now, return empty array
    console.log(`ZORT API: GET ${endpoint}`, params);
    return [];
  }
}

export const zortOrdersAdapter = new ZortOrdersAdapter();
