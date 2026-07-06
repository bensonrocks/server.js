"use strict";
// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zort/
//     Base URL: {{url}} in Postman collection — set via creds.baseUrl or default below.
//     Auth: headers storename / apikey / apisecret on every request.
Object.defineProperty(exports, "__esModule", { value: true });
exports.zortClient = void 0;
const DEFAULT_BASE_URL = 'https://open.zortout.com';
async function request(creds, method, path, params, body) {
    const base = (creds.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    let url = `${base}${path}`;
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
    // Most ZORT POST mutations pass params in the query string, not the body.
    // Use postParams for those (body stays empty); use post for the few that need a JSON body.
    postParams: (creds, path, params) => request(creds, 'POST', path, params, undefined),
    post: (creds, path, body) => request(creds, 'POST', path, undefined, body),
};
//# sourceMappingURL=zort.client.js.map