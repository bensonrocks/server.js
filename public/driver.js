// ── IDEALONE Driver App ──────────────────────────────────────────────────────
// Talks only to /api/driver/* — a driver session is a real token issued by
// the same activeSessions mechanism as every other login (namespaced
// 'driver:<id>' server-side), so nothing here is a parallel auth system.
(() => {
  'use strict';

  const LS_TOKEN = 'driver_token';
  const LS_DRIVER = 'driver_info';
  let driverToken = localStorage.getItem(LS_TOKEN) || '';
  let driverInfo = JSON.parse(localStorage.getItem(LS_DRIVER) || 'null');
  let jobs = [];
  let activeJobId = null;
  let refreshTimer = null;
  let pinBuf = '';

  const $ = id => document.getElementById(id);

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  async function api(path, opts = {}) {
    const resp = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'x-auth-token': driverToken, ...(opts.headers || {}) },
    });
    let data = {};
    try { data = await resp.json(); } catch {}
    if (resp.status === 401) { doLogout(false); throw new Error(data.error || 'Session expired'); }
    if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
    return data;
  }

  // ── Login screen ──────────────────────────────────────────────────────────
  function renderPin() {
    $('pinDisplay').textContent = pinBuf.padEnd(4, '•').split('').map((c, i) => i < pinBuf.length ? '●' : '•').join('');
    $('loginBtn').disabled = !($('driverIdInput').value.trim() && pinBuf.length >= 4);
  }
  document.querySelectorAll('.pin-key[data-k]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (pinBuf.length < 8) pinBuf += btn.dataset.k;
      renderPin();
    });
  });
  $('pinClearBtn').addEventListener('click', () => { pinBuf = ''; renderPin(); });
  $('pinDelBtn').addEventListener('click', () => { pinBuf = pinBuf.slice(0, -1); renderPin(); });
  $('driverIdInput').addEventListener('input', renderPin);

  $('loginBtn').addEventListener('click', async () => {
    const id = $('driverIdInput').value.trim();
    $('loginError').textContent = '';
    $('loginBtn').disabled = true;
    $('loginBtn').textContent = 'Signing in…';
    try {
      const resp = await fetch('/api/driver/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, pin: pinBuf }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Login failed');
      driverToken = data.token;
      driverInfo = data.driver;
      localStorage.setItem(LS_TOKEN, driverToken);
      localStorage.setItem(LS_DRIVER, JSON.stringify(driverInfo));
      pinBuf = '';
      showApp();
    } catch (err) {
      $('loginError').textContent = err.message;
      pinBuf = '';
      renderPin();
    } finally {
      $('loginBtn').textContent = 'Sign In';
      $('loginBtn').disabled = false;
    }
  });

  function showLogin() {
    $('loginWrap').classList.remove('hidden');
    $('app').classList.remove('shown');
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    $('driverIdInput').value = '';
    pinBuf = '';
    renderPin();
  }

  function showApp() {
    $('loginWrap').classList.add('hidden');
    $('app').classList.add('shown');
    $('hdrName').textContent = driverInfo?.name || driverInfo?.id || 'Driver';
    $('hdrSub').textContent = [driverInfo?.vehicle, driverInfo?.plate].filter(Boolean).join(' · ') || '';
    loadJobs();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(loadJobs, 30000);
  }

  async function doLogout(callServer = true) {
    if (callServer && driverToken) {
      try { await fetch('/api/driver/logout', { method: 'POST', headers: { 'x-auth-token': driverToken } }); } catch {}
    }
    driverToken = ''; driverInfo = null;
    localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_DRIVER);
    showLogin();
  }
  $('logoutBtn').addEventListener('click', () => { if (confirm('Log out?')) doLogout(); });

  // ── Job list ─────────────────────────────────────────────────────────────
  async function loadJobs() {
    try {
      const data = await api('/api/driver/jobs');
      jobs = data.jobs || [];
      renderList();
      $('lastRefreshed').textContent = 'Updated ' + new Date().toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
      if (driverToken) toast('⚠ ' + err.message);
    }
  }
  $('refreshBtn').addEventListener('click', loadJobs);

  function renderList() {
    const active = jobs.filter(j => j.status !== 'delivered');
    const done = jobs.filter(j => j.status === 'delivered');
    $('statRemaining').textContent = active.filter(j => j.status !== 'in-transit').length;
    $('statOnRoad').textContent = active.filter(j => j.status === 'in-transit').length;
    $('statDone').textContent = done.length;

    const listEl = $('jobsList');
    if (!jobs.length) {
      listEl.innerHTML = '<div class="empty-state">No deliveries assigned right now.<br>Pull to refresh or check back later.</div>';
      return;
    }
    const cardHtml = j => `
      <div class="job-card" style="border-left-color:${j.statusColor}" data-id="${esc(j.id)}">
        <div class="job-top">
          <div>
            <div class="job-seq">${j.routeNum != null ? 'Stop ' + j.stopSeq + ' · Route ' + j.routeNum : j.id}</div>
            <div class="job-client">${esc(j.client || '(no client name)')}</div>
          </div>
          <span class="job-pill" style="background:${j.statusColor}">${esc(j.statusLabel)}</span>
        </div>
        <div class="job-addr">${esc(j.address || 'No address on file')}${j.zip ? ' · ' + esc(j.zip) : ''}</div>
        <div class="job-meta">
          <span>📦 ${j.packages} carton${j.packages === 1 ? '' : 's'}</span>
          ${j.referenceId ? `<span>PO ${esc(j.referenceId)}</span>` : ''}
        </div>
      </div>`;
    listEl.innerHTML = [...active, ...done].map(cardHtml).join('');
    listEl.querySelectorAll('.job-card').forEach(el => el.addEventListener('click', () => openSheet(el.dataset.id)));
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ── Job detail sheet ─────────────────────────────────────────────────────
  function openSheet(id) {
    const j = jobs.find(x => x.id === id);
    if (!j) return;
    activeJobId = id;
    $('sheetClient').textContent = j.client || '(no client name)';
    $('sheetId').textContent = j.id + (j.routeNum != null ? ` · Route ${j.routeNum}, Stop ${j.stopSeq}` : '');
    $('sheetAddress').textContent = j.address || '—';
    $('sheetZip').textContent = j.zip || '—';
    $('sheetRef').textContent = j.referenceId || '—';
    $('sheetPackages').textContent = j.packages;

    const navQuery = encodeURIComponent([j.address, j.zip, 'Singapore'].filter(Boolean).join(', '));
    $('sheetNavLink').href = `https://www.google.com/maps/search/?api=1&query=${navQuery}`;

    const callLink = $('sheetCallLink');
    if (j.phone) { callLink.href = 'tel:' + j.phone.replace(/[^\d+]/g, ''); callLink.classList.remove('hidden'); }
    else callLink.classList.add('hidden');

    const notesWrap = $('sheetNotesWrap');
    if (j.notes) { $('sheetNotes').textContent = j.notes; notesWrap.classList.remove('hidden'); }
    else notesWrap.classList.add('hidden');

    const pickupBtn = $('pickupBtn'), deliverBtn = $('deliverBtn'), doneNote = $('sheetDoneNote');
    pickupBtn.classList.add('hidden'); deliverBtn.classList.add('hidden'); doneNote.classList.add('hidden');
    if (j.status === 'confirmed') {
      pickupBtn.classList.remove('hidden');
    } else if (j.status === 'in-transit') {
      deliverBtn.classList.remove('hidden');
    } else if (j.status === 'delivered') {
      doneNote.textContent = j.podRemarks
        ? `Delivered with remarks: "${j.podRemarks}"`
        : `Delivered ${j.deliveredAt ? new Date(j.deliveredAt).toLocaleString('en-SG', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : ''}`;
      doneNote.classList.remove('hidden');
    }
    $('sheetOverlay').classList.remove('hidden');
  }
  $('sheetCloseBtn').addEventListener('click', () => $('sheetOverlay').classList.add('hidden'));
  $('sheetOverlay').addEventListener('click', e => { if (e.target === $('sheetOverlay')) $('sheetOverlay').classList.add('hidden'); });

  $('pickupBtn').addEventListener('click', async () => {
    if (!activeJobId) return;
    $('pickupBtn').disabled = true;
    try {
      await api(`/api/driver/jobs/${encodeURIComponent(activeJobId)}/pickup`, { method: 'POST' });
      toast('🚚 On the road');
      $('sheetOverlay').classList.add('hidden');
      loadJobs();
    } catch (err) { toast('⚠ ' + err.message); }
    $('pickupBtn').disabled = false;
  });

  $('deliverBtn').addEventListener('click', async () => {
    if (!activeJobId) return;
    const remarks = prompt('Any issues with this delivery? Leave blank if none.');
    if (remarks === null) return; // cancelled
    $('deliverBtn').disabled = true;
    try {
      await api(`/api/driver/jobs/${encodeURIComponent(activeJobId)}/deliver`, {
        method: 'POST', body: JSON.stringify({ remarks: remarks.trim() }),
      });
      toast(remarks.trim() ? '✓ Delivered (with remarks)' : '✓ Delivered');
      $('sheetOverlay').classList.add('hidden');
      loadJobs();
    } catch (err) { toast('⚠ ' + err.message); }
    $('deliverBtn').disabled = false;
  });

  // ── Offline indicator ────────────────────────────────────────────────────
  function updateOnlineState() { $('offlinePill').classList.toggle('hidden', navigator.onLine); }
  window.addEventListener('online', () => { updateOnlineState(); if (driverToken) loadJobs(); });
  window.addEventListener('offline', updateOnlineState);
  updateOnlineState();

  // ── Boot ─────────────────────────────────────────────────────────────────
  renderPin();
  if (driverToken && driverInfo) showApp(); else showLogin();
})();
