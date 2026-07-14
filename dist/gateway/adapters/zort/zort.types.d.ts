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
export interface ZortProduct {
    sku: string;
    name: string;
    code?: string;
    barcode?: string;
    type?: string;
    categoryname?: string;
    unit?: string;
    price?: number;
    cost?: number;
    qty?: number;
    available?: number;
    reserved?: number;
    location?: string;
    warehousecode?: string;
    active?: boolean | number;
}
export interface ZortProductListResponse {
    total?: number;
    page?: number;
    limit?: number;
    list?: ZortProduct[];
}
export interface ZortContact {
    id?: string | number;
    code?: string;
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
    taxid?: string;
    branchname?: string;
    contacttype?: string;
    facebook?: string;
    line?: string;
}
export interface ZortContactListResponse {
    total?: number;
    page?: number;
    limit?: number;
    list?: ZortContact[];
}
export interface ZortWebhookBody {
    url: string;
    events: string[];
}
export interface ZortWebhookResponse {
    status?: boolean;
    code?: number;
    message?: string;
}
//# sourceMappingURL=zort.types.d.ts.map