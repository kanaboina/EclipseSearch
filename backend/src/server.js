const http = require('node:http');
const url = require('node:url');
const mongoose = require('mongoose');
const { LRUCache } = require('lru-cache');

const { NeighborIndex } = require('./services/neighborIndex');
const { createSingleflight } = require('./services/singleflight');
const { createProgressiveSearch, searchKey } = require('./services/progressiveSearch');
const { normalizeToken } = require('./services/textNlp');
const { fetchSearchBatch, buildAtlasPipeline } = require('./services/searchRanking');
const { generate10kNodes, generate10kWords, buildPopulatedGraph } = require('../scripts/datasetGenerator');
const { generate10kCatalog, createAtlasSearchSimulator } = require('./mockAtlasData');

async function setupSearchEngine({ mongoUri = process.env.MONGODB_URI } = {}) {
  // 1. Build 10k word graph and precomputed NeighborIndex (TypedArray neighbor storage)
  const words = generate10kWords();
  const nodes = generate10kNodes(words);
  const graph = buildPopulatedGraph(nodes);
  const neighborIndex = new NeighborIndex(15).build(graph);

  let isAtlasLive = false;
  let fetchPool = null;

  if (mongoUri) {
    try {
      await mongoose.connect(mongoUri);
      isAtlasLive = true;
      const Wallpaper = mongoose.models.Wallpaper || mongoose.model('Wallpaper', new mongoose.Schema({}, { strict: false }));
      fetchPool = async ({ terms, deviceType, limit }) => {
        // Run aggregation or batch search
        const expansion = { terms };
        const pipeline = buildAtlasPipeline({ q: terms.map((t) => t.term).join(' '), deviceType, limit, expansion });
        return Wallpaper.aggregate(pipeline);
      };
    } catch (err) {
      console.warn(`[Server] Could not connect to Atlas (${err.message}). Falling back to 10k mock catalog.`);
    }
  }

  if (!isAtlasLive) {
    const catalog = generate10kCatalog(10000);
    const simulator = createAtlasSearchSimulator(catalog);
    fetchPool = async ({ terms, deviceType, limit, rawTokens = [] }) => {
      return simulator({ terms, rawTokens, deviceType, limit });
    };
  }

  const singleflight = createSingleflight();
  const sessions = new LRUCache({ max: 50000, ttl: 1000 * 60 * 15 });

  const progressiveSearch = createProgressiveSearch({
    index: neighborIndex,
    fetchPool,
    sessions,
    singleflight,
    batchSize: 20,
    poolSize: 200,
  });

  return {
    progressiveSearch,
    neighborIndex,
    isAtlasLive,
    sessions,
    singleflight,
  };
}

function createSearchHttpServer(engine) {
  const { progressiveSearch, isAtlasLive } = engine;

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, 'http://localhost');
    const pathname = parsed.pathname;

    // Set JSON headers
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Atlas-Mode', isAtlasLive ? 'live' : 'mock-10k');

    if (pathname === '/health' || pathname === '/api/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', atlasLive: isAtlasLive, uptime: process.uptime() }));
      return;
    }

    if (pathname === '/api/search' && req.method === 'GET') {
      const q = parsed.searchParams.get('q') || '';
      const page = parseInt(parsed.searchParams.get('page'), 10) || 1;
      const limit = Math.min(48, Math.max(1, parseInt(parsed.searchParams.get('limit'), 10) || 20));
      const deviceType = parsed.searchParams.get('deviceType') || undefined;
      const sessionId = parsed.searchParams.get('sessionId') || undefined;

      if (!q.trim() && !sessionId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Query parameter "q" or "sessionId" is required' }));
        return;
      }

      try {
        const result = await progressiveSearch.search({
          q,
          sessionId,
          limit,
          deviceType,
        });

        res.writeHead(200);
        res.end(JSON.stringify({
          data: result.data,
          sessionId: result.sessionId,
          hasMore: result.hasMore,
          meta: {
            page,
            limit,
            count: result.data.length,
          },
        }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return server;
}

module.exports = {
  setupSearchEngine,
  createSearchHttpServer,
};
