const { memoryGraph: defaultGraph } = require('./memoryGraph');
const { nlp, STOPWORDS, DOMAIN_STOPWORDS, singularize, normalizeToken } = require('./textNlp');

const MAX_COST = 6;
const MAX_HOPS = 2;
const TOP_TERMS = 25;
const PENALTY = { entity: 15, modifier: 6, stopword: 1 };

/**
 * Normalize query tokens to singular lowercase and assign miss penalties.
 * Nouns/Proper nouns/unknown = 15, Adjectives = 6, domain stopwords = 1.
 */
function analyzeQuery(q) {
  const text = String(q || '').toLowerCase();
  const doc = nlp(text);
  const adjectives = new Set();
  doc.match('#Adjective').terms().forEach((t) => adjectives.add(normalizeToken(t.text('normal'))));
  const nouns = new Set();
  doc.match('(#Noun|#ProperNoun)').terms().forEach((t) => nouns.add(normalizeToken(t.text('normal'))));

  const seen = new Map();
  for (const raw of text.split(/\s+/)) {
    const norm = normalizeToken(raw);
    if (!norm) continue;
    const word = singularize(norm);
    if (STOPWORDS.has(word)) continue;
    let penalty = PENALTY.entity;
    if (DOMAIN_STOPWORDS.has(norm) || DOMAIN_STOPWORDS.has(word)) penalty = PENALTY.stopword;
    else if (adjectives.has(norm) && !nouns.has(norm)) penalty = PENALTY.modifier;
    if (!seen.has(word) || penalty > seen.get(word)) seen.set(word, penalty);
  }
  return Array.from(seen, ([word, penalty]) => ({ word, penalty }));
}

/**
 * Dial's algorithm (bucket queue, costs 0..6), bounded by maxCost and maxHops.
 * 2nd+ hop adds +1 friction so two generic hops (2+2) never beat a direct relation.
 * @returns {Map<string, number>} word -> min distance
 */
function singleSourceBoundedDijkstra(graph, source, maxCost = MAX_COST, maxHops = MAX_HOPS) {
  const dist = new Map([[source, 0]]);
  const hopsAt = new Map([[source, 0]]);
  const buckets = Array.from({ length: maxCost + 1 }, () => []);
  buckets[0].push(source);

  for (let c = 0; c <= maxCost; c++) {
    for (let i = 0; i < buckets[c].length; i++) {
      const u = buckets[c][i];
      if (dist.get(u) !== c) continue; // stale entry
      const hops = hopsAt.get(u);
      if (hops >= maxHops) continue;
      const nbrs = graph.get(u);
      if (!nbrs) continue;
      for (const [v, w] of nbrs) {
        const next = c + w + (hops >= 1 ? 1 : 0);
        if (next > maxCost) continue;
        const cur = dist.get(v);
        if (cur === undefined || next < cur) {
          dist.set(v, next);
          hopsAt.set(v, hops + 1);
          buckets[next].push(v);
        }
      }
    }
  }
  return dist;
}

const boostFor = (cost) => Math.round((20 / (1 + cost)) * 100) / 100;

const LCS_MAX_LEN = 63;
const LCS_MIN_SIMILARITY = 0.55;
const LCS_HIGH_SIMILARITY = 0.8;
// Pre-allocated DP rows: no heap allocation per candidate.
let lcsPrev = new Uint8Array(LCS_MAX_LEN + 1);
let lcsCurr = new Uint8Array(LCS_MAX_LEN + 1);

/** LCS length of a and b using two reusable Uint8Array rows. Both lengths must be <= 63. */
function lcsLength(a, b) {
  const n = a.length;
  const m = b.length;
  let prev = lcsPrev;
  let curr = lcsCurr;
  prev.fill(0, 0, m + 1);
  curr.fill(0, 0, m + 1);
  for (let i = 1; i <= n; i++) {
    const ca = a.charCodeAt(i - 1);
    curr[0] = 0;
    for (let j = 1; j <= m; j++) {
      if (ca === b.charCodeAt(j - 1)) curr[j] = prev[j - 1] + 1;
      else curr[j] = prev[j] >= curr[j - 1] ? prev[j] : curr[j - 1];
    }
    const t = prev; prev = curr; curr = t;
  }
  return prev[m];
}

/**
 * Scan graph keys for the best Sørensen–Dice LCS match: 2*LCS/(|A|+|B|).
 * O(1) branch-and-bound prunes candidates that cannot beat bestScore.
 * @returns {{word: string, similarity: number, initialCost: number} | null}
 */
function findClosestWordByNormalizedLCS(query, graph = defaultGraph) {
  const A = String(query || '');
  if (!A || A.length > LCS_MAX_LEN) return null;
  let bestScore = 0;
  let bestWord = null;
  for (const B of graph.keys()) {
    const lb = B.length;
    if (lb > LCS_MAX_LEN || lb === 0) continue;
    const total = A.length + lb;
    if ((2 * Math.min(A.length, lb)) / total <= bestScore) continue;
    const score = (2 * lcsLength(A, B)) / total;
    if (score > bestScore || (score === bestScore && bestWord !== null && B < bestWord)) {
      bestScore = score;
      bestWord = B;
    }
  }
  if (!bestWord || bestScore < LCS_MIN_SIMILARITY) return null;
  return { word: bestWord, similarity: bestScore, initialCost: bestScore >= LCS_HIGH_SIMILARITY ? 1 : 2 };
}

/**
 * Multi-source intersection scorer. Returns top-25 tightest terms:
 * [{ term, cost, boost }] sorted ascending by cost.
 */
function expandQuerySemantically(q, graph = defaultGraph, limit = TOP_TERMS) {
  const tokens = analyzeQuery(q);
  if (!tokens.length) return { tokens, terms: [] };
  const traversals = tokens.map((t) => {
    if (graph.has(t.word)) return singleSourceBoundedDijkstra(graph, t.word);
    const match = findClosestWordByNormalizedLCS(t.word, graph);
    if (!match) return singleSourceBoundedDijkstra(graph, t.word);
    const raw = singleSourceBoundedDijkstra(graph, match.word);
    const dist = new Map();
    for (const [w, d] of raw) dist.set(w, d + match.initialCost);
    return dist;
  });
  const candidates = new Set();
  for (const t of tokens) candidates.add(t.word);
  for (const d of traversals) for (const w of d.keys()) candidates.add(w);

  const terms = [];
  for (const v of candidates) {
    let cost = 0;
    tokens.forEach((t, i) => {
      const d = traversals[i].get(v);
      cost += d !== undefined ? d : t.penalty;
    });
    terms.push({ term: v, cost, boost: boostFor(cost) });
  }
  terms.sort((a, b) => a.cost - b.cost || (a.term < b.term ? -1 : 1));
  return { tokens, terms: terms.slice(0, limit) };
}

module.exports = {
  analyzeQuery,
  singleSourceBoundedDijkstra,
  findClosestWordByNormalizedLCS,
  expandQuerySemantically,
  boostFor,
  MAX_COST,
  MAX_HOPS,
  TOP_TERMS,
};
