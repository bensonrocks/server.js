// Surveillance → "Packing video & info" on COMPLETED orders.
// Self-contained: it does NOTHING unless /api/surveillance/status says this
// login may use Surveillance. Then it only ADDS a 🎥 button to completed order
// rows (and to the completed-order print modals); it never changes or removes
// any existing element or handler.
(function () {
  'use strict';
  const tok = () => localStorage.getItem('wms_token') || '';
  const H = () => ({ 'x-auth-token': tok(), 'Content-Type': 'application/json' });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sgt = t => t ? new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Singapore', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' SGT' : '—';
  const sgtT = t => t ? new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore', hour12: false }) : '—';
  const dur = s => s == null ? '—' : (s >= 60 ? Math.floor(s / 60) + 'm ' : '') + (s % 60) + 's';
  let on = false, checkedFor = null;

  async function check() {
    const t = tok(); if (t === checkedFor) return; checkedFor = t; on = false; document.querySelectorAll('.surv-pv-btn').forEach(b => b.remove()); if (!t) return;
    try { const r = await fetch('/api/surveillance/status', { headers: H() }); const s = r.ok ? await r.json() : null; on = !!(s && s.visible); } catch { on = false; }
    if (on) { injectCss(); decorate(); }
  }
  function injectCss() {
    if (document.getElementById('survOrdCss')) return;
    const st = document.createElement('style'); st.id = 'survOrdCss';
    st.textContent = `
.surv-pv-btn{border:1px solid #c7d2fe;background:#eef2ff;color:#3730a3;border-radius:6px;padding:2px 8px;font-size:12px;cursor:pointer;margin-left:4px;white-space:nowrap}
.surv-pv-btn:hover{background:#e0e7ff}
#survPvOverlay{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:10050;display:flex;align-items:center;justify-content:center}
#survPv{background:#fff;color:#0f172a;width:min(1180px,96vw);max-height:92vh;overflow:auto;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.35);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
#survPv header{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid #e2e8f0;position:sticky;top:0;background:#fff;z-index:1}
#survPv header h2{margin:0;font-size:18px}#survPv header small{color:#64748b;font-weight:500;margin-left:8px}
#survPv .x{border:0;background:#f1f5f9;border-radius:8px;width:32px;height:32px;font-size:18px;cursor:pointer}
#survPv .grid{display:grid;grid-template-columns:1.05fr 1fr;gap:16px;padding:16px 20px}
#survPv .card{border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px}
#survPv h3{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#475569}
#survPv dl{display:grid;grid-template-columns:120px 1fr;gap:4px 10px;margin:0}#survPv dt{color:#64748b}#survPv dd{margin:0;font-weight:600}
#survPv .pill{display:inline-block;border-radius:999px;padding:1px 10px;font-weight:700;font-size:12px}
.sp-ok{background:#dcfce7;color:#166534}.sp-bad{background:#fee2e2;color:#991b1b}.sp-warn{background:#fef3c7;color:#92400e}.sp-mute{background:#f1f5f9;color:#475569}
#survPv table{width:100%;border-collapse:collapse;font-size:13px}#survPv td,#survPv th{padding:4px 6px;border-bottom:1px solid #f1f5f9;text-align:left}
#survPv th{color:#64748b;font-weight:600}#survPv tr.bad td{background:#fef2f2;color:#991b1b}
#survPv .tl{max-height:190px;overflow:auto}
#survPv video{width:100%;border-radius:8px;background:#000;display:block;max-height:340px}
#survPv .btn{border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;background:#4f46e5;color:#fff}
#survPv .btn.sec{background:#e2e8f0;color:#0f172a}#survPv .muted{color:#64748b}
#survPv code{background:#f1f5f9;padding:1px 6px;border-radius:4px;font-size:12px}`;
    document.head.appendChild(st);
  }
  function btn(order) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'surv-pv-btn'; b.dataset.survOrder = order;
    b.title = 'Packing video & info'; b.innerHTML = '&#127909; Video';
    b.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); openPanel(order); }, true);
    return b;
  }
  function decorate() {
    if (!on) return;
    document.querySelectorAll('tr.orders-tr.status-done').forEach(tr => {
      if (tr.querySelector('.surv-pv-btn')) return;
      const cell = tr.querySelector('td:last-child'); if (cell && tr.dataset.order) cell.appendChild(btn(tr.dataset.order));
    });
    for (const [ov, noId] of [['printOrderLabelOverlay', 'printLabelOrderNo'], ['printWaybillOverlay', 'printOrderNo']]) {
      const o = document.getElementById(ov), n = document.getElementById(noId);
      if (!o || !n || o.classList.contains('hidden')) continue;
      let b = o.querySelector('.surv-pv-btn');
      if (!b) { b = btn(n.textContent.trim()); b.style.marginTop = '8px'; n.parentElement.appendChild(b); }
      b.dataset.survOrder = n.textContent.trim();
      b.onclick = e => { e.stopPropagation(); o.classList.add('hidden'); openPanel(b.dataset.survOrder); };
    }
  }
  let pollT = null;
  async function openPanel(order) {
    close();
    const ov = document.createElement('div'); ov.id = 'survPvOverlay';
    ov.innerHTML = `<div id="survPv"><header><h2>&#127909; Packing video &amp; info<small>${esc(order)}</small></h2><button class="x" title="Close">&times;</button></header><div id="survPvBody" style="padding:20px">Loading…</div></div>`;
    ov.addEventListener('click', e => { if (e.target === ov || e.target.classList.contains('x')) close(); });
    document.body.appendChild(ov);
    render(order);
  }
  function close() { clearInterval(pollT); pollT = null; const o = document.getElementById('survPvOverlay'); if (o) { o.querySelectorAll('video').forEach(v => { if (v.src.startsWith('blob:')) URL.revokeObjectURL(v.src); }); o.remove(); } }
  async function render(order, keepVideo) {
    const body = document.getElementById('survPvBody'); if (!body) return;
    const r = await fetch(`/api/surveillance/order/${encodeURIComponent(order)}/packing`, { headers: H() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { body.innerHTML = `<p class="muted">${esc(d.error || 'Not available')}</p>`; return; }
    const w = d.waybill || {};
    const wbPill = w.result === 'matched' ? `<span class="pill sp-ok">&#10004; MATCHED</span>` : w.result === 'mismatch' ? `<span class="pill sp-bad">&#10006; MISMATCH</span>` : `<span class="pill sp-warn">&#9888; NOT SCANNED</span>`;
    const seen = (w.seenOnCamera || []).map(s => `<div><span class="pill sp-ok">&#128247; seen on camera</span> at <b>${sgtT(s.at)}</b> <span class="muted">(${esc(s.type || '')}, ${esc(s.fileName)} @ ${esc(s.seekHms)})</span></div>`).join('');
    const tl = d.timeline.map(e => {
      const bad = e.kind === 'wrong' || e.over || e.kind === 'waybill_mismatch';
      const what = e.kind === 'scan' ? `<b>${esc(e.sku)}</b> ${e.qty}/${e.expected ?? '?'}${e.over ? ' — OVER-SCAN' : ''}`
        : e.kind === 'wrong' ? `<b>WRONG SKU</b> ${esc(e.sku)}` : e.kind === 'waybill_matched' ? `Waybill &#10004; ${esc(e.value)}`
        : e.kind === 'waybill_mismatch' ? `Waybill MISMATCH ${esc(e.value)}` : esc(e.kind + (e.sku ? ' ' + e.sku : ''));
      return `<tr class="${bad ? 'bad' : ''}"><td style="white-space:nowrap">${sgtT(e.at)}</td><td>${what}</td></tr>`;
    }).join('') || '<tr><td class="muted" colspan="2">No scan events recorded</td></tr>';
    const v = d.video || {}, rec = v.recording, c = d.clip;
    let clipHtml;
    if (!rec) clipHtml = `<p><span class="pill sp-mute">No recording</span> <span class="muted">No recording is registered for this station at this time yet.</span></p>`;
    else if (!c) clipHtml = `<button class="btn" id="survGetClip">&#9986; Get clip</button> <span class="muted">The warehouse PC cuts ${dur(rec.clipLengthSec)} and uploads it.</span>`;
    else if (c.status === 'ready') clipHtml = `<video id="survClipVid" controls playsinline preload="auto"></video>
      <p style="margin:8px 0 0"><span class="pill sp-ok">READY</span> <button class="btn sec" id="survDl">&#11015; Download MP4</button> <span class="muted">${(c.size / 1048576).toFixed(1)} MB · ready ${sgt(c.readyAt)}</span></p>`;
    else if (c.status === 'failed') clipHtml = `<p><span class="pill sp-bad">FAILED</span> ${esc(c.reason)}</p><button class="btn" id="survGetClip" data-retry="1">&#8635; Try again</button>`;
    else clipHtml = `<p><span class="pill sp-warn">REQUESTED</span> <span class="muted">Waiting for the warehouse recorder to cut and upload the clip… (requested ${sgtT(c.requestedAt)} by ${esc(c.requestedBy)})</span></p>`;
    if (keepVideo && c && c.status === 'ready' && document.getElementById('survClipVid')) return;
    body.style.padding = '0';
    body.innerHTML = `<div class="grid">
     <div class="card"><h3>Packing info</h3><dl>
      <dt>Station</dt><dd>${esc(d.station)}</dd><dt>Packer</dt><dd>${esc(d.packer)} <span class="muted">(${esc(d.login)})</span></dd>
      <dt>Client</dt><dd>${esc(d.client)}</dd><dt>Courier</dt><dd>${esc(d.courier || '—')}</dd><dt>Tracking</dt><dd><code style="font-size:13px">${esc(d.tracking || '—')}</code></dd>
      <dt>Start</dt><dd>${sgt(d.startTime)}</dd><dt>End</dt><dd>${sgt(d.endTime)}</dd><dt>Duration</dt><dd>${dur(d.durationSec)}</dd>
      <dt>Waybill</dt><dd>${wbPill} ${w.scannedAt ? `<span class="muted">scanned ${sgtT(w.scannedAt)}${w.value ? ' · ' + esc(w.value) : ''}</span>` : ''}${seen}</dd>
     </dl>
     <h3 style="margin-top:14px">Items</h3><table><tr><th>SKU</th><th>Scanned / expected</th></tr>${d.lines.map(l => `<tr class="${l.scanned !== l.expected ? 'bad' : ''}"><td>${esc(l.sku)}</td><td>${l.scanned} / ${l.expected} ${l.scanned === l.expected ? '&#10004;' : ''}</td></tr>`).join('')}</table>
     <h3 style="margin-top:14px">Scan timeline (SGT)</h3><div class="tl"><table>${tl}</table></div></div>
     <div class="card"><h3>Video</h3>
      ${rec ? `<dl><dt>Camera</dt><dd>${esc(rec.camera)}</dd><dt>Recording</dt><dd><code>${esc(rec.fileName)}</code></dd>
       <dt>Seek to</dt><dd>${esc(rec.seekHms)} <span class="muted">(−${v.padBeforeSec}s / +${v.padAfterSec}s padding)</span></dd>
       <dt>Window</dt><dd>${sgtT(v.windowStart)} → ${sgtT(v.windowEnd)}</dd></dl><div style="margin-top:12px">${clipHtml}</div>`
        : `<dl><dt>Window</dt><dd>${sgtT(v.windowStart)} → ${sgtT(v.windowEnd)}</dd></dl><div style="margin-top:12px">${clipHtml}</div>`}
     </div></div>`;
    const gc = document.getElementById('survGetClip');
    if (gc) gc.onclick = async () => {
      gc.disabled = true;
      const x = await fetch(`/api/surveillance/order/${encodeURIComponent(order)}/clip`, { method: 'POST', headers: H(), body: JSON.stringify({ retry: !!gc.dataset.retry }) });
      if (!x.ok) { const j = await x.json().catch(() => ({})); alert(j.error || 'Could not request the clip'); }
      render(order);
    };
    clearInterval(pollT); pollT = null;
    if (c && (c.status === 'requested' || c.status === 'claimed')) pollT = setInterval(() => render(order, true), 4000);
    if (c && c.status === 'ready') {
      const vid = document.getElementById('survClipVid');
      const blob = await (await fetch(`/api/surveillance/clips/${c.id}/video`, { headers: H() })).blob();
      if (c.hasPoster) { try { const pb = await (await fetch(`/api/surveillance/clips/${c.id}/poster`, { headers: H() })).blob(); vid.poster = URL.createObjectURL(pb); } catch {} }
      vid.src = URL.createObjectURL(blob);
      document.getElementById('survDl').onclick = async () => {
        const b = await (await fetch(`/api/surveillance/clips/${c.id}/video?download=1`, { headers: H() })).blob();
        const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${order}-packing.mp4`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      };
    }
  }
  window.IdealOneSurveillanceOrder = { open: openPanel };
  let raf = 0;
  new MutationObserver(() => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (tok() !== checkedFor) check(); else if (on) decorate(); }); }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  check();
})();
