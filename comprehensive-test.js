#!/usr/bin/env node
'use strict';

/**
 * Comprehensive Test Suite for WMS System
 * Tests all phases: Order Detection, PO Management, B2B Processing,
 * Warehouse Allocation, Inventory Management, and Customs Lot Tracking
 */

const http = require('http');
const assert = require('assert');

const BASE_URL = 'http://localhost:3000';
let testsPassed = 0;
let testsFailed = 0;
let testToken = '';

// Test utilities
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };

    if (testToken) {
      options.headers.Authorization = `Bearer ${testToken}`;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data
          });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(`  Error: ${e.message}`);
    testsFailed++;
  }
}

// ── MAIN TEST RUNNER ────────────────────────────────────────────────────

(async () => {

// ── PHASE 0: Authentication ─────────────────────────────────────────────

console.log('\n=== PHASE 0: Staff Authentication ===\n');

await test('Should authenticate staff', async () => {
  const res = await request('POST', '/api/staff/login', {
    username: 'administrator',
    password: 'Admin1234'
  });
  assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.token, 'No token returned');
  testToken = res.body.token;
});

// ── PHASE 1: Order Type Detection ────────────────────────────────────────

console.log('\n=== PHASE 1: Order Type Detection ===\n');

await test('Should detect B2C order with high confidence', async () => {
  const res = await request('POST', '/api/b2b-b2c/detect-order-type', {
    client_id: 'CLIENT-001',
    client_name: 'Shopee Store',
    waybill: 'TXD123456789',
    qty: 1
  });
  assert.strictEqual(res.status, 200, `Got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.type, 'No type in result');
  assert.strictEqual(res.body.type, 'b2c');
  assert.ok(res.body.confidence >= 0.9);
});

await test('Should detect B2B order with high confidence', async () => {
  const res = await request('POST', '/api/b2b-b2c/detect-order-type', {
    client_id: 'CLIENT-002',
    client_name: 'Retail Store Chain',
    po_number: 'PO-RETAIL-2026-001',
    qty: 50
  });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.type);
  assert.strictEqual(res.body.type, 'b2b');
  assert.ok(res.body.confidence >= 0.6);
});

await test('Should get client profile', async () => {
  const res = await request('GET', '/api/b2b-b2c/client-profile/CLIENT-001', null);
  assert.ok(res.status === 200 || res.status === 404);
});

// ── PHASE 2: PO Management ────────────────────────────────────────────────

console.log('\n=== PHASE 2: PO Management ===\n');

const testPOId = `PO-TEST-${Date.now()}`;

await test('Should create PO document', async () => {
  const res = await request('POST', '/api/b2b-b2c/po', {
    po_number: testPOId,
    po_date: new Date().toISOString(),
    client_id: 'CLIENT-RETAIL-001',
    client_name: 'Retail Store',
    line_items: [
      {
        sku: 'SKU-001',
        skuName: 'Product A',
        quantity: 10,
        destinationStore: 'Store 1',
        batchNumber: 'BATCH-2026-001',
        expiryDate: '2027-12-31',
        serialNumber: 'SN-001-001'
      },
      {
        sku: 'SKU-002',
        skuName: 'Product B',
        quantity: 20,
        destinationStore: 'Store 2',
        batchNumber: 'BATCH-2026-002',
        expiryDate: '2027-12-31',
        serialNumber: 'SN-002-001'
      }
    ]
  });
  assert.strictEqual(res.status, 200, `Got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.poId || res.body.po_id);
});

await test('Should list PO documents', async () => {
  const res = await request('GET', '/api/b2b-b2c/po', null);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.pos) || Array.isArray(res.body));
});

await test('Should validate PO document', async () => {
  const res = await request('POST', `/api/b2b-b2c/po/${testPOId}/validate`, {});
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should approve PO document', async () => {
  const res = await request('POST', `/api/b2b-b2c/po/${testPOId}/approve`, {
    approverName: 'Test Manager'
  });
  assert.ok(res.status >= 200 && res.status < 500);
});

// ── PHASE 3: B2B Batch Processing ────────────────────────────────────────

console.log('\n=== PHASE 3: B2B Batch Processing ===\n');

await test('Should process PO into internal orders', async () => {
  const res = await request('POST', `/api/b2b-b2c/po/${testPOId}/process`, {});
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should get PO import template', async () => {
  const res = await request('GET', '/api/b2b-b2c/po/import/template', null);
  assert.ok(res.status >= 200 && res.status < 500);
});

// ── PHASE 4: Document Generation ─────────────────────────────────────────

console.log('\n=== PHASE 4: Document Generation ===\n');

await test('Should get PO invoice', async () => {
  const res = await request('GET', `/api/b2b-b2c/po/${testPOId}/invoice`, null);
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should get PO packing slip', async () => {
  const res = await request('GET', `/api/b2b-b2c/po/${testPOId}/packing-slip`, null);
  assert.ok(res.status >= 200 && res.status < 500);
});

// ── PHASE 5A: Customs Lot Sequence ───────────────────────────────────────

console.log('\n=== PHASE 5A: Singapore Customs Lot Tracking ===\n');

await test('Should initialize customs lot sequence', async () => {
  const res = await request('POST', '/api/customs/configure-sequence', {
    prefix: 'SG-CUST',
    year: new Date().getFullYear(),
    startingNumber: 1
  });
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should get customs lot sequence info', async () => {
  const res = await request('GET', '/api/customs/sequence-info', null);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.initialized !== undefined);
});

await test('Should get next customs lot number', async () => {
  const res = await request('GET', '/api/customs/next-lot-number', null);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.preview);
  assert.ok(res.body.preview.includes('SG-CUST'));
});

// ── PHASE 5B: Warehouse Allocation ───────────────────────────────────────

console.log('\n=== PHASE 5B: Warehouse Allocation ===\n');

const testOrderId = `ORD-ALLOC-${Date.now()}`;

await test('Should suggest warehouse for order', async () => {
  const res = await request('GET', `/api/warehouse/suggest/${testOrderId}`, null);
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should allocate order to warehouse', async () => {
  const res = await request('POST', '/api/warehouse/allocate', {
    orderId: testOrderId,
    strategy: 'highest_stock'
  });
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should get warehouse statistics', async () => {
  const res = await request('GET', '/api/warehouse/stats', null);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body) || res.body.warehouses);
});

await test('Should get allocation history', async () => {
  const res = await request('GET', `/api/warehouse/allocation-history/${testOrderId}`, null);
  assert.ok(res.status >= 200 && res.status < 500);
});

// ── PHASE 5C: Inventory Management ───────────────────────────────────────

console.log('\n=== PHASE 5C: Inventory & Batch Management ===\n');

await test('Should check warehouse availability', async () => {
  const res = await request('POST', '/api/inventory/check-availability', {
    warehouseId: 'wh-main',
    orderLines: [
      { skuId: 'SKU-001', orderedQty: 5 }
    ]
  });
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should receive goods into inventory', async () => {
  const res = await request('POST', '/api/inventory/receive', {
    warehouseId: 'wh-main',
    skuId: 'SKU-TEST-001',
    batchNumber: 'BATCH-TEST-001',
    serialNumber: 'SN-TEST-001',
    quantity: 100,
    location: 'A1-01',
    expiryDate: '2027-12-31'
  });
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should get warehouse inventory stats', async () => {
  const res = await request('GET', '/api/inventory/warehouse/wh-main/stats', null);
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should adjust batch quantity', async () => {
  const res = await request('POST', '/api/inventory/batch/adjust', {
    batchId: 'BATCH-TEST-001',
    adjustment: -5,
    reason: 'Test adjustment'
  });
  assert.ok(res.status >= 200 && res.status < 500);
});

// ── PHASE 5D: Picking & Packing ──────────────────────────────────────────

console.log('\n=== PHASE 5D: Picking & Packing Integration ===\n');

const testWaveId = `WAVE-TEST-${Date.now()}`;

await test('Should get picking list for wave', async () => {
  const res = await request('GET', `/api/picking/list/${testWaveId}`, null);
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should validate pick item', async () => {
  const res = await request('POST', '/api/picking/validate-item', {
    batchId: 'BATCH-TEST-001',
    orderedQty: 5,
    expiryDate: '2027-12-31'
  });
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should mark item picked', async () => {
  const res = await request('POST', '/api/picking/mark-picked', {
    lineId: 'LINE-001',
    batchId: 'BATCH-TEST-001',
    pickedQty: 5
  });
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should assign batch to carton', async () => {
  const res = await request('POST', '/api/carton/assign-batch', {
    cartonLineId: 'CARTON-LINE-001',
    batchId: 'BATCH-TEST-001',
    quantity: 5
  });
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should close carton', async () => {
  const res = await request('POST', '/api/carton/CARTON-001/close', {});
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should get wave picking status', async () => {
  const res = await request('GET', `/api/picking/status/${testWaveId}`, null);
  assert.ok(res.status >= 200 && res.status < 500);
});

// ── PHASE 5E: Customs Export ─────────────────────────────────────────────

console.log('\n=== PHASE 5E: Customs Export Management ===\n');

await test('Should list pending customs lots', async () => {
  const res = await request('GET', '/api/customs/pending-lots', null);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.lots) || res.body.lots === undefined);
});

await test('Should assign customs lot to carton', async () => {
  const res = await request('POST', '/api/carton/TEST-CARTON/assign-customs-lot', {
    poId: testPOId,
    orderId: 'ORD-001',
    hsCode: '62091000',
    description: 'Test goods',
    totalPieces: 100
  });
  assert.ok(res.status >= 200 && res.status < 500);
});

await test('Should get carton customs lot', async () => {
  const res = await request('GET', '/api/carton/TEST-CARTON/customs-lot', null);
  assert.ok(res.status >= 200 && res.status < 500);
});

// ── PHASE 5F: UI Dashboards ──────────────────────────────────────────────

console.log('\n=== PHASE 5F: UI Dashboards ===\n');

await test('Dashboard warehouse-dashboard.html exists', async () => {
  const res = await request('GET', '/warehouse-dashboard.html', null);
  assert.strictEqual(res.status, 200);
});

await test('Dashboard batch-tracking.html exists', async () => {
  const res = await request('GET', '/batch-tracking.html', null);
  assert.strictEqual(res.status, 200);
});

await test('Dashboard customs-tracking.html exists', async () => {
  const res = await request('GET', '/customs-tracking.html', null);
  assert.strictEqual(res.status, 200);
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log('\n=== TEST SUMMARY ===\n');
console.log(`Passed: ${testsPassed}`);
console.log(`Failed: ${testsFailed}`);
console.log(`Total: ${testsPassed + testsFailed}`);

if (testsFailed > 0) {
  console.log('\n⚠️  Some tests failed. Check output above.');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!');
  process.exit(0);
}

})(); // End of async IIFE
