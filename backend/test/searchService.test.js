const test = require('node:test');
const assert = require('node:assert/strict');
const { SearchBufferCache } = require('../src/services/searchBufferCache');
const { createSearchService } = require('../src/services/wallpaperService');
const { buildAtlasPipeline, buildTextFallbackQuery } = require('../src/services/searchRanking');
const { wallpaperCardDTO } = require('../src/utils/wallpaperDTO');
const { publicVisibilityFilter } = require('../src/utils/visibilityFilter');

function fakeFetch(total) {
  const all = Array.from({ length: total }, (_, i) => ({
    _id: `id${String(i).padStart(4, '0')}`, title: `w${i}`, slug: `w${i}`, previewUrl: 'u',
    story: 'SECRET', downloadKeys: { '4k': 'k' }, downloadBucket: 'private', uuid: 'x', downloads: { '4k': 'd' },
  }));
  const calls = [];
  const fn = async ({ limit, excludeIds }) => {
    calls.push({ limit, excl: excludeIds.length });
    const ex = new Set(excludeIds);
    return all.filter((r) => !ex.has(r._id)).slice(0, limit);
  };
  fn.calls = calls;
  return fn;
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test('multi-page traversal has zero duplicate ids and uses prefetch buffer', async () => {
  const fetchBatch = fakeFetch(130);
  const svc = createSearchService({ fetchBatch, cache: new SearchBufferCache() });
  const ids = [];
  for (let p = 1; p <= 6; p++) {
    const r = await svc.search({ q: 'Dark  Wolf', page: p, limit: 20 });
    ids.push(...r.data.map((c) => c._id));
    await flush();
  }
  assert.equal(ids.length, 120);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(fetchBatch.calls[0].limit, 50);
  assert.ok(fetchBatch.calls[1].excl >= 50); // prefetch used $nin of seen ids
});

test('last page reports no next page', async () => {
  const svc = createSearchService({ fetchBatch: fakeFetch(30), cache: new SearchBufferCache() });
  const r = await svc.search({ q: 'x', page: 2, limit: 20 });
  assert.equal(r.data.length, 10);
  assert.equal(r.meta.pagination.hasNextPage, false);
});

test('invalidation discards cache', async () => {
  const cache = new SearchBufferCache();
  const f = fakeFetch(10);
  const svc = createSearchService({ fetchBatch: f, cache });
  await svc.search({ q: 'a', page: 1, limit: 5 });
  cache.clear();
  await svc.search({ q: 'a', page: 1, limit: 5 });
  assert.equal(f.calls.filter((c) => c.excl === 0).length, 2);
});

test('cache LRU max and TTL', () => {
  let t = 0;
  const c = new SearchBufferCache({ max: 2, ttlMs: 10, now: () => t });
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  assert.equal(c.get('a'), undefined);
  t = 11;
  assert.equal(c.get('b'), undefined);
});

test('cards never leak private fields', async () => {
  const card = wallpaperCardDTO({ _id: 'a', title: 't', story: 's', downloadKeys: {}, downloadBucket: 'private', uuid: 'u', downloads: {}, conversionJournal: {} });
  for (const k of ['story', 'downloadKeys', 'downloadBucket', 'uuid', 'downloads', 'conversionJournal']) {
    assert.ok(!(k in card), k);
  }
});

test('visibility filter excludes drafts and deletionPending in Atlas and $text paths', () => {
  const now = new Date();
  const v = publicVisibilityFilter(now);
  assert.deepEqual(v.status, { $ne: 'draft' });
  assert.deepEqual(v.deletionPending, { $ne: true });
  const atlas = buildAtlasPipeline({ q: 'dark sky wolf', now });
  const match = atlas.find((s) => s.$match).$match;
  assert.deepEqual(match.deletionPending, { $ne: true });
  assert.deepEqual(match.status, { $ne: 'draft' });
  const text = buildTextFallbackQuery({ q: 'wolf', now });
  assert.deepEqual(text.deletionPending, { $ne: true });
  assert.deepEqual(text.status, { $ne: 'draft' });
});

test('atlas pipeline: primary minimumShouldMatch and deterministic sort', () => {
  const p = buildAtlasPipeline({ q: 'wolf', expansion: { terms: [{ term: 'fenrir', cost: 2, boost: 6.67 }] } });
  const compound = p[0].$search.compound;
  assert.equal(compound.must[0].compound.minimumShouldMatch, 1);
  assert.ok(compound.should.every((c) => ['excerpt', 'style'].includes(c.text.path)));
  assert.deepEqual(p.find((s) => s.$sort).$sort, { _searchScore: -1, views: -1, downloadsCount: -1, _id: 1 });
});
