# Mayer Client Onboarding Email Templates

---

## Email 1: Welcome & Account Activation

**Subject:** Welcome to IdealOMS - Your Account is Ready! 🎉

```
Hi Mayer Team,

Welcome to IdealOMS! We're excited to have you on board.

Your account has been set up and is ready to go. Here's what you need to know:

## Account Details
- Client ID: mayer
- Tenant: default
- Admin Portal: https://idealone.local/portal
- API Docs: https://idealone.local/docs

## Getting Started (3 Steps)
1. Log in to the portal with your credentials (check separate email)
2. Review your Profile → Connected Platforms
3. Start importing orders via API or dashboard upload

## Your Special Features
✅ Product Bundling - Create packages like "Gift Bundle" or "Starter Kit"
✅ Virtual Warehouse - Manage dropship, supplier, and affiliate SKUs
✅ Multi-channel Orders - Accept from Shopee, Lazada, TikTok, Shopify, Zort, etc.

## Documentation
📖 Complete Onboarding Guide: /docs/MAYER_ONBOARDING.md
🔌 API Reference: /docs/API.md
📊 Dashboard Tutorial: /docs/DASHBOARD.md

## Next Steps
- Confirm you received this email
- Try importing a test order (template included)
- Schedule kickoff call with our team

Need help? Reply to this email or contact support@idealone.local

Best regards,
IdealOMS Team
```

---

## Email 2: API Key + Credentials

**Subject:** Your API Credentials - Keep Secure ⚠️

```
Hi Mayer Team,

Here are your secure login credentials. Keep these private!

## Account Credentials
- Username: mayer-admin
- Temporary Password: [GENERATED_PASSWORD]
- First Login: https://idealone.local/portal
  ACTION: Change password immediately after first login

## API Key
- Key: mayer_live_xxxxxxxxxxxxxxxxxxxxx
- Secret: sk_live_yyyyyyyyyyyyyyyyyyyyy
  ACTION: Store securely (password manager, environment variable, etc.)

## Authentication
All API calls require this header:
```
Authorization: Bearer mayer_live_xxxxxxxxxxxxxxxxxxxxx
x-tenant-id: default
```

## API Endpoints
- Base URL: https://idealone.local/api
- Order Import: POST /orders/bulk-import
- View Config: GET /clients/mayer/config
- View Bundles: GET /clients/mayer/bundles
- View Virtual SKUs: GET /clients/mayer/virtual-skus

## Security Best Practices
1. ❌ Never commit API key to code
2. ❌ Never share API key in emails
3. ✅ Use environment variables (.env)
4. ✅ Rotate keys quarterly
5. ✅ Enable 2FA on portal account

## Test Your Connection
```bash
curl https://idealone.local/api/clients/mayer/config \
  -H "Authorization: Bearer mayer_live_xxxxxxxxxxxxxxxxxxxxx" \
  -H "x-tenant-id: default"
```

If you see a JSON response, you're connected!

Need to regenerate? Contact support@idealone.local

IdealOMS Team
```

---

## Email 3: Product Configuration Guide

**Subject:** Setting Up Your Bundles & Virtual Warehouse

```
Hi Mayer Team,

It's time to configure your products! Here's how:

## Step 1: Define Your Bundles

Example: "Premium Gift Bundle" (GIFT-BUNDLE-001)
```
POST /api/clients/mayer/bundles
{
  "bundleSku": "GIFT-BUNDLE-001",
  "bundleName": "Premium Gift Bundle",
  "description": "3-piece home care bundle",
  "components": [
    { "sku": "AIR-PURIF", "qty": 1, "name": "Air Purifier", "unitPrice": 250 },
    { "sku": "AMBER-EDP", "qty": 1, "name": "Perfume", "unitPrice": 120 },
    { "sku": "CUSHION", "qty": 1, "name": "Lumbar Cushion", "unitPrice": 45 }
  ]
}
```

When a customer orders 1x GIFT-BUNDLE-001, we'll automatically pick:
- 1x Air Purifier
- 1x Perfume
- 1x Lumbar Cushion

## Step 2: Mark Virtual (Dropship/Supplier) Items

Example: "Dropship Item from FBA" (DROPSUP-001)
```
POST /api/clients/mayer/virtual-skus
{
  "sku": "DROPSUP-001",
  "warehouseName": "Dropship Warehouse",
  "fulfillmentMethod": "dropship",
  "supplierInfo": "Amazon FBA - Warehouse ABC"
}
```

Virtual items:
- Won't check our inventory
- Will show as "sourced" in fulfillment
- Get marked for special handling

## Step 3: Test Your Config

```
GET /api/clients/mayer/bundles
GET /api/clients/mayer/virtual-skus
```

## What You Should Configure
[ ] Create 2-3 bundled products (if applicable)
[ ] List 5-10 dropship/supplier SKUs (if applicable)
[ ] Verify bundle component quantities
[ ] Test with a sample order

## Sample Test Order
```json
{
  "orders": [
    {
      "id": "TEST-MAYER-001",
      "client_id": "mayer",
      "client_name": "Mayer",
      "channel": "shopee",
      "order_date": "2026-07-20T10:00:00Z",
      "status": "pending",
      "currency": "SGD",
      "items": [
        { "sku": "GIFT-BUNDLE-001", "qty": 1, "name": "Premium Gift Bundle", "unitPrice": 415 },
        { "sku": "DROPSUP-001", "qty": 2, "name": "Dropship Item", "unitPrice": 99 }
      ],
      "shipping": {
        "recipient": "Test Customer",
        "addressLine1": "123 Test Street",
        "city": "Singapore",
        "zip": "609216",
        "country": "SG"
      },
      "subtotal": 613,
      "tax": 55,
      "total": 668
    }
  ]
}
```

Once configured, reply to let us know you're ready!

IdealOMS Team
```

---

## Email 4: Order Import Instructions

**Subject:** How to Send Orders to IdealOMS

```
Hi Mayer Team,

Time to start sending orders! Here's how:

## Two Ways to Import Orders

### Option A: API Integration (Recommended for High Volume)
```bash
curl -X POST https://idealone.local/api/orders/bulk-import \
  -H "Authorization: Bearer mayer_live_xxxxxxxxxxxxxxxxxxxxx" \
  -H "x-tenant-id: default" \
  -H "Content-Type: application/json" \
  -d '{
    "orders": [
      {
        "id": "ORD-001",
        "client_id": "mayer",
        "client_name": "Mayer",
        "channel": "shopee",
        "order_date": "2026-07-20T14:30:00Z",
        "status": "pending",
        "currency": "SGD",
        "items": [
          { "sku": "SKU-001", "qty": 2, "name": "Product", "unitPrice": 50 }
        ],
        "shipping": {
          "recipient": "Customer Name",
          "addressLine1": "Address",
          "city": "Singapore",
          "zip": "609216",
          "country": "SG"
        },
        "subtotal": 100,
        "tax": 9,
        "total": 109
      }
    ]
  }'
```

### Option B: Dashboard Upload
1. Go to https://idealone.local/portal
2. Orders → Import
3. Select CSV or JSON file
4. Review & confirm

## Required Fields for Each Order
- `id` (unique order ID)
- `client_id` (must be "mayer")
- `channel` (shopee, lazada, tiktok, shopify, zort, etc.)
- `order_date` (ISO format: 2026-07-20T14:30:00Z)
- `items[]` with sku, qty, unitPrice
- `shipping.recipient` (customer name)
- `shipping.addressLine1` (street)
- `shipping.city` (city)
- `shipping.zip` (postal code)
- `shipping.country` (country code, e.g., SG)
- `subtotal`, `tax`, `total`

## Order Status Flow
- pending: order received, awaiting confirmation
- confirmed: order accepted, ready to process
- processing: inventory reserved, picking started
- packed: items packed into carton, ready to ship
- shipped: order shipped to customer

## Tips
✅ Use unique order IDs (system won't accept duplicates)
✅ Always include shipping address (required for fulfillment)
✅ Use correct currency (SGD for Singapore orders)
✅ Include bundle SKUs if applicable (we'll expand automatically)
✅ Batch imports (20-50 orders) are more efficient than single orders

## Support
- 400 Error? Check order format against template
- 404 Error? Verify order ID isn't duplicate
- Need help? Email support@idealone.local with order ID

Ready to start? Send us your first test order!

IdealOMS Team
```

---

## Email 5: Fulfillment & Shipping Overview

**Subject:** Order Fulfillment Process - What Happens Next

```
Hi Mayer Team,

Once orders arrive, here's what happens:

## The Fulfillment Pipeline

### 1️⃣ Order Received (Status: pending)
- Order arrives via API/upload
- Validated for completeness
- Assigned to warehouse

### 2️⃣ Confirmed (Status: confirmed)
- Order accepted by warehouse
- Ready to process

### 3️⃣ Processing (Status: processing)
- Inventory **reserved** (marked as "spoken for")
- Picking list generated
- Staff begins picking items

### 4️⃣ Packed (Status: packed)
- All items picked and packed into carton
- Shipping label generated
- Ready for pickup

### 5️⃣ Shipped (Status: shipped)
- Order handed to courier
- Inventory **deducted** from stock
- Tracking number provided
- Customer notified

## What About Bundles?

Example: Customer orders 1x GIFT-BUNDLE-001
1. System expands bundle → 3 components
2. Picks: AIR-PURIF (1) + AMBER-EDP (1) + CUSHION (1)
3. Packs all into one box
4. Shipping label shows 1 package (not 3)
5. Customer receives bundled gift

## What About Virtual Items?

Example: Customer orders 2x DROPSUP-001 (dropship)
1. System flags as "virtual" - no inventory check
2. Marked for "dropship/sourcing"
3. Staff sources from supplier/FBA
4. Once received, packed with other items
5. Shipped to customer

## Cancellations

If a customer wants to cancel BEFORE shipping:
1. Request cancellation
2. Manager reviews & approves/rejects
3. If approved: order marked as cancelled, reserved inventory released
4. Customer gets refund

If order ALREADY SHIPPED: Cannot cancel (must handle return instead)

## Tracking & Updates

- Each order gets unique tracking number
- Shipping URL included in customer notification
- Dashboard shows real-time status updates
- Return/replacement requests tracked separately

## FAQs

**Q: What if we run out of stock?**
A: Orders stay in "processing" until stock arrives. Manual intervention needed.

**Q: Can customers change address after order placed?**
A: Only if still in "pending/confirmed" status. After processing, address locked.

**Q: How do I know when items arrive at warehouse?**
A: Dashboard shows real-time status. Updates sent via webhook if configured.

**Q: Do bundles count as 1 or 3 items in packing materials?**
A: 1 customer order = 1 shipping box, regardless of bundle size.

Let us know if you have more questions!

IdealOMS Team
```

---

## Email 6: Support & Escalation

**Subject:** Support Contacts & Emergency Procedures

```
Hi Mayer Team,

Here's how to get help:

## Support Channels

### 📧 Email Support (24-48hr response)
- support@idealone.local
- api-support@idealone.local (for API issues)

### 🆘 Urgent Support (Same-day)
- Phone: +65-1234-5678
- Email subject: [URGENT] ...
- Available: Mon-Fri, 9 AM - 6 PM SGT

### 💬 Chat Support (During business hours)
- Available in dashboard at idealone.local/portal

## Common Issues & Quick Fixes

**"Order not importing"**
→ Check: unique ID, all required fields, JSON format
→ Test: API connection with curl

**"Bundle not expanding"**
→ Check: Bundle SKU matches exactly
→ Test: GET /api/clients/mayer/bundles (verify exists)

**"Inventory shortage"**
→ Check: Current stock levels in dashboard
→ Action: Contact support to restock

**"Can't access portal"**
→ Reset password: forgot password link
→ Check: Browser cookies enabled
→ Try: Incognito window

**"API authentication failing"**
→ Check: API key correct & not expired
→ Check: Header format: Authorization: Bearer KEY
→ Check: Tenant header: x-tenant-id: default

## Escalation Path

1. Try fix from above → 2 hrs
2. Email support@idealone.local → 24-48 hrs
3. Phone if urgent → Same day
4. Escalate to account manager → Next business day

## What to Include in Support Emails

- Order ID (if applicable)
- Error message (full text, including code)
- Timestamp when error occurred
- What you were trying to do
- Steps to reproduce the issue
- Screenshots (if helpful)

## Service Level Agreement (SLA)

| Issue | Response Time | Resolution Time |
|-------|-------|---|
| Critical (orders blocked) | 1 hour | 4 hours |
| High (API errors) | 2 hours | 8 hours |
| Medium (slow performance) | 4 hours | 24 hours |
| Low (documentation) | 24 hours | 5 days |

## Maintenance Windows

- **Planned maintenance**: Posted 72 hours in advance
- **Typical window**: Sundays 2-4 AM SGT
- **Emergency maintenance**: As needed, with notification

Stay in touch, and don't hesitate to reach out!

IdealOMS Team
```

---

## Email 7: Go-Live Checklist

**Subject:** Final Checklist Before Go-Live ✅

```
Hi Mayer Team,

You're almost ready! Just a few final checks:

## Pre-Launch Checklist

### Account Setup
- [ ] Portal login confirmed
- [ ] API key generated and stored securely
- [ ] 2FA enabled on account
- [ ] Admin user created

### Product Configuration
- [ ] All bundles defined and tested
- [ ] All virtual (dropship) SKUs marked
- [ ] Inventory uploaded (minimum stock for launch SKUs)
- [ ] Test order imported successfully

### Integration
- [ ] API endpoint responding to test calls
- [ ] Order format validated
- [ ] Authentication headers correct
- [ ] Error handling understood

### Fulfillment Understanding
- [ ] Order workflow understood (pending → shipped)
- [ ] Bundle expansion verified
- [ ] Virtual item handling confirmed
- [ ] Cancellation approval process reviewed

### Support
- [ ] Support contacts saved
- [ ] SLA understood
- [ ] Documentation reviewed
- [ ] Emergency contact obtained

## Go-Live Testing (Mandatory)

Send 3 test orders covering:
1. Bundle order (1x bundle + 1 regular item)
2. Virtual/dropship order (2-3 virtual items)
3. Regular order (standard SKUs only)

Track these through the full workflow:
- pending → confirmed → processing → packed → shipped

## Sign-Off

Once you've completed the checklist, reply confirming:
- [ ] All items checked
- [ ] Test orders completed
- [ ] Team is ready
- [ ] Go-live date: [DATE]

We'll enable live mode and you're officially go-live!

Questions? This is the time to ask!

IdealOMS Team
```

---

**Template Version:** 1.0  
**Last Updated:** 2026-07-19  
**Status:** Ready to send
