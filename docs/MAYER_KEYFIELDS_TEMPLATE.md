# Mayer Inventory Setup - Keyfields Base Template

Using **Keyfields Inventory** as the market-tested base format for Mayer's product catalog.

---

## Keyfields Standard Format

| Column | Type | Example | Notes |
|--------|------|---------|-------|
| **d-SKUCODE** | Text | `SKU-001` | Primary key, unique per product |
| **d-Description** | Text | `Memory Foam Pillow Pro` | Product name |
| **d-Category** | Text | `Home & Bedding` | Product category |
| **d-UnitPrice** | Number | `45.00` | Selling price per unit |
| **d-CostPrice** | Number | `22.50` | Your cost (optional) |
| **d-StockQty** | Number | `150` | Current on-hand inventory |
| **d-ReorderPoint** | Number | `20` | Low stock alert level |
| **d-Location** | Text | `A-12-03` | Warehouse bin location |
| **d-Supplier** | Text | `Supplier ABC` | Primary supplier (optional) |
| **d-LeadTime** | Number | `7` | Days to restock |
| **d-IsBundle** | Yes/No | `Yes` | Mark as bundle product |
| **d-BundleComponents** | Text | `SKU-002|2,SKU-003|1` | Components (SKU\|qty, comma-separated) |
| **d-IsVirtual** | Yes/No | `No` | Mark as virtual/dropship |
| **d-VirtualMethod** | Text | `dropship` | dropship / supplier / affiliate |
| **d-VirtualSupplier** | Text | `FBA Warehouse ABC` | Supplier info for virtual items |
| **d-Barcode** | Text | `1234567890` | Product barcode (optional) |
| **d-Active** | Yes/No | `Yes` | Enable/disable product |

---

## Import Template (CSV Format)

### File: `mayer-inventory.csv`

```csv
d-SKUCODE,d-Description,d-Category,d-UnitPrice,d-CostPrice,d-StockQty,d-ReorderPoint,d-Location,d-Supplier,d-LeadTime,d-IsBundle,d-BundleComponents,d-IsVirtual,d-VirtualMethod,d-VirtualSupplier,d-Barcode,d-Active
SKU-001,Memory Foam Pillow Pro,Home & Bedding,45.00,22.50,150,20,A-12-03,Supplier ABC,7,No,,No,,,,Yes
SKU-002,LED Desk Lamp,Lighting,49.00,24.50,75,15,B-05-01,Supplier ABC,5,No,,No,,,,Yes
SKU-003,Electric Toothbrush Pro,Personal Care,59.90,29.95,100,25,C-08-02,Supplier DEF,10,No,,No,,,,Yes
SKU-004,Whey Protein 1kg,Nutrition,79.00,39.50,200,50,D-02-01,Supplier ABC,3,No,,No,,,,Yes
SKU-005,RC Monster Truck,Toys,69.00,34.50,80,10,E-15-05,Supplier GHI,14,No,,No,,,,Yes
SKU-006,Oud Perfume 50ml,Beauty,88.00,44.00,120,15,F-03-02,Supplier DEF,7,No,,No,,,,Yes
SKU-007,Casual Watch,Accessories,89.00,44.50,90,12,G-06-03,Supplier ABC,5,No,,No,,,,Yes
SKU-008,Bomber Jacket,Apparel,89.00,45.00,60,10,H-10-01,Supplier JKL,10,No,,No,,,,Yes
SKU-009,Plush Bear 40cm,Toys,55.00,27.50,200,30,I-12-04,Supplier GHI,7,No,,No,,,,Yes
SKU-010,Rose Garden EDP,Beauty,65.00,32.50,110,20,J-04-02,Supplier DEF,7,No,,No,,,,Yes
AIR-PURIF,Portable HEPA Air Purifier,Home & Health,250.00,125.00,45,5,K-01-01,Supplier ABC,7,No,,No,,,,Yes
AMBER-EDP,Amber Noir EDP 50ml,Beauty,120.00,60.00,100,10,L-02-01,Supplier DEF,7,No,,No,,,,Yes
BACK-CUSHION,Lumbar Support Cushion,Home & Health,45.00,22.50,75,10,M-03-01,Supplier ABC,5,No,,No,,,,Yes
AROMA-STONES,Ceramic Aroma Stones Set,Home & Aromatherapy,35.00,17.50,150,20,N-04-02,Supplier DEF,7,No,,No,,,,Yes
AROMA-DIF,Aroma Diffuser LED 150ml,Home & Aromatherapy,85.00,42.50,80,15,O-05-01,Supplier ABC,7,No,,No,,,,Yes
GIFT-BUNDLE-001,Premium Gift Bundle,Bundles,415.00,210.00,50,5,P-01-01,Internal,0,Yes,"AIR-PURIF|1,AMBER-EDP|1,BACK-CUSHION|1",No,,,,Yes
STARTER-PACK,Starter Pack,Bundles,160.00,80.00,100,10,P-02-01,Internal,0,Yes,"AROMA-STONES|2,AROMA-DIF|1",No,,,,Yes
DROPSUP-001,Dropship Item - FBA,Dropship,99.00,45.00,999,0,Virtual,FBA Warehouse,2,No,,Yes,dropship,"Amazon FBA - Warehouse ABC",,Yes
SUPPLIER-B,3rd Party Supplier Item,Dropship,120.00,55.00,999,0,Virtual,Supplier XYZ,3,No,,Yes,supplier,"Direct from XYZ Supplier",,,Yes
```

---

## Column Mapping to IdealOMS

| Keyfields Column | IdealOMS Field | Notes |
|------------------|----------------|-------|
| d-SKUCODE | `skus.code` + `skus.id` | Primary identifier |
| d-Description | `skus.name` | Product display name |
| d-Category | `skus.category` | Category grouping |
| d-UnitPrice | `skus.unit_price` | Selling price |
| d-CostPrice | (optional) | For margin calculation |
| d-StockQty | `inventory_balance.total_qty` | Total inventory |
| d-ReorderPoint | `skus.reorder_point` | Auto-replenishment threshold |
| d-Location | `inventory_balance.location` | Warehouse bin/shelf |
| d-IsBundle | `client_bundles.bundle_sku` | Bundle flag |
| d-BundleComponents | `client_bundles.config` | Component list (JSON) |
| d-IsVirtual | `client_virtual_skus.sku` | Virtual warehouse flag |
| d-VirtualMethod | `client_virtual_skus.fulfillment_method` | dropship/supplier/affiliate |
| d-VirtualSupplier | `client_virtual_skus.supplier_info` | Supplier details |
| d-Active | Filter in queries | Disabled items excluded |

---

## Excel Template (Download-Ready)

### File: `mayer-inventory-template.xlsx`

Use this Excel file to manage Mayer's inventory. Columns are pre-formatted with dropdowns for:
- **d-Category** - predefined list
- **d-IsBundle** - Yes/No dropdown
- **d-IsVirtual** - Yes/No dropdown
- **d-VirtualMethod** - dropship / supplier / affiliate
- **d-LeadTime** - numeric validation (1-90 days)
- **d-Active** - Yes/No dropdown

---

## Data Import Workflow

### Step 1: Prepare Data (Mayer's Side)
1. Export from Keyfields Inventory
2. Verify columns match template
3. Validate:
   - [ ] d-SKUCODE unique and not empty
   - [ ] d-Description not empty
   - [ ] d-UnitPrice valid numbers (≥0)
   - [ ] d-StockQty valid numbers (≥0)
   - [ ] Bundle components exist in SKU list
   - [ ] No duplicate SKUs

### Step 2: Upload to IdealOMS
**Endpoint:** `POST /api/wms/inventory/batch-update`

```bash
curl -X POST "https://idealone.local/api/wms/inventory/batch-update" \
  -H "Authorization: Bearer $API_KEY" \
  -H "x-tenant-id: default" \
  -H "Content-Type: application/json" \
  -d '{
    "inventory": [
      {
        "sku": "SKU-001",
        "name": "Memory Foam Pillow Pro",
        "category": "Home & Bedding",
        "unit_price": 45.00,
        "stock_qty": 150,
        "reorder_point": 20,
        "location": "A-12-03",
        "warehouse": "wh-main",
        "supplier": "Supplier ABC"
      }
    ]
  }'
```

### Step 3: System Processing
1. Creates SKU records in `skus` table
2. Creates inventory balance in `inventory_balance` table
3. For bundles: Creates entries in `client_bundles`
4. For virtual: Creates entries in `client_virtual_skus`
5. Returns import summary (success/fail count)

### Step 4: Verification
Check that all items appear:
- GET `/api/clients/mayer/bundles` - View bundles
- GET `/api/clients/mayer/virtual-skus` - View virtual items
- Dashboard inventory view - Spot check items

---

## Bundle Configuration (Keyfields Format)

When `d-IsBundle = Yes`, populate `d-BundleComponents` with pipe-separated values:

**Format:** `SKU-CODE|QUANTITY,SKU-CODE|QUANTITY`

**Examples:**
```
AIR-PURIF|1,AMBER-EDP|1,BACK-CUSHION|1
  → Bundle of 1 air purifier + 1 perfume + 1 cushion

AROMA-STONES|2,AROMA-DIF|1
  → Bundle of 2 aroma stone sets + 1 diffuser

SKU-001|3,SKU-002|2
  → Bundle of 3 pillows + 2 lamps
```

**System Processing:**
- On order import, bundles are automatically expanded
- Components inherit bundle quantity
- Example: 2x GIFT-BUNDLE-001 order → 2x AIR-PURIF + 2x AMBER-EDP + 2x BACK-CUSHION

---

## Virtual Warehouse (Keyfields Format)

When `d-IsVirtual = Yes`, configure:

| Field | Value | Example |
|-------|-------|---------|
| d-VirtualMethod | dropship \| supplier \| affiliate | `dropship` |
| d-VirtualSupplier | Text description | `Amazon FBA - Warehouse ABC` |
| d-StockQty | Set to 999 | `999` (unlimited virtual stock) |

**Processing:**
- Virtual items bypass inventory checks
- Orders with virtual items marked for special sourcing
- Fulfillment flags them with supplier info
- Shipping includes virtual items but sourced separately

---

## Price & Cost Calculation

### Unit Metrics
```
Gross Margin = (Unit Price - Cost Price) / Unit Price * 100
Markup = (Unit Price - Cost Price) / Cost Price * 100

Example (SKU-001):
  Unit Price: $45.00
  Cost Price: $22.50
  Gross Margin: ($45 - $22.50) / $45 * 100 = 50%
  Markup: ($45 - $22.50) / $22.50 * 100 = 100%
```

### Margin Analysis (Dashboard)
IdealOMS automatically calculates:
- Total Cost of Goods Sold (COGS)
- Total Gross Profit
- Average margin per category
- Margin trends

---

## Reorder Management

**Reorder Point Logic:**
```
Current Stock < Reorder Point → LOW STOCK ALERT

Example (SKU-001):
  Current: 18 units
  Reorder Point: 20 units
  Status: ⚠️ LOW - Recommend reorder

Dashboard shows:
  - Items below reorder point
  - Suggested reorder quantity
  - Lead time to delivery
  - Impact on fulfillment if not ordered
```

---

## Category Best Practices

Use consistent categories for reporting:
```
Home & Bedding
Home & Health
Home & Aromatherapy
Personal Care
Beauty & Perfume
Apparel & Fashion
Toys & Games
Accessories
Nutrition & Supplements
Dropship & Virtual
Bundles & Kits
```

---

## Supplier Management

Track supplier per SKU:
- **d-Supplier** - Primary supplier name
- **d-LeadTime** - Days until delivery
- **d-VirtualSupplier** - For virtual items only

Example:
```
SKU-001: Supplier ABC, 7-day lead time
  → If stock drops below reorder point, 7 days to restock

DROPSUP-001: Amazon FBA (virtual)
  → Stock always available (virtual), 2-day delivery time
```

---

## Sync & Updates

### Sync Frequency Options
1. **Daily Batch** - Import Keyfields export once daily (8 AM)
   - Best for: Stable inventory, non-perishable
   - Setup: Scheduled export from Keyfields

2. **Real-Time API** - Push updates when Keyfields changes
   - Best for: High-velocity items, perishables
   - Setup: Keyfields webhook → IdealOMS API

3. **Manual Upload** - Mayer uploads when needed
   - Best for: Small catalogs, infrequent changes
   - Setup: CSV/Excel file → Dashboard

### Change Tracking
IdealOMS logs all inventory changes:
- **stock_movements** table tracks:
  - Type: add / remove / adjust / reserve / deduct
  - Qty and reason
  - Timestamp and user
  - Order reference (if applicable)

---

## Validation Rules

Before importing, system validates:
- ✅ d-SKUCODE is unique (no duplicates)
- ✅ d-SKUCODE is alphanumeric (no spaces)
- ✅ d-Description is not empty
- ✅ d-UnitPrice is valid number ≥ 0
- ✅ d-StockQty is valid number ≥ 0
- ✅ d-ReorderPoint < d-StockQty (recommended)
- ✅ Bundle components exist in SKU list
- ✅ d-Category matches predefined list

---

## Example: Mayer's Initial Inventory

```csv
d-SKUCODE,d-Description,d-Category,d-UnitPrice,d-CostPrice,d-StockQty,d-ReorderPoint,d-Location,d-LeadTime,d-IsBundle,d-BundleComponents,d-IsVirtual,d-VirtualMethod,d-VirtualSupplier,d-Active
AIR-PURIF,Portable HEPA Air Purifier,Home & Health,250.00,125.00,45,5,K-01-01,7,No,,No,,Yes
AMBER-EDP,Amber Noir EDP 50ml,Beauty,120.00,60.00,100,10,L-02-01,7,No,,No,,Yes
BACK-CUSHION,Lumbar Support Cushion,Home & Health,45.00,22.50,75,10,M-03-01,5,No,,No,,Yes
AROMA-STONES,Ceramic Aroma Stones Set,Home & Aromatherapy,35.00,17.50,150,20,N-04-02,7,No,,No,,Yes
AROMA-DIF,Aroma Diffuser LED 150ml,Home & Aromatherapy,85.00,42.50,80,15,O-05-01,7,No,,No,,Yes
GIFT-BUNDLE-001,Premium Gift Bundle,Bundles,415.00,210.00,50,5,P-01-01,0,Yes,"AIR-PURIF|1,AMBER-EDP|1,BACK-CUSHION|1",No,,Yes
STARTER-PACK,Starter Pack,Bundles,160.00,80.00,100,10,P-02-01,0,Yes,"AROMA-STONES|2,AROMA-DIF|1",No,,Yes
DROPSUP-001,Dropship Item - FBA,Dropship,99.00,45.00,999,0,Virtual,2,No,,Yes,dropship,"Amazon FBA - Warehouse ABC",Yes
SUPPLIER-B,3rd Party Supplier Item,Dropship,120.00,55.00,999,0,Virtual,3,No,,Yes,supplier,"Direct from XYZ Supplier",Yes
```

---

## Next Steps

1. **Download** the Excel template
2. **Export** Keyfields inventory
3. **Map** columns to template
4. **Validate** data
5. **Upload** via API or dashboard
6. **Verify** in IdealOMS dashboard
7. **Test** order with bundle + virtual items
8. **Go live** with Keyfields sync

---

**Version:** 1.0  
**Template:** Keyfields Standard Format  
**Status:** Ready for Mayer  
**Last Updated:** 2026-07-19
