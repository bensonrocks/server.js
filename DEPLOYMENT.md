# IDEALSCAN + IDEALTMS Deployment Guide

## System Overview

Complete order processing and WMS fulfillment system with integrated transport management.

## Features Completed

### ✅ Core Order Processing
- Multi-line, multi-order CSV/XLSX upload
- WMS-format picklist CSV export
- OCR-based picking list PDF parsing
- Live order scan UI with qty verification
- Inbound receiving & returns processing

### ✅ Transport Management System (IDEALTMS)
- **Delivery Job Planning**: BETIME & Outright Excel import
- **Driver Management**: Drivers, vehicles, zones
- **Geocoding**: Postal code → lat/lng with API caching
- **Route Optimization**: TSP solver for stop sequencing
- **Delivery Confirmation**: Mark deliveries complete/failed
- **Route Reports**: XLSX export for drivers

### ✅ Admin & Analytics
- Activity Overview (daily completion metrics)
- Station Throughput (per-operator statistics)
- Route analytics & driver performance
- Comprehensive audit logging

### ✅ Data Integrity
- Auto-archive for aged orders (60+ days)
- Nightly backups with 14-day retention
- Crash-proof scan journal
- Atomic database writes

## Deployment Checklist

### Environment Configuration
```bash
# .env file must contain:
GOOGLE_MAPS_API_KEY=<your-api-key>
MYSQLHOST=<railway-host>
MYSQLPORT=3306
MYSQLUSER=root
MYSQLPASSWORD=<password>
MYSQL_DATABASE=railway
MASTER_KEY=<admin-password>
```

### Dependencies
```bash
npm install
# Requires: express, mysql2/promise, xlsx, tesseract.js, sharp, nodemailer, etc.
```

### Database
- MySQL required for TMS features only
- Order/batch data persists in `db/db.json` (no MySQL needed)
- Graceful fallback: TMS endpoints return 503 if MySQL unavailable

### Startup
```bash
npm start
# or
node server.js
```

Server listens on `PORT` (default 3000) immediately after startup.
MySQL initialization happens asynchronously in background.

## Feature Access

### Order Processing (no auth required for upload)
- `GET /` — Landing page
- `POST /api/preview` — Validate upload
- `POST /api/upload` — Store orders
- `GET /api/orders` — List orders (requires auth)

### Transport Management (requires auth + MySQL)
- `POST /api/tms/routes/plan` — Auto-optimize routes
- `GET /api/tms/drivers` — List drivers
- `POST /api/tms/drivers` — Add driver
- `GET /api/tms/routes/:id/export` — Download XLSX
- `POST /api/tms/stops/:id/complete` — Mark delivered

### Admin (requires admin role or master key)
- `GET /api/master/dashboard/activity-overview`
- `GET /api/master/dashboard/station-throughput`
- `GET /api/master/report/:kind` — Export reports

## Known Limitations

### Cloud Sandbox Environment
- Railway MySQL proxy unreachable from remote cloud sandbox
- Non-TMS features work without any database
- TMS features gracefully degrade (503 error)
- **Solution**: Deploy to your own Railway project or self-hosted environment

### Browser Support
- Mobile-first responsive design
- Tested in Chrome, Firefox, Safari
- Barcode scanning via BarcodeDetector API (modern browsers)

## Testing

### Quick Start
```bash
# 1. Start server
npm start

# 2. Open browser
open http://localhost:3000

# 3. Upload sample orders CSV
# Required columns: order_number, sku, qty, (optional: waybill_number)

# 4. Test TMS (requires MySQL)
# - Try GET /api/tms/drivers (will return 503 without MySQL)
# - Check logs for MySQL connection status
```

### Manual Testing Checklist
- [ ] Landing page loads
- [ ] File upload form works
- [ ] CSV preview shows errors/validation
- [ ] Orders persist in `/db/db.json`
- [ ] Scan overlay works on mobile
- [ ] TMS endpoints return proper 503 when MySQL unavailable

## Architecture

```
server.js (main)
├─ db/ (JSON file storage for orders)
├─ public/ (HTML/JS/CSS UI)
├─ lib/ (parsers, validators, OCR)
├─ MySQL (TMS data — separate from order db)
│  ├─ drivers
│  ├─ routes
│  ├─ route_stops
│  ├─ zones
│  └─ geocoding_cache
└─ DATA_DIR/ (batches, archives, backups, photos)
```

## Next Steps

### Before Production
1. Configure Railway MySQL (or self-hosted)
2. Set `GOOGLE_MAPS_API_KEY` for geocoding
3. Set `MASTER_KEY` to secure admin access
4. Test TMS flow: upload order → plan routes → mark delivered
5. Configure email for nightly backups
6. Set up log rotation & monitoring

### Sync with IdealScan
TMS importer functions (lib/tms-importer.js) are designed to be ported:
1. Copy `lib/tms-importer.js` verbatim
2. Port TMS endpoints to IdealScan
3. Update both CLAUDE.md files with same Transport section
4. Link commits in PR for sync tracking

## Support

### Troubleshooting
- **Server won't start**: Check `.env` file, Node version (14+)
- **Orders not saving**: Verify `/db` directory is writable
- **TMS returns 503**: MySQL not connected; check credentials & network
- **Geocoding fails**: Verify Google Maps API key is valid & has quota
- **Auth errors**: Check session token in browser DevTools → Application → Cookies

### Logs
- Server startup messages logged to stdout
- Errors logged with `[Component]` prefix
- Audit events in `/db/audit-log.ndjson`
- MySQL errors logged with `[MySQL]` prefix
