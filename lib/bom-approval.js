'use strict';

const crypto = require('crypto');

/**
 * BOM (Bundle/Virtual SKU) Approval Workflow Manager
 * Handles client BOM submissions, staff approval/rejection
 */
module.exports = function createBOMApproval(db) {
  /**
   * Submit a bundle for approval
   */
  const submitBundleForApproval = (clientId, bundleSku, bundleName, components, description, submittedBy) => {
    const now = new Date().toISOString();

    // Check if bundle already exists
    const existing = db.prepare(`
      SELECT id FROM client_bundles WHERE client_id = ? AND bundle_sku = ? AND status != 'rejected'
    `).get(clientId, bundleSku);

    if (existing) {
      throw new Error(`Bundle ${bundleSku} already exists or is pending approval`);
    }

    db.prepare(`
      INSERT INTO client_bundles (
        client_id, bundle_sku, bundle_name, description, config,
        status, active, submitted_by, submitted_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      clientId,
      bundleSku,
      bundleName,
      description,
      JSON.stringify(components),
      submittedBy,
      now,
      now
    );

    return {
      bundleSku,
      bundleName,
      status: 'pending',
      submittedAt: now,
      submittedBy
    };
  };

  /**
   * Get pending bundles for a client
   */
  const getClientPendingBundles = (clientId) => {
    const bundles = db.prepare(`
      SELECT id, bundle_sku, bundle_name, description, config, status,
             submitted_at, submitted_by, approved_at, approved_by, rejection_reason
      FROM client_bundles
      WHERE client_id = ? AND status IN ('pending', 'rejected')
      ORDER BY submitted_at DESC
    `).all(clientId);

    return bundles.map(row => ({
      ...row,
      config: JSON.parse(row.config)
    }));
  };

  /**
   * Get all pending bundles for staff review
   */
  const getAllPendingBundles = (filter = {}) => {
    const { clientId, status = 'pending', limit = 50, offset = 0 } = filter;

    let sql = `
      SELECT id, client_id, bundle_sku, bundle_name, description, config, status,
             submitted_at, submitted_by, approved_at, approved_by
      FROM client_bundles
      WHERE status = ?
    `;
    const params = [status];

    if (clientId) {
      sql += ` AND client_id = ?`;
      params.push(clientId);
    }

    sql += ` ORDER BY submitted_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const bundles = db.prepare(sql).all(...params);

    return bundles.map(row => ({
      ...row,
      config: JSON.parse(row.config)
    }));
  };

  /**
   * Approve a pending bundle
   */
  const approveBundleSubmission = (bundleId, approvedBy) => {
    const bundle = db.prepare(`
      SELECT client_id, bundle_sku FROM client_bundles WHERE id = ?
    `).get(bundleId);

    if (!bundle) throw new Error('Bundle not found');

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE client_bundles
      SET status = 'approved', active = 1, approved_at = ?, approved_by = ?
      WHERE id = ?
    `).run(now, approvedBy, bundleId);

    return {
      bundleId,
      bundleSku: bundle.bundle_sku,
      status: 'approved',
      approvedAt: now,
      approvedBy
    };
  };

  /**
   * Reject a pending bundle
   */
  const rejectBundleSubmission = (bundleId, rejectionReason, rejectedBy) => {
    const bundle = db.prepare(`
      SELECT bundle_sku FROM client_bundles WHERE id = ?
    `).get(bundleId);

    if (!bundle) throw new Error('Bundle not found');

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE client_bundles
      SET status = 'rejected', active = 0, approved_at = ?, approved_by = ?, rejection_reason = ?
      WHERE id = ?
    `).run(now, rejectedBy, rejectionReason, bundleId);

    return {
      bundleId,
      bundleSku: bundle.bundle_sku,
      status: 'rejected',
      rejectionReason,
      rejectedAt: now,
      rejectedBy
    };
  };

  /**
   * Submit a virtual SKU for approval
   */
  const submitVirtualSKUForApproval = (clientId, sku, warehouseName, fulfillmentMethod, supplierInfo, submittedBy) => {
    const now = new Date().toISOString();

    // Check if SKU already exists
    const existing = db.prepare(`
      SELECT id FROM client_virtual_skus WHERE client_id = ? AND sku = ? AND status != 'rejected'
    `).get(clientId, sku);

    if (existing) {
      throw new Error(`Virtual SKU ${sku} already exists or is pending approval`);
    }

    db.prepare(`
      INSERT INTO client_virtual_skus (
        client_id, sku, warehouse_name, fulfillment_method, supplier_info,
        status, active, submitted_by, submitted_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      clientId,
      sku,
      warehouseName,
      fulfillmentMethod,
      supplierInfo,
      submittedBy,
      now,
      now
    );

    return {
      sku,
      status: 'pending',
      submittedAt: now,
      submittedBy
    };
  };

  /**
   * Get pending virtual SKUs for a client
   */
  const getClientPendingVirtualSkus = (clientId) => {
    const skus = db.prepare(`
      SELECT id, sku, warehouse_name, fulfillment_method, supplier_info, status,
             submitted_at, submitted_by, approved_at, approved_by, rejection_reason
      FROM client_virtual_skus
      WHERE client_id = ? AND status IN ('pending', 'rejected')
      ORDER BY submitted_at DESC
    `).all(clientId);

    return skus;
  };

  /**
   * Get all pending virtual SKUs for staff review
   */
  const getAllPendingVirtualSkus = (filter = {}) => {
    const { clientId, status = 'pending', limit = 50, offset = 0 } = filter;

    let sql = `
      SELECT id, client_id, sku, warehouse_name, fulfillment_method, supplier_info, status,
             submitted_at, submitted_by, approved_at, approved_by
      FROM client_virtual_skus
      WHERE status = ?
    `;
    const params = [status];

    if (clientId) {
      sql += ` AND client_id = ?`;
      params.push(clientId);
    }

    sql += ` ORDER BY submitted_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return db.prepare(sql).all(...params);
  };

  /**
   * Approve a pending virtual SKU
   */
  const approveVirtualSKUSubmission = (skuId, approvedBy) => {
    const sku = db.prepare(`
      SELECT sku FROM client_virtual_skus WHERE id = ?
    `).get(skuId);

    if (!sku) throw new Error('Virtual SKU not found');

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE client_virtual_skus
      SET status = 'approved', active = 1, approved_at = ?, approved_by = ?
      WHERE id = ?
    `).run(now, approvedBy, skuId);

    return {
      skuId,
      sku: sku.sku,
      status: 'approved',
      approvedAt: now,
      approvedBy
    };
  };

  /**
   * Reject a pending virtual SKU
   */
  const rejectVirtualSKUSubmission = (skuId, rejectionReason, rejectedBy) => {
    const sku = db.prepare(`
      SELECT sku FROM client_virtual_skus WHERE id = ?
    `).get(skuId);

    if (!sku) throw new Error('Virtual SKU not found');

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE client_virtual_skus
      SET status = 'rejected', active = 0, approved_at = ?, approved_by = ?, rejection_reason = ?
      WHERE id = ?
    `).run(now, rejectedBy, rejectionReason, skuId);

    return {
      skuId,
      sku: sku.sku,
      status: 'rejected',
      rejectionReason,
      rejectedAt: now,
      rejectedBy
    };
  };

  /**
   * Validate bundle components (check for circular refs, duplicates, etc)
   */
  const validateBundleComponents = (clientId, components) => {
    const errors = [];

    if (!Array.isArray(components) || components.length === 0) {
      errors.push('Bundle must have at least one component');
      return { valid: false, errors };
    }

    const seenSkus = new Set();
    components.forEach((comp, index) => {
      if (!comp.sku) errors.push(`Component ${index}: SKU is required`);
      if (!comp.qty || comp.qty < 1) errors.push(`Component ${index}: Quantity must be >= 1`);
      if (seenSkus.has(comp.sku)) errors.push(`Component ${index}: Duplicate SKU ${comp.sku}`);
      seenSkus.add(comp.sku);
    });

    return { valid: errors.length === 0, errors };
  };

  return {
    submitBundleForApproval,
    getClientPendingBundles,
    getAllPendingBundles,
    approveBundleSubmission,
    rejectBundleSubmission,
    submitVirtualSKUForApproval,
    getClientPendingVirtualSkus,
    getAllPendingVirtualSkus,
    approveVirtualSKUSubmission,
    rejectVirtualSKUSubmission,
    validateBundleComponents
  };
};
