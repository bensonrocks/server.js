'use strict';

// ── Connector Registry ────────────────────────────────────────────────────────
// Auto-discovers every connector under lib/connectors/{type}/*.js
// and exposes them as a flat map keyed by connector meta.id.
//
// To add a new connector:
//   1. Create lib/connectors/{type}/{name}.js
//   2. Export { meta, ... } where meta.id is unique
//   3. Done — no changes to server.js needed
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const registry = {};
const base     = path.join(__dirname, 'connectors');

for (const typeName of fs.readdirSync(base)) {
  const typePath = path.join(base, typeName);
  if (!fs.statSync(typePath).isDirectory()) continue;

  for (const file of fs.readdirSync(typePath)) {
    if (!file.endsWith('.js')) continue;
    try {
      const connector = require(path.join(typePath, file));
      if (!connector?.meta?.id) {
        console.warn(`[registry] ${typeName}/${file} missing meta.id — skipped`);
        continue;
      }
      registry[connector.meta.id] = connector;
    } catch (err) {
      console.warn(`[registry] Failed to load ${typeName}/${file}:`, err.message);
    }
  }
}

module.exports = registry;
