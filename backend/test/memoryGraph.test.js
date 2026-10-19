const test = require('node:test');
const assert = require('node:assert/strict');
const {
  memoryGraph,
  addEdges,
  rebuildGraph,
  initMemoryGraph,
  directedWeights,
  REVERSE_RELATION,
} = require('../src/services/memoryGraph');

test('directedWeights assigns asymmetric forward 2 and reverse 4 for hyponym relation', () => {
  const { forward, reverse } = directedWeights('hyponym', 3);
  assert.equal(forward, 2);
  assert.equal(reverse, 4);
});

test('directedWeights assigns asymmetric forward 4 and reverse 2 for hypernym relation', () => {
  const { forward, reverse } = directedWeights('hypernym', 3);
  assert.equal(forward, 4);
  assert.equal(reverse, 2);
});

test('directedWeights assigns symmetric weights for synonym, sibling, and mood relations', () => {
  assert.deepEqual(directedWeights('synonym', 1), { forward: 1, reverse: 1 });
  assert.deepEqual(directedWeights('sibling', 3), { forward: 3, reverse: 3 });
  assert.deepEqual(directedWeights('mood', 5), { forward: 5, reverse: 5 });
  assert.deepEqual(directedWeights('tangent', 6), { forward: 6, reverse: 6 });
});

test('REVERSE_RELATION maps hyponym and hypernym reciprocally', () => {
  assert.equal(REVERSE_RELATION.hyponym, 'hypernym');
  assert.equal(REVERSE_RELATION.hypernym, 'hyponym');
});

test('addEdges ignores self-loop edges where target equals word', () => {
  const g = new Map();
  addEdges(g, 'wolf', [{ target: 'wolf', weight: 1, relation: 'synonym' }]);
  assert.equal(g.get('wolf').has('wolf'), false);
});

test('addEdges filters out weights outside 1..6 range', () => {
  const g = new Map();
  addEdges(g, 'wolf', [
    { target: 'dog', weight: 0, relation: 'synonym' },
    { target: 'fox', weight: 7, relation: 'synonym' },
    { target: 'coyote', weight: -2, relation: 'synonym' },
    { target: 'jackal', weight: 2, relation: 'synonym' },
  ]);
  assert.equal(g.get('wolf').has('dog'), false);
  assert.equal(g.get('wolf').has('fox'), false);
  assert.equal(g.get('wolf').has('coyote'), false);
  assert.equal(g.get('wolf').get('jackal'), 2);
});

test('addEdges retains the minimum weight when duplicate edges exist', () => {
  const g = new Map();
  addEdges(g, 'wolf', [
    { target: 'dog', weight: 3, relation: 'sibling' },
    { target: 'dog', weight: 1, relation: 'synonym' },
    { target: 'dog', weight: 5, relation: 'tangent' },
  ]);
  assert.equal(g.get('wolf').get('dog'), 1);
});

test('addEdges handles empty, null, or undefined edges array safely', () => {
  const g = new Map();
  addEdges(g, 'cat', null);
  addEdges(g, 'bird', undefined);
  addEdges(g, 'fish', []);
  addEdges(g, 'deer', [null, { target: '' }]);
  assert.ok(g.has('cat'));
  assert.equal(g.get('cat').size, 0);
  assert.ok(g.has('deer'));
  assert.equal(g.get('deer').size, 0);
});

test('rebuildGraph clears existing edges and populates new node collection', () => {
  const g = new Map([['ancient', new Map([['old', 1]])]]);
  const nodes = [
    { word: 'dragon', edges: [{ target: 'wyvern', weight: 2, relation: 'sibling' }] },
    { word: 'knight', edges: [{ target: 'warrior', weight: 1, relation: 'synonym' }] },
  ];
  rebuildGraph(g, nodes);
  assert.equal(g.has('ancient'), false);
  assert.equal(g.get('dragon').get('wyvern'), 2);
  assert.equal(g.get('knight').get('warrior'), 1);
});

test('initMemoryGraph loads nodes from SemanticNode model and hydrates memoryGraph', async () => {
  const mockNodes = [
    { word: 'sky', edges: [{ target: 'cloud', weight: 1, relation: 'synonym' }] },
    { word: 'fire', edges: [{ target: 'flame', weight: 1, relation: 'synonym' }] },
  ];
  const MockModel = {
    find: () => ({
      select: () => ({
        lean: async () => mockNodes,
      }),
    }),
  };
  const count = await initMemoryGraph(MockModel);
  assert.ok(count >= 2);
  assert.ok(memoryGraph.has('sky'));
  assert.equal(memoryGraph.get('sky').get('cloud'), 1);
  assert.equal(memoryGraph.get('cloud').get('sky'), 1);
});
