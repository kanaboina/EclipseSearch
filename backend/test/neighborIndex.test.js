const test = require('node:test');
const assert = require('node:assert/strict');
const { NeighborIndex } = require('../src/services/neighborIndex');
const { addEdges } = require('../src/services/memoryGraph');

function graphFixture() {
  const g = new Map();
  addEdges(g, 'dragon', [
    { target: 'wyvern', weight: 1, relation: 'synonym' },
    { target: 'fire', weight: 3, relation: 'scene' },
    { target: 'lizard', weight: 2, relation: 'hypernym' },
  ]);
  addEdges(g, 'castle', [{ target: 'fortress', weight: 1, relation: 'synonym' }]);
  addEdges(g, 'knight', [
    { target: 'warrior', weight: 1, relation: 'synonym' },
    { target: 'castle', weight: 2, relation: 'scene' },
  ]);
  return g;
}

test('NeighborIndex.size reflects the number of indexed words', () => {
  const idx = new NeighborIndex().build(graphFixture());
  assert.ok(idx.size >= 6); // dragon, wyvern, fire, lizard, castle, fortress, knight, warrior
});

test('NeighborIndex.has returns true for indexed words and false for unknown', () => {
  const idx = new NeighborIndex().build(graphFixture());
  assert.ok(idx.has('dragon'));
  assert.ok(idx.has('wyvern'));
  assert.ok(!idx.has('unicorn'));
});

test('NeighborIndex.byteLength is a positive number reflecting buffer sizes', () => {
  const idx = new NeighborIndex().build(graphFixture());
  assert.ok(idx.byteLength > 0);
  assert.equal(typeof idx.byteLength, 'number');
});

test('NeighborIndex.neighbors returns self at cost 0', () => {
  const idx = new NeighborIndex().build(graphFixture());
  const n = idx.neighbors('dragon');
  assert.equal(n.get('dragon'), 0);
});

test('NeighborIndex.neighbors for unknown word returns only self at cost 0', () => {
  const idx = new NeighborIndex().build(graphFixture());
  const n = idx.neighbors('unicorn');
  assert.equal(n.size, 1);
  assert.equal(n.get('unicorn'), 0);
});

test('NeighborIndex.expand with empty query returns empty terms', () => {
  const idx = new NeighborIndex().build(graphFixture());
  const result = idx.expand('');
  assert.deepEqual(result.tokens, []);
  assert.deepEqual(result.terms, []);
});

test('NeighborIndex.expand with multi-word query returns merged neighbor lists', () => {
  const idx = new NeighborIndex().build(graphFixture());
  const result = idx.expand('dragon castle');
  const terms = result.terms.map((t) => t.term);
  assert.ok(terms.includes('wyvern'));
  assert.ok(terms.includes('fortress'));
  assert.ok(terms.includes('dragon'));
  assert.ok(terms.includes('castle'));
});

test('NeighborIndex.expand respects custom limit', () => {
  const idx = new NeighborIndex().build(graphFixture());
  const result = idx.expand('dragon', { limit: 3 });
  assert.ok(result.terms.length <= 3);
});

test('NeighborIndex.expand terms are sorted by cost ascending', () => {
  const idx = new NeighborIndex().build(graphFixture());
  const result = idx.expand('dragon');
  for (let i = 1; i < result.terms.length; i++) {
    assert.ok(result.terms[i].cost >= result.terms[i - 1].cost);
  }
});

test('NeighborIndex.build returns the index itself for chaining', () => {
  const idx = new NeighborIndex();
  const result = idx.build(graphFixture());
  assert.equal(result, idx);
});

test('NeighborIndex capacity doubles correctly when growing', () => {
  const g = new Map();
  // Add more nodes than the initial capacity (64)
  for (let i = 0; i < 100; i++) {
    addEdges(g, `word${i}`, [{ target: `word${(i + 1) % 100}`, weight: 1, relation: 'synonym' }]);
  }
  const idx = new NeighborIndex().build(g);
  assert.ok(idx.capacity >= 100);
  assert.equal(idx.size, 100);
  // Verify data integrity after growth
  const n = idx.neighbors('word0');
  assert.ok(n.has('word1'));
});

test('NeighborIndex.resolveDocIds with multi-word query aggregates scores', () => {
  const g = graphFixture();
  const idx = new NeighborIndex().build(g);
  const docIds = new Map([
    ['dragon', new Set(['d1', 'd2'])],
    ['castle', new Set(['d2', 'd3'])],
    ['fortress', new Set(['d3', 'd4'])],
  ]);
  const result = idx.resolveDocIds('dragon castle', docIds);
  assert.ok(result.docIds.length > 0);
  // d2 should score highest (matches both dragon and castle)
  const d2 = result.docIds.find((r) => r.docId === 'd2');
  assert.ok(d2);
  const d1 = result.docIds.find((r) => r.docId === 'd1');
  assert.ok(d1);
  assert.ok(d2.score >= d1.score);
});
