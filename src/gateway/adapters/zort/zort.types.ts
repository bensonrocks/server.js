// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zort/
//     OMS modules must use StandardOrder, StandardInventory, StandardShipment only.
//     Field names verified against ZORT Api v4.0 Postman collection (2026-01-01).

export interface ZortOrderItem {
  sku:            string;
  name:           string;
  number:         number;   // qty — ZORT uses "number" for quantity
  pricepernumber: number;   // unit price
  discount:       number | string;
  totalprice:     number;
}

export interface ZortOrder {
  number:           string;   // order reference / human-readable ID  (e.g. "SO-0005")
  id?:              number;   // internal integer ID used by UpdateOrderStatus / ReadyToShip
  orderdate:        string;   // "YYYY-MM-DD"
  status:           string;   // string status name — see ZORT_STATUS in mapper
  currency?:        string;
  amount:           number;   // order total (shipping + VAT included)
  paymentamount?:   number;
  shippingamount:   number;
  vatamount:        number;
  paymentmethod?:   string;
  customername?:    string;   // confirmed: present in EditPurchaseOrderInfo body
  customerphone?:   string;   // confirmed: present in EditPurchaseOrderInfo body
  customeraddress?: string;   // single-string address
  description?:     string;   // order-level note (EditPurchaseOrderInfo uses "description")
  note?:            string;   // alternate note field on sales orders
  list:             ZortOrderItem[];
}

export interface ZortOrderListResponse {
  total?:  number;
  page?:   number;
  limit?:  number;
  list?:   ZortOrder[];
}

// UpdateOrderStatus — POST /Order/UpdateOrderStatus?id=&status=&actionDate=
// All fields are query params (no request body).
export interface ZortUpdateStatusParams {
  id?:           string;   // internal ZORT order ID (preferred)
  number?:       string;   // order number, if id not available
  status:        string;   // numeric: 1=waiting,2=packing,3=shipping,4=success,5=voided
  actionDate?:   string;   // "YYYY-MM-DD"
  warehousecode?: string;
}

// ReadyToShip — POST /Order/ReadyToShip?id=&shipment=&trackingno=&warehousecode=
// Used to mark an order as ready-to-ship with an optional tracking number.
export interface ZortReadyToShipParams {
  id?:           string;
  number?:       string;
  shipment:      string;   // shipping channel name, e.g. "flashexpress", "pickup", "jtexpress"
  trackingno?:   string;
  warehousecode?: string;
  address?:      string;   // required for Shopee Pickup shipment
}

export interface ZortActionResponse {
  status?:  boolean;
  code?:    number;
  message?: string;
  result?:  string;
  error?:   string;
}
