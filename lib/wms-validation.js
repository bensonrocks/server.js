'use strict';

/**
 * WMS Validation Framework
 * Comprehensive data quality checks for cartons, returns, and allocation operations
 *
 * All validation errors include:
 * - issue: category (CRITICAL, WARNING)
 * - description: what went wrong
 * - action: how to fix it
 * - critical: whether it blocks operation
 */

const INVALID_PLACEHOLDERS = [
  'n/a', 'na', 'nil', 'none', 'null', 'tbc', 'tbd', '-', '--', '—', '.', '...',
];

function isBlank(v) {
  if (v === null || v === undefined) return true;
  return String(v).trim() === '';
}

function isInvalidPlaceholder(v) {
  return INVALID_PLACEHOLDERS.includes(String(v).trim().toLowerCase());
}

// ────────────────────────────────────────────────────────────────────────────
// Carton Validation
// ────────────────────────────────────────────────────────────────────────────

function validateCartonData(cartons) {
  const errors = [];

  for (let i = 0; i < cartons.length; i++) {
    const carton = cartons[i];
    const cartonNum = i + 1;
    const cartonId = carton.id || `carton-${cartonNum}`;

    // Mandatory fields
    const mandatoryFields = [
      { field: 'order_id', label: 'Order ID', critical: true },
      { field: 'weight', label: 'Weight (kg)', critical: false },
      { field: 'length', label: 'Length (cm)', critical: false },
      { field: 'width', label: 'Width (cm)', critical: false },
      { field: 'height', label: 'Height (cm)', critical: false },
    ];

    for (const { field, label, critical } of mandatoryFields) {
      if (isBlank(carton[field])) {
        errors.push({
          cartonNum,
          cartonId,
          field,
          issue: `${label.toUpperCase()} MISSING`,
          description: `${label} (${field}) is empty`,
          action: `Populate the ${label.toLowerCase()} for this carton`,
          critical,
        });
      }
    }

    // Dimension validation
    if (!isBlank(carton.weight)) {
      const weight = parseFloat(carton.weight);
      if (isNaN(weight) || weight <= 0) {
        errors.push({
          cartonNum,
          cartonId,
          field: 'weight',
          issue: 'INVALID WEIGHT',
          description: `Weight "${carton.weight}" is not a positive number`,
          action: 'Correct the weight to a positive numeric value (kg)',
          critical: true,
        });
      }
      if (weight > 50) {
        errors.push({
          cartonNum,
          cartonId,
          field: 'weight',
          issue: 'CARTON TOO HEAVY',
          description: `Weight ${weight}kg exceeds standard carton limit (50kg)`,
          action: 'Verify the weight or split into multiple cartons',
          critical: false,
        });
      }
    }

    // Volume validation
    const dims = [carton.length, carton.width, carton.height].filter(d => !isBlank(d));
    if (dims.length > 0 && dims.length < 3) {
      errors.push({
        cartonNum,
        cartonId,
        field: 'dimensions',
        issue: 'INCOMPLETE DIMENSIONS',
        description: `Only ${dims.length}/3 dimensions provided (length, width, height)`,
        action: 'Provide all three dimensions or none',
        critical: false,
      });
    }

    if (dims.length === 3) {
      const [l, w, h] = dims.map(d => parseFloat(d));
      const volume = l * w * h;
      if (volume > 1000) {
        errors.push({
          cartonNum,
          cartonId,
          field: 'dimensions',
          issue: 'CARTON TOO LARGE',
          description: `Volume ${volume}cm³ exceeds standard limit (1000cm³)`,
          action: 'Verify dimensions or split into multiple cartons',
          critical: false,
        });
      }
    }
  }

  return {
    passed: errors.filter(e => e.critical).length === 0,
    totalCartons: cartons.length,
    totalErrors: errors.length,
    criticalErrors: errors.filter(e => e.critical).length,
    errors,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Return Item Validation
// ────────────────────────────────────────────────────────────────────────────

function validateReturnItems(returns) {
  const errors = [];

  for (let i = 0; i < returns.length; i++) {
    const ret = returns[i];
    const rowNum = i + 1;
    const returnId = ret.id || `return-${rowNum}`;

    // Mandatory fields
    if (isBlank(ret.order_id)) {
      errors.push({
        rowNum,
        returnId,
        field: 'order_id',
        issue: 'ORDER ID MISSING',
        description: 'Order ID is empty',
        action: 'Reference the original order for this return',
        critical: true,
      });
    }

    if (isBlank(ret.sku_id)) {
      errors.push({
        rowNum,
        returnId,
        field: 'sku_id',
        issue: 'SKU MISSING',
        description: 'SKU/Product code is empty',
        action: 'Identify the returned product',
        critical: true,
      });
    }

    // Quantity validation
    if (!isBlank(ret.return_qty)) {
      const qty = parseInt(ret.return_qty);
      if (isNaN(qty) || qty <= 0) {
        errors.push({
          rowNum,
          returnId,
          field: 'return_qty',
          issue: 'INVALID RETURN QUANTITY',
          description: `Quantity "${ret.return_qty}" is not a positive integer`,
          action: 'Correct to a positive whole number',
          critical: true,
        });
      }
      if (qty > 1000) {
        errors.push({
          rowNum,
          returnId,
          field: 'return_qty',
          issue: 'UNUSUAL RETURN QUANTITY',
          description: `Quantity ${qty} is unusually high`,
          action: 'Verify the returned quantity',
          critical: false,
        });
      }
    }

    // Condition validation
    const validConditions = ['good', 'like-new', 'damaged', 'defective', 'unknown'];
    if (!isBlank(ret.condition) && !validConditions.includes(String(ret.condition).toLowerCase())) {
      errors.push({
        rowNum,
        returnId,
        field: 'condition',
        issue: 'INVALID CONDITION',
        description: `Condition "${ret.condition}" is not valid`,
        action: `Use one of: ${validConditions.join(', ')}`,
        critical: false,
      });
    }

    // Reason validation
    if (isBlank(ret.reason)) {
      errors.push({
        rowNum,
        returnId,
        field: 'reason',
        issue: 'RETURN REASON MISSING',
        description: 'Reason for return is empty',
        action: 'Document why the item is being returned',
        critical: false,
      });
    }

    // Placeholder rejection
    if (!isBlank(ret.notes) && isInvalidPlaceholder(ret.notes)) {
      errors.push({
        rowNum,
        returnId,
        field: 'notes',
        issue: 'INVALID PLACEHOLDER IN NOTES',
        description: `Notes contain placeholder value: "${String(ret.notes).trim()}"`,
        action: 'Provide actual inspection notes or leave blank',
        critical: false,
      });
    }
  }

  return {
    passed: errors.filter(e => e.critical).length === 0,
    totalReturns: returns.length,
    totalErrors: errors.length,
    criticalErrors: errors.filter(e => e.critical).length,
    errors,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Allocation Validation
// ────────────────────────────────────────────────────────────────────────────

function validateAllocationRequest(orderId, strategy) {
  const errors = [];

  if (isBlank(orderId)) {
    errors.push({
      field: 'order_id',
      issue: 'ORDER ID REQUIRED',
      description: 'No order ID provided',
      action: 'Specify an order ID to allocate',
      critical: true,
    });
  }

  const validStrategies = ['nearest', 'highest_stock', 'smallest'];
  if (!validStrategies.includes(strategy)) {
    errors.push({
      field: 'strategy',
      issue: 'INVALID ALLOCATION STRATEGY',
      description: `Strategy "${strategy}" is not valid`,
      action: `Use one of: ${validStrategies.join(', ')}`,
      critical: true,
    });
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Batch Allocation Validation
// ────────────────────────────────────────────────────────────────────────────

function validateBatchAllocation(orderIds, strategy) {
  const errors = [];

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    errors.push({
      field: 'orderIds',
      issue: 'NO ORDERS PROVIDED',
      description: 'Order ID array is empty',
      action: 'Provide at least one order ID',
      critical: true,
    });
  }

  if (orderIds.length > 1000) {
    errors.push({
      field: 'orderIds',
      issue: 'BATCH TOO LARGE',
      description: `${orderIds.length} orders exceeds batch limit (1000)`,
      action: 'Split into smaller batches',
      critical: true,
    });
  }

  const validStrategies = ['nearest', 'highest_stock', 'smallest'];
  if (!validStrategies.includes(strategy)) {
    errors.push({
      field: 'strategy',
      issue: 'INVALID ALLOCATION STRATEGY',
      description: `Strategy "${strategy}" is not valid`,
      action: `Use one of: ${validStrategies.join(', ')}`,
      critical: true,
    });
  }

  return {
    passed: errors.length === 0,
    totalOrders: orderIds.length,
    errors,
  };
}

module.exports = {
  validateCartonData,
  validateReturnItems,
  validateAllocationRequest,
  validateBatchAllocation,
};
