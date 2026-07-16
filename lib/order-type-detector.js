'use strict';

/**
 * Order Type Detection
 * Classifies orders as B2C or B2B using rule-based logic and ML prediction
 */
module.exports = function createOrderTypeDetector(db) {

  const detectOrderType = (orderData) => {
    const {
      waybill,
      source,     // 'platform', 'manual_upload'
      po_number,
      qty,
      client_id,
      client_name,
    } = orderData;

    // Rule 1: If waybill exists → B2C (highest priority)
    if (waybill) {
      return {
        type: 'b2c',
        confidence: 0.99,
        reason: 'Has waybill',
        rule: 'waybill_rule',
      };
    }

    // Rule 2: Manual upload without waybill → B2B (default for manual)
    if (source === 'manual_upload' && !waybill) {
      return {
        type: 'b2b',
        confidence: 0.90,
        reason: 'Manual upload without waybill',
        rule: 'manual_upload_rule',
      };
    }

    // Rule 3: PO number present → B2B
    if (po_number) {
      return {
        type: 'b2b',
        confidence: 0.95,
        reason: 'PO number detected',
        rule: 'po_rule',
      };
    }

    // Rule 4: Volume-based heuristic (qty > 50 often B2B)
    if (qty && qty > 50) {
      return {
        type: 'b2b',
        confidence: 0.65,
        reason: `High quantity (${qty}) suggests bulk order`,
        rule: 'volume_rule',
      };
    }

    // Rule 5: Check client ML model
    if (client_id) {
      const mlPrediction = getClientMLPrediction(client_id);
      if (mlPrediction && mlPrediction.confidence > 0.75) {
        return {
          type: mlPrediction.type,
          confidence: mlPrediction.confidence,
          reason: `ML model predicts ${mlPrediction.type}`,
          rule: 'ml_rule',
          modelVersion: mlPrediction.version,
        };
      }
    }

    // Default: uncertain, ask user
    return {
      type: null,
      confidence: 0.5,
      reason: 'Unable to determine from rules or ML',
      rule: 'ask_user',
      requiresUserConfirmation: true,
    };
  };

  const getClientMLPrediction = (clientId) => {
    const model = db.prepare(`
      SELECT detected_type, confidence, updated_at FROM client_ml_model
      WHERE client_id = ? AND confidence > 0.5
    `).get(clientId);

    if (!model) return null;

    return {
      type: model.detected_type,
      confidence: model.confidence,
      version: model.updated_at,
    };
  };

  const recordDetection = (orderData, detectedType, userConfirmedType = null) => {
    const logId = require('crypto').randomUUID();
    const now = new Date().toISOString();
    const learned = userConfirmedType && userConfirmedType !== detectedType ? 1 : 0;

    db.prepare(`
      INSERT INTO order_type_log (id, po_id, order_id, upload_date, client_id, detected_type, user_confirmed_type, learned, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      logId,
      orderData.po_id || null,
      orderData.order_id || null,
      now,
      orderData.client_id || null,
      detectedType,
      userConfirmedType || detectedType,
      learned,
      now
    );

    // Update ML model if user confirmed
    if (userConfirmedType && orderData.client_id) {
      updateClientMLModel(orderData.client_id, userConfirmedType, learned);
    }

    return logId;
  };

  const updateClientMLModel = (clientId, confirmedType, learned) => {
    const existing = db.prepare(`
      SELECT * FROM client_ml_model WHERE client_id = ?
    `).get(clientId);

    const now = new Date().toISOString();

    if (!existing) {
      // Create new model
      const modelId = require('crypto').randomUUID();
      const initialConfidence = 0.65;

      db.prepare(`
        INSERT INTO client_ml_model (id, client_id, upload_count, b2b_confirmed, b2c_confirmed, detected_type, confidence, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
      `).run(
        modelId,
        clientId,
        confirmedType === 'b2b' ? 1 : 0,
        confirmedType === 'b2c' ? 1 : 0,
        confirmedType,
        initialConfidence,
        now,
        now
      );
    } else {
      // Update existing model (simple Naive Bayes)
      const b2bConfirmed = existing.b2b_confirmed + (confirmedType === 'b2b' ? 1 : 0);
      const b2cConfirmed = existing.b2c_confirmed + (confirmedType === 'b2c' ? 1 : 0);
      const totalConfirmed = b2bConfirmed + b2cConfirmed;
      const confidence = Math.max(b2bConfirmed, b2cConfirmed) / totalConfirmed;
      const detectedType = b2bConfirmed > b2cConfirmed ? 'b2b' : 'b2c';

      db.prepare(`
        UPDATE client_ml_model
        SET upload_count = upload_count + 1,
            b2b_confirmed = ?,
            b2c_confirmed = ?,
            detected_type = ?,
            confidence = ?,
            updated_at = ?
        WHERE client_id = ?
      `).run(b2bConfirmed, b2cConfirmed, detectedType, confidence, now, clientId);
    }
  };

  const getClientProfile = (clientId) => {
    const profile = db.prepare(`
      SELECT * FROM client_ml_model WHERE client_id = ?
    `).get(clientId);

    if (!profile) {
      return {
        clientId,
        uploadCount: 0,
        b2bConfirmed: 0,
        b2cConfirmed: 0,
        confidence: 0.5,
        detectedType: null,
        lastDetection: null,
      };
    }

    return {
      clientId,
      uploadCount: profile.upload_count,
      b2bConfirmed: profile.b2b_confirmed,
      b2cConfirmed: profile.b2c_confirmed,
      confidence: profile.confidence,
      detectedType: profile.detected_type,
      lastDetection: profile.updated_at,
    };
  };

  const getDetectionLog = (clientId = null, limit = 50) => {
    let sql = 'SELECT * FROM order_type_log WHERE 1=1';
    const params = [];

    if (clientId) {
      sql += ' AND client_id = ?';
      params.push(clientId);
    }

    sql += ' ORDER BY upload_date DESC LIMIT ?';
    params.push(limit);

    return db.prepare(sql).all(...params);
  };

  return {
    detectOrderType,
    recordDetection,
    updateClientMLModel,
    getClientProfile,
    getDetectionLog,
  };
};
