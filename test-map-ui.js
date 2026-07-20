const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
  
  try {
    console.log('Opening app...');
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    
    console.log('Logging in...');
    await page.fill('#loginName', 'demo');
    await page.fill('#loginIC', 'password123');
    await page.click('#loginBtn');
    await page.waitForTimeout(3000);
    
    console.log('Opening Transport tab...');
    await page.click('[data-tab="transport"]');
    await page.waitForTimeout(2000);
    
    console.log('Taking screenshot of map view...');
    await page.screenshot({ path: '/tmp/claude-0/-home-user-server-js/4b7fa832-ce33-5952-aada-1bdabeb36d01/scratchpad/transport-map-ui.png', fullPage: false });
    console.log('✅ Screenshot 1 saved');
    
    console.log('Clicking Upload Jobs submenu...');
    await page.click('#uploadJobsBtn');
    await page.waitForTimeout(1500);
    
    console.log('Taking screenshot of upload modal...');
    await page.screenshot({ path: '/tmp/claude-0/-home-user-server-js/4b7fa832-ce33-5952-aada-1bdabeb36d01/scratchpad/transport-upload-modal.png', fullPage: false });
    console.log('✅ Screenshot 2 saved');

    console.log('Closing upload modal...');
    await page.click('#uploadJobsCloseBtn');
    await page.waitForTimeout(1000);

    console.log('Clicking Show Drivers...');
    await page.click('#transportToggleDriversBtn');
    await page.waitForTimeout(1500);
    
    console.log('Taking screenshot with drivers...');
    await page.screenshot({ path: '/tmp/claude-0/-home-user-server-js/4b7fa832-ce33-5952-aada-1bdabeb36d01/scratchpad/transport-with-drivers.png', fullPage: false });
    console.log('✅ Screenshot 3 saved');
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
  }
})();
