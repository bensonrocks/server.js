# Mayer Client Onboarding Guide

**Client ID:** `mayer`  
**Tenant:** `default`  
**Onboarding Date:** 2026-07-19  
**Account Type:** B2C with Bundling + Virtual Warehouse

---

## 1. Account Setup

### Credentials
```
Client ID:      mayer
Tenant ID:      default
API Key:        [Generated on request]
Portal URL:     https://idealone.local/portal
Support Email:  support@idealone.local
```

### Dashboard Access
- **URL:** `/portal` (client login)
- **Admin Dashboard:** `/admin` (staff only, with x-tenant-id header)
- **API Base:** `/api`

---

## 2. Core Features Enabled for Mayer

### ✅ Bundling
Mayer can create product bundles that expand into component SKUs on order fulfillment.

**Example:**
- `GIFT-BUNDLE-001` = AIR-PURIF (1x) + AMBER-EDP (1x) + BACK-CUSHION (1x)
- When customer orders 1x bundle, 3 separate items are picked

### ✅ Virtual Warehouse
Mayer can mark SKUs as "virtual" — we don't hold inventory but still fulfill orders via:
- **Dropship** (FBA, partner warehouses)
- **Suppliers** (direct sourcing)
- **3rd Party** (affiliate fulfillment)

Virtual items bypass our inventory checks and are marked for special sourcing.

---

## 3. Order Format Template

### B2C Order (REST API)

**Endpoint:** `POST /api/orders/bulk-import`

```json
{
  "orders": [
    {
      "id": "MAYER-ORD-001",
      "client_id": "mayer",
      "client_name": "Mayer",
      "channel": "shopee",
      "order_date": "2026-07-19T10:30:00Z",
      "status": "pending",
      "currency": "SGD",
      "items": [
        {
          "sku": "GIFT-BUNDLE-001",
          "name": "Premium Gift Bundle",
          "qty": 2,
          "unitPrice": 415
        },
        {
          "sku": "DROPSUP-001",
          "name": "Dropship Item",
          "qty": 1,
          "unitPrice": 99
        }
      ],
      "shipping": {
        "recipient": "John Doe",
        "addressLine1": "123 Mayer Street",
        "addressLine2": "",
        "city": "Singapore",
        "state": "SG",
        "zip": "609216",
        "country": "SG"
      },
      "subtotal": 929,
      "shipping_cost": 10,
      "tax": 84.51,
      "total": 1023.51,
      "notes": "Special delivery instructions here"
    }
  ]
}
```

**Response:**
```json
{
  "imported": 1,
  "skipped": 0,
  "errors": []
}
```

### Field Reference

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | ✅ | Unique order ID (max 40 chars) |
| `client_id` | string | ✅ | Must be `mayer` |
| `client_name` | string | ✅ | Display name |
| `channel` | string | ✅ | `shopee`, `lazada`, `tiktok`, `shopify`, `zort`, etc. |
| `order_date` | ISO string | ✅ | When order was placed |
| `status` | string | ✅ | `pending`, `confirmed`, `processing`, `packed`, `shipped` |
| `currency` | string | ✅ | `SGD`, `MYR`, etc. |
| `items[].sku` | string | ✅ | SKU (can be bundle or regular) |
| `items[].name` | string | ✅ | Product name |
| `items[].qty` | number | ✅ | Quantity ordered |
| `items[].unitPrice` | number | ✅ | Price per unit |
| `shipping.recipient` | string | ✅ | Customer name |
| `shipping.addressLine1` | string | ✅ | Street address |
| `shipping.city` | string | ✅ | City/town |
| `shipping.zip` | string | ✅ | Postal code |
| `shipping.country` | string | ✅ | Country code (e.g., `SG`) |
| `subtotal` | number | ✅ | Sum of item costs |
| `shipping_cost` | number | ✅ | Shipping fee |
| `tax` | number | ✅ | Tax amount |
| `total` | number | ✅ | Grand total |
| `notes` | string | ❌ | Special instructions |

---

## 4. Bundle Configuration

### View Mayer's Bundles

**Endpoint:** `GET /api/clients/mayer/bundles`

```json
{
  "bundles": [
    {
      "bundleSku": "GIFT-BUNDLE-001",
      "bundleName": "Premium Gift Bundle",
      "description": "Premium home care bundle - 3 items",
      "components": [
        { "sku": "AIR-PURIF", "qty": 1, "name": "Portable HEPA Air Purifier", "unitPrice": 250 },
        { "sku": "AMBER-EDP", "qty": 1, "name": "Amber Noir EDP 50ml", "unitPrice": 120 },
        { "sku": "BACK-CUSHION", "qty": 1, "name": "Lumbar Support Cushion", "unitPrice": 45 }
      ]
    }
  ]
}
```

### Create a New Bundle

**Endpoint:** `POST /api/clients/mayer/bundles`

```json
{
  "bundleSku": "SUMMER-PACK",
  "bundleName": "Summer Kit 2026",
  "description": "Beach & outdoor essentials",
  "components": [
    { "sku": "SUNSCREEN", "qty": 2, "name": "Sunscreen SPF50", "unitPrice": 25 },
    { "sku": "BEACH-BAG", "qty": 1, "name": "Waterproof Beach Bag", "unitPrice": 45 },
    { "sku": "FLIP-FLOPS", "qty": 1, "name": "Flip Flops", "unitPrice": 15 }
  ]
}
```

---

## 5. Virtual Warehouse Setup

### View Virtual SKUs

**Endpoint:** `GET /api/clients/mayer/virtual-skus`

```json
{
  "virtualSkus": [
    {
      "sku": "DROPSUP-001",
      "warehouseName": "Dropship Warehouse",
      "fulfillmentMethod": "dropship",
      "supplierInfo": "FBA Fulfillment - Warehouse ABC"
    },
    {
      "sku": "SUPPLIER-B",
      "warehouseName": "3rd Party Supplier",
      "fulfillmentMethod": "supplier",
      "supplierInfo": "Direct from XYZ Supplier, 2-3 days"
    }
  ]
}
```

### Add a Virtual SKU

**Endpoint:** `POST /api/clients/mayer/virtual-skus`

```json
{
  "sku": "NEW-DROPSHIP-001",
  "warehouseName": "Partner Warehouse",
  "fulfillmentMethod": "dropship",
  "supplierInfo": "Partner FBA - Singapore"
}
```

### Fulfillment Methods

| Method | Description | Use Case |
|--------|-------------|----------|
| `dropship` | Inventory held at partner/FBA warehouse | Amazon FBA, eBay fulfillment |
| `supplier` | Direct from supplier/manufacturer | Direct sourcing, made-to-order |
| `affiliate` | Affiliate partner fulfillment | Reseller network |

---

## 6. Order Fulfillment Workflow

### Order Status Flow

```
pending → confirmed → processing → packed → shipped
  (Received)  (Accepted)  (Reserve)  (Pack)  (Deduct & Ship)
```

### Inventory Handling

**Regular SKUs:**
- `pending → processing`: Inventory **reserved** (marked unavailable)
- `processing → shipped`: Inventory **deducted** (physically removed)
- Cancellation: Reserved inventory **released** (returned to available)

**Virtual SKUs:**
- No inventory check (always available)
- Marked for special handling (dropship/sourcing flag)
- Still tracked in fulfillment pipeline

---

## 7. Cancellation Workflow

### Request Cancellation

Orders can be cancelled but require **approval** before taking effect.

**Step 1: Request Cancellation**
```bash
POST /api/orders/:orderId/cancel-request
{
  "reason": "Customer requested refund",
  "requestedBy": "customer_service"
}
```

**Step 2: Admin Approves**
```bash
POST /api/cancellations/:requestId/approve
{
  "approvedBy": "warehouse_admin"
}
```

**Result:**
- Order status → `cancelled`
- Reserved inventory → **released** (returned to available)
- Audit trail recorded

**Alternative: Reject Cancellation**
```bash
POST /api/cancellations/:requestId/reject
{
  "reason": "Order already shipped",
  "rejectedBy": "warehouse_admin"
}
```

---

## 8. Inventory Management

### SKU Format Requirements

```json
{
  "sku": "SKU-001",
  "code": "SKU-001",
  "name": "Product Name",
  "category": "home",
  "description": "Product description",
  "unit_price": 45.00,
  "stock_qty": 100,
  "reorder_point": 10
}
```

### Upload Inventory Batch

**Endpoint:** `POST /api/wms/inventory/batch-update`

```json
{
  "inventory": [
    {
      "sku": "SKU-001",
      "name": "Memory Foam Pillow Pro",
      "qty": 150,
      "warehouse": "wh-main",
      "location": "A-12-03"
    },
    {
      "sku": "SKU-002",
      "name": "LED Desk Lamp",
      "qty": 75,
      "warehouse": "wh-main",
      "location": "B-05-01"
    }
  ]
}
```

---

## 9. Error Handling & Support

### Common Error Responses

| Code | Error | Solution |
|------|-------|----------|
| 400 | `Order ... already exists` | Use unique order ID |
| 400 | `Invalid order date` | Use ISO 8601 format |
| 404 | `Order not found` | Verify order ID |
| 401 | `Authentication required` | Check API key |
| 422 | `Insufficient inventory` | Check stock levels |

### Support Contacts

- **General Support:** support@idealone.local
- **API Issues:** api-support@idealone.local
- **Billing:** billing@idealone.local
- **Urgent Issues:** +65-1234-5678

---

## 10. Testing Checklist

- [ ] Test B2C order import
- [ ] Verify bundle expansion (order with bundle, check if components picked)
- [ ] Test virtual SKU fulfillment (order with virtual item, bypass inventory)
- [ ] Test cancellation request → approval → inventory release
- [ ] Verify shipping address parsing
- [ ] Test multiple orders in batch import
- [ ] Check order status progression
- [ ] Verify inventory movements in audit trail

---

## 11. Quick Start Script

```bash
# 1. Import test order
curl -X POST http://localhost:3000/api/orders/bulk-import \
  -H "Authorization: Bearer $API_KEY" \
  -H "x-tenant-id: default" \
  -H "Content-Type: application/json" \
  -d @order.json

# 2. View Mayer's config
curl http://localhost:3000/api/clients/mayer/config \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -H "x-tenant-id: default"

# 3. View bundles
curl http://localhost:3000/api/clients/mayer/bundles \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -H "x-tenant-id: default"

# 4. View virtual SKUs
curl http://localhost:3000/api/clients/mayer/virtual-skus \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -H "x-tenant-id: default"
```

---

## 12. Next Steps

1. **Setup:** Create Mayer's API key + user accounts
2. **Config:** Define bundles + virtual SKUs
3. **Testing:** Run through testing checklist
4. **Training:** Provide order import instructions to Mayer's team
5. **Go Live:** Begin receiving orders

---

**Document Version:** 1.0  
**Last Updated:** 2026-07-19
