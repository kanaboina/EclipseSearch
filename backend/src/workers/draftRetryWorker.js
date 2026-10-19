const AiIngestionJob = require('../models/AiIngestionJob');
const { expandWords } = require('../services/aiGraphService');
const { invalidateSearchCache } = require('../services/searchBufferCache');

const POLL_MS = 60 * 1000;
const MAX_ATTEMPTS = 10;
const backoffMs = (attempts) => Math.min(60, 2 ** attempts) * 60 * 1000;

/**
 * Background worker: restores AI-queued drafts once expansion succeeds.
 * deps: { Wallpaper, Job, expand, revalidate }
 * Note: wallpaper.status enum is draft|published; 'scheduled' is published with a
 * future publishAt, so desiredStatus 'scheduled' also maps to 'published'.
 */
function createDraftRetryWorker({ Wallpaper, Job = AiIngestionJob, expand = expandWords, revalidate = async () => {}, now = () => new Date() } = {}) {
  let timer = null;
  let running = false;

  async function claim() {
    return Job.findOneAndUpdate(
      { state: 'pending', nextRetryAt: { $lte: now() } },
      { $set: { state: 'processing' } },
      { sort: { nextRetryAt: 1 }, new: true }
    );
  }

  async function processJob(job) {
    try {
      await expand(job.unprocessedWords);
      await Wallpaper.updateOne({ _id: job.wallpaperId, status: 'draft' }, { $set: { status: 'published' } });
      await Job.updateOne({ _id: job._id }, { $set: { state: 'completed', lastError: null } });
      invalidateSearchCache();
      try { await revalidate(job.wallpaperId); } catch (_) { /* best effort */ }
      return 'completed';
    } catch (err) {
      const attempts = job.attempts + 1;
      const permanent = attempts >= MAX_ATTEMPTS;
      await Job.updateOne(
        { _id: job._id },
        {
          $set: {
            state: permanent ? 'failed_permanent' : 'pending',
            attempts,
            lastError: err.message,
            nextRetryAt: new Date(now().getTime() + backoffMs(attempts)),
          },
        }
      );
      return permanent ? 'failed_permanent' : 'retry';
    }
  }

  async function tick() {
    if (running) return 0;
    running = true;
    let n = 0;
    try {
      for (let job = await claim(); job; job = await claim()) {
        await processJob(job);
        n++;
      }
    } finally {
      running = false;
    }
    return n;
  }

  return {
    tick,
    processJob,
    start() { if (!timer) { timer = setInterval(() => tick().catch(() => {}), POLL_MS); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createDraftRetryWorker, backoffMs };
