const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const source = readFileSync(require.resolve('../src/edge/searchCacheWorker.js'), 'utf8');
const loadWorker = () => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function fixture(t, body, cached) {
  const puts = [];
  const tasks = [];
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++;
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    match: async () => cached?.clone(), put: async (key, value) => puts.push([key, value]),
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, 'caches', original) : delete globalThis.caches);
  return { puts, tasks, ctx: { waitUntil: (p) => tasks.push(p) }, fetches: () => fetches };
}

test('edge preserves private origin session when more pages exist', async (t) => {
  const f = fixture(t, { data: [{ _id: '1' }], sessionId: 'private-session', hasMore: true });
  const { default: worker } = await loadWorker();
  const result = await worker.fetch(new Request('https://edge.test/api/search?q=dragon'), { ORIGIN: 'https://origin.test' }, f.ctx);
  assert.equal((await result.json()).sessionId, 'private-session');
  assert.match(result.headers.get('Cache-Control'), /no-store/);
  await Promise.all(f.tasks);
  assert.equal(f.puts.length, 0);
});

test('edge caches complete results without sharing origin sessions', async (t) => {
  const f = fixture(t, { data: [{ _id: '1' }], sessionId: 'private-session', hasMore: false });
  const { default: worker } = await loadWorker();
  const result = await worker.fetch(new Request('https://edge.test/api/search?q=dragon'), { ORIGIN: 'https://origin.test' }, f.ctx);
  assert.equal((await result.json()).sessionId, undefined);
  await Promise.all(f.tasks);
  assert.equal(f.puts.length, 1);
  assert.equal((await f.puts[0][1].json()).sessionId, undefined);
});

test('edge ignores older cached pages that cannot be continued', async (t) => {
  const f = fixture(t, { data: [], sessionId: 'fresh-session', hasMore: true }, new Response(JSON.stringify({ data: [], hasMore: true })));
  const { default: worker } = await loadWorker();
  const result = await worker.fetch(new Request('https://edge.test/api/search?q=dragon'), { ORIGIN: 'https://origin.test' }, f.ctx);
  assert.equal((await result.json()).sessionId, 'fresh-session');
  assert.equal(f.fetches(), 1);
});

test('edge forwards a non-JSON origin response without caching it', async (t) => {
  const f = fixture(t, {});
  t.mock.method(globalThis, 'fetch', async () => new Response('temporarily unavailable'));
  const { default: worker } = await loadWorker();
  const result = await worker.fetch(new Request('https://edge.test/api/search?q=dragon'), { ORIGIN: 'https://origin.test' }, f.ctx);
  assert.equal(await result.text(), 'temporarily unavailable');
  assert.equal(f.puts.length, 0);
});

test('edge marks hits as cached even for older sessionless entries', async (t) => {
  const f = fixture(t, {}, new Response(JSON.stringify({ data: [], hasMore: false })));
  const { default: worker } = await loadWorker();
  const result = await worker.fetch(new Request('https://edge.test/api/search?q=dragon'), { ORIGIN: 'https://origin.test/' }, f.ctx);
  assert.equal((await result.json()).fromCache, true);
  assert.equal(result.headers.get('X-Cache'), 'HIT');
  assert.equal(f.fetches(), 0);
});

test('edge marks fresh origin results as misses and normalizes the origin slash', async (t) => {
  const f = fixture(t, {});
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    urls.push(typeof input === 'string' ? input : input.url);
    return new Response(JSON.stringify({ data: [], sessionId: 'private', hasMore: false }));
  });
  const { default: worker } = await loadWorker();
  const result = await worker.fetch(new Request('https://edge.test/api/search?q=dragon'), { ORIGIN: 'https://origin.test/' }, f.ctx);
  assert.equal((await result.json()).fromCache, false);
  assert.equal(urls[0], 'https://origin.test/api/search?q=dragon');
  await worker.fetch(new Request('https://edge.test/api/search?sessionId=private'), { ORIGIN: 'https://origin.test/' }, f.ctx);
  assert.equal(urls[1], 'https://origin.test/api/search?sessionId=private');
  await Promise.all(f.tasks);
});

test('edge cache failures fall back to the origin and leave responses usable', async (t) => {
  const f = fixture(t, { data: [], hasMore: false });
  t.mock.method(globalThis.caches.default, 'match', async () => { throw new Error('cache unavailable'); });
  t.mock.method(globalThis.caches.default, 'put', async () => { throw new Error('cache unavailable'); });
  const { default: worker } = await loadWorker();
  const result = await worker.fetch(new Request('https://edge.test/api/search?q=dragon'), { ORIGIN: 'https://origin.test' }, f.ctx);
  assert.deepEqual((await result.json()).data, []);
  await Promise.all(f.tasks);
});
