const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SearchBufferCache,
  searchBufferCache,
  invalidateSearchCache,
} = require('../src/services/searchBufferCache');

test('get returns undefined for absent keys in cache', () => {
  const cache = new SearchBufferCache();
  assert.equal(cache.get('nonexistent'), undefined);
});

test('set stores key-value pair and get retrieves it', () => {
  const cache = new SearchBufferCache();
  cache.set('key1', { items: [1, 2, 3] });
  assert.deepEqual(cache.get('key1'), { items: [1, 2, 3] });
});

test('get respects TTL and evicts expired items', () => {
  let currentTime = 1000;
  const cache = new SearchBufferCache({ ttlMs: 500, now: () => currentTime });
  cache.set('item1', 'value1');
  assert.equal(cache.get('item1'), 'value1');

  // Fast forward past TTL
  currentTime = 1501;
  assert.equal(cache.get('item1'), undefined);
  assert.equal(cache.size, 0); // evicted on get
});

test('get refreshes LRU order so accessed item survives eviction', () => {
  const cache = new SearchBufferCache({ max: 2 });
  cache.set('a', 1);
  cache.set('b', 2);

  // Access 'a' to make it most-recently used
  assert.equal(cache.get('a'), 1);

  // Adding 'c' should evict 'b' (the least recently used), leaving 'a' and 'c'
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('set evicts oldest key when capacity exceeds max limit', () => {
  const cache = new SearchBufferCache({ max: 3 });
  cache.set('k1', 'v1');
  cache.set('k2', 'v2');
  cache.set('k3', 'v3');
  cache.set('k4', 'v4');

  assert.equal(cache.size, 3);
  assert.equal(cache.get('k1'), undefined);
  assert.equal(cache.get('k4'), 'v4');
});

test('clear empties all items and increments cache generation', () => {
  const cache = new SearchBufferCache();
  cache.set('x', 10);
  cache.set('y', 20);
  const genBefore = cache.generation;

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('x'), undefined);
  assert.equal(cache.generation, genBefore + 1);
});

test('size property reflects current item count in cache', () => {
  const cache = new SearchBufferCache();
  assert.equal(cache.size, 0);
  cache.set('one', 1);
  assert.equal(cache.size, 1);
  cache.set('two', 2);
  assert.equal(cache.size, 2);
  cache.set('one', 11); // overwrite does not increase size
  assert.equal(cache.size, 2);
});

test('invalidateSearchCache helper resets global searchBufferCache instance', () => {
  searchBufferCache.set('test_key', 'val');
  assert.equal(searchBufferCache.get('test_key'), 'val');
  const genBefore = searchBufferCache.generation;

  invalidateSearchCache();
  assert.equal(searchBufferCache.get('test_key'), undefined);
  assert.equal(searchBufferCache.generation, genBefore + 1);
});
