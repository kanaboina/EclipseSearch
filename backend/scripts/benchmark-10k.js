/**
 * Comprehensive 10k-Word Search Space Latency Benchmark Suite
 * Measures high-precision timing, averages, maximums, percentiles (P50, P95, P99),
 * and throughput across all core functions in EclipseSearchVersionTwo.
 */
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');

const {
  generate10kWords,
  generate10kNodes,
  buildPopulatedGraph,
} = require('./datasetGenerator');

const {
  singularize,
  normalizeToken,
  extractCleanWords,
} = require('../src/services/textNlp');

const {
  memoryGraph,
  addEdges,
  rebuildGraph,
  directedWeights,
} = require('../src/services/memoryGraph');

const {
  analyzeQuery,
  singleSourceBoundedDijkstra,
  findClosestWordByNormalizedLCS,
  expandQuerySemantically,
  boostFor,
} = require('../src/services/semanticDijkstra');

const {
  buildAtlasPipeline,
  buildTextFallbackQuery,
} = require('../src/services/searchRanking');

const {
  SearchBufferCache,
} = require('../src/services/searchBufferCache');

const {
  createSearchService,
} = require('../src/services/wallpaperService');

const {
  wallpaperCardDTO,
} = require('../src/utils/wallpaperDTO');

const {
  publicVisibilityFilter,
} = require('../src/utils/visibilityFilter');

const {
  sanitizeExpansions,
  findUnseenWords,
} = require('../src/services/aiGraphService');

/** High precision benchmark runner using process.hrtime.bigint() */
function measure(name, category, fn, { warmup = 10, iterations = 100 } = {}) {
  // Warmup phase to trigger JIT optimization
  for (let i = 0; i < warmup; i++) {
    fn();
  }

  // Measurement phase
  const latencies = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    fn();
    const end = process.hrtime.bigint();
    latencies[i] = Number(end - start) / 1e6; // Convert nanoseconds to milliseconds
  }

  // Statistical calculations
  latencies.sort();
  let sum = 0;
  for (let i = 0; i < iterations; i++) {
    sum += latencies[i];
  }
  const mean = sum / iterations;
  const min = latencies[0];
  const max = latencies[iterations - 1];
  const p50 = latencies[Math.floor(iterations * 0.50)];
  const p95 = latencies[Math.floor(iterations * 0.95)];
  const p99 = latencies[Math.min(iterations - 1, Math.floor(iterations * 0.99))];

  // Variance & Standard Deviation
  let varianceSum = 0;
  for (let i = 0; i < iterations; i++) {
    const diff = latencies[i] - mean;
    varianceSum += diff * diff;
  }
  const stddev = Math.sqrt(varianceSum / iterations);
  const throughput = mean > 0 ? Math.round(1000 / mean) : 0;

  return {
    name,
    category,
    iterations,
    mean: Number(mean.toFixed(4)),
    max: Number(max.toFixed(4)),
    min: Number(min.toFixed(4)),
    p50: Number(p50.toFixed(4)),
    p95: Number(p95.toFixed(4)),
    p99: Number(p99.toFixed(4)),
    stddev: Number(stddev.toFixed(4)),
    throughput,
  };
}

async function runBenchmark() {
  console.log('='.repeat(80));
  console.log('   ECLIPSE FANTASY SEARCH ENGINE: 10K-WORD SEARCH SPACE BENCHMARK');
  console.log('='.repeat(80));

  console.log('\n[Phase 1] Synthesizing 10,000-Word Semantic Search Space...');
  const t0 = performance.now();
  const words10k = generate10kWords();
  const nodes10k = generate10kNodes(words10k);
  const graph10k = buildPopulatedGraph(nodes10k);
  const setupTime = performance.now() - t0;

  let totalAdjacencyEntries = 0;
  for (const [, nbrs] of graph10k) totalAdjacencyEntries += nbrs.size;

  console.log(`✓ 10,000 vocabulary words generated`);
  console.log(`✓ ${nodes10k.length} nodes synthesized with ${nodes10k.reduce((acc, n) => acc + n.edges.length, 0)} raw edges`);
  console.log(`✓ In-memory semantic graph hydrated: ${graph10k.size} nodes, ${totalAdjacencyEntries} directed relations`);
  console.log(`✓ Setup completed in ${setupTime.toFixed(2)}ms\n`);

  const results = [];

  // ==========================================
  // Group 1: NLP & Text Normalization
  // ==========================================
  console.log('[Phase 2] Benchmarking NLP & Text Normalization Functions...');
  results.push(measure('singularize (regular plural - dragons)', 'NLP', () => {
    singularize('dragons');
  }, { iterations: 200 }));

  results.push(measure('singularize (irregular -ies - fairies)', 'NLP', () => {
    singularize('fairies');
  }, { iterations: 200 }));

  results.push(measure('singularize (irregular -ches - witches)', 'NLP', () => {
    singularize('witches');
  }, { iterations: 200 }));

  results.push(measure('singularize (non-singular -ss - abyss)', 'NLP', () => {
    singularize('abyss');
  }, { iterations: 200 }));

  results.push(measure('singularize (short/num - 4k)', 'NLP', () => {
    singularize('4k');
  }, { iterations: 200 }));

  results.push(measure('normalizeToken (clean token)', 'NLP', () => {
    normalizeToken('CyberpunkKnight');
  }, { iterations: 1000 }));

  results.push(measure('normalizeToken (noisy symbols/emoji)', 'NLP', () => {
    normalizeToken('  #Cyber_Knight-8K!! ⚔️  ');
  }, { iterations: 1000 }));

  const sampleWallpaperStandard = {
    title: 'Crimson Dragon Over Eldoria Castle',
    excerpt: 'An epic legendary wyrm descending upon an ancient burning fortress amidst thunderous clouds.',
    story: 'In the forgotten era of knights and sorcery, the grand citadel fell under the shadow of ancient wings.',
    tags: ['dragon', 'fantasy', 'castle', 'night', 'flame', '4k', 'knight', 'epic'],
  };

  results.push(measure('extractCleanWords (standard wallpaper doc)', 'NLP', () => {
    extractCleanWords(sampleWallpaperStandard);
  }, { iterations: 100 }));

  const sampleWallpaperDense = {
    title: 'Cyberpunk Neo Tokyo Rain - Ethereal Shinobi Horizon 8K Ultra HD',
    excerpt: 'A wandering cyborg samurai gazing across a sprawling neon metropolis bathed in holographic rain and shadows.',
    story: 'High above the dark alleyways where androids dream of electric spirits, the cyber warrior stands sentinel over futuristic skyscrapers, glowing billboards, and flying vehicles traversing the misty atmosphere.',
    tags: ['cyberpunk', 'neo-tokyo', 'samurai', 'neon', 'rain', 'cyborg', 'futuristic', 'dark', 'city', 'night', 'blade', 'hologram', 'anime'],
  };

  results.push(measure('extractCleanWords (dense wallpaper doc)', 'NLP', () => {
    extractCleanWords(sampleWallpaperDense);
  }, { iterations: 100 }));

  results.push(measure('analyzeQuery (1-word entity: dragon)', 'NLP', () => {
    analyzeQuery('dragon');
  }, { iterations: 100 }));

  results.push(measure('analyzeQuery (3-word query: dark dragon castle)', 'NLP', () => {
    analyzeQuery('dark dragon castle');
  }, { iterations: 100 }));

  results.push(measure('analyzeQuery (6-word noisy query with stopwords)', 'NLP', () => {
    analyzeQuery('the ancient dark dragon near a burning castle wallpaper 4k');
  }, { iterations: 100 }));

  // ==========================================
  // Group 2: Graph Construction & Mutation (10k Space)
  // ==========================================
  console.log('[Phase 3] Benchmarking Memory Graph Operations (10k Nodes)...');

  results.push(measure('rebuildGraph (hydrate all 10,000 nodes)', 'MemoryGraph', () => {
    const tempGraph = new Map();
    rebuildGraph(tempGraph, nodes10k);
  }, { warmup: 3, iterations: 25 }));

  const newClusterEdges = [
    { target: 'dragon', weight: 1, relation: 'synonym' },
    { target: 'castle', weight: 2, relation: 'hyponym' },
    { target: 'knight', weight: 3, relation: 'sibling' },
    { target: 'flame', weight: 4, relation: 'scene' },
    { target: 'darkness', weight: 5, relation: 'mood' },
  ];

  results.push(measure('addEdges (insert 5 edges into 10k graph)', 'MemoryGraph', () => {
    addEdges(graph10k, 'shadowwyrm', newClusterEdges);
  }, { iterations: 500 }));

  results.push(measure('directedWeights (hyponym forward/reverse)', 'MemoryGraph', () => {
    directedWeights('hyponym', 2);
  }, { iterations: 1000 }));

  results.push(measure('directedWeights (symmetric weight)', 'MemoryGraph', () => {
    directedWeights('synonym', 1);
  }, { iterations: 1000 }));

  // ==========================================
  // Group 3: Semantic Dijkstra & LCS Traversal (10k Space)
  // ==========================================
  console.log('[Phase 4] Benchmarking Dijkstra & LCS Traversal Across 10k Search Space...');

  results.push(measure('Dijkstra Dial (hub node degree ~40: dragon)', 'Dijkstra', () => {
    singleSourceBoundedDijkstra(graph10k, 'dragon');
  }, { iterations: 200 }));

  results.push(measure('Dijkstra Dial (mid node degree ~12: starblade)', 'Dijkstra', () => {
    singleSourceBoundedDijkstra(graph10k, 'starblade');
  }, { iterations: 500 }));

  results.push(measure('Dijkstra Dial (leaf node degree ~3: term9990)', 'Dijkstra', () => {
    singleSourceBoundedDijkstra(graph10k, 'term9990');
  }, { iterations: 500 }));

  results.push(measure('findClosestWordByNormalizedLCS (1-char typo: dragn)', 'LCS', () => {
    findClosestWordByNormalizedLCS('dragn', graph10k);
  }, { iterations: 50 }));

  results.push(measure('findClosestWordByNormalizedLCS (moderate typo: castlee)', 'LCS', () => {
    findClosestWordByNormalizedLCS('castlee', graph10k);
  }, { iterations: 50 }));

  results.push(measure('findClosestWordByNormalizedLCS (miss full 10k scan: zzzzzzzz)', 'LCS', () => {
    findClosestWordByNormalizedLCS('zzzzzzzz', graph10k);
  }, { iterations: 30 }));

  results.push(measure('expandQuerySemantically (1-word exact: dragon)', 'Expansion', () => {
    expandQuerySemantically('dragon', graph10k);
  }, { iterations: 50 }));

  results.push(measure('expandQuerySemantically (3-word multi-source: dragon knight castle)', 'Expansion', () => {
    expandQuerySemantically('dragon knight castle', graph10k);
  }, { iterations: 50 }));

  results.push(measure('expandQuerySemantically (typo + exact: dragn knight)', 'Expansion', () => {
    expandQuerySemantically('dragn knight', graph10k);
  }, { iterations: 30 }));

  results.push(measure('boostFor (cost-to-boost curve)', 'Ranking', () => {
    boostFor(3);
  }, { iterations: 1000 }));

  // ==========================================
  // Group 4: Search Ranking & Pipeline Assembly
  // ==========================================
  console.log('[Phase 5] Benchmarking Search Pipeline Assembly...');

  const precomputedExpansion = expandQuerySemantically('dragon knight castle', graph10k);

  results.push(measure('buildAtlasPipeline (with precomputed expansion)', 'Ranking', () => {
    buildAtlasPipeline({
      q: 'dragon knight castle',
      deviceType: 'desktop',
      limit: 50,
      excludeIds: ['660000000000000000000001', '660000000000000000000002'],
      expansion: precomputedExpansion,
    });
  }, { iterations: 500 }));

  results.push(measure('buildAtlasPipeline (end-to-end with inline 10k expansion)', 'Ranking', () => {
    buildAtlasPipeline({
      q: 'dragon knight castle',
      deviceType: 'desktop',
      limit: 50,
    });
  }, { iterations: 30 }));

  results.push(measure('buildTextFallbackQuery', 'Ranking', () => {
    buildTextFallbackQuery({
      q: 'dragon knight castle',
      deviceType: 'phone',
      excludeIds: ['660000000000000000000001'],
    });
  }, { iterations: 1000 }));

  results.push(measure('publicVisibilityFilter', 'Utils', () => {
    publicVisibilityFilter();
  }, { iterations: 1000 }));

  // ==========================================
  // Group 5: Caching & Service Layer
  // ==========================================
  console.log('[Phase 6] Benchmarking Buffer Cache & Search Service...');

  const testCache = new SearchBufferCache({ max: 200, ttlMs: 300000 });
  const sampleItems = Array.from({ length: 50 }, (_, i) => ({
    _id: `6600000000000000000000${String(i).padStart(2, '0')}`,
    title: `Wallpaper ${i}`,
    views: 100 + i,
  }));

  results.push(measure('SearchBufferCache.set', 'Cache', () => {
    testCache.set('query:desktop', { items: sampleItems, seenIds: new Set(), hasMore: true });
  }, { iterations: 1000 }));

  results.push(measure('SearchBufferCache.get (hit)', 'Cache', () => {
    testCache.get('query:desktop');
  }, { iterations: 1000 }));

  results.push(measure('SearchBufferCache.get (miss)', 'Cache', () => {
    testCache.get('nonexistent:query');
  }, { iterations: 1000 }));

  let evictCount = 0;
  results.push(measure('SearchBufferCache.set under eviction pressure (>200 keys)', 'Cache', () => {
    testCache.set(`key_${evictCount++}`, { items: [] });
  }, { iterations: 500 }));

  // ==========================================
  // Group 6: Wallpaper DTO & Service Simulation
  // ==========================================
  console.log('[Phase 7] Benchmarking DTO Mapping & Service Pagination...');

  const rawWallpaperDoc = {
    _id: '660000000000000000000001',
    title: 'Crimson Dragon Fortress',
    slug: 'crimson-dragon-fortress',
    excerpt: 'Epic dragon artwork',
    previewUrl: 'https://cdn.example.com/preview.webp',
    thumbnailUrl: 'https://cdn.example.com/thumb.webp',
    modalUrl: 'https://cdn.example.com/modal.webp',
    heroUrl: 'https://cdn.example.com/hero.webp',
    mobileCardUrl: 'https://cdn.example.com/mobile.webp',
    category: { _id: '660000000000000000000099', name: 'Fantasy', slug: 'fantasy' },
    style: 'cinematic',
    tags: ['dragon', 'dark', 'castle'],
    colors: ['#ff0000', '#000000'],
    deviceType: 'desktop',
    featured: true,
    premium: false,
    views: 1542,
    width: 3840,
    height: 2160,
    createdAt: new Date(),
    story: 'Hidden internal story that must be stripped',
    downloadKeys: ['secret-key-1'],
    downloadBucket: 'private-r2',
  };

  results.push(measure('wallpaperCardDTO (single card)', 'DTO', () => {
    wallpaperCardDTO(rawWallpaperDoc);
  }, { iterations: 1000 }));

  const batchRawDocs = Array.from({ length: 50 }, (_, i) => ({
    ...rawWallpaperDoc,
    _id: `6600000000000000000000${String(i).padStart(2, '0')}`,
    title: `Card ${i}`,
  }));

  results.push(measure('wallpaperCardDTO (batch 50 cards mapping)', 'DTO', () => {
    for (let i = 0; i < 50; i++) {
      wallpaperCardDTO(batchRawDocs[i]);
    }
  }, { iterations: 200 }));

  // End-to-end Search Service simulation
  const mockDbFetch = async ({ limit = 50, excludeIds = [] }) => {
    const start = excludeIds.length;
    return Array.from({ length: limit }, (_, i) => ({
      ...rawWallpaperDoc,
      _id: `660000000000000000000${String(start + i).padStart(3, '0')}`,
      title: `Wallpaper Item ${start + i}`,
    }));
  };

  const service = createSearchService({
    fetchBatch: mockDbFetch,
    cache: new SearchBufferCache(),
    batchSize: 50,
  });

  // Cold search (triggers DB fetch + cache set)
  let coldQueryIndex = 0;
  results.push(measure('searchService.search (cold query - cache miss)', 'Service', () => {
    service.search({ q: `query_${coldQueryIndex++}`, page: 1, limit: 20 });
  }, { iterations: 100 }));

  // Warm search (cache hit)
  service.search({ q: 'warm_query', page: 1, limit: 20 });
  results.push(measure('searchService.search (warm query - cache hit)', 'Service', () => {
    service.search({ q: 'warm_query', page: 1, limit: 20 });
  }, { iterations: 500 }));

  // Page 2 buffered search
  results.push(measure('searchService.search (page 2 - buffered slice)', 'Service', () => {
    service.search({ q: 'warm_query', page: 2, limit: 20 });
  }, { iterations: 500 }));

  // ==========================================
  // Group 7: AI Ingestion Utilities
  // ==========================================
  console.log('[Phase 8] Benchmarking Ingestion & Sanitation Utilities...');

  const sampleLlmPayload = {
    expansions: {
      dragon: Array.from({ length: 25 }, (_, i) => ({
        target: `beast_${i}`,
        weight: (i % 6) + 1,
        relation: 'synonym',
      })),
      knight: Array.from({ length: 25 }, (_, i) => ({
        target: `warrior_${i}`,
        weight: (i % 6) + 1,
        relation: 'hyponym',
      })),
      castle: Array.from({ length: 25 }, (_, i) => ({
        target: `fortress_${i}`,
        weight: (i % 6) + 1,
        relation: 'hypernym',
      })),
    },
  };

  results.push(measure('sanitizeExpansions (3 words x 25 raw edges)', 'Ingestion', () => {
    sanitizeExpansions(sampleLlmPayload, ['dragon', 'knight', 'castle']);
  }, { iterations: 500 }));

  const sampleWordsFilter = Array.from({ length: 50 }, (_, i) =>
    i % 2 === 0 ? words10k[i] : `brand_new_unseen_${i}`
  );

  const mockModel = {
    find: ({ word: { $in: queryWords } }) => ({
      select: () => ({
        lean: async () => queryWords.filter((w) => words10k.includes(w)).map((w) => ({ word: w })),
      }),
    }),
  };

  results.push(measure('findUnseenWords (filter 50 words vs 10k database)', 'Ingestion', () => {
    findUnseenWords(sampleWordsFilter, mockModel);
  }, { iterations: 200 }));

  // ==========================================
  // Output Formatting & Tabular Report
  // ==========================================
  console.log('\n' + '='.repeat(110));
  console.log('                            10,000 WORDS SEARCH SPACE: METRICS BENCHMARK REPORT');
  console.log('='.repeat(110));

  const formatRow = (cols, widths) =>
    cols.map((c, i) => String(c).padEnd(widths[i])).join(' | ');

  const headers = ['Function / Process', 'Category', 'N', 'Mean (ms)', 'Max (ms)', 'Min (ms)', 'P50 (ms)', 'P95 (ms)', 'P99 (ms)', 'Throughput'];
  const widths = [48, 12, 5, 10, 10, 10, 10, 10, 10, 11];

  console.log(formatRow(headers, widths));
  console.log('-'.repeat(110));

  let currentCat = '';
  for (const r of results) {
    if (r.category !== currentCat) {
      currentCat = r.category;
      console.log(`-- [${currentCat}] ${'-'.repeat(102 - currentCat.length)}`);
    }
    const cols = [
      r.name,
      r.category,
      r.iterations,
      r.mean.toFixed(3),
      r.max.toFixed(3),
      r.min.toFixed(3),
      r.p50.toFixed(3),
      r.p95.toFixed(3),
      r.p99.toFixed(3),
      `${r.throughput.toLocaleString()} op/s`,
    ];
    console.log(formatRow(cols, widths));
  }
  console.log('='.repeat(110));

  // Save JSON report for programmatic analysis
  const outputPath = path.join(__dirname, '..', 'test-metrics-10k.json');
  const reportPayload = {
    timestamp: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      searchSpaceSize: words10k.length,
      graphNodes: graph10k.size,
      graphAdjacencyEntries: totalAdjacencyEntries,
    },
    metrics: results,
  };
  fs.writeFileSync(outputPath, JSON.stringify(reportPayload, null, 2));
  console.log(`\n✓ Full JSON Metrics Report saved to: ${outputPath}`);

  return reportPayload;
}

if (require.main === module) {
  runBenchmark().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}

module.exports = { runBenchmark, measure };
