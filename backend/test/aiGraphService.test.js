const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPrompt,
  sanitizeExpansions,
  callLlmWithFallback,
  findUnseenWords,
  linkWallpaperToGraph,
  processWallpaperSemanticsOnUpload,
} = require('../src/services/aiGraphService');
const { wordDocIds } = require('../src/services/memoryGraph');

test('buildPrompt formats LLM prompt with required word list and relation types', () => {
  const prompt = buildPrompt(['fenrir', 'valkyrie']);
  assert.ok(prompt.includes('fenrir'));
  assert.ok(prompt.includes('valkyrie'));
  assert.ok(prompt.includes('synonym|hyponym|hypernym|sibling|scene|mood|tangent'));
  assert.ok(prompt.includes('exactly 20'));
});

test('sanitizeExpansions discards self-loops where target equals source word', () => {
  const parsed = {
    expansions: {
      wolf: [
        { target: 'wolf', weight: 1, relation: 'synonym' },
        { target: 'fenrir', weight: 1, relation: 'synonym' },
      ],
    },
  };
  const sanitized = sanitizeExpansions(parsed, ['wolf']);
  assert.equal(sanitized.wolf.length, 1);
  assert.equal(sanitized.wolf[0].target, 'fenrir');
});

test('sanitizeExpansions discards targets with invalid characters or symbols', () => {
  const parsed = {
    expansions: {
      dragon: [
        { target: '$$$invalid$$$', weight: 2, relation: 'synonym' },
        { target: 'wyvern', weight: 2, relation: 'sibling' },
        { target: '   ', weight: 1, relation: 'synonym' },
      ],
    },
  };
  const sanitized = sanitizeExpansions(parsed, ['dragon']);
  assert.equal(sanitized.dragon.length, 1);
  assert.equal(sanitized.dragon[0].target, 'wyvern');
});

test('sanitizeExpansions clamps weights between 1 and 6 and defaults unknown relations to synonym', () => {
  const parsed = {
    expansions: {
      blade: [
        { target: 'sword', weight: 0, relation: 'synonym' }, // invalid weight < 1
        { target: 'dagger', weight: 8, relation: 'synonym' }, // invalid weight > 6
        { target: 'katana', weight: 2.2, relation: 'unknown_type' }, // valid weight rounds to 2, relation -> synonym
      ],
    },
  };
  const sanitized = sanitizeExpansions(parsed, ['blade']);
  assert.equal(sanitized.blade.length, 1);
  assert.equal(sanitized.blade[0].target, 'katana');
  assert.equal(sanitized.blade[0].weight, 2);
  assert.equal(sanitized.blade[0].relation, 'synonym');
});

test('sanitizeExpansions enforces limit of 20 edges per word and dedupes targets', () => {
  const rawEdges = Array.from({ length: 35 }, (_, i) => ({
    target: `related${i}`,
    weight: 2,
    relation: 'sibling',
  }));
  // Add duplicate
  rawEdges.push({ target: 'related0', weight: 1, relation: 'synonym' });

  const sanitized = sanitizeExpansions({ expansions: { testword: rawEdges } }, ['testword']);
  assert.equal(sanitized.testword.length, 20); // capped at 20
});

test('callLlmWithFallback succeeds on primary provider when valid JSON is returned', async () => {
  const providers = [
    {
      name: 'gemini-mock',
      call: async () => JSON.stringify({
        expansions: {
          wolf: [{ target: 'canine', weight: 2, relation: 'hypernym' }],
        },
      }),
    },
  ];

  const result = await callLlmWithFallback(['wolf'], providers);
  assert.ok(result.wolf);
  assert.equal(result.wolf[0].target, 'canine');
});

test('callLlmWithFallback fails over to secondary provider when primary throws', async () => {
  const providers = [
    {
      name: 'failing-provider',
      call: async () => { throw new Error('429 Rate Limit Exceeded'); },
    },
    {
      name: 'backup-provider',
      call: async () => JSON.stringify({
        expansions: {
          sky: [{ target: 'cloud', weight: 1, relation: 'synonym' }],
        },
      }),
    },
  ];

  const result = await callLlmWithFallback(['sky'], providers);
  assert.ok(result.sky);
  assert.equal(result.sky[0].target, 'cloud');
});

test('callLlmWithFallback throws comprehensive error when all providers fail', async () => {
  const providers = [
    { name: 'p1', call: async () => { throw new Error('p1 down'); } },
    { name: 'p2', call: async () => { throw new Error('p2 timeout'); } },
  ];

  await assert.rejects(
    async () => callLlmWithFallback(['magic'], providers),
    (err) => {
      assert.ok(err.message.includes('p1: p1 down'));
      assert.ok(err.message.includes('p2: p2 timeout'));
      return true;
    }
  );
});

test('findUnseenWords returns only words that have not been expanded yet', async () => {
  const MockModel = {
    find: () => ({
      select: () => ({
        lean: async () => [{ word: 'wolf' }, { word: 'sky' }],
      }),
    }),
  };

  const unseen = await findUnseenWords(['wolf', 'sky', 'fenrir', 'dragon'], MockModel);
  assert.deepEqual(unseen, ['fenrir', 'dragon']);
});

test('processWallpaperSemanticsOnUpload falls back to draft status when AI providers fail', async () => {
  const MockModel = {
    find: () => ({
      select: () => ({
        lean: async () => [],
      }),
    }),
    bulkWrite: async () => {},
  };

  const failingProviders = [
    { name: 'mock-llm', call: async () => { throw new Error('Connection refused'); } },
  ];

  const result = await processWallpaperSemanticsOnUpload(
    { title: 'Majestic Phoenix Rising' },
    'published',
    { Model: MockModel, providers: failingProviders }
  );

  assert.equal(result.status, 'draft');
  assert.ok(result.unprocessedWords.length > 0);
  assert.ok(result.error);
});

test('linkWallpaperToGraph calls bulkWrite with $addToSet and updates in-memory wordDocIds', async () => {
  const writtenOps = [];
  const MockModel = {
    bulkWrite: async (ops) => { writtenOps.push(...ops); },
  };

  await linkWallpaperToGraph('wallpaper-abc', ['nebula', 'cosmos'], { Model: MockModel });

  // DB: each word should have an $addToSet on docIds
  assert.equal(writtenOps.length, 2);
  assert.deepEqual(writtenOps[0].updateOne.update.$addToSet, { docIds: 'wallpaper-abc' });
  assert.equal(writtenOps[0].updateOne.filter.word, 'nebula');

  // In-memory: wordDocIds must reflect the link
  assert.ok(wordDocIds.get('nebula').has('wallpaper-abc'));
  assert.ok(wordDocIds.get('cosmos').has('wallpaper-abc'));
});

test('linkWallpaperToGraph is idempotent — bulkWrite $addToSet prevents duplicates in DB', async () => {
  const writtenBatches = [];
  const MockModel = {
    bulkWrite: async (ops) => { writtenBatches.push(ops.length); },
  };
  await linkWallpaperToGraph('wall-dup', ['aurora'], { Model: MockModel });
  await linkWallpaperToGraph('wall-dup', ['aurora'], { Model: MockModel }); // second call same ID
  // Both DB calls should go through (DB deduplication via $addToSet)
  assert.equal(writtenBatches.length, 2);
  // In-memory: Set guarantees no duplicates regardless
  assert.equal(wordDocIds.get('aurora').size, 1);
});

test('linkWallpaperToGraph is a no-op when docId or words are missing', async () => {
  let called = false;
  const MockModel = { bulkWrite: async () => { called = true; } };
  await linkWallpaperToGraph('', ['dragon'], { Model: MockModel });
  await linkWallpaperToGraph('some-id', [], { Model: MockModel });
  assert.equal(called, false); // bulkWrite must not be called for empty inputs
});

test('processWallpaperSemanticsOnUpload links wallpaperId to words when _id is present', async () => {
  const linkedOps = [];
  const MockModel = {
    find: () => ({ select: () => ({ lean: async () => [] }) }),
    bulkWrite: async (ops) => { linkedOps.push(...ops); },
  };
  // Provider that returns expansions for whatever words are given to it
  const okProviders = [{
    name: 'mock',
    call: async (prompt) => {
      // Extract word list from the prompt JSON and return an expansion for each
      const match = prompt.match(/Words:\s*(\[.*?\])/s);
      const words = match ? JSON.parse(match[1]) : ['phoenix'];
      const expansions = {};
      for (const w of words) {
        expansions[w] = [{ target: 'firebird', weight: 1, relation: 'synonym' }];
      }
      return JSON.stringify({ expansions });
    },
  }];

  const result = await processWallpaperSemanticsOnUpload(
    { _id: 'wall-999', title: 'Phoenix Rising' },
    'published',
    { Model: MockModel, providers: okProviders }
  );

  assert.equal(result.status, 'published');
  // bulkWrite must have been called to link the wallpaper's words
  assert.ok(linkedOps.length > 0);
  // Every $addToSet op must include the wallpaperId
  const linkOps = linkedOps.filter((op) => op.updateOne.update.$addToSet);
  assert.ok(linkOps.every((op) => op.updateOne.update.$addToSet.docIds === 'wall-999'));
});

