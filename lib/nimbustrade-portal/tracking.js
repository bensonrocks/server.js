'use strict';

// Carrier tracking lookups via AfterShip (aftership.com) — chosen because it has
// a genuine free tier (no carrier account needed, ~50-100 trackings/month free
// as of writing) and covers DHL/FedEx/UPS/etc behind one API. Wholly optional:
// with no AFTERSHIP_API_KEY set, the app still works — it just shows our own
// internal fulfillment timeline (always real, since it's our own order data)
// without a live carrier status. Never fabricates carrier-branded tracking data.

const CARRIER_SLUGS = {
  DHL: 'dhl',
  FedEx: 'fedex',
  UPS: 'ups',
  'USPS': 'usps',
};

function carrierSlug(carrier) {
  return CARRIER_SLUGS[carrier] || String(carrier || '').toLowerCase();
}

async function fetchCarrierTracking(carrier, waybillNumber) {
  const apiKey = process.env.AFTERSHIP_API_KEY;
  if (!apiKey) return { available: false, reason: 'not_configured' };
  if (!carrier || !waybillNumber) return { available: false, reason: 'no_waybill' };

  const slug = carrierSlug(carrier);
  const base = `https://api.aftership.com/tracking/2024-04/trackings/${slug}/${encodeURIComponent(waybillNumber)}`;

  try {
    let res = await fetch(base, { headers: { 'as-api-key': apiKey } });

    if (res.status === 404) {
      // Not registered with AfterShip yet — create it, then fetch.
      await fetch('https://api.aftership.com/tracking/2024-04/trackings', {
        method: 'POST',
        headers: { 'as-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracking: { slug, tracking_number: waybillNumber } }),
      });
      res = await fetch(base, { headers: { 'as-api-key': apiKey } });
    }

    if (!res.ok) {
      return { available: false, reason: 'error', message: `AfterShip returned ${res.status}` };
    }

    const body = await res.json();
    const t = body && body.data && body.data.tracking;
    if (!t) return { available: false, reason: 'error', message: 'Unexpected response shape' };

    return {
      available: true,
      tag: t.tag,
      subtag: t.subtag_message || t.subtag,
      checkpoints: (t.checkpoints || []).map((c) => ({
        message: c.message,
        location: [c.city, c.state, c.country_iso3].filter(Boolean).join(', '),
        time: c.checkpoint_time,
      })),
    };
  } catch (e) {
    return { available: false, reason: 'error', message: e.message };
  }
}

module.exports = { fetchCarrierTracking, carrierSlug };
