const { extractCleanWords } = require('./textNlp');
const { expandWords, processWallpaperSemanticsOnUpload } = require('./aiGraphService');
const { invalidateSearchCache } = require('./searchBufferCache');
const SemanticNode = require('../models/SemanticNode');
const { unlinkDocFromWords } = require('./memoryGraph');

const SEMANTIC_FIELDS = ['title', 'excerpt', 'story', 'tags'];

/** Edit hook: if any semantic field changed, expand new words; always flush cache. */
async function onWallpaperEdited(before, after, requestedStatus, deps) {
  // Hooks may receive a patch rather than a complete document.
  const payload = { ...before, ...after, _id: after?._id ?? before?._id };
  const changed = SEMANTIC_FIELDS.some((f) => JSON.stringify(before?.[f]) !== JSON.stringify(payload[f]));
  let result = { status: requestedStatus, unprocessedWords: [] };
  try {
    if (changed) {
      const oldWords = new Set(extractCleanWords(before));
      const newWords = new Set(extractCleanWords(payload));
      const removedWords = Array.from(oldWords).filter((w) => !newWords.has(w));
      const docId = payload._id ? String(payload._id) : null;
      if (docId && removedWords.length) {
        const Model = deps?.Model || SemanticNode;
        await Model.updateMany(
          { word: { $in: removedWords } },
          { $pull: { docIds: docId } }
        );
        unlinkDocFromWords(removedWords, docId);
      }
      result = await processWallpaperSemanticsOnUpload(payload, requestedStatus, deps);
    }
    return result;
  } finally {
    invalidateSearchCache();
  }
}

/** Category rename hook (call after Category.name update + categoryName updateMany). */
async function onCategoryRenamed(newName, deps) {
  invalidateSearchCache();
  try { await expandWords(extractCleanWords({ tags: [newName] }), deps); } catch (_) { /* non-fatal */ }
}

/** Call when status becomes 'draft', deletionPending is set, or a wallpaper is deleted/published. */
function onWallpaperVisibilityChanged() { invalidateSearchCache(); }

module.exports = { onWallpaperEdited, onCategoryRenamed, onWallpaperVisibilityChanged };
