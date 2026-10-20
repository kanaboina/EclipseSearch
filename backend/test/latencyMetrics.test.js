const test = require('node:test');
const assert = require('node:assert/strict');

const { generate10kWords, generate10kNodes, buildPopulatedGraph } = require('../scripts/datasetGenerator');
const { singleSourceBoundedDijkstra, findClosestWordByNormalizedLCS, expandQuerySemantically } = require('../src/services/semanticDijkstra');
const { rebuildGraph } = require('../src/services/memoryGraph');
const { SearchBufferCache } = require('../src/services/searchBufferCache');
const { wallpaperCardDTO } = require('../src/utils/wallpaperDTO');
const { analyzeQuery } = require('../src/services/semanticDijkstra');

// Initialize shared 10k search space
const words10k = generate10kWords();
const nodes10k = generate10kNodes(words10k);
const graph10k = buildPopulatedGraph(nodes10k);

function timeFunction(fn, iterations = 20) {
  // 3 warmups
  for (let i = 0; i < 3; i++) fn();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const max = Math.max(...times);
  return { avg, max };
}

test('Performance SLA: 10,000-word graph hydration completes within 50ms', () => {
  const { avg, max } = timeFunction(() => {
    const tempGraph = new Map();
    rebuildGraph(tempGraph, nodes10k);
  }, 5);

  assert.ok(avg < 50, `Expected avg < 50ms, received ${avg.toFixed(2)}ms`);
  assert.ok(max < 100, `Expected max < 100ms, received ${max.toFixed(2)}ms`);
});

test('Performance SLA: Dijkstra on 10k-node hub node completes with average < 2ms', () => {
  const { avg, max } = timeFunction(() => {
    singleSourceBoundedDijkstra(graph10k, 'dragon');
  }, 30);

  assert.ok(avg < 2.0, `Expected avg < 2ms, received ${avg.toFixed(3)}ms`);
  assert.ok(max < 10.0, `Expected max < 10ms, received ${max.toFixed(3)}ms`);
});

test('Performance SLA: Dijkstra on 10k-node mid-degree node completes with average < 0.2ms', () => {
  const { avg, max } = timeFunction(() => {
    singleSourceBoundedDijkstra(graph10k, 'starblade');
  }, 50);

  assert.ok(avg < 0.2, `Expected avg < 0.2ms, received ${avg.toFixed(3)}ms`);
  assert.ok(max < 2.0, `Expected max < 2ms, received ${max.toFixed(3)}ms`);
});

test('Performance SLA: 10k-word LCS branch-and-bound typo search completes with average < 2ms', () => {
  const { avg, max } = timeFunction(() => {
    findClosestWordByNormalizedLCS('dragn', graph10k);
  }, 20);

  assert.ok(avg < 2.0, `Expected avg < 2ms, received ${avg.toFixed(3)}ms`);
  assert.ok(max < 5.0, `Expected max < 5ms, received ${max.toFixed(3)}ms`);
});

test('Performance SLA: Worst-case 10k-word LCS miss scan completes with average < 10ms', () => {
  const { avg, max } = timeFunction(() => {
    findClosestWordByNormalizedLCS('zzzzzzzz', graph10k);
  }, 10);

  assert.ok(avg < 10.0, `Expected avg < 10ms, received ${avg.toFixed(3)}ms`);
  assert.ok(max < 20.0, `Expected max < 20ms, received ${max.toFixed(3)}ms`);
});

test('Performance SLA: Semantic query expansion on 10k graph completes with average < 10ms', () => {
  const { avg, max } = timeFunction(() => {
    expandQuerySemantically('dark dragon castle', graph10k);
  }, 15);

  assert.ok(avg < 10.0, `Expected avg < 10ms, received ${avg.toFixed(3)}ms`);
  assert.ok(max < 25.0, `Expected max < 25ms, received ${max.toFixed(3)}ms`);
});

test('Performance SLA: SearchBufferCache get/set completes sub-millisecond (< 0.05ms)', () => {
  const cache = new SearchBufferCache();
  const { avg: setAvg, max: setMax } = timeFunction(() => {
    cache.set('test_key', { items: [1, 2, 3] });
  }, 100);
  const { avg: getAvg, max: getMax } = timeFunction(() => {
    cache.get('test_key');
  }, 100);

  assert.ok(setAvg < 0.05, `Expected cache set avg < 0.05ms, received ${setAvg.toFixed(4)}ms`);
  assert.ok(getAvg < 0.05, `Expected cache get avg < 0.05ms, received ${getAvg.toFixed(4)}ms`);
});

test('Performance SLA: wallpaperCardDTO batch transformation of 50 cards completes < 0.2ms', () => {
  const sampleCard = {
    _id: '660000000000000000000001',
    title: 'Dragon Fortress',
    slug: 'dragon-fortress',
    category: { _id: '660000000000000000000099', name: 'Fantasy', slug: 'fantasy' },
    previewUrl: 'https://example.com/preview.webp',
    tags: ['dragon', 'castle'],
  };
  const batch = Array.from({ length: 50 }, () => ({ ...sampleCard }));

  const { avg, max } = timeFunction(() => {
    for (let i = 0; i < 50; i++) wallpaperCardDTO(batch[i]);
  }, 50);

  assert.ok(avg < 0.2, `Expected DTO batch avg < 0.2ms, received ${avg.toFixed(4)}ms`);
  assert.ok(max < 1.0, `Expected DTO batch max < 1.0ms, received ${max.toFixed(4)}ms`);
});
