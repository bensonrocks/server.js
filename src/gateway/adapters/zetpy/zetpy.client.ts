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

  const body = await res.text().catch(() => '');
  let parsed: unknown = {};
  try { parsed = JSON.parse(body); } catch { /* keep empty */ }

  const asAuth = parsed as ZetpyAuthResponse;
  const asErr  = parsed as { error?: { code?: string; message?: string } };

  if (!res.ok || asAuth.success === false) {
    const code = asErr.error?.code ?? '';
    const msg  = asErr.error?.message ?? body;

    if (code === 'missing_permissions') {
      throw Object.assign(
        new Error(
          'Your Zetpy account does not have API access. ' +
          'Please contact Zetpy support or upgrade your plan to enable API access.',
        ),
        { status: 403 },
      );
    }

    throw Object.assign(
      new Error(msg || `Zetpy auth failed (HTTP ${res.status})`),
      { status: res.status === 401 ? 401 : 502 },
    );
  }

  if (!asAuth.token) {
    throw Object.assign(
      new Error('Zetpy auth returned no token — check email and password'),
      { status: 401 },
    );
  }

  const data = asAuth;

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
