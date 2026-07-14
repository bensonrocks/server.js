'use strict';

const crypto = require('crypto');
const db     = require('./db');

const COL = 'orgs';

// The owner org's predetermined lead attributes (self-use bypass): new
// tenant orgs fill these in themselves during onboarding.
const OWNER_WISHLIST = {
  market: 'Singapore',
  industries: 'Retail, furniture & home living, F&B, consumer goods, electronics, toys, e-commerce, industrial components',
  signals: 'Market entry; new store/showroom/office opening; physical product launch; distributor appointed; logistics/warehouse hiring; expansion funding; active 3PL search; import flows; bonded storage / bulky / white-glove needs',
  services: 'Warehousing; bonded zero-GST storage; customs coordination; retail & store distribution; e-commerce fulfilment; container transloading; white-glove & bulky delivery; B2B/B2C distribution; project cargo; cross-border freight; last-mile transport',
  leads_per_day: 12,
  notes: '',
  // Apollo-native buying signals (Apollo discovery mode).
  signal_hiring: true,          // company has active job postings
  signal_hiring_titles: '',     // optional: only these roles (comma-separated)
  signal_growing: false,        // headcount up >=10% in the last 6 months
  signal_funded: false,         // raised funding in the last 12 months
};

const EMPTY_WISHLIST = {
  market: '', industries: '', signals: '', services: '', leads_per_day: 10, notes: '',
  signal_hiring: false, signal_hiring_titles: '', signal_growing: false, signal_funded: false,
};

async function ensureOwnerSeed() {
  const orgs = await db.list(COL);
  let owner = orgs.find(o => o.is_owner);
  if (owner) return owner;
  owner = {
    id: crypto.randomUUID(),
    name: process.env.HUNTER_OWNER_ORG || 'United Logistics & Distribution (Singapore)',
    is_owner: true,
    setup_complete: true,      // owner bypasses onboarding
    wishlist: OWNER_WISHLIST,
    created_at: new Date().toISOString(),
  };
  await db.put(COL, owner.id, owner);
  return owner;
}

async function create(name) {
  const org = {
    id: crypto.randomUUID(),
    name: String(name || '').trim(),
    is_owner: false,
    setup_complete: false,     // tenant must fill the wishlist before the CRM runs
    wishlist: { ...EMPTY_WISHLIST },
    created_at: new Date().toISOString(),
  };
  await db.put(COL, org.id, org);
  return org;
}

async function findById(id) {
  return id ? db.get(COL, id) : null;
}

async function saveWishlist(id, wishlist) {
  const org = await findById(id);
  if (!org) return null;
  const leadsPerDay = Math.max(1, Math.min(50, parseInt(wishlist.leads_per_day, 10) || 10));
  const bool = v => v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
  org.wishlist = {
    market:     String(wishlist.market || '').trim(),
    industries: String(wishlist.industries || '').trim(),
    signals:    String(wishlist.signals || '').trim(),
    services:   String(wishlist.services || '').trim(),
    leads_per_day: leadsPerDay,
    notes:      String(wishlist.notes || '').trim(),
    signal_hiring:        bool(wishlist.signal_hiring),
    signal_hiring_titles: String(wishlist.signal_hiring_titles || '').trim(),
    signal_growing:       bool(wishlist.signal_growing),
    signal_funded:        bool(wishlist.signal_funded),
  };
  org.setup_complete = !!(org.wishlist.market && org.wishlist.industries && org.wishlist.services);
  await db.put(COL, id, org);
  return org;
}

// Tenant-facing view — never leaks owner/internal flags beyond what the UI needs.
function safe(o) {
  return o ? { id: o.id, name: o.name, is_owner: !!o.is_owner,
               setup_complete: !!o.setup_complete, wishlist: o.wishlist } : null;
}

module.exports = { ensureOwnerSeed, create, findById, saveWishlist, safe };
