"use strict";
// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zort/
Object.defineProperty(exports, "__esModule", { value: true });
exports.zortClient = void 0;
const BASE_URL = 'https://open-api.zortout.com/v4';
async function request(creds, method, path, params, body) {
    let url = `${BASE_URL}${path}`;
    if (params && Object.keys(params).length) {
        url += `?${new URLSearchParams(params)}`;
    }
    const res = await fetch(url, {
        method,
        headers: {
            storename: creds.storename,
            apikey: creds.apikey,
            apisecret: creds.apisecret,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`ZORT ${method} ${path} → HTTP ${res.status}: ${text}`);
    }
    return res.json();
}
exports.zortClient = {
    get: (creds, path, params) => request(creds, 'GET', path, params),
    post: (creds, path, body) => request(creds, 'POST', path, undefined, body),
};
//# sourceMappingURL=zort.client.js.map