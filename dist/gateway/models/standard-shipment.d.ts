export interface StandardShipment {
    externalOrderId: string;
    trackingNumber: string;
    carrier?: string;
    notifyCustomer?: boolean;
    shippedAt?: string;
}
export interface StandardFulfillmentResult {
    ok: boolean;
    externalId?: string;
    message?: string;
    skipped?: boolean;
}
//# sourceMappingURL=standard-shipment.d.ts.map