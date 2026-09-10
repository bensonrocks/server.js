// The Connections page: five sections, only the store table open by default,
// each one remembering whether it was left open. And the probe's fifth question
// — "is there actually a label?" — reachable from the store row.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636', MK = '201432547E', HUB = 'http://localhost:4926';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let T = '';
// Connections is Administrator-only: the tab opens a password overlay first.
const openConnections = async (p) => {
  await p.evaluate(() => document.querySelector('[data-tab="connections"]')?.click());
  await p.waitForTimeout(700);
  if (await p.isVisible('#logPasswordOverlay').catch(() => false)) {
    await p.fill('#logPasswordInput', '201432547E');
    await p.click('#logPasswordSubmitBtn');
    await p.waitForTimeout(1800);
  }
  await p.waitForTimeout(1500);
};
const J = async (p, o = {}) => { const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-master-key': MK, 'x-auth-token': T, ...(o.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

(async () => {
  T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;
  for (const s of ((await J('/api/master/zort/stores')).body?.stores || [])) if (s.clientName === 'PbCo') await J(`/api/master/zort/stores/${s.id}`, { method: 'DELETE' });
  await J('/api/master/zort/stores', { method: 'POST', body: JSON.stringify({
    clientName: 'PbCo', storename: 'hub', apikey: 'k', apisecret: 's', endpoint: HUB, enabled: true, completeAction: 'none' }) });

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, vp] of [['desktop', { width: 1440, height: 950 }], ['Pixel 5', { width: 393, height: 851 }]]) {
    const ctx = await b.newContext({ viewport: vp });
    const p = await ctx.newPage();
    const dialogs = [];
    p.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
    await p.goto(BASE); await p.waitForTimeout(1500);
    await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
    await p.click('#loginBtn'); await p.waitForTimeout(3000);
    // Connections sits behind the Administrator password gate — unlock once.
    await openConnections(p);

    const secs = await p.evaluate(() => [...document.querySelectorAll('.conn-sec')].map(s => ({
      id: s.id, open: s.open, title: s.querySelector('.cs-t')?.textContent?.trim() || '',
      hint: s.querySelector('.cs-h')?.textContent?.trim() || '' })));
    ok(secs.length === 5, `[${label}] the page is five collapsible sections (${secs.length})`);
    ok(secs.every(s => s.title), `[${label}] each says what it is`);
    ok(secs.every(s => s.hint), `[${label}] and what is inside it, so a closed one is not a mystery`);
    const open = secs.filter(s => s.open);
    ok(open.length === 1 && open[0].id === 'secStores',
       `[${label}] only the store table opens by default — the part used daily (${open.map(s => s.id)})`);

    // THE PAGE IS ACTUALLY SHORTER. That was the whole ask.
    const h = await p.evaluate(() => document.getElementById('tab-connections').scrollHeight);
    await p.evaluate(() => document.querySelectorAll('.conn-sec').forEach(s => { s.open = true; }));
    await p.waitForTimeout(400);
    const hAll = await p.evaluate(() => document.getElementById('tab-connections').scrollHeight);
    ok(hAll > h * 1.5, `[${label}] collapsed is far shorter than expanded (${h}px vs ${hAll}px)`);
    await p.evaluate(() => document.querySelectorAll('.conn-sec').forEach(s => { s.open = s.id === 'secStores'; }));
    await p.waitForTimeout(300);

    // ── THE CHOICE STICKS. Anything else is an irritation twice a day.
    await p.evaluate(() => { const s = document.getElementById('secHealth'); s.open = true; s.dispatchEvent(new Event('toggle')); });
    await p.waitForTimeout(400);
    await p.reload(); await p.waitForTimeout(3000);
    await openConnections(p);
    ok(await p.evaluate(() => document.getElementById('secHealth')?.open === true),
       `[${label}] a section left open is still open after a reload`);
    await p.screenshot({ path: `conn-sections-${vp.width}.png`, fullPage: true });

    // ── AND THE PROBE ANSWERS THE LABEL QUESTION.
    await p.evaluate(() => { const s = document.getElementById('secStores'); if (s) s.open = true; });
    await p.waitForTimeout(500);
    await p.evaluate(() => document.querySelector('.z-probe')?.click());
    await p.waitForTimeout(4000);
    const msg = dialogs.find(m => /hub probe/i.test(m)) || '';
    ok(/GetShipmentLabels/.test(msg), `[${label}] the probe reports the label question`);
    ok(/Is there a label for order/.test(msg), `[${label}] in plain words`);
    ok(/NO label for this order yet|HAS a label/.test(msg), `[${label}] with a verdict, not just a payload`);
    await ctx.close();
  }
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
