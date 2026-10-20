const { NeighborIndex } = require('../src/services/neighborIndex');
const { createSingleflight } = require('../src/services/singleflight');
const { createProgressiveSearch } = require('../src/services/progressiveSearch');
const { addEdges } = require('../src/services/memoryGraph');
const { LRUCache } = require('lru-cache');
const fs = require('fs');
const path = require('path');

const WORD_COUNT = 10000;
const words = Array.from({ length: WORD_COUNT }, (_, i) => `w${i.toString(36)}x${i}`);

function buildBigGraph() {
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

const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ _id: `row_${i}`, score: 1000 - i }));

async function runLadder() {
  console.log('========================================================================');
  console.log('  CONCURRENCY LADDER BENCHMARK: 1k -> 20k Concurrent Searches (20 Tests)');
  console.log('========================================================================\n');

  console.log('1. Constructing 10k Graph and Building NeighborIndex...');
  const tGraph0 = process.hrtime.bigint();
  const graph = buildBigGraph();
  const idx = new NeighborIndex(15).build(graph);
  const tGraph1 = process.hrtime.bigint();
  console.log(`   Graph + Index built in ${(Number(tGraph1 - tGraph0) / 1e6).toFixed(2)} ms.\n`);

  // Query pool: Mix of hot repeated queries (60%) and diverse unique queries (40%)
  const hotQueries = [words[10], words[42], words[100], words[256], words[999]];

  const reports = [];

  for (let step = 1; step <= 20; step++) {
    const concurrency = step * 1000;

    // Reset progressive search per test with sufficient session capacity
    const sf = createSingleflight();
    const sessions = new LRUCache({ max: concurrency * 2, ttl: 1000 * 60 * 15 });
    const ps = createProgressiveSearch({
      index: idx,
      sessions,
      singleflight: sf,
      fetchPool: async () => makeRows(100),
    });

    // Prepare search requests
    const queries = [];
    for (let i = 0; i < concurrency; i++) {
      if (i % 5 < 3) {
        queries.push(hotQueries[i % hotQueries.length]);
      } else {
        queries.push(words[(i * 17) % WORD_COUNT]);
      }
    }

    if (global.gc) global.gc();
    const memStart = process.memoryUsage().heapUsed;

    const latencies = new Float64Array(concurrency);
    const tBatchStart = process.hrtime.bigint();

    await Promise.all(
      queries.map(async (q, idx) => {
        const tReqStart = process.hrtime.bigint();
        await ps.search({ q });
        const tReqEnd = process.hrtime.bigint();
        latencies[idx] = Number(tReqEnd - tReqStart) / 1e6;
      })
    );

    const tBatchEnd = process.hrtime.bigint();
    const totalMs = Number(tBatchEnd - tBatchStart) / 1e6;
    const throughput = (concurrency / (totalMs / 1000));
    const memEnd = process.memoryUsage().heapUsed;
    const memUsedMB = memEnd / (1024 * 1024);

    // Calculate latency metrics
    latencies.sort();
    const sum = latencies.reduce((acc, v) => acc + v, 0);
    const mean = sum / concurrency;
    const p50 = latencies[Math.floor(concurrency * 0.50)];
    const p90 = latencies[Math.floor(concurrency * 0.90)];
    const p95 = latencies[Math.floor(concurrency * 0.95)];
    const p99 = latencies[Math.floor(concurrency * 0.99)];
    const max = latencies[concurrency - 1];

    const report = {
      test: `Test ${step}`,
      concurrency,
      durationMs: Number(totalMs.toFixed(2)),
      throughputQPS: Math.round(throughput),
      meanLatencyMs: Number(mean.toFixed(3)),
      p50LatencyMs: Number(p50.toFixed(3)),
      p90LatencyMs: Number(p90.toFixed(3)),
      p95LatencyMs: Number(p95.toFixed(3)),
      p99LatencyMs: Number(p99.toFixed(3)),
      maxLatencyMs: Number(max.toFixed(3)),
      heapUsedMB: Number(memUsedMB.toFixed(2)),
    };

    reports.push(report);

    console.log(
      `[Test ${String(step).padStart(2, ' ')} / 20] Concurrency: ${String(concurrency).padStart(5, ' ')} | ` +
      `Time: ${String(totalMs.toFixed(1)).padStart(7, ' ')}ms | ` +
      `Throughput: ${String(Math.round(throughput)).padStart(6, ' ')} QPS | ` +
      `p50: ${p50.toFixed(2)}ms | p95: ${p95.toFixed(2)}ms | p99: ${p99.toFixed(2)}ms | Max: ${max.toFixed(2)}ms`
    );
  }

  const outPath = path.join(__dirname, '../concurrency-ladder-results.json');
  fs.writeFileSync(outPath, JSON.stringify(reports, null, 2));
  console.log(`\nAll 20 tests completed successfully! Results written to ${outPath}`);
}

if (require.main === module) {
  runLadder().catch((err) => { console.error(err); process.exitCode = 1; });
}

module.exports = { runLadder };
