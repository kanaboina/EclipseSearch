const test = require('node:test');
const assert = require('node:assert/strict');
const { createProgressiveSearch, searchKey, BATCH_SIZE, POOL_SIZE, MIN_BOOST } = require('../src/services/progressiveSearch');
const { NeighborIndex } = require('../src/services/neighborIndex');
const { addEdges } = require('../src/services/memoryGraph');

function graphFixture() {
  const g = new Map();
  addEdges(g, 'dragon', [
    { target: 'wyvern', weight: 1, relation: 'synonym' },
    { target: 'fire', weight: 3, relation: 'scene' },
  ]);
  return g;
}

test('searchKey is order-insensitive', () => {
  assert.equal(searchKey('dragon castle'), searchKey('castle dragon'));
});

test('searchKey handles null, undefined and falsy values', () => {
  assert.equal(searchKey(null), '');
  assert.equal(searchKey(undefined), '');
  assert.equal(searchKey(0), ''); // 0 is falsy, so q || '' yields ''
});

test('searchKey collapses multiple spaces and trims', () => {
  assert.equal(searchKey('  dragon   castle  '), 'castle dragon');
});

test('exported constants have expected values', () => {
  assert.equal(BATCH_SIZE, 20);
  assert.equal(POOL_SIZE, 200);
  assert.equal(MIN_BOOST, 2);
});

test('progressive search legacy mode handles empty fetchPool', async () => {
  const idx = new NeighborIndex().build(graphFixture());
  const ps = createProgressiveSearch({
    index: idx,
    fetchPool: async () => [],
  });
  const r = await ps.search({ q: 'dragon' });
  assert.equal(r.data.length, 0);
  assert.equal(r.hasMore, false);
  assert.ok(r.sessionId);
});

test('progressive search legacy mode custom batchSize', async () => {
  const idx = new NeighborIndex().build(graphFixture());
  const rows = Array.from({ length: 30 }, (_, i) => ({ _id: String(i), score: 100 - i }));
  const ps = createProgressiveSearch({
    index: idx,
    fetchPool: async () => rows,
    batchSize: 10,
  });
  const r = await ps.search({ q: 'dragon' });
  assert.equal(r.data.length, 10);
  assert.equal(r.hasMore, true);
});

test('progressive search ID-first mode works with empty resolvePool', async () => {
  const idx = new NeighborIndex().build(graphFixture());
  const ps = createProgressiveSearch({
    index: idx,
    resolvePool: async () => [],
    fetchDocs: async () => [],
  });
  const r = await ps.search({ q: 'dragon' });
  assert.equal(r.data.length, 0);
  assert.equal(r.hasMore, false);
});

test('progressive search sessions are isolated per sessionId', async () => {
  const idx = new NeighborIndex().build(graphFixture());
  const rows = Array.from({ length: 50 }, (_, i) => ({ _id: String(i), score: 100 - i }));
  const ps = createProgressiveSearch({
    index: idx,
    fetchPool: async () => rows,
  });
  const r1 = await ps.search({ q: 'dragon' });
  const r2 = await ps.search({ q: 'wyvern' });
  // Different queries create different sessions
  assert.notEqual(r1.sessionId, r2.sessionId);
});

test('progressive search ID-first mode reorders docs to match ranking', async () => {
  const idx = new NeighborIndex().build(graphFixture());
  const rankedPool = [
    { docId: 'first', score: 100 },
    { docId: 'second', score: 50 },
    { docId: 'third', score: 10 },
  ];
  const ps = createProgressiveSearch({
    index: idx,
    resolvePool: async () => rankedPool,
    fetchDocs: async ({ ids }) =>
      // Return docs in REVERSE order to verify reordering
      ids.map((id) => ({ _id: id, title: `Doc ${id}` })).reverse(),
    batchSize: 10,
  });
  const r = await ps.search({ q: 'dragon' });
  assert.equal(r.data[0]._id, 'first');
  assert.equal(r.data[1]._id, 'second');
  assert.equal(r.data[2]._id, 'third');
});

test('progressive search sessions.get after search returns session data', async () => {
  const idx = new NeighborIndex().build(graphFixture());
  const rows = Array.from({ length: 5 }, (_, i) => ({ _id: String(i), score: 10 }));
  const ps = createProgressiveSearch({
    index: idx,
    fetchPool: async () => rows,
  });
  const r = await ps.search({ q: 'dragon' });
  const session = ps.sessions.get(r.sessionId);
  assert.ok(session);
  assert.ok(session.seenIds instanceof Set);
});
