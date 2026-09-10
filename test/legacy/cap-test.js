// Drives the NEW capturePage against the mock: does it sign in, save the real
// DOM, and name the button we would have to click?
process.env.DATA_DIR = __dirname + '/ddcap';
process.env.ZORT_WEB_BASE = 'http://localhost:4938';
process.env.ZORT_BROWSER_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const zw = require('/home/user/server.js/lib/zort-web.js');
const fs = require('fs');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const avail = zw.available();
  ok(avail.ok, 'the browser worker is available (' + (avail.why || 'ok') + ')');
  if (!avail.ok) { process.exit(1); }
  const store = { id: 'capstore', webEmail: 'labels@nimbus.test', webPassword: 'webpass123' };
  const out = await zw.capturePage(store, 'http://localhost:4938/order/9001');
  console.log('  controls:', JSON.stringify(out.controls, null, 1));
  ok(/Order 9001/.test(fs.readFileSync(out.htmlPath, 'utf8')), 'the real page HTML is saved to disk');
  ok(fs.existsSync(out.shotPath) && fs.statSync(out.shotPath).size > 1000, 'a screenshot is saved');
  const print = (out.controls || []).find(c => /print shipping label/i.test(c.text));
  ok(!!print, '★ the Print shipping label button is FOUND and named');
  // What matters is that the selector is SPECIFIC enough to find it again —
  // an id or a testid, never a bare tag name. Which of the two the code picks
  // is its own business (it prefers id, which is the stronger locator).
  ok(print && /^[#\[]|\./.test(print.selector) && print.selector !== 'button',
     '…with a selector specific enough to find it again (' + (print?.selector) + ')');
  ok((out.controls || []).some(c => /ready to ship/i.test(c.text)), 'the RTS button is reported too');
  ok(!(out.controls || []).some(c => /edit order/i.test(c.text)), 'an unrelated control is NOT reported as label-ish');
  // IT MUST NOT HAVE PRESSED ANYTHING.
  ok(!fs.readFileSync(__dirname + '/cap-mock.log', 'utf8').includes('/print-fired'), '★ it clicked nothing — read-only');
  // A wrong password must say so rather than hang.
  try {
    zw.forgetSession('capstore2');
    await zw.capturePage({ id: 'capstore2', webEmail: 'labels@nimbus.test', webPassword: 'WRONG' }, 'http://localhost:4938/order/9001');
    ok(false, 'a bad password is refused in words');
  } catch (e) { ok(/sign.?in|password/i.test(e.message), 'a bad password is refused in words: ' + e.message.slice(0, 60)); }
  console.log('\n' + (fails.length ? fails.length + ' FAILED' : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
