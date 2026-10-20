const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupSearchEngine, createSearchHttpServer } = require('../src/server');

let server;
let baseUrl;

// Helper: simple HTTP GET returning parsed JSON
function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, headers: res.headers, raw: body }); }
      });
    }).on('error', reject);
  });
}

test('server integration: setup and lifecycle', async (t) => {
  const engine = await setupSearchEngine();
  server = createSearchHttpServer(engine);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;

  await t.test('health endpoint returns status ok', async () => {
    const r = await httpGet('/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'ok');
    assert.equal(typeof r.data.uptime, 'number');
  });

  await t.test('/api/health also works', async () => {
    const r = await httpGet('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'ok');
  });

  await t.test('search with valid query returns results with sessionId', async () => {
    const r = await httpGet('/api/search?q=dragon');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.data));
    assert.ok(r.data.data.length > 0);
    assert.ok(typeof r.data.sessionId === 'string');
    assert.ok(r.data.sessionId.length > 0);
    assert.equal(typeof r.data.hasMore, 'boolean');
    assert.equal(r.data.meta.page, 1);
  });

  await t.test('pagination with sessionId returns next batch without duplicates', async () => {
    const r1 = await httpGet('/api/search?q=wolf');
    assert.equal(r1.status, 200);
    const sid = r1.data.sessionId;
    const r2 = await httpGet(`/api/search?q=wolf&sessionId=${sid}`);
    assert.equal(r2.status, 200);
    const ids1 = new Set(r1.data.data.map((d) => d._id));
    const ids2 = new Set(r2.data.data.map((d) => d._id));
    // No overlap between page 1 and page 2
    for (const id of ids2) assert.ok(!ids1.has(id), `Duplicate ID found: ${id}`);
  });

  await t.test('search with deviceType filter returns results', async () => {
    const r = await httpGet('/api/search?q=fantasy&deviceType=phone');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.data));
  });

  await t.test('search with custom limit respects the value', async () => {
    const r = await httpGet('/api/search?q=castle&limit=5');
    assert.equal(r.status, 200);
    assert.ok(r.data.data.length <= 5);
    assert.equal(r.data.meta.limit, 5);
  });

  await t.test('search without query or sessionId returns 400', async () => {
    const r = await httpGet('/api/search?q=');
    assert.equal(r.status, 400);
    assert.ok(r.data.error.includes('required'));
  });

  await t.test('unknown route returns 404', async () => {
    const r = await httpGet('/api/nonexistent');
    assert.equal(r.status, 404);
    assert.deepEqual(r.data, { error: 'Not found' });
  });

  await t.test('response headers include Content-Type JSON and X-Atlas-Mode', async () => {
    const r = await httpGet('/api/search?q=dragon');
    assert.equal(r.headers['content-type'], 'application/json');
    assert.ok(['live', 'mock-10k'].includes(r.headers['x-atlas-mode']));
  });

  // Cleanup
  server.close();
});
