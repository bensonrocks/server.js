# Testing Guide - Phase 2: ZORT Order Sync

## Overview

This directory contains all tests for the ZORT order sync integration:

```
test/
├── unit/                           # Unit tests (fast, no external deps)
│   ├── zort-adapter.test.ts       # ZORT adapter mapping tests
│   └── order-sync.test.js         # OrderSync service tests
├── integration/                    # Integration tests (slow, with ZORT API)
│   └── zort-integration.test.md  # Integration test guide
├── mocks/                          # Mock data for testing
│   └── zort-responses.mock.ts    # ZORT API response samples
├── test-setup.js                   # Global test setup
└── README.md                       # This file
```

## Quick Start

### 1. Install Test Dependencies
```bash
cd /home/user/server.js
npm install
```

### 2. Run Unit Tests (Fast ⚡)
```bash
# Run all unit tests
npm test

# Run only ZORT adapter tests
npm run test:zort

# Run only order sync tests
npm run test:order-sync

# Watch mode (re-run on changes)
npm test -- --watch
```

### 3. Run with Coverage Report
```bash
npm run test:coverage

# View coverage report
open coverage/lcov-report/index.html
```

## Test Structure

### Unit Tests (Fast, No External Dependencies)

#### `/test/unit/zort-adapter.test.ts`
Tests the ZORT order adapter's mapping logic:
- ✅ ZORT order → StandardOrder conversion
- ✅ Field mapping (customer, shipping, status)
- ✅ Status translation (ZORT status → internal status)
- ✅ Error handling (missing credentials)
- ✅ Metadata preservation

**Run:** `npm run test:zort`

**Example test:**
```typescript
it('should convert ZORT order format to StandardOrder', () => {
  const zortOrder = { id: 'ZORT-12345', ... };
  const result = adapter.mapZortOrderToStandard(zortOrder);
  
  expect(result.externalOrderId).toBe('ZORT-12345');
  expect(result.platform).toBe('zort');
});
```

#### `/test/unit/order-sync.test.js`
Tests the generic OrderSync service:
- ✅ Order syncing (create, update, skip duplicates)
- ✅ Duplicate detection by external_order_id + source
- ✅ SKU mapping and validation
- ✅ Customer lookup/creation
- ✅ Batch processing
- ✅ Error handling and reporting

**Run:** `npm run test:order-sync`

**Example test:**
```javascript
it('should detect duplicate orders', async () => {
  const order = { externalOrderId: 'ZORT-DUP', ... };
  
  // First sync
  const result1 = await orderSync.syncOrders({ orders: [order] });
  expect(result1.created).toBe(1);
  
  // Second sync (should skip)
  const result2 = await orderSync.syncOrders({ orders: [order] });
  expect(result2.orders[0].status).toBe('duplicate_skipped');
});
```

### Integration Tests (Slow, Requires ZORT Account)

See `/test/integration/zort-integration.test.md` for:
- ZORT API connectivity
- Complete ZORT → IDEALONE flow
- Database verification
- Auto-allocation testing
- Manual testing checklist

## Current Test Coverage

### What's Tested ✅
- ZORT order format → StandardOrder mapping
- Field transformations (status, customer data, shipping)
- Metadata preservation
- OrderSync duplicate detection
- SKU validation and mapping
- Customer creation/lookup
- Batch order processing
- Error handling

### What's NOT Tested Yet ❌
- Actual ZORT API calls (requires live credentials)
- Database writes (uses mock DB)
- Auto-allocation flow (needs IDEALONE database)
- Inventory updates
- Webhook handling

These are covered in **Phase 2.2: Integration Tests** and **Phase 2.3: Manual Testing**

## Writing New Tests

### Unit Test Template (TypeScript)
```typescript
import { SomeClass } from '../../src/path/to/class';

describe('SomeClass', () => {
  let instance: SomeClass;

  beforeEach(() => {
    instance = new SomeClass();
  });

  describe('methodName', () => {
    it('should do something', () => {
      const input = {...};
      const result = instance.methodName(input);
      
      expect(result).toEqual(expectedOutput);
    });

    it('should handle error case', () => {
      const badInput = {...};
      
      expect(() => instance.methodName(badInput)).toThrow();
    });
  });
});
```

### Unit Test Template (JavaScript)
```javascript
const createSomething = require('../../lib/something');

describe('Something', () => {
  let instance;

  beforeEach(() => {
    instance = createSomething();
  });

  it('should do something', () => {
    const result = instance.doSomething();
    expect(result).toBe(expectedValue);
  });
});
```

### Running Specific Tests
```bash
# Run one test file
npm test -- zort-adapter.test.ts

# Run tests matching pattern
npm test -- --testNamePattern="mapZortOrderToStandard"

# Run one test suite
npm test -- --testNamePattern="ZortOrdersAdapter"

# Run with verbose output
npm test -- --verbose
```

## Debugging Tests

### Print debug output
```javascript
console.log('Debug info:', value);  // Shows in test output with -v flag
```

### Run single test
```typescript
it.only('should do something', () => {
  // Only this test runs
});
```

### Skip test
```typescript
it.skip('should do something', () => {
  // This test is skipped
});
```

### Increase timeout
```javascript
jest.setTimeout(60000); // 60 seconds
```

### Use debugger
```bash
# Run with debugger
node --inspect-brk node_modules/.bin/jest --runInBand

# Then open chrome://inspect in Chrome
```

## Common Test Scenarios

### Testing Error Handling
```javascript
it('should throw on invalid input', () => {
  expect(() => {
    service.process(null);
  }).toThrow('Input required');
});

it('should return error result', async () => {
  const result = await service.process(badData);
  expect(result.error).toBeDefined();
  expect(result.success).toBe(false);
});
```

### Testing Async Operations
```javascript
it('should resolve with data', async () => {
  const result = await service.fetchData();
  expect(result.data).toBeDefined();
});

it('should reject on error', async () => {
  await expect(service.fetchData()).rejects.toThrow();
});
```

### Testing with Mock Data
```javascript
import { mockZortOrdersResponse } from '../mocks/zort-responses.mock';

it('should handle real ZORT response format', () => {
  const order = mockZortOrdersResponse[0];
  const result = adapter.mapZortOrderToStandard(order);
  
  expect(result.externalOrderId).toBe('ZORT-12345');
});
```

## Continuous Integration

### Local CI Simulation
```bash
# Run complete test suite with coverage
npm run test:coverage

# Check if coverage threshold is met
npm run test:coverage -- --collectCoverageFrom='lib/**/*.js' --collectCoverageFrom='src/**/*.ts'
```

### CI Commands (for GitHub Actions, etc.)
```bash
# Install
npm install

# Test
npm test -- --coverage --maxWorkers=2

# Report
npm test -- --coverage --coverageReporters=lcov
```

## Troubleshooting

### "Cannot find module"
- Ensure all imports use correct paths
- Check that `jest.config.js` rootDir is correct
- Run `npm install` to ensure dependencies installed

### "Timeout exceeded"
- Increase `jest.setTimeout()` for slow tests
- Check for unresolved promises
- Use `--runInBand` to run tests sequentially

### "Test not found"
- Check test file name matches pattern `*.test.ts` or `*.test.js`
- Verify file is in `test/` directory
- Check Jest configuration in `jest.config.js`

### Mock database not working
- Ensure `MockDb` class is instantiated in `beforeEach`
- Check SQL patterns match in `prepare()` method
- Verify mock data structure matches real DB schema

## Next Steps (After Unit Tests Pass)

1. **Phase 2.2: Integration Tests**
   - Get ZORT test credentials
   - Set up `.env.test`
   - Run full ZORT → IDEALONE flow
   - Verify database writes

2. **Phase 2.3: Manual Testing**
   - Start servers (SERVER.JS + IDEALONE)
   - Test via cURL
   - Verify database directly
   - Test auto-allocation

3. **Phase 3: Complete Missing Features**
   - Implement auto-allocation
   - Build inventory sync
   - Add order status sync

## Resources

- [Jest Documentation](https://jestjs.io/)
- [Testing Library](https://testing-library.com/)
- [ZORT API Documentation](https://docs.zort.com/)
- [Order Sync Architecture](../scratchpad/ORDER_SYNC_ARCHITECTURE.md)
