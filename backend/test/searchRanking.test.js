const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  buildAtlasPipeline,
  buildTextFallbackQuery,
  fetchSearchBatch,
  PRIMARY,
} = require('../src/services/searchRanking');

test('PRIMARY weights define title=10, tags=8, categoryName=7', () => {
  assert.equal(PRIMARY.title, 10);
  assert.equal(PRIMARY.tags, 8);
  assert.equal(PRIMARY.categoryName, 7);
});

test('buildAtlasPipeline generates $search stage with wallpaper_search index', () => {
  const pipeline = buildAtlasPipeline({ q: 'wolf' });
  assert.equal(pipeline[0].$search.index, 'wallpaper_search');
  assert.ok(pipeline[0].$search.compound);
});

test('buildAtlasPipeline applies must compound with minimumShouldMatch 1 on primary fields', () => {
  const pipeline = buildAtlasPipeline({ q: 'wolf' });
  const compound = pipeline[0].$search.compound;
  assert.equal(compound.must[0].compound.minimumShouldMatch, 1);
  assert.ok(compound.must[0].compound.should.length > 0);
});

test('buildAtlasPipeline adds fuzzy matching for raw tokens with maxEdits 1 and prefixLength 2', () => {
  const pipeline = buildAtlasPipeline({ q: 'dragon' });
  const primary = pipeline[0].$search.compound.must[0].compound.should;
  const fuzzy = primary.find((c) => c.text && c.text.fuzzy);
  assert.ok(fuzzy);
  assert.equal(fuzzy.text.fuzzy.maxEdits, 1);
  assert.equal(fuzzy.text.fuzzy.prefixLength, 2);
});

test('buildAtlasPipeline adds edgegram autocomplete clauses on title and tags', () => {
  const pipeline = buildAtlasPipeline({ q: 'cyberpunk' });
  const primary = pipeline[0].$search.compound.must[0].compound.should;
  const autoTitle = primary.find((c) => c.autocomplete && c.autocomplete.path === 'title');
  const autoTags = primary.find((c) => c.autocomplete && c.autocomplete.path === 'tags');
  assert.ok(autoTitle);
  assert.equal(autoTitle.autocomplete.score.boost.value, 6);
  assert.ok(autoTags);
  assert.equal(autoTags.autocomplete.score.boost.value, 4);
});

test('buildAtlasPipeline adds support clauses for excerpt (0.5x) and style (0.25x)', () => {
  const pipeline = buildAtlasPipeline({
    q: 'wolf',
    expansion: { terms: [{ term: 'fenrir', cost: 1, boost: 10 }] },
  });
  const support = pipeline[0].$search.compound.should;
  const excerptClause = support.find((s) => s.text && s.text.path === 'excerpt');
  const styleClause = support.find((s) => s.text && s.text.path === 'style');
  assert.ok(excerptClause);
  assert.equal(excerptClause.text.score.boost.value, 5); // 0.5 * 10
  assert.ok(styleClause);
  assert.equal(styleClause.text.score.boost.value, 2.5); // 0.25 * 10
});

test('buildAtlasPipeline injects deviceType filter when deviceType option is passed', () => {
  const withDevice = buildAtlasPipeline({ q: 'sky', deviceType: 'phone' });
  const withoutDevice = buildAtlasPipeline({ q: 'sky' });
  assert.deepEqual(withDevice[0].$search.compound.filter, [{ equals: { path: 'deviceType', value: 'phone' } }]);
  assert.equal(withoutDevice[0].$search.compound.filter, undefined);
});

test('buildAtlasPipeline converts excludeIds to ObjectIds in $match._id $nin', () => {
  const id1 = new mongoose.Types.ObjectId().toString();
  const id2 = new mongoose.Types.ObjectId().toString();
  const pipeline = buildAtlasPipeline({ q: 'wolf', excludeIds: [id1, id2] });
  const match = pipeline.find((s) => s.$match).$match;
  assert.ok(match._id && match._id.$nin);
  assert.equal(match._id.$nin.length, 2);
  assert.ok(match._id.$nin[0] instanceof mongoose.Types.ObjectId);
});

test('buildAtlasPipeline enforces deterministic sort by _searchScore, views, downloadsCount, _id', () => {
  const pipeline = buildAtlasPipeline({ q: 'knight' });
  const sortStage = pipeline.find((s) => s.$sort);
  assert.deepEqual(sortStage.$sort, {
    _searchScore: -1,
    views: -1,
    downloadsCount: -1,
    _id: 1,
  });
});

test('buildTextFallbackQuery constructs $text query with publicVisibilityFilter', () => {
  const query = buildTextFallbackQuery({ q: 'fantasy art' });
  assert.deepEqual(query.$text, { $search: 'fantasy art' });
  assert.deepEqual(query.status, { $ne: 'draft' });
  assert.deepEqual(query.deletionPending, { $ne: true });
});

test('buildTextFallbackQuery includes deviceType and excludeIds when supplied', () => {
  const id = new mongoose.Types.ObjectId().toString();
  const query = buildTextFallbackQuery({ q: 'dark', deviceType: 'desktop', excludeIds: [id] });
  assert.equal(query.deviceType, 'desktop');
  assert.equal(query._id.$nin.length, 1);
  assert.ok(query._id.$nin[0] instanceof mongoose.Types.ObjectId);
});

test('fetchSearchBatch falls back to $text search when Atlas aggregate throws error', async () => {
  const fallbackDocs = [{ _id: 'doc1', title: 'Fallback Result' }];
  const mockWallpaper = {
    aggregate: async () => {
      throw new Error('MongoServerError: PlanExecutor error during aggregation [SearchNotEnabled]');
    },
    find: (filter, projection) => ({
      sort: () => ({
        limit: () => ({
          populate: () => ({
            lean: async () => fallbackDocs,
          }),
        }),
      }),
    }),
  };

  const results = await fetchSearchBatch(mockWallpaper, { q: 'wolf', limit: 10 });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Fallback Result');
});
