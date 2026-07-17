const Database = require('better-sqlite3');
const db = new Database('/tmp/wms_default.db');

// Check test orders
const testOrders = db.prepare("SELECT id, client_id, status FROM orders WHERE id LIKE 'TEST-%'").all();
console.log('Test orders in DB:', testOrders.length);
testOrders.forEach(o => console.log(`  - ${o.id}: ${o.client_id} (${o.status})`));

// Check total orders
const total = db.prepare("SELECT COUNT(*) as count FROM orders").get();
console.log('\nTotal orders:', total.count);

// Check inventory
const invCount = db.prepare("SELECT COUNT(*) as count FROM inventory").get();
console.log('Inventory SKUs:', invCount.count);

db.close();
