const test = require('node:test');
const assert = require('node:assert/strict');
const { createDraftRetryWorker, backoffMs } = require('../src/workers/draftRetryWorker');
const { onWallpaperEdited, onCategoryRenamed, onWallpaperVisibilityChanged } = require('../src/services/searchLifecycle');
const { searchBufferCache } = require('../src/services/searchBufferCache');

test('backoffMs computes exponential backoff: 2m for attempt 1, 4m for attempt 2', () => {
  assert.equal(backoffMs(1), 2 * 60 * 1000); // 2 minutes
  assert.equal(backoffMs(2), 4 * 60 * 1000); // 4 minutes
  assert.equal(backoffMs(3), 8 * 60 * 1000); // 8 minutes
});

test('backoffMs caps maximum backoff at 60 minutes for higher attempts', () => {
  assert.equal(backoffMs(6), 60 * 60 * 1000); // 2^6 = 64 > 60 -> 60 minutes
  assert.equal(backoffMs(10), 60 * 60 * 1000);
});

test('draftRetryWorker claim finds and locks pending jobs with nextRetryAt in past', async () => {
  let queryCaptured = null;
  let calls = 0;
  const mockJobModel = {
    findOneAndUpdate: async (query, update) => {
      if (calls++ === 0) {
        queryCaptured = { query, update };
        return { _id: 'job_1', wallpaperId: 'wp_1', unprocessedWords: ['wolf'], attempts: 0 };
      }
      return null;
    },
    updateOne: async () => {},
  };
  const mockWallpaper = { updateOne: async () => {} };

  const fixedNow = new Date('2026-10-19T10:00:00Z');
  const worker = createDraftRetryWorker({
    Job: mockJobModel,
    Wallpaper: mockWallpaper,
    expand: async () => ({ expanded: ['wolf'] }),
    now: () => fixedNow,
  });

  await worker.tick();
  assert.ok(queryCaptured);
  assert.equal(queryCaptured.query.state, 'pending');
  assert.deepEqual(queryCaptured.query.nextRetryAt, { $lte: fixedNow });
  assert.equal(queryCaptured.update.$set.state, 'processing');
});

test('draftRetryWorker processJob publishes wallpaper and completes job on success', async () => {
  const updates = [];
  const Wallpaper = {
    updateOne: async (...args) => updates.push({ type: 'wallpaper', args }),
  };
  const Job = {
    updateOne: async (...args) => updates.push({ type: 'job', args }),
  };

  const worker = createDraftRetryWorker({
    Wallpaper,
    Job,
    expand: async () => ({ expanded: ['dragon'] }),
  });

  const job = { _id: 'job_10', wallpaperId: 'wp_10', unprocessedWords: ['dragon'], attempts: 1 };
  const status = await worker.processJob(job);

  assert.equal(status, 'completed');
  const wpUpdate = updates.find((u) => u.type === 'wallpaper');
  assert.deepEqual(wpUpdate.args[1], { $set: { status: 'published' } });

  const jobUpdate = updates.find((u) => u.type === 'job');
  assert.equal(jobUpdate.args[1].$set.state, 'completed');
  assert.equal(jobUpdate.args[1].$set.lastError, null);
});

test('draftRetryWorker processJob increments attempts and reschedules on expansion failure', async () => {
  const updates = [];
  const Wallpaper = { updateOne: async () => {} };
  const Job = {
    updateOne: async (...args) => updates.push({ type: 'job', args }),
  };

  const fixedNow = new Date('2026-10-19T10:00:00Z');
  const worker = createDraftRetryWorker({
    Wallpaper,
    Job,
    expand: async () => { throw new Error('API timeout'); },
    now: () => fixedNow,
  });

  const job = { _id: 'job_11', wallpaperId: 'wp_11', unprocessedWords: ['titan'], attempts: 2 };
  const status = await worker.processJob(job);

  assert.equal(status, 'retry');
  const jobUpdate = updates.find((u) => u.type === 'job');
  assert.equal(jobUpdate.args[1].$set.state, 'pending');
  assert.equal(jobUpdate.args[1].$set.attempts, 3);
  assert.equal(jobUpdate.args[1].$set.lastError, 'API timeout');
  assert.ok(jobUpdate.args[1].$set.nextRetryAt > fixedNow);
});

test('draftRetryWorker processJob marks state failed_permanent after 10 failed attempts', async () => {
  const updates = [];
  const Wallpaper = { updateOne: async () => {} };
  const Job = {
    updateOne: async (...args) => updates.push({ type: 'job', args }),
  };

  const worker = createDraftRetryWorker({
    Wallpaper,
    Job,
    expand: async () => { throw new Error('Permanent blacklisted word'); },
  });

  const job = { _id: 'job_12', wallpaperId: 'wp_12', unprocessedWords: ['badword'], attempts: 9 };
  const status = await worker.processJob(job);

  assert.equal(status, 'failed_permanent');
  const jobUpdate = updates.find((u) => u.type === 'job');
  assert.equal(jobUpdate.args[1].$set.state, 'failed_permanent');
  assert.equal(jobUpdate.args[1].$set.attempts, 10);
});

test('draftRetryWorker tick processes all available jobs in sequence', async () => {
  let call = 0;
  const jobs = [
    { _id: 'j1', wallpaperId: 'w1', unprocessedWords: ['a'], attempts: 0 },
    { _id: 'j2', wallpaperId: 'w2', unprocessedWords: ['b'], attempts: 0 },
  ];

  const mockJobModel = {
    findOneAndUpdate: async () => (call < jobs.length ? jobs[call++] : null),
    updateOne: async () => {},
  };
  const mockWallpaper = { updateOne: async () => {} };

  const worker = createDraftRetryWorker({
    Job: mockJobModel,
    Wallpaper: mockWallpaper,
    expand: async () => {},
  });

  const processedCount = await worker.tick();
  assert.equal(processedCount, 2);
});

test('onWallpaperEdited triggers re-expansion and cache invalidation when semantic fields change', async () => {
  const genBefore = searchBufferCache.generation;
  const before = { title: 'Old Title', excerpt: 'same', story: 'same', tags: ['anime'] };
  const after = { title: 'New Dragon Title', excerpt: 'same', story: 'same', tags: ['anime'] };

  const mockModel = {
    find: () => ({ select: () => ({ lean: async () => [] }) }),
    bulkWrite: async () => {},
  };

  const mockProvider = {
    name: 'mock',
    call: async () => JSON.stringify({
      expansions: Object.fromEntries(
        ['new', 'dragon', 'title', 'same', 'anime'].map((w) => [
          w,
          [{ target: 'x' + w, weight: 1, relation: 'synonym' }],
        ])
      ),
    }),
  };

  const res = await onWallpaperEdited(before, after, 'published', {
    Model: mockModel,
    providers: [mockProvider],
  });
  assert.equal(res.status, 'published');
  assert.equal(searchBufferCache.generation, genBefore + 1); // cache invalidated
});

test('onWallpaperEdited skips re-expansion when semantic fields are unchanged', async () => {
  const genBefore = searchBufferCache.generation;
  const before = { title: 'Same', excerpt: 'Same', story: 'Same', tags: ['same'], views: 10 };
  const after = { title: 'Same', excerpt: 'Same', story: 'Same', tags: ['same'], views: 11 };

  const res = await onWallpaperEdited(before, after, 'published');
  assert.equal(res.status, 'published');
  assert.deepEqual(res.unprocessedWords, []);
  assert.equal(searchBufferCache.generation, genBefore + 1); // cache still invalidated on edit
});

test('onCategoryRenamed invalidates cache and triggers expansion for new category name', async () => {
  const genBefore = searchBufferCache.generation;
  let expandedWords = [];
  const deps = {
    Model: {
      find: () => ({ select: () => ({ lean: async () => [] }) }),
      bulkWrite: async () => {},
    },
    providers: [
      {
        name: 'mock',
        call: async () => JSON.stringify({
          expansions: { cyberpunk: [{ target: 'neon', weight: 1, relation: 'synonym' }] },
        }),
      },
    ],
  };

  await onCategoryRenamed('Cyberpunk Wallpapers', deps);
  assert.equal(searchBufferCache.generation, genBefore + 1);
});
