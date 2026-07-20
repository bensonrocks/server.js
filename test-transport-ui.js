const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1024, height: 1200 } });
  
  try {
    console.log('Opening app...');
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    
    console.log('Logging in...');
    await page.fill('#loginName', 'demo', { timeout: 5000 });
    await page.fill('#loginIC', 'password123', { timeout: 5000 });
    await page.click('#loginBtn', { timeout: 5000 });
    await page.waitForTimeout(3000);
    
    console.log('Navigating to Transport tab...');
    await page.click('[data-tab="transport"]', { timeout: 5000 });
    await page.waitForTimeout(2000);
    
    console.log('Taking full page screenshot...');
    await page.screenshot({ path: '/tmp/claude-0/-home-user-server-js/4b7fa832-ce33-5952-aada-1bdabeb36d01/scratchpad/transport-ui-improved.png', fullPage: true });
    
    console.log('✅ Screenshot saved');
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
  }
})();
