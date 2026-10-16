// Client Portal PWA helper: service-worker registration, install prompt
// (Android/desktop button, iOS "Add to Home Screen" hint) and the opt-in for
// the daily low-stock push. Does NOTHING unless /pwa-config.json says the
// PWA flag is on. Self-contained: no dependency on portal.js internals beyond
// the portal_token localStorage key it already uses.
(function () {
  'use strict';
  const DISMISS_INSTALL = 'portal_install_hint_dismissed';
  const DISMISS_PUSH = 'portal_push_hint_dismissed';
  const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };
  const token = () => ls('portal_token') || '';

  function bar(id, html, actions) {
    let el = document.getElementById(id);
    if (el) el.remove();
    el = document.createElement('div');
    el.id = id;
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9000;background:#1e3a8a;color:#fff;border-radius:12px;padding:10px 12px;display:flex;gap:8px;align-items:center;font:14px -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:560px;margin:0 auto';
    const t = document.createElement('div'); t.style.flex = '1'; t.innerHTML = html; el.appendChild(t);
    for (const a of actions) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = a.label;
      b.style.cssText = a.primary ? 'background:#fff;color:#1e3a8a;border:0;border-radius:8px;padding:6px 10px;font-weight:700' : 'background:transparent;color:#fff;border:0;font-size:18px;padding:2px 6px';
      if (a.aria) b.setAttribute('aria-label', a.aria);
      b.addEventListener('click', () => { a.onClick(); el.remove(); });
      el.appendChild(b);
    }
    document.body.appendChild(el);
    return el;
  }

  function initInstall() {
    if (isStandalone() || ls(DISMISS_INSTALL)) return;
    const dismiss = { label: '×', aria: 'Dismiss', onClick: () => ls(DISMISS_INSTALL, '1') };
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (isIOS) {
      const inSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
      bar('pwaInstallBar', inSafari
        ? '📲 Install the portal: tap <b>Share</b>, then <b>“Add to Home Screen”</b>.'
        : '📲 To install: open this page in <b>Safari</b>, tap <b>Share</b>, then <b>“Add to Home Screen”</b>.', [dismiss]);
      return;
    }
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      bar('pwaInstallBar', '📲 Install the <b>IdealOne Client Portal</b> on this device.', [
        { label: 'Install', primary: true, onClick: () => { try { e.prompt(); } catch {} } }, dismiss]);
    });
    window.addEventListener('appinstalled', () => { const b = document.getElementById('pwaInstallBar'); if (b) b.remove(); });
  }

  function b64ToBytes(s) {
    const pad = '='.repeat((4 - s.length % 4) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }
  async function api(path, body) {
    const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-auth-token': token() }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function subscribe(reg, key) {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return false;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    await api('/api/portal/push/subscribe', { subscription: sub.toJSON(), alerts: { low_stock: true } });
    return true;
  }
  // Offer the push opt-in only to a signed-in login, once per device, and only
  // where the browser can actually do push (iOS: only once installed).
  async function maybeOfferPush(reg, key) {
    if (!token() || !('PushManager' in window) || !('Notification' in window)) return;
    if (Notification.permission === 'denied' || ls(DISMISS_PUSH)) return;
    const sub = await reg.pushManager.getSubscription();
    if (sub && Notification.permission === 'granted') {
      // keep the server copy fresh (e.g. after a re-login on the same device)
      api('/api/portal/push/subscribe', { subscription: sub.toJSON() }).catch(() => {});
      return;
    }
    bar('pwaPushBar', '🔔 Get the <b>daily low-stock alert</b> as a notification on this device?', [
      { label: 'Turn on', primary: true, onClick: () => subscribe(reg, key).catch(() => {}) },
      { label: '×', aria: 'Not now', onClick: () => ls(DISMISS_PUSH, '1') }]);
  }
  window.idealonePortalPush = { enable: null };

  fetch('/pwa-config.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(cfg => {
    if (!cfg || !cfg.pwa) return;
    initInstall();
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(reg => {
      if (!cfg.push || !cfg.vapidPublicKey) return;
      window.idealonePortalPush.enable = () => subscribe(reg, cfg.vapidPublicKey);
      // portal.js stores the token on login without a reload, so check again shortly after.
      let tries = 0;
      const tick = () => { if (token()) { maybeOfferPush(reg, cfg.vapidPublicKey).catch(() => {}); return; } if (++tries < 60) setTimeout(tick, 5000); };
      setTimeout(tick, 4000);
    }).catch(() => {});
  }).catch(() => {});
})();
