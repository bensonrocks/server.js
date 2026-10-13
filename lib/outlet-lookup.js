// OUTLET LOOKUP for B2B paperwork (system label, DO, carton label).
// B2B/GI orders often carry only an outlet code as the customer ("BUJ (050)").
// When the client has outletLookup on, the code is resolved in the Address Book
// (same index as the #65 order fill: code / name / chain+name, case-insensitive)
// and printed as "Chain – NAME (code)"; the book's address / postcode / phone
// fill ONLY blank fields. Display-only: the stored order is never modified.
const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
// "BUJ (050)" ⇄ "BUJ 050" — the same code written with or without brackets.
const bare = s => norm(String(s || '').replace(/[()]/g, ' '));

function findOutlet(idx, order) {
  if (!idx || !idx.size || !order) return null;
  const keys = [order.customer_name, order.ship_to_code].filter(k => String(k || '').trim());
  for (const k of keys) { const e = idx.get(norm(k)); if (e) return e; }
  // Bracket-insensitive code match as a fallback.
  const want = new Set(keys.map(bare));
  for (const e of new Set(idx.values())) if (e.code && want.has(bare(e.code))) return e;
  return null;
}

function outletDisplayName(e) {
  if (!e) return '';
  const name = String(e.name || '').trim(), chain = String(e.chain || '').trim();
  const code = bare(e.code);
  let s = [chain, name].filter(Boolean).join(' – ');
  if (code && code !== bare(name)) s = s ? `${s} (${code})` : code;
  return s;
}

function outletView(order, idx) {
  const e = findOutlet(idx, order);
  if (!e) return { order, matched: false };
  const o = { ...order, outlet_code: order.customer_name };
  const label = outletDisplayName(e);
  if (label) o.customer_name = label;
  const blank = v => !String(v == null ? '' : v).trim();
  if (blank(o.delivery_address) && String(e.address || '').trim()) o.delivery_address = String(e.address).trim();
  if (blank(o.tel) && String(e.phone || '').trim()) o.tel = String(e.phone).trim();
  if (blank(o.postal_code) && String(e.zip || '').trim()) o.postal_code = String(e.zip).trim();
  return { order: o, matched: true, entry: e };
}

module.exports = { findOutlet, outletDisplayName, outletView };
