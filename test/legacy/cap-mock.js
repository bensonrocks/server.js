// A ZORT-web stand-in shaped like the screen the operator presses Print on:
// login → an ORDER page carrying a "Print shipping label (PDF)" button and a
// Task Manager entry, both behind the session.
const http = require('http');
const PORT = Number(process.argv[2] || 4938);
const GOOD_EMAIL = 'labels@nimbus.test', GOOD_PW = 'webpass123';
const send = (res, code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, ...extra }); res.end(body); };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const signedIn = String(req.headers.cookie || '').includes('zsess=ok');
  if (u.pathname === '/login') return send(res, 200, 'text/html',
    `<!DOCTYPE html><body><form method="post" action="/dologin">
     <input type="email" name="email"><input type="password" name="password">
     <button type="submit">Sign in</button></form></body>`);
  if (u.pathname === '/dologin') {
    let b = ''; req.on('data', c => b += c).on('end', () => {
      const p = new URLSearchParams(b);
      if (p.get('email') === GOOD_EMAIL && p.get('password') === GOOD_PW)
        return send(res, 302, 'text/html', 'ok', { 'set-cookie': 'zsess=ok; Path=/', location: '/order/9001' });
      return send(res, 200, 'text/html', '<!DOCTYPE html><body><form><input type="password"></form>wrong</body>');
    });
    return;
  }
  // The REAL shape the floor described: /Sell/list, a grid with row checkboxes,
  // and the print action as a named global function rather than a plain button.
  if (u.pathname === '/Sell/list') {
    if (!signedIn) return send(res, 200, 'text/html', '<!DOCTYPE html><body><form><input type="password"></form>Please sign in</body>');
    return send(res, 200, 'text/html',
      `<!DOCTYPE html><html><head><title>Sell list</title></head><body>
       <table><tr><td><input type="checkbox" id="chkAll" class="check-all"></td><td>All</td></tr>
       <tr><td><input type="checkbox" class="chkRow" name="orderIds" value="9001"></td><td>SO-9001</td></tr>
       <tr><td><input type="checkbox" class="chkRow" name="orderIds" value="9002"></td><td>SO-9002</td></tr></table>
       <a href="javascript:printMainMarketplaceDocument('shippingLabelPDF');" id="lnkPrintLabel">Print shipping label</a>
       <script>
         function printMainMarketplaceDocument(kind){
           var ids=[].slice.call(document.querySelectorAll('.chkRow:checked')).map(function(c){return c.value;});
           window.open('/Marketplace/PrintDoc?type='+kind+'&ids='+ids.join(','),'_blank');
         }
         function exportMainDocument(){ return 1; }
       </script></body></html>`);
  }
  if (u.pathname.startsWith('/order/')) {
    if (!signedIn) return send(res, 200, 'text/html', '<!DOCTYPE html><body><form><input type="password"></form>Please sign in</body>');
    return send(res, 200, 'text/html',
      `<!DOCTYPE html><html><head><title>Sale Order 9001</title></head><body>
       <h1>Order 9001</h1>
       <button id="btnRts" class="btn btn-primary">Ready to Ship</button>
       <button id="btnPrintLabel" class="btn btn-mkt" data-testid="print-shipping-label">Print shipping label (PDF)</button>
       <a href="/tasks" class="nav-task">Task Manager</a>
       <button class="btn btn-plain">Edit order</button>
       </body></html>`);
  }
  send(res, 404, 'text/plain', 'nope');
}).listen(PORT, () => console.log('cap-mock on ' + PORT));
