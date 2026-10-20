const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { NeighborIndex } = require('../src/services/neighborIndex');
const { singleSourceBoundedDijkstra, findClosestWordByNormalizedLCS } = require('../src/services/semanticDijkstra');
const { addEdges, rebuildGraph, wordDocIds, linkDocToWords } = require('../src/services/memoryGraph');
const { createProgressiveSearch } = require('../src/services/progressiveSearch');
const { createSearchHttpServer } = require('../src/server');
const { buildAtlasPipeline, buildTextFallbackQuery, fetchSearchBatch } = require('../src/services/searchRanking');
const { createSearchService } = require('../src/services/wallpaperService');
const { SearchBufferCache, searchBufferCache } = require('../src/services/searchBufferCache');
const { onWallpaperEdited } = require('../src/services/searchLifecycle');
const { createDraftRetryWorker } = require('../src/workers/draftRetryWorker');
const { measure } = require('../scripts/benchmark-10k');
const SemanticNode = require('../src/models/SemanticNode');
const index = () => new NeighborIndex().build(new Map([['dragon', new Map()]]));
const rows = (n) => Array.from({ length: n }, (_, i) => ({ _id: String(i) }));
const ids = (result) => result.data.map((r) => r._id);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function httpFixture(t, ps) {
  const server = createSearchHttpServer({ progressiveSearch: ps, isAtlasLive: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const capacity of [64, 128]) {
  test(`neighbor recomputation writes into the current buffer after crossing ${capacity} words`, () => {
    const idx = new NeighborIndex();
    for (let i = 0; i < capacity; i++) idx._ensure(`word${i}`);
    const graph = new Map([['word1', new Map([['newword', 1]])]]);
    idx._recompute(graph, 'word1');
    assert.deepEqual([...idx.neighbors('word1')], [['word1', 0], ['newword', 1]]);
  });
}

test('bounded graph traversal preserves a costlier path with fewer hops', () => {
  const graph = new Map([
    ['start', new Map([['middle', 4], ['shortcut', 1]])],
    ['shortcut', new Map([['middle', 1]])],
    ['middle', new Map([['finish', 1]])],
  ]);
  const dist = singleSourceBoundedDijkstra(graph, 'start');
  assert.equal(dist.get('middle'), 3);
  assert.equal(dist.get('finish'), 6);
});

test('typo matching keeps repeated-character matches and lexical ties', () => {
  assert.equal(findClosestWordByNormalizedLCS('aaaaaabcd', new Map([['aaaaaaefg', new Map()]]))?.word, 'aaaaaaefg');
  assert.equal(findClosestWordByNormalizedLCS('ab', new Map([['abz', new Map()], ['a', new Map()], ['aa', new Map()]]))?.word, 'abz');
  // "abcx" and "a" both score 2/3 for "ab"; the shorter word wins the tie.
  assert.equal(findClosestWordByNormalizedLCS('ab', new Map([['abcx', new Map()], ['a', new Map()]]))?.word, 'a');
});

test('same-size vocabulary rebuild invalidates cached typo matches', () => {
  const graph = new Map();
  rebuildGraph(graph, [{ word: 'dragon', edges: [] }]);
  assert.equal(findClosestWordByNormalizedLCS('dragn', graph)?.word, 'dragon');
  rebuildGraph(graph, [{ word: 'dragne', edges: [] }]);
  assert.equal(findClosestWordByNormalizedLCS('dragn', graph)?.word, 'dragne');
});

test('neighbor typo budget bounds unsuccessful dictionary scans', () => {
  class CountingMap extends Map {
    keys() { this.scans++; return super.keys(); }
  }
  const graph = new CountingMap([['dragon', new Map()]]);
  graph.scans = 0;
  const idx = new NeighborIndex().build(graph);
  // Prime dictionary state, then measure full scan calls only.
  findClosestWordByNormalizedLCS('nothing', graph);
  graph.scans = 0;
  idx.expand('zzzz qqqq xxxx vvvv');
  assert.equal(graph.scans, 2);
});

test('invalid graph weights cannot corrupt graph traversal', () => {
  const graph = new Map();
  addEdges(graph, 'dragon', [NaN, 1.5, undefined, Infinity].map((weight, i) => ({ target: `bad${i}`, weight })));
  assert.equal(graph.get('dragon').size, 0);
  assert.doesNotThrow(() => singleSourceBoundedDijkstra(graph, 'dragon'));
  for (const weight of [0, 1.5, NaN, 7]) {
    assert.ok(new SemanticNode({ word: 'dragon', edges: [{ target: 'wolf', weight }] }).validateSync());
  }
});

test('neighbor count storage rejects invalid K values', () => {
  for (const k of [0, -1, 1.5, 256, NaN]) assert.throws(() => new NeighborIndex(k), /k/i);
});

for (const mode of ['legacy', 'id-first']) {
  test(`explicit pages jump and replay deterministically in ${mode} mode`, async () => {
    const data = rows(9);
    const ps = createProgressiveSearch({ index: index(), ...(mode === 'legacy'
      ? { fetchPool: async () => data }
      : { resolvePool: async () => data.map((r) => ({ docId: r._id })), fetchDocs: async ({ ids }) => data.filter((r) => ids.includes(r._id)) }) });
    const second = await ps.search({ q: 'dragon', page: 2, limit: 3 });
    assert.deepEqual(ids(second), ['3', '4', '5']);
    const repeat = await ps.search({ sessionId: second.sessionId, page: 2, limit: 3 });
    assert.deepEqual(ids(repeat), ['3', '4', '5']);
    const first = await ps.search({ sessionId: second.sessionId, page: 1, limit: 3 });
    assert.deepEqual(ids(first), ['0', '1', '2']);
    const next = await ps.search({ sessionId: second.sessionId, limit: 3 });
    assert.deepEqual(ids(next), ['3', '4', '5']);
    const pastEnd = await ps.search({ sessionId: second.sessionId, page: 99999999, limit: 3 });
    assert.deepEqual(ids(pastEnd), []);
    assert.equal(pastEnd.total, 9);
    assert.equal(pastEnd.hasMore, false);
  });
}

test('explicit ID pages count visible unique documents and recheck visibility on replay', async () => {
  let hidden = new Set(['0', '4']);
  const ps = createProgressiveSearch({ resolvePool: async () => ['0','1','1','2','3','4','5','6'].map((docId) => ({ docId })),
    fetchDocs: async ({ ids }) => ids.filter((id) => !hidden.has(id)).map((_id) => ({ _id })) });
  const second = await ps.search({ q: 'dragon', page: 2, limit: 2 });
  assert.deepEqual(ids(second), ['3', '5']);
  hidden.add('3');
  const replay = await ps.search({ sessionId: second.sessionId, page: 2, limit: 2 });
  assert.deepEqual(ids(replay), ['5', '6']);
  assert.equal(replay.total, 4);
});

test('expired sessions without a query return 410 and mismatched searches return 400', async (t) => {
  const ps = createProgressiveSearch({ index: index(), fetchPool: async () => rows(4) });
  const base = await httpFixture(t, ps);
  const expired = await fetch(`${base}/api/search?sessionId=expired`);
  assert.equal(expired.status, 410);
  const first = await (await fetch(`${base}/api/search?q=dragon&deviceType=phone`)).json();
  for (const params of ['q=wolf', 'deviceType=desktop']) {
    const response = await fetch(`${base}/api/search?sessionId=${first.sessionId}&${params}`);
    assert.equal(response.status, 400);
  }
});

test('HTTP pages reflect requested slices and empty totals have zero pages', async (t) => {
  const ps = createProgressiveSearch({ index: index(), fetchPool: async ({ q }) => q === 'none' ? [] : rows(5) });
  const base = await httpFixture(t, ps);
  const second = await (await fetch(`${base}/api/search?q=dragon&page=2&limit=2`)).json();
  assert.deepEqual(ids(second), ['2', '3']);
  assert.equal(second.meta.page, 2);
  const next = await (await fetch(`${base}/api/search?sessionId=${second.sessionId}&limit=2`)).json();
  assert.equal(next.meta.page, 3);
  const empty = await (await fetch(`${base}/api/search?q=none`)).json();
  assert.equal(empty.meta.totalPages, 0);
});

test('invalid ObjectId exclusions do not break either ranking path', async () => {
  const valid = new mongoose.Types.ObjectId();
  const options = { q: 'dragon', expansion: { terms: [] }, excludeIds: ['row_1', valid, 'bad'] };
  const atlas = buildAtlasPipeline(options)[2].$match._id.$nin;
  assert.deepEqual(atlas.map(String), [String(valid)]);
  assert.deepEqual(buildTextFallbackQuery(options)._id.$nin.map(String), [String(valid)]);
  const result = await fetchSearchBatch({ aggregate: async () => { throw new Error('unavailable'); },
    find: (filter) => { assert.deepEqual(filter._id.$nin.map(String), [String(valid)]); return { sort() { return this; }, limit() { return this; }, populate() { return this; }, lean: async () => [] }; } }, options);
  assert.deepEqual(result, []);
});

test('benchmark waits for warmup and measured async work and propagates rejection', async () => {
  let completed = 0;
  const result = await measure('async fixture', 'test', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed++;
  }, { warmup: 2, iterations: 3 });
  assert.equal(completed, 5);
  assert.ok(result.min >= 3, `latencies must include async work: ${result.min}`);
  await assert.rejects(async () => measure('failed', 'test', async () => { throw new Error('async failed'); }, { warmup: 0, iterations: 1 }), /async failed/);
});

test('patch edits preserve ID and untouched semantic fields while updating postings', async () => {
  linkDocToWords(['dragon', 'castle'], 'patch-wall');
  const writes = [];
  const Model = {
    find: ({ word: { $in } }) => ({ select: () => ({ lean: async () => $in.map((word) => ({ word })) }) }),
    updateMany: async (...args) => writes.push(args), bulkWrite: async () => {},
  };
  const result = await onWallpaperEdited({ _id: 'patch-wall', title: 'Castle', tags: ['dragon'] }, { tags: ['wolf'] }, 'published', { Model });
  assert.equal(result.status, 'published');
  assert.equal(wordDocIds.get('dragon').has('patch-wall'), false);
  assert.equal(wordDocIds.get('wolf')?.has('patch-wall'), true);
  assert.equal(wordDocIds.get('castle').has('patch-wall'), true);
  assert.deepEqual(writes[0][0].word.$in, ['dragon']);
});

test('failed edit maintenance still invalidates cached results', async () => {
  const generation = searchBufferCache.generation;
  await assert.rejects(onWallpaperEdited({ _id: 'wall', tags: ['dragon'] }, { tags: ['wolf'] }, 'published', {
    Model: { updateMany: async () => { throw new Error('database unavailable'); } },
  }), /database unavailable/);
  assert.equal(searchBufferCache.generation, generation + 1);
});

test('retry worker preserves scheduled status', async () => {
  let status;
  const worker = createDraftRetryWorker({ Wallpaper: { updateOne: async (_, u) => { status = u.$set.status; } }, Job: { updateOne: async () => {} }, expand: async () => ({ missing: [] }) });
  await worker.processJob({ _id: 'job', wallpaperId: 'wall', desiredStatus: 'scheduled', unprocessedWords: [], attempts: 0 });
  assert.equal(status, 'scheduled');
});

test('retry tick recovers once and processes a bounded batch', async () => {
  let recoveries = 0;
  let claims = 0;
  const worker = createDraftRetryWorker({ batchSize: 2, Wallpaper: { updateOne: async () => {} }, expand: async () => ({}),
    Job: { updateMany: async () => { recoveries++; }, updateOne: async () => {}, findOneAndUpdate: async () => ++claims <= 5 ? { _id: 'job', attempts: 0, unprocessedWords: [] } : null } });
  assert.equal(await worker.tick(), 2);
  assert.equal(recoveries, 1);
  assert.equal(claims, 2);
});

test('cold buffer searches fill distant pages and coalesce concurrent fetches', async () => {
  const data = rows(130);
  let fetches = 0;
  const svc = createSearchService({ cache: new SearchBufferCache(), fetchBatch: async ({ excludeIds, limit }) => {
    fetches++; await new Promise((resolve) => setImmediate(resolve)); return data.filter((r) => !excludeIds.includes(r._id)).slice(0, limit);
  } });
  const results = await Promise.all([svc.search({ q: 'dragon', page: 4, limit: 20 }), svc.search({ q: 'dragon', page: 4, limit: 20 })]);
  assert.deepEqual(ids(results[0]), data.slice(60,80).map((r) => r._id));
  assert.deepEqual(ids(results[1]), ids(results[0]));
  assert.equal(fetches, 2);
});

test('transient prefetch failure is retried when the next page is requested', async () => {
  const data = rows(5);
  let calls = 0;
  const scheduled = [];
  const svc = createSearchService({ cache: new SearchBufferCache(), batchSize: 2, schedule: (fn) => scheduled.push(fn), fetchBatch: async ({ excludeIds, limit }) => {
    if (++calls === 2) throw new Error('transient');
    return data.filter((r) => !excludeIds.includes(r._id)).slice(0, limit);
  } });
  await svc.search({ q: 'dragon', limit: 2 });
  scheduled.shift()();
  await Promise.all(svc._inflight.values());
  const next = await svc.search({ q: 'dragon', page: 2, limit: 2 });
  assert.deepEqual(ids(next), ['2', '3']);
  assert.equal(next.meta.pagination.hasNextPage, true);
});

test('cache invalidation during cold fetch cannot repopulate stale buffer data', async () => {
  const cache = new SearchBufferCache();
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const svc = createSearchService({ cache, fetchBatch: async () => {
    if (++calls === 1) { started.resolve(); await release.promise; return [{ _id: 'stale' }]; }
    return [{ _id: 'fresh' }];
  } });
  const pending = svc.search({ q: 'dragon' });
  await started.promise;
  cache.clear();
  release.resolve();
  const next = await pending;
  assert.deepEqual(ids(next), ['fresh']);
  assert.deepEqual(ids(await svc.search({ q: 'dragon' })), ['fresh']);
});

test('empty buffered results report zero total pages', async () => {
  const svc = createSearchService({ cache: new SearchBufferCache(), fetchBatch: async () => [] });
  assert.equal((await svc.search({ q: 'empty' })).meta.pagination.totalPages, 0);
});

test('small generated graphs never create undefined target nodes', () => {
  const { generate10kNodes } = require('../scripts/datasetGenerator');
  for (const size of [0, 1, 5]) {
    const words = Array.from({ length: size }, (_, i) => `word${i}`);
    const nodes = generate10kNodes(words);
    assert.ok(nodes.every((node) => node.edges.every((edge) => words.includes(edge.target))));
  }
});

test('invalid request URLs return 400 without crashing the async HTTP handler', async (t) => {
  const base = await httpFixture(t, {});
  const http = require('node:http');
  const status = await new Promise((resolve, reject) => {
    const req = http.get(base, { path: 'http://[' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(status, 400);
});

test('load test reports measured percentiles and the documented request mix', () => {
  const { buildRealisticRequests, formatResultSummary } = require('../scripts/http-load-test');
  const requests = buildRealisticRequests(['session']);
  assert.equal(requests.length, 100);
  assert.equal(requests.filter((r) => r.path.includes('sessionId=')).length, 10);
  assert.equal(requests.filter((r) => r.path.includes('cybrpunk')).length + requests.filter((r) => r.path.includes('dragn')).length + requests.filter((r) => r.path.includes('anme')).length + requests.filter((r) => r.path.includes('sakura%20blosom')).length, 5);
  const result = formatResultSummary('fixture', { latency: { average: 1, p50: 1, p90: 2, p97_5: 4, p99: 5, p99_9: 6, max: 7, min: 0, stddev: 1 }, requests: { total: 1, average: 1 }, throughput: { average: 1 } });
  assert.equal(result.latency.p95Ms, null, 'P95 cannot be reconstructed from other percentiles');
  assert.equal(result.latency.p97_5Ms, 4);
});

test('load test fails for an unavailable explicit target without starting an unrelated local server', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [require.resolve('../scripts/http-load-test')], {
    env: { ...process.env, TARGET_URL: 'http://127.0.0.1:1' }, timeout: 10000, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Target health check failed/);
  assert.doesNotMatch(result.stdout, /Spawning test HTTP server/);
});

test('concurrency benchmark can be imported without running the entire ladder', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(require.resolve('../scripts/concurrency-ladder'))})`], { timeout: 10000, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('hop-constrained distances agree with exhaustive walks on deterministic small graphs', () => {
  let seed = 1234;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let fixture = 0; fixture < 30; fixture++) {
    const graph = new Map(Array.from({ length: 7 }, (_, i) => [String(i), new Map()]));
    for (const [from, edges] of graph) for (const to of graph.keys()) {
      if (from !== to && random() < 0.4) edges.set(to, Math.ceil(random() * 6));
    }
    for (const maxHops of [0, 1, 2, 3]) {
      const expected = new Map([['0', 0]]);
      const visit = (word, cost, hops) => {
        if (hops === maxHops) return;
        for (const [next, weight] of graph.get(word)) {
          const distance = cost + weight + (hops > 0 ? 1 : 0);
          if (distance > 6) continue;
          if (!expected.has(next) || distance < expected.get(next)) expected.set(next, distance);
          visit(next, distance, hops + 1);
        }
      };
      visit('0', 0, 0);
      const actual = singleSourceBoundedDijkstra(graph, '0', 6, maxHops);
      assert.deepEqual([...actual].sort(), [...expected].sort());
    }
  }
});

test('grouped term scoring matches exhaustive per-token penalties', () => {
  const { mergeTraversals, boostFor } = require('../src/services/semanticDijkstra');
  const tokens = [{ word: 'dragon', penalty: 15 }, { word: 'castle', penalty: 15 }, { word: 'dark', penalty: 6 }, { word: 'wallpaper', penalty: 1 }];
  const traversals = [new Map([['dragon',0], ['wyvern',2], ['all',8]]), new Map([['castle',0], ['all',7]]), new Map([['dark',0], ['all',6]]), new Map([['wallpaper',0], ['all',5]])];
  const words = new Set([...tokens.map((t) => t.word), ...traversals.flatMap((m) => [...m.keys()])]);
  const expected = [...words].map((term) => {
    const cost = Math.min(...tokens.map((t, i) => traversals[i].has(term) ? traversals[i].get(term) : t.penalty));
    return { term, cost, boost: boostFor(cost) };
  }).sort((a,b) => a.cost - b.cost || a.term.localeCompare(b.term));
  assert.deepEqual(mergeTraversals(tokens, traversals), expected);
  for (const limit of [0, 1, 3, 50]) assert.deepEqual(mergeTraversals(tokens, traversals, limit), expected.slice(0, limit));
  assert.deepEqual(mergeTraversals([...tokens, ...tokens, ...tokens], [...traversals, ...traversals, ...traversals]), expected);
});
