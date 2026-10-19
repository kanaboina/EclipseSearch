# 🌒 Eclipse Fantasy Semantic Search Engine

[![Tests](https://img.shields.io/badge/Tests-108%20Passing-brightgreen.svg)](./backend/test/)
[![Node Version](https://img.shields.io/badge/Node-%3E%3D18-blue.svg)](https://nodejs.org/)
[![Database](https://img.shields.io/badge/MongoDB-Atlas%20Search-green.svg)](https://www.mongodb.com/atlas/database)
[![AI Integration](https://img.shields.io/badge/AI-Gemini%20%7C%20Groq%20%7C%20OpenAI-orange.svg)](./backend/src/services/aiGraphService.js)

A high-performance, deterministic semantic search engine and associative knowledge graph built specifically for fantasy, anime, and artistic wallpaper catalogs. 

Combines lightweight in-memory graph traversal (**Dial's Bounded Dijkstra**), **compromise** NLP tokenization, and **MongoDB Atlas Search** compound pipelines with a resilient multi-provider AI expansion fallback chain.

---

## 🌟 Key Architecture & Highlights

```mermaid
flowchart TD
    UserQuery(["User Search Query"]) --> NLP["NLP Tokenizer & PoS Analyzer<br/>(textNlp.js)"]
    NLP --> Dijkstra["Dial's Bounded Dijkstra<br/>(semanticDijkstra.js)"]
    
    subgraph GraphMemory ["Semantic Memory Layer"]
        MemoryGraph[("In-Memory Adjacency Graph")] <--> MongoNodes[("MongoDB SemanticNode Collection")]
        AIFallback["Multi-Provider AI Expansion<br/>(Gemini 2.5 Flash / Groq / OpenAI)"] -.-> MemoryGraph
    end
    
    Dijkstra <--> MemoryGraph
    Dijkstra --> RankedTerms["Ranked & Weighted Expansion Terms"]
    
    RankedTerms --> SearchEngine{"Search Engine Pipeline"}
    SearchEngine -->|Atlas Search| CompoundAtlas["Atlas Compound Pipeline<br/>(Autocomplete + Must/Should Boosts)"]
    SearchEngine -->|Fallback| MongoText["MongoDB $text Search Pipeline"]
    
    CompoundAtlas --> Visibility["Public Visibility Filter<br/>(visibilityFilter.js)"]
    MongoText --> Visibility
    
    Visibility --> CacheBuffer["LRU Buffer & Prefetch Cache<br/>(searchBufferCache.js)"]
    CacheBuffer --> Results(["Zero-Duplicate Paginated DTOs"])
```

- **Graph-Powered Query Expansion**: Evaluates relationships across synonyms, hyponyms, hypernyms, siblings, moods, aesthetics, and scene descriptors.
- **Dial's Bounded Dijkstra (0..6 cost, max 2 hops)**: Deterministic, integer-bucket graph search with hop friction to prevent generic semantic drift.
- **Normalized LCS Typo Fallback**: Query words missing from the graph (typos, unseen words) are matched to the closest graph word using the Sørensen–Dice LCS score `2·LCS(A,B) / (|A|+|B|)`. DP uses pre-allocated `Uint8Array(64)` rows (no per-candidate heap allocation) with O(1) branch-and-bound pruning. A match with similarity ≥ 0.80 starts Dijkstra at cost 1, one with similarity 0.55–0.80 starts at cost 2, and anything lower is ignored.
- **Resilient AI Ingestion**: Multi-LLM provider fallback chain (`Gemini 2.5 Flash` → `Groq Llama-3.3-70b` → `OpenAI`) for building graph edges when new terms are introduced.
- **Zero-Downtime Draft Protection**: If AI expansion is temporarily unavailable upon wallpaper upload, wallpapers are cleanly staged in draft state with an asynchronous exponential-backoff retry worker.
- **Strict Public Visibility & DTO Projections**: Enforces status, deletion checks, and publish dates at the query level; sanitizes internal metadata from card payloads.
- **Atlas Search + Deterministic Fallback**: Native autocomplete edge-grams with seamless fallback to MongoDB `$text` search.

---

## 📁 Repository Structure

```
EclipseSearch/
├── .gitignore
├── README.md
└── backend/
    ├── docs/
    │   └── atlas-search.md             # MongoDB Atlas Search index definition
    ├── package.json
    ├── test-metrics-10k.json           # Detailed 10k-word latency benchmarks JSON export
    ├── scripts/
    │   ├── backfill-semantic-graph.js  # Batch utility to hydrate graph from DB
    │   ├── benchmark-10k.js            # Latency benchmark suite runner across 10k search space
    │   └── datasetGenerator.js         # Deterministic 10,000-word dataset and graph generator
    ├── src/
    │   ├── models/
    │   │   ├── AiIngestionJob.js       # Background ingestion & retry schema
    │   │   └── SemanticNode.js         # Semantic graph persistence schema
    │   ├── services/
    │   │   ├── aiGraphService.js       # AI provider fallback & edge builder
    │   │   ├── memoryGraph.js          # In-memory graph representation
    │   │   ├── searchBufferCache.js    # LRU cache & pagination prefetch buffer
    │   │   ├── searchLifecycle.js      # Upload/edit/rename lifecycle hooks
    │   │   ├── searchRanking.js        # Search query scoring & boost builder
    │   │   ├── semanticDijkstra.js     # Dial's algorithm implementation
    │   │   ├── textNlp.js              # NLP parsing, singularize, stopwords
    │   │   └── wallpaperService.js     # Search execution & aggregation
    │   ├── utils/
    │   │   ├── visibilityFilter.js     # Public safety & status match filters
    │   │   └── wallpaperDTO.js         # Client-safe card data sanitization
    │   └── workers/
    │       └── draftRetryWorker.js     # Background retry queue processor
    └── test/
        ├── aiGraphService.test.js          # AI provider failover & edge sanitization (10 tests)
        ├── draftWorkerLifecycle.test.js    # Exponential backoff & lifecycle hooks (10 tests)
        ├── latencyMetrics.test.js          # 10,000-word search space SLA regression tests (8 tests)
        ├── memoryGraph.test.js             # Directed weights & graph operations (10 tests)
        ├── searchBufferCache.test.js       # LRU eviction & TTL cache (8 tests)
        ├── searchRanking.test.js           # Atlas compound & $text fallback (12 tests)
        ├── semanticDijkstra.test.js        # Dial's algorithm, penalties & LCS typos (15 tests)
        ├── textNlp.test.js                 # Tokenization, singularization & stopwords (12 tests)
        ├── visibilityFilter.test.js        # Status & deletion safety filters (5 tests)
        ├── wallpaperDTO.test.js            # Security field stripping & projection (8 tests)
        └── wallpaperService.test.js        # Pagination, prefetching & deduplication (10 tests)
```

---

## 🚀 Getting Started

### 1. Prerequisites

- **Node.js**: `v18.0.0` or higher
- **MongoDB**: `v6.0+` (MongoDB Atlas recommended for Atlas Search autocomplete)

### 2. Installation

```bash
cd backend
npm install
```

### 3. Environment Configuration

Create a `.env` file inside `backend/`:

```env
PORT=5000
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/eclipsesearch
GEMINI_API_KEY=your_gemini_api_key
GROQ_API_KEY=your_groq_api_key
OPENAI_API_KEY=your_openai_api_key
```

---

## 🔍 Atlas Search Index Setup

For full-text autocomplete with edge-grams, configure the `wallpaper_search` index on your `wallpapers` collection in MongoDB Atlas:

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

---

## 🧪 Testing & Analysis Report

The test suite runs with Node's native test runner (`node --test`), requiring zero external test framework dependencies:

```bash
cd backend
npm test
```

### 📊 Test Suite Execution Summary

```
Total Tests:     108
Passed:          108
Failed:            0
Skipped:           0
Duration:       ~766 ms
Pass Rate:        100%
```

| Test Suite | Tests | Status | Target Component & Verification Focus |
|:---|:---:|:---:|:---|
| `testNlp.test.js` | 12 | ✅ PASS | NLP singularization (`-ies`, `-shes`, `-ches`, `-xes`), irregulars, general & domain stopwords, token normalization. |
| `memoryGraph.test.js` | 10 | ✅ PASS | Directed asymmetric weights (hyponym 2/4, hypernym 4/2), symmetric relations, self-loop pruning, 1..6 range clamp, graph rebuild & init. |
| `semanticDijkstra.test.js` | 15 | ✅ PASS | PoS miss penalties (noun 15, adjective 6, domain stopword 1), Dial's bucket queue, hop friction (+1 on hop 2), maxCost 6 & maxHops 2 cutoff, Sørensen–Dice LCS typo fallback (similarity ≥0.80 & 0.55..0.80). |
| `searchBufferCache.test.js` | 8 | ✅ PASS | LRU eviction ordering, TTL expiry eviction, cache hit promotion, generation incrementing, global singleton cache invalidation. |
| `wallpaperDTO.test.js` | 8 | ✅ PASS | Strict data protection: strips `story`, `downloadKeys`, `downloadBucket`, `uuid`, `downloads`, `conversionJournal`; safe category projection & URL fallbacks. |
| `visibilityFilter.test.js` | 5 | ✅ PASS | Strict draft rejection (`status: { $ne: 'draft' }`), deletion pending check (`deletionPending: { $ne: true }`), publish date validation. |
| `searchRanking.test.js` | 12 | ✅ PASS | Primary weights (title 10, tags 8, categoryName 7), Atlas compound pipeline with `minimumShouldMatch: 1`, fuzzy edge-gram autocomplete, deterministic sort, MongoDB `$text` fallback failover. |
| `wallpaperService.test.js` | 10 | ✅ PASS | Multi-page traversal with **zero duplicate IDs**, prefetch buffer activation at threshold (<25 remaining), buffer expansion for jump pages, device-isolated cache partitions. |
| `aiGraphService.test.js` | 10 | ✅ PASS | Structured LLM prompt generation, edge sanitization, weight clamping, multi-provider failover chain, unseen word deduplication, safe draft fallback on total provider failure. |
| `draftWorkerLifecycle.test.js` | 10 | ✅ PASS | Exponential backoff progression (2m, 4m, 8m ... max 60m), atomic pending job claiming, wallpaper publication on retry, permanent failure ceiling after 10 attempts, lifecycle edit hooks. |
| `latencyMetrics.test.js` | 8 | ✅ PASS | Performance SLA regression tests over a simulated **10,000-word search space**: Dijkstra < 2ms, LCS branch-and-bound < 2ms, cache < 0.05ms, DTO batch < 0.2ms. |

---

## ⚡ Performance & Latency Benchmark (10,000-Word Search Space)

To validate production readiness under enterprise scale, the engine includes a dedicated statistical latency benchmark suite (`npm run test:metrics` / `npm run benchmark`) simulating a **10,000-word vocabulary search space** (10,000 nodes, 57,991 directed relations, and 115,734 bidirectional graph adjacency entries).

All metrics were captured using `process.hrtime.bigint()` (nanosecond precision) with warmup iterations to achieve V8 JIT steady-state:

### 📈 Latency Metrics Table by Process & Function

| Function / Process | Category | Samples | Mean (Avg) | P50 (Median) | P95 | P99 | Maximum | Throughput |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`singularize` (regular plural)** | NLP | 200 | **0.511 ms** | 0.454 ms | 0.792 ms | 1.923 ms | **2.457 ms** | 1,958 ops/s |
| **`singularize` (irregular -ies)** | NLP | 200 | **0.376 ms** | 0.354 ms | 0.531 ms | 0.667 ms | **0.730 ms** | 2,657 ops/s |
| **`singularize` (irregular -ches)** | NLP | 200 | **0.412 ms** | 0.388 ms | 0.617 ms | 0.733 ms | **0.808 ms** | 2,426 ops/s |
| **`singularize` (non-singular -ss)** | NLP | 200 | **0.293 ms** | 0.272 ms | 0.458 ms | 0.553 ms | **0.560 ms** | 3,407 ops/s |
| **`singularize` (short/num token)** | NLP | 200 | **0.0001 ms** | 0.0001 ms | 0.0001 ms | 0.0003 ms | **0.0088 ms** | 10,212,940 ops/s |
| **`normalizeToken` (clean)** | NLP | 1,000 | **0.0002 ms** | 0.0001 ms | 0.0002 ms | 0.0002 ms | **0.011 ms** | 6,162,607 ops/s |
| **`normalizeToken` (dirty symbols/emoji)** | NLP | 1,000 | **0.001 ms** | 0.0003 ms | 0.0003 ms | 0.001 ms | **0.184 ms** | 2,115,440 ops/s |
| **`extractCleanWords` (standard doc)** | NLP | 100 | **9.081 ms** | 8.944 ms | 10.262 ms | 10.552 ms | **10.552 ms** | 110 ops/s |
| **`extractCleanWords` (dense doc)** | NLP | 100 | **14.799 ms** | 14.849 ms | 16.341 ms | 18.289 ms | **18.289 ms** | 68 ops/s |
| **`analyzeQuery` (1-word entity)** | NLP | 100 | **0.274 ms** | 0.264 ms | 0.324 ms | 0.506 ms | **0.506 ms** | 3,653 ops/s |
| **`analyzeQuery` (3-word entity)** | NLP | 100 | **0.828 ms** | 0.812 ms | 1.032 ms | 1.112 ms | **1.112 ms** | 1,208 ops/s |
| **`analyzeQuery` (6-word noisy query)** | NLP | 100 | **2.274 ms** | 2.249 ms | 2.595 ms | 2.658 ms | **2.658 ms** | 440 ops/s |
| **`rebuildGraph` (hydrate 10,000 nodes)** | MemoryGraph | 25 | **10.996 ms** | 10.732 ms | 14.330 ms | 16.232 ms | **16.232 ms** | 91 ops/s |
| **`addEdges` (insert 5 edges into 10k)** | MemoryGraph | 500 | **0.0002 ms** | 0.0001 ms | 0.0002 ms | 0.0002 ms | **0.016 ms** | 5,057,811 ops/s |
| **`directedWeights` (hyponym/hypernym)**| MemoryGraph | 1,000 | **0.0001 ms** | 0.0001 ms | 0.0001 ms | 0.0001 ms | **0.003 ms** | 18,107,085 ops/s |
| **`Dijkstra Dial` (hub node, degree ~40)** | Dijkstra | 200 | **0.258 ms** | 0.247 ms | 0.365 ms | 0.436 ms | **0.581 ms** | 3,874 ops/s |
| **`Dijkstra Dial` (mid node, degree ~12)** | Dijkstra | 500 | **0.015 ms** | 0.014 ms | 0.016 ms | 0.019 ms | **0.183 ms** | 68,520 ops/s |
| **`Dijkstra Dial` (leaf node, degree ~3)** | Dijkstra | 500 | **0.001 ms** | 0.001 ms | 0.001 ms | 0.001 ms | **0.006 ms** | 1,694,737 ops/s |
| **`findClosestWord` (1-char typo: dragn)** | LCS | 50 | **0.064 ms** | 0.071 ms | 0.079 ms | 0.126 ms | **0.126 ms** | 15,695 ops/s |
| **`findClosestWord` (moderate: castlee)** | LCS | 50 | **0.450 ms** | 0.441 ms | 0.528 ms | 0.537 ms | **0.537 ms** | 2,224 ops/s |
| **`findClosestWord` (full 10k miss scan)** | LCS | 30 | **2.560 ms** | 2.566 ms | 2.728 ms | 2.874 ms | **2.874 ms** | 391 ops/s |
| **`expandQuerySemantically` (1 word)** | Expansion | 50 | **1.479 ms** | 1.417 ms | 1.832 ms | 2.020 ms | **2.020 ms** | 676 ops/s |
| **`expandQuerySemantically` (3 words)** | Expansion | 50 | **3.941 ms** | 3.943 ms | 4.256 ms | 4.344 ms | **4.344 ms** | 254 ops/s |
| **`expandQuerySemantically` (typo+exact)** | Expansion | 30 | **2.862 ms** | 2.796 ms | 3.682 ms | 4.601 ms | **4.601 ms** | 349 ops/s |
| **`buildAtlasPipeline` (pre-expanded)** | Ranking | 500 | **0.037 ms** | 0.024 ms | 0.033 ms | 0.111 ms | **7.222 ms** | 27,029 ops/s |
| **`buildAtlasPipeline` (inline 10k)** | Ranking | 30 | **1.013 ms** | 0.998 ms | 1.314 ms | 1.327 ms | **1.327 ms** | 987 ops/s |
| **`buildTextFallbackQuery`** | Ranking | 1,000 | **0.001 ms** | 0.001 ms | 0.001 ms | 0.003 ms | **0.034 ms** | 1,457,539 ops/s |
| **`SearchBufferCache.set`** | Cache | 1,000 | **0.0002 ms** | 0.0001 ms | 0.0003 ms | 0.001 ms | **0.010 ms** | 3,181,896 ops/s |
| **`SearchBufferCache.get` (hit)** | Cache | 1,000 | **0.0002 ms** | 0.0001 ms | 0.0003 ms | 0.0005 ms | **0.007 ms** | 5,460,960 ops/s |
| **`SearchBufferCache.get` (miss)** | Cache | 1,000 | **0.0001 ms** | 0.0001 ms | 0.0001 ms | 0.0001 ms | **0.003 ms** | 19,548,431 ops/s |
| **`SearchBufferCache.set` (>200 eviction)**| Cache | 500 | **0.0008 ms** | 0.0006 ms | 0.001 ms | 0.001 ms | **0.020 ms** | 2,020,635 ops/s |
| **`wallpaperCardDTO` (single card)** | DTO | 1,000 | **0.0003 ms** | 0.0001 ms | 0.001 ms | 0.004 ms | **0.030 ms** | 2,517,015 ops/s |
| **`wallpaperCardDTO` (batch 50 cards)** | DTO | 200 | **0.003 ms** | 0.001 ms | 0.011 ms | 0.015 ms | **0.024 ms** | 366,324 ops/s |
| **`searchService.search` (cold query)** | Service | 100 | **0.006 ms** | 0.005 ms | 0.011 ms | 0.028 ms | **0.028 ms** | 156,341 ops/s |
| **`searchService.search` (warm query)** | Service | 500 | **0.006 ms** | 0.005 ms | 0.006 ms | 0.013 ms | **0.035 ms** | 173,504 ops/s |
| **`searchService.search` (page 2 slice)**| Service | 500 | **0.006 ms** | 0.006 ms | 0.006 ms | 0.030 ms | **0.045 ms** | 161,426 ops/s |
| **`sanitizeExpansions` (3x25 edges)** | Ingestion | 500 | **0.005 ms** | 0.004 ms | 0.009 ms | 0.012 ms | **0.026 ms** | 207,960 ops/s |
| **`findUnseenWords` (50 terms vs 10k)** | Ingestion | 200 | **0.167 ms** | 0.164 ms | 0.181 ms | 0.298 ms | **0.301 ms** | 5,976 ops/s |

### 🔬 Key Latency Observations

- **Dial's Algorithm Efficiency**: Traversing connected subgraphs with max cost 6 and max 2 hops takes **0.015 ms to 0.258 ms** even in a 10,000-node graph.
- **LCS Branch-and-Bound**: Early pruning drops typo matching to **0.064 ms** for high-similarity matches. Worst-case full scans over all 10k words cap out at **~2.5 ms**.
- **NLP Ingestion vs Traversal**: Full prose tokenization (`extractCleanWords`) on wallpaper descriptions takes **9 ms to 15 ms** due to compromise's PoS tagging, while search-time query normalization (`analyzeQuery`) executes in **0.27 ms to 0.83 ms**.
- **Zero Serialization Bottlenecks**: The `wallpaperCardDTO` transformation of 50 cards takes just **0.003 ms**, running at over **366,000 operations/sec**.

### 🏃 Running the Benchmarks

```bash
cd backend

# Execute full statistical benchmark runner (generates test-metrics-10k.json)
npm run test:metrics
# or
npm run benchmark

# Execute the complete unit test & SLA verification suite
npm test
```

---

## ⚖️ License

Private project developed for Eclipse Fantasy. All rights reserved.
