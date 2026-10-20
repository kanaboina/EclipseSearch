const { randomUUID } = require('node:crypto');
const { LRUCache } = require('lru-cache');
const { createSingleflight } = require('./singleflight');

const BATCH_SIZE = 20;
const POOL_SIZE = 200;
const MIN_BOOST = 2; // relevance cutoff on term boost: below this, stop paginating
const FETCH_OVERFETCH_RATIO = 1.5; // fetch extra IDs to account for post-query filtering

/** Sorted-token key, mirrors the edge normalization so equal searches coalesce. */
const searchKey = (q) => String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');

/**
 * Batched progressive pagination with direct document-ID resolution.
 *
 * Two operating modes depending on what is provided:
 *
 *  A) **ID-first mode** (preferred): `resolvePool` is supplied.
 *     - Batch 1: expand query → collect ranked [{docId, score}] from the in-memory
 *       inverted index, store only IDs in the session.
 *     - Each batch: fetch full documents for the next `batchSize` IDs via a single
 *       `$in` query (`fetchDocs`).  No full-pool DB hit; no re-ranking of fetched docs.
 *
 *  B) **Legacy mode**: `fetchPool` is supplied (original behavior).
 *     - Batch 1: fetch a ranked pool of full rows, return slices from memory.
 *     - Sessions live in an lru-cache holding a Set of seenIds (O(1) dup check, 15 min TTL).
 *
 * `resolvePool({ terms, deviceType, limit })` → [{ docId, score }]   (ID-first)
 * `fetchPool({ terms, deviceType, limit })`   → ranked rows           (legacy)
 * `fetchDocs({ ids, deviceType })`            → full wallpaper rows   (ID-first)
 */
function createProgressiveSearch({
  index,
  resolvePool,   // ID-first: (q) -> [{docId, score}]
  fetchDocs,     // ID-first: ({ids}) -> wallpaper rows by $in
  fetchPool,     // legacy: ({terms, deviceType, limit, rawTokens}) -> rows
  sessions = new LRUCache({ max: 5000, ttl: 1000 * 60 * 15 }),
  singleflight = createSingleflight(),
  batchSize = BATCH_SIZE,
  poolSize = POOL_SIZE,
  minBoost = MIN_BOOST,
  minScoreRatio = 0,
} = {}) {
  const idFirstMode = typeof resolvePool === 'function' && typeof fetchDocs === 'function';

  /** Build an ID-first session: ranked docId list in memory, no docs fetched yet. */
  async function buildIdFirstSession(q, deviceType) {
    const sfKey = `ids:${searchKey(q)}:${deviceType || 'all'}`;
    const ranked = await singleflight.run(sfKey, () => resolvePool({ q, deviceType, limit: poolSize }));
    return {
      mode: 'id-first',
      // ranked: [{ docId, score }] — only IDs stored in session
      ranked,
      cursor: 0,
      seenIds: new Set(),
      q,
      deviceType,
    };
  }

  /** Build a legacy session: fetch full pool once, slice from memory. */
  async function buildLegacySession(q, deviceType) {
    const { terms, tokens } = index.expand(q);
    const relevant = terms.filter((t) => t.boost >= minBoost);
    const rawTokens = (tokens || []).map((t) => t.word);
    const rows = relevant.length
      ? await singleflight.run(`${searchKey(q)}:${deviceType || 'all'}`, () =>
          fetchPool({ terms: relevant, deviceType, limit: poolSize, rawTokens }))
      : [];
    const topScore = rows.length && typeof rows[0].score === 'number' ? rows[0].score : null;
    const cutoff = topScore && minScoreRatio > 0 ? topScore * minScoreRatio : null;
    const ranked = cutoff === null ? rows : rows.filter((r) => r.score >= cutoff);
    return { mode: 'legacy', ranked, cursor: 0, seenIds: new Set(), q, deviceType };
  }

  async function search({ q, sessionId, limit = batchSize, deviceType } = {}) {
    // Use client-provided sessionId if given, otherwise generate new one
    const id = sessionId || randomUUID();
    let session = sessions.get(id);

    if (!session) {
      session = idFirstMode
        ? await buildIdFirstSession(q, deviceType)
        : await buildLegacySession(q, deviceType);
      sessions.set(id, session);
    }

    if (session.mode === 'id-first') {
      // Collect the next `limit` unseen docIds from the ranked list.
      // Over-fetch to account for docs that may be filtered out by fetchDocs (e.g., deleted, unpublished)
      const targetCount = Math.ceil(limit * FETCH_OVERFETCH_RATIO);
      const idBatch = [];
      while (idBatch.length < targetCount && session.cursor < session.ranked.length) {
        const { docId } = session.ranked[session.cursor++];
        if (!session.seenIds.has(docId)) {
          session.seenIds.add(docId);
          idBatch.push(docId);
        }
      }
      const hasMore = session.cursor < session.ranked.length;

      // Hydrate the IDs into full documents in a single batched $in query.
      const docs = idBatch.length ? await fetchDocs({ ids: idBatch, deviceType }) : [];

      // Re-order docs to match the ranking order of idBatch (fetchDocs may return in any order).
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      const ordered = idBatch.map((docId) => byId.get(docId)).filter(Boolean);

      // Trim to requested limit
      const data = ordered.slice(0, limit);

      return { sessionId: id, data, hasMore };
    }

    // Legacy mode: slice ranked pool.
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
