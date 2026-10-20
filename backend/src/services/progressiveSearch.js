const { randomUUID } = require('node:crypto');
const { LRUCache } = require('lru-cache');
const { createSingleflight } = require('./singleflight');

const BATCH_SIZE = 20;
const POOL_SIZE = 200;
const MIN_BOOST = 2; // relevance cutoff on term boost: below this, stop paginating

/** Sorted-token key, mirrors the edge normalization so equal searches coalesce. */
const searchKey = (q) => String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');

/**
 * Batched progressive pagination with direct document-ID resolution.
 *
 * Two operating modes depending on what is provided:
 *
 *  A) **ID-first mode** (preferred): `resolvePool` is supplied.
 *     - Batch 1: resolve ranked [{docId, score}] using the supplied resolver
 *       (for example Atlas Search or an inverted index), store only IDs in the session.
 *     - Each batch: fetch full documents for the next `batchSize` IDs via a single
 *       `$in` query (`fetchDocs`), refilling if visibility filtering removes rows.
 *       Hydration preserves the resolver's ranking.
 *
 *  B) **Legacy mode**: `fetchPool` is supplied (original behavior).
 *     - Batch 1: fetch a ranked pool of full rows, return slices from memory.
 *     - Sessions live in an lru-cache holding a Set of seenIds (O(1) dup check, 15 min TTL).
 *
 * `resolvePool({ q, deviceType, limit })` → [{ docId, score }]   (ID-first)
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
          fetchPool({ q, terms: relevant, deviceType, limit: poolSize, rawTokens }))
      : [];
    const topScore = rows.length && typeof rows[0].score === 'number' ? rows[0].score : null;
    const cutoff = topScore && minScoreRatio > 0 ? topScore * minScoreRatio : null;
    const ranked = cutoff === null ? rows : rows.filter((r) => r.score >= cutoff);
    return { mode: 'legacy', ranked, cursor: 0, seenIds: new Set(), q, deviceType };
  }

  async function search({ q, sessionId, page, limit = batchSize, deviceType } = {}) {
    limit = Math.min(48, Math.max(1, parseInt(limit, 10) || batchSize));
    const explicitPage = page === undefined ? undefined : Math.max(1, parseInt(page, 10) || 1);
    let id = sessionId;
    let session = sessions.get(id);

    if (!session) {
      if (!String(q || '').trim()) {
        const error = new Error(sessionId ? 'Search session expired; restart with a query' : 'A search query is required');
        error.statusCode = sessionId ? 410 : 400;
        throw error;
      }
      session = idFirstMode
        ? await buildIdFirstSession(q, deviceType)
        : await buildLegacySession(q, deviceType);
      id = randomUUID();
      sessions.set(id, session);
    } else if ((String(q || '').trim() && searchKey(q) !== searchKey(session.q)) ||
               (deviceType !== undefined && deviceType !== session.deviceType)) {
      const error = new Error('Query and deviceType must match the search session');
      error.statusCode = 400;
      throw error;
    }

    // Serialize requests for a session. Explicit page numbers can jump/replay;
    // omitting page continues the cursor. ID pages always recheck visibility.
    const previous = session.pending || Promise.resolve();
    const pending = previous.then(async () => {
      const state = { ...session, seenIds: new Set(session.seenIds) };
      if (explicitPage !== undefined) {
        state.cursor = 0;
        state.seenIds = new Set();
        state.returnedCount = 0;
        let skip = (explicitPage - 1) * limit;
        while (skip > 0 && state.cursor < state.ranked.length) {
          const skipped = await advance(state, id, Math.min(skip, limit));
          skip -= skipped.data.length;
        }
      }
      const resultPage = explicitPage ?? Math.floor((state.returnedCount || state.seenIds.size) / limit) + 1;
      const result = await advance(state, id, limit);
      // Commit only after the entire request succeeds, including any skipped pages.
      session.cursor = state.cursor;
      session.seenIds = state.seenIds;
      session.returnedCount = state.returnedCount;
      return { ...result, page: resultPage };
    });
    session.pending = pending.then(() => {}, () => {});
    return pending;
  }

  async function advance(session, id, limit) {
    if (session.mode === 'id-first') {
      // Use local state until hydration succeeds so a failed query can be retried.
      let cursor = session.cursor;
      const seenIds = new Set(session.seenIds);
      const data = [];
      while (data.length < limit && cursor < session.ranked.length) {
        const idBatch = [];
        // Fetch only the number of rows still needed; no visible rows are discarded.
        while (idBatch.length < limit - data.length && cursor < session.ranked.length) {
          const docId = String(session.ranked[cursor++].docId);
          if (!seenIds.has(docId)) {
            seenIds.add(docId);
            idBatch.push(docId);
          }
        }
        if (!idBatch.length) continue;
        const docs = await fetchDocs({ ids: idBatch, deviceType: session.deviceType });
        const byId = new Map(docs.map((d) => [String(d._id), d]));
        data.push(...idBatch.map((docId) => byId.get(docId)).filter(Boolean));
      }
      session.cursor = cursor;
      session.seenIds = seenIds;
      session.returnedCount = (session.returnedCount || 0) + data.length;
      const hasMore = cursor < session.ranked.length;
      return { sessionId: id, data, hasMore, total: hasMore ? undefined : session.returnedCount };
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
    return { sessionId: id, data: items, hasMore: session.cursor < session.ranked.length, total: session.seenIds.size };
  }

  return { search, sessions };
}

module.exports = { createProgressiveSearch, searchKey, BATCH_SIZE, POOL_SIZE, MIN_BOOST };
