const fs = require('fs');
const db = JSON.parse(fs.readFileSync('db/db.json', 'utf8'));

console.log('\n=== TRANSPORT DATA INSPECTION ===\n');
if (db.transport && db.transport.length > 0) {
  const first = db.transport[0];
  console.log('First transport request:');
  console.log(JSON.stringify(first, null, 2));
} else {
  console.log('No transport data found');
}
