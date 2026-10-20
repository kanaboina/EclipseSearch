const test = require('node:test');
const assert = require('node:assert/strict');
const { createSingleflight } = require('../src/services/singleflight');

test('singleflight propagates errors to all waiters', async () => {
  const sf = createSingleflight();
  const fn = async () => { throw new Error('boom'); };
  const results = await Promise.allSettled([sf.run('k', fn), sf.run('k', fn), sf.run('k', fn)]);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason.message, 'boom');
  }
  assert.equal(sf.pending, 0); // cleaned up after error
});

test('singleflight runs independent keys in parallel', async () => {
  const sf = createSingleflight();
  let aCalls = 0, bCalls = 0;
  const fnA = async () => { aCalls++; return 'a'; };
  const fnB = async () => { bCalls++; return 'b'; };
  const [ra, rb] = await Promise.all([sf.run('a', fnA), sf.run('b', fnB)]);
  assert.equal(ra, 'a');
  assert.equal(rb, 'b');
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 1);
});

test('singleflight allows re-use of key after completion', async () => {
  const sf = createSingleflight();
  let calls = 0;
  const fn = async () => ++calls;
  const r1 = await sf.run('k', fn);
  assert.equal(r1, 1);
  assert.equal(sf.pending, 0);
  const r2 = await sf.run('k', fn);
  assert.equal(r2, 2);
  assert.equal(calls, 2);
});

test('singleflight pending count reflects in-flight keys', async () => {
  const sf = createSingleflight();
  let resolve1, resolve2;
  const p1 = new Promise((r) => { resolve1 = r; });
  const p2 = new Promise((r) => { resolve2 = r; });
  const r1 = sf.run('a', () => p1);
  const r2 = sf.run('b', () => p2);
  assert.equal(sf.pending, 2);
  resolve1('x');
  resolve2('y');
  await Promise.all([r1, r2]);
  assert.equal(sf.pending, 0);
});

test('singleflight synchronous function values are coalesced', async () => {
  const sf = createSingleflight();
  let calls = 0;
  // Sync function wrapped in Promise.resolve
  const fn = () => { calls++; return 42; };
  const [a, b, c] = await Promise.all([sf.run('k', fn), sf.run('k', fn), sf.run('k', fn)]);
  assert.equal(a, 42);
  assert.equal(b, 42);
  assert.equal(c, 42);
  assert.equal(calls, 1);
});
