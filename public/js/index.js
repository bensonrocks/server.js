const listEl = document.getElementById('client-list');
const form = document.getElementById('new-client-form');
const errorEl = document.getElementById('new-client-error');

async function renderClients() {
  const clients = await api.listClients();
  if (clients.length === 0) {
    listEl.innerHTML = '<p class="muted">No clients yet. Create one above.</p>';
    return;
  }
  listEl.innerHTML = clients
    .map(
      (c) => `
      <div class="client-list-item">
        <a href="/client.html?id=${c.id}">${c.name}<small>${c.address || ''}</small></a>
        <button class="danger" data-id="${c.id}">Delete</button>
      </div>`
    )
    .join('');

  listEl.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this client and all their rooms/furniture?')) return;
      await api.deleteClient(btn.dataset.id);
      renderClients();
    });
  });
}

(async () => {
  const user = await ensureAuth();
  if (user) renderClients();
})();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  const data = {
    name: form.name.value,
    address: form.address.value,
    particulars: form.particulars.value,
  };
  try {
    const client = await api.createClient(data);
    window.location.href = `/client.html?id=${client.id}`;
  } catch (err) {
    errorEl.textContent = err.message;
  }
});
