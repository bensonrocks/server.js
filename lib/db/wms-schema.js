'use strict';

/**
 * WMS Schema - Creates tables for order processing, picking, picking waves, returns, and analytics
 */
module.exports = function initWMSSchema(db) {
  db.exec(`
    -- Warehouses
    CREATE TABLE IF NOT EXISTS warehouses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      location_address TEXT,
      location_city TEXT,
      location_state TEXT,
      location_zip TEXT,
      location_lat REAL,
      location_lon REAL,
      capacity_units INTEGER DEFAULT 10000,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Inventory Balance (per warehouse)
    CREATE TABLE IF NOT EXISTS inventory_balance (
      id TEXT PRIMARY KEY,
      warehouse_id TEXT NOT NULL,
      sku_id TEXT NOT NULL,
      total_qty INTEGER DEFAULT 0,
      allocated_qty INTEGER DEFAULT 0,
      available_qty INTEGER DEFAULT 0,
      reserved_qty INTEGER DEFAULT 0,
      damaged_qty INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
      UNIQUE(warehouse_id, sku_id)
    );

    -- Inventory Movements (audit trail)
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id TEXT PRIMARY KEY,
      sku_id TEXT NOT NULL,
      warehouse_id TEXT,
      movement_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      reference_id TEXT,
      order_id TEXT,
      return_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (sku_id) REFERENCES skus(id)
    );

    -- Allocation Log
    CREATE TABLE IF NOT EXISTS allocation_log (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      strategy TEXT,
      allocated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    );

    -- Picking Waves
    CREATE TABLE IF NOT EXISTS picking_waves (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      warehouse_id TEXT,
      status TEXT DEFAULT 'created',
      priority TEXT DEFAULT 'normal',
      max_orders INTEGER DEFAULT 50,
      order_count INTEGER DEFAULT 0,
      thu_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    );

    -- Wave Orders (many-to-many)
    CREATE TABLE IF NOT EXISTS wave_orders (
      wave_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      sequence INTEGER,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      picked_at TEXT,
      PRIMARY KEY (wave_id, order_id),
      FOREIGN KEY (wave_id) REFERENCES picking_waves(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    -- Cartons (boxes/containers for shipment)
    CREATE TABLE IF NOT EXISTS cartons (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      wave_id TEXT,
      barcode TEXT UNIQUE,
      weight REAL,
      length REAL,
      width REAL,
      height REAL,
      line_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'created',
      sealed_at TEXT,
      shipped_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (wave_id) REFERENCES picking_waves(id)
    );

    -- Carton Lines (items in carton)
    CREATE TABLE IF NOT EXISTS carton_lines (
      id TEXT PRIMARY KEY,
      carton_id TEXT NOT NULL,
      order_line_id TEXT NOT NULL,
      line_number INTEGER,
      quantity INTEGER NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (carton_id) REFERENCES cartons(id),
      FOREIGN KEY (order_line_id) REFERENCES order_lines(id)
    );

    -- Returns
    CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      reason TEXT,
      status TEXT DEFAULT 'received',
      source TEXT DEFAULT 'platform',
      notes TEXT,
      inspection_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      inspected_at TEXT,
      disposed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    -- Return Items
    CREATE TABLE IF NOT EXISTS return_items (
      id TEXT PRIMARY KEY,
      return_id TEXT NOT NULL,
      order_line_id TEXT NOT NULL,
      return_qty INTEGER NOT NULL,
      condition TEXT DEFAULT 'unknown',
      inspection_notes TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      inspected_at TEXT,
      disposed_at TEXT,
      FOREIGN KEY (return_id) REFERENCES returns(id),
      FOREIGN KEY (order_line_id) REFERENCES order_lines(id)
    );

    -- Returns Disposal
    CREATE TABLE IF NOT EXISTS returns_disposal (
      id TEXT PRIMARY KEY,
      return_item_id TEXT NOT NULL,
      disposal_date TEXT DEFAULT (datetime('now')),
      method TEXT,
      notes TEXT,
      FOREIGN KEY (return_item_id) REFERENCES return_items(id)
    );

    -- Printed Labels
    CREATE TABLE IF NOT EXISTS printed_labels (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      carton_id TEXT,
      label_type TEXT,
      label_data TEXT,
      printed_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (carton_id) REFERENCES cartons(id)
    );

    -- Print Jobs
    CREATE TABLE IF NOT EXISTS print_jobs (
      id TEXT PRIMARY KEY,
      label_data TEXT,
      printer_type TEXT DEFAULT 'office',
      copies INTEGER DEFAULT 1,
      priority TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'queued',
      notes TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      printed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Scan-Based Pick-and-Pack Sessions
    CREATE TABLE IF NOT EXISTS scan_sessions (
      id TEXT PRIMARY KEY,
      wave_id TEXT,
      order_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      operator_id TEXT DEFAULT '',
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (wave_id) REFERENCES picking_waves(id)
    );

    -- Scan-Based Cartons (HU = Handling Unit)
    CREATE TABLE IF NOT EXISTS scan_cartons (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      hu_code TEXT NOT NULL,
      carton_seq INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      weight_kg REAL,
      length_cm REAL,
      width_cm REAL,
      height_cm REAL,
      notes TEXT,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      FOREIGN KEY (session_id) REFERENCES scan_sessions(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    -- Scan-Based Carton Items
    CREATE TABLE IF NOT EXISTS scan_carton_items (
      id TEXT PRIMARY KEY,
      carton_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      item_name TEXT DEFAULT '',
      qty REAL NOT NULL DEFAULT 1,
      lot_number TEXT,
      expiry_date TEXT,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (carton_id) REFERENCES scan_cartons(id),
      FOREIGN KEY (session_id) REFERENCES scan_sessions(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    -- PO Documents (Inbound B2B orders)
    CREATE TABLE IF NOT EXISTS po_documents (
      id TEXT PRIMARY KEY,
      po_number TEXT NOT NULL UNIQUE,
      po_date TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_name TEXT,
      order_type TEXT DEFAULT 'b2b',
      status TEXT DEFAULT 'received',
      validated_at TEXT,
      validation_errors TEXT,
      validation_notes TEXT,
      total_lines INTEGER DEFAULT 0,
      total_qty INTEGER DEFAULT 0,
      document_data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- PO Line Items (Extended order_lines for B2B)
    CREATE TABLE IF NOT EXISTS po_line_items (
      id TEXT PRIMARY KEY,
      po_id TEXT NOT NULL,
      sku_code TEXT NOT NULL,
      sku_name TEXT DEFAULT '',
      qty INTEGER NOT NULL DEFAULT 0,
      destination_store TEXT,
      serial_number TEXT,
      batch_number TEXT,
      expiry_date TEXT,
      length_cm REAL,
      width_cm REAL,
      height_cm REAL,
      weight_kg REAL,
      line_number INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (po_id) REFERENCES po_documents(id)
    );

    -- Staging Area (cartons hold for consolidation/verification)
    CREATE TABLE IF NOT EXISTS staging_area (
      id TEXT PRIMARY KEY,
      carton_id TEXT NOT NULL,
      po_id TEXT,
      order_id TEXT,
      status TEXT DEFAULT 'staged',
      destination_store TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT,
      quality_check_notes TEXT,
      FOREIGN KEY (carton_id) REFERENCES scan_cartons(id),
      FOREIGN KEY (po_id) REFERENCES po_documents(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    -- Client ML Model (Learning from uploads)
    CREATE TABLE IF NOT EXISTS client_ml_model (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_name TEXT,
      upload_count INTEGER DEFAULT 0,
      b2b_confirmed INTEGER DEFAULT 0,
      b2c_confirmed INTEGER DEFAULT 0,
      waybill_pattern REAL DEFAULT 0.0,
      manual_upload_pattern REAL DEFAULT 0.0,
      volume_pattern REAL DEFAULT 0.0,
      confidence REAL DEFAULT 0.5,
      detected_type TEXT,
      last_detection TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(client_id)
    );

    -- Order Type Detection Log (audit trail for learning)
    CREATE TABLE IF NOT EXISTS order_type_log (
      id TEXT PRIMARY KEY,
      po_id TEXT,
      order_id TEXT,
      upload_date TEXT NOT NULL,
      client_id TEXT,
      detected_type TEXT,
      user_confirmed_type TEXT,
      ml_confidence REAL,
      learned INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (po_id) REFERENCES po_documents(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    -- Inventory Batches (Multi-warehouse batch/lot tracking)
    CREATE TABLE IF NOT EXISTS inventory_batches (
      id TEXT PRIMARY KEY,
      warehouse_id TEXT NOT NULL,
      sku_id TEXT NOT NULL,
      batch_number TEXT NOT NULL,
      serial_number TEXT,
      expiry_date DATE,
      received_qty INTEGER NOT NULL,
      available_qty INTEGER DEFAULT 0,
      allocated_qty INTEGER DEFAULT 0,
      picked_qty INTEGER DEFAULT 0,
      damaged_qty INTEGER DEFAULT 0,
      scrap_qty INTEGER DEFAULT 0,
      received_at DATETIME NOT NULL,
      last_counted_at DATETIME,
      location_bin TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (sku_id) REFERENCES skus(id),
      UNIQUE(warehouse_id, sku_id, batch_number, serial_number)
    );

    -- Singapore Customs Lots (Immutable export tracking)
    CREATE TABLE IF NOT EXISTS customs_lots (
      id TEXT PRIMARY KEY,
      customs_lot_number TEXT NOT NULL UNIQUE,
      carton_id TEXT NOT NULL,
      po_id TEXT,
      order_id TEXT,
      hs_code TEXT,
      description TEXT,
      total_pieces INTEGER,
      gross_weight_kg REAL,
      assigned_at DATETIME NOT NULL,
      locked_at DATETIME,
      exported_at DATETIME,
      notes TEXT,
      created_at DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (carton_id) REFERENCES cartons(id),
      UNIQUE(carton_id)
    );

    -- Customs Lot Sequence (Running number generator)
    CREATE TABLE IF NOT EXISTS customs_lot_sequences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      prefix TEXT DEFAULT 'SG-CUST',
      year INTEGER DEFAULT 2026,
      current_number INTEGER DEFAULT 0,
      last_assigned_at DATETIME,
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );

    -- Cycle Count Batches
    CREATE TABLE IF NOT EXISTS cycle_count_batches (
      id TEXT PRIMARY KEY,
      warehouse_id TEXT NOT NULL,
      batch_count INTEGER DEFAULT 0,
      count_type TEXT DEFAULT 'full',
      status TEXT DEFAULT 'in_progress',
      counted_by TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      approved_by TEXT,
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    );

    -- Cycle Count Items
    CREATE TABLE IF NOT EXISTS cycle_count_items (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      batch_id_inventory TEXT,
      sku_id TEXT NOT NULL,
      location_bin TEXT,
      expected_qty INTEGER,
      counted_qty INTEGER,
      variance_qty INTEGER,
      status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      FOREIGN KEY (batch_id) REFERENCES cycle_count_batches(id)
    );

    -- Cycle Count Variances (Discrepancies requiring investigation)
    CREATE TABLE IF NOT EXISTS cycle_count_variances (
      id TEXT PRIMARY KEY,
      count_item_id TEXT NOT NULL,
      sku_id TEXT NOT NULL,
      location_bin TEXT,
      expected_qty INTEGER,
      counted_qty INTEGER,
      variance_qty INTEGER,
      variance_pct INTEGER,
      notes TEXT,
      status TEXT DEFAULT 'pending_investigation',
      resolved_at TEXT,
      resolution_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (count_item_id) REFERENCES cycle_count_items(id)
    );

    -- Replenishment Waves (Batches of replenishment tasks)
    CREATE TABLE IF NOT EXISTS replenishment_waves (
      id TEXT PRIMARY KEY,
      warehouse_id TEXT NOT NULL,
      task_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'planned',
      supervisor TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    );

    -- Replenishment Tasks (Individual stock moves from high-tier to pick face)
    CREATE TABLE IF NOT EXISTS replenishment_tasks (
      id TEXT PRIMARY KEY,
      wave_id TEXT NOT NULL,
      sku_id TEXT NOT NULL,
      source_batch_id TEXT,
      target_qty INTEGER,
      moved_qty INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 5,
      status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (wave_id) REFERENCES replenishment_waves(id),
      FOREIGN KEY (source_batch_id) REFERENCES inventory_batches(id)
    );

    -- Create default warehouse if not exists
    INSERT OR IGNORE INTO warehouses (id, name, location_city, location_state)
    VALUES ('wh-main', 'Main Warehouse', 'Singapore', 'SG');

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_inventory_balance_warehouse ON inventory_balance(warehouse_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_balance_sku ON inventory_balance(sku_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_movements_order ON inventory_movements(order_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_movements_return ON inventory_movements(return_id);
    CREATE INDEX IF NOT EXISTS idx_picking_waves_status ON picking_waves(status);
    CREATE INDEX IF NOT EXISTS idx_wave_orders_wave ON wave_orders(wave_id);
    CREATE INDEX IF NOT EXISTS idx_cartons_order ON cartons(order_id);
    CREATE INDEX IF NOT EXISTS idx_cartons_wave ON cartons(wave_id);
    CREATE INDEX IF NOT EXISTS idx_returns_order ON returns(order_id);
    CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_id);
    CREATE INDEX IF NOT EXISTS idx_po_documents_po ON po_documents(po_number);
    CREATE INDEX IF NOT EXISTS idx_po_documents_client ON po_documents(client_id);
    CREATE INDEX IF NOT EXISTS idx_po_documents_status ON po_documents(status);
    CREATE INDEX IF NOT EXISTS idx_po_line_items_po ON po_line_items(po_id);
    CREATE INDEX IF NOT EXISTS idx_staging_area_status ON staging_area(status);
    CREATE INDEX IF NOT EXISTS idx_staging_area_po ON staging_area(po_id);
    CREATE INDEX IF NOT EXISTS idx_client_ml_model_client ON client_ml_model(client_id);
    CREATE INDEX IF NOT EXISTS idx_order_type_log_client ON order_type_log(client_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_batches_warehouse ON inventory_batches(warehouse_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_batches_sku ON inventory_batches(sku_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_batches_expiry ON inventory_batches(expiry_date);
    CREATE INDEX IF NOT EXISTS idx_inventory_batches_received ON inventory_batches(received_at);
    CREATE INDEX IF NOT EXISTS idx_customs_lots_number ON customs_lots(customs_lot_number);
    CREATE INDEX IF NOT EXISTS idx_customs_lots_carton ON customs_lots(carton_id);
    CREATE INDEX IF NOT EXISTS idx_customs_lots_status ON customs_lots(locked_at, exported_at);
    CREATE INDEX IF NOT EXISTS idx_cycle_count_batch_warehouse ON cycle_count_batches(warehouse_id);
    CREATE INDEX IF NOT EXISTS idx_cycle_count_batch_status ON cycle_count_batches(status);
    CREATE INDEX IF NOT EXISTS idx_cycle_count_items_batch ON cycle_count_items(batch_id);
    CREATE INDEX IF NOT EXISTS idx_cycle_count_items_sku ON cycle_count_items(sku_id);
    CREATE INDEX IF NOT EXISTS idx_cycle_count_variances_status ON cycle_count_variances(status);
    CREATE INDEX IF NOT EXISTS idx_cycle_count_variances_sku ON cycle_count_variances(sku_id);
    CREATE INDEX IF NOT EXISTS idx_replenishment_waves_warehouse ON replenishment_waves(warehouse_id);
    CREATE INDEX IF NOT EXISTS idx_replenishment_waves_status ON replenishment_waves(status);
    CREATE INDEX IF NOT EXISTS idx_replenishment_tasks_wave ON replenishment_tasks(wave_id);
    CREATE INDEX IF NOT EXISTS idx_replenishment_tasks_status ON replenishment_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_replenishment_tasks_sku ON replenishment_tasks(sku_id);
  `);
};
