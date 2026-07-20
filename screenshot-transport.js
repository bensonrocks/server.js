const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  
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
    
    console.log('Taking screenshot of Transport list...');
    await page.screenshot({ path: '/tmp/claude-0/-home-user-server-js/4b7fa832-ce33-5952-aada-1bdabeb36d01/scratchpad/transport-01-list.png', fullPage: false });
    
    console.log('✅ Screenshot 1 saved');
    
    // Scroll down to see more of the list
    await page.locator('#transportList').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    
    // Click on first View button in the list
    console.log('Clicking first View button...');
    const viewButtons = await page.locator('#transportList button:has-text("View")');
    const count = await viewButtons.count();
    console.log(`Found ${count} View buttons`);
    
    if (count > 0) {
      await viewButtons.first().click({ timeout: 5000 });
      await page.waitForTimeout(2500);
      
      console.log('Taking screenshot of map view...');
      await page.screenshot({ path: '/tmp/claude-0/-home-user-server-js/4b7fa832-ce33-5952-aada-1bdabeb36d01/scratchpad/transport-02-map.png', fullPage: false });
      console.log('✅ Screenshot 2 saved');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
  }
})();
