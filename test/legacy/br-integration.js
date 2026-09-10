// The Connections panel, driven in a real browser: an operator issues a key,
// is shown it ONCE, adds a webhook, tests it against a live receiver, and
// revokes the key — on a desktop and on a phone.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const B = 'http://localhost:4717', R = 'http://localhost:4791', MK = '201432547E';

(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const vp of [{ w: 1440, h: 900, n: 'desktop' }, { w: 393, h: 851, n: 'Pixel 5' }]) {
    const ctx = await br.newContext({ viewport: { width: vp.w, height: vp.h } });
    const p = await ctx.newPage();
    const dialogs = [];
    p.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });

    await p.goto(B, { waitUntil: 'domcontentloaded' });
    await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
    await p.click('#loginBtn'); await p.waitForTimeout(2500);
    if (vp.w < 768) { await p.locator('#sidebarToggleBtn').click(); await p.waitForTimeout(600); }
    await p.locator('[data-tab="connections"]').click({ force: true }); await p.waitForTimeout(800);
    // Connections is behind the Administrator password gate.
    const pw = p.locator('#logPasswordInput');
    if (await pw.count() && await pw.isVisible()) {
      await pw.fill(MK);
      await p.getByRole('button', { name: /unlock|enter|ok/i }).first().click().catch(() => {});
      await p.keyboard.press('Enter').catch(() => {});
      await p.waitForTimeout(1200);
    }
    await p.locator('#secIntegration summary').click(); await p.waitForTimeout(1200);
    ok(await p.locator('#secIntegration').isVisible(), `${vp.n}: the Partner API section is on Connections`);
    ok(/x-api-key/.test(await p.locator('#secIntegration').textContent() || ''),
       `${vp.n}: it names the header a partner actually sends`);

    // ── Issue a key.
    const name = 'BrKey' + String(Date.now()).slice(-6);
    await p.locator('#apiKeyAddBtn').click(); await p.waitForTimeout(300);
    const scopes = p.locator('.ak-scope');
    ok(await scopes.count() >= 4, `${vp.n}: the scope ticks are built from what the server offers (${await scopes.count()})`);
    await p.fill('#akName', name);
    await scopes.first().check();                       // read
    dialogs.length = 0;
    await p.locator('#apiKeySaveBtn').click(); await p.waitForTimeout(1500);
    const shown = dialogs.join('\n');
    ok(/iok_[0-9a-f]{12}_[0-9a-f]{32}/.test(shown), `${vp.n}: ★ the key is SHOWN, once, in full`);
    ok(/can never be shown again/i.test(shown), `${vp.n}: …and the dialog says it cannot be shown again`);
    const key = (/iok_[0-9a-f]{12}_[0-9a-f]{32}/.exec(shown) || [])[0];

    const row = p.locator('#apiKeysTbody tr', { hasText: name });
    ok(await row.count() === 1, `${vp.n}: the key is listed`);
    const rowTxt = await row.first().textContent() || '';
    ok(/iok_…/.test(rowTxt) && !rowTxt.includes(key), `${vp.n}: ★ the list shows only the tail — never the key`);

    // It genuinely works, and only within its scope.
    const okRead = await p.evaluate(k => fetch('/api/orders?range=today', { headers: { 'x-api-key': k } }).then(r => r.status), key);
    ok(okRead === 200, `${vp.n}: the issued key really reads (${okRead})`);
    const noWrite = await p.evaluate(k => fetch('/api/orders/intake', { method: 'POST', headers: { 'x-api-key': k, 'Content-Type': 'application/json' }, body: '{"client":"x","orders":[]}' }).then(r => r.status), key);
    ok(noWrite === 403, `${vp.n}: …and is refused the write it was not given (${noWrite})`);

    // ── Add a webhook and test it against the live receiver.
    const hname = 'BrHook' + String(Date.now()).slice(-6);
    await p.locator('#webhookAddBtn').click(); await p.waitForTimeout(300);
    await p.fill('#whName', hname);
    await p.fill('#whUrl', R + '/hook');
    await p.locator('.wh-event').first().check();
    dialogs.length = 0;
    await p.locator('#webhookSaveBtn').click(); await p.waitForTimeout(1500);
    ok(/whsec_/.test(dialogs.join('\n')), `${vp.n}: the signing secret is shown once`);
    ok(/HMAC-SHA256/.test(dialogs.join('\n')), `${vp.n}: …with how to verify it`);

    const hrow = p.locator('#webhooksTbody tr', { hasText: hname });
    ok(await hrow.count() === 1, `${vp.n}: the webhook is listed`);
    dialogs.length = 0;
    await hrow.first().locator('.wh-test').click(); await p.waitForTimeout(2000);
    ok(/took it/i.test(dialogs.join('\n')), `${vp.n}: ★ Test reports what the receiver actually said`);

    // ── Clean up through the screen, which is also the revoke test.
    dialogs.length = 0;
    await hrow.first().locator('.wh-del').click(); await p.waitForTimeout(1200);
    await row.first().locator('.ak-del').click(); await p.waitForTimeout(1200);
    ok(await p.locator('#apiKeysTbody tr', { hasText: name }).count() === 0, `${vp.n}: the revoked key is off the list`);
    ok(await p.locator('#webhooksTbody tr', { hasText: hname }).count() === 0, `${vp.n}: the deleted webhook is off the list`);
    const doc = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    ok(doc, `${vp.n}: no sideways scroll`);
    // The 401 a revoked key gets is asserted in the API suite, not here: the
    // office app's own fetch wrapper force-reloads the page on ANY 401 (its
    // session-expired handler), so asking for one from inside the page
    // destroys the execution context mid-test. The app is behaving correctly;
    // the test simply must not stand in front of it.
    await ctx.close();
  }
  await br.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
