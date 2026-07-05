'use strict';

const { query } = require('./db');
const { gql }   = require('./graphql');

// ── GraphQL queries / mutations ───────────────────────────────────────────────

const LOCATIONS_QUERY = `
  query { locations(first: 10) { nodes { id name } } }
`;

const INV_LEVELS_QUERY = `
  query GetInventoryLevels($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        inventoryLevels(first: 10) {
          nodes {
            location { id name }
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }
  }
`;

const SET_QTY_MUTATION = `
  mutation SetInventoryQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { id }
      userErrors { field message }
    }
  }
`;

// ── Pull: Shopify inventory → IDEALONE ────────────────────────────────────────

async function pullFromShopify(shopDomain, accessToken, getCtx) {
  // Get all inventory item IDs we know about for this shop
  const mappingRows = await query(
    'SELECT variant_id, idealone_sku, inventory_item_id FROM shopify_sku_mappings WHERE shop_domain=$1 AND inventory_item_id IS NOT NULL',
    [shopDomain]
  );
  if (!mappingRows.rows.length) return { synced: 0 };

  const shopRow = await query('SELECT tenant_id FROM shopify_shops WHERE shop_domain=$1', [shopDomain]);
  const tenantId = shopRow.rows[0]?.tenant_id || 'default';
  const { inventory } = getCtx(tenantId);

  // Batch requests to avoid exceeding query complexity
  const BATCH = 50;
  const items = mappingRows.rows;
  let synced = 0;

  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const ids   = batch.map(r => r.inventory_item_id);

    const data = await gql(shopDomain, accessToken, INV_LEVELS_QUERY, { ids });
    for (const node of data.nodes || []) {
      if (!node) continue;
      const row = batch.find(r => r.inventory_item_id === node.id);
      if (!row) continue;

      for (const level of node.inventoryLevels?.nodes || []) {
        const available = level.quantities?.find(q => q.name === 'available')?.quantity ?? 0;
        const locId     = level.location.id;
        const locName   = level.location.name;

        await query(
          `INSERT INTO shopify_inventory_levels (shop_domain, inventory_item_id, location_id, location_name, available)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (shop_domain, inventory_item_id, location_id)
             DO UPDATE SET available=$5, location_name=$4, updated_at=NOW()`,
          [shopDomain, node.id, locId, locName, available]
        );

        // Update IDEALONE inventory if we track this SKU
        try {
          const inv = inventory.get(row.idealone_sku);
          if (inv) {
            // Set absolute quantity (sync from source of truth)
            const delta = available - inv.stock_qty;
            if (delta !== 0) inventory.adjust(row.idealone_sku, delta, 'sync', 'Shopify inventory sync');
            synced++;
          }
        } catch {}
      }
    }
  }

  return { synced };
}

// ── Push: IDEALONE inventory → Shopify ────────────────────────────────────────

async function pushToShopify(shopDomain, accessToken, getCtx) {
  const shopRow = await query('SELECT tenant_id FROM shopify_shops WHERE shop_domain=$1', [shopDomain]);
  const tenantId = shopRow.rows[0]?.tenant_id || 'default';
  const { inventory } = getCtx(tenantId);

  // Get all locations for this shop (we'll use the first/primary location)
  const locData = await gql(shopDomain, accessToken, LOCATIONS_QUERY);
  const locations = locData.locations?.nodes || [];
  if (!locations.length) return { pushed: 0, error: 'No locations found in Shopify' };
  const primaryLocationId = locations[0].id;

  // Get all IDEALONE inventory items and find matching Shopify variants
  const allInv = inventory.getAll();
  const quantities = [];

  for (const item of allInv) {
    const mapRows = await query(
      'SELECT inventory_item_id FROM shopify_sku_mappings WHERE shop_domain=$1 AND idealone_sku=$2 AND inventory_item_id IS NOT NULL',
      [shopDomain, item.sku]
    );
    for (const r of mapRows.rows) {
      quantities.push({
        inventoryItemId: r.inventory_item_id,
        locationId:      primaryLocationId,
        quantity:        item.stock_qty ?? 0,
      });
    }
  }

  if (!quantities.length) return { pushed: 0 };

  // Shopify allows max 100 quantities per mutation call
  const BATCH = 100;
  let pushed = 0;
  for (let i = 0; i < quantities.length; i += BATCH) {
    const batch = quantities.slice(i, i + BATCH);
    const data  = await gql(shopDomain, accessToken, SET_QTY_MUTATION, {
      input: { name: 'available', reason: 'correction', quantities: batch },
    });
    const errs = data.inventorySetQuantities?.userErrors || [];
    if (errs.length) console.warn('[shopify inv push] userErrors:', errs);
    pushed += batch.length - errs.length;
  }

  return { pushed };
}

module.exports = { pullFromShopify, pushToShopify };
