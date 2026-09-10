// Kill the test server for a given PORT, by matching its environ — never a
// pkill pattern, which matches its own command line and kills the shell.
const fs = require('fs');
const want = 'PORT=' + process.argv[2];
let hits = 0;
for (const d of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(d)) continue;
  try {
    const c = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8');
    const e = fs.readFileSync('/proc/' + d + '/environ', 'utf8');
    if (c.includes('node') && c.includes('server.js') && e.includes(want)) {
      process.kill(Number(d)); hits++; console.log('killed', d);
    }
  } catch {}
}
if (!hits) console.log('nothing on', want);
