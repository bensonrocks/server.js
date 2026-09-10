// The GI regexes must be linear on hostile input — this text comes off an
// uploaded PDF / OCR pass, so it is uncontrolled. The FIRST cut of the caption
// pattern did not finish 2,000 spaces in two minutes.
const { extractLabelFields } = require('/home/user/server.js/lib/label-extract.js');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };

const BUDGET = 250; // ms — generous; the fixed pattern lands in single digits
for (const [what, make] of [
  ['"Issue" + N spaces + a non-match', n => 'Issue' + ' '.repeat(n) + '!'],
  ['"GI No" + N spaces + a non-match', n => 'GI No' + ' '.repeat(n) + '!'],
  ['"GI" + N colons + a non-match',    n => 'GI' + ':'.repeat(n) + '!'],
  ['N mixed colon/space + non-match',  n => 'Issue No' + ': '.repeat(n) + '!'],
  ['a page of pure whitespace',        n => ' '.repeat(n)],
]) {
  for (const n of [2000, 8000, 20000]) {
    const s = make(n);
    const t = Date.now();
    extractLabelFields(s);
    const ms = Date.now() - t;
    ok(ms < BUDGET, `${what}, n=${n}: ${ms}ms`);
  }
}

// And a full-size realistic page still parses instantly.
const page = ('Lazada Shipping Label\nOrder No: 1690123456789012\n'
  + 'Tracking LZSGD1015379600\nTo: Someone\n20 Tuas Ave, Singapore 639999\n').repeat(60);
{ const t = Date.now(); extractLabelFields(page); ok(Date.now() - t < BUDGET, `a realistic ${page.length}-char page: ${Date.now() - t}ms`); }

// The fix must not have changed WHAT is read.
const cases = [
  ['GI No: GI-25001234',      'GI-25001234'],
  ['GI 25001234',             'GI-25001234'],
  ['Issue No: 1300456',       '1300456'],
  ['Issue No.: 1300456',      '1300456'],
  ['iWMS GINo 1300456',       '1300456'],
  ['Issue: 1300456',          '1300456'],
  ['GI No.   1300456',        '1300456'],
  ['ORIGIN: SINGAPORE',       ''],
  ['GIFT WRAP INCLUDED',      ''],
  ['Order ID: 260726PNCVDSYK',''],
];
for (const [text, want] of cases) {
  const got = extractLabelFields(text).giNumber;
  ok(got === want, `"${text}" -> ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
}

console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
process.exit(fails.length ? 1 : 0);
