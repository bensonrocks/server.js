'use strict';

/**
 * Label Printer Service
 * Generates shipping labels, carton labels, and SKU barcodes
 */
module.exports = function createLabelPrinter(db) {

  const generateShippingLabel = async (orderId, options = {}) => {
    const { format = 'pdf', copies = 1 } = options;

    const order = db.prepare(`
      SELECT o.*, c.name as customer_name, c.phone, c.email
      FROM orders o
      LEFT JOIN clients c ON o.client_id = c.id
      WHERE o.id = ?
    `).get(orderId);

    if (!order) throw new Error('Order not found');

    const address = JSON.parse(order.delivery_address || '{}');
    const lines = db.prepare(`
      SELECT ol.*, s.name as sku_name, s.barcode
      FROM order_lines ol
      JOIN skus s ON ol.sku_id = s.id
      WHERE ol.order_id = ?
      ORDER BY ol.line_number
    `).all(orderId);

    // Generate barcode for order
    const orderBarcode = await generateBarcode(order.id, '128');

    const label = {
      type: 'shipping',
      orderId: order.id,
      orderNumber: order.order_number,
      customerName: order.customer_name || address.name,
      customerPhone: order.customer_phone || address.phone,
      customerEmail: order.customer_email || address.email,
      shippingAddress: {
        line1: address.line1 || address.address,
        line2: address.line2 || '',
        city: address.city || '',
        state: address.state || '',
        zip: address.zip || address.postal_code || '',
        country: address.country || '',
      },
      items: lines.map(l => ({
        sku: l.sku_code,
        name: l.sku_name,
        qty: l.ordered_qty,
        barcode: l.barcode,
      })),
      orderBarcode,
      generatedAt: new Date().toISOString(),
      copies,
    };

    // Store label
    db.prepare(`
      INSERT INTO printed_labels (order_id, label_type, label_data, printed_at)
      VALUES (?, 'shipping', ?, datetime('now'))
    `).run(orderId, JSON.stringify(label));

    return label;
  };

  const generateCartonLabel = async (cartonId, options = {}) => {
    const carton = db.prepare(`
      SELECT *FROM cartons WHERE id = ?
    `).get(cartonId);

    if (!carton) throw new Error('Carton not found');

    const lines = db.prepare(`
      SELECT cl.*, ol.sku_code, s.name as sku_name
      FROM carton_lines cl
      JOIN order_lines ol ON cl.order_line_id = ol.id
      JOIN skus s ON ol.sku_id = s.id
      WHERE cl.carton_id = ?
      ORDER BY cl.line_number
    `).all(cartonId);

    // Generate barcode for carton
    const cartonBarcode = await generateBarcode(carton.id, '128');

    const label = {
      type: 'carton',
      cartonId: carton.id,
      cartonBarcode,
      weight: carton.weight,
      dimensions: {
        length: carton.length,
        width: carton.width,
        height: carton.height,
      },
      items: lines.map((l, idx) => ({
        sequence: idx + 1,
        sku: l.sku_code,
        name: l.sku_name,
        qty: l.quantity,
      })),
      contents: lines.length + ' items',
      generatedAt: new Date().toISOString(),
    };

    // Store label
    db.prepare(`
      INSERT INTO printed_labels (carton_id, label_type, label_data, printed_at)
      VALUES (?, 'carton', ?, datetime('now'))
    `).run(cartonId, JSON.stringify(label));

    return label;
  };

  const generateSKULabel = async (skuId, quantity = 1) => {
    const sku = db.prepare('SELECT * FROM skus WHERE id = ?').get(skuId);
    if (!sku) throw new Error('SKU not found');

    const barcode = await generateBarcode(sku.barcode || sku.code, '128');

    return {
      type: 'sku',
      sku: sku.code,
      name: sku.name,
      barcode,
      quantity,
      generatedAt: new Date().toISOString(),
    };
  };

  const generateBarcode = async (data, format = '128') => {
    // Generate a simple SVG barcode representation
    // In production, integrate with a proper barcode library like 'bwip-js'
    const text = String(data);
    const barcodeHeight = 50;
    const textHeight = 20;
    const padding = 10;

    // Create simple visual barcode using vertical bars
    const barWidth = 2;
    const numBars = Math.min(text.length * 3, 80);
    const totalWidth = numBars * barWidth + padding * 2;

    let bars = '';
    for (let i = 0; i < numBars; i++) {
      const height = (Math.sin(i * Math.PI / numBars) + Math.cos(i * 0.5)) * 10 + 20;
      bars += `<rect x="${padding + i * barWidth}" y="${barcodeHeight - height}" width="${barWidth - 1}" height="${height}" fill="black"/>`;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${barcodeHeight + textHeight + padding}">
      <rect width="100%" height="100%" fill="white"/>
      ${bars}
      <text x="${totalWidth/2}" y="${barcodeHeight + textHeight}" text-anchor="middle" font-size="12" font-family="monospace">${text}</text>
    </svg>`;
  };

  const printLabel = async (labelData) => {
    // In production, this would send to an actual label printer
    // For now, return a JSON representation that can be rendered as HTML/PDF
    const printJob = {
      id: require('crypto').randomUUID(),
      labelData,
      status: 'queued',
      createdAt: new Date().toISOString(),
      printerDevice: 'default',
    };

    // Store print job
    db.prepare(`
      INSERT INTO print_jobs (id, label_data, status, created_at)
      VALUES (?, ?, 'queued', datetime('now'))
    `).run(printJob.id, JSON.stringify(labelData));

    return printJob;
  };

  const getPrintHistory = (filters = {}) => {
    const { orderId, limit = 50 } = filters;

    let sql = 'SELECT * FROM printed_labels WHERE 1=1';
    const params = [];

    if (orderId) {
      sql += ' AND order_id = ?';
      params.push(orderId);
    }

    sql += ' ORDER BY printed_at DESC LIMIT ?';
    params.push(limit);

    return db.prepare(sql).all(...params);
  };

  return {
    generateShippingLabel,
    generateCartonLabel,
    generateSKULabel,
    generateBarcode,
    printLabel,
    getPrintHistory,
  };
};
