# Railway Deployment Guide - SERVER.JS

## Quick Start (5 minutes)

### 1. Push to GitHub

```bash
git remote add github https://github.com/bensonrocks/server.js.git
git push github claude/ecommerce-order-dashboard-cxMNo
```

### 2. Deploy on Railway

1. Go to **https://railway.app**
2. Login/Sign up with GitHub
3. Click **New Project** → **GitHub Repo**
4. Select `bensonrocks/server.js`
5. Railway auto-detects `railway.toml` and builds
6. Wait for deployment (2-3 minutes)

### 3. Set Environment Variables

Once deployed, in Railway Dashboard → Project → Variables:

```
PORT=3000
BASE_URL=https://{your-app-name}.railway.app
IDEAL_SUPER_PASSWORD=YourSecureAdminPassword
SYNC_INTERVAL_MINUTES=15
```

### 4. Test ZORT Connection

Once deployed, your app is live at `https://{your-app-name}.railway.app`

**Save ZORT Credentials:**
```bash
curl -X POST https://{your-app-name}.railway.app/api/connect/zort \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: default" \
  -d '{
    "storeName": "bensonscottlee@gmail.com",
    "storename": "bensonscottlee@gmail.com",
    "apikey": "CgGeCuccHSlLyfvylquf2BHilySUJn4lgHEQhqXV0=",
    "apisecret": "VZJM3P4gwUu5BgPQeAtO/4SGrkr0EKT6YnbUeMbHV4="
  }'
```

**Fetch Shopee + Lazada + TikTok + Shopify Orders:**
```bash
curl -X POST https://{your-app-name}.railway.app/api/sync/zort \
  -H "x-tenant-id: default"
```

**Pull Inventory from ZORT:**
```bash
curl -X POST https://{your-app-name}.railway.app/api/connect/zort/inventory/pull \
  -H "x-tenant-id: default"
```

**Push OMS Inventory to ZORT:**
```bash
curl -X POST https://{your-app-name}.railway.app/api/connect/zort/inventory/push \
  -H "x-tenant-id: default"
```

**Sync Products to OMS:**
```bash
curl -X POST https://{your-app-name}.railway.app/api/connect/zort/products/sync \
  -H "x-tenant-id: default"
```

**Register Webhook:**
```bash
curl -X POST https://{your-app-name}.railway.app/api/connect/zort/webhook/register \
  -H "x-tenant-id: default" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://{your-app-name}.railway.app/webhook/zort"}'
```

---

## What's Deployed

- ✅ **ZORT Integration** (all 8 gaps fixed)
  - Order sync (Lazada, Shopee, TikTok, Shopify)
  - Inventory pull/push
  - Product sync
  - Real-time webhooks
  - PII masking compliance

- ✅ **Shopee Documentation**
  - Screenshots with masked PII examples
  - Date range picker details
  - Webhook event flow
  - API security details

- ✅ **Test Suite** (`test-zort.sh`)
  - Automated testing for all endpoints
  - Color-coded results

---

## Continuous Deployment

Railway auto-deploys on every push to `claude/ecommerce-order-dashboard-cxMNo`

```bash
# Make changes
git commit -am "your message"
git push github claude/ecommerce-order-dashboard-cxMNo

# Railway auto-redeploys (watch in dashboard)
```

---

## Logs & Monitoring

**View Live Logs:**
- Railway Dashboard → Project → Deployments → View Logs

**Monitor API Calls:**
- Audit trail in `/data/audit.db` (SQLite)
- All ZORT API calls logged automatically

---

## Troubleshooting

**ZORT Connection Error**
- Verify credentials are correct
- Check BASE_URL is set to your Railway app URL
- Ensure server can reach https://open-api.zortout.com

**Webhook Not Registering**
- BASE_URL must be publicly accessible
- ZORT must be able to POST to /webhook/zort
- Check webhook registration response for errors

**Inventory Not Syncing**
- Verify SKUs exist in both ZORT and OMS
- Check that reserved_qty is correct
- Review audit logs for specific errors

---

## Next Steps

1. ✅ Deploy to Railway
2. ✅ Connect ZORT credentials
3. ⏳ Register webhook
4. ⏳ Sync first orders from Shopee/Lazada/TikTok/Shopify
5. ⏳ Test inventory sync

---

**Documentation:** See `ZORT_SETUP.md` and `SHOPEE_INTEGRATION_WITH_SCREENSHOTS.html`
