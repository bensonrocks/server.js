'use strict';

const crypto = require('crypto');

// Address → lat/lng via OpenStreetMap Nominatim (free, fair-use: 1 req/sec,
// identifying User-Agent). Results are cached forever on success; failures are
// cached for a day so a bad address doesn't hammer the API but can heal.
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'IdealOneOMS/1.0 (self-hosted delivery route planning)';
const FAIL_RETRY_MS = 24 * 60 * 60 * 1000;

module.exports = function createGeocoder(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS geocode_cache (
      qhash TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      lat   REAL,
      lng   REAL,
      ok    INTEGER NOT NULL DEFAULT 0,
      at    INTEGER NOT NULL
    );
  `);

  let lastCall = 0;

  async function geocode(address) {
    address = String(address || '').replace(/\s+/g, ' ').trim();
    if (!address) return null;
    const qhash = crypto.createHash('sha1').update(address.toLowerCase()).digest('hex');

    const hit = db.prepare('SELECT * FROM geocode_cache WHERE qhash = ?').get(qhash);
    if (hit) {
      if (hit.ok) return { lat: hit.lat, lng: hit.lng };
      if (Date.now() - hit.at < FAIL_RETRY_MS) return null;
      db.prepare('DELETE FROM geocode_cache WHERE qhash = ?').run(qhash);
    }

    // fair-use throttle: at most ~1 request/second across the process
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();

    let result = null;
    try {
      const r = await fetch(NOMINATIM + '?format=json&limit=1&q=' + encodeURIComponent(address), {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j) && j[0] && Number.isFinite(+j[0].lat) && Number.isFinite(+j[0].lon)) {
          result = { lat: +j[0].lat, lng: +j[0].lon };
        }
      }
    } catch (_) { /* offline / blocked / timeout — cached as failure below */ }

    db.prepare('INSERT OR REPLACE INTO geocode_cache (qhash, query, lat, lng, ok, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(qhash, address, result ? result.lat : null, result ? result.lng : null, result ? 1 : 0, Date.now());
    return result;
  }

  // Test/ops helper: pre-seed a known coordinate (also used to correct a bad lookup)
  function setManual(address, lat, lng) {
    address = String(address || '').replace(/\s+/g, ' ').trim();
    const qhash = crypto.createHash('sha1').update(address.toLowerCase()).digest('hex');
    db.prepare('INSERT OR REPLACE INTO geocode_cache (qhash, query, lat, lng, ok, at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(qhash, address, +lat, +lng, Date.now());
  }

  return { geocode, setManual };
};
