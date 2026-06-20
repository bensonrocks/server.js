const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');

(async () => {
  const me = await authApi.me();
  if (me) window.location.href = '/index.html';
})();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  try {
    await authApi.login(form.email.value, form.password.value);
    window.location.href = '/index.html';
  } catch (err) {
    errorEl.textContent = err.message;
  }
});
