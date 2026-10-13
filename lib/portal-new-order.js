// Client-keyed orders from the portal "New Order" form.
// Order number: CLIENTNAME-YYYYMMDD-NNN (SGT day, sequence per client per day).
function sgDay(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
}
function clientPrefix(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 20) || 'CLIENT';
}
function makeOrderNumber(clientName, day, seq) {
  return `${clientPrefix(clientName)}-${day}-${String(seq).padStart(3, '0')}`;
}
// Mints the next free number. `taken(n)` reports clashes with any existing
// order/submission; the per-day counter lives in db.portalOrderSeq.
function nextPortalOrderNumber(db, clientName, taken = () => false, now = new Date()) {
  const day = sgDay(now);
  const key = `${clientPrefix(clientName)}|${day}`;
  db.portalOrderSeq = db.portalOrderSeq || {};
  for (const k of Object.keys(db.portalOrderSeq)) if (!k.endsWith('|' + day)) delete db.portalOrderSeq[k];
  let seq = db.portalOrderSeq[key] || 0, n;
  do { seq++; n = makeOrderNumber(clientName, day, seq); } while (taken(n) && seq < 9999);
  db.portalOrderSeq[key] = seq;
  return n;
}
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
// Validates the form against the client's OWN item master (Map sku → item).
function validateNewOrder(body, items) {
  const b = body || {};
  const errors = [];
  const o = {
    ship_to_name: clip(b.ship_to_name, 120), address: clip(b.address, 300), postal: clip(b.postal, 12),
    phone: clip(b.phone, 40), contact: clip(b.contact, 80), delivery_date: clip(b.delivery_date, 10),
    remarks: clip(b.remarks, 500), lines: [],
  };
  if (!o.ship_to_name) errors.push('Ship-to name is required.');
  if (!o.address) errors.push('Delivery address is required.');
  if (o.postal && !/^\d{6}$/.test(o.postal)) errors.push('Postal code must be 6 digits.');
  if (o.delivery_date && !/^\d{4}-\d{2}-\d{2}$/.test(o.delivery_date)) errors.push('Delivery date must be YYYY-MM-DD.');
  const merged = new Map();
  for (const l of Array.isArray(b.lines) ? b.lines : []) {
    const sku = clip(l && l.sku, 60); const qty = Math.floor(Number(l && l.qty));
    if (!sku) continue;
    const it = items.get(sku) || items.get(sku.toUpperCase());
    if (!it) { errors.push(`SKU ${sku} is not in your item master.`); continue; }
    if (!(qty > 0) || qty > 100000) { errors.push(`Quantity for ${sku} must be a whole number above 0.`); continue; }
    const cur = merged.get(it.sku) || { sku: it.sku, description: it.name || '', qty: 0 };
    cur.qty += qty; merged.set(it.sku, cur);
  }
  o.lines = [...merged.values()];
  if (!o.lines.length) errors.push('Add at least one item line.');
  if (o.lines.length > 200) errors.push('At most 200 lines per order.');
  return { order: o, errors };
}
module.exports = { sgDay, clientPrefix, makeOrderNumber, nextPortalOrderNumber, validateNewOrder };
