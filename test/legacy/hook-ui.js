const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636', MK = '201432547E';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  const dialogs = [];
  p.on('dialog', async d => {
    dialogs.push({ type: d.type(), msg: d.message() });
    if (d.type() === 'prompt') await d.accept('https://idealone.tech').catch(() => {});
    else await d.accept().catch(() => {});
  });
  await p.goto(BASE); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-tab="connections"]')?.click());
  await p.waitForTimeout(700);
  if (await p.isVisible('#logPasswordOverlay').catch(() => false)) {
    await p.fill('#logPasswordInput', MK); await p.click('#logPasswordSubmitBtn'); await p.waitForTimeout(2000);
  }
  await p.evaluate(() => { const s = document.getElementById('secStores'); if (s) s.open = true; });
  await p.waitForTimeout(1500);

  // TARGET THE STORE WHOSE HUB IS ACTUALLY UP. The first row is a store
  // pointing at a dead mock, and "the channel did not confirm it" is the RIGHT
  // answer there — asserting against it would be testing the wrong thing.
  const sel = '.z-hook';
  // Search FROM the Push buttons, not from every row on the page — the Orders
  // table also mentions ExCo, and matching on text alone found an order row.
  const hookOf = () => `[...document.querySelectorAll('.z-hook')].find(b => /ExCo/.test(b.closest('tr').textContent))`;
  const pick = async () => p.evaluate(`!!(${hookOf()})`);
  const clickHook = () => p.evaluate(`(${hookOf()})?.click()`);
  ok(await pick(), 'the live store has a Push button');
  const btns = await p.evaluate(() => [...document.querySelectorAll('.z-hook')].length);
  ok(btns > 0, `every connected store has a Push button (${btns})`);
  const title = await p.evaluate(() => document.querySelector('.z-hook')?.getAttribute('title') || '');
  ok(/instead of us asking/.test(title), 'saying what it is for, in words');

  // Turn it ON.
  await clickHook();
  await p.waitForTimeout(3000);
  ok(dialogs.some(d => d.type === 'prompt' && /public https address/.test(d.msg)),
     'turning it on asks for the public address — only the operator knows it');
  ok(dialogs.some(d => /Push registered/.test(d.msg)), 'and confirms it registered');
  ok(dialogs.some(d => /Keep this URL private/.test(d.msg)),
     'with the warning that the URL IS the secret');

  // Open it again — now it offers to stop.
  dialogs.length = 0;
  await clickHook();
  await p.waitForTimeout(3000);
  ok(dialogs.some(d => /Push is ON/.test(d.msg)), 'opening it again reports the live state');
  ok(dialogs.some(d => /Recent pushes/.test(d.msg)), 'and shows what has actually arrived');
  ok(dialogs.some(d => /scheduled pull carries on/.test(d.msg)),
     'making clear the sweep is not switched off with it');
  // The confirm was auto-accepted, so it should now be off.
  await p.waitForTimeout(1500);
  const all = await (await fetch(`${BASE}/api/master/zort/stores`, { headers: { 'x-master-key': MK } })).json();
  const exco = all.find(x => x.clientName === 'ExCo');
  const off = await (await fetch(`${BASE}/api/master/zort/stores/${exco.id}/webhook`,
    { headers: { 'x-master-key': MK } })).json();
  ok(off.registered === false, 'and OK really does stop it');
  await p.screenshot({ path: 'hook-ui.png' });
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
