export interface ZortOrderItem {
    sku: string;
    name: string;
    number: number;
    pricepernumber: number;
    discount: number | string;
    totalprice: number;
}
export interface ZortOrder {
    number: string;
    id?: number;
    orderdate: string;
    status: string;
    currency?: string;
    amount: number;
    paymentamount?: number;
    shippingamount: number;
    vatamount: number;
    paymentmethod?: string;
    customername?: string;
    customerphone?: string;
    customeraddress?: string;
    description?: string;
    note?: string;
    list: ZortOrderItem[];
}
export interface ZortOrderListResponse {
    total?: number;
    page?: number;
    limit?: number;
    list?: ZortOrder[];
}
export interface ZortUpdateStatusParams {
    id?: string;
    number?: string;
    status: string;
    actionDate?: string;
    warehousecode?: string;
}
export interface ZortReadyToShipParams {
    id?: string;
    number?: string;
    shipment: string;
    trackingno?: string;
    warehousecode?: string;
    address?: string;
}
export interface ZortActionResponse {
    status?: boolean;
    code?: number;
    message?: string;
    result?: string;
    error?: string;
}
//# sourceMappingURL=zort.types.d.ts.map