const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createProgressiveSearch } = require('../src/services/progressiveSearch');
const { createSearchHttpServer } = require('../src/server');
const { fetchSearchBatch } = require('../src/services/searchRanking');
const { processWallpaperSemanticsOnUpload, expandWords } = require('../src/services/aiGraphService');
const { createDraftRetryWorker } = require('../src/workers/draftRetryWorker');
const { NeighborIndex } = require('../src/services/neighborIndex');
const rows = Array.from({ length: 200 }, (_, i) => ({ _id: String(i) }));
const idsOf = (result) => result.data.map((row) => row._id);
const ranked = rows.map((row) => ({ docId: row._id, score: 200 - Number(row._id) }));

for (const page of [2, 5, 10]) {
  test(`cold numbered page ${page} hydrates only its own IDs`, async () => {
    const batches = [];
    let resolutions = 0;
    const ps = createProgressiveSearch({ resolvePool: async () => { resolutions++; return ranked; },
      fetchDocs: async ({ ids }) => { batches.push(ids); return ids.map((_id) => ({ _id })).reverse(); } });
    const result = await ps.search({ q: 'dragon', page, limit: 10 });
    const expected = rows.slice((page - 1) * 10, page * 10).map((row) => row._id);
    assert.deepEqual(idsOf(result), expected);
    assert.equal(resolutions, 1);
    assert.deepEqual(batches, [expected]);
  });
}

test('numbered pages keep fixed unique rank windows when documents are withdrawn', async () => {
  const hidden = new Set(['0', '3']);
  const batches = [];
  const ps = createProgressiveSearch({ resolvePool: async () => [ranked[0], ...ranked.slice(0, 6)],
    fetchDocs: async ({ ids }) => { batches.push(ids); return ids.filter((id) => !hidden.has(id)).map((_id) => ({ _id })); } });
  const first = await ps.search({ q: 'dragon', page: 1, limit: 2 });
  const second = await ps.search({ q: 'dragon', page: 2, limit: 2 });
  assert.deepEqual(idsOf(first), ['1']);
  assert.deepEqual(idsOf(second), ['2']);
  hidden.add('2');
  assert.deepEqual(idsOf(await ps.search({ sessionId: second.sessionId, page: 2, limit: 2 })), []);
  assert.deepEqual(idsOf(await ps.search({ sessionId: second.sessionId, limit: 2 })), ['4', '5']);
  assert.deepEqual(batches, [['0', '1'], ['2', '3'], ['2', '3'], ['4', '5']]);
});

test('failed numbered hydration preserves the cursor and can be retried', async () => {
  let fail = false;
  const ps = createProgressiveSearch({ resolvePool: async () => ranked,
    fetchDocs: async ({ ids }) => { if (fail) throw new Error('timeout'); return ids.map((_id) => ({ _id })); } });
  const first = await ps.search({ q: 'dragon', limit: 2 });
  fail = true;
  await assert.rejects(ps.search({ sessionId: first.sessionId, page: 10, limit: 2 }), /timeout/);
  fail = false;
  const next = await ps.search({ sessionId: first.sessionId, limit: 2 });
  assert.deepEqual(idsOf(next), ['2', '3']);
  assert.deepEqual(idsOf(await ps.search({ sessionId: first.sessionId, page: 10, limit: 2 })), ['18', '19']);
});

test('HTTP does not invent a visible total after a cold jump to the last ID page', async (t) => {
  const ps = createProgressiveSearch({ resolvePool: async () => ranked.slice(0, 4),
    fetchDocs: async ({ ids }) => ids.filter((id) => id !== '0').map((_id) => ({ _id })) });
  const server = createSearchHttpServer({ progressiveSearch: ps, isAtlasLive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const last = await (await fetch(`${base}/api/search?q=dragon&page=2&limit=2`)).json();
  assert.equal(last.hasMore, false);
  assert.equal(last.meta.total, 'unknown');
  assert.equal(last.meta.totalPages, 2);
  const first = await ps.search({ q: 'dragon', page: 1, limit: 2 });
  const sequentialLast = await ps.search({ sessionId: first.sessionId, page: 2, limit: 2 });
  assert.equal(sequentialLast.total, 3);
  assert.equal(sequentialLast.totalPages, 2);
  const withdrawn = createProgressiveSearch({ resolvePool: async () => ranked.slice(0, 6),
    fetchDocs: async ({ ids }) => ids.filter((id) => Number(id) % 2).map((_id) => ({ _id })) });
  const firstWindow = await withdrawn.search({ q: 'dragon', page: 1, limit: 2 });
  await withdrawn.search({ sessionId: firstWindow.sessionId, page: 2, limit: 2 });
  const finalWindow = await withdrawn.search({ sessionId: firstWindow.sessionId, page: 3, limit: 2 });
  assert.equal(finalWindow.total, 3);
  assert.equal(finalWindow.totalPages, 3, 'withdrawals must not shrink the number of rank windows');
});

for (const fallback of [false, true]) {
  test(`ranking pool requests only IDs and scores (${fallback ? 'text fallback' : 'Atlas'})`, async () => {
    const expected = [{ _id: 'one', _searchScore: 5 }];
    const model = {
      aggregate: async (pipeline) => {
        if (fallback) throw new Error('Atlas unavailable');
        assert.deepEqual(pipeline.at(-1), { $project: { _id: 1, _searchScore: 1 } });
        assert.equal(pipeline.some((stage) => stage.$lookup), false);
        return expected;
      },
      find: (_, projection) => {
        assert.equal(fallback, true, 'Atlas projection assertions must not be hidden by fallback');
        assert.deepEqual(projection, { _id: 1, _searchScore: { $meta: 'textScore' } });
        return { sort() { return this; }, limit() { return this; },
          populate() { assert.fail('ID pool must not populate categories'); }, lean: async () => expected };
      },
    };
    assert.deepEqual(await fetchSearchBatch(model, { q: 'dragon', expansion: { terms: [] }, idsOnly: true }), expected);
  });
}

test('partial upload makes one provider pass without sleeps; worker retries missing words later', async (t) => {
  let sleeps = 0;
  t.mock.method(globalThis, 'setTimeout', (fn) => { sleeps++; queueMicrotask(fn); });
  let calls = 0;
  const written = [];
  const done = new Set();
  const deps = { graph: new Map(), index: new NeighborIndex(),
    Model: { find: () => ({ select: () => ({ lean: async () => [...done].map((word) => ({ word })) }) }),
      bulkWrite: async (ops) => { written.push(...ops); for (const op of ops) if (op.updateOne.update.$set?.isExpanded) done.add(op.updateOne.filter.word); } },
    providers: [{ name: 'partial', call: async (prompt) => {
      calls++;
      if (calls === 1) return JSON.stringify({ expansions: { dragon: [{ target: 'wyvern', weight: 1 }] } });
      assert.match(prompt, /Words: \["wolf"\]/);
      return JSON.stringify({ expansions: { wolf: [{ target: 'canine', weight: 1 }] } });
    } }],
  };
  const upload = await processWallpaperSemanticsOnUpload({ _id: 'wall', tags: ['dragon', 'wolf'] }, 'scheduled', deps);
  assert.equal(sleeps, 0);
  assert.equal(calls, 1);
  assert.equal(upload.status, 'draft');
  assert.deepEqual(upload.unprocessedWords, ['wolf']);
  const updates = [];
  const worker = createDraftRetryWorker({ expand: (words) => expandWords(words, deps),
    Wallpaper: { updateOne: async (_, update) => updates.push(update.$set) },
    Job: { updateOne: async () => {} } });
  assert.equal(await worker.processJob({ _id: 'job', wallpaperId: 'wall', desiredStatus: 'scheduled', attempts: 0, unprocessedWords: upload.unprocessedWords }), 'completed');
  assert.equal(calls, 2);
  assert.deepEqual(updates, [{ status: 'scheduled' }]);
  assert.deepEqual([...done].sort(), ['dragon', 'wolf']);
});

test('cached paginated first page continues over HTTP without shared sessions or earlier hydration', async (t) => {
  const batches = [];
  const ps = createProgressiveSearch({ resolvePool: async () => ranked,
    fetchDocs: async ({ ids }) => { batches.push(ids); return ids.filter((id) => id !== '0').map((_id) => ({ _id })); } });
  const server = createSearchHttpServer({ progressiveSearch: ps, isAtlasLive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const entries = new Map();
  const tasks = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    match: async (key) => entries.get(key.url)?.clone(), put: async (key, value) => entries.set(key.url, value),
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, 'caches', original) : delete globalThis.caches);
  const source = readFileSync(require.resolve('../src/edge/searchCacheWorker.js'), 'utf8');
  const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const ctx = { waitUntil: (p) => tasks.push(p) };
  const first = await worker.fetch(new Request('https://edge.test/api/search?q=Dragon&limit=2&deviceType=phone'), { ORIGIN: origin }, ctx);
  const body = await first.json();
  assert.equal(first.headers.get('X-Cache'), 'MISS');
  assert.equal(body.sessionId, undefined);
  assert.deepEqual(idsOf(body), ['1']);
  assert.equal(body.hasMore, true);
  await Promise.all(tasks);
  assert.equal(entries.size, 1);
  const hit = await worker.fetch(new Request('https://edge.test/api/search?q=dragon&limit=2&deviceType=phone&page=1'), { ORIGIN: origin }, ctx);
  const hitBody = await hit.json();
  assert.equal(hit.headers.get('X-Cache'), 'HIT');
  assert.equal(hitBody.fromCache, true);
  assert.equal(hitBody.sessionId, undefined);
  const continuation = new URL(hitBody.nextPage, 'https://edge.test');
  assert.equal(continuation.searchParams.get('q'), 'dragon');
  assert.equal(continuation.searchParams.get('deviceType'), 'phone');
  const next = await worker.fetch(new Request(continuation), { ORIGIN: origin }, ctx);
  const nextBody = await next.json();
  assert.deepEqual(idsOf(nextBody), ['2', '3']);
  assert.equal(nextBody.meta.page, 2);
  assert.equal(entries.size, 1);
  assert.deepEqual(batches, [['0', '1'], ['2', '3']]);
  const other = await worker.fetch(new Request(continuation), { ORIGIN: origin }, ctx);
  assert.notEqual((await other.json()).sessionId, nextBody.sessionId);
});
