// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zetpy/
//     Field names verified against the official Zetpy Postman collection.

export interface ZetpyAuthResponse {
  success:    boolean;
  token:      string;
  expires_in: number;   // seconds (3600 = 60 min)
  request_id: string;
}

export interface ZetpyOrderItem {
  id:                number;
  product_id:        number | null;
  name:              string;
  sku:               string;
  unit_price:        number;
  discounted_price:  number;
  discount_given:    number | string;
  quantity_sold:     number;
  taxable:           boolean;
  tax:               number;
  tax_rate:          number;
  tax_type:          string;
  total:             number;
  is_free:           number | boolean;
  belong_to_item_id: number | null;
}

// One order as returned inside the nested orders response
export interface ZetpyOrder {
  app_name:                string;          // e.g. "Shopee Malaysia"
  app_account_name:        string;          // e.g. "My Shop"
  app_account_identifier?: string | number; // account ID for RTS/AWB calls
  app_internal_ref_id:     string;          // Zetpy-internal ref, same as ref_no
  ref_no:                  string;          // marketplace order number (primary key)

  total:                   number;
  subtotal:                number;
  discount:                number;
  discount_marketplace:    number | string;
  shipping_fee:            number;
  coin:                    number;
  shipping_tax:            number | string;
  shipping_tax_type:       string;
  tax:                     number;
  tax_rate:                number;
  tax_type:                string;

  billing_name:            string;
  billing_address:         string;
  billing_postcode:        string;
  billing_city:            string;
  billing_state:           string;
  billing_country:         string;
  billing_phone:           string;

  shipping_name:           string;
  shipping_address:        string;
  shipping_postcode:       string;
  shipping_city:           string;
  shipping_state:          string;
  shipping_country:        string;
  shipping_phone:          string;

  shipping_provider:       string;
  shipping_provider_id:    string | null;
  tracking_no:             string;
  shipment_type:           string | null;
  pickup_detail:           string | null;

  status:                  string;   // new | ready_to_ship | shipped | completed | canceled | return | unpaid
  discount_name:           string;
  ship_by_date:            string | null;
  created_date:            string;   // platform date, "YYYY-MM-DD HH:mm:ss"
  created_at:              string;   // Zetpy date, ISO 8601
  updated_at:              string;

  payment_method:          string;
  billing_company:         string | null;
  shipping_company:        string | null;
  message_to_seller:       string;
  seller_note:             string;
  package_ids:             string | null;
  currency:                string;
  restock:                 number | boolean;

  items:                   ZetpyOrderItem[];
}

// GET /api/orders/get-paginated response
// orders[marketplace][shop][ref_no] = ZetpyOrder
export interface ZetpyOrderListResponse {
  orders:        Record<string, Record<string, Record<string, ZetpyOrder>>>;
  current_page?: number;
  last_page?:    number;
  per_page?:     number;
  total?:        number;
  request_id?:   string;
}

// POST /api/orders/rts
export interface ZetpyRtsBody {
  credentials: {
    app_account_identifier: string | number;
    app_name:               string;
  };
  shipment_type:        'pickup' | 'drop_off' | 'self_deliver';
  self_deliver_orders?: Array<{ ref_no: string; tracking_number: string }>;
  orders?:              string[];
}

export interface ZetpyRtsResponse {
  success:          boolean;
  message?:         string;
  successful_ref?:  string[];
  unsuccessful_ref?: Array<Record<string, string>>;
  error?:           { code: string; message: string };
  request_id?:      string;
}
