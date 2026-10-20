const mongoose = require('mongoose');
const autocannon = require('autocannon');
const fs = require('node:fs');
const path = require('node:path');
const { setupSearchEngine, createSearchHttpServer } = require('../src/server');

const TEST_PORT = parseInt(process.env.TEST_PORT, 10) || 5055;
const BASE_URL = process.env.TARGET_URL || `http://127.0.0.1:${TEST_PORT}`;

// Realistic query mix
const HOT_QUERIES = [
  'cyberpunk neon',
  'dark fantasy dragon',
  'anime warrior girl',
  'minimalist landscape',
  'space nebula galaxy',
  'samurai sunset',
  'mystic forest light',
  'steampunk city',
];

const LONG_TAIL_QUERIES = [
  'phoenix fire blade',
  'valkyrie celestial armor',
  'shadow assassin moon',
  'abyss underwater crystal',
  'tundra frozen glacier',
  'vortex storm lightning',
  'shrine cherry blossom',
  'golem ancient ruins',
];

const TYPO_QUERIES = [
  'cybrpunk non',
  'dragn castel',
  'anme warir',
  'sakura blosom',
];

function buildRealisticRequests(sessionIds = []) {
  const requests = [];

  // 1. Hot trending queries (60%)
  for (const q of HOT_QUERIES) {
    requests.push({
      method: 'GET',
      path: `/api/search?q=${encodeURIComponent(q)}&limit=20`,
    });
    // With deviceType
    requests.push({
      method: 'GET',
      path: `/api/search?q=${encodeURIComponent(q)}&deviceType=phone&limit=20`,
    });
  }

  // 2. Long-tail queries (25%)
  for (const q of LONG_TAIL_QUERIES) {
    requests.push({
      method: 'GET',
      path: `/api/search?q=${encodeURIComponent(q)}&limit=20`,
    });
  }

  // 3. Typo queries testing bitmask + LCS fallback (5%)
  for (const q of TYPO_QUERIES) {
    requests.push({
      method: 'GET',
      path: `/api/search?q=${encodeURIComponent(q)}&limit=20`,
    });
  }

  // 4. Multi-page pagination using sessions (10%)
  for (const sid of sessionIds) {
    requests.push({
      method: 'GET',
      path: `/api/search?sessionId=${sid}&page=2&limit=20`,
    });
    requests.push({
      method: 'GET',
      path: `/api/search?sessionId=${sid}&page=3&limit=20`,
    });
  }

  // Weight request templates explicitly instead of assuming their counts give
  // the documented traffic mix.
  const hot = requests.slice(0, HOT_QUERIES.length * 2);
  const tail = requests.slice(hot.length, hot.length + LONG_TAIL_QUERIES.length);
  const typo = requests.slice(hot.length + tail.length, hot.length + tail.length + TYPO_QUERIES.length);
  const pages = requests.slice(hot.length + tail.length + typo.length);
  const repeat = (group, count) => group.length ? Array.from({ length: count }, (_, i) => group[i % group.length]) : [];
  return [...repeat(hot, 60), ...repeat(tail, 25), ...repeat(typo, 5), ...repeat(pages, 10)];
}

async function primeInitialSessions(baseUrl) {
  const sessionIds = [];
  try {
    for (const q of HOT_QUERIES.slice(0, 4)) {
      const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(q)}&limit=20`);
      if (res.ok) {
        const json = await res.json();
        if (json.sessionId) sessionIds.push(json.sessionId);
      }
    }
  } catch (err) {
    console.warn('[LoadTest] Session warmup notice:', err.message);
  }
  return sessionIds;
}

async function runBenchmarkScenario({
  name,
  connections,
  duration,
  pipelining = 1,
  requests,
}) {
  console.log(`\n========================================================================`);
  console.log(`  RUNNING: ${name}`);
  console.log(`  Connections: ${connections} | Duration: ${duration}s | Pipelining: ${pipelining}`);
  console.log(`========================================================================`);

  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url: BASE_URL,
        connections,
        duration,
        pipelining,
        requests,
        headers: {
          'accept': 'application/json',
          'user-agent': 'autocannon-eclipse-loadtest',
        },
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );

    autocannon.track(instance, { renderProgressBar: false, renderLatencyTable: true });
  });
}

function formatResultSummary(scenarioName, res) {
  const lat = res.latency;
  const req = res.requests;
  const throughput = res.throughput;
  const p95 = typeof lat.p95 === 'number' ? lat.p95 : null;

  return {
    scenario: scenarioName,
    durationSeconds: res.duration,
    connections: res.connections,
    pipelining: res.pipelining,
    requestsTotal: req.total,
    requestsPerSec: req.average,
    throughputMBPerSec: Number((throughput.average / (1024 * 1024)).toFixed(2)),
    latency: {
      averageMs: Number(lat.average.toFixed(2)),
      p50Ms: Number(lat.p50.toFixed(2)),
      p90Ms: Number(lat.p90.toFixed(2)),
      p95Ms: p95,
      p97_5Ms: Number(lat.p97_5.toFixed(2)),
      p99Ms: Number(lat.p99.toFixed(2)),
      p99_9Ms: Number(lat.p99_9.toFixed(2)),
      maxMs: Number(lat.max.toFixed(2)),
      minMs: Number(lat.min.toFixed(2)),
      stddevMs: Number(lat.stddev.toFixed(2)),
    },
    statusCodes: {
      '2xx': res['2xx'],
      non2xx: res.non2xx,
      errors: res.errors,
      timeouts: res.timeouts,
    },
  };
}

async function main() {
  let serverInstance = null;
  let isInternalServer = false;
  let atlasLive;

  // Check if target server is already running
  try {
    const probe = await fetch(`${BASE_URL}/health`);
    if (!probe.ok) throw new Error(`Health check returned HTTP ${probe.status}`);
    if (probe.ok) {
      const info = await probe.json();
      atlasLive = info.atlasLive;
      console.log(`[LoadTest] Connected to existing server at ${BASE_URL} (Atlas Live: ${info.atlasLive})`);
    }
  } catch (error) {
    if (process.env.TARGET_URL) throw new Error(`Target health check failed: ${error.message}`);
    // Start local search server
    console.log(`[LoadTest] Spawning test HTTP server on port ${TEST_PORT}...`);
    const engine = await setupSearchEngine();
    serverInstance = createSearchHttpServer(engine);
    await new Promise((resolve, reject) => {
      serverInstance.once('error', reject);
      serverInstance.listen(TEST_PORT, '127.0.0.1', resolve);
    });
    atlasLive = engine.isAtlasLive;
    isInternalServer = true;
    console.log(`[LoadTest] Internal HTTP server ready at ${BASE_URL}`);
  }

  try {
    // Warmup session pool for multi-page pagination tests
    console.log('[LoadTest] Priming search sessions...');
    const sessionIds = await primeInitialSessions(BASE_URL);
    const requests = buildRealisticRequests(sessionIds);
    console.log(`[LoadTest] Prepared ${requests.length} realistic HTTP search request templates.`);

    // Warmup run: 3s
    console.log('[LoadTest] Executing 3s JIT warmup...');
    await runBenchmarkScenario({
      name: 'Warmup Phase',
      connections: 10,
      duration: 3,
      pipelining: 1,
      requests,
    });

    const reportSummaries = [];

    // Scenario 1: Realistic Steady-State Traffic (15 concurrent users, 10s)
    const res1 = await runBenchmarkScenario({
      name: 'Scenario 1: Realistic Steady-State Search Traffic (15 Concurrent Clients)',
      connections: 15,
      duration: 10,
      pipelining: 1,
      requests,
    });
    const s1 = formatResultSummary('Scenario 1: Steady-State (15 CCU)', res1);
    reportSummaries.push(s1);

    // Scenario 2: Peak Search Traffic (50 Concurrent Clients, 10s)
    const res2 = await runBenchmarkScenario({
      name: 'Scenario 2: Peak High-Load Traffic (50 Concurrent Clients)',
      connections: 50,
      duration: 10,
      pipelining: 1,
      requests,
    });
    const s2 = formatResultSummary('Scenario 2: Peak Load (50 CCU)', res2);
    reportSummaries.push(s2);

    // Scenario 3: Extreme Arrival Surge (100 Concurrent Clients, 10s)
    const res3 = await runBenchmarkScenario({
      name: 'Scenario 3: Stress Surge Traffic (100 Concurrent Clients)',
      connections: 100,
      duration: 10,
      pipelining: 1,
      requests,
    });
    const s3 = formatResultSummary('Scenario 3: Stress Surge (100 CCU)', res3);
    reportSummaries.push(s3);

    // Write results to JSON
    const outputPath = path.resolve(__dirname, '../http-load-test-results.json');
    const fullReport = {
      timestamp: new Date().toISOString(),
      targetUrl: BASE_URL,
      atlasLive,
      catalogSize: atlasLive === false ? 10000 : null,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      scenarios: reportSummaries,
    };
    fs.writeFileSync(outputPath, JSON.stringify(fullReport, null, 2));
    console.log(`\n[LoadTest] Benchmark completed! Full metrics written to ${outputPath}\n`);

    // Print summary table to console
    console.log('========================================================================================================');
    console.log('                                HTTP LOAD TEST SUMMARY & PERCENTILES                                     ');
    console.log('========================================================================================================');
    console.log(
      ['Scenario'.padEnd(32), 'Req/s'.padStart(9), 'Avg'.padStart(9), 'P50'.padStart(9), 'P97.5'.padStart(9), 'P99'.padStart(9), 'Max'.padStart(9), 'Errors'.padStart(8)].join(' | ')
    );
    console.log('--------------------------------------------------------------------------------------------------------');
    for (const s of reportSummaries) {
      console.log(
        [
          s.scenario.padEnd(32),
          Math.round(s.requestsPerSec).toString().padStart(9),
          `${s.latency.averageMs}ms`.padStart(9),
          `${s.latency.p50Ms}ms`.padStart(9),
          `${s.latency.p97_5Ms}ms`.padStart(9),
          `${s.latency.p99Ms}ms`.padStart(9),
          `${s.latency.maxMs}ms`.padStart(9),
          s.statusCodes.errors.toString().padStart(8),
        ].join(' | ')
      );
    }
    console.log('========================================================================================================\n');
  } finally {
    if (serverInstance && isInternalServer) {
      await new Promise((resolve, reject) => serverInstance.close((error) => error ? reject(error) : resolve()));
      if (atlasLive) await mongoose.disconnect();
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[LoadTest] Benchmark failed:', err);
    process.exit(1);
  });
}

module.exports = { main, buildRealisticRequests, formatResultSummary };
