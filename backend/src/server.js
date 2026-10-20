const http = require('node:http');
const url = require('node:url');
const mongoose = require('mongoose');
const { LRUCache } = require('lru-cache');

const { NeighborIndex, neighborIndex } = require('./services/neighborIndex');
const { createSingleflight } = require('./services/singleflight');
const { createProgressiveSearch, searchKey } = require('./services/progressiveSearch');
const { normalizeToken } = require('./services/textNlp');
const { fetchSearchBatch, buildAtlasPipeline } = require('./services/searchRanking');
const { wordDocIds, initMemoryGraph } = require('./services/memoryGraph');
const { generate10kNodes, generate10kWords, buildPopulatedGraph } = require('../scripts/datasetGenerator');
const { generate10kCatalog, createAtlasSearchSimulator } = require('./mockAtlasData');
const { wallpaperCardDTO } = require('./utils/wallpaperDTO');

async function setupSearchEngine({ mongoUri = process.env.MONGODB_URI } = {}) {
  // 1. Build 10k word graph and precomputed NeighborIndex (TypedArray neighbor storage)
  const words = generate10kWords();
  const nodes = generate10kNodes(words);
  const graph = buildPopulatedGraph(nodes);
  const neighborIndex = new NeighborIndex(20).build(graph);

  let isAtlasLive = false;
  let resolvePool = null;
  let fetchDocs = null;
  let fetchPool = null; // legacy mock path

  if (mongoUri) {
    try {
      await mongoose.connect(mongoUri);
      isAtlasLive = true;
      const Wallpaper = mongoose.models.Wallpaper || mongoose.model('Wallpaper', new mongoose.Schema({}, { strict: false }));

      // Initialize memory graph from MongoDB (loads SemanticNode and populates wordDocIds)
      await initMemoryGraph();
      // Build neighbor index from the loaded graph (breaks circular dependency)
      neighborIndex.build(require('./services/memoryGraph').memoryGraph);

      /**
       * ID-first path: resolve ranked document IDs directly from the in-memory
       * inverted index — zero DB round trips for ranking.
       */
      resolvePool = async ({ q, deviceType, limit }) => {
        const { docIds } = neighborIndex.resolveDocIds(q, wordDocIds, limit);
        return docIds; // [{docId, score}]
      };

      /**
       * Hydrate a batch of IDs into full wallpaper documents via a single $in query.
       * Preserves only published, non-deleted docs with publishAt <= now; populates category.
       * Applies DTO projection to strip private fields.
       */
      fetchDocs = async ({ ids, deviceType }) => {
        if (!ids || !ids.length) return [];
        const now = new Date();
        const docs = await Wallpaper.find(
          {
            _id: { $in: ids },
            status: 'published',
            deletionPending: { $ne: true },
            $or: [{ publishAt: null }, { publishAt: { $lte: now } }],
            ...(deviceType ? { deviceType } : {}),
          },
        ).populate('category', 'name slug').lean();
        return docs.map(wallpaperCardDTO);
      };

      /**
       * Atlas Search fetchPool for live mode: uses Atlas Search pipeline for ranking
       * with full relevance features (fuzzy, autocomplete, semantic expansion).
       * Used by progressiveSearch in legacy mode for first-page relevance.
       */
      fetchPool = async ({ terms, deviceType, limit, rawTokens = [] }) => {
        // Reconstruct query from rawTokens for Atlas Search
        const q = rawTokens.join(' ');
        const expansion = { terms: terms || [] };
        const rows = await fetchSearchBatch(Wallpaper, { q, deviceType, limit, expansion, now: new Date() });
        return rows.map(wallpaperCardDTO);
      };
    } catch (err) {
      console.warn(`[Server] Could not connect to Atlas (${err.message}). Falling back to 10k mock catalog.`);
    }
  }

  if (!isAtlasLive) {
    // Legacy mock path: simulate Atlas search over in-memory 10k catalog.
    const catalog = generate10kCatalog(10000);
    const simulator = createAtlasSearchSimulator(catalog);
    fetchPool = async ({ terms, deviceType, limit, rawTokens = [] }) => {
      return simulator({ terms, rawTokens, deviceType, limit });
    };
  }

  const singleflight = createSingleflight();
  const sessions = new LRUCache({ max: 5000, ttl: 1000 * 60 * 15 });

  // Live mode: use Atlas Search via fetchPool for relevance; mock mode: use legacy fetchPool.
  const progressiveSearch = createProgressiveSearch({
    index: neighborIndex,
    ...(isAtlasLive ? { fetchPool } : { fetchPool }),
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

  const MAX_QUERY_LENGTH = 500;
  const MAX_TOKENS = 20;

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
          limit,
          deviceType,
        });

        // Calculate pagination metadata
        const totalResults = result.hasMore ? 'unknown' : result.data.length;
        const totalPages = totalResults === 'unknown' ? 'unknown' : Math.max(1, Math.ceil(totalResults / limit));

        res.writeHead(200);
        res.end(JSON.stringify({
          data: result.data,
          sessionId: result.sessionId,
          hasMore: result.hasMore,
          meta: {
            page,
            limit,
            count: result.data.length,
            total: totalResults,
            totalPages,
          },
        }));
      } catch (err) {
        console.error('[Server] Search error:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal server error' }));
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
