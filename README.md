# Eclipse Fantasy — Semantic Search Engine

[![Tests](https://img.shields.io/badge/tests-122%20passing-brightgreen.svg)](./backend/test/)
[![Node](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](https://nodejs.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-Atlas%20Search-green.svg)](https://www.mongodb.com/atlas/database)
[![Peak Throughput](https://img.shields.io/badge/in--process%20peak-28.4k%20QPS-purple.svg)](#concurrency-ladder-1k--20k-concurrent-searches)
[![HTTP Load](https://img.shields.io/badge/autocannon-1.2k%20req%2Fs%20%C2%B7%200%20errors-orange.svg)](#real-http-load-testing-autocannon-on-atlas-schema-10k-catalog)
[![Edge Cache](https://img.shields.io/badge/benchmarks-no%20Cloudflare%20cache-lightgrey.svg)](#benchmark-scope--methodology)
[![Relevance](https://img.shields.io/badge/nDCG%4010-0.944-brightgreen.svg)](#search-relevance-results)

A deterministic semantic search engine and associative knowledge graph for fantasy, anime and artistic wallpaper catalogs.

**Graph traversal happens only when the graph is written — never while serving a search.** Bounded Dijkstra runs at write time and its results go into a flat, `TypedArray`-backed top-K neighbor index. At query time, expanding a search is a set of array lookups. In-flight requests are coalesced (singleflight). Pagination reads from a per-session ranked pool, so it never re-queries the database.

> [!IMPORTANT]
> **All performance figures in this document are origin-only.** They were measured **without the Cloudflare edge cache** ([`searchCacheWorker.js`](./backend/src/edge/searchCacheWorker.js)), without any CDN, Redis or other external cache layer, and on a single Node.js process. In production, cacheable public queries are answered at the edge before they reach the origin, so these numbers are a **worst-case floor** and not the expected steady state.

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [How the Engine Works](#how-the-engine-works)
3. [Optimisation Techniques](#optimisation-techniques)
4. [Test Suite & Results](#test-suite--results)
5. [Performance & Load Testing](#performance--load-testing)
6. [Repository Structure](#repository-structure)
7. [Getting Started](#getting-started)
8. [Atlas Search Index](#atlas-search-index)
9. [Operational Notes & Known Limits](#operational-notes--known-limits)

---

## System Architecture

The system has two paths. The **write path** (upload, AI ingestion, backfill) pays all the computational cost up front. The **read path** (search) does only lookups and slices.

```mermaid
flowchart LR
    subgraph EDGE["Edge (not part of benchmarks)"]
        CF["Cloudflare Worker<br/>query normalisation + Cache API"]
    end

    subgraph READ["Read Path - search, hot"]
        direction TB
        API["GET /api/search"] --> SESS{"sessionId<br/>in LRU?"}
        SESS -->|yes| SLICE["Slice ranked pool<br/>cursor + Set dedupe"]
        SESS -->|no| NLP["analyzeQuery<br/>compromise PoS + stopwords"]
        NLP --> EXP["NeighborIndex.expand<br/>TypedArray lookups, zero traversal"]
        EXP --> TYPO["Typo fallback, max 2 tokens<br/>bitmask prefilter, LCS, LRU cache"]
        TYPO --> CUT["Relevance cutoff<br/>boost >= MIN_BOOST"]
        CUT --> SF["Singleflight<br/>coalesce identical in-flight keys"]
        SF --> DB[("MongoDB Atlas Search<br/>compound pipeline / $text fallback")]
        DB --> POOL["Ranked pool, 200 rows<br/>stored in session"]
        POOL --> SLICE
        SLICE --> DTO["wallpaperCardDTO<br/>strip internal fields"]
    end

    subgraph WRITE["Write Path - ingestion, cold"]
        direction TB
        UP["Upload / Edit / Backfill"] --> AI["AI expansion chain<br/>Gemini, Groq, OpenAI"]
        AI --> PERSIST["bulkWrite SemanticNode<br/>+ addEdges to memoryGraph"]
        PERSIST --> DIJ["Bounded Dijkstra<br/>Dial buckets, cost 6, 2 hops"]
        DIJ --> IDX["NeighborIndex.update<br/>affected region only"]
        AI -.->|all providers down| DRAFT["Draft + exponential backoff worker"]
    end

    CF --> API
    IDX -.->|precomputed top-K| EXP
```

---

## How the Engine Works

### 1. Query understanding — [`textNlp.js`](./backend/src/services/textNlp.js), [`semanticDijkstra.js`](./backend/src/services/semanticDijkstra.js)

The query is tokenised, normalised (lower-case, symbols and emoji stripped; internal hyphens are kept, so `sci-fi` is emitted as both `sci-fi` and `scifi`), singularised (`fairies → fairy`, `witches → witch`, and irregular forms) and filtered for stopwords. `compromise` tags each surviving token with a part of speech. The tag sets the **miss penalty** applied when a candidate term is unrelated to that token:

| Token class | Miss penalty | Rationale |
|:---|:---:|:---|
| Entity / noun | 15 | The subject of the search. Missing it makes the result irrelevant. |
| Modifier / adjective | 6 | Refines the result. A miss costs relevance but is not disqualifying. |
| Domain stopword | 1 | Words like *wallpaper* or *background* carry almost no signal. |

### 2. Semantic graph and write-time precomputation — [`memoryGraph.js`](./backend/src/services/memoryGraph.js), [`neighborIndex.js`](./backend/src/services/neighborIndex.js)

The knowledge graph stores typed, weighted relations: synonym, hyponym, hypernym, sibling, scene, mood and tangent. Some weights are **asymmetric**. For example, *dragon → wyvern* (hyponym) is cheaper than the reverse direction, so specific queries do not drift towards generic terms.

When a word is added or edited, `NeighborIndex.update(graph, changedWords)`:

1. Runs a BFS outward from the changed words for `MAX_HOPS = 2` hops. These are the only nodes whose shortest paths can have changed.
2. Runs **Dial's bucket-queue Dijkstra** (integer costs 0..6, +1 friction on hop 2) from each affected node.
3. Writes the cheapest `K = 20` neighbors into flat buffers:

```text
neighborNodeIds[node * K + i]   Uint32   neighbor node id
neighborCosts  [node * K + i]   Uint8    semantic cost (0..6)
neighborCounts [node]           Uint8    occupied slots (<= K)
```

Buffers grow by doubling, which amortises the cost of growth to O(1). At startup, `initMemoryGraph()` hydrates the graph from MongoDB and builds the index once.

### 3. Query expansion with zero traversal

`NeighborIndex.expand(q)` reads each token's precomputed neighbor list and builds the union of candidate terms. Each candidate's cost is the **minimum**, over the query tokens, of either its precomputed distance or that token's miss penalty. A term only has to be close to *one* query token to be relevant — for multi-word queries such as `dragon knight`, whose tokens have disjoint neighborhoods, this ensures both token neighborhoods contribute candidates without inflating costs. Candidates are sorted by cost and the top 25 are kept. `boostFor(cost)` converts each cost into an Atlas boost. **No graph traversal happens per request.**

**Typo fallback.** A token that is not in the vocabulary (at most 2 per query) is matched to the closest dictionary word using the Sørensen–Dice LCS similarity `2·LCS(A,B) / (|A|+|B|)`:

- similarity ≥ 0.80: the match's neighbors are inherited at **+1** cost
- 0.55 ≤ similarity < 0.80: inherited at **+2** cost
- similarity < 0.55: ignored, and the token's normal miss penalty applies

### 4. Retrieval and ranking — [`searchRanking.js`](./backend/src/services/searchRanking.js)

Expanded terms are compiled into an **Atlas Search compound pipeline**. Primary fields are weighted title 10, tags 8, categoryName 7, wrapped in a `must` clause with `minimumShouldMatch: 1`. Edge-gram fuzzy autocomplete covers partially typed queries. Secondary fields add `should` boosts. Sorting is deterministic. If Atlas Search is unavailable, the engine falls back to a MongoDB `$text` query. [`visibilityFilter.js`](./backend/src/utils/visibilityFilter.js) applies the public visibility rules (no drafts, no pending deletions, `publishAt <= now`) **inside the query itself**, not as a post-filter.

### 5. Progressive pagination — [`progressiveSearch.js`](./backend/src/services/progressiveSearch.js)

```text
Request 1 (no sessionId)
  expand -> drop terms with boost < 2 -> singleflight(fetchPool, limit 200)
  -> optional score-ratio cutoff -> store {ranked, cursor, seenIds:Set} in LRU (5,000 sessions, 15 min TTL)
  -> return first 20 + sessionId

Request 2..N (with sessionId)
  -> advance cursor over the in-memory ranked pool, skip ids already in seenIds
  -> return next 20, hasMore = cursor < ranked.length       (no DB round-trip)
```

### 6. Write-path resilience — [`aiGraphService.js`](./backend/src/services/aiGraphService.js), [`draftRetryWorker.js`](./backend/src/workers/draftRetryWorker.js)

The engine uses AI only to discover new words, never during a search. If none of Gemini 2.5 Flash, Groq Llama-3.3-70B or OpenAI responds, the wallpaper is saved as a **draft** and an exponential-backoff worker retries (2 m → 4 m → 8 m … capped at 60 m, abandoned after 10 attempts). Uploads never fail because an LLM provider is down.

---

## Optimisation Techniques

| # | Technique | Where | Why it matters |
|:-:|:---|:---|:---|
| 1 | **Read/write split** (precompute at write time) | `neighborIndex.js` | Writes are rare and reads are frequent, so the expensive traversal moves to the rare side. |
| 2 | **Struct-of-arrays in `TypedArray`s** | `neighborIndex.js` | Cache-friendly sequential reads and no per-node heap objects for V8's GC to scan. 10k nodes × K=20 take about **1.6 MB**. |
| 3 | **Incremental, region-bounded updates** | `NeighborIndex.update` | Only nodes within 2 hops of a change are recomputed. A full rebuild is needed only at startup or backfill. |
| 4 | **Dial's algorithm** (bucket queue) | `semanticDijkstra.js` | Integer costs 0..6 allow O(1) bucket operations with no binary heap and no `log n` factor. |
| 5 | **Hop friction + cost ceiling** | `semanticDijkstra.js` | Prevents *dragon → animal → cat* style drift and bounds the search space. |
| 6 | **Bitmask + popcount pre-filter** | `findClosestWordByNormalizedLCS` | A 32-bit AND and a SWAR popcount reject most dictionary words before the O(n·m) DP runs. |
| 7 | **Branch-and-bound on length** | `findClosestWordByNormalizedLCS` | Skips any candidate whose best possible score cannot beat the current best. |
| 8 | **Pre-allocated DP rows** | `lcsLength` | `Uint8Array` rows are reused, so no allocation happens per candidate. |
| 9 | **Negative caching** | LRU `typoCache` (5,000) | Misses are stored as a `NO_MATCH` sentinel, so repeated garbage queries cost O(1). |
| 10 | **Typo budget** (`MAX_TYPO_TOKENS = 2`) | expansion | Limits CPU per request, which mitigates algorithmic-complexity DoS. |
| 11 | **Singleflight request coalescing** | `singleflight.js` | Prevents a thundering herd on hot or trending queries. N concurrent callers produce one fetch. |
| 12 | **Order-insensitive keys** | `searchKey` / `normalizeQuery` | `"Red Dragon"` and `"dragon red"` coalesce and share a cache entry. |
| 13 | **Session-scoped ranked pools** | `progressiveSearch.js` | One DB query serves up to 10 pages. Deduplication uses an O(1) `Set`. |
| 14 | **Relevance cutoffs** | `MIN_BOOST`, `minScoreRatio` | Stops paginating into noise and makes the result pool smaller. |
| 15 | **Query-level visibility** | `visibilityFilter.js` | The database never returns ineligible rows, so no work is spent filtering them afterwards. |
| 16 | **DTO projection** | `wallpaperDTO.js` | Removes `story`, `downloadKeys`, `uuid` and similar fields, which keeps payloads small and private data off the wire. |
| 17 | **Edge normalisation + SWR** | `searchCacheWorker.js` | Serves repeat public queries at the edge. *Disabled for all benchmarks below.* |

---

## Test Suite & Results

The suite uses Node's built-in test runner (`node --test`). It has no external test-framework dependencies.

```bash
cd backend
npm test
```

### Execution summary

```text
Test files:        13
Total tests:      122
Passed:           122
Failed:             0
Skipped:            0
Pass rate:       100%
Wall clock:     ~6.1 s   (≈ 4.5 s of this is the intentional 10k-token stress query, STRESS 5)
```

### Coverage by suite

| Suite | Tests | Status | Verification focus |
|:---|:---:|:---:|:---|
| `textNlp.test.js` | 12 | ✅ | Singularisation (`-ies`, `-shes`, `-ches`, `-xes`, irregulars), general and domain stopwords, token normalisation (internal hyphens preserved) |
| `memoryGraph.test.js` | 10 | ✅ | Asymmetric hyponym/hypernym weights, symmetric relations, self-loop pruning, 1..6 clamp, rebuild and init |
| `semanticDijkstra.test.js` | 15 | ✅ | PoS penalties (15 / 6 / 1), Dial buckets, hop friction, cost and hop cutoffs, LCS typo tiers (≥0.80, 0.55–0.80) |
| `searchBufferCache.test.js` | 8 | ✅ | LRU ordering, TTL expiry, hit promotion, generation-based invalidation |
| `wallpaperDTO.test.js` | 8 | ✅ | Strips internal and sensitive fields, safe category projection, URL fallbacks |
| `visibilityFilter.test.js` | 5 | ✅ | Draft rejection, deletion-pending exclusion, publish-date gating |
| `searchRanking.test.js` | 12 | ✅ | Field weights, compound pipeline with `minimumShouldMatch: 1`, fuzzy autocomplete, `$text` failover |
| `wallpaperService.test.js` | 10 | ✅ | Multi-page traversal with zero duplicates, prefetch threshold, jump pages, device-isolated partitions |
| `aiGraphService.test.js` | 10 | ✅ | Prompt structure, edge sanitisation, weight clamping, provider failover, safe draft fallback |
| `draftWorkerLifecycle.test.js` | 10 | ✅ | Backoff progression, atomic job claiming, retry publication, 10-attempt ceiling, edit hooks |
| `latencyMetrics.test.js` | 8 | ✅ | Latency SLA regression gates over a 10,000-word search space |
| `highPerfSearch.test.js` | **9** | ✅ | TypedArray layout, K-cap, live-vs-precomputed parity, singleflight, session deduplication, single-fetch pagination, relevance cutoff, key normalisation, bitmask/popcount, typo cache identity, typo budget, incremental 2-hop refresh |
| `stress.test.js` | **5** | ✅ | 10k-word index build, sustained expansion rate, 2k-way coalescing, 3k concurrent sessions, 10k-token adversarial query plus typo storm |

### Stress test results (10,000-word synthetic graph, ~30k directed edges)

| ID | Scenario | Assertion | Observed | Result |
|:---:|:---|:---|:---|:---:|
| S1 | Build `NeighborIndex` (K=15) over 10k words | build < 3,000 ms, every node ≤ 15 neighbors | **~112 ms** | ✅ |
| S2 | 5,000 sequential `expand()` calls across the vocabulary | > 1,000 expansions/s | **> 15,000 /s** (5k in < 325 ms wall-clock, index build included) | ✅ |
| S3 | **2,000 concurrent identical searches** | exactly **1** pool fetch, all callers get 20 rows, no leaked in-flight keys | **1 fetch**, 2,000 × 20 rows, `pending = 0` | ✅ |
| S4 | **3,000 concurrent users × 3 pages** (9,000 searches) | unique session ids, zero duplicates per session, > 1,000 searches/s | **3,000 unique sessions, 0 duplicates, > 30,000 searches/s** | ✅ |
| S5 | 10,000-token query + 1,000 repeated typo lookups | completes < 10 s, typo result identity-stable (cached) | **~4.5 s** cold worst case, 1,000/1,000 cache hits | ✅ |

> [!NOTE]
> S5 is an intentionally adversarial input: a single query containing all 10,000 words of the vocabulary. It runs the **live** `expandQuerySemantically` path, not the precomputed index, and it is the one test that dominates suite wall-clock time. Real queries are 1–6 tokens. The API layer should also enforce a query-length limit.

---

## Performance & Load Testing

### Benchmark scope & methodology

| Parameter | Value |
|:---|:---|
| Runtime | Node.js v26.8.1, Linux x64, **single process / single event loop** |
| Search space | 10,000 words, synthetic deterministic graph |
| Timer | `process.hrtime.bigint()` (nanosecond resolution), JIT warm-up before sampling |
| **CDN / edge cache** | ❌ **Disabled — no Cloudflare cache** |
| External caches | ❌ None (no Redis or Memcached). Only in-process LRU caches are active. |
| Clustering | ❌ None (no `cluster`, PM2 or horizontal replicas) |
| Database I/O | Mocked in-memory `fetchPool` (100 rows) to isolate application-layer cost |

> [!WARNING]
> Because the database is mocked, these numbers measure the **engine's own overhead**: NLP, expansion, coalescing, sessions and slicing. Real deployments add the Atlas round-trip (typically single-digit to tens of milliseconds) **once per new session**. Subsequent pages remain in memory. Equivalent queries that hit the Cloudflare edge never reach the origin.

### Concurrency ladder (1k → 20k concurrent searches)

[`scripts/concurrency-ladder.js`](./backend/scripts/concurrency-ladder.js) fires *N* searches at once through `Promise.all`, increasing *N* from 1,000 to 20,000 in 20 steps. The traffic mix is **60% hot queries** (5 trending terms, which exercises singleflight) and **40% long-tail queries** (distinct words spread across the vocabulary). Raw output is in [`concurrency-ladder-results.json`](./backend/concurrency-ladder-results.json). *Last run: 2026-10-20, Node v26.8.1, 12 logical cores, run with `--expose-gc`.*

| Test | Concurrency | Batch time (ms) | Throughput (QPS) | Mean (ms) | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Max (ms) | Heap (MB) |
|:---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1,000 | 77.51 | 12,901 | 29.21 | 28.53 | 49.26 | 52.27 | 55.66 | 77.20 | 27.3 |
| 2 | 2,000 | 127.12 | 15,733 | 64.69 | 63.09 | 114.99 | 120.60 | 124.80 | 126.75 | 60.4 |
| 3 | 3,000 | 149.79 | 20,028 | 79.52 | 76.79 | 134.77 | 141.84 | 147.53 | 149.32 | 56.2 |
| 4 | 4,000 | 182.84 | 21,876 | 95.82 | 94.21 | 162.61 | 171.38 | 179.61 | 182.15 | 63.9 |
| 5 | 5,000 | 216.58 | 23,086 | 116.06 | 114.73 | 194.28 | 204.74 | 213.09 | 215.76 | 71.7 |
| 6 | 6,000 | 253.59 | 23,660 | 127.76 | 122.37 | 219.56 | 234.43 | 247.71 | 252.61 | 93.9 |
| 7 | 7,000 | 312.09 | 22,429 | 167.84 | 166.33 | 282.33 | 296.44 | 307.35 | 310.98 | 96.1 |
| 8 | 8,000 | 343.16 | 23,313 | 177.89 | 173.64 | 297.90 | 315.26 | 331.89 | 342.05 | 103.0 |
| 9 | 9,000 | 428.32 | 21,013 | 223.93 | 212.18 | 381.06 | 402.89 | 421.78 | 427.24 | 115.9 |
| 10 | 10,000 | 391.81 | 25,522 | 213.47 | 209.31 | 350.51 | 369.85 | 385.23 | 390.57 | 122.5 |
| 11 | 11,000 | 426.54 | 25,789 | 227.81 | 224.19 | 378.68 | 400.10 | 417.22 | 423.07 | 139.1 |
| 12 | 12,000 | 503.62 | 23,827 | 265.02 | 260.09 | 442.80 | 470.01 | 492.78 | 501.69 | 136.3 |
| 13 | 13,000 | 476.16 | 27,302 | 253.18 | 250.16 | 420.37 | 446.08 | 467.54 | 474.36 | 151.2 |
| 14 | 14,000 | 513.28 | 27,276 | 276.32 | 272.02 | 457.83 | 483.14 | 505.06 | 512.02 | 151.6 |
| 15 | 15,000 | 594.68 | 25,224 | 310.68 | 301.56 | 524.39 | 555.13 | 582.12 | 591.35 | 163.0 |
| 16 | 16,000 | 592.08 | 27,023 | 314.01 | 307.92 | 521.93 | 552.19 | 577.58 | 586.08 | 156.7 |
| 17 | 17,000 | 610.33 | 27,854 | 324.49 | 317.92 | 539.35 | 571.53 | 598.69 | 608.22 | 179.1 |
| 18 | 18,000 | 666.61 | 27,002 | 348.35 | 340.17 | 585.39 | 621.74 | 653.70 | 664.50 | 185.4 |
| 19 | 19,000 | 672.24 | 28,264 | 360.37 | 356.09 | 597.54 | 631.55 | 660.57 | 669.63 | 186.0 |
| **20** | **20,000** | 705.07 | **28,366** ⬆ | 370.95 | 365.83 | 620.62 | 654.91 | 688.67 | 702.12 | 199.7 |

#### Headline numbers

| Metric | Value |
|:---|:---|
| Peak throughput (single process, **no edge cache**) | **28,366 QPS** at 20k concurrency |
| Sustained throughput plateau (≥ 13k concurrency) | **25–28k QPS** |
| Effective per-search CPU cost | **≈ 35 µs** (1 / 28.4k QPS) |
| 20,000 simultaneous searches drained in | **705 ms** |
| Errors / dropped requests across all 210,000 searches | **0** |
| Heap at 20k concurrency (20k live sessions with pools) | ~200 MB |

#### Reading the curve

- **Throughput scales, then plateaus.** QPS rises from 12.9k to 23k between 1k and 5k concurrency as V8 warms up and fixed per-batch overhead is amortised. It then climbs more slowly and settles at **25–28k QPS** from 13k concurrency upwards. This is the CPU ceiling of **one** event loop. Throughput never collapses as load increases, which means there is no lock contention, quadratic behaviour or GC thrashing. The dips at 7k, 9k and 12k are run-to-run noise (GC pauses landing inside a batch).
- **Latency here is queueing time, not service time.** All *N* requests are released in the same tick, so the last request waits for the N−1 ahead of it. That is why p99 ≈ batch duration and latency grows linearly with *N*. The actual service time is **~35 µs per search**. Against a real arrival process (Poisson rather than a burst), tail latency is far lower at the same QPS.
- **Heap is bounded.** Memory follows the number of live sessions (each holds a ranked pool and a `Set`), not request count. It grows roughly linearly from 27 MB to 200 MB, about 10 KB per live session. The production session LRU is capped at 5,000 entries with a 15-minute TTL.
- **Run-to-run variance.** An earlier run on the same machine peaked at 31.3k QPS. Expect about ±10% between runs depending on background load and GC timing.
- **Linear horizontal scaling.** The engine is stateless apart from session affinity, so `cluster` across *C* cores, or *R* replicas behind sticky routing, multiplies the plateau by roughly *C × R*. That figure is **before** counting edge-cache offload.

### Component micro-benchmarks (10,000-word search space)

These are per-function latencies from [`scripts/benchmark-10k.js`](./backend/scripts/benchmark-10k.js), exported to [`test-metrics-10k.json`](./backend/test-metrics-10k.json). The graph has 10,002 nodes and 115,734 adjacency entries.

| Function / process | Category | Samples | Mean | P50 | P95 | P99 | Max | Throughput |
|:---|:---|:---:|---:|---:|---:|---:|---:|---:|
| `normalizeToken` (clean) | NLP | 1,000 | 0.0002 ms | 0.0001 ms | 0.0002 ms | 0.0003 ms | 0.011 ms | 6.16 M ops/s |
| `normalizeToken` (symbols/emoji) | NLP | 1,000 | 0.0005 ms | 0.0003 ms | 0.0003 ms | 0.0005 ms | 0.184 ms | 2.12 M ops/s |
| `singularize` (regular plural) | NLP | 200 | 0.524 ms | 0.440 ms | 0.808 ms | 3.134 ms | 3.466 ms | 1,910 ops/s |
| `singularize` (irregular `-ies`) | NLP | 200 | 0.376 ms | 0.355 ms | 0.531 ms | 0.667 ms | 0.730 ms | 2,657 ops/s |
| `analyzeQuery` (1 word) | NLP | 100 | 0.274 ms | 0.264 ms | 0.324 ms | 0.506 ms | 0.506 ms | 3,653 ops/s |
| `analyzeQuery` (3 words) | NLP | 100 | 0.828 ms | 0.812 ms | 1.032 ms | 1.112 ms | 1.112 ms | 1,208 ops/s |
| `analyzeQuery` (6 words, noisy) | NLP | 100 | 2.274 ms | 2.249 ms | 2.595 ms | 2.658 ms | 2.658 ms | 440 ops/s |
| `extractCleanWords` (standard doc) | NLP · write | 100 | 9.081 ms | 8.944 ms | 10.262 ms | 10.552 ms | 10.552 ms | 110 ops/s |
| `rebuildGraph` (10k nodes) | Graph · write | 25 | 10.996 ms | 10.732 ms | 14.330 ms | 16.232 ms | 16.232 ms | 91 ops/s |
| `addEdges` (5 edges into 10k) | Graph · write | 500 | 0.0002 ms | 0.0001 ms | 0.0002 ms | 0.0003 ms | 0.016 ms | 5.06 M ops/s |
| Dijkstra Dial (hub, deg ≈ 40) | Dijkstra · write | 200 | 0.258 ms | 0.247 ms | 0.365 ms | 0.436 ms | 0.581 ms | 3,874 ops/s |
| Dijkstra Dial (mid, deg ≈ 12) | Dijkstra · write | 500 | 0.015 ms | 0.014 ms | 0.016 ms | 0.019 ms | 0.183 ms | 68,520 ops/s |
| Dijkstra Dial (leaf, deg ≈ 3) | Dijkstra · write | 500 | 0.0006 ms | 0.0006 ms | 0.0006 ms | 0.0008 ms | 0.006 ms | 1.69 M ops/s |
| LCS typo (1-char: `dragn`) | Typo | 50 | 0.064 ms | 0.071 ms | 0.079 ms | 0.126 ms | 0.126 ms | 15,695 ops/s |
| LCS typo (moderate: `castlee`) | Typo | 50 | 0.450 ms | 0.441 ms | 0.528 ms | 0.538 ms | 0.538 ms | 2,224 ops/s |
| LCS typo (full 10k miss scan) | Typo | 30 | 2.560 ms | 2.566 ms | 2.728 ms | 2.874 ms | 2.874 ms | 391 ops/s |
| `expandQuerySemantically` (1 word, live) | Expansion · live | 50 | 1.479 ms | 1.417 ms | 1.832 ms | 2.020 ms | 2.020 ms | 676 ops/s |
| `expandQuerySemantically` (3 words, live) | Expansion · live | 50 | 3.941 ms | 3.944 ms | 4.256 ms | 4.344 ms | 4.344 ms | 254 ops/s |
| `buildAtlasPipeline` (pre-expanded) | Ranking | 500 | 0.037 ms | 0.024 ms | 0.033 ms | 0.111 ms | 7.222 ms | 27,029 ops/s |
| `buildTextFallbackQuery` | Ranking | 1,000 | 0.0007 ms | 0.0006 ms | 0.0007 ms | 0.0027 ms | 0.034 ms | 1.46 M ops/s |
| `publicVisibilityFilter` | Utils | 1,000 | 0.0002 ms | 0.0002 ms | 0.0003 ms | 0.0004 ms | 0.005 ms | 5.73 M ops/s |
| `SearchBufferCache.get` (hit) | Cache | 1,000 | 0.0002 ms | 0.0002 ms | 0.0002 ms | 0.0004 ms | 0.007 ms | 5.46 M ops/s |
| `SearchBufferCache.set` (eviction) | Cache | 500 | 0.0005 ms | 0.0005 ms | 0.0007 ms | 0.0012 ms | 0.020 ms | 2.02 M ops/s |
| `wallpaperCardDTO` (batch 50) | DTO | 200 | 0.0027 ms | 0.001 ms | 0.011 ms | 0.015 ms | 0.024 ms | 366,324 ops/s |
| `sanitizeExpansions` (3 × 25 edges) | Ingestion | 500 | 0.0048 ms | 0.0037 ms | 0.0088 ms | 0.0116 ms | 0.027 ms | 207,960 ops/s |
| `findUnseenWords` (50 vs 10k) | Ingestion | 200 | 0.167 ms | 0.164 ms | 0.181 ms | 0.298 ms | 0.301 ms | 5,976 ops/s |

> [!TIP]
> **Why the precomputed index is faster on the read path.** The `Expansion · live` rows (1.5–3.9 ms) are the live-Dijkstra cost paid on **every** search when traversal is not precomputed. With the precomputed index, the same Dijkstra work (rows marked `· write`) runs only when the graph changes. The read path now does lookups into the precomputed index instead, which is how one process sustains ~28k searches/s.
>
> The micro-benchmark script still measures the live expansion path for comparison. Re-run `npm run benchmark` to refresh it.

### Running the benchmarks

```bash
cd backend

npm test                              # full suite: unit + SLA + high-perf + stress (122 tests)
node --test test/stress.test.js       # stress scenarios only
npm run benchmark                     # component micro-benchmarks -> test-metrics-10k.json
node --expose-gc scripts/concurrency-ladder.js   # 1k -> 20k ladder -> concurrency-ladder-results.json
npm run test:relevance                # golden-set relevance (P@10, MRR, nDCG@10)
node scripts/relevance-test.js --save before     # snapshot, then after a change:
node scripts/relevance-test.js --compare before  # A/B delta per query
```

`--expose-gc` lets the ladder force a GC between steps so that heap readings are comparable.

### Real HTTP Load Testing (`autocannon` on Atlas-Schema 10k Catalog)

While the in-process concurrency ladder measures raw algorithmic capability without network overhead, [`scripts/http-load-test.js`](./backend/scripts/http-load-test.js) runs **real HTTP requests over TCP** against the live Node.js HTTP server ([`src/server.js`](./backend/src/server.js)), querying a **10,000-document Atlas-schema catalog** ([`src/mockAtlasData.js`](./backend/src/mockAtlasData.js)). *Last run: 2026-10-20, Node v26.8.1, `autocannon@^8`, single process, no Cloudflare cache.*

The benchmark generates a **realistic traffic arrival mix** (28 request templates rotated by autocannon):
* **60% Trending / Hot Queries** (8 queries × 2 variants = 16 templates): `cyberpunk neon`, `dark fantasy dragon`, `anime warrior girl`, `minimalist landscape`, `space nebula galaxy`, `samurai sunset`, `mystic forest light`, `steampunk city` — each also tested with `deviceType=phone`
* **25% Long-Tail Queries** (8 templates): `phoenix fire blade`, `valkyrie celestial armor`, `shadow assassin moon`, `abyss underwater crystal`, `tundra frozen glacier`, `vortex storm lightning`, `shrine cherry blossom`, `golem ancient ruins`
* **5% Typo Fallback** (4 templates): `cybrpunk non`, `dragn castel`, `anme warir`, `sakura blosom` — triggering bitmask + LCS fallback
* **10% Multi-Page Pagination**: Sequential page requests (`page=2`, `page=3`) using session IDs primed before the benchmark, exercising in-memory session caching

#### HTTP Load Test Results (36,111 total HTTP requests · 0 errors · 0 timeouts)

| Scenario | Connections | Duration | Total Reqs | Arrival Rate (Req/s) | Avg Latency | P50 | P90 | **P95** | **P99** | P99.9 | Max | Throughput | Errors |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Scenario 1: Steady-State (15 CCU)** | 15 | 10.04 s | 11,561 | **1,156 req/s** | 12.52 ms | 15 ms | 17 ms | **18 ms** | **23 ms** | 36 ms | 76 ms | 2.31 MB/s | **0** |
| **Scenario 2: Peak High-Load (50 CCU)** | 50 | 10.11 s | 12,400 | **1,240 req/s** | 40.16 ms | 37 ms | 50 ms | **51.5 ms** | **66 ms** | 482 ms | 771 ms | 2.47 MB/s | **0** |
| **Scenario 3: Stress Surge (100 CCU)** | 100 | 10.25 s | 12,150 | **1,215 req/s** | 83.45 ms | 77 ms | 93 ms | **99.5 ms** | **121 ms** | 1,992 ms | 2,500 ms | 2.46 MB/s | **0** |

> Raw metrics exported to [`http-load-test-results.json`](./backend/http-load-test-results.json).

#### Key Observations Under Real HTTP Traffic

1. **Sub-23 ms P99 under steady traffic.** At 1,156 req/s (15 concurrent clients, `pipelining=1`), **P95 is 18 ms** and **P99 is 23 ms**. Semantic expansion, typo fallback, session management and JSON serialisation add negligible latency on top of Node's HTTP layer.
2. **Stable throughput under 3.3× concurrency increase.** Increasing connections from 15 → 50 → 100 raises latency (queueing) but throughput stays in the narrow **1,156–1,240 req/s** band. This is characteristic of a CPU-bound server with no contention: the event loop is fully utilised and additional connections queue rather than degrade.
3. **Tail latency is connection queueing.** P99.9 jumps from 36 ms (15 CCU) to 1,992 ms (100 CCU) because 100 clients contend for one event loop. The median stays at 77 ms even under 100 CCU, confirming that per-request service time is constant.
4. **100% Reliability.** Across all 36,111 HTTP request-response cycles — including typo queries, pagination lookups and device-filtered searches — the server maintained **0 errors, 0 dropped connections, and 0 timeouts**.
5. **Singleflight in action.** The 60% hot-query traffic share means most concurrent clients hit the same trending terms. Singleflight coalesces these into one `fetchPool` call, keeping latency flat despite the hot-key concentration.

#### Autocannon vs. In-Process Ladder

| Metric | In-Process Ladder | Autocannon HTTP |
|:---|:---:|:---:|
| What it measures | Engine overhead only (no TCP, no HTTP parsing, no JSON serialisation) | Full request lifecycle over TCP |
| Peak throughput | **28,366 QPS** | **1,240 req/s** |
| Bottleneck | CPU (expansion + session slice) | CPU + HTTP parsing + JSON `stringify` + TCP |
| Errors | 0 / 210,000 | 0 / 36,111 |

The ~23× gap between the two numbers is expected: autocannon pays the TCP + HTTP + JSON cost per request, and the 10k mock-Atlas search simulator scores candidates against the inverted token index on every new session, which the in-process ladder does not include.

To run the HTTP load test at any time:
```bash
cd backend
npm run test:load
```
*(If `MONGODB_URI` is provided in `backend/.env`, the server and test suite will automatically target your live Atlas cluster).*

---

### Search Relevance Results

Measured against a 25-query golden set (K = 10) using the 10k mock Atlas catalog.

| Metric | Score |
|:---|:---:|
| **Mean Precision@10** | **0.760** |
| **Mean MRR** | **0.941** |
| **Mean nDCG@10** | **0.944** |
| GOOD / OKAY / WEAK queries | **23 / 1 / 1** |

| Query type | P@10 | MRR | nDCG@10 |
|:---|:---:|:---:|:---:|
| Exact match (5) | 0.76 | 1.00 | 0.99 |
| Multi-word (5) | 0.94 | 1.00 | 1.00 |
| Category / style (6) | 0.97 | 1.00 | 1.00 |
| Semantic expansion (5) | 0.70 | 1.00 | 0.97 |
| Edge cases (2) | 0.90 | 1.00 | 0.99 |
| Typo tolerance (5) | 0.44 | 0.71 | 0.77 |

> [!NOTE]
> Typo queries score lower because min-cost aggregation lets the +1/+2 typo-inherited neighbors compete equally with the corrected word. Possible follow-up: give the matched dictionary word a cost-0 slot ahead of its inherited neighbors.

Raw relevance snapshots are saved in [`backend/relevance-results/`](./backend/relevance-results/). Use `npm run test:relevance -- --save <name>` and `--compare <name>` to track changes over time.

---

## Repository Structure

```text
EclipseSearch/
├── README.md
└── backend/
    ├── package.json
    ├── http-load-test-results.json         # Autocannon real HTTP load test metrics
    ├── concurrency-ladder-results.json     # 1k→20k concurrency ladder output
    ├── test-metrics-10k.json               # Component latency export (10k space)
    ├── benchmark-comparison/               # Saved benchmark comparison snapshots
    ├── relevance-results/                  # Saved relevance snapshots (--save / --compare)
    ├── docs/
    │   └── atlas-search.md                 # Atlas Search index definition
    ├── scripts/
    │   ├── http-load-test.js               # Autocannon realistic HTTP load test runner
    │   ├── relevance-test.js               # Golden-set relevance suite (P@K, MRR, nDCG, A/B compare)
    │   ├── backfill-semantic-graph.js      # Hydrate the graph from existing wallpapers
    │   ├── benchmark-10k.js                # Statistical micro-benchmark runner
    │   ├── concurrency-ladder.js           # 20-step concurrent load generator
    │   └── datasetGenerator.js             # Deterministic 10k-word dataset and graph
    ├── src/
    │   ├── index.js                        # HTTP server entrypoint
    │   ├── server.js                       # High-throughput search HTTP server
    │   ├── mockAtlasData.js                # 10k Atlas-schema dataset and search simulator
    │   ├── edge/
    │   │   └── searchCacheWorker.js        # Cloudflare Worker: query normalisation + SWR cache
    │   ├── models/
    │   │   ├── AiIngestionJob.js           # Ingestion and retry job schema
    │   │   └── SemanticNode.js             # Graph persistence schema
    │   ├── services/
    │   │   ├── aiGraphService.js           # AI provider chain; refreshes NeighborIndex on write
    │   │   ├── memoryGraph.js              # In-memory adjacency; builds NeighborIndex at startup
    │   │   ├── neighborIndex.js            # TypedArray top-K precomputed neighbor index
    │   │   ├── progressiveSearch.js        # Session-pooled batched pagination
    │   │   ├── singleflight.js             # In-flight request coalescer
    │   │   ├── searchBufferCache.js        # LRU and prefetch buffer
    │   │   ├── searchLifecycle.js          # Upload, edit and rename hooks
    │   │   ├── searchRanking.js            # Atlas pipeline builder; reads NeighborIndex
    │   │   ├── semanticDijkstra.js         # Dial's Dijkstra, LCS + bitmask prefilter + typo LRU
    │   │   ├── textNlp.js                  # Tokenise, singularise, stopwords
    │   │   └── wallpaperService.js         # Search execution and aggregation
    │   ├── utils/
    │   │   ├── visibilityFilter.js         # Public visibility predicates
    │   │   └── wallpaperDTO.js             # Client-safe projection
    │   └── workers/
    │       └── draftRetryWorker.js         # Exponential-backoff retry worker
    └── test/                               # 13 files · 122 tests
        ├── aiGraphService.test.js          (10)
        ├── draftWorkerLifecycle.test.js    (10)
        ├── highPerfSearch.test.js          (9)
        ├── latencyMetrics.test.js          (8)
        ├── memoryGraph.test.js             (10)
        ├── searchBufferCache.test.js       (8)
        ├── searchRanking.test.js           (12)
        ├── semanticDijkstra.test.js        (15)
        ├── stress.test.js                  (5)
        ├── textNlp.test.js                 (12)
        ├── visibilityFilter.test.js        (5)
        ├── wallpaperDTO.test.js            (8)
        └── wallpaperService.test.js        (10)
```

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **MongoDB** ≥ 6.0 (Atlas recommended for Atlas Search autocomplete)

### Install

```bash
cd backend
npm install
```

### Configure

Create `backend/.env`:

```env
PORT=5000
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/eclipsesearch
GEMINI_API_KEY=your_gemini_api_key
GROQ_API_KEY=your_groq_api_key
OPENAI_API_KEY=your_openai_api_key
```

### Edge worker (optional, recommended for production)

Deploy [`src/edge/searchCacheWorker.js`](./backend/src/edge/searchCacheWorker.js) as a Cloudflare Worker and set the `ORIGIN` environment variable to the backend URL. The worker:

- caches only `GET /api/search` requests **without** a `sessionId`, since session pages are user-specific
- normalises `q` by lower-casing, collapsing whitespace and sorting tokens, so equivalent queries share one entry
- sets `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`

---

## Atlas Search Index

Create an index named `wallpaper_search` on the `wallpapers` collection:

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "title": [
        { "type": "string" },
        { "type": "autocomplete", "tokenization": "edgeGram", "minGrams": 2, "maxGrams": 15, "foldDiacritics": true }
      ],
      "tags": [
        { "type": "string" },
        { "type": "autocomplete", "tokenization": "edgeGram", "minGrams": 2, "maxGrams": 15, "foldDiacritics": true }
      ],
      "categoryName": { "type": "string" },
      "excerpt": { "type": "string" },
      "style": { "type": "string" },
      "story": { "type": "string" },
      "status": { "type": "token" },
      "deviceType": { "type": "token" },
      "publishAt": { "type": "date" },
      "views": { "type": "number" },
      "downloadsCount": { "type": "number" },
      "category": { "type": "objectId" }
    }
  }
}
```

See [`docs/atlas-search.md`](./backend/docs/atlas-search.md) for details.

---

## Operational Notes & Known Limits

| Topic | Note |
|:---|:---|
| **Session affinity** | Progressive sessions live in process memory. Behind multiple replicas, route by `sessionId` (sticky sessions) or move the session store to a shared cache. |
| **Session memory** | Each session holds up to 200 rows plus a `Set`. The default LRU cap is 5,000 sessions with a 15-minute TTL. Size `max` from the available heap. |
| **Index consistency** | `NeighborIndex` updates synchronously inside the write path. Readers in the same process see the new neighbors immediately after the write resolves. Other replicas pick them up on restart or on their own ingestion events. |
| **Query length** | The live expansion path is linear in the number of tokens (see S5). Enforce a request-level limit, for example 64 characters or 8 tokens. |
| **Typo ranking** | With min-cost aggregation, typo-inherited neighbors can outrank the corrected word for short typos (`phenix`, `samuari`). Possible fix: give the corrected word a cost-0 slot. |
| **Typo-cache invalidation** | The bitmask dictionary and typo LRU are rebuilt automatically when the vocabulary size changes. |
| **Benchmark realism** | The ladder uses a mocked DB and burst arrivals on one process, **without Cloudflare caching**. Treat it as a measure of engine overhead, not end-to-end SLOs. |

---

## License

Private project developed for Eclipse Fantasy. All rights reserved.
