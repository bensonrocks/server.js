'use strict';
/* Liagire Workflow — staff dashboard */

let TOKEN = localStorage.getItem('liagire_token');
let USER = null;
try { USER = JSON.parse(localStorage.getItem('liagire_user') || 'null'); } catch (e) { USER = null; }
if (!TOKEN) location.href = 'login.html';

let STAGE_ORDER = [];
let STAGE_LABELS = {};
let filters = { status: '', cancelled: '', q: '', overdueOnly: false };

// ---------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtMoney(amount, currency) {
  if (amount == null || amount === '') return '—';
  return `${currency || 'SGD'} ${Number(amount).toFixed(2)}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' });
  } catch (e) { return iso; }
}

function stageIdx(key) { return STAGE_ORDER.indexOf(key); }

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.getElementById('toastRoot').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function signedOutRedirect() {
  localStorage.removeItem('liagire_token');
  localStorage.removeItem('liagire_user');
  location.href = 'login.html';
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers, { 'x-auth-token': TOKEN });
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, { method: opts.method || 'GET', headers, body });
  if (res.status === 401) { signedOutRedirect(); throw new Error('Not signed in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function apiForm(path, formData, method = 'POST') {
  const res = await fetch(path, { method, headers: { 'x-auth-token': TOKEN }, body: formData });
  if (res.status === 401) { signedOutRedirect(); throw new Error('Not signed in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function collectFormData(formEl) {
  const fd = new FormData();
  formEl.querySelectorAll('[name]').forEach(el => {
    if (el.type === 'file') {
      for (const f of el.files) fd.append(el.name, f);
    } else {
      fd.append(el.name, el.value);
    }
  });
  return fd;
}

function fileHref(jobId, rel) {
  if (!rel) return null;
  const name = rel.includes('/') ? rel.split('/').slice(1).join('/') : rel;
  return `/api/files/${jobId}/${encodeURIComponent(name)}?token=${encodeURIComponent(TOKEN)}`;
}

function photoGridHtml(jobId, photos) {
  if (!photos.length) return '<div class="hint">No photos yet.</div>';
  return `<div class="photo-grid">${photos.map(p => `
    <div><img src="${fileHref(jobId, p.file_path)}" alt="${esc(p.caption || '')}"
      data-full="${fileHref(jobId, p.file_path)}" class="photo-thumb" />
      ${p.caption ? `<span class="cap">${esc(p.caption)}</span>` : ''}</div>
  `).join('')}</div>`;
}

function showLightbox(src) {
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.style.zIndex = '300';
  el.innerHTML = `<img src="${src}" style="max-width:100%;max-height:90vh;border-radius:8px;display:block;" />`;
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------
function showModal(innerHtml, opts = {}) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `<div class="modal-backdrop" id="modalBackdrop">
    <div class="modal-card" style="${opts.wide ? 'max-width:1020px' : ''}">${innerHtml}</div>
  </div>`;
  document.getElementById('modalBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modalBackdrop') closeModal();
  });
  root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
}
function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }

// ---------------------------------------------------------------------------
// Dashboard tiles + filters
// ---------------------------------------------------------------------------
async function loadStats() {
  const s = await api('/api/stats');
  STAGE_ORDER = s.stage_order;
  STAGE_LABELS = s.stage_labels;
  renderTiles(s);
}

function tileHtml(key, label, n, warn) {
  return `<div class="tile ${warn ? 'warn' : ''}" data-filter="${key}"><div class="n">${n}</div><div class="l">${esc(label)}</div></div>`;
}

function renderTiles(s) {
  const parts = [];
  parts.push(tileHtml('all', 'Active jobs', s.total_active, false));
  for (const key of STAGE_ORDER) parts.push(tileHtml(key, STAGE_LABELS[key], s.by_stage[key] || 0, false));
  parts.push(tileHtml('overdue', 'Overdue invoices', s.overdue_invoices, s.overdue_invoices > 0));
  parts.push(`<div class="tile money"><div class="n">${fmtMoney(s.total_outstanding, 'SGD')}</div><div class="l">Outstanding</div></div>`);
  parts.push(tileHtml('cancelled', 'Cancelled', s.cancelled, false));
  const tiles = document.getElementById('tiles');
  tiles.innerHTML = parts.join('');
  tiles.querySelectorAll('.tile[data-filter]').forEach(t => t.addEventListener('click', () => setFilterFromKey(t.dataset.filter)));
}

function setFilterFromKey(key) {
  if (key === 'all') { filters.status = ''; filters.cancelled = ''; filters.overdueOnly = false; }
  else if (key === 'cancelled') { filters.status = ''; filters.cancelled = 'only'; filters.overdueOnly = false; }
  else if (key === 'overdue') { filters.status = ''; filters.cancelled = ''; filters.overdueOnly = true; }
  else { filters.status = key; filters.cancelled = ''; filters.overdueOnly = false; }
  renderStageChips();
  loadJobs();
}

function renderStageChips() {
  const items = [{ key: '', label: 'All' }, ...STAGE_ORDER.map(k => ({ key: k, label: STAGE_LABELS[k] })),
    { key: '__cancelled', label: 'Cancelled' }];
  const wrap = document.getElementById('stageChips');
  wrap.innerHTML = items.map(it => {
    const active = it.key === '__cancelled'
      ? filters.cancelled === 'only'
      : (filters.status === it.key && filters.cancelled !== 'only' && !filters.overdueOnly);
    return `<button type="button" class="chip ${active ? 'active' : ''}" data-chip="${it.key}">${esc(it.label)}</button>`;
  }).join('');
  wrap.querySelectorAll('[data-chip]').forEach(btn => btn.addEventListener('click', () => {
    const key = btn.dataset.chip;
    setFilterFromKey(key === '__cancelled' ? 'cancelled' : (key || 'all'));
  }));
}

// ---------------------------------------------------------------------------
// Job list
// ---------------------------------------------------------------------------
async function loadJobs() {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.cancelled) params.set('cancelled', filters.cancelled);
  if (filters.q) params.set('q', filters.q);
  let jobs = await api('/api/jobs?' + params.toString());
  if (filters.overdueOnly) jobs = jobs.filter(j => j.overdue);
  renderJobList(jobs);
}

function jobRowHtml(j) {
  const pillClass = j.cancelled ? 'pill-grey' : (j.overdue ? 'pill-red' : (j.status === 'paid' ? 'pill-green' : 'pill-blue'));
  const pillLabel = j.cancelled ? 'Cancelled' : j.stage_label;
  const flags = [];
  if (j.overdue) flags.push('<span class="pill pill-red">Overdue</span>');
  if (j.vendor_cost_total > 0) flags.push(`<span class="pill pill-grey">Vendor ${fmtMoney(j.vendor_cost_total, j.quote_currency)}</span>`);
  return `<div class="job-row" data-id="${j.id}">
    <div class="job-main">
      <div class="client-line"><span class="client">${esc(j.client_name)}</span><span class="code">${esc(j.job_code)}</span></div>
      ${j.description ? `<div class="desc">${esc(j.description)}</div>` : ''}
    </div>
    <div class="flags">${flags.join('')}</div>
    <span class="pill ${pillClass} stage-pill">${esc(pillLabel)}</span>
  </div>`;
}

function renderJobList(jobs) {
  const list = document.getElementById('jobList');
  const empty = document.getElementById('jobListEmpty');
  if (!jobs.length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  list.innerHTML = jobs.map(jobRowHtml).join('');
  list.querySelectorAll('.job-row').forEach(row => row.addEventListener('click', () => openJob(row.dataset.id)));
}

// ---------------------------------------------------------------------------
// New job
// ---------------------------------------------------------------------------
function openNewJobModal() {
  showModal(`
    <h3>New quote request</h3>
    <label>Client name</label><input type="text" id="njClient" required />
    <label>Client contact</label><input type="text" id="njContact" placeholder="email / phone" />
    <label>Description</label><textarea id="njDesc" placeholder="What are we quoting?"></textarea>
    <div class="error-text" id="njErr"></div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" data-close>Cancel</button>
      <button type="button" class="btn-primary btn-sm" id="njSubmit">Create</button>
    </div>
  `);
  document.getElementById('njSubmit').addEventListener('click', async () => {
    const client_name = document.getElementById('njClient').value.trim();
    const client_contact = document.getElementById('njContact').value.trim();
    const description = document.getElementById('njDesc').value.trim();
    const errEl = document.getElementById('njErr');
    if (!client_name) { errEl.textContent = 'Client name is required'; return; }
    try {
      const job = await api('/api/jobs', { method: 'POST', json: { client_name, client_contact, description } });
      toast(`${job.job_code} created`);
      await loadStats(); await loadJobs();
      openJob(job.id);
    } catch (e) { errEl.textContent = e.message; }
  });
}

// ---------------------------------------------------------------------------
// Job detail — stage blocks
// ---------------------------------------------------------------------------
function stageBlockWrap(key, title, done, metaHtml, formHtml, toggleLabel) {
  return `<div class="stage-block ${done ? 'done' : ''}" data-stage-block="${key}">
    <div class="stage-title">
      <span>${done ? '✅' : '○'} ${esc(title)}</span>
      <button type="button" class="btn-sm" data-toggle="${key}" style="margin-left:auto;">${toggleLabel || (done ? 'Update' : 'Record')}</button>
    </div>
    ${metaHtml}
    <div class="stage-form" data-form="${key}">${formHtml}</div>
  </div>`;
}

function quoteBlockHtml(job) {
  const done = !!job.quote_sent_at;
  const meta = done
    ? `<div class="stage-meta">Sent ${fmtDate(job.quote_sent_at)} &middot; ${fmtMoney(job.quote_amount, job.quote_currency)}${job.quote_doc_path ? ` &middot; <a href="${fileHref(job.id, job.quote_doc_path)}" target="_blank">quote document</a>` : ''}</div>`
    : '<div class="stage-meta">Not yet sent</div>';
  return stageBlockWrap('quote', 'Quote', done, meta, `
    <form data-endpoint="/api/jobs/${job.id}/quote">
      <div class="field-row">
        <div><label>Amount</label><input type="number" step="0.01" name="amount" value="${job.quote_amount ?? ''}" required /></div>
        <div><label>Currency</label><input type="text" name="currency" value="${esc(job.quote_currency || 'SGD')}" /></div>
      </div>
      <label>Notes</label><textarea name="notes">${esc(job.quote_notes || '')}</textarea>
      <label>Quote document ${job.quote_doc_path ? '(replace)' : ''}</label>
      <input type="file" name="doc" accept="application/pdf,image/*" />
      <div class="error-text"></div>
      <button type="submit" class="btn-primary btn-sm" style="margin-top:8px;">${done ? 'Update quote' : 'Send quote'}</button>
    </form>
  `, done ? 'Update' : 'Record');
}

function acceptanceBlockHtml(job) {
  const enabled = !!job.quote_sent_at;
  const done = !!job.accepted_at;
  const meta = done
    ? `<div class="stage-meta">${job.accepted_by ? `Accepted by ${esc(job.accepted_by)} &middot; ` : ''}${fmtDate(job.accepted_at)}${job.acceptance_proof_path ? ` &middot; <a href="${fileHref(job.id, job.acceptance_proof_path)}" target="_blank">proof</a>` : ''}</div>`
    : `<div class="stage-meta">${enabled ? 'Not yet accepted' : 'Send the quote first'}</div>`;
  if (!enabled) return stageBlockWrap('accept', 'Proof of quote acceptance', done, meta, '<div class="hint">Send the quote before recording acceptance.</div>', 'Locked');
  return stageBlockWrap('accept', 'Proof of quote acceptance', done, meta, `
    <form data-endpoint="/api/jobs/${job.id}/accept">
      <label>Accepted by</label><input type="text" name="accepted_by" value="${esc(job.accepted_by || '')}" placeholder="Client contact name" />
      <label>Notes</label><textarea name="notes">${esc(job.acceptance_notes || '')}</textarea>
      <label>Proof (PO, signed quote, confirmation email) ${job.acceptance_proof_path ? '(replace)' : '(required)'}</label>
      <input type="file" name="proof" accept="application/pdf,image/*" ${job.acceptance_proof_path ? '' : 'required'} />
      <div class="error-text"></div>
      <button type="submit" class="btn-primary btn-sm" style="margin-top:8px;">${done ? 'Update' : 'Record acceptance'}</button>
    </form>
  `);
}

function collectionBlockHtml(job) {
  const enabled = !!job.accepted_at;
  const done = !!job.collected_at;
  const photos = job.photos.filter(p => p.stage === 'collection');
  const meta = done
    ? `<div class="stage-meta">${job.collected_by ? `Collected by ${esc(job.collected_by)} &middot; ` : ''}${fmtDate(job.collected_at)}${job.pickup_location ? ` &middot; ${esc(job.pickup_location)}` : ''}</div>${photoGridHtml(job.id, photos)}`
    : `<div class="stage-meta">${enabled ? 'Not yet collected' : 'Record acceptance first'}</div>`;
  if (!enabled) return stageBlockWrap('collect', 'Proof of collection', done, meta, '<div class="hint">Record acceptance before collection.</div>', 'Locked');
  return stageBlockWrap('collect', 'Proof of collection', done, meta, `
    <form data-endpoint="/api/jobs/${job.id}/collect">
      <div class="field-row">
        <div><label>Collected by</label><input type="text" name="collected_by" value="${esc(job.collected_by || '')}" /></div>
        <div><label>Pickup location</label><input type="text" name="pickup_location" value="${esc(job.pickup_location || '')}" /></div>
      </div>
      <label>Notes</label><textarea name="notes">${esc(job.collection_notes || '')}</textarea>
      <label>Photos ${photos.length ? '(add more)' : '(required)'}</label>
      <input type="file" name="photos" accept="image/*" capture="environment" multiple ${photos.length ? '' : 'required'} />
      <div class="error-text"></div>
      <button type="submit" class="btn-primary btn-sm" style="margin-top:8px;">${done ? 'Add / update' : 'Record collection'}</button>
    </form>
  `);
}

function shipmentBlockHtml(job) {
  const enabled = !!job.collected_at;
  const done = !!job.shipped_at;
  const updates = job.events.filter(e => e.type === 'tracking_update');
  const meta = done
    ? `<div class="stage-meta">${[job.carrier, job.tracking_number].filter(Boolean).map(esc).join(' &middot; ') || '&mdash;'} &middot; ${fmtDate(job.shipped_at)}</div>
       ${updates.length ? `<ul class="timeline">${updates.slice().reverse().map(u => `<li>${esc(u.note)}<div class="when">${fmtDate(u.at)}</div></li>`).join('')}</ul>` : ''}`
    : `<div class="stage-meta">${enabled ? 'Not shipped yet' : 'Record collection first'}</div>`;
  if (!enabled) return stageBlockWrap('ship', 'Tracking / shipment', done, meta, '<div class="hint">Record collection before starting tracking.</div>', 'Locked');
  return stageBlockWrap('ship', 'Tracking / shipment', done, meta, `
    <form data-endpoint="/api/jobs/${job.id}/ship" data-json="1">
      <div class="field-row">
        <div><label>Carrier</label><input type="text" name="carrier" value="${esc(job.carrier || '')}" /></div>
        <div><label>Tracking number</label><input type="text" name="tracking_number" value="${esc(job.tracking_number || '')}" /></div>
      </div>
      <label>Notes</label><textarea name="notes"></textarea>
      <div class="error-text"></div>
      <button type="submit" class="btn-primary btn-sm" style="margin-top:8px;">${done ? 'Update' : 'Start tracking'}</button>
    </form>
    ${done ? `
    <form data-endpoint="/api/jobs/${job.id}/tracking-update" data-json="1" style="margin-top:12px;border-top:1px dashed var(--border);padding-top:10px;">
      <label>Add a tracking update</label>
      <input type="text" name="note" placeholder="e.g. Arrived at transit hub" required />
      <div class="error-text"></div>
      <button type="submit" class="btn-sm" style="margin-top:8px;">Add update</button>
    </form>` : ''}
  `);
}

function deliveryBlockHtml(job) {
  const enabled = !!job.shipped_at;
  const done = !!job.delivered_at;
  const photos = job.photos.filter(p => p.stage === 'delivery');
  const meta = done
    ? `<div class="stage-meta">${job.received_by ? `Received by ${esc(job.received_by)} &middot; ` : ''}${fmtDate(job.delivered_at)}</div>${photoGridHtml(job.id, photos)}`
    : `<div class="stage-meta">${enabled ? 'Not yet delivered' : 'Start tracking first'}</div>`;
  if (!enabled) return stageBlockWrap('deliver', 'Proof of delivery', done, meta, '<div class="hint">Start shipment tracking before recording delivery.</div>', 'Locked');
  return stageBlockWrap('deliver', 'Proof of delivery', done, meta, `
    <form data-endpoint="/api/jobs/${job.id}/deliver">
      <label>Received by</label><input type="text" name="received_by" value="${esc(job.received_by || '')}" />
      <label>Notes</label><textarea name="notes">${esc(job.delivery_notes || '')}</textarea>
      <label>Photos ${photos.length ? '(add more)' : '(required)'}</label>
      <input type="file" name="photos" accept="image/*" capture="environment" multiple ${photos.length ? '' : 'required'} />
      <div class="error-text"></div>
      <button type="submit" class="btn-primary btn-sm" style="margin-top:8px;">${done ? 'Add / update' : 'Record delivery'}</button>
    </form>
  `);
}

function invoiceBlockHtml(job) {
  const done = !!job.invoice_sent_at;
  const meta = done
    ? `<div class="stage-meta">#${esc(job.invoice_number || '—')} &middot; ${fmtMoney(job.invoice_amount, job.invoice_currency)}${job.invoice_due_at ? ` &middot; due ${esc(String(job.invoice_due_at).slice(0, 10))}` : ''}${job.invoice_doc_path ? ` &middot; <a href="${fileHref(job.id, job.invoice_doc_path)}" target="_blank">invoice document</a>` : ''}</div>`
    : '<div class="stage-meta">Not yet issued</div>';
  return stageBlockWrap('invoice', 'Client invoice', done, meta, `
    <form data-endpoint="/api/jobs/${job.id}/invoice">
      <div class="field-row">
        <div><label>Invoice number</label><input type="text" name="invoice_number" value="${esc(job.invoice_number || '')}" /></div>
        <div><label>Amount</label><input type="number" step="0.01" name="amount" value="${job.invoice_amount ?? job.quote_amount ?? ''}" required /></div>
      </div>
      <div class="field-row">
        <div><label>Currency</label><input type="text" name="currency" value="${esc(job.invoice_currency || job.quote_currency || 'SGD')}" /></div>
        <div><label>Due date</label><input type="date" name="due_at" value="${job.invoice_due_at ? String(job.invoice_due_at).slice(0, 10) : ''}" /></div>
      </div>
      <label>Invoice document ${job.invoice_doc_path ? '(replace)' : ''}</label>
      <input type="file" name="doc" accept="application/pdf,image/*" />
      <div class="error-text"></div>
      <button type="submit" class="btn-primary btn-sm" style="margin-top:8px;">${done ? 'Update' : 'Issue invoice'}</button>
    </form>
  `);
}

function paymentBlockHtml(job) {
  const enabled = !!job.invoice_sent_at;
  const done = job.payment_status === 'paid';
  const balance = job.invoice_amount != null ? Math.max(0, job.invoice_amount - job.paid_amount) : null;
  const statusPill = job.payment_status === 'paid' ? '<span class="pill pill-green">Paid</span>'
    : job.payment_status === 'partial' ? '<span class="pill pill-amber">Partial</span>'
    : '<span class="pill pill-grey">Unpaid</span>';
  const meta = `<div class="stage-meta">${statusPill}${job.invoice_amount != null ? ` &middot; ${fmtMoney(job.paid_amount, job.invoice_currency)} of ${fmtMoney(job.invoice_amount, job.invoice_currency)}${balance > 0 ? ` &middot; balance ${fmtMoney(balance, job.invoice_currency)}` : ''}` : ''}</div>
    ${job.payments.length ? `<table class="simple" style="margin-top:8px;"><thead><tr><th>Date</th><th>Amount</th><th>Note</th><th></th></tr></thead><tbody>
      ${job.payments.map(p => `<tr><td>${fmtDate(p.at)}</td><td class="money">${fmtMoney(p.amount, job.invoice_currency)}</td><td>${esc(p.note || '')}${p.proof_path ? ` &middot; <a href="${fileHref(job.id, p.proof_path)}" target="_blank">proof</a>` : ''}</td><td><button type="button" class="btn-sm" data-del-payment="${p.id}">Remove</button></td></tr>`).join('')}
    </tbody></table>` : ''}`;
  if (!enabled) return stageBlockWrap('payment', 'Payment', done, meta, '<div class="hint">Issue the invoice before recording a payment.</div>', 'Locked');
  return stageBlockWrap('payment', 'Payment', done, meta, `
    <form data-endpoint="/api/jobs/${job.id}/payment">
      <div class="field-row">
        <div><label>Amount received</label><input type="number" step="0.01" name="amount" required /></div>
        <div><label>Note</label><input type="text" name="note" placeholder="e.g. bank transfer ref" /></div>
      </div>
      <label>Payment proof</label>
      <input type="file" name="proof" accept="application/pdf,image/*" />
      <div class="error-text"></div>
      <button type="submit" class="btn-primary btn-sm" style="margin-top:8px;">Record payment</button>
    </form>
  `, 'Record payment');
}

function vendorCostsHtml(job) {
  const rows = job.vendor_costs.map(vc => {
    const statusPill = vc.status === 'paid' ? '<span class="pill pill-green">Paid</span>'
      : vc.status === 'partial' ? '<span class="pill pill-amber">Partial</span>'
      : '<span class="pill pill-grey">Unpaid</span>';
    return `<tr>
      <td>${esc(vc.vendor_name)}${vc.description ? `<div class="hint">${esc(vc.description)}</div>` : ''}</td>
      <td>${esc(vc.invoice_number || '—')}${vc.invoice_doc_path ? ` &middot; <a href="${fileHref(job.id, vc.invoice_doc_path)}" target="_blank">doc</a>` : ''}</td>
      <td class="money">${fmtMoney(vc.invoice_amount, vc.currency)}</td>
      <td>${statusPill}<div class="hint">${fmtMoney(vc.paid_amount, vc.currency)} paid</div></td>
      <td>
        ${vc.status !== 'paid' ? `<button type="button" class="btn-sm" data-vc-pay="${vc.id}">Pay</button>` : ''}
        ${vc.paid_amount === 0 ? `<button type="button" class="btn-sm btn-danger" data-vc-del="${vc.id}">Delete</button>` : ''}
      </td>
    </tr>`;
  }).join('');
  return `
    <table class="simple">
      <thead><tr><th>Vendor</th><th>Invoice</th><th>Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="hint">No vendor costs recorded yet.</td></tr>`}</tbody>
    </table>
    <div class="hint" style="margin-top:8px;">Total vendor cost ${fmtMoney(job.totals.vendor_cost, job.quote_currency)} &middot; outstanding ${fmtMoney(job.totals.vendor_outstanding, job.quote_currency)}
      ${job.totals.margin != null ? ` &middot; margin <span class="money ${job.totals.margin >= 0 ? 'pos' : 'neg'}">${fmtMoney(job.totals.margin, job.quote_currency)}</span>` : ''}
    </div>
    <button type="button" class="btn-sm" id="addVendorCostBtn" style="margin-top:10px;">+ Add vendor cost</button>
    <form id="vendorCostForm" class="hidden" data-endpoint="/api/jobs/${job.id}/vendor-costs" style="margin-top:10px;">
      <div class="field-row">
        <div><label>Vendor name</label><input type="text" name="vendor_name" required /></div>
        <div><label>Invoice number</label><input type="text" name="invoice_number" /></div>
      </div>
      <label>Description</label><input type="text" name="description" />
      <div class="field-row">
        <div><label>Amount</label><input type="number" step="0.01" name="invoice_amount" required /></div>
        <div><label>Currency</label><input type="text" name="currency" value="${esc(job.quote_currency || 'SGD')}" /></div>
      </div>
      <label>Due date</label><input type="date" name="due_at" />
      <label>Vendor invoice document</label><input type="file" name="doc" accept="application/pdf,image/*" />
      <div class="error-text"></div>
      <button type="submit" class="btn-primary btn-sm" style="margin-top:8px;">Add</button>
    </form>
  `;
}

function stageMilestoneDone(job, key) {
  switch (key) {
    case 'quote_requested': return true;
    case 'quote_sent': return !!job.quote_sent_at;
    case 'accepted': return !!job.accepted_at;
    case 'collected': return !!job.collected_at;
    case 'in_transit': return !!job.shipped_at;
    case 'delivered': return !!job.delivered_at;
    case 'invoiced': return !!job.invoice_sent_at;
    case 'paid': return job.payment_status === 'paid';
    default: return false;
  }
}

function jobModalHtml(job) {
  let seenNotDone = false;
  const stepperHtml = STAGE_ORDER.map((key) => {
    const done = stageMilestoneDone(job, key);
    let cls = '';
    if (done) cls = 'done';
    else if (!seenNotDone) { cls = 'current'; seenNotDone = true; }
    return `<div class="step ${cls}">${esc(STAGE_LABELS[key])}</div>`;
  }).join('');
  const clientUrl = `${location.origin}/client.html?t=${job.client_token}`;
  return `
    <div style="display:flex;align-items:flex-start;gap:10px;">
      <div>
        <h3 style="margin:0;">${esc(job.client_name)} <span class="hint" style="font-family:ui-monospace,monospace;">${esc(job.job_code)}</span></h3>
        ${job.description ? `<div class="hint">${esc(job.description)}</div>` : ''}
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;">
        ${job.cancelled ? `<button type="button" class="btn-sm" id="reactivateBtn">Reactivate</button>` : `<button type="button" class="btn-sm btn-danger" id="cancelJobBtn">Cancel job</button>`}
        <button type="button" class="btn-sm" data-close>Close</button>
      </div>
    </div>
    ${job.cancelled ? `<div class="pill pill-grey" style="margin:8px 0;">Cancelled ${fmtDate(job.cancelled_at)} — ${esc(job.cancel_reason || '')}</div>` : ''}
    <div class="stepper">${stepperHtml}</div>
    <div class="detail-grid">
      <div>
        <div class="section">
          ${quoteBlockHtml(job)}
          ${acceptanceBlockHtml(job)}
          ${collectionBlockHtml(job)}
          ${shipmentBlockHtml(job)}
          ${deliveryBlockHtml(job)}
          ${invoiceBlockHtml(job)}
          ${paymentBlockHtml(job)}
        </div>
      </div>
      <div>
        <div class="section card">
          <h3>Client link</h3>
          <div class="hint">Share this so the client can follow their job — no login needed.</div>
          <div class="copy-link" style="margin-top:8px;">
            <input type="text" readonly value="${esc(clientUrl)}" id="clientLinkInput" />
            <button type="button" class="btn-sm" id="copyClientLinkBtn">Copy</button>
          </div>
        </div>
        <div class="section card">
          <h3>Vendor costs <span class="sub">not shown to the client</span></h3>
          ${vendorCostsHtml(job)}
        </div>
        <div class="section card">
          <h3>Activity</h3>
          <ul class="timeline">
            ${job.events.slice().reverse().map(e => `<li>${esc(e.note || e.type)}<div class="when">${esc(e.actor || '')} &middot; ${fmtDate(e.at)}</div></li>`).join('')}
          </ul>
        </div>
      </div>
    </div>
  `;
}

async function handleStageSubmit(e, jobId) {
  e.preventDefault();
  const form = e.target;
  const errEl = form.querySelector('.error-text');
  if (errEl) errEl.textContent = '';
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  try {
    if (form.dataset.json) {
      const json = {};
      form.querySelectorAll('[name]').forEach(el => { json[el.name] = el.value; });
      await api(form.dataset.endpoint, { method: 'POST', json });
    } else {
      const fd = collectFormData(form);
      await apiForm(form.dataset.endpoint, fd);
    }
    toast('Saved');
    await refreshJob(jobId);
    await loadJobs();
    await loadStats();
  } catch (err) {
    if (errEl) errEl.textContent = err.message;
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function refreshJob(id) {
  const job = await api('/api/jobs/' + id);
  renderJobModal(job);
}

function wireJobModal(job) {
  const root = document.getElementById('modalRoot');

  root.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.stage-block').classList.toggle('open'));
  });

  root.querySelectorAll('form[data-endpoint]').forEach(form => {
    form.addEventListener('submit', (e) => handleStageSubmit(e, job.id));
  });

  const cancelBtn = document.getElementById('cancelJobBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => openCancelJobModal(job));
  const reactivateBtn = document.getElementById('reactivateBtn');
  if (reactivateBtn) reactivateBtn.addEventListener('click', async () => {
    try {
      await api(`/api/jobs/${job.id}/reactivate`, { method: 'POST' });
      toast('Job reactivated');
      await refreshJob(job.id); await loadJobs(); await loadStats();
    } catch (e) { toast(e.message); }
  });

  const copyBtn = document.getElementById('copyClientLinkBtn');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    const input = document.getElementById('clientLinkInput');
    input.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(() => toast('Link copied')).catch(() => toast('Select and copy the link'));
    } else {
      document.execCommand('copy');
      toast('Link copied');
    }
  });

  const addVcBtn = document.getElementById('addVendorCostBtn');
  const vcForm = document.getElementById('vendorCostForm');
  if (addVcBtn && vcForm) addVcBtn.addEventListener('click', () => vcForm.classList.toggle('hidden'));

  root.querySelectorAll('[data-vc-pay]').forEach(btn => btn.addEventListener('click', () => openVendorPaymentModal(btn.dataset.vcPay, job)));
  root.querySelectorAll('[data-vc-del]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this vendor cost?')) return;
    try { await api(`/api/vendor-costs/${btn.dataset.vcDel}`, { method: 'DELETE' }); toast('Removed'); await refreshJob(job.id); }
    catch (e) { toast(e.message); }
  }));
  root.querySelectorAll('[data-del-payment]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Remove this payment entry?')) return;
    try {
      await api(`/api/jobs/${job.id}/payment/${btn.dataset.delPayment}`, { method: 'DELETE' });
      toast('Payment removed'); await refreshJob(job.id); await loadJobs(); await loadStats();
    } catch (e) { toast(e.message); }
  }));

  root.querySelectorAll('.photo-thumb').forEach(img => img.addEventListener('click', () => showLightbox(img.dataset.full)));
}

function renderJobModal(job) {
  showModal(jobModalHtml(job), { wide: true });
  wireJobModal(job);
}

async function openJob(id) {
  const job = await api('/api/jobs/' + id);
  renderJobModal(job);
}

function openCancelJobModal(job) {
  const reason = prompt('Reason for cancelling this job (min 4 characters):');
  if (reason === null) return;
  if (reason.trim().length < 4) { toast('Reason must be at least 4 characters'); return; }
  api(`/api/jobs/${job.id}/cancel`, { method: 'POST', json: { reason } })
    .then(async () => { toast('Job cancelled'); await refreshJob(job.id); await loadJobs(); await loadStats(); })
    .catch(e => toast(e.message));
}

function openVendorPaymentModal(vcId, job) {
  const vc = job.vendor_costs.find(v => v.id === vcId);
  if (!vc) return;
  showModal(`
    <h3>Record vendor payment — ${esc(vc.vendor_name)}</h3>
    <div class="hint">Outstanding: ${fmtMoney(vc.invoice_amount - vc.paid_amount, vc.currency)}</div>
    <form id="vcPayForm">
      <label>Amount</label><input type="number" step="0.01" name="amount" required />
      <label>Note</label><input type="text" name="note" />
      <label>Proof</label><input type="file" name="proof" accept="application/pdf,image/*" />
      <div class="error-text" id="vcPayErr"></div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" data-close>Cancel</button>
        <button type="submit" class="btn-primary btn-sm">Record</button>
      </div>
    </form>
  `);
  document.getElementById('vcPayForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = collectFormData(e.target);
    try {
      await apiForm(`/api/vendor-costs/${vcId}/payment`, fd);
      toast('Vendor payment recorded');
      openJob(job.id);
    } catch (err) { document.getElementById('vcPayErr').textContent = err.message; }
  });
}

// ---------------------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------------------
async function openUsersModal() {
  const users = await api('/api/users');
  showModal(`
    <h3>Users</h3>
    <table class="simple">
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody>${users.map(u => `
        <tr>
          <td>${esc(u.name)}</td><td>${esc(u.username)}</td>
          <td>${esc(u.role)}</td>
          <td>${u.disabled ? '<span class="pill pill-grey">Disabled</span>' : '<span class="pill pill-green">Active</span>'}</td>
          <td>
            <button type="button" class="btn-sm" data-toggle-disable="${u.id}" data-disabled="${u.disabled ? '1' : '0'}">${u.disabled ? 'Enable' : 'Disable'}</button>
            <button type="button" class="btn-sm btn-danger" data-del-user="${u.id}">Delete</button>
          </td>
        </tr>`).join('')}</tbody>
    </table>
    <h3 style="margin-top:16px;">Add user</h3>
    <form id="addUserForm">
      <div class="field-row">
        <div><label>Full name</label><input type="text" name="name" required /></div>
        <div><label>Username</label><input type="text" name="username" required /></div>
      </div>
      <div class="field-row">
        <div><label>Password</label><input type="password" name="password" required /></div>
        <div><label>Role</label><select name="role"><option value="staff">Staff</option><option value="admin">Admin</option></select></div>
      </div>
      <div class="error-text" id="addUserErr"></div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" data-close>Close</button>
        <button type="submit" class="btn-primary btn-sm">Add</button>
      </div>
    </form>
  `, { wide: true });

  document.getElementById('addUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const json = Object.fromEntries(fd.entries());
    try { await api('/api/users', { method: 'POST', json }); toast('User added'); openUsersModal(); }
    catch (err) { document.getElementById('addUserErr').textContent = err.message; }
  });

  document.querySelectorAll('[data-toggle-disable]').forEach(btn => btn.addEventListener('click', async () => {
    const disabled = btn.dataset.disabled !== '1';
    try { await api(`/api/users/${btn.dataset.toggleDisable}`, { method: 'PATCH', json: { disabled } }); openUsersModal(); }
    catch (err) { toast(err.message); }
  }));
  document.querySelectorAll('[data-del-user]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this user?')) return;
    try { await api(`/api/users/${btn.dataset.delUser}`, { method: 'DELETE' }); openUsersModal(); }
    catch (err) { toast(err.message); }
  }));
}

function signOut() {
  api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  signedOutRedirect();
}

// ---------------------------------------------------------------------------
async function boot() {
  document.getElementById('whoLabel').textContent = USER ? `${USER.name} (${USER.role})` : '';
  if (!USER || USER.role !== 'admin') document.getElementById('usersBtn').classList.add('hidden');
  document.getElementById('signOutBtn').addEventListener('click', signOut);
  document.getElementById('usersBtn').addEventListener('click', openUsersModal);
  document.getElementById('newJobBtn').addEventListener('click', openNewJobModal);
  document.getElementById('searchInput').addEventListener('input', debounce((e) => {
    filters.q = e.target.value.trim();
    loadJobs();
  }, 250));
  try {
    await loadStats();
    renderStageChips();
    await loadJobs();
  } catch (e) {
    toast(e.message);
  }
}
boot();
