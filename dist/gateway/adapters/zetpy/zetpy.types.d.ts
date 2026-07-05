export interface ZetpyAuthResponse {
    success: boolean;
    token: string;
    expires_in: number;
    request_id: string;
}
export interface ZetpyOrderItem {
    id: number;
    product_id: number | null;
    name: string;
    sku: string;
    unit_price: number;
    discounted_price: number;
    discount_given: number | string;
    quantity_sold: number;
    taxable: boolean;
    tax: number;
    tax_rate: number;
    tax_type: string;
    total: number;
    is_free: number | boolean;
    belong_to_item_id: number | null;
}
export interface ZetpyOrder {
    app_name: string;
    app_account_name: string;
    app_account_identifier?: string | number;
    app_internal_ref_id: string;
    ref_no: string;
    total: number;
    subtotal: number;
    discount: number;
    discount_marketplace: number | string;
    shipping_fee: number;
    coin: number;
    shipping_tax: number | string;
    shipping_tax_type: string;
    tax: number;
    tax_rate: number;
    tax_type: string;
    billing_name: string;
    billing_address: string;
    billing_postcode: string;
    billing_city: string;
    billing_state: string;
    billing_country: string;
    billing_phone: string;
    shipping_name: string;
    shipping_address: string;
    shipping_postcode: string;
    shipping_city: string;
    shipping_state: string;
    shipping_country: string;
    shipping_phone: string;
    shipping_provider: string;
    shipping_provider_id: string | null;
    tracking_no: string;
    shipment_type: string | null;
    pickup_detail: string | null;
    status: string;
    discount_name: string;
    ship_by_date: string | null;
    created_date: string;
    created_at: string;
    updated_at: string;
    payment_method: string;
    billing_company: string | null;
    shipping_company: string | null;
    message_to_seller: string;
    seller_note: string;
    package_ids: string | null;
    currency: string;
    restock: number | boolean;
    items: ZetpyOrderItem[];
}
export interface ZetpyOrderListResponse {
    orders: Record<string, Record<string, Record<string, ZetpyOrder>>>;
    current_page?: number;
    last_page?: number;
    per_page?: number;
    total?: number;
    request_id?: string;
}
export interface ZetpyRtsBody {
    credentials: {
        app_account_identifier: string | number;
        app_name: string;
    };
    shipment_type: 'pickup' | 'drop_off' | 'self_deliver';
    self_deliver_orders?: Array<{
        ref_no: string;
        tracking_number: string;
    }>;
    orders?: string[];
}
export interface ZetpyRtsResponse {
    success: boolean;
    message?: string;
    successful_ref?: string[];
    unsuccessful_ref?: Array<Record<string, string>>;
    error?: {
        code: string;
        message: string;
    };
    request_id?: string;
}
export interface ZetpyAwbBody {
    credentials: {
        app_account_identifier: string | number;
        app_name: string;
    };
    orders: string[];
}
export interface ZetpyAwbResponse {
    success: boolean;
    url?: string;
    urls?: Record<string, string>;
    message?: string;
    error?: {
        code: string;
        message: string;
    };
    request_id?: string;
}
//# sourceMappingURL=zetpy.types.d.ts.map