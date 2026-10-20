const http = require('node:http');
const mongoose = require('mongoose');
const { LRUCache } = require('lru-cache');

const { NeighborIndex, neighborIndex } = require('./services/neighborIndex');
const { createSingleflight } = require('./services/singleflight');
const { createProgressiveSearch } = require('./services/progressiveSearch');
const { fetchSearchBatch } = require('./services/searchRanking');
const { memoryGraph, initMemoryGraph } = require('./services/memoryGraph');
const { generate10kNodes, generate10kWords, buildPopulatedGraph } = require('../scripts/datasetGenerator');
const { generate10kCatalog, createAtlasSearchSimulator } = require('./mockAtlasData');
const { wallpaperCardDTO } = require('./utils/wallpaperDTO');
const { publicVisibilityFilter } = require('./utils/visibilityFilter');
const Wallpaper = require('./models/Wallpaper');

async function setupSearchEngine({ mongoUri = process.env.MONGODB_URI } = {}) {
  let searchIndex;
  let fetchPool;
  let resolvePool;
  let fetchDocs;
  const isAtlasLive = Boolean(mongoUri);

  if (isAtlasLive) {
    // An explicitly configured database must initialize successfully before serving traffic.
    await mongoose.connect(mongoUri);
    await initMemoryGraph();
    searchIndex = neighborIndex.build(memoryGraph);
    // Atlas ranks once; each page rechecks current visibility while hydrating IDs.
    resolvePool = async ({ q, deviceType, limit }) => {
      const { terms } = searchIndex.expand(q);
      const rows = await fetchSearchBatch(Wallpaper, {
        q, deviceType, limit, expansion: { terms }, now: new Date(),
      });
      return rows.map((row) => ({ docId: String(row._id), score: row._searchScore }));
    };
    fetchDocs = async ({ ids, deviceType }) => {
      const rows = await Wallpaper.find({
        _id: { $in: ids },
        ...publicVisibilityFilter(),
        ...(deviceType ? { deviceType } : {}),
      }).populate('category', 'name slug').lean();
      return rows.map(wallpaperCardDTO);
    };
  } else {
    const words = generate10kWords();
    searchIndex = new NeighborIndex(20).build(buildPopulatedGraph(generate10kNodes(words)));
    const simulator = createAtlasSearchSimulator(generate10kCatalog(10000));
    fetchPool = async ({ terms, deviceType, limit, rawTokens = [] }) =>
      simulator({ terms, rawTokens, deviceType, limit });
  }

  const singleflight = createSingleflight();
  const sessions = new LRUCache({ max: 5000, ttl: 1000 * 60 * 15 });

  // Live mode ranks via Atlas and hydrates each page; mock mode slices its local pool.
  const progressiveSearch = createProgressiveSearch({
    index: searchIndex,
    ...(isAtlasLive ? { resolvePool, fetchDocs } : { fetchPool }),
    sessions,
    singleflight,
    batchSize: 20,
    poolSize: 200,
  });

  return {
    progressiveSearch,
    neighborIndex: searchIndex,
    isAtlasLive,
    sessions,
    singleflight,
  };
}

function createSearchHttpServer(engine) {
  const { progressiveSearch, isAtlasLive } = engine;

  const MAX_QUERY_LENGTH = 500;
  const MAX_TOKENS = 20;

  const server = http.createServer(async (req, res) => {
    let parsed;
    try { parsed = new URL(req.url, 'http://localhost'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request URL' }));
      return;
    }
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
      const page = Math.max(1, parseInt(parsed.searchParams.get('page'), 10) || 1);
      const limit = Math.min(48, Math.max(1, parseInt(parsed.searchParams.get('limit'), 10) || 20));
      const deviceType = parsed.searchParams.get('deviceType') || undefined;
      const sessionId = parsed.searchParams.get('sessionId') || undefined;

      // Query length limit (DoS prevention)
      if (q.length > MAX_QUERY_LENGTH) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: `Query too long (max ${MAX_QUERY_LENGTH} characters)` }));
        return;
      }

      // Token count limit
      const tokenCount = q.trim().split(/\s+/).filter(Boolean).length;
      if (tokenCount > MAX_TOKENS) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: `Too many tokens (max ${MAX_TOKENS})` }));
        return;
      }

      if (!q.trim() && !sessionId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Query parameter "q" or "sessionId" is required' }));
        return;
      }

      try {
        const result = await progressiveSearch.search({
          q,
          sessionId,
          ...(parsed.searchParams.has('page') ? { page } : {}),
          limit,
          deviceType,
        });

        // Calculate pagination metadata
        const totalResults = result.hasMore ? 'unknown' : result.total;
        const totalPages = totalResults === 'unknown' ? 'unknown' : Math.ceil(totalResults / limit);

        res.writeHead(200);
        res.end(JSON.stringify({
          data: result.data,
          sessionId: result.sessionId,
          hasMore: result.hasMore,
          meta: {
            page: result.page ?? page,
            limit,
            count: result.data.length,
            total: totalResults,
            totalPages,
          },
        }));
      } catch (err) {
        const status = [400, 410].includes(err.statusCode) ? err.statusCode : 500;
        if (status === 500) console.error('[Server] Search error:', err);
        res.writeHead(status);
        res.end(JSON.stringify({ error: status === 500 ? 'Internal server error' : err.message }));
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
