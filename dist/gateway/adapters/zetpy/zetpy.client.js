"use strict";
// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zetpy/
//
// Auth: POST /api/account/auth  { email, password } → { token, expires_in }
// Token: Bearer JWT, valid 3600 s (60 min); cached in-process to avoid re-auth on every call.
Object.defineProperty(exports, "__esModule", { value: true });
exports.zetpyClient = void 0;
const BASE_URL = 'https://api.zetpy.com';
// In-process cache keyed by email — avoids re-auth on every adapter call
const tokenCache = new Map();
async function getToken(email, password) {
    const cached = tokenCache.get(email);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
        return cached.token;
    }
    const res = await fetch(`${BASE_URL}/api/account/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw Object.assign(new Error(`Zetpy auth failed HTTP ${res.status}: ${text}`), { status: res.status === 401 ? 401 : 502 });
    }
    const data = await res.json();
    if (!data.success || !data.token) {
        throw Object.assign(new Error('Zetpy auth rejected — check email and password'), { status: 401 });
    }
    tokenCache.set(email, {
        token: data.token,
        expiresAt: Date.now() + data.expires_in * 1000,
    });
    return data.token;
}
async function request(creds, method, path, params, body) {
    const token = await getToken(creds.email, creds.password);
    let url = `${BASE_URL}${path}`;
    if (params && Object.keys(params).length) {
        url += `?${new URLSearchParams(params)}`;
    }
    const res = await fetch(url, {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
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
    // Expose for testing / token warm-up
    clearTokenCache: () => tokenCache.clear(),
};
//# sourceMappingURL=zetpy.client.js.map