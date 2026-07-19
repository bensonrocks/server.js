# Mayer API Request Templates

Copy-paste ready templates for all common API operations.

---

## Setup: Authentication

```bash
# Store your credentials
export API_KEY="mayer_live_xxxxxxxxxxxxxxxxxxxxx"
export TENANT_ID="default"
export API_BASE="https://idealone.local/api"
export HEADERS="-H 'Authorization: Bearer $API_KEY' -H 'x-tenant-id: $TENANT_ID' -H 'Content-Type: application/json'"
```

---

## 1. Import Orders (Batch)

```bash
curl -X POST $API_BASE/orders/bulk-import $HEADERS \
  -d '{
    "orders": [
      {
        "id": "MAYER-ORD-001",
        "client_id": "mayer",
        "client_name": "Mayer",
        "channel": "shopee",
        "order_date": "2026-07-20T10:30:00Z",
        "status": "pending",
        "currency": "SGD",
        "items": [
          {
            "sku": "SKU-001",
            "name": "Memory Foam Pillow",
            "qty": 2,
            "unitPrice": 45.00
          },
          {
            "sku": "SKU-002",
            "name": "LED Lamp",
            "qty": 1,
            "unitPrice": 49.00
          }
        ],
        "shipping": {
          "recipient": "John Doe",
          "addressLine1": "123 Main Street",
          "addressLine2": "Apt 4B",
          "city": "Singapore",
          "state": "SG",
          "zip": "609216",
          "country": "SG"
        },
        "subtotal": 139.00,
        "shipping_cost": 10.00,
        "tax": 13.41,
        "total": 162.41,
        "notes": "Leave at door if no one home"
      },
      {
        "id": "MAYER-ORD-002",
        "client_id": "mayer",
        "client_name": "Mayer",
        "channel": "lazada",
        "order_date": "2026-07-20T11:45:00Z",
        "status": "pending",
        "currency": "SGD",
        "items": [
          {
            "sku": "GIFT-BUNDLE-001",
            "name": "Premium Gift Bundle",
            "qty": 1,
            "unitPrice": 415.00
          }
        ],
        "shipping": {
          "recipient": "Jane Smith",
          "addressLine1": "456 Park Avenue",
          "city": "Singapore",
          "zip": "609921",
          "country": "SG"
        },
        "subtotal": 415.00,
        "shipping_cost": 0,
        "tax": 37.35,
        "total": 452.35
      }
    ]
  }'
```

**Response:**
```json
{
  "imported": 2,
  "skipped": 0,
  "errors": []
}
```

---

## 2. Get Client Configuration

```bash
curl -X GET "$API_BASE/clients/mayer/config" $HEADERS
```

**Response:**
```json
{
  "config": {
    "client_id": "mayer",
    "bundling_enabled": 1,
    "virtual_warehouse_enabled": 1,
    "settings": {},
    "created_at": "2026-07-19 01:57:14",
    "updated_at": "2026-07-19 01:57:14"
  },
  "bundles": [...],
  "virtualSkus": [...]
}
```

---

## 3. View All Bundles

```bash
curl -X GET "$API_BASE/clients/mayer/bundles" $HEADERS
```

**Response:**
```json
{
  "bundles": [
    {
      "bundleSku": "GIFT-BUNDLE-001",
      "bundleName": "Premium Gift Bundle",
      "description": "3-piece home care bundle",
      "components": [
        {
          "sku": "AIR-PURIF",
          "qty": 1,
          "name": "Portable HEPA Air Purifier",
          "unitPrice": 250
        },
        {
          "sku": "AMBER-EDP",
          "qty": 1,
          "name": "Amber Noir EDP 50ml",
          "unitPrice": 120
        },
        {
          "sku": "BACK-CUSHION",
          "qty": 1,
          "name": "Lumbar Support Cushion",
          "unitPrice": 45
        }
      ]
    }
  ]
}
```

---

## 4. Create a New Bundle

```bash
curl -X POST "$API_BASE/clients/mayer/bundles" $HEADERS \
  -d '{
    "bundleSku": "STARTER-PACK",
    "bundleName": "Starter Kit",
    "description": "Essential beginner collection",
    "components": [
      {
        "sku": "AROMA-STONES",
        "qty": 2,
        "name": "Ceramic Aroma Stones Set",
        "unitPrice": 35
      },
      {
        "sku": "AROMA-DIF",
        "qty": 1,
        "name": "Aroma Diffuser LED 150ml",
        "unitPrice": 85
      },
      {
        "sku": "CANDLE-BOX",
        "qty": 1,
        "name": "Scented Candle Box",
        "unitPrice": 40
      }
    ]
  }'
```

**Response:**
```json
{
  "clientId": "mayer",
  "bundleSku": "STARTER-PACK",
  "bundleName": "Starter Kit",
  "components": [
    {
      "sku": "AROMA-STONES",
      "qty": 2,
      "name": "Ceramic Aroma Stones Set",
      "unitPrice": 35
    },
    {
      "sku": "AROMA-DIF",
      "qty": 1,
      "name": "Aroma Diffuser LED 150ml",
      "unitPrice": 85
    },
    {
      "sku": "CANDLE-BOX",
      "qty": 1,
      "name": "Scented Candle Box",
      "unitPrice": 40
    }
  ],
  "description": "Essential beginner collection"
}
```

---

## 5. View Virtual Warehouse SKUs

```bash
curl -X GET "$API_BASE/clients/mayer/virtual-skus" $HEADERS
```

**Response:**
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
      "supplierInfo": "Direct from XYZ Supplier"
    }
  ]
}
```

---

## 6. Add Virtual Warehouse SKU

```bash
curl -X POST "$API_BASE/clients/mayer/virtual-skus" $HEADERS \
  -d '{
    "sku": "DROPSHIP-NEW-001",
    "warehouseName": "Partner FBA",
    "fulfillmentMethod": "dropship",
    "supplierInfo": "Amazon FBA - Warehouse XYZ, 2-day delivery"
  }'
```

**Response:**
```json
{
  "clientId": "mayer",
  "sku": "DROPSHIP-NEW-001",
  "warehouseName": "Partner FBA",
  "fulfillmentMethod": "dropship",
  "supplierInfo": "Amazon FBA - Warehouse XYZ, 2-day delivery"
}
```

---

## 7. Request Order Cancellation

```bash
curl -X POST "$API_BASE/orders/MAYER-ORD-001/cancel-request" $HEADERS \
  -d '{
    "reason": "Customer requested refund - changed mind",
    "requestedBy": "customer_service"
  }'
```

**Response:**
```json
{
  "requestId": "4a136cbc-fa0e-4f68-bdb9-c84b8635e1ab",
  "orderId": "MAYER-ORD-001",
  "status": "pending",
  "reason": "Customer requested refund - changed mind",
  "requestedBy": "customer_service",
  "requestedAt": "2026-07-20T12:00:00Z",
  "message": "Cancellation pending approval"
}
```

---

## 8. Approve Cancellation Request

```bash
curl -X POST "$API_BASE/cancellations/4a136cbc-fa0e-4f68-bdb9-c84b8635e1ab/approve" $HEADERS \
  -d '{
    "approvedBy": "warehouse_manager"
  }'
```

**Response:**
```json
{
  "requestId": "4a136cbc-fa0e-4f68-bdb9-c84b8635e1ab",
  "orderId": "MAYER-ORD-001",
  "previousStatus": "pending",
  "newStatus": "cancelled",
  "approvedBy": "warehouse_manager",
  "approvedAt": "2026-07-20T12:15:00Z",
  "inventoryResult": { "ok": true },
  "message": "Cancellation approved and executed"
}
```

---

## 9. Reject Cancellation Request

```bash
curl -X POST "$API_BASE/cancellations/4a136cbc-fa0e-4f68-bdb9-c84b8635e1ab/reject" $HEADERS \
  -d '{
    "reason": "Order already in fulfillment - cannot cancel",
    "rejectedBy": "warehouse_manager"
  }'
```

**Response:**
```json
{
  "requestId": "4a136cbc-fa0e-4f68-bdb9-c84b8635e1ab",
  "orderId": "MAYER-ORD-001",
  "status": "rejected",
  "rejectedBy": "warehouse_manager",
  "rejectedAt": "2026-07-20T12:15:00Z",
  "rejectionReason": "Order already in fulfillment - cannot cancel",
  "message": "Cancellation request rejected"
}
```

---

## 10. Get Order Details

```bash
curl -X GET "$API_BASE/orders/MAYER-ORD-001" $HEADERS
```

**Response:**
```json
{
  "id": "MAYER-ORD-001",
  "clientId": "mayer",
  "clientName": "Mayer",
  "channel": "shopee",
  "orderDate": "2026-07-20T10:30:00Z",
  "status": "processing",
  "currency": "SGD",
  "notes": "Leave at door if no one home",
  "items": [
    {
      "sku": "SKU-001",
      "name": "Memory Foam Pillow",
      "qty": 2,
      "unitPrice": 45.00
    },
    {
      "sku": "SKU-002",
      "name": "LED Lamp",
      "qty": 1,
      "unitPrice": 49.00
    }
  ],
  "shipping": {
    "recipient": "John Doe",
    "addressLine1": "123 Main Street",
    "addressLine2": "Apt 4B",
    "city": "Singapore",
    "state": "SG",
    "zip": "609216",
    "country": "SG"
  },
  "subtotal": 139.00,
  "shippingCost": 10.00,
  "tax": 13.41,
  "total": 162.41,
  "source": { "type": "shopee" },
  "warehouseId": "wh-main",
  "createdAt": "2026-07-20T10:30:15Z",
  "updatedAt": "2026-07-20T11:00:00Z"
}
```

---

## 11. List All Orders (with Filters)

```bash
# All orders
curl -X GET "$API_BASE/orders" $HEADERS

# Filter by status
curl -X GET "$API_BASE/orders?status=pending" $HEADERS

# Filter by channel
curl -X GET "$API_BASE/orders?channel=shopee" $HEADERS

# Filter by search (looks in recipient, order ID, notes)
curl -X GET "$API_BASE/orders?search=John%20Doe" $HEADERS

# Multiple filters
curl -X GET "$API_BASE/orders?status=processing&channel=lazada" $HEADERS
```

**Response:**
```json
[
  {
    "id": "MAYER-ORD-001",
    "clientId": "mayer",
    "clientName": "Mayer",
    "channel": "shopee",
    "status": "processing",
    "total": 162.41,
    "orderDate": "2026-07-20T10:30:00Z",
    ...
  },
  {
    "id": "MAYER-ORD-002",
    "clientId": "mayer",
    "clientName": "Mayer",
    "channel": "lazada",
    "status": "pending",
    "total": 452.35,
    "orderDate": "2026-07-20T11:45:00Z",
    ...
  }
]
```

---

## 12. Test Connection (Health Check)

```bash
curl -X GET "$API_BASE/clients/mayer/config" $HEADERS -v
```

**Expected Response Codes:**
- `200` - Success! API is working
- `401` - Authentication failed (check API key)
- `404` - Endpoint not found
- `500` - Server error (contact support)

---

## Error Handling Examples

### Scenario 1: Duplicate Order

```bash
curl -X POST $API_BASE/orders/bulk-import $HEADERS \
  -d '{ "orders": [{ "id": "DUP-001", ... }] }'
```

**Error Response:**
```json
{
  "imported": 0,
  "skipped": 1,
  "errors": [
    {
      "id": "DUP-001",
      "error": "Order DUP-001 already exists"
    }
  ]
}
```

**Fix:** Use unique order ID

---

### Scenario 2: Invalid Bundle SKU

```bash
curl -X POST $API_BASE/orders/bulk-import $HEADERS \
  -d '{ "orders": [{ "id": "ORD-001", "items": [{"sku": "FAKE-BUNDLE", ...}] }] }'
```

**Response:**
```json
{
  "imported": 1,
  "skipped": 0,
  "errors": []
}
```

**Note:** Invalid bundle SKUs don't error - they're treated as regular items. Verify bundle exists before using!

---

### Scenario 3: Missing Required Fields

```bash
curl -X POST $API_BASE/orders/bulk-import $HEADERS \
  -d '{ "orders": [{ "id": "ORD-001" }] }'
```

**Error Response:**
```json
{
  "imported": 0,
  "skipped": 1,
  "errors": [
    {
      "id": "ORD-001",
      "error": "Missing required fields"
    }
  ]
}
```

**Fix:** Include all required fields (items, shipping, totals)

---

## Common Header Issues

```bash
# ❌ Wrong: Missing Authorization header
curl -X GET "$API_BASE/orders" \
  -H "x-tenant-id: default"
→ Response: 401 Unauthorized

# ✅ Correct:
curl -X GET "$API_BASE/orders" \
  -H "Authorization: Bearer $API_KEY" \
  -H "x-tenant-id: default"
→ Response: 200 OK

# ❌ Wrong: Wrong tenant ID
curl -X GET "$API_BASE/orders" $HEADERS \
  -H "x-tenant-id: other-tenant"
→ Response: 404 Tenant not found

# ✅ Correct:
curl -X GET "$API_BASE/orders" $HEADERS \
  -H "x-tenant-id: default"
→ Response: 200 OK
```

---

## Python Example (Using requests library)

```python
import requests
import json

API_KEY = "mayer_live_xxxxxxxxxxxxxxxxxxxxx"
TENANT_ID = "default"
API_BASE = "https://idealone.local/api"

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "x-tenant-id": TENANT_ID,
    "Content-Type": "application/json"
}

# Import order
order = {
    "id": "MAYER-ORD-001",
    "client_id": "mayer",
    "client_name": "Mayer",
    "channel": "shopee",
    "order_date": "2026-07-20T10:30:00Z",
    "status": "pending",
    "currency": "SGD",
    "items": [
        {"sku": "SKU-001", "qty": 2, "name": "Item", "unitPrice": 45}
    ],
    "shipping": {
        "recipient": "John Doe",
        "addressLine1": "123 Main St",
        "city": "Singapore",
        "zip": "609216",
        "country": "SG"
    },
    "subtotal": 90,
    "tax": 8.10,
    "total": 98.10
}

response = requests.post(
    f"{API_BASE}/orders/bulk-import",
    headers=headers,
    json={"orders": [order]}
)

print(response.status_code)
print(response.json())
```

---

## Node.js Example (Using fetch)

```javascript
const API_KEY = "mayer_live_xxxxxxxxxxxxxxxxxxxxx";
const TENANT_ID = "default";
const API_BASE = "https://idealone.local/api";

const headers = {
  "Authorization": `Bearer ${API_KEY}`,
  "x-tenant-id": TENANT_ID,
  "Content-Type": "application/json"
};

const order = {
  id: "MAYER-ORD-001",
  client_id: "mayer",
  client_name: "Mayer",
  channel: "shopee",
  order_date: "2026-07-20T10:30:00Z",
  status: "pending",
  currency: "SGD",
  items: [
    { sku: "SKU-001", qty: 2, name: "Item", unitPrice: 45 }
  ],
  shipping: {
    recipient: "John Doe",
    addressLine1: "123 Main St",
    city: "Singapore",
    zip: "609216",
    country: "SG"
  },
  subtotal: 90,
  tax: 8.10,
  total: 98.10
};

fetch(`${API_BASE}/orders/bulk-import`, {
  method: "POST",
  headers,
  body: JSON.stringify({ orders: [order] })
})
  .then(r => r.json())
  .then(data => console.log(data));
```

---

**Version:** 1.0  
**Last Updated:** 2026-07-19  
**Status:** Ready to use
