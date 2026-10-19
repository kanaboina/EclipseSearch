const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryGraph, addEdges } = require('../src/services/memoryGraph');
const { singleSourceBoundedDijkstra, expandQuerySemantically, analyzeQuery, boostFor } = require('../src/services/semanticDijkstra');
const { extractCleanWords } = require('../src/services/textNlp');

function graph(spec) {
  const g = new Map();
  for (const [w, edges] of Object.entries(spec)) addEdges(g, w, edges);
  return g;
}

test('extractCleanWords singularizes, dedupes, strips stopwords', () => {
  const w = extractCleanWords({ title: 'Dark Clouds over the Castle', tags: ['clouds', 'Fenrir'] });
  assert.ok(w.includes('cloud'));
  assert.ok(w.includes('fenrir'));
  assert.ok(!w.includes('the'));
  assert.equal(new Set(w).size, w.length);
});

test('asymmetric hypernym/hyponym weights', () => {
  const g = graph({ animal: [{ target: 'dog', weight: 2, relation: 'hyponym' }] });
  assert.equal(g.get('animal').get('dog'), 2);
  assert.equal(g.get('dog').get('animal'), 4);
});

test('dijkstra respects maxCost 6 and hop friction', () => {
  const g = graph({
    a: [{ target: 'b', weight: 2, relation: 'sibling' }],
    b: [{ target: 'c', weight: 2, relation: 'sibling' }],
    c: [{ target: 'd', weight: 1, relation: 'synonym' }],
  });
  const d = singleSourceBoundedDijkstra(g, 'a');
  assert.equal(d.get('b'), 2);
  assert.equal(d.get('c'), 5); // 2 + 2 + 1 friction
  assert.equal(d.has('d'), false); // 3rd hop blocked
});

test('weight 0 > weight 1 > weight 2 ranking by boost', () => {
  const g = graph({
    dog: [{ target: 'puppy', weight: 1, relation: 'synonym' }, { target: 'wolf', weight: 2, relation: 'hyponym' }],
  });
  const { terms } = expandQuerySemantically('dog', g);
  const by = Object.fromEntries(terms.map((t) => [t.term, t.boost]));
  assert.equal(by.dog, 20);
  assert.ok(by.dog > by.puppy && by.puppy > by.wolf);
  assert.equal(boostFor(0), 20);
});

test('multi-source intersection: dark sky wolf finds night/cloud/fenrir', () => {
  const g = graph({
    dark: [{ target: 'night', weight: 2, relation: 'sibling' }],
    sky: [{ target: 'cloud', weight: 1, relation: 'synonym' }],
    wolf: [{ target: 'fenrir', weight: 2, relation: 'hyponym' }],
  });
  const { terms } = expandQuerySemantically('dark sky wolf', g);
  const names = terms.map((t) => t.term);
  for (const n of ['night', 'cloud', 'fenrir']) assert.ok(names.includes(n), n);
  assert.ok(terms.length <= 25);
});

test('analyzeQuery assigns penalties', () => {
  const t = Object.fromEntries(analyzeQuery('dark wolf wallpaper 4k').map((x) => [x.word, x.penalty]));
  assert.equal(t.wolf, 15);
  assert.equal(t.wallpaper, 1);
  assert.equal(t['4k'], 1);
});

test('normalized LCS maps typos to graph words with initialCost 1 or 2', () => {
  const { findClosestWordByNormalizedLCS } = require('../src/services/semanticDijkstra');
  const g = graph({ dragon: [{ target: 'wyvern', weight: 2, relation: 'sibling' }], castle: [] });
  const hi = findClosestWordByNormalizedLCS('dragn', g);
  assert.equal(hi.word, 'dragon');
  assert.equal(hi.initialCost, 1);
  assert.equal(findClosestWordByNormalizedLCS('zzzzzz', g), null);
  const { terms } = expandQuerySemantically('dragn', g);
  const by = Object.fromEntries(terms.map((t) => [t.term, t.cost]));
  assert.equal(by.wyvern, 3);
});
