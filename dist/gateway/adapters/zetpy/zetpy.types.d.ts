export interface ZetpyOrderItem {
    sku: string;
    name: string;
    quantity: number;
    unit_price: number;
    discount: number;
    total_price: number;
}
export interface ZetpyAddress {
    name: string;
    phone: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postcode: string;
    country: string;
}
export interface ZetpyOrder {
    id: string | number;
    order_number: string;
    channel: string;
    status: string;
    currency: string;
    created_at: string;
    subtotal?: number;
    shipping_fee?: number;
    total: number;
    buyer_note?: string;
    items: ZetpyOrderItem[];
    shipping_address: ZetpyAddress;
}
export interface ZetpyOrderListResponse {
    data: ZetpyOrder[];
    total?: number;
    page?: number;
    per_page?: number;
    last_page?: number;
}
export interface ZetpyFulfillBody {
    tracking_number: string;
    carrier?: string;
    notify_buyer?: boolean;
}
export interface ZetpyFulfillResponse {
    success?: boolean;
    message?: string;
    error?: string;
}
//# sourceMappingURL=zetpy.types.d.ts.map