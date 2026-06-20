const listEl = document.getElementById('user-list');
const form = document.getElementById('new-user-form');
const errorEl = document.getElementById('new-user-error');

async function renderUsers() {
  const users = await authApi.listUsers();
  listEl.innerHTML = users
    .map(
      (u) => `
      <div class="client-list-item">
        <span>${u.name} &mdash; ${u.email}<small>${u.role}</small></span>
        <button class="danger" data-id="${u.id}">Delete</button>
      </div>`
    )
    .join('');

  listEl.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this staff account?')) return;
      try {
        await authApi.deleteUser(btn.dataset.id);
        renderUsers();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  try {
    await authApi.createUser({
      name: form.name.value,
      email: form.email.value,
      password: form.password.value,
      role: form.role.value,
    });
    form.reset();
    renderUsers();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

(async () => {
  const user = await ensureAuth();
  if (!user) return;
  if (user.role !== 'ADMIN') {
    document.querySelector('main').innerHTML = '<p class="error">Admin access required.</p>';
    return;
  }
  renderUsers();
})();
