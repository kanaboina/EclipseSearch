/** In-flight request coalescer: concurrent calls with the same key share one Promise. */
function createSingleflight() {
  const inflight = new Map();
  function run(key, fn) {
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = Promise.resolve()
      .then(fn)
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }
  return { run, get pending() { return inflight.size; } };
}

module.exports = { createSingleflight };
