'use strict';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.FREIGHT_TIMEOUT_MS || '12000', 10);

// fetch() with a hard timeout and JSON decoding. Throws an Error carrying
// `status` and `body` so provider code can log a useful upstream message.
async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, form = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const init = {
    method,
    headers: { Accept: 'application/json', ...headers },
    signal: controller.signal,
  };

  if (body !== undefined) {
    if (form) {
      init.body = new URLSearchParams(body).toString();
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`timeout after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* upstream returned non-JSON */ }

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    err.status = res.status;
    err.body   = json || text;
    throw err;
  }

  return json;
}

module.exports = { requestJson, DEFAULT_TIMEOUT_MS };
