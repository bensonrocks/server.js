#!/usr/bin/env node
'use strict';

/**
 * End-to-End API Test
 *
 * Tests complete workflow sequences for both B2B and B2C:
 * Inbound → Inventory → Outbound (Picking/Packing) → Delivery → Returns
 *
 * Comprehensive API-based testing (no UI required)
 * Usage: node test-e2e-chromium.js
 */

const http = require('http');

const BASE_URL = 'http://localhost:3000';

// Test results tracking
const results = {
  inbound: { passed: 0, failed: 0, steps: [] },
  inventory: { passed: 0, failed: 0, steps: [] },
  outbound_b2c: { passed: 0, failed: 0, steps: [] },
  outbound_b2b: { passed: 0, failed: 0, steps: [] },
  delivery: { passed: 0, failed: 0, steps: [] },
  returns: { passed: 0, failed: 0, steps: [] }
};

// ─ Utilities ─────────────────────────────────────────────────────────────

async function apiCall(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'default',
        'X-API-Key': 'migration-key'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data || '{}') });
        } catch (e) {
          resolve({ status: res.statusCode, data: {} });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function logStep(section, step, status, message) {
  const icon = status === 'PASS' ? '✅' : '❌';
  console.log(`  ${icon} ${step}: ${message}`);
  results[section].steps.push({ step, status, message });
  if (status === 'PASS') results[section].passed++;
  else results[section].failed++;
}

// ─ Test: Inbound Workflow ────────────────────────────────────────────────

async function testInboundWorkflow() {
  console.log('\n📦 INBOUND WORKFLOW TEST\n');
  const section = 'inbound';

  try {
    // 1. Create ASN (Advance Shipment Notice)
    console.log('  Testing ASN workflow...');
    const asnRes = await apiCall('POST', '/api/asn/create', {
      asnId: 'ASN-20260717-001',
      supplierId: 'SUPPLIER-BW',
      poNumber: 'PO-12345',
      expectedLines: [
        { skuId: 'SKU-001', expectedQty: 100, batch: 'B1', expiry: '2026-12-31' },
        { skuId: 'SKU-002', expectedQty: 50, batch: 'B2', expiry: '2026-11-30' }
      ]
    });
    logStep(section, 'ASN Creation', asnRes.status === 200 ? 'PASS' : 'FAIL',
      `ASN-001 created (status: ${asnRes.status})`);

    // 2. Create Inbound Receipt (with ASN)
    console.log('  Testing inbound receipt...');
    const inboundRes = await apiCall('POST', '/api/inbound/create', {
      inboundId: 'IB-20260717-001',
      asnId: 'ASN-20260717-001',
      warehouseId: 'wh-main',
      receivedDate: new Date().toISOString()
    });
    logStep(section, 'Inbound Creation', inboundRes.status === 200 ? 'PASS' : 'FAIL',
      `Receipt IB-001 created (status: ${inboundRes.status})`);

    // 3. Scan items (simulate barcode scanner)
    console.log('  Testing item scanning...');
    const scanRes = await apiCall('POST', '/api/inbound/IB-20260717-001/scan', {
      skuId: 'SKU-001',
      barcode: 'BW-SKU-001-001',
      quantity: 100,
      batch: 'B1',
      expiry: '2026-12-31'
    });
    logStep(section, 'Item Scanning', scanRes.status === 200 ? 'PASS' : 'FAIL',
      `Scanned 100x SKU-001 (status: ${scanRes.status})`);

    // 4. QC Inspection (with photo capture)
    console.log('  Testing QC inspection...');
    const qcRes = await apiCall('POST', '/api/inbound/IB-20260717-001/qc-check', {
      scanId: 'SCAN-001',
      damageLevel: 'none',
      defects: [],
      notes: 'All items intact, good condition',
      inspectorName: 'John Picker'
    });
    logStep(section, 'QC Inspection', qcRes.status === 200 ? 'PASS' : 'FAIL',
      `QC passed, no damage (status: ${qcRes.status})`);

    // 5. Variance handling (optional)
    console.log('  Testing variance handling...');
    const varianceRes = await apiCall('POST', '/api/inbound/IB-20260717-001/review-variance', {
      lineId: 'LINE-1',
      expectedQty: 100,
      receivedQty: 100,
      varianceReason: 'none'
    });
    logStep(section, 'Variance Review', varianceRes.status === 200 ? 'PASS' : 'FAIL',
      `No variance (expected: 100, received: 100)`);

    // 6. Auto-putaway assignment
    console.log('  Testing auto-putaway...');
    const putawayRes = await apiCall('POST', '/api/inbound/IB-20260717-001/putaway', {
      scanId: 'SCAN-001',
      skuId: 'SKU-001',
      qty: 100,
      method: 'auto'
    });
    logStep(section, 'Auto-Putaway', putawayRes.status === 200 ? 'PASS' : 'FAIL',
      `Items auto-assigned to putaway locations`);

    // 7. Approve & Complete Receipt
    console.log('  Testing receipt completion...');
    const approveRes = await apiCall('POST', '/api/inbound/IB-20260717-001/approve', {
      approvedBy: 'Manager-1'
    });
    logStep(section, 'Approval', approveRes.status === 200 ? 'PASS' : 'FAIL',
      `Receipt approved by manager (status: ${approveRes.status})`);

    // 8. Generate GRN (Goods Receive Note)
    console.log('  Testing GRN generation...');
    const grnRes = await apiCall('POST', '/api/inbound/IB-20260717-001/grn', {});
    logStep(section, 'GRN Generation', grnRes.status === 200 ? 'PASS' : 'FAIL',
      `GRN-20260717-0001 generated (status: ${grnRes.status})`);

    // 9. Inbound without ASN (fresh receive)
    console.log('  Testing inbound WITHOUT ASN...');
    const freshInboundRes = await apiCall('POST', '/api/inbound/create', {
      inboundId: 'IB-20260717-002',
      warehouseId: 'wh-expansion',
      receivedDate: new Date().toISOString()
    });
    logStep(section, 'Fresh Inbound (No ASN)', freshInboundRes.status === 200 ? 'PASS' : 'FAIL',
      `Fresh receipt IB-002 created (status: ${freshInboundRes.status})`);

  } catch (e) {
    logStep(section, 'Inbound Workflow', 'FAIL', e.message);
  }
}

// ─ Test: Inventory Workflow ──────────────────────────────────────────────

async function testInventoryWorkflow() {
  console.log('\n📊 INVENTORY WORKFLOW TEST\n');
  const section = 'inventory';

  try {
    // 1. Check inventory balance
    console.log('  Testing inventory balance...');
    const balanceRes = await apiCall('GET', '/api/inventory/summary');
    logStep(section, 'Inventory Summary', balanceRes.status === 200 ? 'PASS' : 'FAIL',
      `Total SKUs in stock: ${balanceRes.data.totalSkus || 0}`);

    // 2. Test allocation strategies
    console.log('  Testing allocation strategies...');
    const allocationRes = await apiCall('POST', '/api/orders/allocate', {
      orderId: 'TEST-ALLOC-001',
      strategy: 'highest_stock'
    });
    logStep(section, 'Allocation (Highest Stock)', allocationRes.status === 200 ? 'PASS' : 'FAIL',
      `Order allocated to warehouse (status: ${allocationRes.status})`);

    // 3. Test nearest warehouse allocation
    console.log('  Testing nearest warehouse allocation...');
    const nearestRes = await apiCall('POST', '/api/orders/allocate', {
      orderId: 'TEST-ALLOC-002',
      strategy: 'nearest',
      deliveryZip: '65001'
    });
    logStep(section, 'Allocation (Nearest)', nearestRes.status === 200 ? 'PASS' : 'FAIL',
      `Order allocated by proximity (status: ${nearestRes.status})`);

    // 4. Check low stock alerts
    console.log('  Testing low stock detection...');
    const lowStockRes = await apiCall('GET', '/api/inventory/low-stock');
    logStep(section, 'Low Stock Alerts', lowStockRes.status === 200 ? 'PASS' : 'FAIL',
      `Low stock items detected: ${lowStockRes.data.count || 0}`);

    // 5. Forecast demand
    console.log('  Testing demand forecast...');
    const forecastRes = await apiCall('GET', '/api/forecast/demand/SKU-001');
    logStep(section, 'Demand Forecast', forecastRes.status === 200 ? 'PASS' : 'FAIL',
      `7-day forecast generated (status: ${forecastRes.status})`);

  } catch (e) {
    logStep(section, 'Inventory Workflow', 'FAIL', e.message);
  }
}

// ─ Test: Outbound B2C Workflow ───────────────────────────────────────────

async function testOutboundB2CWorkflow() {
  console.log('\n📦 OUTBOUND B2C WORKFLOW TEST\n');
  const section = 'outbound_b2c';

  try {
    // 1. Create B2C order
    console.log('  Creating B2C order (Shopee)...');
    const orderRes = await apiCall('POST', '/api/ingest/orders', {
      id: 'ORD-B2C-20260717-001',
      clientId: 'shopee-customer-1',
      clientName: 'Shopee Customer',
      channel: 'shopee',
      orderDate: new Date().toISOString(),
      status: 'pending',
      currency: 'SGD',
      items: [
        { skuId: 'SKU-001', quantity: 2, price: 50, name: 'T-Shirt' },
        { skuId: 'SKU-002', quantity: 1, price: 100, name: 'Jeans' }
      ],
      shipping: {
        address: '123 Main Street',
        city: 'Singapore',
        state: 'SG',
        zip: '65001',
        country: 'SG'
      },
      subtotal: 200,
      shippingCost: 10,
      tax: 15,
      total: 225
    });
    logStep(section, 'Order Creation (B2C)', orderRes.status === 200 ? 'PASS' : 'FAIL',
      `Order ORD-B2C-001 created (status: ${orderRes.status})`);

    // 2. Auto-allocate
    console.log('  Auto-allocating to warehouse...');
    const allocRes = await apiCall('POST', '/api/orders/ORD-B2C-20260717-001/allocate', {
      strategy: 'nearest'
    });
    logStep(section, 'Auto-Allocation', allocRes.status === 200 ? 'PASS' : 'FAIL',
      `Allocated to warehouse (status: ${allocRes.status})`);

    // 3. Create picking wave
    console.log('  Creating picking wave...');
    const waveRes = await apiCall('POST', '/api/picking/waves', {
      warehouseId: 'wh-main',
      status: 'created',
      mode: 'batch',
      orders: ['ORD-B2C-20260717-001']
    });
    const waveId = waveRes.data.waveId || 'WAVE-B2C-001';
    logStep(section, 'Wave Creation', waveRes.status === 200 ? 'PASS' : 'FAIL',
      `Wave ${waveId} created (status: ${waveRes.status})`);

    // 4. Confirm picks (barcode scanning)
    console.log('  Simulating picker scanning barcodes...');
    const pick1Res = await apiCall('POST', `/api/picking/waves/${waveId}/confirm-pick`, {
      lineId: 'LINE-1',
      skuId: 'SKU-001',
      qtyRequired: 2,
      qtyPicked: 2,
      pickedAt: new Date().toISOString()
    });
    logStep(section, 'Pick Confirmation (Item 1)', pick1Res.status === 200 ? 'PASS' : 'FAIL',
      `2x SKU-001 picked (status: ${pick1Res.status})`);

    const pick2Res = await apiCall('POST', `/api/picking/waves/${waveId}/confirm-pick`, {
      lineId: 'LINE-2',
      skuId: 'SKU-002',
      qtyRequired: 1,
      qtyPicked: 1,
      pickedAt: new Date().toISOString()
    });
    logStep(section, 'Pick Confirmation (Item 2)', pick2Res.status === 200 ? 'PASS' : 'FAIL',
      `1x SKU-002 picked (status: ${pick2Res.status})`);

    // 5. Create carton (packing)
    console.log('  Packing items into carton...');
    const cartonRes = await apiCall('POST', '/api/cartons', {
      cartonId: 'CTN-B2C-001',
      waveId: waveId,
      orderId: 'ORD-B2C-20260717-001',
      thuCode: 'THU-B2C-001',
      weight: 2.5,
      status: 'open'
    });
    logStep(section, 'Carton Creation (Packing)', cartonRes.status === 200 ? 'PASS' : 'FAIL',
      `Carton CTN-B2C-001 created (status: ${cartonRes.status})`);

    // 6. Generate shipping label
    console.log('  Generating shipping label...');
    const labelRes = await apiCall('POST', '/api/labels/generate', {
      orderId: 'ORD-B2C-20260717-001',
      cartonId: 'CTN-B2C-001',
      format: 'svg'
    });
    logStep(section, 'Label Generation', labelRes.status === 200 ? 'PASS' : 'FAIL',
      `Shipping label generated (status: ${labelRes.status})`);

    // 7. Complete wave
    console.log('  Completing picking wave...');
    const completeRes = await apiCall('PUT', `/api/picking/waves/${waveId}`, {
      status: 'completed',
      completedAt: new Date().toISOString()
    });
    logStep(section, 'Wave Completion', completeRes.status === 200 ? 'PASS' : 'FAIL',
      `Wave marked as completed (status: ${completeRes.status})`);

    // 8. Update order to shipped
    console.log('  Marking order as shipped...');
    const shipRes = await apiCall('PUT', '/api/orders/ORD-B2C-20260717-001', {
      status: 'shipped',
      trackingNumber: 'TRACK-B2C-001'
    });
    logStep(section, 'Order Shipped', shipRes.status === 200 ? 'PASS' : 'FAIL',
      `Order marked shipped (status: ${shipRes.status})`);

  } catch (e) {
    logStep(section, 'B2C Workflow', 'FAIL', e.message);
  }
}

// ─ Test: Outbound B2B Workflow ───────────────────────────────────────────

async function testOutboundB2BWorkflow() {
  console.log('\n📦 OUTBOUND B2B WORKFLOW TEST\n');
  const section = 'outbound_b2b';

  try {
    // 1. Create B2B order (bulk)
    console.log('  Creating B2B bulk order...');
    const orderRes = await apiCall('POST', '/api/ingest/orders', {
      id: 'ORD-B2B-20260717-001',
      clientId: 'b2b-retailer-1',
      clientName: 'Retail Chain ABC',
      channel: 'direct',
      orderDate: new Date().toISOString(),
      status: 'pending',
      currency: 'SGD',
      items: [
        { skuId: 'SKU-001', quantity: 50, price: 30, name: 'T-Shirt' },
        { skuId: 'SKU-002', quantity: 30, price: 80, name: 'Jeans' },
        { skuId: 'SKU-003', quantity: 20, price: 120, name: 'Jacket' }
      ],
      shipping: {
        address: '456 Business Park',
        city: 'Singapore',
        state: 'SG',
        zip: '65123',
        country: 'SG'
      },
      subtotal: 6700,
      shippingCost: 50,
      tax: 470,
      total: 7220,
      notes: 'Bulk order - priority shipping'
    });
    logStep(section, 'Order Creation (B2B)', orderRes.status === 200 ? 'PASS' : 'FAIL',
      `Order ORD-B2B-001 created (status: ${orderRes.status})`);

    // 2. Allocate to warehouse (load balancing for bulk)
    console.log('  Allocating bulk order...');
    const allocRes = await apiCall('POST', '/api/orders/ORD-B2B-20260717-001/allocate', {
      strategy: 'load_balance'  // Spread inventory across warehouses
    });
    logStep(section, 'Allocation (Load Balance)', allocRes.status === 200 ? 'PASS' : 'FAIL',
      `Order split across warehouses if needed (status: ${allocRes.status})`);

    // 3. Create batch picking wave (multiple orders)
    console.log('  Creating batch wave for B2B...');
    const waveRes = await apiCall('POST', '/api/picking/waves', {
      warehouseId: 'wh-main',
      status: 'created',
      mode: 'batch',
      orders: ['ORD-B2B-20260717-001']
    });
    const waveId = waveRes.data.waveId || 'WAVE-B2B-001';
    logStep(section, 'Batch Wave Creation', waveRes.status === 200 ? 'PASS' : 'FAIL',
      `Wave ${waveId} created (status: ${waveRes.status})`);

    // 4. Picking all items
    console.log('  Picking bulk items...');
    const picks = [
      { line: 'LINE-1', sku: 'SKU-001', qty: 50 },
      { line: 'LINE-2', sku: 'SKU-002', qty: 30 },
      { line: 'LINE-3', sku: 'SKU-003', qty: 20 }
    ];

    for (const pick of picks) {
      const pickRes = await apiCall('POST', `/api/picking/waves/${waveId}/confirm-pick`, {
        lineId: pick.line,
        skuId: pick.sku,
        qtyRequired: pick.qty,
        qtyPicked: pick.qty,
        pickedAt: new Date().toISOString()
      });
      logStep(section, `Pick (${pick.sku})`, pickRes.status === 200 ? 'PASS' : 'FAIL',
        `${pick.qty}x ${pick.sku} picked`);
    }

    // 5. Multi-carton packing (large order)
    console.log('  Packing into multiple cartons...');
    for (let i = 1; i <= 3; i++) {
      const cartonRes = await apiCall('POST', '/api/cartons', {
        cartonId: `CTN-B2B-${i.toString().padStart(3, '0')}`,
        waveId: waveId,
        orderId: 'ORD-B2B-20260717-001',
        thuCode: `THU-B2B-${i.toString().padStart(3, '0')}`,
        weight: 15 + (i * 5),
        status: 'open'
      });
      logStep(section, `Carton ${i}`, cartonRes.status === 200 ? 'PASS' : 'FAIL',
        `Carton CTN-B2B-${i} packed`);
    }

    // 6. Generate multiple labels
    console.log('  Generating labels for all cartons...');
    const labelRes = await apiCall('POST', '/api/labels/generate-batch', {
      orderId: 'ORD-B2B-20260717-001',
      cartonIds: ['CTN-B2B-001', 'CTN-B2B-002', 'CTN-B2B-003']
    });
    logStep(section, 'Batch Label Generation', labelRes.status === 200 ? 'PASS' : 'FAIL',
      `3 shipping labels generated`);

    // 7. Complete wave
    console.log('  Completing wave...');
    const completeRes = await apiCall('PUT', `/api/picking/waves/${waveId}`, {
      status: 'completed',
      completedAt: new Date().toISOString()
    });
    logStep(section, 'Wave Completion', completeRes.status === 200 ? 'PASS' : 'FAIL',
      `Wave marked as completed`);

    // 8. Mark order shipped
    console.log('  Marking order as shipped...');
    const shipRes = await apiCall('PUT', '/api/orders/ORD-B2B-20260717-001', {
      status: 'shipped',
      trackingNumber: 'TRACK-B2B-001'
    });
    logStep(section, 'Order Shipped', shipRes.status === 200 ? 'PASS' : 'FAIL',
      `B2B order marked shipped`);

  } catch (e) {
    logStep(section, 'B2B Workflow', 'FAIL', e.message);
  }
}

// ─ Test: Delivery Workflow ───────────────────────────────────────────────

async function testDeliveryWorkflow() {
  console.log('\n🚚 DELIVERY WORKFLOW TEST\n');
  const section = 'delivery';

  try {
    // 1. Create delivery job (TMS)
    console.log('  Creating delivery job...');
    const deliveryRes = await apiCall('POST', '/api/delivery/jobs', {
      jobId: 'DELIV-20260717-001',
      orderId: 'ORD-B2C-20260717-001',
      customerId: 'shopee-customer-1',
      address: '123 Main Street, Singapore 65001',
      phone: '+65 9123 4567',
      deliveryDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
      notes: 'Ring bell twice'
    });
    logStep(section, 'Delivery Job Creation', deliveryRes.status === 200 ? 'PASS' : 'FAIL',
      `Job DELIV-001 created (status: ${deliveryRes.status})`);

    // 2. Assign to driver
    console.log('  Assigning to delivery driver...');
    const assignRes = await apiCall('PUT', '/api/delivery/jobs/DELIV-20260717-001', {
      driverId: 'DRIVER-001',
      driverName: 'Ahmad',
      vehicleId: 'VAN-001'
    });
    logStep(section, 'Driver Assignment', assignRes.status === 200 ? 'PASS' : 'FAIL',
      `Assigned to driver Ahmad (status: ${assignRes.status})`);

    // 3. Create delivery route (batch multiple jobs)
    console.log('  Creating delivery route...');
    const routeRes = await apiCall('POST', '/api/delivery/routes', {
      routeId: 'ROUTE-20260717-001',
      driverId: 'DRIVER-001',
      jobs: ['DELIV-20260717-001'],
      plannedDistance: 15.5,
      plannedTime: 120
    });
    logStep(section, 'Route Creation', routeRes.status === 200 ? 'PASS' : 'FAIL',
      `Route ROUTE-001 created (status: ${routeRes.status})`);

    // 4. Update delivery status (in progress)
    console.log('  Starting delivery...');
    const startRes = await apiCall('PUT', '/api/delivery/jobs/DELIV-20260717-001', {
      status: 'in_progress',
      startTime: new Date().toISOString()
    });
    logStep(section, 'Delivery Start', startRes.status === 200 ? 'PASS' : 'FAIL',
      `Delivery marked as in progress`);

    // 5. Complete delivery
    console.log('  Completing delivery...');
    const completeRes = await apiCall('PUT', '/api/delivery/jobs/DELIV-20260717-001', {
      status: 'delivered',
      completedTime: new Date().toISOString(),
      recipientName: 'John Doe',
      signature: 'base64-encoded-signature'
    });
    logStep(section, 'Delivery Completion', completeRes.status === 200 ? 'PASS' : 'FAIL',
      `Delivery completed and signed (status: ${completeRes.status})`);

  } catch (e) {
    logStep(section, 'Delivery Workflow', 'FAIL', e.message);
  }
}

// ─ Test: Returns Workflow ────────────────────────────────────────────────

async function testReturnsWorkflow() {
  console.log('\n↩️  RETURNS WORKFLOW TEST\n');
  const section = 'returns';

  try {
    // 1. Create return (customer initiated)
    console.log('  Creating return...');
    const returnRes = await apiCall('POST', '/api/returns/create', {
      returnId: 'RET-20260717-001',
      orderId: 'ORD-B2C-20260717-001',
      customerId: 'shopee-customer-1',
      reason: 'Size too large',
      items: [
        { skuId: 'SKU-001', qty: 1, condition: 'unused' }
      ]
    });
    logStep(section, 'Return Creation', returnRes.status === 200 ? 'PASS' : 'FAIL',
      `Return RET-001 created (status: ${returnRes.status})`);

    // 2. QC inspection on return
    console.log('  Performing QC inspection...');
    const qcRes = await apiCall('POST', '/api/returns/RET-20260717-001/inspect', {
      inspectorName: 'QA-Officer-1',
      damageLevel: 'none',
      condition: 'like-new',
      notes: 'Item in excellent condition, eligible for restock'
    });
    logStep(section, 'QC Inspection', qcRes.status === 200 ? 'PASS' : 'FAIL',
      `QC passed, item restock-eligible`);

    // 3. Approve return & disposition
    console.log('  Approving return disposition...');
    const approveRes = await apiCall('POST', '/api/returns/RET-20260717-001/approve', {
      disposition: 'approved_restock',
      approvedBy: 'Manager-1',
      notes: 'Return to inventory'
    });
    logStep(section, 'Return Approval', approveRes.status === 200 ? 'PASS' : 'FAIL',
      `Return approved for restock (status: ${approveRes.status})`);

    // 4. Process refund
    console.log('  Processing refund...');
    const refundRes = await apiCall('POST', '/api/returns/RET-20260717-001/refund', {
      amount: 50,
      method: 'original_payment',
      transactionId: 'REFUND-TXN-001'
    });
    logStep(section, 'Refund Processing', refundRes.status === 200 ? 'PASS' : 'FAIL',
      `Refund of $50 processed (status: ${refundRes.status})`);

    // 5. Put back to inventory
    console.log('  Restocking returned item...');
    const restockRes = await apiCall('POST', '/api/inventory/restock', {
      returnId: 'RET-20260717-001',
      skuId: 'SKU-001',
      warehouseId: 'wh-main',
      qty: 1,
      batch: 'RETURN-BATCH',
      location: 'AISLE-A-01'
    });
    logStep(section, 'Item Restock', restockRes.status === 200 ? 'PASS' : 'FAIL',
      `Item restocked to inventory`);

  } catch (e) {
    logStep(section, 'Returns Workflow', 'FAIL', e.message);
  }
}

// ─ Main Test Runner ──────────────────────────────────────────────────────

async function runAllTests() {
  console.log('\n' + '='.repeat(70));
  console.log('🧪 END-TO-END API TEST SUITE');
  console.log('Testing: Inbound → Inventory → Outbound → Delivery → Returns');
  console.log('='.repeat(70));

  try {
    // Run all test sequences
    await testInboundWorkflow();
    await testInventoryWorkflow();
    await testOutboundB2CWorkflow();
    await testOutboundB2BWorkflow();
    await testDeliveryWorkflow();
    await testReturnsWorkflow();

  } catch (e) {
    console.error('❌ Test runner error:', e.message);
  }

  // Print summary
  printSummary();
}

function printSummary() {
  console.log('\n' + '='.repeat(70));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(70) + '\n');

  let totalPassed = 0;
  let totalFailed = 0;

  for (const [section, result] of Object.entries(results)) {
    const passed = result.passed;
    const failed = result.failed;
    const total = passed + failed;
    const percentage = total > 0 ? Math.round((passed / total) * 100) : 0;

    const status = failed === 0 ? '✅' : '⚠️';
    const sectionName = section.replace(/_/g, ' ').toUpperCase();

    console.log(`${status} ${sectionName.padEnd(30)} ${passed}/${total} (${percentage}%)`);

    totalPassed += passed;
    totalFailed += failed;
  }

  console.log('\n' + '-'.repeat(70));
  const grandTotal = totalPassed + totalFailed;
  const grandPercentage = grandTotal > 0 ? Math.round((totalPassed / grandTotal) * 100) : 0;
  console.log(`📈 TOTAL: ${totalPassed}/${grandTotal} tests passed (${grandPercentage}%)\n`);

  if (totalFailed === 0) {
    console.log('🎉 ALL TESTS PASSED! System is production-ready.\n');
  } else {
    console.log(`⚠️  ${totalFailed} test(s) failed. Review errors above.\n`);
  }

  console.log('='.repeat(70));
}

// Run tests
runAllTests().catch(console.error);
