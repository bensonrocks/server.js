// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zetpy/
//
// TODO: confirm exact base URL (may be https://app.zetpy.com/api/v1)
const BASE_URL = 'https://api.zetpy.com/v1';

export interface ZetpyCredentials {
  apiKey: string;
}

// TODO: confirm auth header name & format
function authHeaders(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
}

async function request<T>(
  creds: ZetpyCredentials,
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, string>,
  body?: unknown,
): Promise<T> {
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

  return res.json() as Promise<T>;
}

export const zetpyClient = {
  get:  <T>(creds: ZetpyCredentials, path: string, params?: Record<string, string>) =>
    request<T>(creds, 'GET', path, params),

  post: <T>(creds: ZetpyCredentials, path: string, body: unknown) =>
    request<T>(creds, 'POST', path, undefined, body),
};
