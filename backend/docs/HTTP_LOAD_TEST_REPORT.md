# HTTP Load Test Report — EclipseSearch v2

> Historical report from the earlier implementation, retained for comparison. These results were not rerun for the bug audit. The traffic percentages below were intended weights; the old script rotated unweighted templates. P95 values were interpolated from P90/P97.5, not measured. Use the [README](../../README.md#real-http-load-testing-autocannon-on-atlas-schema-10k-catalog) for the snapshot linked to retained JSON and current limitations.

**Date:** October 20, 2026  
**Load Testing Tool:** `autocannon v8.0.0`  
**Protocol:** Real HTTP/1.1 over TCP (`GET /api/search`)  
**Engine:** Node.js native `http` server + `NeighborIndex` + `singleflight` + `progressiveSearch`  
**Catalog Space:** 10,000 realistic wallpaper documents strictly matching MongoDB Atlas schema & `wallpaper_search` compound ranking  

---

## 1. Executive Summary

A real HTTP load test was performed across three traffic arrival scenarios ranging from steady state (15 CCU) to peak load (50 CCU) and stress surge (100 CCU). Over **35,514 total requests**, the server maintained **0% errors**, **0 timeouts**, and **sub-25 ms P99 latency** under steady-state traffic.

| Scenario | Arrival Rate | Average | P50 (Median) | P90 | **P95 (estimate)** | **P99** | Max | Errors |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Steady-State (15 CCU)** | **1,154 req/s** | 12.54 ms | 15.00 ms | 17.00 ms | **18.00 ms** | **24.00 ms** | 82 ms | **0** |
| **Peak Load (50 CCU)** | **1,208 req/s** | 41.31 ms | 37.00 ms | 51.00 ms | **54.00 ms** | **77.00 ms** | 753 ms | **0** |
| **Stress Surge (100 CCU)** | **1,190 req/s** | 84.47 ms | 81.00 ms | 90.00 ms | **100.50 ms** | **125.00 ms** | 2,436 ms | **0** |

---

## 2. Test Methodology & Traffic Model

Real-world search engines do not receive uniform synthetic queries. The benchmark uses a **production-realistic request distribution**:

```text
┌────────────────────────────────────────────────────────┐
│               Realistic Arrival Traffic Mix            │
├───────────────────────┬────────┬───────────────────────┤
│ Query Category        │ Share  │ Example / Purpose     │
├───────────────────────┼────────┼───────────────────────┤
│ Trending / Hot terms  │  60%   │ "cyberpunk neon"      │
│ Long-tail catalog     │  25%   │ "valkyrie armor sky"  │
│ Multi-page pagination │  10%   │ page=2, page=3 via SID│
│ Typo / Misspelling    │   5%   │ "dragn castel" (LCS)  │
└───────────────────────┴────────┴───────────────────────┘
```

* **Client Concurrency**: 15, 50, and 100 simultaneous concurrent connections.
* **HTTP Pipelining**: `1` (realistic browser behavior where queries are issued on interaction).
* **Payload verification**: Autocannon records HTTP status counts; it does not validate JSON bodies or page contents. Separate tests cover those assertions.

---

## 3. Comprehensive Percentile Breakdown

The table below details all recorded latency percentiles across the test scenarios:

| Metric | Scenario 1 (Steady-State 15 CCU) | Scenario 2 (Peak Load 50 CCU) | Scenario 3 (Stress Surge 100 CCU) |
| :--- | :---: | :---: | :---: |
| **Total Requests** | 11,539 reqs | 12,075 reqs | 11,900 reqs |
| **Duration** | 10.04 s | 10.12 s | 10.16 s |
| **Sustained Req/s** | **1,153.91 req/s** | **1,207.50 req/s** | **1,190.00 req/s** |
| **Throughput** | 2.30 MB/s | 2.44 MB/s | 2.42 MB/s |
| **Min Latency** | 1.00 ms | 2.00 ms | 2.00 ms |
| **P50 (Median)** | **15.00 ms** | **37.00 ms** | **81.00 ms** |
| **P90** | 17.00 ms | 51.00 ms | 90.00 ms |
| **P95 (estimate)** | **18.00 ms** | **54.00 ms** | **100.50 ms** |
| **P97.5** | 19.00 ms | 57.00 ms | 111.00 ms |
| **P99** | **24.00 ms** | **77.00 ms** | **125.00 ms** |
| **P99.9** | 38.00 ms | 429.00 ms | 1,992.00 ms |
| **Max Latency** | 82.00 ms | 753.00 ms | 2,436.00 ms |
| **Standard Deviation**| 5.84 ms | 22.16 ms | 102.18 ms |
| **HTTP 2xx Success** | **11,539 (100%)** | **12,075 (100%)** | **11,900 (100%)** |
| **Errors / Timeouts** | **0 / 0** | **0 / 0** | **0 / 0** |

---

## 4. Current implementation notes

The index precomputes hop-bounded graph distances when writes occur. Live sessions retain ranked IDs and hydrate requested pages from MongoDB, rechecking visibility; mock sessions slice cached rows. These historical timings do not measure live database queries or establish the cause of tail latency. Typo matching uses a safe disjoint-alphabet check and at most two fallback attempts, including misses.

---

## 5. How to Reproduce

Run the automated load test suite against the local HTTP search server:

```bash
cd backend
npm run test:load
```

To target a live MongoDB Atlas cluster, export `MONGODB_URI` into the process environment (a `.env` file alone is not loaded):

```env
PORT=5000
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/eclipsesearch
```

Then rerun `npm run test:load`. The script uses the configured database and fails if startup cannot initialize it.
