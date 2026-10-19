const test = require('node:test');
const assert = require('node:assert/strict');
const { publicVisibilityFilter } = require('../src/utils/visibilityFilter');

test('publicVisibilityFilter enforces status $ne draft', () => {
  const filter = publicVisibilityFilter();
  assert.deepEqual(filter.status, { $ne: 'draft' });
});

test('publicVisibilityFilter enforces deletionPending $ne true', () => {
  const filter = publicVisibilityFilter();
  assert.deepEqual(filter.deletionPending, { $ne: true });
});

test('publicVisibilityFilter allows documents with publishAt null', () => {
  const filter = publicVisibilityFilter();
  assert.ok(Array.isArray(filter.$or));
  assert.deepEqual(filter.$or[0], { publishAt: null });
});

test('publicVisibilityFilter allows documents with publishAt in past or present', () => {
  const refDate = new Date('2026-01-01T00:00:00Z');
  const filter = publicVisibilityFilter(refDate);
  assert.deepEqual(filter.$or[1], { publishAt: { $lte: refDate } });
});

test('publicVisibilityFilter accepts custom reference date', () => {
  const custom = new Date('2026-10-19T12:00:00Z');
  const filter = publicVisibilityFilter(custom);
  assert.equal(filter.$or[1].publishAt.$lte.getTime(), custom.getTime());
});
