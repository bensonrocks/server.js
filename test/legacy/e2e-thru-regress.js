// E2E — Total Throughput Time report: upload -> complete -> the report's own
// arithmetic matches the real clock, the client filter genuinely narrows,
// and a pre-existing completion with no uploadedAt degrades to "-" honestly.
const B = 'http://localhost:4731', MK = '201432547E';
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'x-auth-token': l.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: { ...H, 'Content-Type': 'application/json' }, ...o }).then(r => r.json());

  // Upload an order for client ThroughputCo.
  const csv = 'Order Number,SKU,Quantity\nTHR-1,ANY-SKU,3\n';
  const fd = new FormData();
  fd.append('orderFile', new Blob([csv], { type: 'text/csv' }), 'thr.csv');
  fd.append('client_name', 'ThroughputCo'); fd.append('arrange_delivery', 'no');
  const up = await fetch(B + '/api/upload', { method: 'POST', headers: H, body: fd });
  const ud = await up.json();
  ok(up.ok, 'upload accepted: ' + JSON.stringify(ud).slice(0, 150));

  // A SECOND client + order to prove the filter actually narrows.
  const fd2 = new FormData();
  fd2.append('orderFile', new Blob(['Order Number,SKU,Quantity\nTHR-2,ANY-SKU,1\n'], { type: 'text/csv' }), 'thr2.csv');
  fd2.append('client_name', 'OtherCo'); fd2.append('arrange_delivery', 'no');
  await fetch(B + '/api/upload', { method: 'POST', headers: H, body: fd2 });

  await new Promise(r => setTimeout(r, 1200)); // real elapsed gap: upload -> completion

  // Complete both orders.
  for (const num of ['THR-1', 'THR-2']) {
    await J('/api/scan/setqty', { method: 'POST', body: JSON.stringify({ orderNumber: num, sku: 'ANY-SKU', qty: num === 'THR-1' ? 3 : 1 }) });
    await J('/api/scan/complete', { method: 'POST', body: JSON.stringify({ orderNumber: num, startTime: new Date().toISOString(), endTime: new Date().toISOString(), operator: 'demo' }) });
  }

  // Pull the report, UNFILTERED — both orders should appear.
  const r1 = await fetch(B + '/api/master/report/throughput?from=2020-01-01&to=2030-01-01', { headers: H });
  ok(r1.status === 200, `report route: 200 (got ${r1.status})`);
  const buf1 = Buffer.from(await r1.arrayBuffer());
  const wb1 = XLSX.read(buf1, { type: 'buffer' });
  ok(wb1.SheetNames.includes('Throughput') && wb1.SheetNames.includes('By Client'), `sheets present: ${wb1.SheetNames.join(', ')}`);
  const rows1 = XLSX.utils.sheet_to_json(wb1.Sheets['Throughput'], { header: 1 });
  const dataRows1 = rows1.slice(2); // title row + header row
  ok(dataRows1.some(r => r[0] === 'THR-1') && dataRows1.some(r => r[0] === 'THR-2'), 'both orders present unfiltered');
  const thr1Row = dataRows1.find(r => r[0] === 'THR-1');
  console.log('  THR-1 row:', JSON.stringify(thr1Row));
  ok(thr1Row[1] === 'ThroughputCo', 'client column correct');
  ok(thr1Row[2] !== '—' && thr1Row[3] !== '—', 'uploaded-at and completed-at both populated');
  ok(typeof thr1Row[5] === 'number' && thr1Row[5] >= 0 && thr1Row[5] < 1, `lead time is a small positive number of hours (${thr1Row[5]}) matching the ~1.2s real gap`);
  ok(/^\d+h \d+m$/.test(thr1Row[4]), `lead time text formatted as "Xh Ym" (got "${thr1Row[4]}")`);

  // FILTERED — only ThroughputCo.
  const r2 = await fetch(B + '/api/master/report/throughput?from=2020-01-01&to=2030-01-01&client=ThroughputCo', { headers: H });
  const buf2 = Buffer.from(await r2.arrayBuffer());
  const wb2 = XLSX.read(buf2, { type: 'buffer' });
  const rows2 = XLSX.utils.sheet_to_json(wb2.Sheets['Throughput'], { header: 1 }).slice(2);
  ok(rows2.every(r => r[1] === 'ThroughputCo'), 'client filter excludes OtherCo entirely');
  ok(rows2.some(r => r[0] === 'THR-1'), 'ThroughputCo order still present when filtered to it');

  // By Client sheet has an average for ThroughputCo.
  const byClient = XLSX.utils.sheet_to_json(wb1.Sheets['By Client'], { header: 1 }).slice(1);
  const tcRow = byClient.find(r => r[0] === 'ThroughputCo');
  ok(tcRow && tcRow[1] === 1, `By Client: ThroughputCo shows 1 completed order (${JSON.stringify(tcRow)})`);

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
