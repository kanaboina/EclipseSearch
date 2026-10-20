const { searchBufferCache } = require('./searchBufferCache');
const { wallpaperCardDTO } = require('../utils/wallpaperDTO');

const BATCH = 50;
const PREFETCH_THRESHOLD = 25;
const MAX_LIMIT = 48;
const DEFAULT_LIMIT = 20;

const normalizeQuery = (q) => String(q || '').toLowerCase().trim().replace(/\s+/g, ' ');

function clampPaging(page, limit) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT));
  return { page: p, limit: l };
}

/**
 * createSearchService({ fetchBatch, cache }) where
 * fetchBatch({ q, deviceType, limit, excludeIds }) -> raw wallpaper rows.
 */
function createSearchService({ fetchBatch, cache = searchBufferCache, batchSize = BATCH, schedule = setImmediate } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize must be a positive integer');
  const inflight = new Map(); // cacheKey -> Promise

  function absorb(entry, rows) {
    let added = 0;
    for (const row of rows) {
      const card = wallpaperCardDTO(row);
      if (entry.seenIds.has(card._id)) continue;
      entry.seenIds.add(card._id);
      entry.items.push(card);
      added++;
    }
    entry.hasMore = rows.length >= batchSize && added > 0;
  }

  function fetchNext(key, params, entry, scheduled = false) {
    const existing = inflight.get(key);
    if (existing?.entry === entry) return existing;
    const p = (scheduled ? new Promise((resolve) => schedule(resolve)) : Promise.resolve())
      .then(() => fetchBatch({ ...params, limit: batchSize, excludeIds: Array.from(entry.seenIds) }))
      .then((rows) => {
        if (cache.generation === entry.generation && cache.get(key) === entry) absorb(entry, rows);
      })
      .catch((error) => { if (!scheduled) throw error; })
      .finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
    p.entry = entry;
    inflight.set(key, p);
    return p;
  }

  function prefetch(key, params, entry) {
    if (!entry.hasMore || inflight.has(key)) return;
    // Failure leaves the buffer retryable. Foreground requests surface their own
    // fetch errors; speculative work must not create an unhandled rejection.
    fetchNext(key, params, entry, true).catch(() => {});
  }

  async function search({ q, page, limit, deviceType }) {
    const { page: P, limit: L } = clampPaging(page, limit);
    const nq = normalizeQuery(q);
    const params = { q: nq, deviceType };
    const key = `${nq}:${deviceType || 'all'}`;
    const startIdx = (P - 1) * L;
    const endIdx = startIdx + L;

    let entry;
    // Invalidation can happen during any fetch. Restart from the current cache
    // generation instead of returning or storing data fetched before that edit.
    for (;;) {
      entry = cache.get(key);
      if (!entry) {
        entry = { items: [], seenIds: new Set(), hasMore: true, generation: cache.generation };
        cache.set(key, entry);
      }
      while (entry.items.length < endIdx && entry.hasMore) {
        await fetchNext(key, params, entry);
        if (cache.generation !== entry.generation || cache.get(key) !== entry) break;
      }
      if (cache.generation === entry.generation && cache.get(key) === entry) break;
    }

    const items = entry.items.slice(startIdx, endIdx);
    if (entry.hasMore && entry.items.length - endIdx < PREFETCH_THRESHOLD) prefetch(key, params, entry);

    const hasNextPage = entry.items.length > endIdx || entry.hasMore;
    return {
      data: items,
      meta: {
        pagination: {
          page: P,
          limit: L,
          hasNextPage,
          hasPrevPage: P > 1,
          buffered: entry.items.length,
          ...(entry.hasMore ? {} : { total: entry.items.length, totalPages: Math.ceil(entry.items.length / L) }),
        },
      },
    };
  }

  return { search, _inflight: inflight };
}

module.exports = { createSearchService, normalizeQuery, clampPaging, BATCH, MAX_LIMIT, DEFAULT_LIMIT };
