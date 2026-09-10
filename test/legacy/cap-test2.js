// Against a mock shaped like the REAL /Sell/list: does the capture read back
// the print function's own source, and how rows are selected?
process.env.DATA_DIR = __dirname + '/ddcap2';
process.env.ZORT_WEB_BASE = 'http://localhost:4938';
process.env.ZORT_BROWSER_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const zw = require('/home/user/server.js/lib/zort-web.js');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const store = { id: 'sell', webEmail: 'labels@nimbus.test', webPassword: 'webpass123' };
  const out = await zw.capturePage(store, 'http://localhost:4938/Sell/list',
    { fns: ['printMainMarketplaceDocument'] });
  const fn = (out.functions || []).find(f => f.name === 'printMainMarketplaceDocument');
  console.log('  FUNCTION SOURCE:\n' + (fn ? fn.source : '(none)'));
  console.log('  SELECTION:', JSON.stringify(out.selection));
  ok(!!fn, '★ the print function is read back by name');
  ok(fn && /window\.open|PrintDoc/.test(fn.source), '★ its SOURCE shows what it actually does');
  ok(fn && /chkRow:checked/.test(fn.source), '…including that it acts on the SELECTED rows');
  ok((out.selection || []).some(s => s.value === '9001'), 'the row checkboxes are reported with their ids');
  ok((out.selection || []).some(s => /check-all|chkAll/.test(s.cls + s.id)), 'the select-all box is reported');
  ok((out.controls || []).some(c => /print shipping label/i.test(c.text)), 'the print link is still listed as a control');
  // A sibling function is picked up too, so the family is visible.
  ok((out.functions || []).some(f => f.name === 'exportMainDocument'), 'a sibling print/export function is found as well');
  // SSRF pin.
  try {
    await zw.capturePage(store, 'http://169.254.169.254/latest/meta-data/');
    ok(false, '★ a non-ZORT host is refused');
  } catch (e) { ok(/only captures pages on/.test(e.message), '★ a non-ZORT host is refused: ' + e.message.slice(0, 70)); }
  console.log('\n' + (fails.length ? fails.length + ' FAILED' : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('THREW', e.message); process.exit(1); });
