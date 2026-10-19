const { randomUUID } = require('node:crypto');
const { LRUCache } = require('lru-cache');
const { createSingleflight } = require('./singleflight');

const BATCH_SIZE = 20;
const POOL_SIZE = 200;
const MIN_BOOST = 2; // relevance cutoff on term boost: below this, stop paginating

/** Sorted-token key, mirrors the edge normalization so equal searches coalesce. */
const searchKey = (q) => String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');

/**
 * Batched progressive pagination.
 *  - Batch 1: expand query via precomputed neighbors, fetch a ranked pool once, return top 20.
 *  - Next batches: slice the same in-memory ranked pool (no further DB hits).
 *  - Sessions live in an lru-cache holding a Set of seenIds (O(1) duplicate checks, 15 min TTL).
 *
 * fetchPool({ terms, deviceType, limit }) -> ranked rows ({_id, score?, ...}).
 */
function createProgressiveSearch({
  index,
  fetchPool,
  sessions = new LRUCache({ max: 5000, ttl: 1000 * 60 * 15 }),
  singleflight = createSingleflight(),
  batchSize = BATCH_SIZE,
  poolSize = POOL_SIZE,
  minBoost = MIN_BOOST,
  minScoreRatio = 0,
} = {}) {
  async function buildSession(q, deviceType) {
    const { terms } = index.expand(q);
    const relevant = terms.filter((t) => t.boost >= minBoost);
    const rows = relevant.length
      ? await singleflight.run(`${searchKey(q)}:${deviceType || 'all'}`, () =>
          fetchPool({ terms: relevant, deviceType, limit: poolSize }))
      : [];
    const topScore = rows.length && typeof rows[0].score === 'number' ? rows[0].score : null;
    const cutoff = topScore && minScoreRatio > 0 ? topScore * minScoreRatio : null;
    const ranked = cutoff === null ? rows : rows.filter((r) => r.score >= cutoff);
    return { ranked, cursor: 0, seenIds: new Set(), q, deviceType };
  }

  async function search({ q, sessionId, limit = batchSize, deviceType } = {}) {
    let id = sessionId;
    let session = id ? sessions.get(id) : undefined;
    if (!session) {
      session = await buildSession(q, deviceType);
      id = randomUUID();
      sessions.set(id, session);
    }
    const items = [];
    while (items.length < limit && session.cursor < session.ranked.length) {
      const row = session.ranked[session.cursor++];
      const rid = String(row._id);
      if (session.seenIds.has(rid)) continue;
      session.seenIds.add(rid);
      items.push(row);
    }
    return { sessionId: id, data: items, hasMore: session.cursor < session.ranked.length };
  }

  return { search, sessions };
}

module.exports = { createProgressiveSearch, searchKey, BATCH_SIZE, POOL_SIZE, MIN_BOOST };
