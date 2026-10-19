/** LRU (max 200 keys) + 5 min TTL cache for the sliding 50-item search buffer. */
class SearchBufferCache {
  constructor({ max = 200, ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
    this.generation = 0; // bumped on invalidation so in-flight prefetches can be discarded
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) { this.map.delete(key); return undefined; }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, at: this.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() { this.map.clear(); this.generation++; }
  get size() { return this.map.size; }
}

const searchBufferCache = new SearchBufferCache();

/** Call on publish, edit, delete, withdrawal (draft/deletionPending), category rename. */
function invalidateSearchCache() { searchBufferCache.clear(); }

module.exports = { SearchBufferCache, searchBufferCache, invalidateSearchCache };
