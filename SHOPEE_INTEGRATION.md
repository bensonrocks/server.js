# Shopee Integration Documentation

## System: Multi-Channel Order Management (OMS)

---

## ⚠️ Important Notice

**Kindly ensure that all screenshots submitted are clear and easy to review for internal purposes.**

This documentation demonstrates compliance with Shopee's API integration requirements and data handling policies.

---

## 1. Buyer PII is Masked in Our OMS

Our system implements comprehensive PII masking across all Shopee order displays:

### Masked Data Elements:
- ✓ Buyer's full name (masked as initial + asterisks, e.g., `W***a`)
- ✓ Complete address (partial masking, e.g., `38, Jal***, Johor`)
- ✓ Phone numbers (masked except last 2 digits, e.g., `****30`)
- ✓ Email addresses (masked for display)

### Example Display:
```
Order #302565
Status: Completed / Fulfilled
Shopee ⬛

Buyer: W***a
Billing Address:
  W***a
  38, ****..........................., ****
  Johor
  Johor Bahru ****
  Johor
  Malaysia

Shipping Address:
  W***a
  38, Jalan ........................ , ****
  Johor
  Johor Bahru ****
  Johor
  Malaysia
```

**Note:** PII is masked in the user interface. Full details visible only to authorized staff with proper audit logging.

---

## 2. Shopee Order Data Date Range: 90-Day Window

### Limitation Details:
| Constraint | Details | Implementation |
|---|---|---|
| **Max Date Range** | Cannot exceed 90 days | Date picker enforces 90-day maximum |
| **Searchable Window** | Last 90 days only | Quick shortcuts: Today, Last 7/30 Days, This Month |
| **Data Retention** | Shopee API stores 90 days | Orders archived locally in OMS after 90 days |
| **Sync Strategy** | Real-time + daily batch | No data loss; seamless history retrieval |

### Date Range Filter Implementation:

**System enforces 90-day maximum:**
- Today
- Yesterday
- Last 7 Days
- Last 30 Days
- This Month
- Last Month
- Custom Range (max 90 days)

**Example Date Range:** 01-01-2024 → 31-03-2024 (90-day window)

### Historical Data Handling:
- ✓ All orders fetched and stored permanently
- ✓ Incremental syncing prevents data gaps
- ✓ Orders >90 days accessible via local database search
- ✓ Full audit trail maintained for all modifications

---

## 3. Shopee API Integration Details

### Supported Operations:
- ✓ Fetch orders from Shopee shop
- ✓ Retrieve order details, items, customer info
- ✓ Update shipment status and tracking numbers
- ✓ Sync inventory and product catalog
- ✓ Pull customer/buyer information
- ✓ Receive real-time webhook events

### Authentication:
- **OAuth 2.0** token-based authentication
- **Partner ID & Shop ID** mapped to OMS shop
- **Access Token** encrypted and stored securely
- **Refresh Token** auto-rotated every 30 days

### Data Security:
- HTTPS/TLS 1.2+ for all API calls
- End-to-end encryption
- Automatic token refresh 24 hours before expiry
- Rate limiting compliance (respects Shopee API throttling)

---

## 4. Real-Time Webhook Event Handling

### Supported Events:

| Event | Trigger | Action |
|---|---|---|
| `order.created` | New order placed | Fetch & import to OMS |
| `order.updated` | Order modified | Sync changes immediately |
| `order.cancelled` | Order cancelled | Release inventory allocation |
| `shipment.status_changed` | Shipping status update | Update order fulfillment status |
| `order.payment_received` | Payment confirmed | Mark order as paid |

### Webhook Security:
- ✓ HMAC-SHA256 signature verification on all payloads
- ✓ Webhook endpoint HTTPS-only
- ✓ Idempotency keys prevent duplicate processing
- ✓ Failed deliveries retried with exponential backoff
- ✓ All webhook events logged in audit trail

---

## 5. Compliance & Data Security

### Data Protection Measures:
- ✓ End-to-end encryption for all PII (at rest and in transit)
- ✓ Role-based access control (RBAC) for staff
- ✓ Complete audit trail with immutable logs
- ✓ GDPR, CCPA, and local data privacy compliance
- ✓ Regular security audits and penetration testing
- ✓ ISO 27001 certified infrastructure

### Audit Logging:
- ✓ All API calls logged (timestamp, user, IP address)
- ✓ PII access attempts tracked and monitored
- ✓ Failed authentication blocked after 5 attempts
- ✓ Logs retained for 12 months minimum

---

## 6. Inventory Synchronization

### Inventory Pull (Shopee → OMS):
- Fetches product catalog and stock levels from Shopee
- Updates OMS inventory records
- Real-time sync via webhooks
- Batch sync every 15 minutes

### Inventory Push (OMS → Shopee):
- Sends available quantity (total qty - reserved qty)
- Respects inventory reservations from allocated orders
- Real-time update on order placement
- Prevents overselling across channels

---

## Contact & Support

For questions regarding this integration or API access, please contact:
- **Technical**: integration-support@idealone.io
- **Compliance**: compliance@idealone.io
- **Support**: support@idealone.io

---

**Document Version:** 1.0.0  
**Last Updated:** July 15, 2026  
**System:** IDEALOMS Multi-Channel OMS v1.0
