const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad/shots';

  await page.goto('http://localhost:4703/');
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

  // Confirm the fields load BLANK (no default).
  const fromVal = await page.$eval('#adminTab-reports .rep-throughput-from', el => el.value);
  const toVal   = await page.$eval('#adminTab-reports .rep-throughput-to', el => el.value);
  console.log('field values on load: from=' + JSON.stringify(fromVal) + ' to=' + JSON.stringify(toVal));

  // Click the button with both fields blank -- must NOT fire a network request.
  let requestFired = false;
  page.on('request', req => { if (req.url().includes('/api/master/report/throughput')) requestFired = true; });
  const target = await page.$('#adminTab-reports button[data-report="throughput"]');
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await page.waitForTimeout(1000);
  const errText = await page.$eval('#adminTab-reports .report-status', el => el.textContent).catch(() => '');
  await page.screenshot({ path: `${S}/nodef-01-blocked.png` });
  console.log('inline error text:', JSON.stringify(errText));
  console.log('request fired while blank:', requestFired);

  // Now fill both dates and click -- the request SHOULD fire this time.
  await page.fill('#adminTab-reports .rep-throughput-from', '2026-07-01');
  await page.fill('#adminTab-reports .rep-throughput-to', '2026-08-31');
  requestFired = false;
  await target.click();
  await page.waitForTimeout(1200);
  console.log('request fired once both dates set:', requestFired);
  await page.screenshot({ path: `${S}/nodef-02-filled.png` });

  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
