const test = require('node:test');
const assert = require('node:assert/strict');
const {
  singularize,
  normalizeToken,
  extractCleanWords,
  STOPWORDS,
  DOMAIN_STOPWORDS,
} = require('../src/services/textNlp');

test('singularize handles regular plurals by removing trailing s', () => {
  assert.equal(singularize('clouds'), 'cloud');
  assert.equal(singularize('wolves'), 'wolf');
  assert.equal(singularize('dragons'), 'dragon');
});

test('singularize handles words ending in -ies', () => {
  assert.equal(singularize('berries'), 'berry');
  assert.equal(singularize('categories'), 'category');
  assert.equal(singularize('fairies'), 'fairy');
  // short words <= 4 chars like 'ties' should not be mangled to 'ty'
  assert.equal(singularize('ties'), 'tie');
});

test('singularize preserves words ending in -ss, -us, -is, -ous without mangling', () => {
  assert.equal(singularize('dress'), 'dress');
  assert.equal(singularize('virus'), 'virus');
  assert.equal(singularize('basis'), 'basis');
  assert.equal(singularize('continuous'), 'continuous');
});

test('singularize handles suffixes -ches, -shes, -xes', () => {
  assert.equal(singularize('watches'), 'watch');
  assert.equal(singularize('dishes'), 'dish');
  assert.equal(singularize('boxes'), 'box');
  assert.equal(singularize('foxes'), 'fox');
});

test('singularize leaves short words (< 3 chars) and words with digits unchanged', () => {
  assert.equal(singularize('as'), 'as');
  assert.equal(singularize('4k'), '4k');
  assert.equal(singularize('1080p'), '1080p');
  assert.equal(singularize(''), '');
});

test('normalizeToken converts to lowercase, strips non-alphanumeric but preserves internal hyphens', () => {
  assert.equal(normalizeToken('Dark-Wolf!'), 'dark-wolf');
  assert.equal(normalizeToken('  #Anime_Art  '), 'animeart');
  assert.equal(normalizeToken('4K-HD'), '4k-hd');
});

test('normalizeToken handles mixed symbols, accents and emojis cleanly', () => {
  assert.equal(normalizeToken('cyberpunk@2077'), 'cyberpunk2077');
  assert.equal(normalizeToken('🐉Dragon🔥'), 'dragon');
  assert.equal(normalizeToken('***'), '');
});

test('extractCleanWords extracts nouns, proper nouns, and adjectives from title and excerpt', () => {
  const words = extractCleanWords({
    title: 'Dark Clouds over Ancient Castle',
    excerpt: 'A majestic dragon rests in the eerie shadows.',
  });
  assert.ok(words.includes('cloud'));
  assert.ok(words.includes('castle'));
  assert.ok(words.includes('dragon'));
  assert.ok(words.includes('shadow'));
});

test('extractCleanWords strips general stopwords', () => {
  const words = extractCleanWords({
    title: 'The wolf in the forest with his prey under that moonlight',
  });
  assert.ok(!words.includes('the'));
  assert.ok(!words.includes('in'));
  assert.ok(!words.includes('with'));
  assert.ok(!words.includes('his'));
  assert.ok(!words.includes('under'));
  assert.ok(!words.includes('that'));
  assert.ok(words.includes('wolf'));
});

test('extractCleanWords handles explicit tags, splits multi-word tags and dedupes', () => {
  const words = extractCleanWords({
    title: 'Dark Wolf',
    tags: ['dark fantasy', 'Wolf', 'FENRIR', 'dark wolf'],
  });
  assert.equal(new Set(words).size, words.length);
  assert.ok(words.includes('fantasy'));
  assert.ok(words.includes('fenrir'));
  assert.ok(words.includes('wolf'));
  assert.ok(words.includes('dark'));
});

test('extractCleanWords ignores pure digit tokens and single-character tokens', () => {
  const words = extractCleanWords({
    title: 'Cyberpunk 2077 Scene 4',
    tags: ['a', 'x', '12345'],
  });
  assert.ok(!words.includes('2077'));
  assert.ok(!words.includes('4'));
  assert.ok(!words.includes('12345'));
  assert.ok(!words.includes('a'));
  assert.ok(!words.includes('x'));
});

test('extractCleanWords returns empty array when given empty or missing inputs', () => {
  assert.deepEqual(extractCleanWords({}), []);
  assert.deepEqual(extractCleanWords(), []);
  assert.deepEqual(extractCleanWords({ title: '', tags: [] }), []);
});
