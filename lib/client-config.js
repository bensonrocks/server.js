'use strict';

/**
 * Client Configuration Manager
 * Handles client-level customizations: bundling, virtual warehouses, feature toggles
 */
module.exports = function createClientConfig(db) {

  // Get client configuration
  const getConfig = (clientId) => {
    const config = db.prepare('SELECT * FROM client_config WHERE client_id = ?').get(clientId);
    if (!config) return null;
    return {
      ...config,
      settings: config.settings ? JSON.parse(config.settings) : {}
    };
  };

  // Enable bundling for a client
  const enableBundling = (clientId) => {
    const existing = db.prepare('SELECT 1 FROM client_config WHERE client_id = ?').get(clientId);
    if (existing) {
      db.prepare(`
        UPDATE client_config
        SET bundling_enabled = 1, updated_at = datetime('now')
        WHERE client_id = ?
      `).run(clientId);
    } else {
      db.prepare(`
        INSERT INTO client_config (client_id, bundling_enabled, updated_at)
        VALUES (?, 1, datetime('now'))
      `).run(clientId);
    }
    return { clientId, bundling_enabled: true };
  };

  // Enable virtual warehouse for a client
  const enableVirtualWarehouse = (clientId) => {
    const existing = db.prepare('SELECT 1 FROM client_config WHERE client_id = ?').get(clientId);
    if (existing) {
      db.prepare(`
        UPDATE client_config
        SET virtual_warehouse_enabled = 1, updated_at = datetime('now')
        WHERE client_id = ?
      `).run(clientId);
    } else {
      db.prepare(`
        INSERT INTO client_config (client_id, virtual_warehouse_enabled, updated_at)
        VALUES (?, 1, datetime('now'))
      `).run(clientId);
    }
    return { clientId, virtual_warehouse_enabled: true };
  };

  // Create a bundle for a client
  // config: [{ sku: 'SKU-001', qty: 2 }, { sku: 'SKU-002', qty: 1 }]
  const createBundle = (clientId, bundleSku, bundleName, componentConfig, description = '') => {
    if (!Array.isArray(componentConfig) || componentConfig.length === 0) {
      throw new Error('Bundle must have at least one component');
    }

    db.prepare(`
      INSERT INTO client_bundles (client_id, bundle_sku, bundle_name, description, config)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      clientId,
      bundleSku,
      bundleName,
      description,
      JSON.stringify(componentConfig)
    );

    // Ensure client has bundling enabled
    enableBundling(clientId);

    return {
      clientId,
      bundleSku,
      bundleName,
      components: componentConfig,
      description
    };
  };

  // Get bundles for a client
  const getBundles = (clientId) => {
    const bundles = db.prepare(`
      SELECT bundle_sku, bundle_name, description, config
      FROM client_bundles
      WHERE client_id = ? AND active = 1
    `).all(clientId);

    return bundles.map(b => ({
      bundleSku: b.bundle_sku,
      bundleName: b.bundle_name,
      description: b.description,
      components: JSON.parse(b.config)
    }));
  };

  // Get a specific bundle
  const getBundle = (clientId, bundleSku) => {
    const bundle = db.prepare(`
      SELECT bundle_sku, bundle_name, description, config
      FROM client_bundles
      WHERE client_id = ? AND bundle_sku = ? AND active = 1
    `).get(clientId, bundleSku);

    if (!bundle) return null;
    return {
      bundleSku: bundle.bundle_sku,
      bundleName: bundle.bundle_name,
      description: bundle.description,
      components: JSON.parse(bundle.config)
    };
  };

  // Add a virtual warehouse SKU
  const addVirtualSku = (clientId, sku, warehouseName = 'Virtual', fulfillmentMethod = 'dropship', supplierInfo = '') => {
    db.prepare(`
      INSERT INTO client_virtual_skus (client_id, sku, warehouse_name, fulfillment_method, supplier_info)
      VALUES (?, ?, ?, ?, ?)
    `).run(clientId, sku, warehouseName, fulfillmentMethod, supplierInfo);

    // Ensure client has virtual warehouse enabled
    enableVirtualWarehouse(clientId);

    return {
      clientId,
      sku,
      warehouseName,
      fulfillmentMethod,
      supplierInfo
    };
  };

  // Get virtual warehouse SKUs for a client
  const getVirtualSkus = (clientId) => {
    const skus = db.prepare(`
      SELECT sku, warehouse_name, fulfillment_method, supplier_info
      FROM client_virtual_skus
      WHERE client_id = ? AND active = 1
    `).all(clientId);

    return skus.map(s => ({
      sku: s.sku,
      warehouseName: s.warehouse_name,
      fulfillmentMethod: s.fulfillment_method,
      supplierInfo: s.supplier_info
    }));
  };

  // Check if a SKU is virtual for a client
  const isVirtualSku = (clientId, sku) => {
    const result = db.prepare(`
      SELECT 1 FROM client_virtual_skus
      WHERE client_id = ? AND sku = ? AND active = 1
    `).get(clientId, sku);
    return !!result;
  };

  // Expand order items: replace bundles with components
  const expandOrderItems = (clientId, items) => {
    const config = getConfig(clientId);
    if (!config || !config.bundling_enabled) return items;

    const bundles = getBundles(clientId);
    const bundleMap = {};
    bundles.forEach(b => {
      bundleMap[b.bundleSku] = b.components;
    });

    const expanded = [];
    items.forEach(item => {
      if (bundleMap[item.sku]) {
        // Expand bundle: multiply component qty by bundle qty
        bundleMap[item.sku].forEach(component => {
          const existing = expanded.find(e => e.sku === component.sku);
          const qty = component.qty * item.qty;
          if (existing) {
            existing.qty += qty;
          } else {
            expanded.push({
              sku: component.sku,
              name: component.name || component.sku,
              qty,
              unitPrice: component.unitPrice || 0,
              isComponentOf: item.sku
            });
          }
        });
      } else {
        // Regular item, pass through
        expanded.push(item);
      }
    });

    return expanded;
  };

  // Check if client uses virtual warehouse
  const usesVirtualWarehouse = (clientId) => {
    const config = getConfig(clientId);
    return config && config.virtual_warehouse_enabled;
  };

  return {
    getConfig,
    enableBundling,
    enableVirtualWarehouse,
    createBundle,
    getBundles,
    getBundle,
    addVirtualSku,
    getVirtualSkus,
    isVirtualSku,
    expandOrderItems,
    usesVirtualWarehouse
  };
};
