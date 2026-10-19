const test = require('node:test');
const assert = require('node:assert/strict');
const { addEdges } = require('../src/services/memoryGraph');
const {
  analyzeQuery,
  singleSourceBoundedDijkstra,
  findClosestWordByNormalizedLCS,
  expandQuerySemantically,
  boostFor,
  MAX_COST,
  MAX_HOPS,
  TOP_TERMS,
} = require('../src/services/semanticDijkstra');

function buildGraph(spec) {
  const g = new Map();
  for (const [w, edges] of Object.entries(spec)) addEdges(g, w, edges);
  return g;
}

test('analyzeQuery assigns entity penalty (15) to nouns and proper nouns', () => {
  const tokens = analyzeQuery('wolf dragon castle');
  const map = Object.fromEntries(tokens.map((t) => [t.word, t.penalty]));
  assert.equal(map.wolf, 15);
  assert.equal(map.dragon, 15);
  assert.equal(map.castle, 15);
});

test('analyzeQuery assigns modifier penalty (6) to adjectives preceding nouns', () => {
  const tokens = analyzeQuery('dark wolf beautiful red dragon');
  const map = Object.fromEntries(tokens.map((t) => [t.word, t.penalty]));
  assert.equal(map.dark, 6);
  assert.equal(map.beautiful, 6);
  assert.equal(map.red, 6);
  assert.equal(map.wolf, 15);
  assert.equal(map.dragon, 15);
});

test('analyzeQuery assigns stopword penalty (1) to domain stopwords', () => {
  const tokens = analyzeQuery('wallpaper 4k desktop 1080p hd background');
  const map = Object.fromEntries(tokens.map((t) => [t.word, t.penalty]));
  assert.equal(map.wallpaper, 1);
  assert.equal(map['4k'], 1);
  assert.equal(map.desktop, 1);
  assert.equal(map.background, 1);
});

test('analyzeQuery filters out general stopwords completely', () => {
  const tokens = analyzeQuery('the wolf in and of a castle');
  const words = tokens.map((t) => t.word);
  assert.ok(!words.includes('the'));
  assert.ok(!words.includes('in'));
  assert.ok(!words.includes('and'));
  assert.ok(!words.includes('of'));
  assert.ok(!words.includes('a'));
  assert.ok(words.includes('wolf'));
  assert.ok(words.includes('castle'));
});

test('analyzeQuery handles empty strings and whitespace-only queries', () => {
  assert.deepEqual(analyzeQuery(''), []);
  assert.deepEqual(analyzeQuery('   \t\n  '), []);
  assert.deepEqual(analyzeQuery(null), []);
});

test('analyzeQuery deduplicates words and retains maximum penalty', () => {
  // 'dark' in 'dark wolf' is modifier (6), but standalone 'dark' is noun (15); max penalty 15 is retained
  const tokens = analyzeQuery('dark wolf dark');
  const darkTokens = tokens.filter((t) => t.word === 'dark');
  assert.equal(darkTokens.length, 1);
  assert.equal(darkTokens[0].penalty, 15);
});

test('singleSourceBoundedDijkstra discovers immediate neighbors at exact weight', () => {
  const g = buildGraph({
    wolf: [
      { target: 'fenrir', weight: 1, relation: 'synonym' },
      { target: 'canine', weight: 2, relation: 'hypernym' },
    ],
  });
  const dist = singleSourceBoundedDijkstra(g, 'wolf');
  assert.equal(dist.get('wolf'), 0);
  assert.equal(dist.get('fenrir'), 1);
  assert.equal(dist.get('canine'), 4); // hypernym forward is 4
});

test('singleSourceBoundedDijkstra enforces +1 hop friction penalty on second hop', () => {
  const g = buildGraph({
    a: [{ target: 'b', weight: 2, relation: 'sibling' }],
    b: [{ target: 'c', weight: 2, relation: 'sibling' }],
  });
  const dist = singleSourceBoundedDijkstra(g, 'a');
  assert.equal(dist.get('b'), 2);
  // hop 1: a->b cost 2. hop 2: b->c cost 2 + 2 + 1 (hop friction) = 5
  assert.equal(dist.get('c'), 5);
});

test('singleSourceBoundedDijkstra prunes paths exceeding maxCost 6', () => {
  const g = buildGraph({
    a: [{ target: 'b', weight: 4, relation: 'mood' }],
    b: [{ target: 'c', weight: 3, relation: 'sibling' }],
  });
  const dist = singleSourceBoundedDijkstra(g, 'a');
  assert.equal(dist.get('b'), 4);
  // a->b(4) + b->c(3) + friction(1) = 8 > 6, so c must be excluded
  assert.equal(dist.has('c'), false);
});

test('singleSourceBoundedDijkstra prunes paths exceeding maxHops 2', () => {
  const g = buildGraph({
    h0: [{ target: 'h1', weight: 1, relation: 'synonym' }],
    h1: [{ target: 'h2', weight: 1, relation: 'synonym' }],
    h2: [{ target: 'h3', weight: 1, relation: 'synonym' }],
  });
  const dist = singleSourceBoundedDijkstra(g, 'h0');
  assert.equal(dist.get('h0'), 0);
  assert.equal(dist.get('h1'), 1);
  assert.equal(dist.get('h2'), 3); // 1 + 1 + 1 (friction)
  assert.equal(dist.has('h3'), false); // hop 3 blocked
});

test('singleSourceBoundedDijkstra selects shortest path when multiple alternate routes exist', () => {
  const g = buildGraph({
    start: [
      { target: 'direct', weight: 5, relation: 'mood' },
      { target: 'shortcut', weight: 1, relation: 'synonym' },
    ],
    shortcut: [{ target: 'direct', weight: 1, relation: 'synonym' }],
  });
  const dist = singleSourceBoundedDijkstra(g, 'start');
  // direct route is 5. shortcut route is 1 + 1 + 1 friction = 3
  assert.equal(dist.get('direct'), 3);
});

test('boostFor returns expected inverse-cost boost curve', () => {
  assert.equal(boostFor(0), 20);
  assert.equal(boostFor(1), 10);
  assert.equal(boostFor(2), 6.67);
  assert.equal(boostFor(3), 5);
  assert.equal(boostFor(4), 4);
  assert.equal(boostFor(5), 3.33);
  assert.equal(boostFor(6), 2.86);
});

test('findClosestWordByNormalizedLCS matches 1-character typo with similarity >= 0.8 and initialCost 1', () => {
  const g = buildGraph({
    dragon: [{ target: 'wyvern', weight: 2, relation: 'sibling' }],
    castle: [],
  });
  const match = findClosestWordByNormalizedLCS('dragn', g);
  assert.ok(match);
  assert.equal(match.word, 'dragon');
  assert.equal(match.initialCost, 1);
  assert.ok(match.similarity >= 0.8);
});

test('findClosestWordByNormalizedLCS returns initialCost 2 for moderate typo (similarity 0.55 - 0.8)', () => {
  const g = buildGraph({
    nightfall: [],
  });
  // 'night' vs 'nightfall': LCS=5, length 5+9=14, score = 10/14 = 0.714
  const match = findClosestWordByNormalizedLCS('night', g);
  assert.ok(match);
  assert.equal(match.word, 'nightfall');
  assert.equal(match.initialCost, 2);
  assert.ok(match.similarity >= 0.55 && match.similarity < 0.8);
});

test('findClosestWordByNormalizedLCS returns null for distant words or words exceeding 63 chars', () => {
  const g = buildGraph({ dragon: [] });
  assert.equal(findClosestWordByNormalizedLCS('zzzzzzzz', g), null);
  assert.equal(findClosestWordByNormalizedLCS('', g), null);
  assert.equal(findClosestWordByNormalizedLCS('a'.repeat(64), g), null);
});
