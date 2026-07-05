'use strict';

const { query }    = require('./db');
const { gql, paginate } = require('./graphql');

const PRODUCTS_QUERY = `
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        variants(first: 100) {
          nodes {
            id
            sku
            title
            inventoryItem { id }
          }
        }
      }
    }
  }
`;

// Shopify GID helpers
const gidToId  = gid => BigInt(gid.split('/').pop());
const toNum    = gid => Number(gidToId(gid));

// Pull all product variants from Shopify and upsert into our mapping table.
// idealoneSku defaults to the Shopify SKU; operators can override in the DB later.
async function syncProductVariants(shopDomain, accessToken) {
  const products = await paginate(
    shopDomain, accessToken, PRODUCTS_QUERY, { first: 50 },
    d => d.products
  );

  for (const product of products) {
    for (const v of product.variants.nodes) {
      const variantId   = toNum(v.id);
      const productId   = toNum(product.id);
      const invItemId   = v.inventoryItem?.id || null;
      const sku         = v.sku || '';
      const idealoneSku = sku; // default: same as Shopify SKU

      if (!sku) continue;

      await query(
        `INSERT INTO shopify_sku_mappings
           (shop_domain, variant_id, product_id, shopify_sku, idealone_sku, title, inventory_item_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (shop_domain, variant_id)
           DO UPDATE SET shopify_sku=$4, title=$6, inventory_item_id=$7`,
        [shopDomain, variantId, productId, sku, idealoneSku, `${product.title} – ${v.title}`, invItemId]
      );
    }
  }
}

async function getIdealoneSku(shopDomain, variantId) {
  const r = await query(
    'SELECT idealone_sku FROM shopify_sku_mappings WHERE shop_domain=$1 AND variant_id=$2',
    [shopDomain, Number(variantId)]
  );
  return r.rows[0]?.idealone_sku || null;
}

async function upsertMapping(shopDomain, variantId, productId, shopifySku, idealoneSku, title, invItemId = null) {
  await query(
    `INSERT INTO shopify_sku_mappings
       (shop_domain, variant_id, product_id, shopify_sku, idealone_sku, title, inventory_item_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (shop_domain, variant_id)
       DO UPDATE SET idealone_sku=$5, title=$6, inventory_item_id=$7`,
    [shopDomain, Number(variantId), Number(productId), shopifySku, idealoneSku, title, invItemId]
  );
}

module.exports = { syncProductVariants, getIdealoneSku, upsertMapping };
