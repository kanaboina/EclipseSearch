const { extractCleanWords } = require('./textNlp');
const { expandWords, processWallpaperSemanticsOnUpload } = require('./aiGraphService');
const { invalidateSearchCache } = require('./searchBufferCache');
const { unlinkDocFromWords } = require('./memoryGraph');

const SEMANTIC_FIELDS = ['title', 'excerpt', 'story', 'tags'];

/** Edit hook: if any semantic field changed, expand new words; always flush cache. */
async function onWallpaperEdited(before, after, requestedStatus, deps) {
  const changed = SEMANTIC_FIELDS.some((f) => JSON.stringify(before?.[f]) !== JSON.stringify(after?.[f]));
  let result = { status: requestedStatus, unprocessedWords: [] };
  if (changed) {
    // Unlink old words that are no longer in the wallpaper
    const oldWords = new Set(extractCleanWords(before));
    const newWords = new Set(extractCleanWords(after));
    const removedWords = Array.from(oldWords).filter((w) => !newWords.has(w));
    const docId = after._id ? String(after._id) : null;
    if (docId && removedWords.length) {
      unlinkDocFromWords(removedWords, docId);
    }
    // Process new words (expand and link)
    result = await processWallpaperSemanticsOnUpload(after, requestedStatus, deps);
  }
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
