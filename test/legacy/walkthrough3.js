const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad/shots';

  await page.goto('http://localhost:4701/');
  await page.waitForSelector('#loginName', { timeout: 15000 });
  await page.fill('#loginName', 'demo');
  await page.fill('#loginIC', 'demo');
  await page.click('#loginBtn');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${S}/01-logged-in.png` });

  // Click the sidebar Administrator button.
  await page.click('#logAccessBtn');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${S}/02-password-overlay.png` });

  // Unlock with the master key.
  await page.fill('#logPasswordInput', '201432547E');
  await page.click('#logPasswordSubmitBtn');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${S}/03-admin-panel-open.png` });

  // Click the Reports sub-tab inside the Administrator panel.
  await page.click('[data-admin-tab="reports"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${S}/04-admin-reports-top.png` });

  // Scroll to the new Total Throughput Time row and highlight it.
  const target = await page.$('button[data-report="throughput"]');
  if (target) {
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await target.evaluate(el => { el.style.outline = '4px solid #ef4444'; el.style.outlineOffset = '3px'; });
  }
  await page.screenshot({ path: `${S}/05-throughput-report-found.png` });

  console.log('DONE');
  await browser.close();
})().catch(async (e) => { console.error('ERR', e.message); process.exit(1); });
