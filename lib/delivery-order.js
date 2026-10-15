// Delivery Order (DO) PDF — one order, printable by the office and the client
// portal: client name, DO number, date, ship-to/address, SKU lines, and a
// receiver signature box. Pure function of the order record (no db access).
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

function doNumber(order) {
  return 'DO-' + String(order.issue_no || order.order_number || '').replace(/[^A-Za-z0-9-]/g, '');
}

function sgDate(d) {
  const t = d ? new Date(d) : new Date();
  return new Date(t.getTime() + 8 * 3600e3).toISOString().slice(0, 10).split('-').reverse().join('/');
}

// Latin-1 only (StandardFonts): replace anything else so pdf-lib never throws.
const safe = s => String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D]/g, '?');

async function buildDeliveryOrderPdf({ order, clientName, jobCode = '', date, warehouse = 'IdealOne Fulfilment', signature = null }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]); // A4
  const M = 40, W = 595 - 2 * M;
  let y = 800;
  const text = (s, x, yy, o = {}) => page.drawText(safe(s), { x, y: yy, size: o.size || 10, font: o.bold ? bold : font, color: rgb(0, 0, 0) });
  const fit = (s, max, size = 10, f = font) => { s = safe(s); while (s && f.widthOfTextAtSize(s, size) > max) s = s.slice(0, -1); return s; };

  text('DELIVERY ORDER', M, y, { size: 20, bold: true });
  text(doNumber(order), 595 - M - bold.widthOfTextAtSize(safe(doNumber(order)), 12), y + 4, { size: 12, bold: true });
  y -= 18; text(warehouse, M, y, { size: 9 });
  y -= 26;
  const kv = [
    ['Client', clientName || order.client_name || '-'],
    ['Date', sgDate(date)],
    ['Order No.', order.order_number || '-'],
    ['GI / Issue No.', order.issue_no || '-'],
    ['PO No.', order.po_number || '-'],
    ['Job', jobCode || '-'],
    ['Delivery date', order.delivery_date || '-'],
    ['Contact', order.contact || '-'],
  ];
  kv.forEach(([k, v], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = M + col * (W / 2), yy = y - row * 15;
    text(k + ':', x, yy, { bold: true }); text(fit(v, W / 2 - 95), x + 90, yy);
  });
  y -= Math.ceil(kv.length / 2) * 15 + 10;
  // Ship-to box
  page.drawRectangle({ x: M, y: y - 62, width: W, height: 66, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  text('DELIVER TO', M + 8, y - 10, { bold: true, size: 9 });
  const addr = [order.delivery_address, order.postal_code && !String(order.delivery_address || '').includes(order.postal_code) ? `S(${order.postal_code})` : ''].filter(Boolean).join(' ');
  text(fit(order.customer_name || '-', W - 16, 12, bold), M + 8, y - 26, { size: 12, bold: true });
  text(fit(addr || 'Address not on file', W - 16), M + 8, y - 41);
  text(fit(order.tel ? `Tel: ${order.tel}` : '', W - 16), M + 8, y - 55);
  y -= 84;
  // Lines
  const cols = [M, M + 30, M + 150, M + W - 70];
  const header = () => {
    page.drawRectangle({ x: M, y: y - 4, width: W, height: 16, color: rgb(0.9, 0.9, 0.9) });
    text('#', cols[0] + 4, y, { bold: true }); text('SKU', cols[1], y, { bold: true });
    text('Description', cols[2], y, { bold: true }); text('Qty', cols[3], y, { bold: true });
    y -= 18;
  };
  header();
  const lines = (order.lines || []).filter(l => l && l.sku);
  let total = 0;
  lines.forEach((l, i) => {
    if (y < 150) { page = pdf.addPage([595, 842]); y = 800; header(); }
    const q = Number(l.qty) || 0; total += q;
    text(String(i + 1), cols[0] + 4, y); text(fit(l.sku, 115), cols[1], y);
    text(fit(l.description || '', cols[3] - cols[2] - 10), cols[2], y); text(String(q), cols[3], y);
    page.drawLine({ start: { x: M, y: y - 5 }, end: { x: M + W, y: y - 5 }, thickness: 0.3, color: rgb(0.7, 0.7, 0.7) });
    y -= 16;
  });
  y -= 4; text(`Total: ${lines.length} line(s), ${total} pcs`, cols[2], y, { bold: true });
  if (order.remarks) { y -= 18; text('Remarks:', M, y, { bold: true }); text(fit(order.remarks, W - 60), M + 55, y); }
  // Signatures
  const sy = Math.min(y - 30, 150);
  const box = (x, label) => {
    page.drawRectangle({ x, y: sy - 70, width: W / 2 - 10, height: 80, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
    text(label, x + 8, sy - 2, { bold: true, size: 9 });
    text('Name:', x + 8, sy - 30, { size: 9 }); text('Signature / Stamp:', x + 8, sy - 46, { size: 9 }); text('Date / Time:', x + 8, sy - 62, { size: 9 });
  };
  box(M, 'ISSUED BY (WAREHOUSE)'); box(M + W / 2 + 10, 'RECEIVED IN GOOD ORDER BY');
  // SIGNED DO: the receiver's on-phone signature, name and time stamped into
  // the 'Received in good order by' box (signature = { png, receiverName, signedAt }).
  if (signature && signature.override) {
    const bx = M + W / 2 + 10, bw = W / 2 - 10;
    page.drawRectangle({ x: bx + 4, y: sy - 68, width: bw - 8, height: 58, color: rgb(1, 1, 1) });
    text('NOT SIGNED', bx + 8, sy - 22, { bold: true, size: 10 });
    const words = safe(signature.override).replace(/^NOT SIGNED - /, '').split(' '); let line = '', ly = sy - 35;
    for (const w of words) { const t = line ? line + ' ' + w : w; if (font.widthOfTextAtSize(t, 8) > bw - 16 && line) { text(line, bx + 8, ly, { size: 8 }); ly -= 10; line = w; if (ly < sy - 66) break; } else line = t; }
    if (line && ly >= sy - 66) text(line, bx + 8, ly, { size: 8 });
  } else if (signature && signature.png) {
    const bx = M + W / 2 + 10, bw = W / 2 - 10;
    try {
      const simg = await pdf.embedPng(signature.png);
      const maxW = bw - 112, maxH = 30, sc = Math.min(maxW / simg.width, maxH / simg.height);
      page.drawImage(simg, { x: bx + 105, y: sy - 52, width: simg.width * sc, height: simg.height * sc });
    } catch (_) { /* a bad image never blocks the DO */ }
    text(fit(signature.receiverName || '', 60, 9), bx + 40, sy - 30, { size: 9 });
    const t = signature.signedAt ? new Date(new Date(signature.signedAt).getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '';
    if (t) text(`${t.slice(8, 10)}/${t.slice(5, 7)}/${t.slice(0, 4)} ${t.slice(11)} SGT`, bx + 70, sy - 62, { size: 9 });
    const tag = 'E-SIGNED ON DRIVER APP';
    page.drawText(tag, { x: bx + bw - 8 - font.widthOfTextAtSize(tag, 6.5), y: sy - 2, size: 6.5, font, color: rgb(0.35, 0.35, 0.35) });
  }
  // DELIVERY QR, bottom right under the signature box, away from any barcode:
  // 'IO-DLV:' + the system label barcode's value (waybill, else order no.).
  // The driver app closes deliveries from this QR only.
  const qrValue = String(order.waybill_number || '').trim() || String(order.order_number || '');
  if (qrValue) {
    try {
      const qpng = await require('bwip-js').toBuffer({ bcid: 'qrcode', text: require('./driver-scan').deliveryQrPayload(qrValue), scale: 4, eclevel: 'M', paddingwidth: 4, paddingheight: 4, backgroundcolor: 'FFFFFF' });
      const qimg = await pdf.embedPng(qpng);
      const qs = 58, qy = Math.max(14, Math.min(sy - 70 - 8 - qs, 14));
      page.drawImage(qimg, { x: 595 - M - qs, y: qy, width: qs, height: qs });
    } catch (_) { /* QR is an aid; the DO prints without it */ }
  }
  return Buffer.from(await pdf.save());
}

module.exports = { buildDeliveryOrderPdf, doNumber };
