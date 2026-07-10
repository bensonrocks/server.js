'use strict';
const crypto = require('crypto');

// ── Shopee helpers ────────────────────────────────────────────────────────────
const SHOPEE_BASE = 'https://partner.shopeemobile.com';

function shopeeSign(key, pid, path, ts, token = '', shopId = '') {
  return crypto.createHmac('sha256', key).update(`${pid}${path}${ts}${token}${shopId}`).digest('hex');
}

async function shopeeApi(creds, path, extra = {}, method = 'GET', body = null) {
  const pid  = String(creds.partnerId  ?? '');
  const pkey = String(creds.partnerKey ?? '');
  const tok  = String(creds.accessToken ?? '');
  const sid  = String(creds.shopId ?? '');
  const ts   = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(pkey, pid, path, ts, tok, sid);
  const p = new URLSearchParams({ partner_id: pid, timestamp: String(ts), sign, access_token: tok, shop_id: sid, ...extra });
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SHOPEE_BASE}${path}?${p}`, opts);
  const j = await res.json();
  if (j.error && j.error !== '') throw new Error(`Shopee: ${j.message ?? j.error}`);
  return j;
}

// ── Lazada helpers ────────────────────────────────────────────────────────────
const LAZADA_BASE = { MY:'https://api.lazada.com.my', SG:'https://api.lazada.sg', TH:'https://api.lazada.co.th', PH:'https://api.lazada.com.ph', ID:'https://api.lazada.co.id', VN:'https://api.lazada.vn' };

function lazadaSign(secret, apiPath, params) {
  const str = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  return crypto.createHmac('sha256', secret).update(`${apiPath}${str}`).digest('hex').toUpperCase();
}

async function lazadaApi(creds, apiPath, extra = {}) {
  const appKey = String(creds.appKey ?? '');
  const secret = String(creds.appSecret ?? '');
  const token  = String(creds.accessToken ?? '');
  const region = String(creds.region ?? 'MY');
  const base   = LAZADA_BASE[region] ?? LAZADA_BASE.MY;
  const ts     = Date.now().toString();
  const params = { app_key: appKey, access_token: token, sign_method: 'sha256', timestamp: ts, ...extra };
  params.sign  = lazadaSign(secret, apiPath, params);
  const res = await fetch(`${base}/rest${apiPath}?${new URLSearchParams(params)}`);
  const j = await res.json();
  if (j.code && j.code !== '0') throw new Error(`Lazada ${j.code}: ${j.message}`);
  return j.data ?? {};
}

// ── TikTok helpers ────────────────────────────────────────────────────────────
const TTK_BASE = 'https://open-api.tiktokglobalshop.com';
const TTK_VER  = '202309';

function tiktokSign(secret, params, body = '') {
  const excl = new Set(['sign', 'access_token']);
  const str  = Object.keys(params).filter(k => !excl.has(k)).sort().map(k => `${k}${params[k]}`).join('');
  return crypto.createHmac('sha256', secret).update(`${secret}${str}${body}${secret}`).digest('hex');
}

async function tiktokApi(creds, endpoint, bodyObj = null, method = 'POST') {
  const appKey = String(creds.appKey ?? '');
  const secret = String(creds.appSecret ?? '');
  const token  = String(creds.accessToken ?? '');
  const shopId = String(creds.shopId ?? '');
  const ts     = Math.floor(Date.now() / 1000);
  const params = { app_key: appKey, access_token: token, timestamp: String(ts), shop_id: shopId, version: TTK_VER };
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
  params.sign   = tiktokSign(secret, params, bodyStr);
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (bodyStr) opts.body = bodyStr;
  const res = await fetch(`${TTK_BASE}${endpoint}?${new URLSearchParams(params)}`, opts);
  const j = await res.json();
  if (j.code !== 0) throw new Error(`TikTok ${j.code}: ${j.message}`);
  return j.data ?? {};
}

// ── Shopify GraphQL helper ────────────────────────────────────────────────────
async function shopifyGql(creds, query, variables = {}) {
  const domain = String(creds.shopDomain ?? creds.shop ?? '').replace(/^https?:\/\//, '');
  const token  = String(creds.accessToken ?? '');
  const res = await fetch(`https://${domain}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(`Shopify: ${j.errors[0]?.message}`);
  return j.data;
}

// ── SKU map helpers ───────────────────────────────────────────────────────────
function upsertMap(db, platform, omsSku, externalId, externalSkuId, name = '') {
  db.prepare(`
    INSERT INTO channel_sku_map (platform, oms_sku, external_id, external_sku_id, external_name, last_seen_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(platform, oms_sku) DO UPDATE SET
      external_id     = excluded.external_id,
      external_sku_id = excluded.external_sku_id,
      external_name   = excluded.external_name,
      last_seen_at    = excluded.last_seen_at
  `).run(platform, omsSku, String(externalId ?? ''), String(externalSkuId ?? ''), name);
}

// ── DISCOVER: build mappings from existing orders ─────────────────────────────
// Orders synced from marketplaces carry item_id/variantId in their items JSON.
// This builds the channel_sku_map without any API call.
function discover(platform, db) {
  const orders = db.prepare('SELECT items, source FROM orders WHERE channel = ?').all(platform);
  let count = 0;
  for (const row of orders) {
    let items = [], source = {};
    try { items  = JSON.parse(row.items  || '[]'); } catch {}
    try { source = JSON.parse(row.source || '{}'); } catch {}
    for (const item of items) {
      if (!item.sku) continue;
      // variantId is stored from Shopee item_id, TikTok sku_id, etc.
      upsertMap(db, platform, item.sku, item.variantId ?? '', item.modelId ?? item.variantId ?? '', item.name ?? '');
      count++;
    }
  }
  return { discovered: count };
}

// ── SHOPEE ────────────────────────────────────────────────────────────────────

async function shopeePull(creds, db, inventory) {
  // Fetch all active items from the shop, then read stock per model
  let offset = 0, allItemIds = [];
  while (true) {
    const j = await shopeeApi(creds, '/api/v2/product/get_item_list', { offset: String(offset), page_size: '100', item_status: 'NORMAL' });
    const items = j.response?.item ?? [];
    allItemIds = allItemIds.concat(items.map(i => String(i.item_id)));
    if (!j.response?.has_next_page || items.length < 100) break;
    offset += 100;
  }
  if (!allItemIds.length) return { synced: 0, note: 'No active items found in Shopee' };

  let synced = 0;
  for (let i = 0; i < allItemIds.length; i += 50) {
    const batch = allItemIds.slice(i, i + 50);
    const j = await shopeeApi(creds, '/api/v2/product/get_item_base_info', { item_id_list: batch.join(',') });
    for (const item of (j.response?.item_list ?? [])) {
      const models = item.model_list?.length ? item.model_list : [{ model_id: 0, model_sku: item.item_sku, stock_info_v2: item.stock_info_v2 }];
      for (const model of models) {
        const sku = model.model_sku || item.item_sku;
        if (!sku) continue;
        const qty = Number(
          model.stock_info_v2?.summary_info?.total_available_stock ??
          model.stock_info?.stock_list?.[0]?.current_stock ?? 0
        );
        const inv = inventory.get(sku);
        if (inv) {
          const delta = qty - inv.stock_qty;
          if (delta !== 0) inventory.adjust(sku, delta, 'marketplace_sync', 'Shopee pull');
          synced++;
        }
        upsertMap(db, 'shopee', sku, String(item.item_id), String(model.model_id ?? 0), item.item_name ?? '');
      }
    }
  }
  return { synced };
}

async function shopeePush(creds, db, inventory) {
  const maps = db.prepare('SELECT * FROM channel_sku_map WHERE platform = ?').all('shopee');
  if (!maps.length) return { pushed: 0, warning: 'No SKU mappings — run Discover first' };

  // Group by item_id so we can batch models for the same item
  const byItem = {};
  for (const m of maps) {
    if (!m.external_id) continue;
    const inv = inventory.get(m.oms_sku);
    if (!inv) continue;
    const avail = Math.max(0, inv.stock_qty - inv.reserved_qty);
    (byItem[m.external_id] ??= []).push({ model_id: Number(m.external_sku_id || 0), normal_stock: avail });
  }

  let pushed = 0;
  for (const [itemId, stockList] of Object.entries(byItem)) {
    await shopeeApi(creds, '/api/v2/product/update_stock', {}, 'POST', { item_id: Number(itemId), stock_list: stockList });
    pushed += stockList.length;
  }
  return { pushed };
}

// ── LAZADA ────────────────────────────────────────────────────────────────────

async function lazadaPull(creds, db, inventory) {
  let offset = 0, synced = 0;
  while (true) {
    const data = await lazadaApi(creds, '/products/get', { filter: 'all', offset: String(offset), limit: '50', options: '1' });
    const products = data.products ?? [];
    for (const p of products) {
      for (const sku of (p.skus ?? [])) {
        const omsSku = String(sku.SellerSku ?? '');
        if (!omsSku) continue;
        const qty = Number(sku.quantity ?? sku.Available ?? 0);
        const inv = inventory.get(omsSku);
        if (inv) {
          const delta = qty - inv.stock_qty;
          if (delta !== 0) inventory.adjust(omsSku, delta, 'marketplace_sync', 'Lazada pull');
          synced++;
        }
        upsertMap(db, 'lazada', omsSku, String(p.item_id ?? ''), String(sku.SkuId ?? ''), p.attributes?.name ?? '');
      }
    }
    if (products.length < 50) break;
    offset += 50;
  }
  return { synced };
}

async function lazadaPush(creds, db, inventory) {
  const maps = db.prepare('SELECT * FROM channel_sku_map WHERE platform = ?').all('lazada');
  if (!maps.length) return { pushed: 0, warning: 'No SKU mappings — run Discover first' };

  const skus = [];
  for (const m of maps) {
    const inv = inventory.get(m.oms_sku);
    if (!inv) continue;
    const avail = Math.max(0, inv.stock_qty - inv.reserved_qty);
    skus.push({ SellerSku: m.oms_sku, quantity: avail, SellableQuantity: avail });
  }
  if (!skus.length) return { pushed: 0 };

  // Lazada expects the payload as a URL-encoded JSON string in the `payload` param
  await lazadaApi(creds, '/product/price_quantity/update', { payload: JSON.stringify({ skus }) });
  return { pushed: skus.length };
}

// ── TIKTOK ────────────────────────────────────────────────────────────────────

async function tiktokPull(creds, db, inventory) {
  let pageToken = '', synced = 0;
  while (true) {
    const body = { page_size: 100 };
    if (pageToken) body.page_token = pageToken;
    const data = await tiktokApi(creds, '/api/products/search', body);
    const products = data.products ?? [];

    for (const p of products) {
      // Get full product details to get per-SKU inventory
      let detail;
      try { detail = await tiktokApi(creds, `/api/products/${p.id}`, null, 'GET'); } catch { continue; }
      for (const sku of (detail.product?.skus ?? [])) {
        const sellerSku = String(sku.seller_sku ?? '');
        if (!sellerSku) continue;
        const qty = (sku.inventory ?? []).reduce((s, w) => s + Number(w.quantity ?? 0), 0);
        const inv = inventory.get(sellerSku);
        if (inv) {
          const delta = qty - inv.stock_qty;
          if (delta !== 0) inventory.adjust(sellerSku, delta, 'marketplace_sync', 'TikTok pull');
          synced++;
        }
        upsertMap(db, 'tiktok', sellerSku, String(p.id), String(sku.id ?? ''), p.title ?? '');
      }
    }
    pageToken = data.next_page_token ?? '';
    if (!pageToken || products.length < 100) break;
  }
  return { synced };
}

async function tiktokPush(creds, db, inventory) {
  const maps = db.prepare('SELECT * FROM channel_sku_map WHERE platform = ?').all('tiktok');
  if (!maps.length) return { pushed: 0, warning: 'No SKU mappings — run Discover first' };

  // Fetch warehouse list to get the primary warehouse_id
  let warehouseId;
  try {
    const wh = await tiktokApi(creds, '/api/logistics/warehouses', null, 'GET');
    warehouseId = wh.warehouse_list?.[0]?.id;
  } catch {}
  if (!warehouseId) return { pushed: 0, error: 'No TikTok warehouse found — check shop connection' };

  // Group by product_id
  const byProduct = {};
  for (const m of maps) {
    if (!m.external_id || !m.external_sku_id) continue;
    const inv = inventory.get(m.oms_sku);
    if (!inv) continue;
    const avail = Math.max(0, inv.stock_qty - inv.reserved_qty);
    (byProduct[m.external_id] ??= []).push({
      id: m.external_sku_id,
      seller_sku: m.oms_sku,
      inventory: [{ warehouse_id: warehouseId, quantity: avail }],
    });
  }

  let pushed = 0;
  for (const [productId, skus] of Object.entries(byProduct)) {
    await tiktokApi(creds, `/api/products/${productId}/inventory`, { skus }, 'PUT');
    pushed += skus.length;
  }
  return { pushed };
}

// ── SHOPIFY ───────────────────────────────────────────────────────────────────

async function shopifyPull(creds, db, inventory) {
  let cursor = null, synced = 0;
  const Q = `query GetProducts($after: String) {
    products(first: 50, after: $after) {
      edges {
        node {
          title
          variants(first: 100) {
            edges {
              node {
                sku
                inventoryQuantity
                inventoryItem { id }
              }
            }
          }
        }
        cursor
      }
      pageInfo { hasNextPage }
    }
  }`;

  while (true) {
    const data = await shopifyGql(creds, Q, { after: cursor });
    for (const edge of (data.products.edges ?? [])) {
      const title = edge.node.title ?? '';
      for (const vEdge of (edge.node.variants.edges ?? [])) {
        const v = vEdge.node;
        if (!v.sku) continue;
        const qty = Number(v.inventoryQuantity ?? 0);
        const inv = inventory.get(v.sku);
        if (inv) {
          const delta = qty - inv.stock_qty;
          if (delta !== 0) inventory.adjust(v.sku, delta, 'marketplace_sync', 'Shopify pull');
          synced++;
        }
        upsertMap(db, 'shopify', v.sku, String(v.inventoryItem.id), String(v.inventoryItem.id), title);
      }
      cursor = edge.cursor;
    }
    if (!data.products.pageInfo.hasNextPage) break;
  }
  return { synced };
}

async function shopifyPush(creds, db, inventory) {
  // Get primary location
  const locData = await shopifyGql(creds, `query { locations(first:1) { nodes { id } } }`);
  const locationId = locData.locations.nodes[0]?.id;
  if (!locationId) return { pushed: 0, error: 'No Shopify location found' };

  const maps = db.prepare('SELECT * FROM channel_sku_map WHERE platform = ?').all('shopify');
  if (!maps.length) {
    // Try to auto-pull mappings from products first
    const pullResult = await shopifyPull(creds, db, inventory);
    const freshMaps  = db.prepare('SELECT * FROM channel_sku_map WHERE platform = ?').all('shopify');
    if (!freshMaps.length) return { pushed: 0, warning: 'No SKU mappings — run Pull first or check your Shopify products have SKUs matching OMS' };
    return shopifyPushMaps(freshMaps, creds, db, inventory, locationId);
  }
  return shopifyPushMaps(maps, creds, db, inventory, locationId);
}

async function shopifyPushMaps(maps, creds, db, inventory, locationId) {
  const SET_QTY = `mutation SetQty($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { id }
      userErrors { field message }
    }
  }`;

  const quantities = [];
  for (const m of maps) {
    if (!m.external_id) continue;
    const inv = inventory.get(m.oms_sku);
    if (!inv) continue;
    quantities.push({ inventoryItemId: m.external_id, locationId, quantity: Math.max(0, inv.stock_qty - inv.reserved_qty) });
  }
  if (!quantities.length) return { pushed: 0 };

  let pushed = 0;
  for (let i = 0; i < quantities.length; i += 100) {
    const batch = quantities.slice(i, i + 100);
    const data  = await shopifyGql(creds, SET_QTY, { input: { name: 'available', reason: 'correction', quantities: batch } });
    const errs  = data.inventorySetQuantities?.userErrors ?? [];
    if (errs.length) console.warn('[shopify push] userErrors:', errs);
    pushed += batch.length - errs.length;
  }
  return { pushed };
}

// ── Main router ───────────────────────────────────────────────────────────────
const SUPPORTED = new Set(['shopee', 'lazada', 'tiktok', 'shopify']);

async function syncInventory(action, platform, creds, db, inventory) {
  if (!SUPPORTED.has(platform)) throw new Error(`Inventory sync not supported for: ${platform}`);
  if (action === 'pull') {
    if (platform === 'shopee')  return shopeePull(creds, db, inventory);
    if (platform === 'lazada')  return lazadaPull(creds, db, inventory);
    if (platform === 'tiktok')  return tiktokPull(creds, db, inventory);
    if (platform === 'shopify') return shopifyPull(creds, db, inventory);
  }
  if (action === 'push') {
    if (platform === 'shopee')  return shopeePush(creds, db, inventory);
    if (platform === 'lazada')  return lazadaPush(creds, db, inventory);
    if (platform === 'tiktok')  return tiktokPush(creds, db, inventory);
    if (platform === 'shopify') return shopifyPush(creds, db, inventory);
  }
  throw new Error(`Unknown action: ${action}`);
}

module.exports = { syncInventory, discover, SUPPORTED };
