// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zetpy/
//     OMS modules must use StandardOrder, StandardInventory, StandardShipment only.
//
//  All field names below are best-guess from common REST conventions.
//  Verify every TODO against https://developers.zetpy.com (login required)
//  before going live.

export interface ZetpyOrderItem {
  sku:         string;   // TODO: confirm
  name:        string;   // TODO: confirm
  quantity:    number;   // TODO: confirm (may be qty or item_quantity)
  unit_price:  number;   // TODO: confirm (may be price or sale_price)
  discount:    number;   // TODO: confirm
  total_price: number;   // TODO: confirm (may be line_total)
}

export interface ZetpyAddress {
  name:      string;   // TODO: confirm
  phone:     string;   // TODO: confirm
  address1:  string;   // TODO: confirm (may be address_line_1)
  address2?: string;
  city:      string;   // TODO: confirm
  state:     string;   // TODO: confirm
  postcode:  string;   // TODO: confirm (may be zip or postal_code)
  country:   string;   // TODO: confirm (may be country_code)
}

export interface ZetpyOrder {
  id:               string | number; // TODO: confirm (may be order_id)
  order_number:     string;          // TODO: confirm (may be reference_number)
  channel:          string;          // source marketplace: shopee, lazada, tiktok… TODO: confirm values
  status:           string;          // TODO: verify exact status strings
  currency:         string;          // TODO: confirm
  created_at:       string;          // TODO: confirm (may be order_date or created_time)
  subtotal?:        number;          // TODO: confirm
  shipping_fee?:    number;          // TODO: confirm
  total:            number;          // TODO: confirm (may be total_amount)
  buyer_note?:      string;          // TODO: confirm (may be note or remarks)
  items:            ZetpyOrderItem[];         // TODO: confirm (may be line_items or products)
  shipping_address: ZetpyAddress;    // TODO: confirm (may be delivery_address)
}

export interface ZetpyOrderListResponse {
  data:       ZetpyOrder[];   // TODO: confirm (may be orders or results)
  total?:     number;
  page?:      number;
  per_page?:  number;
  last_page?: number;         // TODO: confirm (may be total_pages)
}

export interface ZetpyFulfillBody {
  tracking_number: string;   // TODO: confirm
  carrier?:        string;   // TODO: confirm (may be courier or shipping_provider)
  notify_buyer?:   boolean;  // TODO: confirm field + if supported
}

export interface ZetpyFulfillResponse {
  success?: boolean;   // TODO: confirm response shape
  message?: string;
  error?:   string;
}
