const test = require('node:test');
const assert = require('node:assert/strict');
const { callLlmWithFallback, processWallpaperSemanticsOnUpload, sanitizeExpansions } = require('../src/services/aiGraphService');
const { createDraftRetryWorker, backoffMs } = require('../src/workers/draftRetryWorker');

const good = (words) => JSON.stringify({
  expansions: Object.fromEntries(words.map((w) => [w, [{ target: 'x' + w, weight: 1, relation: 'synonym' }]])),
});

test('fallback chain moves to next provider on failure', async () => {
  const providers = [
    { name: 'a', call: async () => { throw new Error('429'); } },
    { name: 'b', call: async () => good(['dog']) },
  ];
  const out = await callLlmWithFallback(['dog'], providers);
  assert.equal(out.dog[0].target, 'xdog');
});

test('all providers failing throws', async () => {
  await assert.rejects(callLlmWithFallback(['dog'], [{ name: 'a', call: async () => { throw new Error('boom'); } }]));
});

test('sanitize rejects bad weights/self loops and caps at 20', () => {
  const edges = Array.from({ length: 30 }, (_, i) => ({ target: 't' + i, weight: 3 }));
  edges.push({ target: 'dog', weight: 1 }, { target: 'bad', weight: 9 });
  const out = sanitizeExpansions({ expansions: { dog: edges } }, ['dog']);
  assert.equal(out.dog.length, 20);
  assert.ok(!out.dog.some((e) => e.target === 'dog' || e.target === 'bad'));
});

test('upload: AI failure yields draft + unprocessed words; zero unseen yields requested status', async () => {
  const Model = {
    find: () => ({ select: () => ({ lean: async () => [] }) }),
    bulkWrite: async () => {},
  };
  const failing = await processWallpaperSemanticsOnUpload(
    { title: 'Dark wolf' }, 'published',
    { Model, providers: [{ name: 'a', call: async () => { throw new Error('down'); } }] }
  );
  assert.equal(failing.status, 'draft');
  assert.ok(failing.unprocessedWords.includes('wolf'));

  const seen = { find: () => ({ select: () => ({ lean: async () => [{ word: 'wolf' }, { word: 'dark' }] }) }), bulkWrite: async () => {} };
  const ok = await processWallpaperSemanticsOnUpload({ title: 'Dark wolf' }, 'published', { Model: seen, providers: [] });
  assert.equal(ok.status, 'published');
});

test('worker publishes draft on success and backs off on failure', async () => {
  const updates = [];
  const job = { _id: 'j', wallpaperId: 'w', unprocessedWords: ['wolf'], attempts: 0 };
  const Wallpaper = { updateOne: async (...a) => updates.push(['wp', ...a]) };
  const Job = { updateOne: async (...a) => updates.push(['job', ...a]) };
  const okW = createDraftRetryWorker({ Wallpaper, Job, expand: async () => {} });
  assert.equal(await okW.processJob(job), 'completed');
  assert.equal(updates[0][2].$set.status, 'published');

  const badW = createDraftRetryWorker({ Wallpaper, Job, expand: async () => { throw new Error('x'); } });
  assert.equal(await badW.processJob(job), 'retry');
  assert.equal(backoffMs(1), 2 * 60000);
  assert.equal(backoffMs(10), 60 * 60000);
});
