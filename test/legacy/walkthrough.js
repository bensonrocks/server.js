const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad/shots';

  await page.goto('http://localhost:4695/');
  await page.waitForSelector('#loginId, input[name="id"], #username', { timeout: 15000 }).catch(() => {});
  // Try common login field ids used by this app.
  const idSel = await page.$('#loginId') ? '#loginId' : (await page.$('#username') ? '#username' : 'input[type="text"]');
  const pwSel = await page.$('#loginPassword') ? '#loginPassword' : (await page.$('#password') ? '#password' : 'input[type="password"]');
  await page.fill(idSel, 'demo');
  await page.fill(pwSel, 'demo');
  await page.screenshot({ path: `${S}/01-login.png` });
  await page.click('button[type="submit"], #loginBtn, .login-btn').catch(async () => {
    await page.keyboard.press('Enter');
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${S}/02-after-login.png` });

  // Open sidebar Administrator.
  const adminBtn = await page.$('[data-tab="administrator"], button:has-text("Administrator"), a:has-text("Administrator")');
  if (adminBtn) { await adminBtn.click(); await page.waitForTimeout(800); }
  await page.screenshot({ path: `${S}/03-admin-click.png` });

  // Password overlay may appear — try typing the master key.
  const pwOverlayInput = await page.$('#logPasswordInput, .log-password-input, input[placeholder*="assword"]');
  if (pwOverlayInput) {
    await pwOverlayInput.fill('201432547E');
    await page.screenshot({ path: `${S}/04-overlay-filled.png` });
    const unlockBtn = await page.$('button:has-text("Unlock"), button:has-text("Continue"), button:has-text("OK")');
    if (unlockBtn) await unlockBtn.click(); else await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: `${S}/05-admin-open.png` });

  // Click the Reports sub-tab inside Administrator.
  const repTab = await page.$('[data-admin-tab="reports"], button:has-text("Reports")');
  if (repTab) { await repTab.click(); await page.waitForTimeout(800); }
  await page.screenshot({ path: `${S}/06-reports-tab.png`, fullPage: true });

  console.log('DONE. URL:', page.url());
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
