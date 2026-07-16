'use strict';

/**
 * ASN (Advance Shipment Notice) Management
 * Upload and manage expected inbound shipments
 */

module.exports = function createASNManager(db) {

  /**
   * Create ASN from upload or manual entry
   */
  const createASN = (options = {}) => {
    const {
      asnNumber,
      poNumber = null,
      vendorName,
      carrierName = null,
      trackingNumber = null,
      estimatedDelivery = null,
      lines = [],  // {sku, description, expectedQty}
      notes = ''
    } = options;

    if (!asnNumber || !vendorName) {
      throw new Error('ASN number and vendor name required');
    }

    const asnId = require('crypto').randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO asn_headers (
        id, asn_number, po_number, vendor_name, carrier_name,
        tracking_number, estimated_delivery, status, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asnId,
      asnNumber,
      poNumber,
      vendorName,
      carrierName,
      trackingNumber,
      estimatedDelivery,
      'pending',
      notes,
      now
    );

    // Add ASN lines
    for (const line of lines) {
      const lineId = require('crypto').randomUUID();
      db.prepare(`
        INSERT INTO asn_lines (
          id, asn_id, sku, description, expected_qty, received_qty,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lineId,
        asnId,
        line.sku,
        line.description || '',
        line.expectedQty || 0,
        0,
        'pending',
        now
      );
    }

    return {
      asnId,
      asnNumber,
      vendorName,
      status: 'pending',
      lineCount: lines.length,
      createdAt: now
    };
  };

  /**
   * Link inbound receipt to ASN
   */
  const linkReceiptToASN = (inboundId, asnId) => {
    const asn = db.prepare(`
      SELECT * FROM asn_headers WHERE id = ?
    `).get(asnId);

    if (!asn) throw new Error('ASN not found');

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE inbound_receipts
      SET asn_id = ?, updated_at = ?
      WHERE id = ?
    `).run(asnId, now, inboundId);

    db.prepare(`
      UPDATE asn_headers SET status = 'receiving' WHERE id = ?
    `).run(asnId);

    return { inboundId, asnId, linkedAt: now };
  };

  /**
   * Get ASN details with expected vs received
   */
  const getASNDetails = (asnId) => {
    const asn = db.prepare(`
      SELECT * FROM asn_headers WHERE id = ?
    `).get(asnId);

    if (!asn) return null;

    const lines = db.prepare(`
      SELECT * FROM asn_lines WHERE asn_id = ?
    `).all(asnId);

    return {
      asnId,
      asnNumber: asn.asn_number,
      vendorName: asn.vendor_name,
      poNumber: asn.po_number,
      carrierName: asn.carrier_name,
      trackingNumber: asn.tracking_number,
      estimatedDelivery: asn.estimated_delivery,
      status: asn.status,
      lines: lines.map(line => ({
        sku: line.sku,
        description: line.description,
        expectedQty: line.expected_qty,
        receivedQty: line.received_qty,
        variance: line.received_qty - line.expected_qty,
        variancePct: line.expected_qty > 0
          ? Math.round(((line.received_qty - line.expected_qty) / line.expected_qty) * 100)
          : 0,
        status: line.status
      }))
    };
  };

  /**
   * Upload ASN from file (CSV/Excel)
   */
  const uploadASNFromFile = (fileData, options = {}) => {
    const {
      asnNumber,
      vendorName,
      poNumber = null
    } = options;

    if (!asnNumber || !vendorName) {
      throw new Error('ASN number and vendor name required');
    }

    // Parse file (CSV or Excel)
    const lines = [];
    for (const row of fileData) {
      if (row.sku && row.expected_qty) {
        lines.push({
          sku: row.sku.toUpperCase().trim(),
          description: row.description || '',
          expectedQty: parseInt(row.expected_qty, 10) || 0
        });
      }
    }

    if (lines.length === 0) {
      throw new Error('No valid lines found in file');
    }

    // Create ASN
    return createASN({
      asnNumber,
      vendorName,
      poNumber,
      lines
    });
  };

  /**
   * Close ASN (all lines received or rejected)
   */
  const closeASN = (asnId) => {
    const asn = db.prepare(`
      SELECT * FROM asn_headers WHERE id = ?
    `).get(asnId);

    if (!asn) throw new Error('ASN not found');

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE asn_headers SET status = 'closed', closed_at = ? WHERE id = ?
    `).run(now, asnId);

    return { asnId, status: 'closed', closedAt: now };
  };

  return {
    createASN,
    linkReceiptToASN,
    getASNDetails,
    uploadASNFromFile,
    closeASN
  };
};
