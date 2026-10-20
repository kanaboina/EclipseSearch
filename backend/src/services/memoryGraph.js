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

/**
 * In-memory inverted index: word -> Set<docId>.
 * Populated at startup from SemanticNode.docIds; kept hot on write via
 * linkDocToWords / unlinkDocFromWords.
 */
const wordDocIds = new Map();

/**
 * Add `docId` to the in-memory posting lists for every word in `words`.
 * Called after a wallpaper is indexed (on first upload and during batch re-index).
 *
 * @param {string[]} words - normalized content words of the wallpaper
 * @param {string}   docId - String form of the wallpaper's _id
 */
function linkDocToWords(words, docId) {
  for (const w of words) {
    let s = wordDocIds.get(w);
    if (!s) { s = new Set(); wordDocIds.set(w, s); }
    s.add(docId);
  }
}

/**
 * Remove `docId` from every posting list.
 * Call on wallpaper delete / un-publish / draft-withdrawal.
 *
 * @param {string[]} words - words that were linked when the doc was indexed
 * @param {string}   docId
 */
function unlinkDocFromWords(words, docId) {
  for (const w of words) {
    const s = wordDocIds.get(w);
    if (s) s.delete(docId);
  }
}

async function initMemoryGraph(SemanticNode = require('../models/SemanticNode')) {
  const nodes = await SemanticNode.find({}).select('word edges docIds').lean();
  rebuildGraph(memoryGraph, nodes);

  // Hydrate the in-memory inverted index from each node's persisted docIds array.
  wordDocIds.clear();
  for (const n of nodes) {
    if (n.docIds && n.docIds.length) {
      let s = wordDocIds.get(n.word);
      if (!s) { s = new Set(); wordDocIds.set(n.word, s); }
      for (const id of n.docIds) s.add(id);
    }
  }

  require('./neighborIndex').neighborIndex.build(memoryGraph); // precompute once at startup
  return memoryGraph.size;
}

module.exports = {
  memoryGraph,
  wordDocIds,
  addEdges,
  rebuildGraph,
  initMemoryGraph,
  directedWeights,
  REVERSE_RELATION,
  linkDocToWords,
  unlinkDocFromWords,
};
