// WHERE IS THE TIME GOING? Patch crypto.scryptSync before server.js loads, so
// every call logs its own stack. Armed only after boot, so seeding noise is
// not counted.
const crypto = require('crypto');
const orig = crypto.scryptSync;
let armed = false;
crypto.scryptSync = function (...a) {
  if (armed) console.log('SCRYPT <- ' + new Error().stack.split('\n').slice(1, 5).map(s => s.trim()).join(' | '));
  return orig.apply(this, a);
};
process.env.PORT = '4719';
process.env.DATA_DIR = __dirname + '/ddprobe';
require('/home/user/server.js/server.js');
setTimeout(() => { armed = true; console.log('=== ARMED ==='); }, 6000);
setInterval(() => {}, 1 << 30);
