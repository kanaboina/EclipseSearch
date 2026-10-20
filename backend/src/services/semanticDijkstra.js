const { LRUCache } = require('lru-cache');
const { memoryGraph: defaultGraph, graphRevision } = require('./memoryGraph');
const { nlp, STOPWORDS, DOMAIN_STOPWORDS, singularize, normalizeToken, normalizeTokenStrict } = require('./textNlp');

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
  doc.match('#Adjective').terms().forEach((t) => adjectives.add(normalizeTokenStrict(t.text('normal'))));
  const nouns = new Set();
  doc.match('(#Noun|#ProperNoun)').terms().forEach((t) => nouns.add(normalizeTokenStrict(t.text('normal'))));

  const seen = new Map();
  for (const raw of text.split(/\s+/)) {
    const norm = normalizeToken(raw);      // preserves internal hyphens
    const strict = normalizeTokenStrict(raw); // strips hyphens
    if (!norm && !strict) continue;

    // Emit the hyphenated form (e.g. "sci-fi") if it differs from the strict form
    const candidates = new Set();
    if (norm) candidates.add(singularize(norm));
    if (strict && strict !== norm) candidates.add(singularize(strict));

    for (const word of candidates) {
      if (STOPWORDS.has(word)) continue;
      let penalty = PENALTY.entity;
      if (DOMAIN_STOPWORDS.has(word)) penalty = PENALTY.stopword;
      else if (adjectives.has(strict) && !nouns.has(strict)) penalty = PENALTY.modifier;
      if (!seen.has(word) || penalty > seen.get(word)) seen.set(word, penalty);
    }
  }
  return Array.from(seen, ([word, penalty]) => ({ word, penalty }));
}

/**
 * Hop-bounded shortest paths with a frontier for each exact hop count.
 * 2nd+ hop adds +1 friction. Keeping hop layers separate preserves a costlier
 * short route when a cheaper route has already consumed the hop budget.
 * @returns {Map<string, number>} word -> min distance
 */
function singleSourceBoundedDijkstra(graph, source, maxCost = MAX_COST, maxHops = MAX_HOPS) {
  const dist = new Map([[source, 0]]);
  let frontier = new Map([[source, 0]]);
  for (let hops = 0; hops < maxHops && frontier.size; hops++) {
    const nextLayer = hops + 1 < maxHops ? new Map() : null;
    const friction = hops > 0 ? 1 : 0;
    for (const [u, cost] of frontier) {
      if (cost + 1 + friction > maxCost) continue;
      for (const [v, weight] of graph.get(u) || []) {
        if (!Number.isInteger(weight) || weight < 1 || weight > 6) continue;
        const next = cost + weight + friction;
        if (next > maxCost) continue;
        const best = dist.get(v);
        if (best === undefined || next < best) dist.set(v, next);
        if (nextLayer && (nextLayer.get(v) === undefined || next < nextLayer.get(v))) nextLayer.set(v, next);
      }
    }
    frontier = nextLayer;
  }
  return dist;
}

const boostFor = (cost) => Math.round((20 / (1 + cost)) * 100) / 100;

const LCS_MAX_LEN = 63;
const LCS_MIN_SIMILARITY = 0.55;
const LCS_HIGH_SIMILARITY = 0.8;

/** LCS length of a and b using two Uint8Array rows allocated per call (race-condition safe). */
function lcsLength(a, b) {
  const n = a.length;
  const m = b.length;
  let prev = new Uint8Array(m + 1);
  let curr = new Uint8Array(m + 1);
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

const MAX_TYPO_TOKENS = 2; // anti-DoS: heavy string-distance fallbacks per query

/** 32-bit presence mask: bit (c - 97) set for each a-z character. */
function charMask(word) {
  let m = 0;
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i) - 97;
    if (c >= 0 && c < 26) m |= 1 << c;
  }
  return m >>> 0;
}

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Per-graph dictionary masks, invalidated by vocabulary size or write revision.
const maskStore = new WeakMap(); // graph -> { size, masks: Map<word, mask>, typoCache: LRUCache }
function graphTypoState(graph) {
  let st = maskStore.get(graph);
  const revision = graphRevision(graph);
  if (!st || st.size !== graph.size || st.revision !== revision) {
    const masks = new Map();
    for (const w of graph.keys()) masks.set(w, charMask(w));
    st = { size: graph.size, revision, masks, typoCache: new LRUCache({ max: 5000 }) };
    maskStore.set(graph, st);
  }
  return st;
}

const NO_MATCH = Symbol('no-match');

/**
 * Scan graph keys for the best Sørensen–Dice LCS match: 2*LCS/(|A|+|B|).
 * Pruning: length bound, then disjoint alphabet masks before the O(|A||B|) LCS.
 * Results (including misses) are memoised in an LRU typoCache.
 * @returns {{word: string, similarity: number, initialCost: number} | null}
 */
function findClosestWordByNormalizedLCS(query, graph = defaultGraph) {
  const A = String(query || '');
  if (!A || A.length > LCS_MAX_LEN) return null;
  const { masks, typoCache } = graphTypoState(graph);
  const cached = typoCache.get(A);
  if (cached !== undefined) return cached === NO_MATCH ? null : cached;

  const maskA = charMask(A);
  const lettersOnly = /^[a-z]+$/.test(A);
  let bestScore = 0;
  let bestWord = null;
  for (const B of graph.keys()) {
    const lb = B.length;
    if (lb > LCS_MAX_LEN || lb === 0) continue;
    const total = A.length + lb;
    if ((2 * Math.min(A.length, lb)) / total < bestScore) continue;
    const maskB = masks.get(B);
    // A presence mask cannot bound the LCS when characters repeat. It only
    // proves a miss for disjoint alphabets containing exclusively a-z.
    if (lettersOnly && /^[a-z]+$/.test(B) && !(maskA & maskB)) continue;
    const score = (2 * lcsLength(A, B)) / total;
    if (score > bestScore || (score === bestScore && bestWord !== null && B < bestWord)) {
      bestScore = score;
      bestWord = B;
    }
  }
  const result =
    !bestWord || bestScore < LCS_MIN_SIMILARITY
      ? null
      : { word: bestWord, similarity: bestScore, initialCost: bestScore >= LCS_HIGH_SIMILARITY ? 1 : 2 };
  typoCache.set(A, result === null ? NO_MATCH : result);
  return result;
}

// Keep only the requested terms while scanning. Most candidates cannot enter
// the small top-K result, so avoid sorting/allocating/scoring all of them.
function retainTerm(terms, term, cost, limit) {
  if (limit <= 0) return;
  const last = terms[terms.length - 1];
  if (terms.length >= limit && (cost > last.cost || (cost === last.cost && term >= last.term))) return;
  let low = 0;
  let high = terms.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const row = terms[mid];
    if (row.cost < cost || (row.cost === cost && row.term < term)) low = mid + 1;
    else high = mid;
  }
  terms.splice(low, 0, { term, cost, boost: boostFor(cost) });
  if (terms.length > limit) terms.pop();
}

/**
 * Merge distances and absent-token penalties without scanning every token for
 * every candidate. A penalty applies when at least one traversal in its group
 * lacks the candidate. Counts preserve that rule even for repeated penalties.
 */
function mergeTraversals(tokens, traversals, limit = TOP_TERMS) {
  if (tokens.length <= 4) {
    const candidates = new Set(tokens.map((t) => t.word));
    for (const traversal of traversals) for (const word of traversal.keys()) candidates.add(word);
    const terms = [];
    for (const term of candidates) {
      let cost = Infinity;
      for (let i = 0; i < tokens.length; i++) cost = Math.min(cost, traversals[i].get(term) ?? tokens[i].penalty);
      retainTerm(terms, term, cost, limit);
    }
    return terms;
  }
  const costs = new Map(tokens.map((t) => [t.word, Infinity]));
  const groups = new Map();
  tokens.forEach((token, i) => {
    let group = groups.get(token.penalty);
    if (!group) { group = { total: 0, present: new Map() }; groups.set(token.penalty, group); }
    group.total++;
    for (const [word, distance] of traversals[i]) {
      if (!costs.has(word) || distance < costs.get(word)) costs.set(word, distance);
      group.present.set(word, (group.present.get(word) || 0) + 1);
    }
  });
  const terms = [];
  for (const [term, distance] of costs) {
    let cost = distance;
    for (const [penalty, group] of groups) {
      if ((group.present.get(term) || 0) < group.total) cost = Math.min(cost, penalty);
    }
    retainTerm(terms, term, cost, limit);
  }
  return terms;
}

/**
 * Multi-source intersection scorer. Returns top-25 tightest terms:
 * [{ term, cost, boost }] sorted ascending by cost.
 */
function expandQuerySemantically(q, graph = defaultGraph, limit = TOP_TERMS) {
  const tokens = analyzeQuery(q);
  if (!tokens.length) return { tokens, terms: [] };
  let typoBudget = MAX_TYPO_TOKENS;
  const traversals = tokens.map((t) => {
    if (graph.has(t.word)) return singleSourceBoundedDijkstra(graph, t.word);
    if (typoBudget <= 0) return singleSourceBoundedDijkstra(graph, t.word);
    typoBudget--;
    const match = findClosestWordByNormalizedLCS(t.word, graph);
    if (!match) return singleSourceBoundedDijkstra(graph, t.word);
    const raw = singleSourceBoundedDijkstra(graph, match.word);
    const dist = new Map();
    for (const [w, d] of raw) dist.set(w, d + match.initialCost);
    return dist;
  });
  return { tokens, terms: mergeTraversals(tokens, traversals, limit) };
}

module.exports = {
  analyzeQuery,
  mergeTraversals,
  singleSourceBoundedDijkstra,
  findClosestWordByNormalizedLCS,
  charMask,
  popcount,
  MAX_TYPO_TOKENS,
  expandQuerySemantically,
  boostFor,
  MAX_COST,
  MAX_HOPS,
  TOP_TERMS,
};
