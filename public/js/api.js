const api = {
  async listClients() {
    const res = await fetch('/api/clients');
    return res.json();
  },
  async createClient(data) {
    const res = await fetch('/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to create client');
    return res.json();
  },
  async getClient(id) {
    const res = await fetch(`/api/clients/${id}`);
    if (!res.ok) throw new Error('Client not found');
    return res.json();
  },
  async deleteClient(id) {
    const res = await fetch(`/api/clients/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete client');
  },
  async uploadFloorPlan(clientId, file) {
    const formData = new FormData();
    formData.append('floorPlan', file);
    const res = await fetch(`/api/clients/${clientId}/floorplan`, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok && res.status !== 207) throw new Error(data.error || 'Failed to upload floor plan');
    return data;
  },
  async createRoom(clientId, name) {
    const res = await fetch(`/api/clients/${clientId}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to create room');
    return res.json();
  },
  async deleteRoom(roomId) {
    const res = await fetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete room');
  },
  async addFurniture(roomId, formData) {
    const res = await fetch(`/api/rooms/${roomId}/furniture`, { method: 'POST', body: formData });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to add furniture');
    return res.json();
  },
  async deleteFurniture(id) {
    const res = await fetch(`/api/furniture/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete furniture');
  },
};
