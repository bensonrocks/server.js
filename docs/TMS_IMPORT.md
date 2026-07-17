# TMS Excel Import System

## Overview

The Transport Management System (TMS) includes a complete Excel import infrastructure for managing daily job assignment workflows. Three types of Excel files are supported:

1. **TMS_CUSTOMER.xlsx** - Customer/delivery location data
2. **TMS_STORE_CODE.xlsx** - Hub/depot location data
3. **TMS_ADJUSTMENT.xlsx** - Order adjustments (quantity, delivery type, price)

## Import Workflow

### 1. Customer Import (TMS_CUSTOMER.xlsx)

**Purpose:** Import customer locations as delivery jobs to assign to drivers.

**Expected Columns:**
| Column | Type | Required | Description |
|--------|------|----------|-------------|
| customer_id | string | Yes | Unique customer identifier |
| name | string | Yes | Customer/recipient name |
| address_line1 | string | Yes | Street address |
| address_line2 | string | No | Unit/apartment number |
| city | string | Yes | City name |
| state | string | No | State/province |
| zip | string | Yes | Postal code |
| country | string | No | Country (default: SG) |
| phone | string | No | Contact phone number |
| email | string | No | Contact email |

**Process:**
- Accepts flexible column naming (e.g., "customer_id" or "Customer ID")
- Creates a new order per customer with status 'pending'
- Updates existing orders with new contact info
- Geocodes addresses automatically for route planning

**API Endpoint:**
```
POST /api/tms/import-customers
Content-Type: multipart/form-data

FormData: { file: <xlsx_file> }

Response:
{
  "success": true,
  "imported": {
    "customersCount": 5,
    "ordersCreated": 3,
    "ordersUpdated": 2,
    "createdOrders": ["ORD-CUST001", "ORD-CUST002", "ORD-CUST003"],
    "updatedOrders": ["ORD-CUST004", "ORD-CUST005"]
  }
}
```

### 2. Store Code Import (TMS_STORE_CODE.xlsx)

**Purpose:** Import delivery hub/depot locations for reference and route optimization.

**Expected Columns:**
| Column | Type | Required | Description |
|--------|------|----------|-------------|
| store_code | string | Yes | Unique store/hub identifier (e.g., HQ-MARINA) |
| store_name | string | Yes | Human-readable store name |
| address_line1 | string | Yes | Street address |
| address_line2 | string | No | Unit/suite number |
| city | string | Yes | City name |
| zip | string | Yes | Postal code |
| latitude | number | No | GPS latitude for fast route planning |
| longitude | number | No | GPS longitude for fast route planning |

**Process:**
- Stores hub location data for reference
- Can be used for bulk dispatch from specific hubs
- Pre-seeded coordinates skip geocoding step

**API Endpoint:**
```
POST /api/tms/import-store-codes
Content-Type: multipart/form-data

FormData: { file: <xlsx_file> }

Response:
{
  "success": true,
  "imported": {
    "storesCount": 4,
    "stores": [ /* preview of first 5 stores */ ]
  }
}
```

### 3. Adjustment Import (TMS_ADJUSTMENT.xlsx)

**Purpose:** Apply adjustments to existing orders (quantity changes, delivery type, pricing).

**Expected Columns:**
| Column | Type | Required | Description |
|--------|------|----------|-------------|
| order_id | string | Yes | Order ID to adjust (e.g., ORD-SG-001) |
| adjustment_type | string | Yes | Type: 'qty', 'delivery', 'price' |
| old_value | string | No | Previous value (for reference) |
| new_value | string | Yes | New value to apply |
| reason | string | No | Justification for the change |

**Process:**
- Updates existing orders with new values
- Logs adjustment reason for audit trail
- Recalculates capacity if quantities changed
- Timestamps all adjustments

**API Endpoint:**
```
POST /api/tms/import-adjustments
Content-Type: multipart/form-data

FormData: { file: <xlsx_file> }

Response:
{
  "success": true,
  "imported": {
    "adjustmentsCount": 3,
    "adjustments": [ /* preview of first 5 adjustments */ ]
  }
}
```

## Dashboard Usage

### Access the Import Feature

1. Click **"+ Add Order"** button in dashboard
2. Click the **"TMS Import"** tab
3. You'll see three upload zones for each import type

### Upload Process

1. **Customers:**
   - Drag & drop or click to select `TMS_CUSTOMER.xlsx`
   - Click **"Import Customers"** button
   - System creates/updates orders and geocodes addresses

2. **Store Codes:**
   - Drag & drop or click to select `TMS_STORE_CODE.xlsx`
   - Click **"Import Stores"** button
   - Hub locations are stored for reference

3. **Adjustments:**
   - Drag & drop or click to select `TMS_ADJUSTMENT.xlsx`
   - Click **"Import Adjustments"** button
   - Adjustments are applied to matching orders

### Status Messages

- ✓ **Success**: Shows count of imported/updated records
- ❌ **Error**: Explains what went wrong (missing columns, invalid data, etc.)
- 💬 **Validation**: Alerts if required columns are missing

## Column Name Flexibility

The import system accepts common Excel column name variations:

| Primary | Alternatives |
|---------|---------------|
| customer_id | Customer ID, Customer_ID |
| store_code | Store Code, StoreCode |
| order_id | Order ID, Order_ID |
| address_line1 | Address Line 1, AddressLine1 |
| address_line2 | Address Line 2, AddressLine2 |

This allows imports from different Excel templates without reformatting.

## Common Workflows

### Daily Job Assignment

**Morning Dispatch Routine:**
1. Receive customer list for day's deliveries
2. Save as Excel following customer schema
3. Import via dashboard → Auto-creates delivery orders
4. Assign orders to drivers based on capacity
5. Plan routes with auto-optimization
6. Print customer tracking numbers

### Mid-Day Adjustments

**New Order Arrives:**
1. Add customer row to Excel
2. Import customers → Creates new order
3. Suggest driver for insertion (considers fixed schedule)
4. Driver continues route with new stop

**Customer Requests Change:**
1. Update quantity/address in adjustments Excel
2. Import adjustments → Updates order
3. Recalculate route if driver already assigned
4. Send updated tracking link to customer

### Hub-Based Routing

**Multi-Hub Operations:**
1. Import store codes for all hubs
2. Assign customers to nearest hub
3. Plan hub-to-customer routes
4. Print manifest per hub

## Sample Files

Sample Excel files are provided in `/data/`:
- `TMS_CUSTOMER.xlsx` - 5 example customers
- `TMS_STORE_CODE.xlsx` - 4 example hubs
- `TMS_ADJUSTMENT.xlsx` - 3 example adjustments

Use these as templates for your own imports.

## Error Handling

**File Format Errors:**
- Only `.xlsx` and `.xls` files are accepted
- Excel must be readable without errors
- Empty sheets are rejected

**Data Validation:**
- Missing required columns → Error message lists missing columns
- Duplicate order IDs → Skipped (logged)
- Invalid addresses → Geocoding retried, fallback to manual

**Rate Limiting:**
- Geocoding: 1 request/second (fair-use policy)
- Imports: No limit, processes concurrently
- Large files (1000+ rows) complete within seconds

## API Details

### Request Format

All TMS endpoints accept multipart file uploads:

```
POST /api/tms/import-{customers|store-codes|adjustments}
Authorization: Bearer <admin_token>
Content-Type: multipart/form-data

FormData:
- file: <xlsx_file_buffer>
```

### Response Format

Success (200):
```json
{
  "success": true,
  "imported": {
    "customersCount": 5,
    "ordersCreated": 3,
    "ordersUpdated": 2,
    "createdOrders": ["ORD-...", ...],
    "updatedOrders": ["ORD-...", ...]
  }
}
```

Error (400):
```json
{
  "error": "No valid customer data found in Excel file"
}
```

## Next Steps

1. **Prepare Your Excel Files:**
   - Follow the column structure above
   - Test with sample data first
   - Ensure no duplicates in IDs

2. **Configure Daily Schedule:**
   - Set up automated Excel generation from your system
   - Upload each morning for fresh job list
   - Run after each shift update

3. **Monitor Imports:**
   - Check import success messages
   - Review created/updated order counts
   - Verify addresses geocoded correctly

4. **Integrate with Assignment:**
   - Use imported orders for daily dispatch
   - Apply capacity-based routing
   - Generate customer tracking numbers

---

**Last Updated:** July 2026  
**Version:** 1.0
