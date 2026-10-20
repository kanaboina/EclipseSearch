const {
  singleSourceBoundedDijkstra, analyzeQuery, boostFor, findClosestWordByNormalizedLCS,
  TOP_TERMS, MAX_HOPS, MAX_TYPO_TOKENS,
} = require('./semanticDijkstra');
const { wordDocIds: defaultWordDocIds } = require('./memoryGraph');

const K = 20;

/**
 * Write-time precomputed top-K neighbor index stored in flat TypedArrays
 * (no per-node objects -> no GC pressure, contiguous memory).
 *
 *   neighborNodeIds[node * K + i]  Uint32  neighbor node id
 *   neighborCosts  [node * K + i]  Uint8   semantic cost (0..6)
 *   neighborCounts [node]          Uint8   how many of the K slots are used
 */
class NeighborIndex {
  constructor(k = K) {
    this.k = k;
    this.graph = null;
    this.words = [];
    this.idOf = new Map();
    this.capacity = 0;
    this.neighborNodeIds = new Uint32Array(0);
    this.neighborCosts = new Uint8Array(0);
    this.neighborCounts = new Uint8Array(0);
  }

  get size() { return this.words.length; }

  _ensure(word) {
    let id = this.idOf.get(word);
    if (id !== undefined) return id;
    id = this.words.length;
    this.words.push(word);
    this.idOf.set(word, id);
    if (id >= this.capacity) {
      const cap = Math.max(64, this.capacity * 2);
      const ids = new Uint32Array(cap * this.k);
      const costs = new Uint8Array(cap * this.k);
      const counts = new Uint8Array(cap);
      ids.set(this.neighborNodeIds);
      costs.set(this.neighborCosts);
      counts.set(this.neighborCounts);
      this.neighborNodeIds = ids;
      this.neighborCosts = costs;
      this.neighborCounts = counts;
      this.capacity = cap;
    }
    return id;
  }

  _recompute(graph, word) {
    const node = this._ensure(word);
    const base = node * this.k;
    this.neighborCounts[node] = 0;
    if (!graph.has(word)) return;
    const near = [];
    // The ONLY place bounded Dijkstra runs: write time.
    for (const [w, d] of singleSourceBoundedDijkstra(graph, word)) if (w !== word) near.push([w, d]);
    near.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    const c = Math.min(this.k, near.length);
    for (let i = 0; i < c; i++) {
      this.neighborNodeIds[base + i] = this._ensure(near[i][0]);
      this.neighborCosts[base + i] = near[i][1];
    }
    this.neighborCounts[node] = c;
  }

  /**
   * Write-time incremental update. Recomputes only the changed words and every node within
   * MAX_HOPS of them (the only nodes whose Dijkstra result can have changed).
   */
  update(graph, changedWords) {
    this.graph = graph;
    const affected = new Set();
    let frontier = [];
    for (const w of changedWords) { affected.add(w); frontier.push(w); }
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const next = [];
      for (const w of frontier) {
        const m = graph.get(w);
        if (!m) continue;
        for (const t of m.keys()) if (!affected.has(t)) { affected.add(t); next.push(t); }
      }
      frontier = next;
    }
    for (const w of affected) this._ensure(w);
    for (const w of affected) this._recompute(graph, w);
    return affected.size;
  }

  /** Full rebuild (startup / backfill). Write path, never the read path. */
  build(graph) {
    this.words = [];
    this.idOf = new Map();
    this.capacity = 0;
    this.neighborNodeIds = new Uint32Array(0);
    this.neighborCosts = new Uint8Array(0);
    this.neighborCounts = new Uint8Array(0);
    const all = new Set(graph.keys());
    for (const m of graph.values()) for (const t of m.keys()) all.add(t);
    this.update(graph, all);
    this.graph = graph;
    return this;
  }

  has(word) { return this.idOf.has(word); }

  /** Zero-traversal lookup: Map<word, cost> including the word itself at cost 0. */
  neighbors(word) {
    const out = new Map([[word, 0]]);
    const node = this.idOf.get(word);
    if (node === undefined) return out;
    const base = node * this.k;
    for (let i = 0; i < this.neighborCounts[node]; i++) {
      out.set(this.words[this.neighborNodeIds[base + i]], this.neighborCosts[base + i]);
    }
    return out;
  }

  /** Approximate heap footprint of the binary buffers. */
  get byteLength() {
    return this.neighborNodeIds.byteLength + this.neighborCosts.byteLength + this.neighborCounts.byteLength;
  }

  /**
   * Same contract as expandQuerySemantically, but merges precomputed neighbor lists
   * instead of running graph traversals.
   * @returns {{tokens, terms: {term, cost, boost}[]}}
   */
  expand(q, { limit = TOP_TERMS } = {}) {
    const tokens = analyzeQuery(q);
    if (!tokens.length) return { tokens, terms: [] };
    let typoBudget = MAX_TYPO_TOKENS;
    const lists = tokens.map((t) => {
      if (this.idOf.has(t.word) || typoBudget <= 0 || !this.graph) return this.neighbors(t.word);
      const match = findClosestWordByNormalizedLCS(t.word, this.graph); // LRU-cached string match
      if (!match) return this.neighbors(t.word);
      typoBudget--; // Only consume budget on successful match
      const out = new Map();
      for (const [w, d] of this.neighbors(match.word)) out.set(w, d + match.initialCost);
      return out;
    });
    const candidates = new Set(tokens.map((t) => t.word));
    for (const l of lists) for (const w of l.keys()) candidates.add(w);
    const terms = [];
    for (const v of candidates) {
      // Min-cost: a term only needs to be close to ONE query token.
      let cost = Infinity;
      tokens.forEach((t, i) => {
        const d = lists[i].get(v);
        const c = d !== undefined ? d : t.penalty;
        if (c < cost) cost = c;
      });
      terms.push({ term: v, cost, boost: boostFor(cost) });
    }
    terms.sort((a, b) => a.cost - b.cost || (a.term < b.term ? -1 : 1));
    return { tokens, terms: terms.slice(0, limit) };
  }
  /**
   * Resolve a search query directly to ranked document IDs using the in-memory
   * inverted index (wordDocIds). No DB round trip — returns unique document IDs
   * weighted by semantic proximity to the query.
   *
   * Algorithm:
   *   1. Expand query via precomputed neighbor lists (O(1) per token).
   *   2. For each term, look up its posting list in `wordDocIds`.
   *   3. Accumulate a per-docId score (sum of boost values for each matching term).
   *   4. Sort descending by score, return top `limit` entries as [{docId, score}].
   *
   * @param {string}  q             - raw search query
   * @param {Map}     [docIds]      - wordDocIds map (defaults to in-memory process-wide map)
   * @param {number}  [limit=200]   - max results to return
   * @returns {{ docIds: {docId: string, score: number}[], tokens: object[], terms: object[] }}
   */
  resolveDocIds(q, docIds = defaultWordDocIds, limit = 200) {
    const { tokens, terms } = this.expand(q);
    if (!terms.length) return { docIds: [], tokens, terms };

    // Accumulate score per document ID across all matching terms.
    const scoreMap = new Map();
    for (const { term, boost } of terms) {
      const posting = docIds.get(term);
      if (!posting || !posting.size) continue;
      for (const id of posting) {
        const cur = scoreMap.get(id);
        scoreMap.set(id, (cur || 0) + boost);
      }
    }

    // Sort by score descending, then docId ascending for determinism.
    const ranked = [];
    for (const [docId, score] of scoreMap) ranked.push({ docId, score });
    ranked.sort((a, b) => b.score - a.score || (a.docId < b.docId ? -1 : 1));

    return { docIds: ranked.slice(0, limit), tokens, terms };
  }
}

/** Process-wide index used by the search path. Rebuilt/updated only on graph writes. */
const neighborIndex = new NeighborIndex();

module.exports = { NeighborIndex, neighborIndex, K };
