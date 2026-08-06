'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  OneMap (Singapore Land Authority) — free, no-billing geocoding + routing.
//
//  WHY: the old distance engine mapped a postal code only to its 2-digit
//  district centroid (28 points for all of Singapore), so every Jurong address
//  (sectors 60–64 → one district) read as ~0 km apart. OneMap geocodes a real
//  6-digit postal code to a building-accurate lat/lng, and its routing service
//  returns actual ROAD distance + drive time — which is what a truck fleet
//  needs, not straight-line.
//
//  - Geocoding search is PUBLIC (no token).
//  - Routing needs a token (free registration → email+password → 3-day token).
//
//  Every call takes a `base` override (tests point it at a mock; production can
//  correct the host without a redeploy). Timeouts are short so a slow OneMap
//  never blocks a request — the caller falls back to the district estimate.
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_BASE = 'https://www.onemap.gov.sg';

// Geocode a 6-digit SG postal code → { lat, lng } (building-accurate), or null.
async function geocode(postal, { base } = {}) {
  const pc = String(postal || '').replace(/\D/g, '');
  if (pc.length !== 6) return null;
  const url = `${(base || SEARCH_BASE).replace(/\/+$/, '')}/api/common/elastic/search`
    + `?searchVal=${pc}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`OneMap search HTTP ${res.status}`);
  const d = await res.json();
  const hit = (d.results || []).find(r => String(r.POSTAL) === pc) || (d.results || [])[0];
  if (!hit || !hit.LATITUDE || !hit.LONGITUDE) return null;
  return { lat: Number(hit.LATITUDE), lng: Number(hit.LONGITUDE), address: hit.ADDRESS || '' };
}

// Get a routing token (valid ~3 days). Returns { access_token, expiry }.
async function getToken(email, password, { base } = {}) {
  const url = `${(base || SEARCH_BASE).replace(/\/+$/, '')}/api/auth/post/getToken`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`OneMap token HTTP ${res.status}`);
  const d = await res.json();
  if (!d.access_token) throw new Error(`OneMap token: ${d.error || 'no token returned'}`);
  return { access_token: d.access_token, expiry: Number(d.expiry_timestamp) || 0 };
}

// Road route between two { lat, lng } points → { distance_m, time_s }, or null.
async function route(start, end, token, { base, routeType } = {}) {
  if (!start || !end || !token) return null;
  const url = `${(base || SEARCH_BASE).replace(/\/+$/, '')}/api/public/routingsvc/route`
    + `?start=${start.lat},${start.lng}&end=${end.lat},${end.lng}`
    + `&routeType=${routeType || 'drive'}`;
  const res = await fetch(url, { headers: { Authorization: token }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`OneMap route HTTP ${res.status}`);
  const d = await res.json();
  const s = d.route_summary;
  if (!s || s.total_distance == null) return null;
  return { distance_m: Number(s.total_distance) || 0, time_s: Number(s.total_time) || 0 };
}

module.exports = { geocode, getToken, route };
