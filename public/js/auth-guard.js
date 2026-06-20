async function ensureAuth() {
  const me = await authApi.me();
  if (!me) {
    window.location.href = '/login.html';
    return null;
  }

  const bar = document.createElement('div');
  bar.style.display = 'flex';
  bar.style.alignItems = 'center';
  bar.style.gap = '1rem';

  const links = ['<a href="/index.html">All Clients</a>'];
  if (me.role === 'ADMIN') links.push('<a href="/users.html">Manage Users</a>');

  bar.innerHTML = `
    ${links.join('')}
    <span class="muted" style="color:#ccc">${me.name} (${me.role})</span>
    <button id="logout-btn" class="secondary" style="margin:0">Log Out</button>
  `;
  document.querySelector('header.brand').appendChild(bar);

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await authApi.logout();
    window.location.href = '/login.html';
  });

  return me;
}
