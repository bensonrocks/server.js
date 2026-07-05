"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zetpyClient = void 0;
// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zetpy/
//
// TODO: confirm exact base URL (may be https://app.zetpy.com/api/v1)
const BASE_URL = 'https://api.zetpy.com/v1';
// TODO: confirm auth header name & format
function authHeaders(apiKey) {
    return {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
}
async function request(creds, method, path, params, body) {
    let url = `${BASE_URL}${path}`;
    if (params && Object.keys(params).length) {
        url += `?${new URLSearchParams(params)}`;
    }
    const res = await fetch(url, {
        method,
        headers: authHeaders(creds.apiKey),
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Zetpy ${method} ${path} → HTTP ${res.status}: ${text}`);
    }
    return res.json();
}
exports.zetpyClient = {
    get: (creds, path, params) => request(creds, 'GET', path, params),
    post: (creds, path, body) => request(creds, 'POST', path, undefined, body),
};
//# sourceMappingURL=zetpy.client.js.map