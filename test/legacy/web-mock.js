// A ZORT-WEB stand-in: a login page, and a print-viewer page whose PDF loads
// via a script fetch that only succeeds once a session cookie is set. This is
// the exact shape the live diagnostics proved — a browser app, PDF behind the
// login. Proves the worker signs in and captures the bytes.
const http = require('http');
const fs = require('fs');
const PORT = Number(process.argv[2] || 4932);
const PDF_B64 = fs.readFileSync(__dirname + '/lbl2-fixture.pdf').toString('base64');
const GOOD_EMAIL = 'labels@nimbus.test', GOOD_PW = 'webpass123';

const send = (res, code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, ...extra }); res.end(body); };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const cookie = String(req.headers.cookie || '');
  const signedIn = cookie.includes('zsess=ok');

  if (u.pathname === '/login') {
    return send(res, 200, 'text/html',
      `<!DOCTYPE html><html><body><form method="post" action="/dologin">
       <input type="email" name="email"><input type="password" name="password">
       <button type="submit">Sign in</button></form></body></html>`);
  }
  if (u.pathname === '/dologin') {
    let body = '';
    req.on('data', c => body += c).on('end', () => {
      const p = new URLSearchParams(body);
      if (p.get('email') === GOOD_EMAIL && p.get('password') === GOOD_PW) {
        return send(res, 302, 'text/html', 'ok', { 'set-cookie': 'zsess=ok; Path=/', location: '/dashboard' });
      }
      return send(res, 200, 'text/html', '<!DOCTYPE html><body><form><input type="password"></form><p>wrong</p></body>');
    });
    return;
  }
  if (u.pathname === '/dashboard') return send(res, 200, 'text/html', '<!DOCTYPE html><body>welcome</body>');

  // The print-viewer PAGE — a script shell (like the live 26KB DOCTYPE page).
  // If not signed in, it renders a sign-in prompt instead of the viewer.
  if (u.pathname === '/print') {
    if (!signedIn) return send(res, 200, 'text/html', '<!DOCTYPE html><body><form><input type="password"></form>Please sign in</body>');
    return send(res, 200, 'text/html',
      `<!DOCTYPE html><html><head></head><body><div id="app"></div>
       <script>fetch('/labelfile?tid=${u.searchParams.get('tid') || '1'}',{credentials:'include'})
         .then(r=>r.blob()).then(b=>{var a=document.createElement('iframe');a.src=URL.createObjectURL(b);document.body.appendChild(a);});</script>
       </body></html>`);
  }
  // The PDF bytes — ONLY with the session cookie.
  if (u.pathname === '/labelfile') {
    if (!signedIn) return send(res, 403, 'text/plain', 'no session');
    return send(res, 200, 'application/pdf', Buffer.from(PDF_B64, 'base64'));
  }
  send(res, 404, 'text/plain', 'nope');
}).listen(PORT, () => console.log('web-mock on ' + PORT));
