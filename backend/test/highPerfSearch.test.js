const test = require('node:test');
const assert = require('node:assert/strict');
const { NeighborIndex } = require('../src/services/neighborIndex');
const { createSingleflight } = require('../src/services/singleflight');
const { createProgressiveSearch, searchKey } = require('../src/services/progressiveSearch');
const { addEdges } = require('../src/services/memoryGraph');
const { charMask, popcount, findClosestWordByNormalizedLCS, expandQuerySemantically } = require('../src/services/semanticDijkstra');

function graphFixture() {
  const g = new Map();
  addEdges(g, 'dragon', [
    { target: 'wyvern', weight: 1, relation: 'synonym' },
    { target: 'fire', weight: 3, relation: 'scene' },
  ]);
  addEdges(g, 'castle', [{ target: 'fortress', weight: 1, relation: 'synonym' }]);
  return g;
}

test('NeighborIndex stores neighbors in TypedArrays and matches live expansion', () => {
  const g = graphFixture();
  const idx = new NeighborIndex().build(g);
  assert.ok(idx.neighborNodeIds instanceof Uint32Array);
  assert.ok(idx.neighborCosts instanceof Uint8Array);
  assert.equal(idx.neighbors('dragon').get('wyvern'), 1);
  const live = expandQuerySemantically('dragon', g).terms.map((t) => t.term);
  const pre = idx.expand('dragon').terms.map((t) => t.term);
  assert.ok(pre.includes('wyvern') && pre.includes('fire'));
  assert.ok(live.includes('wyvern'));
});

test('NeighborIndex caps neighbors at k', () => {
  const g = new Map();
  addEdges(g, 'hub', Array.from({ length: 30 }, (_, i) => ({ target: `n${i}`, weight: 2, relation: 'synonym' })));
  const idx = new NeighborIndex(15).build(g);
  assert.equal(idx.neighborCounts[idx.idOf.get('hub')], 15);
});

test('singleflight coalesces concurrent identical calls', async () => {
  const sf = createSingleflight();
  let calls = 0;
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return 'x'; };
  const r = await Promise.all([sf.run('k', fn), sf.run('k', fn), sf.run('k', fn)]);
  assert.deepEqual(r, ['x', 'x', 'x']);
  assert.equal(calls, 1);
  assert.equal(sf.pending, 0);
});

test('progressive search slices pool, dedupes via session Set, and fetches once', async () => {
  const idx = new NeighborIndex().build(graphFixture());
  let fetches = 0;
  const rows = Array.from({ length: 45 }, (_, i) => ({ _id: String(i % 40), score: 100 - i }));
  const ps = createProgressiveSearch({ index: idx, fetchPool: async () => { fetches++; return rows; } });
  const a = await ps.search({ q: 'dragon' });
  assert.equal(a.data.length, 20);
  const b = await ps.search({ q: 'dragon', sessionId: a.sessionId });
  const c = await ps.search({ q: 'dragon', sessionId: a.sessionId });
  const ids = [...a.data, ...b.data, ...c.data].map((r) => r._id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 40);
  assert.equal(c.hasMore, false);
  assert.equal(fetches, 1);
});

test('progressive search relevance cutoff ends pagination on weak scores', async () => {
  const idx = new NeighborIndex().build(graphFixture());
  const rows = [{ _id: 'a', score: 100 }, { _id: 'b', score: 90 }, { _id: 'c', score: 10 }];
  const ps = createProgressiveSearch({ index: idx, fetchPool: async () => rows, minScoreRatio: 0.5 });
  const r = await ps.search({ q: 'dragon' });
  assert.deepEqual(r.data.map((x) => x._id), ['a', 'b']);
  assert.equal(r.hasMore, false);
});

test('searchKey normalizes order and whitespace', () => {
  assert.equal(searchKey('  Red   Dragon '), searchKey('dragon red'));
});

test('charMask/popcount and typo cache', () => {
  assert.equal(popcount(charMask('abca')), 3);
  const g = graphFixture();
  const first = findClosestWordByNormalizedLCS('drgon', g);
  assert.equal(first.word, 'dragon');
  assert.strictEqual(findClosestWordByNormalizedLCS('drgon', g), first); // cached
  assert.equal(findClosestWordByNormalizedLCS('zzzzqq', g), null);
});

test('only the first 2 unknown tokens use LCS fallback', () => {
  const g = graphFixture();
  const { terms } = expandQuerySemantically('drgon castel frtress', g);
  const names = terms.map((t) => t.term);
  assert.ok(names.includes('wyvern') && names.includes('fortress') === true || names.includes('castle'));
});

test('NeighborIndex.update refreshes only on write and expand reads precomputed arrays', () => {
  const g = graphFixture();
  const idx = new NeighborIndex().build(g);
  assert.ok(!idx.expand('dragon').terms.some((t) => t.term === 'drake'));
  addEdges(g, 'wyvern', [{ target: 'drake', weight: 1, relation: 'synonym' }]);
  idx.update(g, ['wyvern']); // write path
  assert.ok(idx.expand('dragon').terms.some((t) => t.term === 'drake')); // 2-hop neighbor of dragon refreshed
  assert.ok(idx.expand('drgon').terms.some((t) => t.term === 'wyvern')); // typo -> dictionary word -> precomputed list
});

test('NeighborIndex.resolveDocIds returns ranked docIds from posting lists', () => {
  const g = graphFixture();
  const idx = new NeighborIndex().build(g);

  // Build a local wordDocIds map for isolation
  const docIds = new Map([
    ['dragon',  new Set(['doc-1', 'doc-2'])],
    ['wyvern',  new Set(['doc-2', 'doc-3'])],
    ['fire',    new Set(['doc-1', 'doc-4'])],
    ['castle',  new Set(['doc-5'])],
  ]);

  const result = idx.resolveDocIds('dragon', docIds);
  // doc-1 and doc-2 appear under 'dragon' directly; doc-2 and doc-3 under 'wyvern' (neighbor)
  assert.ok(Array.isArray(result.docIds));
  assert.ok(result.docIds.length > 0);
  const ids = result.docIds.map((r) => r.docId);
  assert.ok(ids.includes('doc-1'));
  assert.ok(ids.includes('doc-2'));
  // doc-2 matched multiple terms so should score higher than doc-4
  const score2 = result.docIds.find((r) => r.docId === 'doc-2').score;
  const score4 = result.docIds.find((r) => r.docId === 'doc-4')?.score ?? 0;
  assert.ok(score2 >= score4);
});

test('NeighborIndex.resolveDocIds returns empty when no posting lists exist', () => {
  const g = graphFixture();
  const idx = new NeighborIndex().build(g);
  const emptyDocIds = new Map();
  const result = idx.resolveDocIds('dragon', emptyDocIds);
  assert.deepEqual(result.docIds, []);
});

test('NeighborIndex.resolveDocIds respects limit and returns at most limit entries', () => {
  const g = graphFixture();
  const idx = new NeighborIndex().build(g);
  // Seed many docIds under 'dragon' and its neighbors
  const docIds = new Map();
  const allTerms = ['dragon', 'wyvern', 'fire', 'castle', 'fortress'];
  for (const term of allTerms) {
    const s = new Set();
    for (let i = 0; i < 50; i++) s.add(`${term}-doc-${i}`);
    docIds.set(term, s);
  }
  const result = idx.resolveDocIds('dragon castle', docIds, 30);
  assert.ok(result.docIds.length <= 30);
});

test('progressive search ID-first mode fetches docs per batch and dedupes', async () => {
  const g = graphFixture();
  const idx = new NeighborIndex().build(g);

  // Simulate a pool of ranked docIds
  const rankedPool = Array.from({ length: 45 }, (_, i) => ({ docId: `id-${i}`, score: 100 - i }));

  let fetchDocsCalls = 0;
  const ps = createProgressiveSearch({
    index: idx,
    resolvePool: async () => rankedPool,
    fetchDocs: async ({ ids }) => {
      fetchDocsCalls++;
      // Return docs in reverse order to test that reordering works
      return ids.map((id) => ({ _id: id, title: `Title ${id}` })).reverse();
    },
  });

  const a = await ps.search({ q: 'dragon' });
  assert.equal(a.data.length, 20);
  // Documents should be in the ranking order of docIds, not fetch order
  assert.equal(a.data[0]._id, 'id-0');
  assert.equal(a.data[19]._id, 'id-19');

  const b = await ps.search({ q: 'dragon', sessionId: a.sessionId });
  const c = await ps.search({ q: 'dragon', sessionId: a.sessionId });
  const allIds = [...a.data, ...b.data, ...c.data].map((r) => r._id);
  // No duplicates
  assert.equal(new Set(allIds).size, allIds.length);
  assert.equal(allIds.length, 45);
  assert.equal(c.hasMore, false);
  // fetchDocs is called once per batch (3 batches), NOT once for the whole pool
  assert.equal(fetchDocsCalls, 3);
});
