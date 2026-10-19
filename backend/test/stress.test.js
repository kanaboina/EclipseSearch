const test = require('node:test');
const assert = require('node:assert/strict');
const { NeighborIndex } = require('../src/services/neighborIndex');
const { createSingleflight } = require('../src/services/singleflight');
const { createProgressiveSearch } = require('../src/services/progressiveSearch');
const { addEdges } = require('../src/services/memoryGraph');
const { findClosestWordByNormalizedLCS, expandQuerySemantically } = require('../src/services/semanticDijkstra');

const WORD_COUNT = 10000;
const words = Array.from({ length: WORD_COUNT }, (_, i) => `w${i.toString(36)}x${i}`);

function bigGraph() {
  const g = new Map();
  for (let i = 0; i < WORD_COUNT; i++) {
    addEdges(g, words[i], [
      { target: words[(i + 1) % WORD_COUNT], weight: 1, relation: 'synonym' },
      { target: words[(i * 7 + 3) % WORD_COUNT], weight: 2, relation: 'scene' },
      { target: words[(i * 13 + 5) % WORD_COUNT], weight: 3, relation: 'scene' },
    ]);
  }
  return g;
}

const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ _id: String(i), score: 1000 - i }));

test('STRESS 1: build index over 10k words quickly and cap neighbors', () => {
  const g = bigGraph();
  const t = process.hrtime.bigint();
  const idx = new NeighborIndex(15).build(g);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 3000, `build took ${ms}ms`);
  for (const w of words.slice(0, 500)) {
    assert.ok(idx.neighborCounts[idx.idOf.get(w)] <= 15);
  }
});

test('STRESS 2: 5000 index expansions across 10k words sustain >1000/sec', () => {
  const idx = new NeighborIndex().build(bigGraph());
  const N = 5000;
  const t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const r = idx.expand(words[(i * 31) % WORD_COUNT]);
    assert.ok(r.terms.length >= 1);
  }
  const sec = Number(process.hrtime.bigint() - t) / 1e9;
  const rate = N / sec;
  assert.ok(rate > 1000, `only ${Math.round(rate)} expansions/sec`);
});

test('STRESS 3: 2000 concurrent identical searches coalesce into one fetch', async () => {
  const idx = new NeighborIndex().build(bigGraph());
  let fetches = 0;
  const sf = createSingleflight();
  const ps = createProgressiveSearch({
    index: idx,
    fetchPool: () => sf.run('hot', async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 30));
      return makeRows(100);
    }),
  });
  const results = await Promise.all(Array.from({ length: 2000 }, () => ps.search({ q: words[0] })));
  assert.equal(results.length, 2000);
  assert.ok(results.every((r) => r.data.length === 20));
  assert.equal(fetches, 1);
  assert.equal(sf.pending, 0);
});

test('STRESS 4: 3000 concurrent users with distinct sessions paginate with no duplicates', async () => {
  const idx = new NeighborIndex().build(bigGraph());
  const ps = createProgressiveSearch({ index: idx, fetchPool: async () => makeRows(60) });
  const USERS = 3000;
  const t = process.hrtime.bigint();
  const outcomes = await Promise.all(Array.from({ length: USERS }, async (_, u) => {
    const q = words[u % WORD_COUNT];
    const a = await ps.search({ q });
    const b = await ps.search({ q, sessionId: a.sessionId });
    const c = await ps.search({ q, sessionId: a.sessionId });
    return { sid: a.sessionId, ids: [...a.data, ...b.data, ...c.data].map((r) => r._id) };
  }));
  const sec = Number(process.hrtime.bigint() - t) / 1e9;
  assert.equal(new Set(outcomes.map((o) => o.sid)).size, USERS, 'session ids must be unique');
  for (const o of outcomes) assert.equal(new Set(o.ids).size, o.ids.length);
  assert.ok((USERS * 3) / sec > 1000, `only ${Math.round((USERS * 3) / sec)} searches/sec`);
});

test('STRESS 5: 10k-word query and typo storm stay bounded and correct', () => {
  const g = bigGraph();
  const bigQuery = words.join(' ');
  const t = process.hrtime.bigint();
  const { terms } = expandQuerySemantically(bigQuery, g);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(Array.isArray(terms));
  assert.ok(ms < 10000, `10k-word query took ${ms}ms`);

  // typo storm: repeated lookups must hit the cache (same object)
  const typo = 'wax1x1';
  const first = findClosestWordByNormalizedLCS(typo, g);
  for (let i = 0; i < 1000; i++) {
    assert.strictEqual(findClosestWordByNormalizedLCS(typo, g), first);
  }
});
