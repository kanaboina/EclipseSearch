const test = require('node:test');
const assert = require('node:assert/strict');
const { wallpaperCardDTO } = require('../src/utils/wallpaperDTO');

test('wallpaperCardDTO strictly strips story, downloadKeys, and downloadBucket', () => {
  const raw = {
    _id: '123',
    title: 'Secret Dragon',
    previewUrl: 'https://cdn.example.com/p.jpg',
    story: 'Top secret proprietary lore',
    downloadKeys: { '4k': 'secret-key-1' },
    downloadBucket: 's3-private-bucket',
  };
  const card = wallpaperCardDTO(raw);
  assert.equal('story' in card, false);
  assert.equal('downloadKeys' in card, false);
  assert.equal('downloadBucket' in card, false);
});

test('wallpaperCardDTO strictly strips uuid, downloads, and conversionJournal', () => {
  const raw = {
    _id: '456',
    title: 'Neon Wolf',
    previewUrl: 'https://cdn.example.com/p.jpg',
    uuid: 'a891-b421-c111',
    downloads: { count: 9999, '4k': 'secret' },
    conversionJournal: { attempts: 3, rawFormat: 'tiff' },
  };
  const card = wallpaperCardDTO(raw);
  assert.equal('uuid' in card, false);
  assert.equal('downloads' in card, false);
  assert.equal('conversionJournal' in card, false);
});

test('wallpaperCardDTO casts _id to string', () => {
  const card = wallpaperCardDTO({ _id: 123456, title: 'Title', previewUrl: 'p' });
  assert.strictEqual(card._id, '123456');
});

test('wallpaperCardDTO maps category object to _id, name, and slug', () => {
  const raw = {
    _id: '789',
    title: 'Fantasy Art',
    previewUrl: 'p',
    category: { _id: 'cat1', name: 'Fantasy', slug: 'fantasy', internalNotes: 'do not leak' },
  };
  const card = wallpaperCardDTO(raw);
  assert.deepEqual(card.category, { _id: 'cat1', name: 'Fantasy', slug: 'fantasy' });
  assert.equal('internalNotes' in card.category, false);
});

test('wallpaperCardDTO sets category to null when category is missing or invalid', () => {
  assert.equal(wallpaperCardDTO({ _id: '1', title: 'A', previewUrl: 'p' }).category, null);
  assert.equal(wallpaperCardDTO({ _id: '2', title: 'B', previewUrl: 'p', category: null }).category, null);
  assert.equal(wallpaperCardDTO({ _id: '3', title: 'C', previewUrl: 'p', category: 'not-an-object' }).category, null);
  assert.equal(wallpaperCardDTO({ _id: '4', title: 'D', previewUrl: 'p', category: {} }).category, null);
});

test('wallpaperCardDTO falls back thumbnailUrl, modalUrl, heroUrl to previewUrl', () => {
  const card = wallpaperCardDTO({
    _id: '1',
    title: 'Dragon Flame',
    previewUrl: 'https://cdn.example.com/main.webp',
  });
  assert.equal(card.thumbnailUrl, 'https://cdn.example.com/main.webp');
  assert.equal(card.modalUrl, 'https://cdn.example.com/main.webp');
  assert.equal(card.heroUrl, 'https://cdn.example.com/main.webp');
  assert.equal(card.mobileCardUrl, null);
});

test('wallpaperCardDTO defaults tags and colors to empty arrays when omitted', () => {
  const card = wallpaperCardDTO({ _id: '1', title: 'Minimal', previewUrl: 'p' });
  assert.deepEqual(card.tags, []);
  assert.deepEqual(card.colors, []);
  assert.equal(card.excerpt, '');
});

test('wallpaperCardDTO preserves featured, premium, views, width, height, and createdAt', () => {
  const now = new Date();
  const card = wallpaperCardDTO({
    _id: '1',
    title: 'Cyber City',
    previewUrl: 'p',
    featured: true,
    premium: false,
    views: 420,
    width: 3840,
    height: 2160,
    createdAt: now,
  });
  assert.equal(card.featured, true);
  assert.equal(card.premium, false);
  assert.equal(card.views, 420);
  assert.equal(card.width, 3840);
  assert.equal(card.height, 2160);
  assert.equal(card.createdAt, now);
});
