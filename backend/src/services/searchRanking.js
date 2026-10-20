const mongoose = require('mongoose');
const { publicVisibilityFilter } = require('../utils/visibilityFilter');
const { neighborIndex } = require('./neighborIndex');
const { normalizeToken } = require('./textNlp');

const PRIMARY = { title: 10, tags: 8, categoryName: 7 };

function toObjectIds(ids) {
  return ids.map((id) => new mongoose.Types.ObjectId(String(id)));
}

/**
 * Build the Atlas `$search` pipeline.
 * - Raw query tokens: exact/prefix/fuzzy on title(10)/tags(8)/categoryName(7), so exact wins.
 * - Dijkstra terms: weighted should clauses on primary fields scaled by boost;
 *   excerpt (0.5x) and style (0.25x) only add score.
 * - minimumShouldMatch:1 applies to primary fields only (via `must` wrapper).
 */
function buildAtlasPipeline({ q, deviceType, limit = 50, excludeIds = [], now = new Date(), expansion } = {}) {
  const { terms } = expansion || neighborIndex.expand(q);
  const rawTokens = String(q || '').toLowerCase().split(/\s+/).map(normalizeToken).filter(Boolean);

  const primary = [];
  for (const tok of rawTokens) {
    for (const [path, boost] of Object.entries(PRIMARY)) {
      primary.push({ text: { query: tok, path, score: { boost: { value: boost } } } });
      primary.push({ text: { query: tok, path, fuzzy: { maxEdits: 1, prefixLength: 2 }, score: { boost: { value: boost * 0.5 } } } });
    }
    primary.push({ autocomplete: { query: tok, path: 'title', score: { boost: { value: 6 } } } });
    primary.push({ autocomplete: { query: tok, path: 'tags', score: { boost: { value: 4 } } } });
  }
  const support = [];
  for (const { term, boost } of terms) {
    // Only add to support (should), NOT to primary (must) - prevents double-counting
    for (const [path, base] of Object.entries(PRIMARY)) {
      support.push({ text: { query: term, path, score: { boost: { value: Math.max(0.01, boost * (base / 10)) } } } });
    }
    support.push({ text: { query: term, path: 'excerpt', score: { boost: { value: 0.5 * boost } } } });
    support.push({ text: { query: term, path: 'style', score: { boost: { value: 0.25 * boost } } } });
  }

  const compound = {
    must: [{ compound: { should: primary, minimumShouldMatch: 1 } }],
    should: support,
  };
  if (deviceType) compound.filter = [{ equals: { path: 'deviceType', value: deviceType } }];

  const match = { ...publicVisibilityFilter(now) };
  if (excludeIds.length) match._id = { $nin: toObjectIds(excludeIds) };

  return [
    { $search: { index: 'wallpaper_search', compound } },
    { $addFields: { _searchScore: { $meta: 'searchScore' } } },
    { $match: match },
    { $sort: { _searchScore: -1, views: -1, downloadsCount: -1, _id: 1 } },
    { $limit: limit },
    { $lookup: { from: 'categories', localField: 'category', foreignField: '_id', as: 'category',
        pipeline: [{ $project: { name: 1, slug: 1 } }] } },
    { $addFields: { category: { $arrayElemAt: ['$category', 0] } } },
  ];
}

function buildTextFallbackQuery({ q, deviceType, excludeIds = [], now = new Date() }) {
  const filter = { $text: { $search: String(q) }, ...publicVisibilityFilter(now) };
  if (deviceType) filter.deviceType = deviceType;
  if (excludeIds.length) filter._id = { $nin: toObjectIds(excludeIds) };
  return filter;
}

/**
 * Fetch one internal batch. Atlas first; $text fallback if Atlas errors
 * (e.g. SearchNotEnabled) or returns 0 results on the first batch.
 */
async function fetchSearchBatch(Wallpaper, { q, deviceType, limit = 50, excludeIds = [], now = new Date(), expansion } = {}) {
  const first = excludeIds.length === 0;
  try {
    const rows = await Wallpaper.aggregate(buildAtlasPipeline({ q, deviceType, limit, excludeIds, now, expansion }));
    if (rows.length || !first) return rows;
  } catch (_) { /* fall through to $text */ }
  const filter = buildTextFallbackQuery({ q, deviceType, excludeIds, now });
  return Wallpaper.find(filter, { _searchScore: { $meta: 'textScore' } })
    .sort({ _searchScore: { $meta: 'textScore' }, views: -1, downloadsCount: -1, _id: 1 })
    .limit(limit)
    .populate('category', 'name slug')
    .lean();
}

module.exports = { buildAtlasPipeline, buildTextFallbackQuery, fetchSearchBatch, PRIMARY };
