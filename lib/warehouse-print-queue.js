'use strict';

// Print dispatch queue, ported from IDEALPICK (branch
// claude/idealpick-subfunction-8kdzj1, lib/print-queue.js) onto the
// per-client warehouse schema — straight port, no legacy-schema dependency.

const crypto = require('crypto');

module.exports = function createPrintQueue(db) {
  function enqueue({ doc_type, ref_id, title, url }) {
    const existing = db.prepare("SELECT id FROM print_queue WHERE ref_id = ? AND doc_type = ? AND status = 'pending'").get(ref_id, doc_type);
    if (existing) return db.prepare('SELECT * FROM print_queue WHERE id = ?').get(existing.id);

    const id = `prt-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO print_queue (id, doc_type, ref_id, title, url) VALUES (?, ?, ?, ?, ?)').run(id, doc_type, ref_id, title, url);
    return db.prepare('SELECT * FROM print_queue WHERE id = ?').get(id);
  }

  function list({ status } = {}) {
    let sql = 'SELECT * FROM print_queue WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';
    return db.prepare(sql).all(...params);
  }

  function markPrinted(id) {
    db.prepare("UPDATE print_queue SET status='printed', printed_at=datetime('now') WHERE id=?").run(id);
    return db.prepare('SELECT * FROM print_queue WHERE id = ?').get(id);
  }

  function remove(id) {
    db.prepare('DELETE FROM print_queue WHERE id = ?').run(id);
    return { removed: true };
  }

  function pendingCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM print_queue WHERE status='pending'").get().n;
  }

  return { enqueue, list, markPrinted, remove, pendingCount };
};
