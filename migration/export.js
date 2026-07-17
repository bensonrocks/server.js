'use strict';

const fs = require('fs');
const path = require('path');
const { getTenantDb } = require('../lib/db/tenant');

async function exportIdealScanData() {
  console.log('\n📤 IdealScan Data Export\n');

  try {
    const db = getTenantDb('default');

    // Export orders
    console.log('📦 Exporting orders...');
    const orders = db.prepare('SELECT * FROM orders ORDER BY order_date DESC').all();
    const ordersPath = path.join(__dirname, '../data/migration/orders_export.json');
    fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2));
    console.log(`   ✓ ${orders.length} orders exported`);

    // Export picking waves (if they exist)
    console.log('🌊 Exporting picking waves...');
    try {
      const waves = db.prepare('SELECT * FROM picking_waves').all();
      const wavesPath = path.join(__dirname, '../data/migration/waves_export.json');
      fs.writeFileSync(wavesPath, JSON.stringify(waves, null, 2));
      console.log(`   ✓ ${waves.length} waves exported`);
    } catch (e) {
      console.log('   ℹ No picking_waves table (expected)');
    }

    // Export cartons
    console.log('📦 Exporting cartons...');
    try {
      const cartons = db.prepare('SELECT * FROM cartons').all();
      const cartonsPath = path.join(__dirname, '../data/migration/cartons_export.json');
      fs.writeFileSync(cartonsPath, JSON.stringify(cartons, null, 2));
      console.log(`   ✓ ${cartons.length} cartons exported`);
    } catch (e) {
      console.log('   ℹ No cartons table (expected)');
    }

    // Summary
    console.log('\n✅ Export complete!');
    console.log(`   Location: ${path.join(__dirname, '../data/migration/')}`);
    console.log(`   Files: orders_export.json, waves_export.json, cartons_export.json\n`);

  } catch (error) {
    console.error('❌ Export failed:', error.message);
    process.exit(1);
  }
}

exportIdealScanData();
