/**
 * In-memory semantic graph: Map<word, Map<neighbor, weight>>.
 * Hot-updatable; no restart needed.
 */
const memoryGraph = new Map();

const REVERSE_RELATION = { hyponym: 'hypernym', hypernym: 'hyponym' };

/**
 * Directed weight rules (relation describes target relative to `word`):
 *  - hyponym  (target is a child of word):  word->target = 2, target->word = 4
 *  - hypernym (target is a parent of word): word->target = 4, target->word = 2
 *  - symmetric relations: same weight both ways.
 */
function directedWeights(relation, weight) {
  if (relation === 'hyponym') return { forward: 2, reverse: 4 };
  if (relation === 'hypernym') return { forward: 4, reverse: 2 };
  return { forward: weight, reverse: weight };
}

function setMin(graph, from, to, w) {
  if (from === to || w < 1 || w > 6) return;
  let m = graph.get(from);
  if (!m) { m = new Map(); graph.set(from, m); }
  const cur = m.get(to);
  if (cur === undefined || w < cur) m.set(to, w);
}

function addEdges(graph, word, edges) {
  if (!graph.has(word)) graph.set(word, new Map());
  for (const e of edges || []) {
    if (!e || !e.target) continue;
    const { forward, reverse } = directedWeights(e.relation, e.weight);
    setMin(graph, word, e.target, forward);
    setMin(graph, e.target, word, reverse);
  }
}

function rebuildGraph(graph, nodes) {
  graph.clear();
  for (const n of nodes) addEdges(graph, n.word, n.edges);
  return graph;
}

async function initMemoryGraph(SemanticNode = require('../models/SemanticNode')) {
  const nodes = await SemanticNode.find({}).select('word edges').lean();
  rebuildGraph(memoryGraph, nodes);
  require('./neighborIndex').neighborIndex.build(memoryGraph); // precompute once at startup
  return memoryGraph.size;
}

module.exports = { memoryGraph, addEdges, rebuildGraph, initMemoryGraph, directedWeights, REVERSE_RELATION };
