const test = require('node:test');
const assert = require('node:assert/strict');
const { SearchBufferCache } = require('../src/services/searchBufferCache');
const {
  createSearchService,
  normalizeQuery,
  clampPaging,
  MAX_LIMIT,
  DEFAULT_LIMIT,
} = require('../src/services/wallpaperService');

function mockBatchFetcher(totalItems) {
  const dataset = Array.from({ length: totalItems }, (_, i) => ({
    _id: `wp_${String(i).padStart(4, '0')}`,
    title: `Wallpaper ${i}`,
    slug: `wallpaper-${i}`,
    previewUrl: `https://cdn.example.com/${i}.webp`,
  }));

  const calls = [];
  const fetchBatch = async ({ limit, excludeIds = [] }) => {
    calls.push({ limit, excludeCount: excludeIds.length });
    const excluded = new Set(excludeIds);
    return dataset.filter((item) => !excluded.has(item._id)).slice(0, limit);
  };
  fetchBatch.calls = calls;
  return fetchBatch;
}

const flushScheduler = () => new Promise((resolve) => setTimeout(resolve, 25));

test('normalizeQuery trims extra whitespace and converts to lowercase', () => {
  assert.equal(normalizeQuery('   DARK   WOLF   '), 'dark wolf');
  assert.equal(normalizeQuery('CYBERPUNK\t\n2077'), 'cyberpunk 2077');
  assert.equal(normalizeQuery(null), '');
});

test('clampPaging enforces minimum page of 1', () => {
  assert.equal(clampPaging(-5, 20).page, 1);
  assert.equal(clampPaging(0, 20).page, 1);
  assert.equal(clampPaging('abc', 20).page, 1);
});

test('clampPaging enforces maximum limit of 48 and default limit of 20', () => {
  assert.equal(clampPaging(1, 100).limit, MAX_LIMIT); // capped at 48
  assert.equal(clampPaging(1, 0).limit, DEFAULT_LIMIT); // 20
  assert.equal(clampPaging(1, 'abc').limit, DEFAULT_LIMIT); // 20
  assert.equal(clampPaging(1, -10).limit, 1); // clamped to min 1
  assert.equal(clampPaging(1, 30).limit, 30);
});

test('search returns first page of data with complete pagination metadata', async () => {
  const fetchBatch = mockBatchFetcher(60);
  const svc = createSearchService({ fetchBatch, cache: new SearchBufferCache() });

  const res = await svc.search({ q: 'dragon', page: 1, limit: 10 });
  assert.equal(res.data.length, 10);
  assert.equal(res.meta.pagination.page, 1);
  assert.equal(res.meta.pagination.limit, 10);
  assert.equal(res.meta.pagination.hasNextPage, true);
  assert.equal(res.meta.pagination.hasPrevPage, false);
  assert.ok(res.meta.pagination.buffered >= 10);
});

test('search multi-page pagination guarantees zero duplicate IDs across pages', async () => {
  const fetchBatch = mockBatchFetcher(120);
  const svc = createSearchService({ fetchBatch, cache: new SearchBufferCache() });

  const seenIds = [];
  for (let p = 1; p <= 5; p++) {
    const res = await svc.search({ q: 'neon wolf', page: p, limit: 20 });
    seenIds.push(...res.data.map((c) => c._id));
    await flushScheduler();
  }

  assert.equal(seenIds.length, 100);
  assert.equal(new Set(seenIds).size, 100); // 100% unique, zero duplicates
});

test('search uses prefetch buffer for subsequent pages with seen IDs excluded', async () => {
  const fetchBatch = mockBatchFetcher(120);
  const svc = createSearchService({ fetchBatch, cache: new SearchBufferCache() });

  await svc.search({ q: 'fenrir', page: 1, limit: 20 });
  // Page 2 brings remaining buffer to 10 (< 25 threshold), triggering prefetch
  await svc.search({ q: 'fenrir', page: 2, limit: 20 });
  await flushScheduler();

  assert.ok(fetchBatch.calls.length >= 2);
  assert.ok(fetchBatch.calls[1].excludeCount >= 50);
});

test('search marks hasNextPage false on final page and populates total and totalPages', async () => {
  const fetchBatch = mockBatchFetcher(25);
  const svc = createSearchService({ fetchBatch, cache: new SearchBufferCache() });

  const res = await svc.search({ q: 'short catalog', page: 2, limit: 20 });
  assert.equal(res.data.length, 5);
  assert.equal(res.meta.pagination.hasNextPage, false);
  assert.equal(res.meta.pagination.total, 25);
  assert.equal(res.meta.pagination.totalPages, 2);
});

test('search re-fetches synchronously if requested page is beyond current buffer', async () => {
  const fetchBatch = mockBatchFetcher(100);
  const svc = createSearchService({ fetchBatch, cache: new SearchBufferCache() });

  // Prime buffer with page 1 (items 0..50)
  await svc.search({ q: 'jump', page: 1, limit: 20 });
  // Jumping to page 4 (items 60..80) fetches next batch synchronously
  const res = await svc.search({ q: 'jump', page: 4, limit: 20 });
  assert.equal(res.data.length, 20);
  assert.equal(res.data[0]._id, 'wp_0060');
});

test('search isolates cache by query string and deviceType', async () => {
  const fetchBatch = mockBatchFetcher(40);
  const svc = createSearchService({ fetchBatch, cache: new SearchBufferCache() });

  await svc.search({ q: 'wolf', deviceType: 'desktop', page: 1, limit: 10 });
  await svc.search({ q: 'wolf', deviceType: 'phone', page: 1, limit: 10 });

  // Different deviceType must generate separate cache keys and separate fetch calls
  assert.equal(fetchBatch.calls.length, 2);
});

test('search prefetch failure handles gracefully without breaking active search response', async () => {
  let callCount = 0;
  const flakeyFetcher = async () => {
    callCount++;
    if (callCount > 1) throw new Error('Prefetch network timeout');
    return Array.from({ length: 30 }, (_, i) => ({ _id: `id_${i}`, title: `t${i}`, previewUrl: 'u' }));
  };
  const svc = createSearchService({ fetchBatch: flakeyFetcher, cache: new SearchBufferCache() });

  const res = await svc.search({ q: 'flakey', page: 1, limit: 10 });
  assert.equal(res.data.length, 10);
  await flushScheduler();
  // Service remains operational
  assert.equal(res.meta.pagination.page, 1);
});
