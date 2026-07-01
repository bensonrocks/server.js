'use strict';

module.exports = function createCredentials(db) {
  const getAll = () => {
    const result = {};
    for (const row of db.prepare('SELECT platform, data FROM credentials').all()) {
      try { result[row.platform] = JSON.parse(row.data); } catch {}
    }
    return result;
  };

  const get = platform => {
    const row = db.prepare('SELECT data FROM credentials WHERE platform = ?').get(platform);
    if (!row) return null;
    try { return JSON.parse(row.data); } catch { return null; }
  };

  const set = (platform, fields) => {
    const existing = get(platform) || {};
    const merged   = { ...existing, ...fields, updatedAt: new Date().toISOString() };
    db.prepare(`
      INSERT INTO credentials (platform, data, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(platform) DO UPDATE SET
        data       = excluded.data,
        updated_at = excluded.updated_at
    `).run(platform, JSON.stringify(merged));
    return merged;
  };

  const remove = platform => {
    db.prepare('DELETE FROM credentials WHERE platform = ?').run(platform);
  };

  return { getAll, get, set, remove };
};
