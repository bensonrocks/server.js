const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 393, height: 851 } }); // Pixel 5 width
  const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad/shots';

  await page.goto('http://localhost:4701/');
  await page.waitForSelector('#loginName', { timeout: 15000 });
  await page.fill('#loginName', 'demo');
  await page.fill('#loginIC', 'demo');
  await page.click('#loginBtn');
  await page.waitForTimeout(1500);

  await page.click('#sidebarToggleBtn').catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${S}/ph-01-sidebar.png` });

  await page.click('#logAccessBtn');
  await page.waitForTimeout(500);
  await page.fill('#logPasswordInput', '201432547E');
  await page.click('#logPasswordSubmitBtn');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${S}/ph-02-admin-open.png` });

  await page.click('[data-admin-tab="reports"]');
  await page.waitForTimeout(800);

  const target = await page.$('#adminTab-reports button[data-report="throughput"]');
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${S}/ph-03-throughput-row-BEFORE.png` });

  // Check horizontal overflow.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('horizontal overflow px:', overflow);

  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
