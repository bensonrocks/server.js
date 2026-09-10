const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); // phone-ish width
  const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad/shots';

  await page.goto('http://localhost:4699/');
  await page.waitForSelector('#loginName', { timeout: 15000 });
  await page.fill('#loginName', 'demo');
  await page.fill('#loginIC', 'demo');
  await page.click('#loginBtn');
  await page.waitForTimeout(1500);

  await page.click('#logAccessBtn');
  await page.waitForTimeout(500);
  await page.fill('#logPasswordInput', '201432547E');
  await page.click('#logPasswordSubmitBtn');
  await page.waitForTimeout(1000);
  await page.click('[data-admin-tab="reports"]');
  await page.waitForTimeout(800);

  // Deliberately set the SHARED range (top) to one period...
  await page.fill('#adminTab-reports .rep-from', '2019-01-01');
  await page.fill('#adminTab-reports .rep-to', '2019-01-02');
  // ...and the THROUGHPUT-specific fields to a DIFFERENT period.
  await page.fill('#adminTab-reports .rep-throughput-from', '2026-08-01');
  await page.fill('#adminTab-reports .rep-throughput-to', '2026-08-31');

  const target = await page.$('#adminTab-reports button[data-report="throughput"]');
  await target.scrollIntoViewIfNeeded();
  await target.evaluate(el => { el.style.outline = '4px solid #ef4444'; });
  await page.screenshot({ path: `${S}/period-row.png` });

  // Intercept the ACTUAL outgoing request URL.
  let capturedUrl = null;
  page.on('request', req => {
    if (req.url().includes('/api/master/report/throughput')) capturedUrl = req.url();
  });
  await target.click();
  await page.waitForTimeout(1500);

  console.log('CAPTURED URL:', capturedUrl);
  const ok = capturedUrl && capturedUrl.includes('from=2026-08-01') && capturedUrl.includes('to=2026-08-31')
             && !capturedUrl.includes('2019-01');
  console.log('RESULT:', ok ? 'PASS - used the throughput-specific dates, not the shared range' : 'FAIL');
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
