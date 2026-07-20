const http = require('http');
const fs = require('fs');
const path = require('path');

function request(method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: 3000,
      path: pathname,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers['x-auth-token'] = token;

    const req = http.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function uploadFile(method, pathname, filePath, token) {
  return new Promise((resolve, reject) => {
    const fileContent = fs.readFileSync(filePath);
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    const fileField = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\nContent-Type: text/csv\r\n\r\n`;
    const fileEnd = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(fileField),
      fileContent,
      Buffer.from(fileEnd)
    ]);

    const opts = {
      hostname: 'localhost',
      port: 3000,
      path: pathname,
      method: method,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    };
    if (token) opts.headers['x-auth-token'] = token;

    const req = http.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('\n=== IMPORTING TEST DELIVERY DATA ===\n');

  try {
    // Login
    console.log('1️⃣  Authenticating...');
    const login = await request('POST', '/api/auth/login', { id: 'demo', password: 'password123' });
    const token = login.data.token;
    console.log(`✓ Authenticated\n`);

    // Upload CSV
    console.log('2️⃣  Importing test deliveries...');
    const upload = await uploadFile('POST', '/api/transport/import/generic', '/tmp/test-deliveries.csv', token);
    console.log(`Status: ${upload.status}`);
    console.log(`Result: ${JSON.stringify(upload.data.imported)}\n`);

    if (upload.status === 200) {
      console.log('✓ Import successful\n');

      // Verify data was imported
      console.log('3️⃣  Verifying transport requests...');
      const list = await request('GET', '/api/transport', null, token);
      console.log(`Status: ${list.status}`);
      console.log(`Total requests: ${Array.isArray(list.data) ? list.data.length : 0}\n`);

      if (Array.isArray(list.data) && list.data.length > 0) {
        console.log('Sample deliveries:');
        list.data.slice(0, 3).forEach((req, i) => {
          console.log(`  ${i + 1}. ${req.clientName} (${req.postalCode})`);
        });
        console.log();
      }
    }

    console.log('✅ TEST DATA IMPORTED\n');

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
  }
})();
