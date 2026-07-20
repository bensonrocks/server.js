const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  
  try {
    console.log('Opening app...');
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    
    console.log('Logging in...');
    await page.fill('#loginName', 'demo');
    await page.fill('#loginIC', 'password123');
    await page.click('#loginBtn');
    await page.waitForTimeout(3000);
    
    console.log('Opening Transport tab...');
    await page.click('[data-tab="transport"]');
    await page.waitForTimeout(2000);
    
    // Listen for download
    const downloadPromise = page.waitForEvent('download');
    
    console.log('Clicking Download Sample Template...');
    await page.click('#transportTemplateDownloadBtn');
    
    const download = await downloadPromise;
    const filename = await download.suggestedFilename();
    console.log(`Downloaded: ${filename}`);
    
    // Check file content
    const filePath = `/tmp/${filename}`;
    await download.saveAs(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    console.log('File content:');
    console.log(content.split('\n').slice(0, 3).join('\n'));
    console.log('✅ Sample template downloaded successfully');
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
  }
})();
