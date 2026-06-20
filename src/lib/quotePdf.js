const PDFDocument = require('pdfkit');

async function fetchImageBuffer(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

function formatSgd(amount) {
  return `SGD ${amount.toFixed(2)}`;
}

/**
 * Streams a picture quote PDF for a client to the given writable stream.
 * @param {{ name: string, address: string, particulars: string, rooms: Array<{name: string, furniture: Array}> }} client
 * @param {import('stream').Writable} outputStream
 */
async function generateQuotePdf(client, outputStream) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(outputStream);

  doc.fontSize(20).font('Helvetica-Bold').text('Louve Luxe', { align: 'center' });
  doc.fontSize(12).font('Helvetica').text('Furniture & Interior Quotation', { align: 'center' });
  doc.moveDown(1.5);

  doc.fontSize(11).font('Helvetica-Bold').text('Client: ', { continued: true }).font('Helvetica').text(client.name);
  if (client.address) {
    doc.font('Helvetica-Bold').text('Address: ', { continued: true }).font('Helvetica').text(client.address);
  }
  if (client.particulars) {
    doc.font('Helvetica-Bold').text('Particulars: ', { continued: true }).font('Helvetica').text(client.particulars);
  }
  doc.font('Helvetica-Bold').text('Date: ', { continued: true }).font('Helvetica').text(new Date().toLocaleDateString('en-SG'));
  doc.moveDown(1);

  let grandTotal = 0;

  for (const room of client.rooms) {
    if (room.furniture.length === 0) continue;

    if (doc.y > 650) doc.addPage();
    doc.moveDown(0.5);
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#1a1a1a').text(room.name);
    doc.moveTo(doc.x, doc.y + 2).lineTo(545, doc.y + 2).strokeColor('#cccccc').stroke();
    doc.moveDown(0.5);

    for (const item of room.furniture) {
      if (doc.y > 620) doc.addPage();

      const startY = doc.y;
      const imageBuffer = item.imageUrl ? await fetchImageBuffer(item.imageUrl) : null;

      if (imageBuffer) {
        try {
          doc.image(imageBuffer, 50, startY, { fit: [100, 100] });
        } catch {
          // unreadable image format, skip embedding
        }
      }

      const textX = 165;
      let y = startY;
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000').text(item.name, textX, y, { width: 380 });
      y = doc.y + 2;
      if (item.material) {
        doc.fontSize(10).font('Helvetica').fillColor('#444444').text(`Material: ${item.material}`, textX, y);
        y = doc.y + 2;
      }
      const dims = [item.widthCm, item.depthCm, item.heightCm].every((d) => d != null)
        ? `${item.widthCm} x ${item.depthCm} x ${item.heightCm} cm (W x D x H)`
        : null;
      if (dims) {
        doc.fontSize(10).font('Helvetica').fillColor('#444444').text(`Dimensions: ${dims}`, textX, y);
        y = doc.y + 2;
      }
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#0a5c36').text(formatSgd(item.sellingPriceSgd), textX, y);

      grandTotal += item.sellingPriceSgd;

      const rowBottom = Math.max(startY + 100, doc.y) + 12;
      doc.y = rowBottom;
      doc.x = 50;
    }
  }

  if (doc.y > 680) doc.addPage();
  doc.moveDown(1);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#000000').stroke();
  doc.moveDown(0.5);
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#000000').text(`Grand Total: ${formatSgd(grandTotal)}`, { align: 'right' });

  doc.end();
}

module.exports = { generateQuotePdf };
