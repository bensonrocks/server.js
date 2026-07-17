'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: process.env.PORT || 3000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'default',
        'X-API-Key': process.env.API_KEY || 'migration-key'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: { error: 'Parse error', raw: data } });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function importOrders() {
  console.log('\n📥 Importing Orders to IdealOMS\n');

  try {
    // Load transformed data
    const exportPath = path.join(__dirname, '../data/migration');
    const ordersFile = path.join(exportPath, 'orders_transformed.json');

    if (!fs.existsSync(ordersFile)) {
      console.error('❌ Transformed data not found. Run: node migration/transform.js');
      process.exit(1);
    }

    const orders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
    console.log(`📦 Found ${orders.length} orders to import\n`);

    // Import in batches
    const batchSize = 10;
    let imported = 0;
    let failed = 0;
    const failedOrders = [];

    for (let i = 0; i < orders.length; i += batchSize) {
      const batch = orders.slice(i, i + batchSize);
      console.log(`\n📤 Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(orders.length / batchSize)}`);

      for (const order of batch) {
        try {
          const res = await makeRequest('POST', '/api/ingest/orders', order);

          if (res.status === 200) {
            imported++;
            process.stdout.write('.');
          } else {
            failed++;
            process.stdout.write('F');
            failedOrders.push({
              orderId: order.id,
              status: res.status,
              error: res.data.error || 'Unknown error'
            });
          }
        } catch (e) {
          failed++;
          process.stdout.write('E');
          failedOrders.push({
            orderId: order.id,
            error: e.message
          });
        }

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    // Results
    console.log('\n\n' + '='.repeat(60));
    console.log('📊 IMPORT RESULTS');
    console.log('='.repeat(60));
    console.log(`\n✅ Imported: ${imported}/${orders.length}`);
    console.log(`❌ Failed:   ${failed}/${orders.length}`);
    console.log(`📈 Success Rate: ${Math.round((imported / orders.length) * 100)}%\n`);

    if (failedOrders.length > 0 && failedOrders.length <= 20) {
      console.log('Failed Orders:');
      failedOrders.forEach(f => {
        console.log(`  - ${f.orderId}: ${f.error}`);
      });
    }

    // Save report
    const report = {
      timestamp: new Date().toISOString(),
      total: orders.length,
      imported,
      failed,
      successRate: (imported / orders.length) * 100,
      failedOrders
    };

    const reportPath = path.join(exportPath, 'import_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Report saved: ${reportPath}\n`);

    if (failed === 0) {
      console.log('🎉 All orders imported successfully!\n');
      process.exit(0);
    } else {
      console.log(`⚠️  ${failed} orders failed. Review report and retry.\n`);
      process.exit(1);
    }

  } catch (error) {
    console.error('\n❌ Import failed:', error.message);
    process.exit(1);
  }
}

// Check server is running
makeRequest('GET', '/').then(() => {
  console.log('✓ Connected to IdealOMS server\n');
  importOrders();
}).catch(() => {
  console.error('❌ Cannot connect to IdealOMS server at localhost:' + (process.env.PORT || 3000));
  console.error('   Make sure server is running: PORT=3000 node server.js\n');
  process.exit(1);
});
