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
    const cardHtml = j => {
      const isNew = j.status === 'confirmed' && !j.driverAcceptedAt;
      return `
      <div class="job-card${isNew ? ' job-new' : ''}" style="border-left-color:${isNew ? '#7c3aed' : j.statusColor}" data-id="${esc(j.id)}">
        <div class="job-top">
          <div>
            <div class="job-seq">${j.routeNum != null ? 'Stop ' + j.stopSeq + ' · Route ' + j.routeNum : j.id}</div>
            <div class="job-client">${esc(j.client || '(no client name)')}</div>
          </div>
          <span class="${isNew ? 'job-pill-new' : 'job-pill'}" style="${isNew ? '' : 'background:' + j.statusColor}">${isNew ? '🆕 New — Tap to Accept' : esc(j.statusLabel)}</span>
        </div>
        <div class="job-addr">${esc(j.address || 'No address on file')}${j.zip ? ' · ' + esc(j.zip) : ''}</div>
        <div class="job-meta">
          <span>📦 ${j.packages} carton${j.packages === 1 ? '' : 's'}</span>
          ${j.referenceId ? `<span>PO ${esc(j.referenceId)}</span>` : ''}
        </div>
      </div>`;
    };
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
    $('sheetDriverLine').textContent = 'Driver: ' + [driverInfo?.name || driverInfo?.id, driverInfo?.plate].filter(Boolean).join(' · ');
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

    const acceptBtn = $('acceptBtn'), pickupBtn = $('pickupBtn'), podSection = $('podSection'),
          deliverBtn = $('deliverBtn'), doneNote = $('sheetDoneNote');
    acceptBtn.classList.add('hidden'); pickupBtn.classList.add('hidden');
    podSection.classList.add('hidden'); deliverBtn.classList.add('hidden'); doneNote.classList.add('hidden');

    if (j.status === 'confirmed' && !j.driverAcceptedAt) {
      acceptBtn.classList.remove('hidden');
    } else if (j.status === 'confirmed') {
      pickupBtn.classList.remove('hidden');
    } else if (j.status === 'in-transit') {
      podSection.classList.remove('hidden');
      renderPodPhotos(j);
      deliverBtn.classList.remove('hidden');
      deliverBtn.disabled = !(j.podPhotos && j.podPhotos.length);
    } else if (j.status === 'delivered') {
      doneNote.textContent = j.podRemarks
        ? `Delivered with remarks: "${j.podRemarks}"`
        : `Delivered ${j.deliveredAt ? new Date(j.deliveredAt).toLocaleString('en-SG', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : ''}`;
      if (j.podLocation) doneNote.textContent += ' · 📍 GPS captured';
      if (j.podPhotos && j.podPhotos.length) doneNote.textContent += ` · 📷 ${j.podPhotos.length} photo(s)`;
      doneNote.classList.remove('hidden');
      if (j.podPhotos && j.podPhotos.length) { podSection.classList.remove('hidden'); $('podPhotoBtn').classList.add('hidden'); renderPodPhotos(j); }
    }
    $('sheetOverlay').classList.remove('hidden');
  }

  function renderPodPhotos(j) {
    const photos = j.podPhotos || [];
    $('podPhotoCount').textContent = photos.length + ' photo(s)';
    $('podHint').classList.toggle('hidden', photos.length > 0);
    $('podPhotoGrid').innerHTML = photos.map(p =>
      `<img class="pod-photo-thumb" src="/api/driver/jobs/${encodeURIComponent(j.id)}/photo/${encodeURIComponent(p.id)}?token=${encodeURIComponent(driverToken)}" loading="lazy" />`
    ).join('');
  }
  $('sheetCloseBtn').addEventListener('click', () => $('sheetOverlay').classList.add('hidden'));
  $('sheetOverlay').addEventListener('click', e => { if (e.target === $('sheetOverlay')) $('sheetOverlay').classList.add('hidden'); });

  $('acceptBtn').addEventListener('click', async () => {
    if (!activeJobId) return;
    $('acceptBtn').disabled = true;
    try {
      await api(`/api/driver/jobs/${encodeURIComponent(activeJobId)}/accept`, { method: 'POST' });
      toast('✅ Job accepted');
      $('sheetOverlay').classList.add('hidden');
      loadJobs();
    } catch (err) { toast('⚠ ' + err.message); }
    $('acceptBtn').disabled = false;
  });

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

  // ── ePOD: photo (required before delivery) ──────────────────────────────
  $('podPhotoBtn').addEventListener('click', () => $('podPhotoInput').click());
  $('podPhotoInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !activeJobId) return;
    $('podPhotoBtn').disabled = true;
    $('podPhotoBtn').textContent = 'Uploading…';
    try {
      const fd = new FormData();
      fd.append('photo', file);
      const resp = await fetch(`/api/driver/jobs/${encodeURIComponent(activeJobId)}/photo`, {
        method: 'POST', headers: { 'x-auth-token': driverToken }, body: fd,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Photo upload failed');
      toast('📷 Photo added');
      // Refresh in place so the sheet doesn't jump — pull the updated job
      // list, re-find this job, and re-render just this open sheet.
      await loadJobs();
      const j = jobs.find(x => x.id === activeJobId);
      if (j) { renderPodPhotos(j); $('deliverBtn').disabled = !(j.podPhotos && j.podPhotos.length); }
    } catch (err) { toast('⚠ ' + err.message); }
    $('podPhotoBtn').disabled = false;
    $('podPhotoBtn').textContent = '📷 Take Delivery Photo';
  });

  // Best-effort GPS — a denied/unavailable permission never blocks the
  // actual delivery (see server-side comment on POST .../deliver for why).
  function captureGps(timeoutMs = 8000) {
    return new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      const timer = setTimeout(() => resolve(null), timeoutMs);
      navigator.geolocation.getCurrentPosition(
        pos => { clearTimeout(timer); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }); },
        () => { clearTimeout(timer); resolve(null); },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
      );
    });
  }

  $('deliverBtn').addEventListener('click', async () => {
    if (!activeJobId) return;
    const remarks = prompt('Any issues with this delivery? Leave blank if none.');
    if (remarks === null) return; // cancelled
    $('deliverBtn').disabled = true;
    $('deliverBtn').textContent = '📍 Getting location…';
    try {
      const gps = await captureGps();
      $('deliverBtn').textContent = 'Delivering…';
      await api(`/api/driver/jobs/${encodeURIComponent(activeJobId)}/deliver`, {
        method: 'POST',
        body: JSON.stringify({ remarks: remarks.trim(), lat: gps?.lat, lng: gps?.lng, accuracy: gps?.accuracy }),
      });
      toast((remarks.trim() ? '✓ Delivered (with remarks)' : '✓ Delivered') + (gps ? ' · 📍 location saved' : ''));
      $('sheetOverlay').classList.add('hidden');
      loadJobs();
    } catch (err) {
      toast('⚠ ' + err.message);
      $('deliverBtn').disabled = false;
    }
    $('deliverBtn').textContent = '✓ Mark Delivered';
  });

  // ── Offline indicator ────────────────────────────────────────────────────
  function updateOnlineState() { $('offlinePill').classList.toggle('hidden', navigator.onLine); }
  window.addEventListener('online', () => { updateOnlineState(); if (driverToken) loadJobs(); });
  window.addEventListener('offline', updateOnlineState);
  updateOnlineState();

  // ── Install-app hint ─────────────────────────────────────────────────────
  // Same reasoning as the office app's installHintBar: iOS never fires an
  // install prompt (Share -> Add to Home Screen is the only path, so it's
  // spelled out), Android/desktop Chrome exposes a real one. Own dismissal
  // key — a driver dismissing this shouldn't affect the office app's hint
  // on a shared device, and vice versa. driver-manifest.json's start_url
  // is /driver, so an installed icon opens straight to this login screen,
  // never the office app.
  (function initInstallHint() {
    const bar = $('installHintBar');
    if (!bar) return;
    const txt = $('installHintText'), actionBtn = $('installHintAction'), closeBtn = $('installHintClose');
    const DISMISS_KEY = 'driver_install_hint_dismissed';

    const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
    if (isStandalone) return;
    try { if (localStorage.getItem(DISMISS_KEY)) return; } catch {}

    closeBtn.addEventListener('click', () => {
      bar.classList.add('hidden');
      try { localStorage.setItem(DISMISS_KEY, '1'); } catch {}
    });

    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (isIOS) {
      const inSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
      txt.innerHTML = inSafari
        ? '📲 Install this app: tap <b>Share</b>, then <b>&ldquo;Add to Home Screen&rdquo;</b>.'
        : '📲 To install: open this page in <b>Safari</b>, tap <b>Share</b>, then <b>&ldquo;Add to Home Screen&rdquo;</b>.';
      bar.classList.remove('hidden');
      return;
    }
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      txt.innerHTML = '📲 Install <b>IDEALONE Driver</b> on this phone.';
      actionBtn.classList.remove('hidden');
      bar.classList.remove('hidden');
      actionBtn.addEventListener('click', () => {
        bar.classList.add('hidden');
        e.prompt();
      }, { once: true });
    });
    window.addEventListener('appinstalled', () => bar.classList.add('hidden'));
  })();

  // ── Boot ─────────────────────────────────────────────────────────────────
  renderPin();
  if (driverToken && driverInfo) showApp(); else showLogin();
})();
