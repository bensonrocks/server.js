'use strict';

const connectionsDb = require('./db/connections');

module.exports = function createCredentials(tenantId) {
  const getAll = () => {
    const result = {};
    for (const row of connectionsDb.prepare('SELECT platform, data FROM platform_credentials WHERE tenant_id = ?').all(tenantId)) {
      try { result[row.platform] = JSON.parse(row.data); } catch {}
    }
    return result;
  };

  const get = platform => {
    const row = connectionsDb.prepare('SELECT data FROM platform_credentials WHERE tenant_id = ? AND platform = ?').get(tenantId, platform);
    if (!row) return null;
    try { return JSON.parse(row.data); } catch { return null; }
  };

  const set = (platform, fields) => {
    const existing = get(platform) || {};
    const merged   = { ...existing, ...fields, updatedAt: new Date().toISOString() };
    connectionsDb.prepare(`
      INSERT INTO platform_credentials (tenant_id, platform, data)
      VALUES (?, ?, ?)
      ON CONFLICT(tenant_id, platform) DO UPDATE SET
        data       = excluded.data,
        updated_at = datetime('now')
    `).run(tenantId, platform, JSON.stringify(merged));
    return merged;
  };

  const remove = platform => {
    connectionsDb.prepare('DELETE FROM platform_credentials WHERE tenant_id = ? AND platform = ?').run(tenantId, platform);
  };

  return { getAll, get, set, remove };
};
