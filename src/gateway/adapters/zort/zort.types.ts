// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zort/
//     OMS modules must use StandardOrder, StandardInventory, StandardShipment only.

export interface ZortOrderItem {
  sku:            string;
  name:           string;
  number:         number;   // quantity (ZORT uses "number" for qty)
  pricepernumber: number;   // unit price
  discount:       number;
  totalprice:     number;
}

export interface ZortOrder {
  number:           string;   // order reference / human-readable ID
  orderdate:        string;   // "YYYY-MM-DD" or ISO
  status:           string;   // see ZORT_STATUS_MAP in mapper
  currency?:        string;   // TODO: confirm field name in live response
  amount:           number;   // order total (including shipping + VAT)
  shippingamount:   number;
  vatamount:        number;
  customername?:    string;   // TODO: confirm field name
  customerphone?:   string;   // TODO: confirm field name
  customeraddress?: string;   // single-string address (confirmed from ZORT docs)
  note?:            string;   // TODO: confirm field name
  list:             ZortOrderItem[];
}

export interface ZortOrderListResponse {
  total?:  number;
  page?:   number;
  limit?:  number;
  list?:   ZortOrder[];   // TODO: confirm envelope wrapper field name
}

export interface ZortUpdateStatusBody {
  ordernumber:       string;   // TODO: confirm (may be "number")
  status:            string;
  trackingnumber?:   string;   // TODO: confirm
  shippingprovider?: string;   // TODO: confirm
}

export interface ZortUpdateStatusResponse {
  result?: string;
  error?:  string;
}
