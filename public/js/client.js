const clientId = new URLSearchParams(window.location.search).get('id');
if (!clientId) {
  document.body.innerHTML = '<p style="padding:2rem">Missing client id. <a href="/index.html">Go back</a></p>';
}

const els = {
  name: document.getElementById('client-name'),
  meta: document.getElementById('client-meta'),
  floorplanPreview: document.getElementById('floorplan-preview'),
  floorplanInput: document.getElementById('floorplan-input'),
  floorplanUploadBtn: document.getElementById('floorplan-upload-btn'),
  floorplanStatus: document.getElementById('floorplan-status'),
  suggestedRooms: document.getElementById('suggested-rooms'),
  roomsContainer: document.getElementById('rooms-container'),
  addRoomForm: document.getElementById('add-room-form'),
  roomNameInput: document.getElementById('room-name'),
  grandTotal: document.getElementById('grand-total'),
  quotePdfLink: document.getElementById('quote-pdf-link'),
};

const furnitureFormTemplate = document.getElementById('furniture-form-template');

let client = null;

async function loadClient() {
  client = await api.getClient(clientId);
  render();
}

function render() {
  els.name.textContent = client.name;
  els.meta.textContent = [client.address, client.particulars].filter(Boolean).join(' · ');

  els.floorplanPreview.innerHTML = client.floorPlanUrl
    ? `<img src="${client.floorPlanUrl}" alt="Floor plan" />`
    : '<p class="muted">No floor plan uploaded yet.</p>';

  renderRooms();
  renderTotal();
  els.quotePdfLink.href = `/api/clients/${clientId}/quote.pdf`;
}

function renderRooms() {
  if (client.rooms.length === 0) {
    els.roomsContainer.innerHTML = '<p class="muted">No rooms yet. Add one below, or upload a floor plan.</p>';
    return;
  }

  els.roomsContainer.innerHTML = client.rooms
    .map(
      (room) => `
      <div class="room-block" data-room-id="${room.id}">
        <h3>${room.name}
          <button class="secondary add-furniture-toggle" data-room-id="${room.id}">+ Furniture</button>
          <button class="danger delete-room-btn" data-room-id="${room.id}">Delete Room</button>
        </h3>
        <div class="furniture-list">
          ${room.furniture
            .map(
              (f) => `
            <div class="furniture-item">
              ${f.imageUrl ? `<img src="${f.imageUrl}" alt="${f.name}" />` : '<div style="width:80px;height:80px;background:#eee;border-radius:5px"></div>'}
              <div class="details">
                <strong>${f.name}</strong><br/>
                ${f.material ? `<span class="muted">Material: ${f.material}</span><br/>` : ''}
                ${
                  f.widthCm && f.depthCm && f.heightCm
                    ? `<span class="muted">${f.widthCm} x ${f.depthCm} x ${f.heightCm} cm</span><br/>`
                    : ''
                }
                <span class="muted">Cost: ${f.costPrice} ${f.costCurrency} (rate ${f.exchangeRate.toFixed(4)})</span><br/>
                <span class="price">SGD ${f.sellingPriceSgd.toFixed(2)}</span>
              </div>
              <button class="danger delete-furniture-btn" data-furniture-id="${f.id}">Delete</button>
            </div>`
            )
            .join('')}
        </div>
        <div class="furniture-form-slot" data-room-id="${room.id}"></div>
      </div>`
    )
    .join('');

  els.roomsContainer.querySelectorAll('.add-furniture-toggle').forEach((btn) => {
    btn.addEventListener('click', () => toggleFurnitureForm(btn.dataset.roomId));
  });
  els.roomsContainer.querySelectorAll('.delete-room-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this room and its furniture?')) return;
      await api.deleteRoom(btn.dataset.roomId);
      await loadClient();
    });
  });
  els.roomsContainer.querySelectorAll('.delete-furniture-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this furniture item?')) return;
      await api.deleteFurniture(btn.dataset.furnitureId);
      await loadClient();
    });
  });
}

function renderTotal() {
  const total = client.rooms.reduce(
    (sum, room) => sum + room.furniture.reduce((s, f) => s + f.sellingPriceSgd, 0),
    0
  );
  els.grandTotal.textContent = `Grand Total: SGD ${total.toFixed(2)}`;
}

function toggleFurnitureForm(roomId) {
  const slot = els.roomsContainer.querySelector(`.furniture-form-slot[data-room-id="${roomId}"]`);
  if (slot.childElementCount > 0) {
    slot.innerHTML = '';
    return;
  }
  const form = furnitureFormTemplate.content.cloneNode(true).querySelector('form');
  slot.appendChild(form);

  form.querySelector('.cancel-btn').addEventListener('click', () => {
    slot.innerHTML = '';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = form.querySelector('.error');
    errorEl.textContent = '';
    const formData = new FormData(form);
    try {
      await api.addFurniture(roomId, formData);
      await loadClient();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

els.floorplanUploadBtn.addEventListener('click', async () => {
  const file = els.floorplanInput.files[0];
  if (!file) {
    els.floorplanStatus.textContent = 'Choose a file first.';
    return;
  }
  els.floorplanStatus.textContent = 'Uploading and analyzing with AI...';
  try {
    const result = await api.uploadFloorPlan(clientId, file);
    els.floorplanStatus.textContent = result.warning || 'Done. Suggested rooms below — click to add.';
    els.suggestedRooms.innerHTML = (result.suggestedRooms || [])
      .map((name) => `<span class="chip" data-name="${name}">${name}</span>`)
      .join('');
    els.suggestedRooms.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        await api.createRoom(clientId, chip.dataset.name);
        chip.remove();
        await loadClient();
      });
    });
    await loadClient();
  } catch (err) {
    els.floorplanStatus.textContent = err.message;
  }
});

els.addRoomForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = els.roomNameInput.value.trim();
  if (!name) return;
  await api.createRoom(clientId, name);
  els.roomNameInput.value = '';
  await loadClient();
});

(async () => {
  const user = await ensureAuth();
  if (user) loadClient();
})();
