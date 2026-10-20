const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { createProgressiveSearch } = require('../src/services/progressiveSearch');
const { NeighborIndex, neighborIndex } = require('../src/services/neighborIndex');
const { setupSearchEngine, createSearchHttpServer } = require('../src/server');
const SemanticNode = require('../src/models/SemanticNode');
const Wallpaper = require('../src/models/Wallpaper');
const { memoryGraph, wordDocIds, initMemoryGraph } = require('../src/services/memoryGraph');
const { callLlmWithFallback } = require('../src/services/aiGraphService');
const { createDraftRetryWorker } = require('../src/workers/draftRetryWorker');
const { onWallpaperEdited } = require('../src/services/searchLifecycle');
const { backfill } = require('../scripts/backfill-semantic-graph');
const { buildAtlasPipeline, fetchSearchBatch } = require('../src/services/searchRanking');
const index = () => new NeighborIndex().build(new Map([['dragon', new Map()]]));
const queryResult = (rows) => ({ select: () => ({ lean: async () => rows }) });

test('ID pagination returns every visible document, fills filtered pages and keeps device filter', async () => {
  const ranked = Array.from({ length: 45 }, (_, i) => ({ docId: String(i), score: 100 - i }));
  const ps = createProgressiveSearch({ index: index(), resolvePool: async () => ranked,
    fetchDocs: async ({ ids, deviceType }) => {
      assert.equal(deviceType, 'phone');
      return ids.filter((id) => Number(id) % 4 !== 0).map((_id) => ({ _id })).reverse();
    } });
  let page = await ps.search({ q: 'dragon', deviceType: 'phone', limit: 5 });
  const all = [];
  for (let n = 0; n < 20; n++) {
    all.push(...page.data.map((d) => d._id));
    if (!page.hasMore) break;
    assert.equal(page.data.length, 5);
    page = await ps.search({ sessionId: page.sessionId, limit: 5 });
  }
  assert.deepEqual(all, ranked.map((r) => r.docId).filter((id) => Number(id) % 4 !== 0));
});

test('ID pagination retries failed hydration without losing results', async () => {
  let fail = true;
  const ps = createProgressiveSearch({ index: index(), resolvePool: async () => [{ docId: '1' }],
    fetchDocs: async ({ ids }) => { if (fail) { fail = false; throw new Error('transient'); } return ids.map((_id) => ({ _id })); } });
  await assert.rejects(ps.search({ q: 'dragon' }), /transient/);
  const sessionId = [...ps.sessions.keys()][0];
  const result = await ps.search({ sessionId });
  assert.deepEqual(result.data.map((d) => d._id), ['1']);
});

test('partial provider responses use backup for missing words', async () => {
  let backupCalled = false;
  const result = await callLlmWithFallback(['dragon', 'wolf'], [
    { name: 'primary', call: async () => JSON.stringify({ expansions: { dragon: [{ target: 'wyvern', weight: 1 }] } }) },
    { name: 'backup', call: async (prompt) => { backupCalled = true; assert.match(prompt, /Words: \["wolf"\]/);
      return JSON.stringify({ expansions: { wolf: [{ target: 'canine', weight: 1 }] } }); } },
  ]);
  assert.equal(backupCalled, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(Object.keys(result.expansions).sort(), ['dragon', 'wolf']);
});

test('retry worker leaves partial expansions in draft and retries only missing words', async () => {
  let published = false;
  let update;
  const worker = createDraftRetryWorker({ Wallpaper: { updateOne: async () => { published = true; } },
    Job: { updateOne: async (_, value) => { update = value.$set; } },
    expand: async () => ({ expanded: ['dragon'], missing: ['wolf'] }) });
  assert.equal(await worker.processJob({ _id: 'job', wallpaperId: 'wall', attempts: 0, unprocessedWords: ['dragon', 'wolf'] }), 'retry');
  assert.equal(published, false);
  assert.deepEqual(update.unprocessedWords, ['wolf']);
  assert.equal(update.state, 'pending');
});

test('editing removes persisted postings so they stay removed after graph reload', async () => {
  const nodes = [{ word: 'dragon', edges: [], docIds: ['wall'] }, { word: 'wolf', isExpanded: true, edges: [], docIds: [] }];
  const Model = {
    find: (filter) => queryResult(filter.isExpanded ? nodes.filter((n) => n.isExpanded) : nodes),
    updateMany: async (filter, update) => {
      assert.deepEqual(filter.word.$in, ['dragon']);
      for (const n of nodes.filter((n) => filter.word.$in.includes(n.word))) n.docIds = n.docIds.filter((id) => id !== update.$pull.docIds);
    },
    bulkWrite: async () => {},
  };
  await initMemoryGraph(Model);
  await onWallpaperEdited({ _id: 'wall', tags: ['dragon'] }, { _id: 'wall', tags: ['wolf'] }, 'published', { Model });
  await initMemoryGraph(Model);
  assert.equal(wordDocIds.get('dragon')?.has('wall') || false, false);
});

test('backfill honors injected models and reports partial failures', async () => {
  const linked = [];
  const result = await backfill({ Wallpaper: { find: () => queryResult([{ _id: 'wall', tags: ['dragon', 'wolf'] }]) },
    Model: { find: () => queryResult([]) }, expand: async () => ({ expanded: ['dragon'], missing: ['wolf'] }),
    link: async (...args) => linked.push(args), log: () => {}, delayMs: 0 });
  assert.equal(result.done, 1);
  assert.deepEqual(result.failed, ['wolf']);
  assert.equal(result.linked, 1);
  assert.equal(linked[0][0], 'wall');
});

test('semantic terms can qualify a primary match without matching the raw word', () => {
  const pipeline = buildAtlasPipeline({ q: 'dragon', expansion: { terms: [{ term: 'wyvern', boost: 10 }] } });
  const gate = pipeline[0].$search.compound.must[0].compound.should;
  assert.ok(gate.some((c) => c.text?.query === 'wyvern' && c.text.path === 'title'));
  assert.ok(!gate.some((c) => c.text?.path === 'excerpt'));
});

test('MongoDB fallback can populate a category with the standalone registered models', async (t) => {
  const categoryId = new mongoose.Types.ObjectId();
  t.mock.method(Wallpaper, 'aggregate', async () => { throw new Error('SearchNotEnabled'); });
  t.mock.method(Wallpaper.collection, 'find', () => ({ toArray: async () => [{ _id: new mongoose.Types.ObjectId(), category: categoryId }] }));
  const Category = mongoose.models.Category;
  assert.ok(Category, 'Category model must be registered for fallback populate');
  t.mock.method(Category.collection, 'find', () => ({ toArray: async () => [{ _id: categoryId, name: 'Fantasy', slug: 'fantasy' }] }));
  const rows = await fetchSearchBatch(Wallpaper, { q: 'dragon' });
  assert.equal(rows[0].category.name, 'Fantasy');
});

test('live startup uses the shared index and the real fallback schema', async (t) => {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(SemanticNode, 'find', () => queryResult([{ word: 'dragon', edges: [{ target: 'wyvern', weight: 1, relation: 'synonym' }], docIds: [] }]));
  let pipeline;
  t.mock.method(Wallpaper, 'aggregate', async (value) => { pipeline = value; return [{ _id: 'wall', title: 'Wyvern', downloadKeys: ['private'] }]; });
  t.mock.method(Wallpaper, 'find', () => ({ populate: () => ({ lean: async () => [{ _id: 'wall', title: 'Wyvern', downloadKeys: ['private'] }] }) }));
  const engine = await setupSearchEngine({ mongoUri: 'mongodb://synthetic' });
  assert.equal(engine.neighborIndex, neighborIndex);
  assert.ok(!engine.neighborIndex.has('castle'), 'live index must not contain synthetic catalog terms');
  const result = await engine.progressiveSearch.search({ q: 'dragon' });
  assert.ok(pipeline);
  assert.ok(pipeline[0].$search.compound.must[0].compound.should.some((c) => c.text?.query === 'wyvern'));
  assert.equal('downloadKeys' in result.data[0], false);
});

test('live startup never reports success after graph initialization fails', async (t) => {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(SemanticNode, 'find', () => { throw new Error('graph unavailable'); });
  await assert.rejects(setupSearchEngine({ mongoUri: 'mongodb://synthetic' }), /graph unavailable/);
});

test('HTTP pagination metadata counts the entire exhausted result pool', async (t) => {
  const ps = createProgressiveSearch({ index: index(), fetchPool: async () => Array.from({ length: 25 }, (_, i) => ({ _id: String(i) })) });
  const server = createSearchHttpServer({ progressiveSearch: ps, isAtlasLive: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const first = await (await fetch(`${base}/api/search?q=dragon`)).json();
  const last = await (await fetch(`${base}/api/search?sessionId=${first.sessionId}&page=2`)).json();
  assert.equal(last.data.length, 5);
  assert.equal(last.meta.total, 25);
  assert.equal(last.meta.totalPages, 2);
});

test('partial expansions survive an exhausted provider chain', async () => {
  const result = await callLlmWithFallback(['dragon', 'wolf'], [
    { name: 'partial', call: async () => JSON.stringify({ expansions: { dragon: [{ target: 'wyvern', weight: 1 }] } }) },
    { name: 'unavailable', call: async () => { throw new Error('offline'); } },
  ]);
  assert.deepEqual(Object.keys(result.expansions), ['dragon']);
  assert.deepEqual(result.missing, ['wolf']);
});

test('concurrent ID page requests advance a session without overlap', async () => {
  const ps = createProgressiveSearch({ index: index(), resolvePool: async () => Array.from({ length: 9 }, (_, i) => ({ docId: String(i) })),
    fetchDocs: async ({ ids }) => { await new Promise((resolve) => setImmediate(resolve)); return ids.map((_id) => ({ _id })); } });
  const first = await ps.search({ q: 'dragon', limit: 3 });
  const pages = await Promise.all([ps.search({ sessionId: first.sessionId, limit: 3 }), ps.search({ sessionId: first.sessionId, limit: 3 })]);
  assert.deepEqual([...first.data, ...pages.flatMap((p) => p.data)].map((d) => d._id), Array.from({ length: 9 }, (_, i) => String(i)));
});

test('upload persists partial expansion progress and returns missing words for the draft job', async () => {
  const { processWallpaperSemanticsOnUpload } = require('../src/services/aiGraphService');
  const batches = [];
  const Model = { find: () => queryResult([]), bulkWrite: async (ops) => batches.push(ops) };
  const result = await processWallpaperSemanticsOnUpload({ _id: 'partial-wall', tags: ['dragon', 'wolf'] }, 'published', {
    Model, graph: new Map(), index: new NeighborIndex(), providers: [{ name: 'partial', call: async () => JSON.stringify({ expansions: { dragon: [{ target: 'wyvern', weight: 1 }] } }) }],
  });
  assert.equal(result.status, 'draft');
  assert.deepEqual(result.unprocessedWords, ['wolf']);
  const expanded = batches.flat().filter((op) => op.updateOne.update.$set?.isExpanded).map((op) => op.updateOne.filter.word);
  assert.deepEqual(expanded, ['dragon']);
});

test('new sessions receive unpredictable server IDs even when a client supplies an unknown ID', async () => {
  const ps = createProgressiveSearch({ index: index(), fetchPool: async () => [] });
  const result = await ps.search({ q: 'dragon', sessionId: 'shared' });
  assert.notEqual(result.sessionId, 'shared');
});

test('live pagination rechecks visibility and device on every page', async (t) => {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(SemanticNode, 'find', () => queryResult([]));
  const rows = Array.from({ length: 5 }, (_, i) => ({ _id: String(i), title: 'Dragon', status: 'published' }));
  t.mock.method(Wallpaper, 'aggregate', async () => rows);
  t.mock.method(Wallpaper, 'find', (filter) => {
    assert.equal(filter.deviceType, 'phone');
    assert.deepEqual(filter.status, { $ne: 'draft' });
    assert.deepEqual(filter.deletionPending, { $ne: true });
    assert.ok(filter.$or[1].publishAt.$lte instanceof Date);
    return { populate: () => ({ lean: async () => rows.filter((r) => filter._id.$in.includes(r._id) && r.status !== 'draft') }) };
  });
  const engine = await setupSearchEngine({ mongoUri: 'mongodb://synthetic' });
  const first = await engine.progressiveSearch.search({ q: 'dragon', limit: 2, deviceType: 'phone' });
  rows[2].status = 'draft';
  const next = await engine.progressiveSearch.search({ sessionId: first.sessionId, limit: 2 });
  assert.deepEqual(next.data.map((d) => d._id), ['3', '4']);
});

test('HTTP rejects oversized queries and hides internal search errors', async (t) => {
  let searches = 0;
  const server = createSearchHttpServer({ isAtlasLive: true, progressiveSearch: { search: async () => { searches++; throw new Error('private database details'); } } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.mock.method(console, 'error', () => {});
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const q of ['a'.repeat(501), Array(21).fill('dragon').join(' ')]) {
    const response = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`);
    assert.equal(response.status, 400);
  }
  assert.equal(searches, 0);
  const response = await fetch(`${base}/api/search?q=dragon`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error' });
});
