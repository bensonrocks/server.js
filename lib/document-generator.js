'use strict';

/**
 * Document Generator
 * Creates outbound documents: invoices, packing slips, shipping labels
 * Supports multiple formats: HTML, JSON, plain text
 */
module.exports = function createDocumentGenerator(db) {

  const generateInvoice = (poId, format = 'json') => {
    const po = db.prepare('SELECT * FROM po_documents WHERE id = ?').get(poId);
    if (!po) throw new Error('PO not found');

    const lineItems = db.prepare(`
      SELECT * FROM po_line_items WHERE po_id = ? ORDER BY line_number
    `).all(poId);

    const totalQty = lineItems.reduce((s, l) => s + (l.qty || 0), 0);
    const invoiceDate = new Date().toISOString().split('T')[0];
    const invoiceNumber = `INV-${po.po_number}-${invoiceDate.replace(/-/g, '')}`;

    const invoice = {
      invoiceNumber,
      invoiceDate,
      poNumber: po.po_number,
      poDate: po.po_date,
      clientId: po.client_id,
      clientName: po.client_name,
      totalLines: lineItems.length,
      totalQuantity: totalQty,
      lineItems: lineItems.map((item, idx) => ({
        line: idx + 1,
        sku: item.sku_code,
        description: item.sku_name,
        quantity: item.qty,
        destination: item.destination_store,
        batchNumber: item.batch_number || '-',
        expiryDate: item.expiry_date || '-',
      })),
      generatedAt: new Date().toISOString(),
    };

    if (format === 'html') {
      return generateInvoiceHTML(invoice);
    } else if (format === 'csv') {
      return generateInvoiceCSV(invoice);
    }
    return invoice; // JSON
  };

  const generateInvoiceHTML = (invoice) => {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Invoice ${invoice.invoiceNumber}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; color: #333; }
    .header { border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
    .header h1 { margin: 0; font-size: 24px; }
    .header p { margin: 5px 0; font-size: 12px; }
    .details { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
    .details div { font-size: 13px; }
    .details strong { display: block; font-size: 12px; color: #666; margin-bottom: 3px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    table th { background: #f0f0f0; padding: 10px; text-align: left; font-size: 12px; font-weight: bold; border-bottom: 1px solid #ddd; }
    table td { padding: 8px; border-bottom: 1px solid #eee; font-size: 13px; }
    table tr:nth-child(even) { background: #fafafa; }
    .summary { text-align: right; margin-top: 20px; font-size: 13px; }
    .footer { margin-top: 30px; padding-top: 10px; border-top: 1px solid #ddd; font-size: 11px; color: #666; }
  </style>
</head>
<body>
  <div class="header">
    <h1>INVOICE</h1>
    <p>Invoice #: <strong>${invoice.invoiceNumber}</strong></p>
    <p>Date: ${invoice.invoiceDate}</p>
  </div>

  <div class="details">
    <div>
      <strong>Bill To:</strong>
      ${invoice.clientName}<br>
      PO: ${invoice.poNumber}<br>
      Date: ${invoice.poDate}
    </div>
    <div>
      <strong>Summary:</strong>
      ${invoice.lineItems.length} line items<br>
      Total Quantity: ${invoice.totalQuantity} units
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Line</th>
        <th>SKU</th>
        <th>Description</th>
        <th>Qty</th>
        <th>Destination</th>
        <th>Batch #</th>
        <th>Expiry</th>
      </tr>
    </thead>
    <tbody>
      ${invoice.lineItems.map(item => `
        <tr>
          <td>${item.line}</td>
          <td>${item.sku}</td>
          <td>${item.description}</td>
          <td style="text-align:center">${item.quantity}</td>
          <td>${item.destination}</td>
          <td>${item.batchNumber}</td>
          <td>${item.expiryDate}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <div class="summary">
    <div>Total Items: <strong>${invoice.totalQuantity}</strong></div>
  </div>

  <div class="footer">
    <p>Generated: ${invoice.generatedAt}</p>
    <p>This is an automated document. No signature required.</p>
  </div>
</body>
</html>`;
  };

  const generateInvoiceCSV = (invoice) => {
    const rows = [
      ['INVOICE', invoice.invoiceNumber],
      ['Date', invoice.invoiceDate],
      ['PO Number', invoice.poNumber],
      ['Client', invoice.clientName],
      [''],
      ['Line', 'SKU', 'Description', 'Qty', 'Destination', 'Batch', 'Expiry'],
    ];

    invoice.lineItems.forEach(item => {
      rows.push([
        item.line,
        item.sku,
        item.description,
        item.quantity,
        item.destination,
        item.batchNumber,
        item.expiryDate,
      ]);
    });

    return rows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
  };

  const generatePackingSlip = (poId, format = 'json') => {
    const po = db.prepare('SELECT * FROM po_documents WHERE id = ?').get(poId);
    if (!po) throw new Error('PO not found');

    const orders = db.prepare(`
      SELECT * FROM orders WHERE po_number = ? ORDER BY id
    `).all(po.po_number);

    const cartons = [];
    orders.forEach(order => {
      const orderCartons = db.prepare(`
        SELECT sc.* FROM scan_cartons sc
        WHERE sc.order_id = ?
        ORDER BY sc.carton_seq
      `).all(order.id);

      orderCartons.forEach(carton => {
        const items = db.prepare(`
          SELECT * FROM scan_carton_items WHERE carton_id = ?
        `).all(carton.id);

        cartons.push({
          carton_id: carton.id,
          hu_code: carton.hu_code,
          sequence: carton.carton_seq,
          destination_store: order.notes, // Embedded from order notes
          status: carton.status,
          weight_kg: carton.weight_kg,
          items: items.map((item, idx) => ({
            line: idx + 1,
            sku: item.sku,
            description: item.item_name,
            quantity: item.qty,
            batch: item.lot_number || '-',
            expiry: item.expiry_date || '-',
          })),
        });
      });
    });

    const slip = {
      poNumber: po.po_number,
      poDate: po.po_date,
      clientName: po.clientName,
      totalCartons: cartons.length,
      totalItems: cartons.reduce((s, c) => s + c.items.length, 0),
      cartons,
      generatedAt: new Date().toISOString(),
    };

    if (format === 'html') {
      return generatePackingSlipHTML(slip);
    }
    return slip; // JSON
  };

  const generatePackingSlipHTML = (slip) => {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Packing Slip ${slip.poNumber}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; color: #333; }
    .header { border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
    .header h1 { margin: 0; font-size: 24px; }
    .carton { page-break-inside: avoid; border: 1px solid #ddd; padding: 15px; margin-bottom: 15px; }
    .carton-header { background: #f0f0f0; padding: 10px; margin: -15px -15px 10px -15px; font-weight: bold; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    table th { background: #f9f9f9; padding: 6px; text-align: left; border-bottom: 1px solid #ddd; font-size: 11px; }
    table td { padding: 4px; border-bottom: 1px solid #eee; }
    .footer { margin-top: 30px; padding-top: 10px; border-top: 1px solid #ddd; font-size: 11px; color: #666; }
  </style>
</head>
<body>
  <div class="header">
    <h1>PACKING SLIP</h1>
    <p>PO: ${slip.poNumber} | Client: ${slip.clientName}</p>
    <p>Total: ${slip.totalCartons} cartons | ${slip.totalItems} items</p>
  </div>

  ${slip.cartons.map((carton, idx) => `
    <div class="carton">
      <div class="carton-header">
        Carton ${carton.sequence} of ${slip.totalCartons} | HU: ${carton.hu_code} | ${carton.destination_store}
      </div>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>SKU</th>
            <th>Qty</th>
            <th>Batch</th>
            <th>Expiry</th>
          </tr>
        </thead>
        <tbody>
          ${carton.items.map(item => `
            <tr>
              <td>${item.description}</td>
              <td>${item.sku}</td>
              <td style="text-align:center">${item.quantity}</td>
              <td>${item.batch}</td>
              <td>${item.expiry}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `).join('')}

  <div class="footer">
    <p>Generated: ${slip.generatedAt}</p>
    <p>Please verify all items before shipment.</p>
  </div>
</body>
</html>`;
  };

  const generateShippingLabel = (cartonId) => {
    const carton = db.prepare('SELECT * FROM scan_cartons WHERE id = ?').get(cartonId);
    if (!carton) throw new Error('Carton not found');

    const items = db.prepare(`
      SELECT * FROM scan_carton_items WHERE carton_id = ?
    `).all(cartonId);

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(carton.order_id);

    return {
      cartonId,
      huCode: carton.hu_code,
      orderId: carton.order_id,
      clientName: order.client_name,
      destination: order.notes || 'Standard',
      itemCount: items.length,
      weight: carton.weight_kg || 'N/A',
      dimensions: carton.length_cm && carton.width_cm && carton.height_cm
        ? `${carton.length_cm}L × ${carton.width_cm}W × ${carton.height_cm}H cm`
        : 'Not specified',
      items: items.map(i => `${i.sku} (${i.qty})`).join(' | '),
      barcode: carton.hu_code, // Can be rendered as actual barcode
      generatedAt: new Date().toISOString(),
    };
  };

  return {
    generateInvoice,
    generatePackingSlip,
    generateShippingLabel,
  };
};
