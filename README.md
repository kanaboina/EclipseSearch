# 🌒 Eclipse Fantasy Semantic Search Engine

[![Tests](https://img.shields.io/badge/Tests-18%20Passing-brightgreen.svg)](file:///backend/test/)
[![Node Version](https://img.shields.io/badge/Node-%3E%3D18-blue.svg)](https://nodejs.org/)
[![Database](https://img.shields.io/badge/MongoDB-Atlas%20Search-green.svg)](https://www.mongodb.com/atlas/database)
[![AI Integration](https://img.shields.io/badge/AI-Gemini%20%7C%20Groq%20%7C%20OpenAI-orange.svg)](file:///backend/src/services/aiGraphService.js)

A high-performance, deterministic semantic search engine and associative knowledge graph built specifically for fantasy, anime, and artistic wallpaper catalogs. 

Combines lightweight in-memory graph traversal (**Dial's Bounded Dijkstra**), **compromise** NLP tokenization, and **MongoDB Atlas Search** compound pipelines with a resilient multi-provider AI expansion fallback chain.

---

## 🌟 Key Architecture & Highlights

```mermaid
flowchart TD
    UserQuery([User Search Query]) --> NLP[NLP Tokenizer & PoS Analyzer\n(textNlp.js)]
    NLP --> Dijkstra[Dial's Bounded Dijkstra\n(semanticDijkstra.js)]
    
    subgraph GraphMemory [Semantic Memory Layer]
        MemoryGraph[(In-Memory Adjacency Graph)] <--> MongoNodes[(MongoDB SemanticNode Collection)]
        AIFallback[Multi-Provider AI Expansion\nGemini 2.5 Flash / Groq / OpenAI] -.-> MemoryGraph
    end
    
    Dijkstra <--> MemoryGraph
    Dijkstra --> RankedTerms[Ranked & Weighted Expansion Terms]
    
    RankedTerms --> SearchEngine{Search Engine Pipeline}
    SearchEngine -->|Atlas Search| CompoundAtlas[Atlas Compound Pipeline\nAutocomplete + Must/Should Boosts]
    SearchEngine -->|Fallback| MongoText[$text Search Pipeline]
    
    CompoundAtlas --> Visibility[Public Visibility Filter\n(visibilityFilter.js)]
    MongoText --> Visibility
    
    Visibility --> CacheBuffer[LRU Buffer & Prefetch Cache\n(searchBufferCache.js)]
    CacheBuffer --> Results([Zero-Duplicate Paginated DTOs])
```

- **Graph-Powered Query Expansion**: Evaluates relationships across synonyms, hyponyms, hypernyms, siblings, moods, aesthetics, and scene descriptors.
- **Dial's Bounded Dijkstra (0..6 cost, max 2 hops)**: Deterministic, integer-bucket graph search with hop friction to prevent generic semantic drift.
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
    ├── scripts/
    │   └── backfill-semantic-graph.js  # Batch utility to hydrate graph from DB
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
        ├── aiGraphService.test.js      # AI provider & sanitization tests
        ├── searchService.test.js       # Atlas pipeline & cache tests
        └── semanticDijkstra.test.js    # Dijkstra, weights & NLP tests
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

## 🧪 Testing

The test suite runs with Node's native test runner (`node --test`), requiring zero heavy test framework dependencies:

```bash
cd backend
npm test
```

### Test Coverage Highlights:
- **Provider Fallback**: Graceful handover across Gemini, Groq, and fallback errors.
- **Edge Sanitization**: Rejection of self-loops, bad weights, and duplicate relations.
- **Dial's Algorithm**: Respect of maxCost 6, maxHops 2, and hop-friction penalties.
- **Multi-Source Intersections**: Multi-term expansion (e.g. *dark sky wolf* $\rightarrow$ *night, cloud, fenrir*).
- **Zero-Duplicate Pagination**: Cursor-based prefetch buffer validation.
- **Data Protection**: Strict field projection preventing private parameter leakage.

---

## 🛠️ Graph Hydration & Backfill

To seed or backfill the semantic graph from existing wallpaper data in your database:

```bash
cd backend
npm run backfill:semantic
```

---

## ⚖️ License

Private project developed for Eclipse Fantasy. All rights reserved.
