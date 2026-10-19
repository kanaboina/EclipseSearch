/**
 * Canonical public visibility rule shared by ALL search and catalog paths
 * (Atlas Search, $text fallback, counts).
 */
function publicVisibilityFilter(now = new Date()) {
  return {
    status: { $ne: 'draft' },
    deletionPending: { $ne: true },
    $or: [{ publishAt: null }, { publishAt: { $lte: now } }],
  };
}

module.exports = { publicVisibilityFilter };
