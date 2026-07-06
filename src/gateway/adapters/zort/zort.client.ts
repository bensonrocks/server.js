// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zort/
//     Base URL: {{url}} in Postman collection — set via creds.baseUrl or default below.
//     Auth: headers storename / apikey / apisecret on every request.

const DEFAULT_BASE_URL = 'https://open.zortout.com';

export interface ZortCredentials {
  storename: string;
  apikey:    string;
  apisecret: string;
  baseUrl?:  string;
}

async function request<T>(
  creds: ZortCredentials,
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const base = (creds.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  let url = `${base}${path}`;
  if (params && Object.keys(params).length) {
    url += `?${new URLSearchParams(params)}`;
  }

  const res = await fetch(url, {
    method,
    headers: {
      storename:       creds.storename,
      apikey:          creds.apikey,
      apisecret:       creds.apisecret,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
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

  // Most ZORT POST mutations pass params in the query string, not the body.
  // Use postParams for those (body stays empty); use post for the few that need a JSON body.
  postParams: <T>(creds: ZortCredentials, path: string, params: Record<string, string>) =>
    request<T>(creds, 'POST', path, params, undefined),

  post: <T>(creds: ZortCredentials, path: string, body: unknown) =>
    request<T>(creds, 'POST', path, undefined, body),
};
