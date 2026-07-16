# WMS (Warehouse Management System) — Design Patterns & Implementation Notes

This document captures key design decisions, patterns, and algorithms used in the WMS implementation. Read this before modifying core modules.

---

## Architecture Overview

The WMS system manages the complete fulfillment pipeline after orders arrive:

```
Orders (from platforms)
    ↓
[Auto-Allocation] → assign order to warehouse
    ↓
[Picking Waves] → batch orders for batch picking
    ↓
[Cartons] → pack items into shipment containers
    ↓
[Label Printing] → generate shipping labels (SVG-based)
    ↓
[Analytics] → track metrics & performance
    ↓
[Returns] → handle incoming returns with inspection
```

Each module is independent and reusable; they interact only through the database.

---

## 1. Auto-Allocation: Warehouse Selection Strategies

**File:** `lib/auto-allocator.js`

### Strategy Pattern (Pluggable)

Three built-in strategies; easy to add more:

- **`nearest`** — Allocate to warehouse geographically closest to delivery zip code
  - Requires: warehouse `location_zip` and order `delivery_zip`
  - Calculation: Simple string prefix match (e.g., `65102` → `65***`) then lexicographic distance
  - Fallback: If no match, use first available warehouse with stock

- **`highest_stock`** — Allocate to warehouse with most inventory for the SKU
  - Selects warehouse with `available_qty ≥ ordered_qty`
  - Uses `inventory_balance` table (per-warehouse SKU tracking)
  - Tie-breaking: FIFO on warehouse creation

- **`smallest`** — Allocate to warehouse with lowest total inventory (load balancing)
  - Spreads orders across warehouses evenly
  - Useful for equal-cost shipping zones
  - Calculation: `SUM(total_qty)` per warehouse, select minimum

### Validation Before Allocation

```javascript
// CRITICAL: Always check before allocating
if (!checkWarehouseAvailability(orderId, warehouse)) {
  throw new Error('Insufficient inventory');
}
```

This verifies:
1. Order exists and has `order_lines`
2. Warehouse has sufficient `available_qty` for ALL items
3. No circular allocations (order already allocated)

**Do not skip this check** — inventory underflow can cause shipping failures.

### Allocation Log

Every allocation is recorded in `allocation_log` with:
- `order_id` — what was allocated
- `warehouse_id` — where it went
- `strategy` — which strategy was used
- `allocated_at` — timestamp for auditing

This table is append-only (no updates). For reallocation, create a new log entry.

---

## 2. Picking Waves: Batch Fulfillment

**File:** `lib/picking-wave.js`

### Wave Lifecycle

```
created → picking → completed
```

States mean:
- **created** — Wave initialized, awaiting orders
- **picking** — Orders being picked and packed
- **completed** — All orders shipped; no further changes allowed

A wave **cannot transition backward** (no "unship" operation).

### Order Grouping Strategy

Waves group orders by:
1. **Warehouse** — Each wave serves one warehouse only
2. **Priority** — High-priority orders picked first (sort by priority in `wave_orders.sequence`)
3. **Max orders per wave** — Configurable (default 50) to balance batch size

### Picking Statistics

```javascript
const stats = {
  ordersInWave: 45,
  linesPerOrder: 3,
  totalLineItems: 135,
  linesCompleted: 120,
  percentComplete: 88.9,
  averageTimePerOrder: 4.2  // minutes
}
```

These are calculated from `wave_orders` JOIN `order_lines` JOIN `pick_items`.

**Do NOT store stats in the database** — always recalculate on read to ensure consistency.

### Pick Item Tracking

Each line in the wave has a `pick_item` row:
- `qty_required` — original order quantity
- `qty_picked` — what the picker has confirmed
- `picked_at` — timestamp when picked

A wave is complete when ALL `qty_picked ≥ qty_required`.

---

## 3. Label Printing: SVG Barcodes

**File:** `lib/label-printer.js`

### Why SVG (No External Dependencies)

Initially attempted `bwip-js` (barcode library). Removed because:
1. Adds 15MB to `node_modules`
2. Requires system font installation
3. Barcode is visual only — printing and rendering are decoupled

**Solution:** Generate barcode as inline SVG with mathematical bar heights.

### SVG Barcode Generation

```javascript
function generateBarcode(data, format = '128') {
  const barWidth = 2;
  const numBars = Math.min(data.length * 3, 80);
  
  // Use sine/cosine wave to vary bar height (visual realism)
  const height = (Math.sin(i * Math.PI / numBars) + Math.cos(i * 0.5)) * 10 + 20;
  
  // SVG with rects for bars + text overlay
  return `<svg xmlns="http://www.w3.org/2000/svg" ...>
    <rect ... /> ...
    <text>${data}</text>
  </svg>`;
}
```

**Trade-offs:**
- ✅ No dependencies
- ✅ Embeddable in HTML/PDF
- ✅ Lightweight (typically 500 bytes)
- ❌ Not a real barcode format (visual only, not scannable)

For **production scannable barcodes**, reintegrate `bwip-js` with lazy loading:

```javascript
let bwip;
try { bwip = require('bwip-js'); } catch (_) {}

async function generateProperBarcode(data) {
  if (bwip) {
    return await bwip.toSVG({ bcid: 'code128', text: data });
  } else {
    return generateFallbackSVGBarcode(data);  // Current implementation
  }
}
```

### Label Data Storage

Labels are stored twice:
1. **`printed_labels` table** — Full label JSON for audit
2. **`print_jobs` table** — Print queue (status: queued/printing/printed)

Both are append-only; never delete labels (compliance).

---

## 4. Returns Management: Soft-Delete Pattern

**File:** `lib/returns-manager.js`

### Return Lifecycle

```
received → inspected → (approved_restock | approved_disposal)
```

State transition rules:
- Inspection is REQUIRED before approval
- Once approved (either direction), **final** — no reversals
- Return items track condition: `good`, `like-new`, `damaged`, `defective`, `unknown`

### Soft-Delete for Data Retention

Returns are **never hard-deleted**. Instead:
- Add `is_deleted` column (0 = active, 1 = removed)
- Queries default to `WHERE is_deleted = 0`
- Compliance: Maintain 7-year audit trail

```javascript
// Remove from active view (soft-delete)
db.prepare('UPDATE returns SET is_deleted = 1 WHERE id = ?').run(returnId);

// Query: shows only active returns
db.prepare('SELECT * FROM returns WHERE is_deleted = 0 AND order_id = ?').all(orderId);
```

### Inventory Adjustments

When a return is **approved_restock**:
```javascript
db.prepare(`
  INSERT INTO inventory_movements (sku_id, warehouse_id, movement_type, quantity, return_id)
  VALUES (?, ?, 'return_restock', ?, ?)
`).run(skuId, warehouseId, returnQty, returnId);
```

This creates an audit trail in `inventory_movements`; inventory balance is calculated from movements, not a denormalized column.

**Important:** Recalculate `inventory_balance` summary tables nightly:
```javascript
UPDATE inventory_balance SET 
  available_qty = (SELECT SUM(quantity) FROM inventory_movements WHERE movement_type='add') 
                - (SELECT SUM(quantity) FROM inventory_movements WHERE movement_type='allocate')
WHERE sku_id = ?;
```

---

## 5. Inventory Forecasting: Demand Prediction

**File:** `lib/inventory-forecast.js`

### Three Algorithms

#### 1. Moving Average (Baseline)
```
forecast = average(last_N_days_of_demand)
  where N = 3 (configurable)
```
**Use when:** No seasonality, stable demand
**Weakness:** Lags on trend changes

#### 2. Exponential Smoothing
```
forecast = (actual × α) + (forecast_prev × (1 - α))
  where α = 0.3 (tuning parameter)
```
**Use when:** Recent data more important than historical
**Tuning:** Higher α (→ 1.0) = more responsive to change; lower α (→ 0.0) = smoother

#### 3. Seasonal Decomposition
```
forecast = baseline × seasonal_factor(day_of_week)
  where seasonal_factor[Monday] = avg_demand[Mondays] / overall_avg
```
**Use when:** Strong weekly/daily patterns (typical for retail)
**Pattern detection:** Groups demand by day-of-week, calculates multiplier

### Safety Stock & Reorder Points

```javascript
// Reorder point = 14 days of average demand
reorder_point = (demand_last_30_days / 30) * 14;

// Safety stock = 7 days buffer (protect against stockout)
safety_stock = (demand_last_30_days / 30) * 7;

// Low-stock alert triggers when:
available_qty < reorder_point + safety_stock
```

These constants are **hard-coded but documented** — change only after A/B testing demand accuracy.

### Forecast API

```javascript
forecastDemand({ skuId, days = 30, method = 'moving_average' })
  ↓
  returns: { actual, forecast, confidence, reorder_point, safety_stock }

forecastInventoryGap()
  ↓
  returns: array of { sku_id, current_stock, forecast_demand, gap_days }
```

**Confidence Score:** (1 - error_rate). Use to flag unreliable forecasts:
- confidence < 0.7 → Manual review recommended
- confidence < 0.5 → Do not use for auto-replenishment

---

## 6. Analytics: Metrics Aggregation

**File:** `lib/analytics.js`

### Dashboard Dimensions

1. **Orders** — Status breakdown, fulfillment rate, processing time
2. **Fulfillment** — Items ordered/picked, pick accuracy, fulfillment time
3. **Platforms** — Orders/platform, fulfillment rate by platform
4. **Inventory** — Total units, available, low-stock SKUs, out-of-stock
5. **Returns** — Status breakdown, restock rate, disposal method

### Query Patterns

All queries use **denormalized counts** for performance:
```javascript
// ✅ Good: Aggregation on read
SELECT COUNT(*) as total, 
       SUM(CASE WHEN status='shipped' THEN 1 ELSE 0 END) as shipped
FROM orders WHERE created_at >= ?;

// ❌ Avoid: Joining across large tables in real-time
SELECT ... FROM orders JOIN order_lines JOIN ... WHERE ...
```

### Trend Data

Trends are calculated daily at 00:00 UTC (batch job):
```javascript
INSERT INTO analytics_snapshots (date, metric, value)
  SELECT DATE(created_at), 'orders_count', COUNT(*) FROM orders 
  WHERE DATE(created_at) = DATE('now', '-1 day')
  GROUP BY DATE(created_at);
```

Query trends from the snapshot table, not raw orders:
```javascript
// ✅ Fast: Single table, pre-aggregated
SELECT * FROM analytics_snapshots WHERE metric='orders_count' AND date >= ?;

// ❌ Slow: Recalculate every time
SELECT DATE(created_at), COUNT(*) FROM orders WHERE ... GROUP BY DATE(created_at);
```

---

## 7. Validation Framework

**File:** `lib/wms-validation.js`

### Error Structure

Every validation error includes:
```javascript
{
  field: 'order_id',           // Which field failed
  issue: 'ORDER ID MISSING',   // Category (all-caps)
  description: '...',          // What went wrong
  action: 'Reference the ...',  // How to fix it
  critical: true               // true = blocks operation, false = advisory
}
```

### Validation Scope

**Before upload/import:**
```javascript
const result = validateCartonData(cartons);
if (result.criticalErrors > 0) {
  return res.status(400).json({ error: 'Upload blocked', errors: result.errors });
}
```

**Before database write:**
```javascript
const validation = validateReturnItems(returns);
if (!validation.passed) {
  rollback();  // Cancel transaction
  throw new ValidationError(validation.errors);
}
```

### Adding New Validation Rules

1. Create a new validation function in `lib/wms-validation.js`
2. Return standard error object shape
3. Use in the route handler BEFORE any DB operations
4. Document the rule in this file under the appropriate section

Example:
```javascript
function validateWaveCreation(waveData) {
  const errors = [];
  if (!waveData.warehouse_id) {
    errors.push({
      field: 'warehouse_id',
      issue: 'WAREHOUSE NOT SPECIFIED',
      description: 'Warehouse is required for wave creation',
      action: 'Select a warehouse',
      critical: true,
    });
  }
  return { passed: errors.length === 0, errors };
}
```

---

## 8. Label Extraction: Parsing Shipping Documents

**File:** `lib/label-extract.js`

### Use Cases

1. **Return verification** — Scan incoming parcel label to auto-populate return info
2. **Carton tracking** — Extract tracking number from printed label
3. **Batch processing** — Parse multiple labels from a PDF document

### Pattern Priority (Most-Specific → Least-Specific)

Patterns are checked in priority order; first match wins:

```javascript
// Tracking number detection
/\b(TXSGD\d{8,})\b/i,      // ← TRACX (Lazada), most specific
/\b(SGDEX\d{8,})\b/i,      // ← SGDEX, regional
/\b([A-Z]{2}\d{9}[A-Z]{2})\b/,  // ← Postal codes
/\b([A-Z]{2,4}\d{10,18})\b/,    // ← Generic, most permissive
```

**Why this order:** A TRACX number would also match the generic pattern, but TRACX is more specific and reliable. Always check most specific patterns first.

### Address Extraction

Address lines are fragile (OCR errors, formatting variations). Always validate:

```javascript
const { address, postalCode } = extractLabelFields(pdfText);

if (!postalCode || postalCode.length !== 6) {
  // Postal code is unreliable; prompt manual entry
  return { incomplete: true, partialData: { address, recipientName } };
}
```

### Confidence Scoring (Future)

For production use, add confidence scores:

```javascript
return {
  trackingNumber: { value: '...', confidence: 0.95 },
  orderNumber: { value: '...', confidence: 0.87 },
  recipientName: { value: '...', confidence: 0.72 },
  ...
};

// Prompt manual review if any field < 0.8
const needsReview = Object.values(extracted)
  .some(f => f.confidence < 0.8);
```

---

## Testing Strategy

### Unit Tests

Test individual modules in isolation:
```bash
npm test -- lib/auto-allocator.test.js
npm test -- lib/picking-wave.test.js
```

Use **mocked database**:
```javascript
const mockDb = {
  prepare: jest.fn(() => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }))
};
const allocator = createAutoAllocator(mockDb, ...);
```

### Integration Tests

Test full workflows with **real test database**:
```javascript
// Create test tenant DB
const testDb = getTenantDb('test-wms-' + Date.now());

// Allocate → Pick → Pack → Label → Ship
testDb.prepare('INSERT INTO orders ...').run(...);
const allocation = allocator.allocateOrder(orderId);
const wave = pickingWave.createWave({ ... });
const label = labelPrinter.generateShippingLabel(orderId);
```

**Always clean up:** Delete test databases after test completes.

### Load Testing

For forecasting & analytics with large datasets:
```bash
# Seed 1M orders, then test performance
npm run seed:bench 1000000
npm run test:load  # Times queries
```

Target: Analytics dashboard < 500ms with 1M orders.

---

## Deployment Checklist

- [ ] All WMS schema tables created via `lib/db/wms-schema.js`
- [ ] Default warehouse seeded (`wh-main`)
- [ ] Validation rules documented in CLAUDE.md
- [ ] Label printing tested (SVG renders in HTML & PDF)
- [ ] Allocation strategies tested with multiple warehouses
- [ ] Return workflow tested end-to-end
- [ ] Analytics queries < 1s with sample data
- [ ] Soft-delete working (no hard deletes allowed)
- [ ] All 20+ API endpoints tested
- [ ] Staff authentication (withStaffTenant) verified

---

## Common Gotchas

1. **Allocation without checking inventory** → Overselling
   - Always call `checkWarehouseAvailability()` first

2. **Hard-deleting returns** → Compliance violation
   - Use soft-delete (`is_deleted = 1`) only

3. **Recalculating analytics on every dashboard load** → Timeout
   - Pre-aggregate snapshots nightly; query snapshots

4. **Barcode format changes** → Labels not scannable
   - SVG barcodes are visual only; reintegrate `bwip-js` for production

5. **Mixing allocation strategies mid-wave** → Inconsistent results
   - One wave = one strategy; don't mix

6. **Label extraction assuming perfect text** → Parse failures
   - Always handle missing/malformed fields gracefully

---

## Future Enhancements

- [ ] **Real barcode scanning** — Integrate `bwip-js` for CODE128 generation
- [ ] **OCR for carton labels** — Use Tesseract + `lib/label-extract.js`
- [ ] **Multi-carrier support** — Add DHL, FedEx, UPS adapters
- [ ] **Auto-replenishment** — Trigger purchase orders when forecast_gap > threshold
- [ ] **Wave optimization** — Genetic algorithm for order grouping
- [ ] **Returns analytics** — Trend analysis on return rates by SKU/platform
- [ ] **Damage prevention** — ML model to predict fragile items and suggest packaging

---

Last updated: 2026-07-16
