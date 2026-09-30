'use strict';

// better-sqlite3 SQL used by the portal, rewritten for Postgres.
// Only the dialect this app actually emits: datetime('now') and ? placeholders.

const NOW_SQL = "to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')";

function translateSql(sql) {
  const withNow = String(sql).replace(/datetime\s*\(\s*'now'\s*\)/gi, NOW_SQL);
  let out = '';
  let n = 0;
  let inStr = false;
  for (let i = 0; i < withNow.length; i++) {
    const c = withNow[i];
    if (inStr) {
      out += c;
      if (c === "'") {
        if (withNow[i + 1] === "'") out += withNow[++i];
        else inStr = false;
      }
      continue;
    }
    if (c === "'") {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '?') {
      out += '$' + (++n);
      continue;
    }
    out += c;
  }
  return out;
}

function splitSql(sql) {
  const stmts = [];
  let cur = '';
  let inStr = false;
  const src = String(sql);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      cur += c;
      if (c === "'") {
        if (src[i + 1] === "'") cur += src[++i];
        else inStr = false;
      }
      continue;
    }
    if (c === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') i++;
      cur += '\n';
      continue;
    }
    if (c === "'") {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === ';') {
      const t = cur.trim();
      if (t) stmts.push(t);
      cur = '';
      continue;
    }
    cur += c;
  }
  const tail = cur.trim();
  if (tail) stmts.push(tail);
  return stmts;
}

module.exports = { translateSql, splitSql, NOW_SQL };
