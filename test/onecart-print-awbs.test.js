// print_awbs is application/json with integer order_ids.
//
// OneCart v2 operation postApiV2OrdersPrintAwbs consumes application/json.
// order_ids is an array of int32. A multipart body that repeats the field as
// a string is what OneCart answered 400 VALIDATION_ERROR ("Validation failed")
// for on StellarKBeauty's Get Labels (1 Oct 2026, request
// 37e6d98f-e280-8568-807f-c2d375c30faa). Success 201 is { print_jobs }; a
// { data: { print_jobs } } envelope is still read. No IdealOne server — the
// client talks to a local stub of the one route.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { printAwbs, OnecartError, extractLabelCandidates } = require('../lib/onecart');

const savedBase = process.env.ONECART_BASE;
delete process.env.ONECART_BASE;
test.after(() => {
  if (savedBase === undefined) delete process.env.ONECART_BASE;
  else process.env.ONECART_BASE = savedBase;
});

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function storeFor(server) {
  const { port } = server.address();
  return { apiKey: 'test-key', endpoint: `http://127.0.0.1:${port}/api/v2` };
}

test('printAwbs posts JSON integers and reads a bare print_jobs body', async () => {
  let seen = null;
  const server = await listen(async (req, res) => {
    const raw = await readBody(req);
    seen = {
      method: req.method,
      url: req.url,
      ct: req.headers['content-type'],
      auth: req.headers.authorization,
      raw,
    };
    res.writeHead(201, { 'Content-Type': 'application/json', 'X-Request-Id': 'req_bare' });
    res.end(JSON.stringify({
      print_jobs: { shop: { labels: [{ order_id: 7, url: 'https://labels.example/7.pdf' }] } },
    }));
  });
  try {
    const out = await printAwbs(storeFor(server), ['7', 8]);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/api/v2/orders/print_awbs');
    assert.match(seen.ct, /^application\/json\b/);
    assert.equal(seen.auth, 'test-key');
    assert.equal(seen.raw, JSON.stringify({ order_ids: [7, 8] }));
    assert.ok(out.print_jobs && out.print_jobs.shop);
    const cands = extractLabelCandidates(out);
    assert.equal(cands.length, 1);
    assert.equal(cands[0].kind, 'url');
    assert.equal(cands[0].value, 'https://labels.example/7.pdf');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('printAwbs unwraps a data envelope around print_jobs', async () => {
  const server = await listen(async (req, res) => {
    await readBody(req);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: { print_jobs: { shop: { labels: [] } } },
      meta: {}, links: {}, errors: [], warnings: [],
    }));
  });
  try {
    const out = await printAwbs(storeFor(server), [9001]);
    assert.deepEqual(out, { print_jobs: { shop: { labels: [] } } });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('optional fields go out as a boolean and a string, and stay off otherwise', async () => {
  const bodies = [];
  const server = await listen(async (req, res) => {
    bodies.push(await readBody(req));
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ print_jobs: {} }));
  });
  try {
    const store = storeFor(server);
    await printAwbs(store, [9], { withSkuList: true, documentType: 'SHIPPING_LABEL' });
    await printAwbs(store, [9]);
    assert.deepEqual(JSON.parse(bodies[0]), {
      order_ids: [9], with_sku_list: true, document_type: 'SHIPPING_LABEL',
    });
    assert.deepEqual(JSON.parse(bodies[1]), { order_ids: [9] });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a 400 VALIDATION_ERROR keeps the code, details and request id', async () => {
  const server = await listen(async (req, res) => {
    await readBody(req);
    res.writeHead(400, { 'Content-Type': 'application/json', 'X-Request-Id': 'hdr_ignored' });
    res.end(JSON.stringify({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: [{ field: 'order_ids', message: 'invalid' }],
        request_id: '37e6d98f-e280-8568-807f-c2d375c30faa',
      },
    }));
  });
  try {
    await assert.rejects(
      () => printAwbs(storeFor(server), [1]),
      (e) => {
        assert.ok(e instanceof OnecartError);
        assert.equal(e.status, 400);
        assert.equal(e.code, 'VALIDATION_ERROR');
        assert.match(e.message, /Validation failed/);
        assert.equal(e.requestId, '37e6d98f-e280-8568-807f-c2d375c30faa');
        assert.equal(e.details[0].field, 'order_ids');
        return true;
      },
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a non-integer id is refused before any request', async () => {
  let hits = 0;
  const server = await listen(async (req, res) => {
    hits++;
    await readBody(req);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ print_jobs: {} }));
  });
  try {
    await assert.rejects(
      () => printAwbs(storeFor(server), ['GI-1']),
      (e) => e instanceof OnecartError && /not an integer/.test(e.message),
    );
    assert.equal(hits, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
