'use strict';
/* Liagire Workflow — client-facing, read-only, token-gated view. No login. */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtMoney(amount, currency) {
  if (amount == null) return '—';
  return `${currency || 'SGD'} ${Number(amount).toFixed(2)}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' });
  } catch (e) { return iso; }
}

function getToken() {
  return new URLSearchParams(location.search).get('t') || '';
}

// The token comes straight off the URL query string, so it is attacker
// controlled. Every place it lands inside an href/src attribute must use
// this encoded form, never the raw value — encoding once here, at the
// source, means every downstream template literal is safe by construction
// rather than by remembering to escape it at each call site.
function urlSafeToken(raw) {
  return encodeURIComponent(raw);
}

function photoStrip(token, photos) {
  if (!photos || !photos.length) return '';
  return `<div class="photo-grid" style="margin-top:8px;">${photos.map(p => `
    <div><img src="/api/public/${token}/photo/${p.id}" alt="${esc(p.caption || '')}"
      data-full="/api/public/${token}/photo/${p.id}" class="photo-thumb" />
      ${p.caption ? `<span class="cap">${esc(p.caption)}</span>` : ''}</div>
  `).join('')}</div>`;
}

function timelineHtml(token, view) {
  return `<ul class="c-timeline">${view.timeline.map(t => `
    <li>
      <div class="c-dot ${t.done ? 'done' : 'pending'}">${t.done ? '✓' : ''}</div>
      <div class="c-body">
        <div class="t-label">${esc(t.label)}</div>
        ${t.detail ? `<div class="t-detail">${esc(t.detail)}</div>` : ''}
        ${t.at ? `<div class="t-when">${fmtDate(t.at)}</div>` : ''}
        ${t.key === 'collected' && view.collection ? photoStrip(token, view.collection.photos) : ''}
        ${t.key === 'delivered' && view.delivery ? photoStrip(token, view.delivery.photos) : ''}
        ${t.key === 'in_transit' && view.tracking.updates.length ? `
          <ul class="timeline" style="margin-top:6px;">
            ${view.tracking.updates.map(u => `<li>${esc(u.note)}<div class="when">${fmtDate(u.at)}</div></li>`).join('')}
          </ul>` : ''}
      </div>
    </li>
  `).join('')}</ul>`;
}

function invoiceHtml(token, view) {
  if (!view.invoice) return '';
  const inv = view.invoice;
  const statusPill = inv.payment_status === 'paid' ? '<span class="pill pill-green">Paid in full</span>'
    : inv.payment_status === 'partial' ? '<span class="pill pill-amber">Partially paid</span>'
    : '<span class="pill pill-grey">Awaiting payment</span>';
  return `
    <div class="card section">
      <h3 style="margin-top:0;">Invoice ${inv.number ? `#${esc(inv.number)}` : ''}</h3>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span class="money" style="font-size:1.2rem;font-weight:800;">${fmtMoney(inv.amount, inv.currency)}</span>
        ${statusPill}
      </div>
      <div class="hint" style="margin-top:4px;">
        ${inv.due_at ? `Due ${esc(String(inv.due_at).slice(0, 10))} &middot; ` : ''}
        ${fmtMoney(inv.paid_amount, inv.currency)} paid${inv.balance > 0 ? ` &middot; ${fmtMoney(inv.balance, inv.currency)} outstanding` : ''}
        ${inv.has_document ? ` &middot; <a href="/api/public/${token}/files/invoice" target="_blank">download invoice</a>` : ''}
      </div>
      ${inv.payments.length ? `<table class="simple" style="margin-top:10px;">
        <thead><tr><th>Date</th><th>Amount</th></tr></thead>
        <tbody>${inv.payments.map(p => `<tr><td>${fmtDate(p.at)}</td><td class="money">${fmtMoney(p.amount, inv.currency)}</td></tr>`).join('')}</tbody>
      </table>` : ''}
    </div>
  `;
}

async function boot() {
  const app = document.getElementById('app');
  const token = getToken();
  if (!token) {
    app.innerHTML = '<div class="center-msg">This link is missing its reference code. Please check the link your contact sent you.</div>';
    return;
  }
  const safeToken = urlSafeToken(token);
  let view;
  try {
    const res = await fetch(`/api/public/${safeToken}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      app.innerHTML = `<div class="center-msg">${esc(data.error || 'We could not find that job.')}</div>`;
      return;
    }
    view = await res.json();
  } catch (e) {
    app.innerHTML = '<div class="center-msg">Could not load this page right now. Please try again shortly.</div>';
    return;
  }

  const doneCount = view.timeline.filter(t => t.done).length;
  const segs = view.timeline.map((t, i) => {
    if (t.done) return '<div class="seg done"></div>';
    if (i === doneCount) return '<div class="seg current"></div>';
    return '<div class="seg"></div>';
  }).join('');

  app.innerHTML = `
    <div class="client-hero">
      <div class="brand">Liagire</div>
      <h1>${esc(view.client_name)}</h1>
      <div class="sub">Job ${esc(view.job_code)}</div>
    </div>
    ${view.cancelled ? `<div class="pill pill-grey" style="display:block;text-align:center;padding:10px;margin-bottom:16px;">This job was cancelled${view.cancelled_at ? ` on ${fmtDate(view.cancelled_at).split(',')[0]}` : ''}.</div>` : ''}
    <div class="progress-track">${segs}</div>
    <div class="card section">
      <h3 style="margin-top:0;">Status: ${esc(view.stage_label)}</h3>
      ${timelineHtml(safeToken, view)}
    </div>
    ${invoiceHtml(safeToken, view)}
    ${view.quote && view.quote.has_document ? `<div class="hint" style="text-align:center;margin-top:10px;"><a href="/api/public/${safeToken}/files/quote" target="_blank">Download quote</a></div>` : ''}
  `;

  app.querySelectorAll('.photo-thumb').forEach(img => img.addEventListener('click', () => {
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `<img src="${img.dataset.full}" style="max-width:100%;max-height:90vh;border-radius:8px;display:block;" />`;
    el.addEventListener('click', () => el.remove());
    document.body.appendChild(el);
  }));
}

boot();
