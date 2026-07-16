# ZORT Integration Tests

## Setup

Before running integration tests, you need:

### 1. ZORT Test Account
Get test credentials from ZORT:
```bash
ZORT_STORENAME=your-test-store@example.com
ZORT_APIKEY=test-api-key-xxx
ZORT_APISECRET=test-api-secret-xxx
```

### 2. Environment Variables
Create `.env.test` file:
```bash
cp .env.example .env.test

# Then add ZORT test credentials:
ZORT_TEST_STORENAME=your-test-store@example.com
ZORT_TEST_APIKEY=test-api-key-xxx
ZORT_TEST_APISECRET=test-api-secret-xxx

# IDEALONE test database:
DATABASE_URL=postgresql://user:password@localhost:5432/test_db
```

### 3. Test Database
Create test database:
```bash
createdb test_db
npm run migrate:test  # Run migrations on test DB
```

## Running Tests

```bash
# Run all unit tests
npm test

# Run only ZORT adapter tests
npm run test:zort

# Run only order sync tests
npm run test:order-sync

# Run with coverage
npm run test:coverage

# Watch mode (re-run on file changes)
npm test:watch
```

## Integration Test Cases

### Test 1: ZORT API Authentication
```javascript
// Test: Can we connect to ZORT API?
// Expected: Connection succeeds with valid credentials
// Commands: fetch('https://api.zort.com/v1/orders')
```

### Test 2: Fetch Orders from ZORT
```javascript
// Test: Fetch orders from ZORT
// Expected: Returns StandardOrder[] array
// Verify:
// - Order IDs are unique
// - Order dates are valid
// - Line items have SKU codes
```

### Test 3: Sync ZORT Orders to IDEALONE
```javascript
// Test: End-to-end sync
// Expected: Orders created in IDEALONE database
// Verify:
// - Orders table has N new rows
// - Order lines table has correct line items
// - External_order_id set correctly
// - external_order_source = 'zort'
```

### Test 4: Duplicate Detection
```javascript
// Test: Sync same order twice
// Expected: Second sync returns "duplicate_skipped"
// Verify: No duplicate orders created
```

### Test 5: SKU Mapping
```javascript
// Test: Map ZORT SKU → IDEALONE SKU ID
// Expected: All SKUs found and mapped
// Verify: Order lines link to correct SKU records
```

### Test 6: Customer Creation
```javascript
// Test: Sync order from unknown customer
// Expected: New customer record created
// Verify: Customer email/name stored
```

### Test 7: Inventory Auto-Allocation
```javascript
// Test: Sync with autoAllocate=true
// Expected: Stock reserved for order
// Verify: inventoryBalance.allocatedQty increased
```

## Manual Testing Checklist

- [ ] Start SERVER.JS: `npm run dev`
- [ ] Start IDEALONE: `cd ../idealone && npm run dev:api`
- [ ] Connect ZORT credentials via form
- [ ] Trigger ZORT order sync: `curl -X POST http://localhost:8080/api/sync/zort/orders`
- [ ] Check IDEALONE database:
  ```sql
  SELECT * FROM orders WHERE external_order_source = 'zort' LIMIT 5;
  SELECT * FROM order_lines LIMIT 10;
  SELECT * FROM sync_log WHERE source_system = 'zort' LIMIT 5;
  ```
- [ ] Verify inventory (if autoAllocate):
  ```sql
  SELECT sku_id, qty, allocated_qty, available_qty FROM inventory_balance;
  ```

## Expected Results

### Successful Sync
```json
{
  "success": true,
  "message": "3 orders created, 0 updated, 0 failed",
  "created": 3,
  "updated": 0,
  "failed": 0,
  "orders": [
    {
      "created": true,
      "orderId": "uuid-xxx",
      "externalOrderId": "ZORT-12345",
      "status": "imported",
      "skuCount": 2
    }
  ]
}
```

### With Errors
```json
{
  "success": true,
  "message": "2 orders created, 0 updated, 1 failed",
  "created": 2,
  "updated": 0,
  "failed": 1,
  "errors": [
    {
      "externalOrderId": "ZORT-999",
      "error": "SKU not found: SKU-NONEXISTENT"
    }
  ]
}
```

## Debugging

### Check ZORT API connectivity:
```bash
curl -X GET https://api.zort.com/v1/orders \
  -H "X-Store-Name: your-store" \
  -H "X-API-Key: your-key" \
  -H "X-API-Secret: your-secret"
```

### Check SERVER.JS logs:
```bash
npm run dev 2>&1 | grep -i "zort\|order\|sync"
```

### Check IDEALONE database:
```bash
psql $DATABASE_URL -c "SELECT * FROM orders LIMIT 5;"
psql $DATABASE_URL -c "SELECT * FROM sync_log LIMIT 5;"
```

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| 401 Unauthorized | Wrong ZORT credentials | Verify credentials in .env.test |
| SKU not found | SKU doesn't exist in IDEALONE | Create SKU in IDEALONE first |
| No orders returned | ZORT has no pending orders | Create test order in ZORT |
| Orders created but not allocated | autoAllocate=false | Pass autoAllocate=true param |
| Database connection failed | PostgreSQL not running | Start PostgreSQL: `brew services start postgresql` |
