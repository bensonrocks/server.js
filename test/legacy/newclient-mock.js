// A ZORT HUB THE WAY THE USER'S ACTUALLY IS: one login, several clients'
// marketplace shops linked in as SALES CHANNELS, and a brand-new client
// (SmileFam) whose shop has just started sending orders.
//
// Two accounts, told apart by the `storename` auth header, because the point of
// the suite is the difference between them:
//   hub  — many clients under one login. Its own label ("IDEALONEHUB") is
//          nobody's account.
//   solo — ONE client under one login. Its label ("AcmeSolo") IS the client,
//          and must keep its orders.
//
// Nothing here is missing, refused or slow at the channel's end. Whatever
// account an order lands in on this side is this side's doing.
const http = require('http');
const PORT = Number(process.argv[2] || 4798);
const TODAY = new Date().toISOString().slice(0, 10);

const ACC = {
  hub: [
    // THE REPORTED ORDER. Pending, so it imports; channel unmapped and its SKU
    // in no item master, so neither attribution step can place it.
    { number: 'SF-1001', id: 'h1', status: 'Pending', channel: 'ShopeeSmilefam',
      sku: 'SMILE-A', name: 'SmileFam Baby Wipes 80s', tracking: '' },
    // A client who IS set up: the hub maps this channel to Mayer2026, so the
    // mapping must still win. Pending on purpose — the live one was Completed
    // and therefore skipped, which proves nothing about attribution.
    { number: 'SF-1002', id: 'h2', status: 'Pending', channel: 'Lazada20082026Mayer',
      sku: 'MAYER-A', name: 'Mayer 1.0L Rice Cooker', tracking: 'LZSGD1015518443' },
    // Already fulfilled at the hub — never imported as floor work.
    { number: 'SF-1003', id: 'h3', status: 'Success', channel: 'ShopeeSmilefam',
      sku: 'SMILE-A', name: 'SmileFam Baby Wipes 80s', tracking: '' },
  ],
  solo: [
    { number: 'SO-2001', id: 's1', status: 'Pending', channel: 'ShopeeAcmeShop',
      sku: 'ACME-A', name: 'Acme Widget', tracking: '' },
  ],
};

const hits = { getorders: 0, detail: 0 };
const j = (res, b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
const row = o => ({
  number: o.noNumber ? '' : o.number, id: o.id, status: o.status, saleschannel: o.channel,
  trackingno: o.tracking, updated: TODAY, orderdate: TODAY + ' 09:00:00',
  customername: 'Buyer', shippingaddress: '1 Test Road', shippingphone: '90000000',
  // The documented OrderProduct shape: sku / name / number / productid.
  list: o.noLines ? [] : [{ ...(o.noSku ? {} : { sku: o.sku }), name: o.name,
                            number: o.zeroQty ? 0 : 1, productid: o.productid || 500, unittext: 'pcs' }],
});
const accOf = req => ACC[String(req.headers.storename || 'hub').trim()] || [];

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  if (p === '/_hits') return j(res, hits);
  // Append an order mid-run — the second pull needs work the first has not
  // already imported (a re-pull skips numbers it already holds, by design).
  if (p === '/_add') {
    const acc = String(u.searchParams.get('acc') || 'hub');
    ACC[acc].push({
      number: u.searchParams.get('number'), id: 'x' + ACC[acc].length,
      status: 'Pending', channel: u.searchParams.get('channel'),
      sku: u.searchParams.get('sku'), name: u.searchParams.get('name') || 'Added', tracking: '',
      // An order the hub returns with NO product lines, or with no order
      // number at all — the two shapes that used to vanish without a word.
      noLines: u.searchParams.get('noLines') === '1',
      noNumber: u.searchParams.get('noNumber') === '1',
      // A line with NO SKU (a Shopee listing that never had one set), and a
      // line with a zero quantity — the two shapes the final filter drops.
      noSku: u.searchParams.get('noSku') === '1',
      zeroQty: u.searchParams.get('zeroQty') === '1',
      productid: Number(u.searchParams.get('productid') || 0) || undefined,
    });
    return j(res, { ok: true });
  }
  if (p.endsWith('/Merchant/ValidateApi')) return j(res, { resCode: '200', resDesc: 'Success' });
  if (p.endsWith('/Merchant/GetSalesChannels')) {
    return j(res, { resCode: '200', list: [...new Set(accOf(req).map(o => o.channel))].map(n => ({ name: n })) });
  }
  if (p.endsWith('/Order/GetOrders')) {
    hits.getorders++;
    const list = accOf(req);
    const nl = String(req.headers.numberlist || '').trim();
    if (nl) { const w = new Set(nl.split(',').map(s => s.trim())); return j(res, { resCode: '200', list: list.filter(o => w.has(o.number)).map(row) }); }
    return j(res, { resCode: '200', list: Number(u.searchParams.get('page') || 1) > 1 ? [] : list.map(row) });
  }
  if (p.endsWith('/Order/GetOrderDetail')) {
    hits.detail++;
    const o = accOf(req).find(x => x.id === u.searchParams.get('id'));
    return j(res, o ? { resCode: '200', ...row(o) } : { resCode: '200' });
  }
  if (p.endsWith('/Order/GetShipmentLabels')) return j(res, { resCode: '200', list: [] });
  if (p.endsWith('/Order/GetOrderFiles')) return j(res, { resCode: '200', list: [] });
  if (p.endsWith('/Shipment/GetShipmentTransactions')) return j(res, { resCode: '200', list: [] });
  return j(res, { resCode: '200', list: [] });
}).listen(PORT, () => console.log('newclient-mock on ' + PORT));
