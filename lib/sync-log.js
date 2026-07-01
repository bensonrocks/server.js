'use strict';

const db = require('./db');

const push = entry => {
  db.prepare(`
    INSERT INTO sync_log (platform, at, fetched, added, error)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    entry.platform,
    entry.at,
    entry.fetched ?? null,
    entry.added   ?? null,
    entry.error   ?? null,
  );
};

const recent = (n = 100) =>
  db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?').all(n)
    .map(r => ({
      platform: r.platform,
      at:       r.at,
      ...(r.fetched != null ? { fetched: r.fetched } : {}),
      ...(r.added   != null ? { added:   r.added   } : {}),
      ...(r.error             ? { error:   r.error   } : {}),
    }));

const clear = () => db.prepare('DELETE FROM sync_log').run();

module.exports = { push, recent, clear };
