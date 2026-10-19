const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPrompt,
  sanitizeExpansions,
  callLlmWithFallback,
  findUnseenWords,
  processWallpaperSemanticsOnUpload,
} = require('../src/services/aiGraphService');

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
