// A mock of the OneCart API v2, built to the Swagger the user supplied.
//   PORT   — listen port (default 4748)
//   OC_KEY — the only Authorization value accepted (default oc_test_key_123)
//   OC_PDF_DIR — where <order id>.pdf label fixtures live
// Envelope: {data, meta, links, errors:[], warnings:[]} on success,
// {error:{code,message,details,request_id}} on failure. Rate headers on every
// response. mark_as_shipped is ASYNC on purpose (status moves ~2s later), the
// way the spec warns it is.
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT   = Number(process.env.PORT || 4748);
const KEY    = process.env.OC_KEY || 'oc_test_key_123';
const PDFDIR = process.env.OC_PDF_DIR || '';

const nowSec = () => Math.floor(Date.now() / 1000);
const t0 = nowSec();
let orders = [];
function seed() {
  orders = [
    { id: 9001, order_no: '585836014589150279', platform: 'TikTok', shop_id: 11, shop_name: 'Betime TikTok', status: 'pending',
      tracking_no: null, order_date: new Date((t0 - 3600) * 1000).toISOString(), updated_at: t0 - 3600,
      first_name: 'Ali', last_name: 'Tan', shipping_address: '12 Jurong West St 42 #05-11', shipping_postal_code: '640012', shipping_phone_number: '91234567',
      shipping_provider_name: 'J&T Express', net_amt: 40, gross_amt: 44,
      line_items: [
        { sku: 'K5008', quantity: 2, name: 'Koli Pain Relief Plaster (MALA) 5s (Khaki)', is_bundle_component: false, unit_price: 12, line_total: 24 },
        { sku: 'KOLI-BUNDLE', quantity: 1, name: 'Koli Starter Bundle', is_bundle_component: false, unit_price: 20, line_total: 20 },
        { sku: 'KOLI-BOX 9', quantity: 1, name: 'Koli Gold Logo Sticker', is_bundle_component: true, bundle_sku: 'KOLI-BUNDLE' },
        { sku: 'KOLI-BOX 5', quantity: 1, name: 'Koli 20pcs Bundle Empty Box (Khaki)', is_bundle_component: true, bundle_sku: 'KOLI-BUNDLE' },
      ] },
    { id: 9002, order_no: '260907ABCDEF01', platform: 'Shopee', shop_id: 12, shop_name: 'Betime Shopee', status: 'ready_to_ship',
      tracking_no: 'SPXSG0412345678', order_date: new Date((t0 - 7200) * 1000).toISOString(), updated_at: t0 - 1800,
      first_name: 'Mei', last_name: 'Lim', shipping_address: '1 Marina Blvd #10-01', shipping_postal_code: '018989', shipping_phone_number: '98765432',
      shipping_provider_name: 'SPX Express', net_amt: 12, gross_amt: 14,
      line_items: [{ sku: 'K5008', quantity: 1, name: 'Koli Pain Relief Plaster (MALA) 5s (Khaki)', is_bundle_component: false, unit_price: 12, line_total: 12 }] },
    { id: 9003, order_no: '172397910455623', platform: 'Lazada', shop_id: 13, shop_name: 'Betime Lazada', status: 'pending',
      tracking_no: null, order_date: new Date((t0 - 600) * 1000).toISOString(), updated_at: t0 - 600,
      first_name: 'Raj', last_name: 'Kumar', shipping_address: '88 Tampines St 21 #03-22', shipping_postal_code: '521088', shipping_phone_number: '81112222',
      shipping_provider_name: 'LEX', net_amt: 30, gross_amt: 33,
      line_items: [{ sku: '8006', quantity: 3, name: 'Koli Herbal Patch', is_bundle_component: false, unit_price: 10, line_total: 30 }] },
    { id: 9004, order_no: '9004CANCELLED', platform: 'Shopee', shop_id: 12, shop_name: 'Betime Shopee', status: 'cancelled', cancel_reason_text: 'Buyer changed mind',
      tracking_no: null, order_date: new Date((t0 - 9000) * 1000).toISOString(), updated_at: t0 - 100,
      first_name: 'X', last_name: 'Y', shipping_address: 'nowhere', shipping_postal_code: '000000', shipping_phone_number: '',
      line_items: [{ sku: 'K5008', quantity: 1, name: 'Koli', is_bundle_component: false }] },
    { id: 9005, order_no: 'SHIPPED-ALREADY', platform: 'Lazada', shop_id: 13, shop_name: 'Betime Lazada', status: 'shipped',
      tracking_no: 'LZSGD1015379600', order_date: new Date((t0 - 86400) * 1000).toISOString(), updated_at: t0 - 50,
      first_name: 'Z', last_name: 'Z', shipping_address: 'gone', shipping_postal_code: '111111', shipping_phone_number: '',
      line_items: [{ sku: '8006', quantity: 1, name: 'Koli Herbal Patch', is_bundle_component: false }] },
    { id: 9006, order_no: 'NOLINES-1', platform: 'TikTok', shop_id: 11, shop_name: 'Betime TikTok', status: 'pending',
      tracking_no: null, order_date: new Date((t0 - 300) * 1000).toISOString(), updated_at: t0 - 300,
      first_name: 'No', last_name: 'Lines', shipping_address: 'x', shipping_postal_code: '222222', shipping_phone_number: '',
      line_items: [] },
  ];
}
seed();
const calls = [];
let rateLimitOnce = false;

function send(res, status, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-RateLimit-Limit': '300', 'X-RateLimit-Remaining': String(299 - (calls.length % 250)), 'X-RateLimit-Reset': String(nowSec() + 60),
    'X-Request-Id': 'req_' + Math.random().toString(16).slice(2, 10),
    ...extra,
  });
  res.end(JSON.stringify(body));
}
const fail = (res, status, code, message) => send(res, status, { error: { code, message, details: [], request_id: 'req_' + Math.random().toString(16).slice(2, 10) } });
function page(res, rows, q) {
  const per = Math.min(100, Math.max(1, Number(q.get('per_page') || 25)));
  const pg  = Math.max(1, Number(q.get('page') || 1));
  const total = rows.length, pages = Math.max(1, Math.ceil(total / per));
  const data = rows.slice((pg - 1) * per, pg * per);
  send(res, 200, {
    data, meta: { current_page: pg, per_page: per, total_items: total, total_pages: pages, has_next_page: pg < pages, has_previous_page: pg > 1 },
    links: { self: '', first: '', prev: pg > 1 ? 'x' : null, next: pg < pages ? 'x' : null, last: '' }, errors: [], warnings: [],
  });
}
// Order entity view (the /orders shape) — line_items only when asked via _fields.
const orderView = (o, fields) => {
  const base = { id: o.id, order_no: o.order_no, platform: o.platform, order_date: o.order_date, status: o.status, net_amt: o.net_amt || 0, gross_amt: o.gross_amt || 0,
    tracking_no: o.tracking_no || null, shop_id: o.shop_id, shop_name: o.shop_name, created_at: o.order_date, updated_at: new Date(o.updated_at * 1000).toISOString(),
    shipping_provider_name: o.shipping_provider_name || null, cancel_reason_text: o.cancel_reason_text || null };
  if (fields && /order_items/.test(fields)) base.order_items = o.line_items.map(li => ({ sku: li.sku, qty: li.quantity, unit_price: li.unit_price || 0 }));
  return base;
};
const deliveryView = o => ({ id: o.id, order_no: o.order_no, platform: o.platform, shop_name: o.shop_name, shop_id: o.shop_id, order_date: o.order_date, status: o.status,
  first_name: o.first_name, last_name: o.last_name, shipping_address: o.shipping_address, payment_details: { method: 'online' },
  shipping_postal_code: o.shipping_postal_code, shipping_phone_number: o.shipping_phone_number, line_items: o.line_items });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const q = u.searchParams;
  let body = '';
  for await (const c of req) body += c;
  let json = {}; try { json = body ? JSON.parse(body) : {}; } catch (_) {}
  const p = u.pathname;

  // ── control plane (test harness only) ────────────────────────────────────
  if (p.startsWith('/__ctl/')) {
    if (p === '/__ctl/calls') return send(res, 200, calls);
    if (p === '/__ctl/reset') { seed(); calls.length = 0; rateLimitOnce = false; return send(res, 200, { ok: true }); }
    if (p === '/__ctl/rate-limit-once') { rateLimitOnce = true; return send(res, 200, { ok: true }); }
    let m;
    if ((m = p.match(/^\/__ctl\/cancel\/(\d+)$/))) { const o = orders.find(x => x.id === Number(m[1])); if (o) { o.status = 'cancelled'; o.cancel_reason_text = q.get('reason') || 'Cancelled by buyer'; o.updated_at = nowSec(); } return send(res, 200, { ok: !!o }); }
    if ((m = p.match(/^\/__ctl\/track\/(\d+)$/))) { const o = orders.find(x => x.id === Number(m[1])); if (o) { o.tracking_no = q.get('no') || ''; o.updated_at = nowSec(); } return send(res, 200, { ok: !!o }); }
    if (p === '/__ctl/add') { json.updated_at = nowSec(); json.order_date = json.order_date || new Date().toISOString(); orders.push(json); return send(res, 200, { ok: true }); }
    return fail(res, 404, 'NOT_FOUND', 'no such control');
  }
  // Label fixtures served by URL (Lazada / TikTok shape).
  let m;
  if ((m = p.match(/^\/awb\/(\d+)\.pdf$/))) {
    const f = path.join(PDFDIR, m[1] + '.pdf');
    if (!PDFDIR || !fs.existsSync(f)) { res.writeHead(404); return res.end('no such label'); }
    res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(fs.readFileSync(f));
  }

  // ── the API ──────────────────────────────────────────────────────────────
  if (!p.startsWith('/api/v2/')) return fail(res, 404, 'NOT_FOUND', 'unknown path');
  calls.push({ method: req.method, path: p, query: Object.fromEntries(q.entries()), body: json, at: Date.now() });
  if (req.headers.authorization !== KEY) return fail(res, 401, 'UNAUTHORIZED', 'Missing or invalid API key');
  if (rateLimitOnce) { rateLimitOnce = false; return send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests', request_id: 'req_rl' } }, { 'Retry-After': '7', 'X-RateLimit-Remaining': '0' }); }
  const api = p.slice('/api/v2'.length);

  if (api === '/zapier' && req.method === 'GET') return send(res, 200, { data: { hi: 'Betime Online Pte Ltd', using: 'IdealOne', created_by: 'ops@betime.sg' }, meta: {}, links: {}, errors: [], warnings: [] });
  if (api === '/delivery_orders' && req.method === 'GET') {
    // The queue = paid, not yet shipped. ready_to_ship is still IN it.
    let rows = orders.filter(o => !/cancel/i.test(o.status) && !(/ship|complet|deliver/i.test(o.status) && !/ready/i.test(o.status)));
    if (q.get('platform')) rows = rows.filter(o => o.platform.toLowerCase() === q.get('platform').toLowerCase());
    return page(res, rows.map(deliveryView), q);
  }
  if (api === '/orders/cancelled' && req.method === 'GET') return page(res, orders.filter(o => /cancel/i.test(o.status)).sort((a, b) => b.updated_at - a.updated_at).map(o => orderView(o, q.get('_fields'))), q);
  if (api === '/orders' && req.method === 'GET') {
    let rows = orders.slice();
    if (q.get('updated_start')) rows = rows.filter(o => o.updated_at >= Number(q.get('updated_start')));
    if (q.get('updated_end'))   rows = rows.filter(o => o.updated_at <= Number(q.get('updated_end')));
    if (q.get('order_no'))      rows = rows.filter(o => o.order_no === q.get('order_no'));
    if (q.get('status'))        rows = rows.filter(o => q.get('status').toLowerCase().split(',').includes(o.status.toLowerCase()));
    rows.sort((a, b) => b.updated_at - a.updated_at);
    return page(res, rows.map(o => orderView(o, q.get('_fields'))), q);
  }
  if (api === '/orders/print_awbs' && req.method === 'POST') {
    const ids = (json.order_ids || []).map(Number);
    const missing = ids.filter(id => !orders.find(o => o.id === id));
    if (missing.length) return fail(res, 404, 'NOT_FOUND', `Orders not found: ${missing.join(', ')}`);
    const print_jobs = {};
    for (const id of ids) {
      const o = orders.find(x => x.id === id);
      const key = o.shop_name;
      print_jobs[key] = print_jobs[key] || { platform: o.platform, shop_id: o.shop_id, labels: [] };
      if (o.platform === 'Shopee') {
        const f = path.join(PDFDIR, id + '.pdf');
        print_jobs[key].labels.push({ order_id: id, order_no: o.order_no, pdf_base64: fs.existsSync(f) ? fs.readFileSync(f).toString('base64') : '' });
      } else if (o.platform === 'TikTok') {
        print_jobs[key].labels.push({ order_id: id, packages: [{ tracking_number: o.tracking_no || ('TT' + id), url: `http://localhost:${PORT}/awb/${id}.pdf` }] });
      } else {
        print_jobs[key].labels.push({ order_id: id, url: `http://localhost:${PORT}/awb/${id}.pdf` });
      }
    }
    return send(res, 201, { data: { print_jobs }, meta: {}, links: {}, errors: [], warnings: [] });
  }
  if ((m = api.match(/^\/orders\/(\d+)$/))) {
    const o = orders.find(x => x.id === Number(m[1]));
    if (!o) return fail(res, 404, 'NOT_FOUND', 'Order not found');
    if (req.method === 'GET') return send(res, 200, { data: orderView(o, q.get('_fields')), meta: {}, links: {}, errors: [], warnings: [] });
    if (req.method === 'PUT') {
      if (json.mark_as_shipped === true || json.mark_as_shipped === 'true') {
        // ASYNC, as the spec warns: the returned status has not moved yet.
        o.status = 'processing'; o.updated_at = nowSec();
        setTimeout(() => { o.status = 'shipped'; o.updated_at = nowSec(); if (!o.tracking_no) o.tracking_no = 'MOCK-TRK-' + o.id; }, 2000);
      }
      return send(res, 200, { data: orderView(o), meta: {}, links: {}, errors: [], warnings: [] });
    }
  }
  return fail(res, 404, 'NOT_FOUND', 'unknown endpoint ' + api);
}).listen(PORT, () => console.log('onecart mock on', PORT));
