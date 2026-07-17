'use strict';

const fs = require('fs');
const path = require('path');

async function transformData() {
  console.log('\n🔄 Transforming IdealScan → IdealOMS Schema\n');

  try {
    const exportPath = path.join(__dirname, '../data/migration');

    // Load exports
    console.log('📖 Loading exported data...');
    const ordersData = fs.readFileSync(path.join(exportPath, 'orders_export.json'), 'utf8');
    const orders = JSON.parse(ordersData);
    console.log(`   ✓ Loaded ${orders.length} orders`);

    // Transform orders to IdealOMS schema
    console.log('\n🔨 Transforming orders...');
    const transformedOrders = orders.map(order => {
      try {
        return {
          id: order.id,
          clientId: order.client_id,
          clientName: order.client_name,
          channel: order.channel,
          orderDate: order.order_date,
          status: order.status,
          currency: order.currency || 'SGD',
          items: typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []),
          shipping: typeof order.shipping === 'string' ? JSON.parse(order.shipping) : (order.shipping || {}),
          subtotal: parseFloat(order.subtotal || 0),
          shippingCost: parseFloat(order.shipping_cost || 0),
          tax: parseFloat(order.tax || 0),
          total: parseFloat(order.total || 0),
          notes: order.notes || '',
          source: {
            type: 'idealscan-migration',
            migratedAt: new Date().toISOString(),
            originalId: order.id
          }
        };
      } catch (e) {
        console.error(`   ⚠ Warning: Failed to transform order ${order.id}: ${e.message}`);
        return null;
      }
    }).filter(Boolean);

    console.log(`   ✓ Transformed ${transformedOrders.length} orders successfully`);

    // Validation
    console.log('\n🔍 Validating transformed data...');
    let validCount = 0;
    let warnings = 0;

    for (const order of transformedOrders) {
      if (!order.id) {
        console.error(`   ✗ Order missing ID`);
        warnings++;
      }
      if (!order.items || !Array.isArray(order.items)) {
        console.warn(`   ⚠ Order ${order.id} has no items`);
        warnings++;
      }
      if (!order.shipping) {
        console.warn(`   ⚠ Order ${order.id} missing shipping info`);
        warnings++;
      }
      validCount++;
    }

    console.log(`   ✓ ${validCount} orders valid, ${warnings} warnings`);

    // Save transformed data
    console.log('\n💾 Saving transformed data...');
    const outputPath = path.join(exportPath, 'orders_transformed.json');
    fs.writeFileSync(outputPath, JSON.stringify(transformedOrders, null, 2));
    console.log(`   ✓ Saved to ${outputPath}`);

    // Summary report
    console.log('\n📊 Transformation Summary');
    console.log(`   Total orders: ${transformedOrders.length}`);
    console.log(`   Valid: ${validCount}`);
    console.log(`   Warnings: ${warnings}`);
    console.log(`   Ready for import: ${warnings === 0 ? '✅ YES' : '⚠️ REVIEW WARNINGS'}\n`);

  } catch (error) {
    console.error('❌ Transform failed:', error.message);
    process.exit(1);
  }
}

transformData();
