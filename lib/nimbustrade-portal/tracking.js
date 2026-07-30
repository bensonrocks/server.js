'use strict';

// Carrier tracking lookups. Two providers supported, either one activated
// purely by which API key is present in the environment — no code change
// needed to switch. Both have genuine free tiers and need no carrier account.
// Wholly optional: with neither key set, the app still works fine — it just
// shows our own internal fulfillment timeline (always real, since it's our
// own order data) without a live carrier status. Never fabricates carrier
// tracking data — any unexpected response shape degrades to "unavailable"
// rather than showing something that looks live but isn't.

const CARRIER_SLUGS = {
  DHL: 'dhl',
  FedEx: 'fedex',
  UPS: 'ups',
  USPS: 'usps',
};

function carrierSlug(carrier) {
  return CARRIER_SLUGS[carrier] || String(carrier || '').toLowerCase();
}

async function fetchFromTrackingMore(carrier, waybillNumber) {
  const apiKey = process.env.TRACKINGMORE_API_KEY;
  const slug = carrierSlug(carrier);
  const headers = { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' };

  try {
    // Register the tracking first — TrackingMore returns 4029/"already exists"
    // if it's already registered, which we treat as fine, not fatal.
    await fetch('https://api.trackingmore.com/v4/trackings/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tracking_number: waybillNumber, courier_code: slug }),
    });

    const res = await fetch(
      `https://api.trackingmore.com/v4/trackings/${slug}/${encodeURIComponent(waybillNumber)}`,
      { headers }
    );
    if (!res.ok) return { available: false, reason: 'error', message: `TrackingMore returned ${res.status}` };

    const body = await res.json();
    const data = body && body.data;
    if (!data) return { available: false, reason: 'error', message: 'Unexpected response shape' };

    // Checkpoints live under a couple of different keys depending on API
    // version/carrier — take whichever is actually present.
    const checkpoints =
      (data.origin_info && data.origin_info.trackinfo) ||
      (data.destination_info && data.destination_info.trackinfo) ||
      data.trackinfo || data.track_info || [];

    return {
      available: true,
      tag: data.delivery_status || data.status,
      subtag: data.substatus || data.status_detail,
      checkpoints: checkpoints.map((c) => ({
        message: c.tracking_detail || c.checkpoint_delivery_status || c.status_description || c.message,
        location: c.location || [c.city, c.state, c.country].filter(Boolean).join(', '),
        time: c.checkpoint_date || c.date || c.time,
      })),
    };
  } catch (e) {
    return { available: false, reason: 'error', message: e.message };
  }
}

async function fetchFromAfterShip(carrier, waybillNumber) {
  const apiKey = process.env.AFTERSHIP_API_KEY;
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

    if (!res.ok) return { available: false, reason: 'error', message: `AfterShip returned ${res.status}` };

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

async function fetchCarrierTracking(carrier, waybillNumber) {
  if (!carrier || !waybillNumber) return { available: false, reason: 'no_waybill' };
  if (process.env.TRACKINGMORE_API_KEY) return fetchFromTrackingMore(carrier, waybillNumber);
  if (process.env.AFTERSHIP_API_KEY) return fetchFromAfterShip(carrier, waybillNumber);
  return { available: false, reason: 'not_configured' };
}

module.exports = { fetchCarrierTracking, carrierSlug };
