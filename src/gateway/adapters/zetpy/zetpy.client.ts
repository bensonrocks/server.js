// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zetpy/
//
// Auth: POST /api/account/auth  { email, password } → { token, expires_in }
// Token: Bearer JWT, valid 3600 s (60 min); cached in-process to avoid re-auth on every call.

import type { ZetpyAuthResponse } from './zetpy.types';

const BASE_URL = 'https://api.zetpy.com';

interface TokenEntry {
  token:     string;
  expiresAt: number;  // Date.now() ms
}

// In-process cache keyed by email — avoids re-auth on every adapter call
const tokenCache = new Map<string, TokenEntry>();

export interface ZetpyCredentials {
  email:    string;
  password: string;
}

async function getToken(email: string, password: string): Promise<string> {
  const cached = tokenCache.get(email);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const res = await fetch(`${BASE_URL}/api/account/auth`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw Object.assign(
      new Error(`Zetpy auth failed HTTP ${res.status}: ${text}`),
      { status: res.status === 401 ? 401 : 502 },
    );
  }

  const data = await res.json() as ZetpyAuthResponse;
  if (!data.success || !data.token) {
    throw Object.assign(
      new Error('Zetpy auth rejected — check email and password'),
      { status: 401 },
    );
  }

  tokenCache.set(email, {
    token:     data.token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });

  return data.token;
}

async function request<T>(
  creds: ZetpyCredentials,
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const token = await getToken(creds.email, creds.password);

  let url = `${BASE_URL}${path}`;
  if (params && Object.keys(params).length) {
    url += `?${new URLSearchParams(params)}`;
  }

  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Zetpy ${method} ${path} → HTTP ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export const zetpyClient = {
  get:  <T>(creds: ZetpyCredentials, path: string, params?: Record<string, string>) =>
    request<T>(creds, 'GET', path, params),

  post: <T>(creds: ZetpyCredentials, path: string, body: unknown) =>
    request<T>(creds, 'POST', path, undefined, body),

  // Expose for testing / token warm-up
  clearTokenCache: () => tokenCache.clear(),
};
