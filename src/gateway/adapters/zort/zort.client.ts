// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zort/

const BASE_URL = 'https://open-api.zortout.com/v4';

export interface ZortCredentials {
  storename: string;
  apikey:    string;
  apisecret: string;
}

async function request<T>(
  creds: ZortCredentials,
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
    headers: {
      storename:        creds.storename,
      apikey:           creds.apikey,
      apisecret:        creds.apisecret,
      'Content-Type':   'application/json',
      'Accept':         'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`ZORT ${method} ${path} → HTTP ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export const zortClient = {
  get:  <T>(creds: ZortCredentials, path: string, params?: Record<string, string>) =>
    request<T>(creds, 'GET', path, params),

  post: <T>(creds: ZortCredentials, path: string, body: unknown) =>
    request<T>(creds, 'POST', path, undefined, body),
};
