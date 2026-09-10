// A partner's endpoint, behaving like a real one: it VERIFIES the signature
// with the shared secret before accepting anything, and can be told to fail so
// the retry ladder is exercised against a receiver that is genuinely refusing.
const http = require('http');
const { verifySignature } = require('/home/user/server.js/lib/integration');

const PORT = Number(process.env.PORT || 4791);
const state = { secret: process.env.HOOK_SECRET || '', fail: 0, received: [], badSig: 0 };

http.createServer((req, res) => {
  if (req.url.startsWith('/__ctl')) {
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.has('secret')) state.secret = u.searchParams.get('secret');
    if (u.searchParams.has('fail'))   state.fail = Number(u.searchParams.get('fail'));
    if (u.searchParams.has('reset'))  { state.received = []; state.badSig = 0; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, fail: state.fail, count: state.received.length, badSig: state.badSig,
                                    received: state.received }));
  }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const sig = req.headers['x-idealone-signature'] || '';
    const good = state.secret ? verifySignature(state.secret, body, sig) : true;
    if (!good) state.badSig++;
    if (state.fail > 0) {
      state.fail--;
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('receiver is having a bad day');
    }
    let parsed = {}; try { parsed = JSON.parse(body); } catch (_) {}
    state.received.push({
      event: req.headers['x-idealone-event'] || parsed.event || '',
      delivery: req.headers['x-idealone-delivery'] || '',
      sigOk: good, data: parsed.data || {},
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
}).listen(PORT, () => console.log('hook receiver on ' + PORT));
