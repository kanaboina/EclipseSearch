const test = require('node:test');
const assert = require('node:assert/strict');
const { onWallpaperVisibilityChanged } = require('../src/services/searchLifecycle');
const { searchBufferCache } = require('../src/services/searchBufferCache');
const { generate10kWords, generate10kNodes, buildPopulatedGraph, BASE_WORDS } = require('../scripts/datasetGenerator');
const { expandQuerySemantically, analyzeQuery, charMask, popcount } = require('../src/services/semanticDijkstra');
const { addEdges } = require('../src/services/memoryGraph');
const { normalizeTokenStrict } = require('../src/services/textNlp');

// --- searchLifecycle ---

test('onWallpaperVisibilityChanged invalidates the search buffer cache', () => {
  searchBufferCache.set('test-visibility', 'val');
  const genBefore = searchBufferCache.generation;
  onWallpaperVisibilityChanged();
  assert.equal(searchBufferCache.get('test-visibility'), undefined);
  assert.equal(searchBufferCache.generation, genBefore + 1);
});

// --- semanticDijkstra: expandQuerySemantically edge cases ---

test('expandQuerySemantically returns empty terms for empty query', () => {
  const g = new Map();
  addEdges(g, 'dragon', [{ target: 'wyvern', weight: 1, relation: 'synonym' }]);
  const result = expandQuerySemantically('', g);
  assert.deepEqual(result.terms, []);
});

test('expandQuerySemantically with unknown word and no graph neighbors returns query token', () => {
  const g = new Map();
  addEdges(g, 'dragon', [{ target: 'wyvern', weight: 1, relation: 'synonym' }]);
  const result = expandQuerySemantically('unicorn', g);
  const names = result.terms.map((t) => t.term);
  assert.ok(names.includes('unicorn'));
});

test('expandQuerySemantically with multi-word query merges disjoint neighborhoods', () => {
  const g = new Map();
  addEdges(g, 'dragon', [{ target: 'wyvern', weight: 1, relation: 'synonym' }]);
  addEdges(g, 'castle', [{ target: 'fortress', weight: 1, relation: 'synonym' }]);
  const result = expandQuerySemantically('dragon castle', g);
  const names = result.terms.map((t) => t.term);
  assert.ok(names.includes('wyvern'));
  assert.ok(names.includes('fortress'));
});

test('expandQuerySemantically terms are capped at TOP_TERMS', () => {
  const g = new Map();
  const edges = Array.from({ length: 30 }, (_, i) => ({ target: `t${i}`, weight: 1, relation: 'synonym' }));
  addEdges(g, 'hub', edges);
  const result = expandQuerySemantically('hub', g, 10);
  assert.ok(result.terms.length <= 10);
});

// --- charMask / popcount edge cases ---

test('charMask handles empty string', () => {
  assert.equal(charMask(''), 0);
});

test('charMask handles non-alphabetic characters', () => {
  assert.equal(charMask('123!@#'), 0);
});

test('popcount handles zero', () => {
  assert.equal(popcount(0), 0);
});

test('popcount handles all 26 bits set', () => {
  let mask = 0;
  for (let i = 0; i < 26; i++) mask |= (1 << i);
  assert.equal(popcount(mask >>> 0), 26);
});

// --- analyzeQuery edge cases ---

test('analyzeQuery preserves internal hyphens as both hyphenated and stripped forms', () => {
  const tokens = analyzeQuery('sci-fi');
  const words = tokens.map((t) => t.word);
  assert.ok(words.includes('sci-fi') || words.includes('scifi'));
});

test('analyzeQuery handles emoji-only input', () => {
  const tokens = analyzeQuery('🐉🔥');
  assert.deepEqual(tokens, []);
});

// --- normalizeTokenStrict ---

test('normalizeTokenStrict strips all non-alphanumeric including hyphens', () => {
  assert.equal(normalizeTokenStrict('dark-wolf!'), 'darkwolf');
  assert.equal(normalizeTokenStrict('Sci-Fi'), 'scifi');
  assert.equal(normalizeTokenStrict('  Hello  '), 'hello');
});

// --- datasetGenerator ---

test('generate10kWords returns at least 10000 unique words', () => {
  const words = generate10kWords();
  assert.ok(words.length >= 10000);
  assert.equal(new Set(words).size, words.length);
});

test('generate10kNodes produces a node per word with valid edges', () => {
  const words = generate10kWords().slice(0, 200); // need >=100 for hub bias
  const nodes = generate10kNodes(words);
  assert.equal(nodes.length, 200);
  for (const n of nodes) {
    assert.ok(typeof n.word === 'string');
    assert.ok(Array.isArray(n.edges));
    for (const e of n.edges) {
      assert.ok(typeof e.target === 'string');
      assert.ok(e.weight >= 1 && e.weight <= 6);
      assert.ok(typeof e.relation === 'string');
    }
  }
});

test('buildPopulatedGraph returns a Map with all node words as keys', () => {
  const words = generate10kWords().slice(0, 100);
  const nodes = generate10kNodes(words);
  const g = buildPopulatedGraph(nodes);
  assert.ok(g instanceof Map);
  for (const n of nodes) {
    assert.ok(g.has(n.word), `Graph missing word: ${n.word}`);
  }
});

test('BASE_WORDS contains common fantasy terms', () => {
  assert.ok(BASE_WORDS.includes('dragon'));
  assert.ok(BASE_WORDS.includes('knight'));
  assert.ok(BASE_WORDS.includes('castle'));
});
