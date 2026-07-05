'use strict';

const API_VER = '2025-01';

async function gql(shopDomain, accessToken, query, variables = {}) {
  const res = await fetch(`https://${shopDomain}/admin/api/${API_VER}/graphql.json`, {
    method:  'POST',
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Shopify GraphQL HTTP ${res.status}`);
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

// Walk a paginated Shopify connection using cursor-based pagination.
// getConn(data) must return the connection object with { nodes, pageInfo }.
async function paginate(shopDomain, accessToken, query, variables, getConn) {
  const results = [];
  let cursor  = null;
  let hasNext = true;
  while (hasNext) {
    const data = await gql(shopDomain, accessToken, query, { ...variables, after: cursor });
    const conn = getConn(data);
    results.push(...conn.nodes);
    hasNext = conn.pageInfo.hasNextPage;
    cursor  = conn.pageInfo.endCursor;
  }
  return results;
}

module.exports = { gql, paginate };
