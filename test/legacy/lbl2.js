// THE LABEL READER, hardened against real-world reply shapes:
//  1. rows under an unknown container with unknown field spellings
//     (shipmentlabellist / FormatType / FileData) now ATTACH — the old
//     reader returned [] and waited for ever as "not generated yet";
//  2. a reply with NO row container is flagged sync_label_unusable with the
//     KEY NAMES seen, never mistaken for "come back later".
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const B = 'http://localhost:4636';
const MK = '201432547E';
const T0 = new Date().toISOString();

(async () => {
  const login = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'x-auth-token': login.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: H, ...o }).then(r => r.json());

  // A store of its own, pointing at the tricky mock, label pull ON.
  const stores = await J('/api/master/zort/stores');
  let store = stores.find(s => s.clientName === 'LblCo');
  if (!store) {
    const made = await J('/api/master/zort/stores', { method: 'POST', body: JSON.stringify({
      clientName: 'LblCo', storename: 'lblco', apikey: 'k', apisecret: 's',
      endpoint: 'http://localhost:4930', labelSync: true, completeAction: 'none',
    }) });
    store = made.store || (await J('/api/master/zort/stores')).find(s => s.clientName === 'LblCo');
  }
  ok(!!store && store.labelSync !== false, `LblCo store ready with label pull on (${store?.id})`);

  // ── PULL imports both orders and queues their label jobs.
  const p1 = await J(`/api/master/zort/stores/${store.id}/pull`, { method: 'POST' });
  const r1 = p1.result || p1;
  ok((r1.created || 0) >= 2 || (r1.skippedExisting || 0) >= 2, `pull brought the two orders in (${JSON.stringify(r1).slice(0, 80)})`);

  // ── DRAIN the outbox — the label fetch runs NOW.
  const d1 = await J('/api/master/zort/outbox/drain', { method: 'POST' });
  await new Promise(r => setTimeout(r, 2500));

  const db = JSON.parse(require('fs').readFileSync(
    '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad/sup/tenants/default/db.json', 'utf8'));
  const audit = (db.auditLog || []).filter(e => e.at >= T0);

  // 1. THE WEIRD-SHAPED PDF ATTACHES.
  const imported = audit.find(e => e.type === 'sync_label_imported' && e.order === 'PLBL-1');
  ok(!!imported, `PLBL-1's label imported through the unknown shape (${JSON.stringify(imported || {}).slice(0, 100)})`);
  const attached = Object.entries(db.orderLabels || {}).some(([k]) => k === 'PLBL-1');
  ok(attached, 'and is attached to the order');
  const viaFallback = audit.find(e => e.type === 'sync_label_via_fallback' && e.order === 'PLBL-1');
  ok(viaFallback?.via === 'list-data', `read from the inline base64 bytes (${viaFallback?.via})`);

  // 2. THE UNSHAPED REPLY IS FLAGGED WITH ITS KEY NAMES.
  const unusable = audit.find(e => e.type === 'sync_label_unusable' && e.order === 'PLBL-2');
  ok(!!unusable, 'PLBL-2 is flagged, not waited on');
  ok(unusable?.why === 'unshaped' && (unusable?.keysSeen || []).includes('labelinfo'),
     `with the reply's own key names on the trail (${JSON.stringify(unusable?.keysSeen)})`);
  ok(!audit.some(e => e.type === 'sync_label_imported' && e.order === 'PLBL-2'), 'and nothing was invented for it');

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
