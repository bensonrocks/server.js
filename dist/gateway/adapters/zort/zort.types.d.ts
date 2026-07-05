export interface ZortOrderItem {
    sku: string;
    name: string;
    number: number;
    pricepernumber: number;
    discount: number;
    totalprice: number;
}
export interface ZortOrder {
    number: string;
    orderdate: string;
    status: string;
    currency?: string;
    amount: number;
    shippingamount: number;
    vatamount: number;
    customername?: string;
    customerphone?: string;
    customeraddress?: string;
    note?: string;
    list: ZortOrderItem[];
}
export interface ZortOrderListResponse {
    total?: number;
    page?: number;
    limit?: number;
    list?: ZortOrder[];
}
export interface ZortUpdateStatusBody {
    ordernumber: string;
    status: string;
    trackingnumber?: string;
    shippingprovider?: string;
}
export interface ZortUpdateStatusResponse {
    result?: string;
    error?: string;
}
//# sourceMappingURL=zort.types.d.ts.map