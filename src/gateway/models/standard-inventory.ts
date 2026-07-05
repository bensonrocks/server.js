export interface StandardInventory {
  sku:         string;
  name:        string;
  qty:         number;
  reserved?:   number;   // held for open orders
  available?:  number;   // qty − reserved
  location?:   string;
  warehouse?:  string;
  externalId?: string;   // ID in source system
  channel:     string;   // which connector owns this record
}
