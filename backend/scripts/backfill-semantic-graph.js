/**
 * Backfill the semantic graph for the existing catalog.
 * Read-only on wallpapers (no detail endpoints, so views never increment).
 * Throttled: 10 words every 4 seconds. Safe to re-run (global dedupe).
 * Usage: MONGODB_URI=... GEMINI_API_KEY=... node scripts/backfill-semantic-graph.js
 */
const mongoose = require('mongoose');
const SemanticNode = require('../src/models/SemanticNode');
const { extractCleanWords } = require('../src/services/textNlp');
const { findUnseenWords, expandWords } = require('../src/services/aiGraphService');

const BATCH_WORDS = 10;
const DELAY_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function backfill({ Wallpaper, Model = SemanticNode, expand = expandWords, delayMs = DELAY_MS, log = console.log } = {}) {
  const docs = await Wallpaper.find({ deletionPending: { $ne: true } })
    .select('title excerpt story tags').lean();
  const all = new Set();
  for (const d of docs) extractCleanWords(d).forEach((w) => all.add(w));
  const unseen = await findUnseenWords(Array.from(all), Model);
  log(`wallpapers=${docs.length} uniqueWords=${all.size} toExpand=${unseen.length}`);

  let done = 0;
  const failed = [];
  for (let i = 0; i < unseen.length; i += BATCH_WORDS) {
    const batch = unseen.slice(i, i + BATCH_WORDS);
    try {
      await expand(batch);
      done += batch.length;
    } catch (err) {
      failed.push(...batch);
      log(`batch failed (${err.message})`);
    }
    log(`progress ${Math.min(i + BATCH_WORDS, unseen.length)}/${unseen.length}`);
    if (i + BATCH_WORDS < unseen.length) await sleep(delayMs);
  }
  return { done, failed };
}

module.exports = { backfill };

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const Wallpaper = mongoose.model('Wallpaper');
    const res = await backfill({ Wallpaper });
    console.log(res);
    await mongoose.disconnect();
  })().catch((e) => { console.error(e); process.exit(1); });
}
