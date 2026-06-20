async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    window.location.href = '/login.html';
    throw new Error('Not authenticated');
  }
  return res;
}

const api = {
  async listClients() {
    const res = await apiFetch('/api/clients');
    return res.json();
  },
  async createClient(data) {
    const res = await apiFetch('/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to create client');
    return res.json();
  },
  async getClient(id) {
    const res = await apiFetch(`/api/clients/${id}`);
    if (!res.ok) throw new Error('Client not found');
    return res.json();
  },
  async deleteClient(id) {
    const res = await apiFetch(`/api/clients/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete client');
  },
  async uploadFloorPlan(clientId, file) {
    const formData = new FormData();
    formData.append('floorPlan', file);
    const res = await apiFetch(`/api/clients/${clientId}/floorplan`, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok && res.status !== 207) throw new Error(data.error || 'Failed to upload floor plan');
    return data;
  },
  async createRoom(clientId, name) {
    const res = await apiFetch(`/api/clients/${clientId}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to create room');
    return res.json();
  },
  async deleteRoom(roomId) {
    const res = await apiFetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete room');
  },
  async addFurniture(roomId, formData) {
    const res = await apiFetch(`/api/rooms/${roomId}/furniture`, { method: 'POST', body: formData });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to add furniture');
    return res.json();
  },
  async deleteFurniture(id) {
    const res = await apiFetch(`/api/furniture/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete furniture');
  },
};

const authApi = {
  async login(email, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    return data;
  },
  async logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
  },
  async me() {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;
    return res.json();
  },
  async listUsers() {
    const res = await apiFetch('/api/auth/users');
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to load users');
    return res.json();
  },
  async createUser(data) {
    const res = await apiFetch('/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to create user');
    return res.json();
  },
  async deleteUser(id) {
    const res = await apiFetch(`/api/auth/users/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete user');
  },
};
