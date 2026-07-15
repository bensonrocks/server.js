# ZORT Integration Setup & Testing Guide

## Credentials
```
Endpoint: https://open-api.zortout.com/v4
Storename: bensonscottlee@gmail.com
API Key: CgGeCuccHSlLyfvylquf2BHilySUJn4lgHEQhqXV0=
API Secret: VZJM3P4gwUu5BgPQeAtO/4SGrkr0EKT6YnbUeMbHV4=
Regions: TH, MY, SG, ID, PH, VN
```

## Local Testing

### 1. Start Server
```bash
npm run build
npm start
# Server runs at http://localhost:3000
```

### 2. Save ZORT Credentials
```bash
curl -X POST http://localhost:3000/api/connect/zort \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: default" \
  -d '{
    "storeName": "bensonscottlee@gmail.com",
    "storename": "bensonscottlee@gmail.com",
    "apikey": "CgGeCuccHSlLyfvylquf2BHilySUJn4lgHEQhqXV0=",
    "apisecret": "VZJM3P4gwUu5BgPQeAtO/4SGrkr0EKT6YnbUeMbHV4="
  }'
```

### 3. Test ZORT Endpoints

**Fetch Orders from all platforms (Lazada, Shopee, TikTok, Shopify)**
```bash
curl -X POST http://localhost:3000/api/sync/zort \
  -H "x-tenant-id: default"
```

**Pull Inventory Stock Levels**
```bash
curl -X POST http://localhost:3000/api/connect/zort/inventory/pull \
  -H "x-tenant-id: default"
```

**Push OMS Stock → ZORT**
```bash
curl -X POST http://localhost:3000/api/connect/zort/inventory/push \
  -H "x-tenant-id: default"
```

**Fetch Customers/Contacts**
```bash
curl -X GET http://localhost:3000/api/connect/zort/customers \
  -H "x-tenant-id: default"
```

**Sync Products → OMS Inventory**
```bash
curl -X POST http://localhost:3000/api/connect/zort/products/sync \
  -H "x-tenant-id: default"
```

**Register Webhook**
```bash
curl -X POST http://localhost:3000/api/connect/zort/webhook/register \
  -H "x-tenant-id: default" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-domain.com/webhook/zort"}'
```

## Production Deployment (Railway)

### Prerequisites
- Railway account: https://railway.app
- GitHub account with this repo pushed publicly

### Steps

1. **Push to GitHub**
   ```bash
   git remote add github https://github.com/yourname/server.js.git
   git push github claude/ecommerce-order-dashboard-cxMNo
   ```

2. **Create Railway Project**
   - Go to https://railway.app
   - New Project → GitHub Repo
   - Select `bensonrocks/server.js`
   - Railway auto-detects `railway.toml`

3. **Set Environment Variables**
   ```
   PORT=3000
   BASE_URL=https://{your-railway-app}.railway.app
   IDEAL_SUPER_PASSWORD=YourSecurePassword
   SYNC_INTERVAL_MINUTES=15
   ```

4. **Deploy**
   - Railway auto-deploys on push to main/master
   - Or manually trigger deployment in Dashboard

5. **Test Production**
   ```bash
   curl -X POST https://{your-railway-app}.railway.app/api/sync/zort \
     -H "x-tenant-id: default"
   ```

## ZORT Integration Points

### Order Sync
- **Endpoint**: `POST /api/sync/zort`
- **Handler**: `gateway.fetchOrders('zort', creds, opts)`
- **Returns**: Array of StandardOrder objects
- **Maps**: Order status, items, customer, shipping address, pricing

### Inventory Sync
- **Pull**: `POST /api/connect/zort/inventory/pull`
  - Fetches stock levels from ZORT
  - Updates OMS inventory_qty for existing SKUs
- **Push**: `POST /api/connect/zort/inventory/push`
  - Calculates available qty as (stock_qty - reserved_qty)
  - Sends to ZORT via `/Product/AdjustInventory`

### Webhook Events
- **Registration**: `POST /api/connect/zort/webhook/register`
- **Receiver**: `POST /webhook/zort`
- **Events**: 
  - order.created / modified / status_changed / tracking_changed
  - product.quantity_changed
  - contact.created / modified
- **Handler**: Logs to audit trail; TODO domain handlers for real-time sync

### Platforms Unified Under ZORT
1. **Lazada** — Orders, inventory, customers
2. **Shopee** — Orders, inventory, customers  
3. **TikTok Shop** — Orders, inventory, customers
4. **Shopify** — Orders, inventory, customers

All managed through single ZORT API account.

## Troubleshooting

**Connection Error**
- Verify storename, apikey, apisecret are correct
- Check BASE_URL environment variable for webhook URL
- Ensure server has outbound HTTPS access to open-api.zortout.com

**Webhook Not Registering**
- BASE_URL must be publicly accessible
- ZORT must be able to POST to {BASE_URL}/webhook/zort
- Check webhook registration response for ZORT errors

**Inventory Push Showing 0**
- Ensure OMS inventory has at least one SKU
- Check that reserved_qty is correctly calculated
- Verify ZORT accepts the SKU format
