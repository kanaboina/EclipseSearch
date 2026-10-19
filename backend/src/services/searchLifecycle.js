const { extractCleanWords } = require('./textNlp');
const { expandWords, processWallpaperSemanticsOnUpload } = require('./aiGraphService');
const { invalidateSearchCache } = require('./searchBufferCache');

const SEMANTIC_FIELDS = ['title', 'excerpt', 'story', 'tags'];

/** Edit hook: if any semantic field changed, expand new words; always flush cache. */
async function onWallpaperEdited(before, after, requestedStatus, deps) {
  const changed = SEMANTIC_FIELDS.some((f) => JSON.stringify(before?.[f]) !== JSON.stringify(after?.[f]));
  let result = { status: requestedStatus, unprocessedWords: [] };
  if (changed) result = await processWallpaperSemanticsOnUpload(after, requestedStatus, deps);
  invalidateSearchCache();
  return result;
}

/** Category rename hook (call after Category.name update + categoryName updateMany). */
async function onCategoryRenamed(newName, deps) {
  invalidateSearchCache();
  try { await expandWords(extractCleanWords({ tags: [newName] }), deps); } catch (_) { /* non-fatal */ }
}

/** Call when status becomes 'draft', deletionPending is set, or a wallpaper is deleted/published. */
function onWallpaperVisibilityChanged() { invalidateSearchCache(); }

module.exports = { onWallpaperEdited, onCategoryRenamed, onWallpaperVisibilityChanged };
