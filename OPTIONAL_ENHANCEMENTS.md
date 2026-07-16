# Optional Enhancements - WMS System

This document describes 6 optional enhancements added to the core WMS system, providing advanced capabilities for barcode scanning, AI-driven replenishment, smart forecasting, OCR label processing, zone-based auditing, and mobile warehouse operations.

---

## 1. Real Barcode Scanning (bwip-js Integration)

**Module**: `lib/barcode-scanner.js`  
**Status**: ✅ Implemented (dual-mode: real + fallback)

### Features

- **Real Scannable Barcodes**: Generate CODE128 barcodes using `bwip-js` (production-ready)
- **Fallback SVG**: Visual-only SVG barcodes when library unavailable
- **Label Integration**: Embed barcodes into HTML shipping labels
- **Validation**: Verify barcode format (CODE128, EAN, etc.)

### API Endpoints

```
POST /api/barcode/generate          Generate scannable barcode
POST /api/barcode/validate          Validate barcode format
POST /api/barcode/label             Generate shipping label with embedded barcode
```

### Usage Example

```javascript
// Generate real barcode (scannable)
const barcode = await POST('/api/barcode/generate', {
  data: 'TXSGd20260001234',  // Tracking number
  options: { format: 'code128', height: 40 }
});
// → { type: 'real_barcode', svg: '<svg>...', scannable: true }

// Generate shipping label with barcode
const label = await POST('/api/barcode/label', {
  orderNumber: 'ORD-001234',
  trackingNumber: 'TXSGd20260001234',
  recipientName: 'John Doe',
  address: '123 Main St',
  postalCode: '654321'
});
// → { htmlLabel: '<html>...with embedded barcode...</html>' }
```

### Production Deployment

**Requirement**: Install `bwip-js` for real barcode generation

```bash
npm install bwip-js
```

Once installed, barcode generation automatically switches to real CODE128 format. Fallback SVG is used only if library unavailable.

**Cost**: Free (open-source)

---

## 2. Auto-Trigger Replenishment Waves

**Module**: `lib/auto-trigger-scheduler.js`  
**Status**: ✅ Implemented (scheduler-based)

### Features

- **Automatic Wave Creation**: Monitors pick-face inventory every 4 hours
- **Priority-Based**: Creates waves for high-velocity items first (>3 picks/day)
- **Smart Thresholds**: Triggers when pick-face drops below 50% capacity
- **Configurable Intervals**: Change schedule via environment variables
- **All Warehouses**: Runs across multiple warehouses concurrently

### API Endpoints

```
POST /api/auto-trigger/start        Start scheduler
POST /api/auto-trigger/stop         Stop scheduler
GET  /api/auto-trigger/status       Get scheduler status
```

### Usage Example

```javascript
// Start auto-trigger scheduler (4 hours interval)
const result = await POST('/api/auto-trigger/start', {
  intervalMinutes: 240
});
// → { status: 'started', nextRun: '2026-07-16T20:15:00Z' }

// Check if running
const status = await GET('/api/auto-trigger/status');
// → { running: true, intervalMs: 'active' }

// Stop scheduler
await POST('/api/auto-trigger/stop');
```

### Configuration

```javascript
// In server.js, customize scheduler settings:
const scheduler = createAutoTriggerScheduler(db, replenishment);

// Start with custom interval
scheduler.startScheduler(240);  // Every 4 hours (default)

// Auto-trigger threshold settings:
{
  minVelocity: 0.5,           // Only items with >0.5 picks/day
  maxPickFaceQty: 50,         // Target pick-face size
  thresholdPct: 50,           // Trigger at 50% capacity
  autoCreateWave: true        // Automatically create waves
}
```

### Workflow

```
Every interval:
  1. Query all warehouses
  2. Calculate SKU velocity (picks/day)
  3. Check pick-face levels
  4. Identify items below 50% capacity
  5. For high-velocity items (priority ≥ 3):
     - Select source batch (oldest, non-expired)
     - Calculate replenish quantity
     - Create replenishment wave
     - Log activity
```

---

## 3. ML Demand Forecasting

**Module**: `lib/demand-forecast.js`  
**Status**: ✅ Implemented (3 algorithms)

### Features

- **Three Forecasting Methods**:
  1. Moving Average (baseline, stable demand)
  2. Exponential Smoothing (responsive to trends)
  3. Seasonal Decomposition (weekly/daily patterns)
- **Auto-Selection**: Chooses best method based on historical data
- **Reorder Points**: Calculates when to replenish
- **Safety Stock**: Buffers against unexpected demand spikes
- **Inventory Gap Detection**: Identifies SKUs at risk of stockout

### API Endpoints

```
GET  /api/forecast/demand/:skuId             Forecast demand for SKU
GET  /api/forecast/reorder-point/:skuId      Calculate reorder point
GET  /api/forecast/inventory-gap             List SKUs at risk
```

### Usage Example

```javascript
// Forecast demand for SKU
const forecast = await GET('/api/forecast/demand/SKU-001?days=30&method=auto');
// → {
//   method: 'seasonal_decomposition',
//   forecast: 45,                    // Expected picks/day
//   forecastWeekly: 315,
//   forecastMonthly: 1350,
//   confidence: 85,                  // 0-100
//   selectedReason: 'Seasonal patterns detected'
// }

// Calculate when to reorder
const reorder = await GET('/api/forecast/reorder-point/SKU-001?leadTime=7&safetyStock=7');
// → {
//   dailyDemand: 45,
//   reorderPoint: 315,               // Reorder when < this qty
//   safetyStock: 315,
//   economicOrderQty: 420,           // Optimal order size
//   currentStock: 200,
//   needsReplenishment: true,
//   daysOfStockRemaining: 4
// }

// Identify inventory gaps
const gaps = await GET('/api/forecast/inventory-gap?warehouseId=wh-main&days=30');
// → {
//   skusAtRisk: 3,
//   items: [
//     { skuId: 'SKU-001', currentStock: 200, daysUntilStockout: 4, priority: 'critical' }
//   ]
// }
```

### Algorithm Details

#### Moving Average
- **Formula**: `forecast = avg(last_N_days)`
- **Use**: Stable demand, minimal seasonality
- **Weakness**: Lags on trend changes

#### Exponential Smoothing
- **Formula**: `forecast = (actual × α) + (forecast_prev × (1-α))`
- **Use**: Recent data more important
- **Tuning**: α = 0.3 (default, change in code)

#### Seasonal Decomposition
- **Pattern**: Detects day-of-week multipliers
- **Use**: Clear weekly patterns (retail, e-commerce)
- **Example**: Mondays = 1.2x average, Fridays = 0.9x

### Confidence Scoring

- < 50%: Unreliable (insufficient data)
- 50-70%: Caution (high variance)
- 70-85%: Good (normal variance)
- \> 85%: Excellent (stable, predictable)

---

## 4. OCR Label Extraction

**Module**: `lib/ocr-labels.js`  
**Status**: ✅ Implemented (pattern-based + deployment guidance)

### Features

- **Pattern-Based Extraction**: Works without external OCR initially
- **Tracking Number Detection**: Recognizes TRACX, SGDEX, postal formats
- **Address Parsing**: Extracts street, city, postal code
- **Recipient Name**: Extracts "To:" and "Ship To:" fields
- **Confidence Scoring**: Flags fields needing manual review
- **Multiple OCR Backend Support**: Ready for Google Vision, AWS Textract, Tesseract

### API Endpoints

```
POST /api/ocr/extract               Extract fields from label text
POST /api/ocr/validate              Validate extracted fields
POST /api/ocr/process-image         Process image (awaits backend integration)
```

### Usage Example

```javascript
// Extract from label text
const extracted = await POST('/api/ocr/extract', {
  text: `
    Order #: ORD-001234
    To: John Doe
    123 Main Street
    Singapore 654321
    Tracking: TXSGD20260001234
  `
});
// → {
//   status: 'success',
//   extracted: {
//     trackingNumber: { value: 'TXSGD20260001234', confidence: 0.95 },
//     orderNumber: { value: 'ORD-001234', confidence: 0.95 },
//     recipientName: { value: 'John Doe', confidence: 0.95 },
//     postalCode: { value: '654321', confidence: 0.95 }
//   },
//   overallConfidence: 95,
//   needsManualReview: false
// }

// Validate extracted data
const validation = await POST('/api/ocr/validate', {
  extracted: { trackingNumber: { value: 'TXSGD20260001234' }, ... }
});
// → {
//   valid: true,
//   criticalIssues: 0,
//   warnings: 0,
//   needsManualReview: false
// }
```

### Production Deployment Guide

Choose **one** OCR backend for production:

#### Option A: Google Cloud Vision (Recommended)
- **Accuracy**: 95%+ for standard labels
- **Setup**:
  ```bash
  npm install @google-cloud/vision
  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json
  ```
- **Cost**: $1.50 per 1000 requests
- **Supports**: Handwriting, complex layouts

#### Option B: AWS Textract
- **Accuracy**: 90%+ for forms/structured data
- **Setup**:
  ```bash
  npm install @aws-sdk/client-textract
  # Configure AWS credentials
  export AWS_ACCESS_KEY_ID=...
  export AWS_SECRET_ACCESS_KEY=...
  ```
- **Cost**: $0.50-$3.00 per document
- **Supports**: Forms, tables, multi-page

#### Option C: Tesseract.js (Open-Source)
- **Accuracy**: 85-95% (depends on image quality)
- **Setup**:
  ```bash
  npm install tesseract.js
  ```
- **Cost**: Free (runs locally)
- **Speed**: ~30-60ms per page

#### Option D: Azure Computer Vision
- **Setup**:
  ```bash
  npm install @azure/cognitiveservices-vision-computervision
  export AZURE_VISION_KEY=...
  ```
- **Cost**: ~$1.00 per 1000 requests

### Integration Pattern

```javascript
// In ocr-labels.js, processLabelImage function:
const processLabelImage = async (imagePath) => {
  // Example using Google Vision
  const vision = require('@google-cloud/vision');
  const client = new vision.ImageAnnotatorClient();
  const result = await client.textDetection({ image: { source: { filename: imagePath } } });
  const extractedText = result[0].fullTextAnnotation.text;
  return extractLabelFields(extractedText);
};
```

---

## 5. Zone-Based Cycle Counting

**Module**: `lib/zone-cycle-count.js`  
**Status**: ✅ Implemented (rotating zones, drift analysis)

### Features

- **Rotating Zones**: A (pick-face), B (mid-tier), C (upper-tier), D (floor)
- **Continuous Auditing**: Count one zone per week (no warehouse shutdowns)
- **Drift Tracking**: Identifies zones with high variance
- **Zone Performance**: Analytics on accuracy by zone
- **Rotation Schedule**: Smart scheduling based on last count date
- **Auto-Recommendations**: Suggests which zone to count next

### API Endpoints

```
GET  /api/cycle-count/zones                    List zones
GET  /api/cycle-count/zones/:zone/stats        Zone inventory stats
POST /api/cycle-count/zones/:zone              Create zone count batch
GET  /api/cycle-count/zones/schedule           Get rotation schedule
GET  /api/cycle-count/zones/drift              Get variance trends
GET  /api/cycle-count/zones/analysis           Analyze zone performance
```

### Usage Example

```javascript
// Define warehouse zones
const zones = await GET('/api/cycle-count/zones?warehouseId=wh-main');
// → {
//   zones: [
//     { name: 'A', rackPrefix: 'A1-', description: 'Pick face' },
//     { name: 'B', rackPrefix: 'B', description: 'Mid-tier storage' },
//     { name: 'C', rackPrefix: 'C', description: 'Upper-tier storage' },
//     { name: 'D', rackPrefix: 'D', description: 'Bulk storage' }
//   ]
// }

// Get zone statistics
const stats = await GET('/api/cycle-count/zones/A/stats?warehouseId=wh-main');
// → {
//   zone: 'A',
//   batchCount: 450,
//   totalQty: 12500,
//   skuCount: 85,
//   locations: 450
// }

// Get rotation schedule
const schedule = await GET('/api/cycle-count/zones/schedule?daysPerZone=7');
// → {
//   schedule: [
//     { zone: 'B', lastCountDate: null, daysSinceCount: 999, isOverdue: true, priority: 'urgent' },
//     { zone: 'A', lastCountDate: '2026-07-15T...', daysSinceCount: 1, isOverdue: false, priority: 'normal' },
//     ...
//   ],
//   nextRecommendedZone: 'B'
// }

// Create zone count
const batch = await POST('/api/cycle-count/zones/B', {
  countedBy: 'Alice',
  notes: 'Mid-tier inventory audit'
});
// → Initiates cycle count for all Zone B batches

// Get zone drift report (detect problem areas)
const drift = await GET('/api/cycle-count/zones/drift?days=90');
// → {
//   zoneDrift: [
//     { zone: 'D', varianceCount: 5, avgVariancePct: 8.2, reliability: 'needs_attention' },
//     { zone: 'B', varianceCount: 3, avgVariancePct: 2.1, reliability: 'good' },
//     { zone: 'A', varianceCount: 2, avgVariancePct: 0.5, reliability: 'excellent' }
//   ]
// }

// Analyze zone performance
const analysis = await GET('/api/cycle-count/zones/analysis?days=90');
// → {
//   overallAccuracy: 98.5,
//   bestZone: { name: 'A', accuracy: 99.5 },
//   worstZone: { name: 'D', accuracy: 91.8, recommendation: 'Audit receiving process' },
//   insights: [
//     '⚠️ Zone D has high variance (8.2%) - possible receiving or handling issues',
//     '✅ Pick face (Zone A) is well-maintained - high picking accuracy'
//   ]
// }
```

### Zone Rotation Strategy

**Weekly Cycle**:
- Monday: Count Zone A (pick face) - critical for picking accuracy
- Tuesday: Count Zone B (mid-tier) - detect damage/movement
- Wednesday: Count Zone C (upper-tier) - bulk stock verification
- Thursday: Count Zone D (floor) - high-variance area audit
- Friday-Sunday: Catch-up or special counts

**Frequency**: Every 7 days per zone = full audit every 28 days

**Drift Analysis**: Zones with >5% variance get extra audits

---

## 6. Mobile Picking App (React Native)

**Directory**: `mobile-picking-app/`  
**Status**: ✅ Implemented (MVP with 4 screens)

### Features

- **Pick Lists**: Real-time order picking with SKU scanning
- **Carton Assignment**: Pack items into cartons dynamically
- **Performance Dashboards**: Real-time stats and KPIs
- **Authentication**: Secure staff login
- **Barcode Scanning**: Built-in QR/barcode support
- **Offline Support**: Queues picks when offline, syncs when reconnected

### Screens

1. **Picking Screen**
   - Active waves list
   - Pick item details (SKU, qty, bin location)
   - SKU scanner input
   - Qty confirmation
   - Real-time progress tracking

2. **Carton Screen**
   - Create cartons (assign carton numbers)
   - Add items to carton
   - Carton weight/volume tracking
   - Finalize carton (seals and prints label)

3. **Stats Screen**
   - Warehouse performance (orders, fulfillment rate)
   - Picking performance (items picked, accuracy, time)
   - Inventory status (total SKUs, low stock, out of stock)
   - Today's activity summary

4. **Settings Screen**
   - User account info
   - Notification preferences
   - Network settings (API URL)
   - App version info
   - Logout

### Installation

```bash
# Install dependencies
cd mobile-picking-app
npm install

# Run on Android
npm run android

# Run on iOS
npm run ios

# Start Metro bundler only
npm start
```

### API Integration

**Base URL**: Defaults to `http://localhost:3000`, configurable in Settings

**Authentication**: Bearer token stored in AsyncStorage

**Endpoints Used**:
- `GET /api/picking-waves` — List active waves
- `GET /api/picking-waves/:waveId/items` — Get items to pick
- `POST /api/picking-waves/:waveId/items/:itemId/pick` — Record picked item
- `GET /api/cartons?waveId=:id` — List cartons for wave
- `POST /api/cartons` — Create carton
- `POST /api/cartons/:id/finalize` — Complete carton
- `GET /api/analytics/picking-stats` — Performance metrics

### Deployment

**For Production**:

1. Build APK (Android):
   ```bash
   cd android
   ./gradlew assembleRelease
   ```

2. Build IPA (iOS):
   ```bash
   cd ios
   xcodebuild -workspace WMSMobilePicking.xcworkspace -scheme WMSMobilePicking -configuration Release
   ```

3. Sign with your certificate and distribute to app stores

**Environment Configuration**:
```bash
# Create .env file in mobile-picking-app/
REACT_APP_API_URL=https://wms.yourcompany.com
REACT_APP_ENV=production
```

### Offline Support

Picks are queued locally and synced when reconnected:

```javascript
// In PickingScreen, handle network disconnect
if (!isOnline) {
  // Queue picks in AsyncStorage
  await queuePickOffline(waveId, itemId, qty);
  showAlert('Offline - pick queued');
} else {
  // Sync queued picks
  await syncQueuedPicks();
}
```

---

## Summary Table

| Enhancement | Status | Module | API Endpoints | Production Ready |
|---|---|---|---|---|
| Real Barcode Scanning | ✅ | barcode-scanner.js | 3 | Yes (requires bwip-js) |
| Auto-Trigger Replenishment | ✅ | auto-trigger-scheduler.js | 3 | Yes |
| ML Demand Forecasting | ✅ | demand-forecast.js | 3 | Yes |
| OCR Label Extraction | ✅ | ocr-labels.js | 3 | Partial (needs OCR backend) |
| Zone-Based Cycle Counting | ✅ | zone-cycle-count.js | 6 | Yes |
| Mobile Picking App | ✅ | mobile-picking-app/ | 6+ | Yes (awaits distribution) |

---

## Deployment Checklist

- [ ] Install `bwip-js` for real barcode generation
- [ ] Choose and integrate OCR backend (Google Vision / AWS Textract / Tesseract / Azure)
- [ ] Test auto-trigger scheduler with mock inventory
- [ ] Verify demand forecasting on 60+ days of history
- [ ] Set up zone rotation schedule with staff
- [ ] Build and sign mobile app for distribution
- [ ] Configure mobile app API URL for production server
- [ ] Test mobile picking flow end-to-end
- [ ] Train warehouse staff on mobile app
- [ ] Monitor forecasting accuracy for first month
- [ ] Adjust thresholds based on actual performance

---

**Status**: All 6 enhancements complete and integrated  
**Next**: Deploy to production, train staff, monitor KPIs  
**Timeline**: 1-2 weeks for full deployment including staff training
