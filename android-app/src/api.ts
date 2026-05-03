import AsyncStorage from '@react-native-async-storage/async-storage';
import { Order, Stats, Client, Channel } from './types';

// 10.0.2.2 is Android emulator's alias for host localhost
const DEFAULT_URL = 'http://10.0.2.2:3000';
const STORAGE_KEY = '@server_url';

let baseUrl = DEFAULT_URL;

export async function initBaseUrl(): Promise<void> {
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    if (saved) baseUrl = saved;
  } catch {}
}

export async function saveBaseUrl(url: string): Promise<void> {
  baseUrl = url;
  await AsyncStorage.setItem(STORAGE_KEY, url);
}

export function getBaseUrl(): string {
  return baseUrl;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(baseUrl + path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const json = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error((json as any).error || `Request failed: ${res.status}`);
  return json as T;
}

function buildQuery(params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return q ? '?' + q : '';
}

export const api = {
  getOrders: (params: Record<string, string> = {}) =>
    request<Order[]>('/api/orders' + buildQuery(params)),

  getOrder: (id: string) =>
    request<Order>(`/api/orders/${id}`),

  getStats: () =>
    request<Stats>('/api/stats'),

  getClients: () =>
    request<Client[]>('/api/clients'),

  getChannels: () =>
    request<Channel[]>('/api/channels'),

  ingestEmail: (data: { body: string; subject: string; from: string }) =>
    request<Order>('/api/orders/ingest-email', { method: 'POST', body: JSON.stringify(data) }),
};
