'use strict';

const db = require('./db');

// ── Row serialisation ─────────────────────────────────────────────────────────

function toRow(o) {
  return [
    o.id, o.clientId, o.clientName, o.channel, o.orderDate,
    o.status, o.currency || 'USD', o.notes || '',
    JSON.stringify(o.items    || []),
    JSON.stringify(o.shipping || {}),
    o.subtotal || 0, o.shippingCost || 0, o.tax || 0, o.total || 0,
    JSON.stringify(o.source   || {}),
  ];
}

function fromRow(r) {
  return {
    id:           r.id,
    clientId:     r.client_id,
    clientName:   r.client_name,
    channel:      r.channel,
    orderDate:    r.order_date,
    status:       r.status,
    currency:     r.currency,
    notes:        r.notes,
    items:        JSON.parse(r.items    || '[]'),
    shipping:     JSON.parse(r.shipping || '{}'),
    subtotal:     r.subtotal,
    shippingCost: r.shipping_cost,
    tax:          r.tax,
    total:        r.total,
    source:       JSON.parse(r.source   || '{}'),
  };
}

const INSERT = db.prepare(`
  INSERT OR IGNORE INTO orders
    (id, client_id, client_name, channel, order_date, status, currency, notes,
     items, shipping, subtotal, shipping_cost, tax, total, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ── Seed on first run ─────────────────────────────────────────────────────────

const SEED = [
  // ── Acme Corp ─────────────────────────────────────────────────────────────
  { id:'ORD-2026-001',clientId:'acme-corp',clientName:'Acme Corp',channel:'shopify',orderDate:'2026-04-25T08:30:00Z',status:'delivered',currency:'USD',notes:'',items:[{sku:'WIDGET-BLU',name:'Blue Widget',qty:3,unitPrice:29.99},{sku:'CASE-LRG',name:'Large Carry Case',qty:1,unitPrice:12.50}],shipping:{recipient:'Alice Johnson',addressLine1:'45 Park Ave',addressLine2:'',city:'New York',state:'NY',zip:'10016',country:'US'},subtotal:102.47,shippingCost:0,tax:9.22,total:111.69,source:{type:'shopify',ingestedAt:'2026-04-25T08:35:00Z'}},
  { id:'ORD-2026-002',clientId:'acme-corp',clientName:'Acme Corp',channel:'email',orderDate:'2026-04-27T14:10:00Z',status:'shipped',currency:'USD',notes:'Priority shipping requested',items:[{sku:'GADGET-RED',name:'Red Gadget Pro',qty:2,unitPrice:49.99},{sku:'DESK-PAD',name:'Desk Pad XL',qty:1,unitPrice:24.99}],shipping:{recipient:'Bob Smith',addressLine1:'200 Broadway',addressLine2:'Suite 500',city:'New York',state:'NY',zip:'10007',country:'US'},subtotal:124.97,shippingCost:9.99,tax:11.25,total:146.21,source:{type:'email',ingestedAt:'2026-04-27T14:15:00Z',emailFrom:'orders@acme-corp.com',emailSubject:'[ECOM-ORDER] acme-corp | ORD-2026-002 | email'}},
  { id:'ORD-2026-003',clientId:'acme-corp',clientName:'Acme Corp',channel:'shopify',orderDate:'2026-04-30T11:45:00Z',status:'processing',currency:'USD',notes:'',items:[{sku:'WIDGET-BLU',name:'Blue Widget',qty:10,unitPrice:29.99}],shipping:{recipient:'Carol White',addressLine1:'77 Water St',addressLine2:'',city:'New York',state:'NY',zip:'10005',country:'US'},subtotal:299.90,shippingCost:0,tax:26.99,total:326.89,source:{type:'shopify',ingestedAt:'2026-04-30T11:50:00Z'}},
  { id:'ORD-2026-004',clientId:'acme-corp',clientName:'Acme Corp',channel:'web',orderDate:'2026-05-01T09:00:00Z',status:'confirmed',currency:'USD',notes:'',items:[{sku:'GADGET-RED',name:'Red Gadget Pro',qty:1,unitPrice:49.99},{sku:'DESK-PAD',name:'Desk Pad XL',qty:2,unitPrice:24.99}],shipping:{recipient:'David Lee',addressLine1:'555 5th Ave',addressLine2:'',city:'New York',state:'NY',zip:'10017',country:'US'},subtotal:99.97,shippingCost:5.99,tax:8.99,total:114.95,source:{type:'web',ingestedAt:'2026-05-01T09:05:00Z'}},
  { id:'ORD-2026-005',clientId:'acme-corp',clientName:'Acme Corp',channel:'email',orderDate:'2026-05-03T07:20:00Z',status:'pending',currency:'USD',notes:'New account — verify before processing',items:[{sku:'CASE-LRG',name:'Large Carry Case',qty:5,unitPrice:12.50},{sku:'WIDGET-BLU',name:'Blue Widget',qty:2,unitPrice:29.99}],shipping:{recipient:'Eve Brown',addressLine1:'10 Hudson Yards',addressLine2:'',city:'New York',state:'NY',zip:'10001',country:'US'},subtotal:122.48,shippingCost:12.99,tax:11.02,total:146.49,source:{type:'email',ingestedAt:'2026-05-03T07:25:00Z',emailFrom:'orders@acme-corp.com',emailSubject:'[ECOM-ORDER] acme-corp | ORD-2026-005 | email'}},
  // ── TechGear Ltd ──────────────────────────────────────────────────────────
  { id:'ORD-2026-006',clientId:'techgear-ltd',clientName:'TechGear Ltd',channel:'amazon',orderDate:'2026-04-26T16:00:00Z',status:'shipped',currency:'USD',notes:'',items:[{sku:'HEADPH-PRO',name:'Pro Headphones',qty:2,unitPrice:89.99}],shipping:{recipient:'Frank Miller',addressLine1:'321 Oak St',addressLine2:'',city:'Austin',state:'TX',zip:'73301',country:'US'},subtotal:179.98,shippingCost:0,tax:16.20,total:196.18,source:{type:'amazon',ingestedAt:'2026-04-26T16:05:00Z'}},
  { id:'ORD-2026-007',clientId:'techgear-ltd',clientName:'TechGear Ltd',channel:'woocommerce',orderDate:'2026-04-28T10:30:00Z',status:'confirmed',currency:'USD',notes:'',items:[{sku:'KEYBOARD-MEC',name:'Mechanical Keyboard',qty:1,unitPrice:129.99},{sku:'MOUSE-WRL',name:'Wireless Mouse',qty:1,unitPrice:59.99}],shipping:{recipient:'Grace Chen',addressLine1:'88 Tech Blvd',addressLine2:'',city:'San Jose',state:'CA',zip:'95101',country:'US'},subtotal:189.98,shippingCost:4.99,tax:17.10,total:212.07,source:{type:'woocommerce',ingestedAt:'2026-04-28T10:35:00Z'}},
  { id:'ORD-2026-008',clientId:'techgear-ltd',clientName:'TechGear Ltd',channel:'amazon',orderDate:'2026-05-01T13:45:00Z',status:'processing',currency:'USD',notes:'',items:[{sku:'CHARGER-65W',name:'65W USB-C Charger',qty:3,unitPrice:34.99},{sku:'MOUSE-WRL',name:'Wireless Mouse',qty:2,unitPrice:59.99}],shipping:{recipient:'Henry Park',addressLine1:'500 Mission St',addressLine2:'Fl 10',city:'San Francisco',state:'CA',zip:'94105',country:'US'},subtotal:224.95,shippingCost:0,tax:20.25,total:245.20,source:{type:'amazon',ingestedAt:'2026-05-01T13:50:00Z'}},
  { id:'ORD-2026-009',clientId:'techgear-ltd',clientName:'TechGear Ltd',channel:'email',orderDate:'2026-05-02T08:00:00Z',status:'pending',currency:'USD',notes:'Corporate bulk order',items:[{sku:'KEYBOARD-MEC',name:'Mechanical Keyboard',qty:5,unitPrice:129.99},{sku:'HEADPH-PRO',name:'Pro Headphones',qty:5,unitPrice:89.99}],shipping:{recipient:'IT Procurement Dept',addressLine1:'1 Microsoft Way',addressLine2:'',city:'Redmond',state:'WA',zip:'98052',country:'US'},subtotal:1099.90,shippingCost:0,tax:98.99,total:1198.89,source:{type:'email',ingestedAt:'2026-05-02T08:05:00Z',emailFrom:'orders@techgear-ltd.com',emailSubject:'[ECOM-ORDER] techgear-ltd | ORD-2026-009 | email'}},
  // ── Fashion House ─────────────────────────────────────────────────────────
  { id:'ORD-2026-010',clientId:'fashion-house',clientName:'Fashion House',channel:'instagram',orderDate:'2026-04-27T19:00:00Z',status:'shipped',currency:'USD',notes:'Influencer order — gift wrap',items:[{sku:'DRESS-SUM',name:'Summer Dress',qty:1,unitPrice:79.99},{sku:'SCARF-SLK',name:'Silk Scarf',qty:1,unitPrice:44.99}],shipping:{recipient:'Isabella Davis',addressLine1:'8 Rodeo Dr',addressLine2:'',city:'Beverly Hills',state:'CA',zip:'90210',country:'US'},subtotal:124.98,shippingCost:0,tax:11.25,total:136.23,source:{type:'instagram',ingestedAt:'2026-04-27T19:05:00Z'}},
  { id:'ORD-2026-011',clientId:'fashion-house',clientName:'Fashion House',channel:'email',orderDate:'2026-04-29T11:00:00Z',status:'confirmed',currency:'USD',notes:'',items:[{sku:'SHIRT-CAS',name:'Casual Shirt',qty:3,unitPrice:34.99},{sku:'PANTS-SLM',name:'Slim Fit Pants',qty:2,unitPrice:59.99}],shipping:{recipient:'James Wilson',addressLine1:'200 Canal St',addressLine2:'',city:'New York',state:'NY',zip:'10013',country:'US'},subtotal:224.95,shippingCost:7.99,tax:20.25,total:253.19,source:{type:'email',ingestedAt:'2026-04-29T11:05:00Z',emailFrom:'orders@fashionhouse.com',emailSubject:'[ECOM-ORDER] fashion-house | ORD-2026-011 | email'}},
  { id:'ORD-2026-012',clientId:'fashion-house',clientName:'Fashion House',channel:'shopify',orderDate:'2026-05-01T15:30:00Z',status:'confirmed',currency:'USD',notes:'',items:[{sku:'DRESS-SUM',name:'Summer Dress',qty:2,unitPrice:79.99}],shipping:{recipient:'Karen Martinez',addressLine1:'750 Lincoln Ave',addressLine2:'',city:'Chicago',state:'IL',zip:'60614',country:'US'},subtotal:159.98,shippingCost:5.99,tax:14.40,total:180.37,source:{type:'shopify',ingestedAt:'2026-05-01T15:35:00Z'}},
  { id:'ORD-2026-013',clientId:'fashion-house',clientName:'Fashion House',channel:'instagram',orderDate:'2026-05-03T12:00:00Z',status:'pending',currency:'USD',notes:'DM order — awaiting payment confirmation',items:[{sku:'SCARF-SLK',name:'Silk Scarf',qty:2,unitPrice:44.99},{sku:'SHIRT-CAS',name:'Casual Shirt',qty:1,unitPrice:34.99}],shipping:{recipient:'Liam Taylor',addressLine1:'33 Sunset Blvd',addressLine2:'',city:'Los Angeles',state:'CA',zip:'90026',country:'US'},subtotal:124.97,shippingCost:6.99,tax:11.25,total:143.21,source:{type:'instagram',ingestedAt:'2026-05-03T12:05:00Z'}},
  // ── Home Goods Co ─────────────────────────────────────────────────────────
  { id:'ORD-2026-014',clientId:'home-goods-co',clientName:'Home Goods Co',channel:'web',orderDate:'2026-04-26T10:00:00Z',status:'delivered',currency:'USD',notes:'',items:[{sku:'BLENDER-PRO',name:'Pro Blender',qty:1,unitPrice:69.99},{sku:'CUTTING-BRD',name:'Bamboo Cutting Board',qty:2,unitPrice:24.99}],shipping:{recipient:'Mia Anderson',addressLine1:'400 Maple Ave',addressLine2:'',city:'Portland',state:'OR',zip:'97201',country:'US'},subtotal:119.97,shippingCost:0,tax:10.80,total:130.77,source:{type:'web',ingestedAt:'2026-04-26T10:05:00Z'}},
  { id:'ORD-2026-015',clientId:'home-goods-co',clientName:'Home Goods Co',channel:'email',orderDate:'2026-04-30T09:15:00Z',status:'shipped',currency:'USD',notes:'',items:[{sku:'KNIFE-SET',name:'8-Piece Knife Set',qty:1,unitPrice:89.99},{sku:'TOWEL-SET',name:'Bath Towel Set',qty:2,unitPrice:39.99}],shipping:{recipient:'Noah Thomas',addressLine1:'222 Pine St',addressLine2:'Unit 3',city:'Seattle',state:'WA',zip:'98101',country:'US'},subtotal:169.97,shippingCost:8.99,tax:15.30,total:194.26,source:{type:'email',ingestedAt:'2026-04-30T09:20:00Z',emailFrom:'orders@homegoods.co',emailSubject:'[ECOM-ORDER] home-goods-co | ORD-2026-015 | email'}},
  { id:'ORD-2026-016',clientId:'home-goods-co',clientName:'Home Goods Co',channel:'woocommerce',orderDate:'2026-05-01T14:00:00Z',status:'confirmed',currency:'USD',notes:'Wedding registry order',items:[{sku:'KNIFE-SET',name:'8-Piece Knife Set',qty:1,unitPrice:89.99},{sku:'BLENDER-PRO',name:'Pro Blender',qty:1,unitPrice:69.99},{sku:'TOWEL-SET',name:'Bath Towel Set',qty:3,unitPrice:39.99}],shipping:{recipient:'Olivia Jackson',addressLine1:'6 Vineyard Rd',addressLine2:'',city:'Napa',state:'CA',zip:'94558',country:'US'},subtotal:279.95,shippingCost:0,tax:25.20,total:305.15,source:{type:'woocommerce',ingestedAt:'2026-05-01T14:05:00Z'}},
  { id:'ORD-2026-017',clientId:'home-goods-co',clientName:'Home Goods Co',channel:'web',orderDate:'2026-05-02T16:45:00Z',status:'pending',currency:'USD',notes:'',items:[{sku:'CUTTING-BRD',name:'Bamboo Cutting Board',qty:4,unitPrice:24.99}],shipping:{recipient:'Peter Harris',addressLine1:'300 Oak Ln',addressLine2:'',city:'Denver',state:'CO',zip:'80201',country:'US'},subtotal:99.96,shippingCost:9.99,tax:8.99,total:118.94,source:{type:'web',ingestedAt:'2026-05-02T16:50:00Z'}},
  // ── Outdoor World ─────────────────────────────────────────────────────────
  { id:'ORD-2026-018',clientId:'outdoor-world',clientName:'Outdoor World',channel:'amazon',orderDate:'2026-04-29T07:30:00Z',status:'shipped',currency:'USD',notes:'',items:[{sku:'TENT-2P',name:'2-Person Tent',qty:1,unitPrice:199.99},{sku:'SLEEPING-BAG',name:'Sleeping Bag -10C',qty:2,unitPrice:119.99}],shipping:{recipient:'Quinn Roberts',addressLine1:'1 Mountain View Dr',addressLine2:'',city:'Boulder',state:'CO',zip:'80301',country:'US'},subtotal:439.97,shippingCost:0,tax:39.60,total:479.57,source:{type:'amazon',ingestedAt:'2026-04-29T07:35:00Z'}},
  { id:'ORD-2026-019',clientId:'outdoor-world',clientName:'Outdoor World',channel:'email',orderDate:'2026-05-01T11:00:00Z',status:'confirmed',currency:'USD',notes:'Group camping trip order',items:[{sku:'BACKPACK-45L',name:'45L Hiking Backpack',qty:4,unitPrice:89.99},{sku:'WATER-BTL',name:'Insulated Water Bottle',qty:4,unitPrice:24.99}],shipping:{recipient:'Rachel Green',addressLine1:'500 Trailhead Way',addressLine2:'',city:'Bend',state:'OR',zip:'97701',country:'US'},subtotal:459.92,shippingCost:0,tax:41.39,total:501.31,source:{type:'email',ingestedAt:'2026-05-01T11:05:00Z',emailFrom:'orders@outdoorworld.com',emailSubject:'[ECOM-ORDER] outdoor-world | ORD-2026-019 | email'}},
  { id:'ORD-2026-020',clientId:'outdoor-world',clientName:'Outdoor World',channel:'shopify',orderDate:'2026-05-03T06:00:00Z',status:'pending',currency:'USD',notes:'',items:[{sku:'TENT-2P',name:'2-Person Tent',qty:2,unitPrice:199.99},{sku:'BACKPACK-45L',name:'45L Hiking Backpack',qty:2,unitPrice:89.99}],shipping:{recipient:'Sam Wilson',addressLine1:'99 Summit Rd',addressLine2:'',city:'Flagstaff',state:'AZ',zip:'86001',country:'US'},subtotal:579.96,shippingCost:14.99,tax:52.20,total:647.15,source:{type:'shopify',ingestedAt:'2026-05-03T06:05:00Z'}},
];

const { n } = db.prepare('SELECT COUNT(*) AS n FROM orders').get();
if (n === 0) {
  db.transaction(seeds => seeds.forEach(o => INSERT.run(...toRow(o))))(SEED);
}

// ── Public API ────────────────────────────────────────────────────────────────

function getOrders({ clientId, channel, status, search } = {}) {
  let sql = 'SELECT * FROM orders WHERE 1=1';
  const params = [];
  if (clientId) { sql += ' AND client_id = ?';  params.push(clientId); }
  if (channel)  { sql += ' AND channel = ?';     params.push(channel); }
  if (status)   { sql += ' AND status = ?';      params.push(status); }
  sql += ' ORDER BY order_date DESC';
  let rows = db.prepare(sql).all(...params).map(fromRow);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(o =>
      o.id.toLowerCase().includes(q) ||
      o.clientName.toLowerCase().includes(q) ||
      o.shipping.recipient.toLowerCase().includes(q)
    );
  }
  return rows;
}

function getOrder(id) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  return row ? fromRow(row) : null;
}

function addOrder(order) {
  const exists = db.prepare('SELECT id FROM orders WHERE id = ?').get(order.id);
  if (exists) throw new Error(`Order ${order.id} already exists`);
  INSERT.run(...toRow(order));
  return order;
}

function getStats() {
  const rows     = db.prepare('SELECT status, channel, client_id, client_name, total FROM orders').all();
  const byStatus = {}, byChannel = {}, byClientMap = {};
  for (const o of rows) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    if (!byChannel[o.channel]) byChannel[o.channel] = { count: 0, revenue: 0 };
    byChannel[o.channel].count++;
    byChannel[o.channel].revenue = Math.round((byChannel[o.channel].revenue + o.total) * 100) / 100;
    if (!byClientMap[o.client_id]) byClientMap[o.client_id] = { clientId: o.client_id, clientName: o.client_name, count: 0, revenue: 0 };
    byClientMap[o.client_id].count++;
    byClientMap[o.client_id].revenue = Math.round((byClientMap[o.client_id].revenue + o.total) * 100) / 100;
  }
  return {
    totalOrders:   rows.length,
    totalRevenue:  Math.round(rows.reduce((s, o) => s + o.total, 0) * 100) / 100,
    totalClients:  Object.keys(byClientMap).length,
    totalChannels: Object.keys(byChannel).length,
    byStatus,
    byChannel,
    byClient: Object.values(byClientMap),
  };
}

function getClients() {
  return db.prepare(`
    SELECT client_id AS id, client_name AS name, COUNT(*) AS orderCount
    FROM orders GROUP BY client_id ORDER BY orderCount DESC
  `).all();
}

function getChannels() {
  return db.prepare(`
    SELECT channel, COUNT(*) AS count FROM orders GROUP BY channel ORDER BY count DESC
  `).all();
}

// Lookup by barcode/tracking: matches order ID, waybill-style ID prefix, or tracking number in source JSON
function lookupByCode(code) {
  const q = code.trim();
  // exact order ID
  let row = db.prepare('SELECT * FROM orders WHERE id = ?').get(q);
  if (row) return fromRow(row);
  // case-insensitive order ID
  row = db.prepare("SELECT * FROM orders WHERE LOWER(id) = LOWER(?)").get(q);
  if (row) return fromRow(row);
  // tracking number stored in source JSON — scan all and match
  const all = db.prepare('SELECT * FROM orders').all();
  const ql = q.toLowerCase();
  for (const r of all) {
    const src = JSON.parse(r.source || '{}');
    if (src.trackingNo && src.trackingNo.toLowerCase() === ql) return fromRow(r);
  }
  // partial match on order ID (e.g. scan gives "2026-001" → matches "ORD-2026-001")
  for (const r of all) {
    if (r.id.toLowerCase().includes(ql)) return fromRow(r);
  }
  return null;
}

function updateStatus(id, status) {
  const exists = db.prepare('SELECT id FROM orders WHERE id = ?').get(id);
  if (!exists) return null;
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
  return getOrder(id);
}

module.exports = { getOrders, getOrder, addOrder, getStats, getClients, getChannels, lookupByCode, updateStatus };
