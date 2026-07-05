export interface StandardShipment {
  externalOrderId: string;   // order ID in the source system
  trackingNumber:  string;
  carrier?:        string;
  notifyCustomer?: boolean;
  shippedAt?:      string;   // ISO 8601
}

export interface StandardFulfillmentResult {
  ok:          boolean;
  externalId?: string;   // fulfilment ID returned by the platform
  message?:    string;
  skipped?:    boolean;  // platform returned skip / not-applicable
}
