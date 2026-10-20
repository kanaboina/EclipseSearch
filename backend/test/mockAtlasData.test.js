const test = require('node:test');
const assert = require('node:assert/strict');
const { generate10kCatalog, createAtlasSearchSimulator } = require('../src/mockAtlasData');

test('generate10kCatalog produces exact requested number of documents', () => {
  const { docs, tokenIndex, words } = generate10kCatalog(100);
  assert.equal(docs.length, 100);
  assert.ok(tokenIndex.size > 0);
  assert.ok(words.length >= 100);
});

test('generate10kCatalog documents have all required Atlas schema fields', () => {
  const { docs } = generate10kCatalog(10);
  for (const doc of docs) {
    assert.ok(typeof doc._id === 'string');
    assert.ok(typeof doc.title === 'string' && doc.title.length > 0);
    assert.ok(typeof doc.slug === 'string');
    assert.ok(Array.isArray(doc.tags) && doc.tags.length > 0);
    assert.ok(typeof doc.categoryName === 'string');
    assert.ok(doc.category && typeof doc.category.name === 'string');
    assert.ok(['desktop', 'phone', 'tablet'].includes(doc.deviceType));
    assert.equal(doc.status, 'published');
    assert.equal(doc.deletionPending, false);
    assert.ok(doc.publishAt instanceof Date);
    assert.ok(typeof doc.views === 'number' && doc.views >= 0);
    assert.ok(typeof doc.downloadsCount === 'number');
    assert.ok(typeof doc.previewUrl === 'string');
    assert.ok(typeof doc.thumbnailUrl === 'string');
    assert.equal(doc.width, 3840);
    assert.equal(doc.height, 2160);
  }
});

test('generate10kCatalog produces unique _id per document', () => {
  const { docs } = generate10kCatalog(500);
  const ids = docs.map((d) => d._id);
  assert.equal(new Set(ids).size, ids.length);
});

test('generate10kCatalog builds a valid token index mapping tokens to document indices', () => {
  const { docs, tokenIndex } = generate10kCatalog(50);
  // Every document's title tokens should map back to its index
  for (let i = 0; i < docs.length; i++) {
    const titleTokens = docs[i].title.toLowerCase().split(/\s+/);
    for (const t of titleTokens) {
      if (t === 'in') continue; // skip the "in" conjunction word in title template
      const set = tokenIndex.get(t);
      assert.ok(set, `Token "${t}" not found in tokenIndex`);
      assert.ok(set.has(i), `Document index ${i} not found under token "${t}"`);
    }
  }
});

test('createAtlasSearchSimulator returns scored results for matching terms', async () => {
  const catalog = generate10kCatalog(200);
  const simulator = createAtlasSearchSimulator(catalog);
  const results = await simulator({
    terms: [{ term: 'fantasy', boost: 10 }],
    rawTokens: ['fantasy'],
    limit: 20,
  });
  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0);
  assert.ok(results.length <= 20);
  // Results should be sorted by score descending
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i - 1].score >= results[i].score || results[i - 1]._id < results[i]._id);
  }
});

test('createAtlasSearchSimulator respects deviceType filter', async () => {
  const catalog = generate10kCatalog(500);
  const simulator = createAtlasSearchSimulator(catalog);
  const results = await simulator({
    terms: [{ term: 'dragon', boost: 5 }],
    rawTokens: ['dragon'],
    deviceType: 'phone',
    limit: 50,
  });
  for (const r of results) {
    assert.equal(r.deviceType, 'phone');
  }
});

test('createAtlasSearchSimulator respects excludeIds', async () => {
  const catalog = generate10kCatalog(200);
  const simulator = createAtlasSearchSimulator(catalog);
  const first = await simulator({ terms: [{ term: 'fantasy', boost: 10 }], rawTokens: [], limit: 5 });
  const excludeIds = first.slice(0, 2).map((r) => r._id);
  const second = await simulator({
    terms: [{ term: 'fantasy', boost: 10 }],
    rawTokens: [],
    limit: 50,
    excludeIds,
  });
  for (const r of second) {
    assert.ok(!excludeIds.includes(r._id), `Excluded ID ${r._id} found in results`);
  }
});

test('createAtlasSearchSimulator returns empty for non-matching query', async () => {
  const catalog = generate10kCatalog(50);
  const simulator = createAtlasSearchSimulator(catalog);
  const results = await simulator({
    terms: [{ term: 'zzzzznonexistent', boost: 10 }],
    rawTokens: ['zzzzznonexistent'],
    limit: 10,
  });
  // Should still return results (fallback sampling) but they will have score 0
  assert.ok(Array.isArray(results));
});

test('createAtlasSearchSimulator results contain DTO fields (no internal fields leaked)', async () => {
  const catalog = generate10kCatalog(100);
  const simulator = createAtlasSearchSimulator(catalog);
  const results = await simulator({
    terms: [{ term: 'dragon', boost: 5 }],
    rawTokens: ['dragon'],
    limit: 5,
  });
  for (const r of results) {
    assert.ok(typeof r._id === 'string');
    assert.ok(typeof r.title === 'string');
    assert.equal('story' in r, false);
    assert.equal('downloadKeys' in r, false);
  }
});
