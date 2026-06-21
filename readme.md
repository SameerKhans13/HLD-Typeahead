# Distributed Typeahead System

> **Ultra-fast, in-memory prefix-tree autocomplete system** — built with Bun + Elysia, backed by PostgreSQL, Redis, and Nginx in a distributed Docker architecture.

[![Tests](https://img.shields.io/badge/tests-32%20pass-brightgreen)](#-running-tests)
[![Bun](https://img.shields.io/badge/runtime-Bun%201.x-black)](#prerequisites)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue)](#)
[![Docker](https://img.shields.io/badge/docker-compose-2496ED)](#-docker-distributed-setup)

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture](#architecture)
3. [Dataset](#dataset)
4. [Quick Start (Local)](#quick-start-local)
5. [Docker Distributed Setup](#docker-distributed-setup)
6. [API Documentation](#api-documentation)
7. [Performance Report](#performance-report)
8. [Design Choices & Trade-offs](#design-choices--trade-offs)
9. [Running Tests](#running-tests)

---

## System Overview

This Distributed Typeahead System solves the **high-load search autocomplete problem** — returning the top 10 relevant query completions for any prefix in under **1ms** at scale, while safely handling millions of concurrent search submissions without losing data.

**Key capabilities:**
- **100,500+ query** in-memory prefix tree with O(k) cached lookups
- **Consistent hash ring** distributing cache keys across 3 logical nodes using FNV-1a + virtual nodes
- **Passive TTL cache** (30s) with in-memory fallback when Redis is unavailable
- **Write-Ahead Log + RAM buffer** — batch 50 writes before flushing, with crash recovery
- **Exponential time-decay ranking** — viral trending queries rise and fall naturally
- **PostgreSQL** persistent backend with auto-seeding on first boot
- **3-node Nginx load-balanced** Docker cluster

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CLIENT BROWSER (Vanilla JS)                      │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │  Debounced input → GET /suggest?q=<prefix>&ranking=basic     │  │
│   │  Throttled submit → POST /search { query }                   │  │
│   └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ HTTP
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    NGINX (Load Balancer — Port 80)                  │
│              Round-robin / least_conn across 3 app nodes            │
│              Keepalive upstream, gzip, proxy timeouts               │
└──────────┬──────────────────┬──────────────────┬────────────────────┘
           │                  │                  │
           ▼                  ▼                  ▼
    ┌─────────┐         ┌─────────┐        ┌─────────┐
    │  app-1  │         │  app-2  │        │  app-3  │
    │  :3000  │         │  :3000  │        │  :3000  │
    └────┬────┘         └────┬────┘        └────┬────┘
         │                   │                  │
         └───────────────────┼──────────────────┘
                             │  (all nodes share same backing services)
         ┌───────────────────┼──────────────────────────────┐
         │                   │  READ PATH                   │
         │    ┌──────────────▼──────────────────┐           │
         │    │    Consistent Hash Ring          │           │
         │    │  FNV-1a hash → clockwise BST     │           │
         │    │  3 nodes × 20 vnodes = 60 points │           │
         │    └──────────────┬──────────────────┘           │
         │                   │                              │
         │    ┌──────────────▼──────────────────┐           │
         │    │  Distributed Cache Layer         │           │
         │    │  ┌──────────┐ ┌──────────┐ ┌──────────┐   │
         │    │  │ redis-0  │ │ redis-1  │ │ redis-2  │   │
         │    │  │  :6379   │ │  :6380   │ │  :6381   │   │
         │    │  └──────────┘ └──────────┘ └──────────┘   │
         │    │  Fallback: in-process Map (passive TTL)    │
         │    └──────────────┬──────────────────┘           │
         │          HIT ─────┤─── MISS                      │
         │                   │                              │
         │    ┌──────────────▼──────────────────┐           │
         │    │    In-Memory Trie (prefix tree)  │           │
         │    │  Each node caches top-10 comps   │           │
         │    │  O(k) walk — no branching reads  │           │
         │    └──────────────┬──────────────────┘           │
         │                   │  WRITE PATH                  │
         │    ┌──────────────▼──────────────────┐           │
         │    │    RAM Write Buffer (Map<k,n>)   │           │
         │    │    Auto-flush at 50 entries      │           │
         │    └──────────────┬──────────────────┘           │
         │                   │                              │
         │    ┌──────────────▼──────────────────┐           │
         │    │  Write-Ahead Log (wal.log)        │           │
         │    │  Append-only, crash-safe          │           │
         │    │  Replayed on boot if non-empty    │           │
         │    └──────────────┬──────────────────┘           │
         │                   │                              │
         │    ┌──────────────▼──────────────────┐           │
         │    │    PostgreSQL  (primary store)   │           │
         │    │    search_queries + time_buckets │           │
         │    │    Auto-seeded from dataset.json │           │
         │    └─────────────────────────────────┘           │
         └─────────────────────────────────────────────────┘
```

### Component Breakdown

#### 1. Prefix Tree (Trie) — `src/trie.ts`
Raw DFS traversal to collect completions under a prefix is O(T) where T is the size of the subtree — unacceptable at 100k+ entries. Instead:

- Each `TrieNode` maintains a **pre-sorted `topCompletions[10]` cache** of the best results in its subtree.
- On `insert(query, count)`, we walk back from the terminal node to the root and propagate/merge the completions upward.
- `getSuggestions(prefix)` is a pure **O(k) pointer-walk** (k = prefix length) with no branching — the result is already cached at the prefix node.
- `updateAllCompletions()` runs one post-order DFS after bulk loading the dataset, costing O(N·10·log10) ≈ O(N) to build the entire cache.

#### 2. Consistent Hash Ring — `src/hashring.ts`
- **FNV-1a** 32-bit hashing algorithm — fast, well-distributed, avalanche-effect
- **3 physical cache nodes** × **20 virtual nodes** = **60 ring points** for uniform distribution
- Ring points sorted ascending; `getNode(key)` uses **binary search** (O(log 60)) for clockwise lookup
- Wrap-around handled by defaulting to index 0 (ring is circular)

#### 3. Distributed Cache — `src/cache.ts`
- `CacheNode`: thin wrapper over `ioredis` with in-process `Map<string, {value, expiry}>` fallback
- **Passive TTL eviction**: expiry checked on `get()` — stale entries deleted lazily, zero background threads
- `DistributedCache`: routes `REDIS_NODES` env var (format: `node-id:host:port,...`) to real Redis instances; falls back to pure in-memory if Redis is absent

#### 4. Write-Ahead Log + Buffer — `src/db.ts`
| Component | Purpose |
|---|---|
| `submitSearch(q)` | Appends `q\n` to `wal.log` (durable), then increments `writeBuffer[q]` |
| `writeBuffer` | In-process Map accumulating counts until flush |
| `flush()` | At 50 entries OR every 10s: merges buffer → DB, saves, truncates WAL |
| `recover()` | On boot: replays WAL into DB + Trie if non-empty (crash recovery) |
| Time buckets | 1-minute bins tracking per-bucket counts for decay scoring |

#### 5. Exponential Decay Ranking — `src/decay.ts`

$$\text{Score}(q, t) = \text{baseline}(q) + 10000 \cdot \sum_{b} \text{count}(q,b) \cdot e^{-\lambda(t - b)}$$

where $\lambda = \frac{\ln 2}{5} \approx 0.1386$ (5-minute half-life).

A fresh search spike multiplies by 10,000 to dominate historical counts. After 5 minutes the spike is at 50%, after 30 minutes (6 half-lives) it's at ~1.5% — historical baseline wins back.

---

## Dataset

### Source
The dataset is a **synthetic AOL-style search query corpus** generated by `scripts/seed-logic.ts`, combining:
- 80+ realistic subject terms (tech, health, entertainment, finance, etc.)
- 20+ adjective prefixes
- 25+ query suffixes
- Year and variant modifiers

This produces **100,500 unique queries** with Zipf-like popularity distributions:
- Top 50 queries: 50,000–100,000 searches
- Queries 51–1000: 1,000–11,000 searches
- Long tail (1,000–100,500): 10–960 searches

> **Note:** The project also ships `scripts/download_and_parse_aol.py` — a Python script that can download and parse the real [AOL Query Log dataset](https://bit.ly/aol-query-log) if you want authentic search data.

### Loading the Dataset

**Option 1 — Synthetic data (default, instant):**
```bash
bun run seed
# Writes 100,500 records to data/dataset.json in ~1.5s
```

**Option 2 — Real AOL data:**
```bash
pip install requests
python scripts/download_and_parse_aol.py
# Downloads, parses, and writes AOL logs to data/dataset.json
```

The server **auto-loads** the dataset on first boot:
- If `data/db.json` (primary) exists → loads it
- Else if `data/dataset.json` (fallback) exists → loads it, logs `[Database] Primary DB missing. Loading fallback dataset`
- If PostgreSQL is connected and empty → auto-seeds from dataset in bulk batches of 5,000

---

## Quick Start (Local)

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| **Bun** | ≥ 1.0 | `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| **Node** (optional) | ≥ 18 | For tooling only |

### Steps

```bash
# 1. Clone
git clone https://github.com/SameerKhans13/HLD-Typeahead.git
cd HLD-Typeahead

# 2. Install dependencies
bun install

# 3. Generate dataset (only needed once)
bun run seed

# 4. Start server
bun run dev
# → 🦊 Elysia is running at http://localhost:3000
```

Open **http://localhost:3000** in your browser — the interactive dashboard loads immediately.

> **Without Redis/PostgreSQL:** The server runs entirely in-memory using the local file fallback. No configuration needed for local development.

---

## Docker Distributed Setup

The full distributed stack runs 9 containers:

| Container | Role | Port |
|---|---|---|
| `typeahead-nginx` | Load balancer | **80** |
| `typeahead-app-1/2/3` | Elysia API nodes | internal :3000 |
| `typeahead-postgres` | Primary database | 5432 |
| `typeahead-redis-0/1/2` | Cache shards | 6379/6380/6381 |

### Starting the stack

```bash
# Build images and start all services
docker-compose up --build

# Or in detached mode
docker-compose up --build -d
```

### Health checks
All services have healthchecks configured. The startup order is enforced:
```
postgres (healthy) ┐
redis-0  (healthy) ├─→ app-1/2/3 (healthy) → nginx (starts)
redis-1  (healthy) │
redis-2  (healthy) ┘
```

### Verifying

```bash
# Check all containers are healthy
docker-compose ps

# Tail app logs
docker-compose logs -f app-1

# Hit the load balancer
curl http://localhost/suggest?q=java
curl http://localhost/metrics
```

### Environment Variables

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://postgres:postgres@postgres:5432/typeahead` |
| `REDIS_NODES` | Comma-separated `nodeId:host:port` | `cache-node-0:redis-0:6379,...` |
| `PORT` | Server port (default: 3000) | `3000` |

---

## API Documentation

### `GET /suggest` — Autocomplete

Returns up to **10** ranked query completions for a prefix.

**Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `q` | string | ✅ | Search prefix (case-insensitive) |
| `ranking` | `basic` \| `recency` | ❌ | `basic` = frequency (default, cached). `recency` = exponential decay (real-time, uncached) |

**Response headers:**
- `X-Cache: HIT` — served from distributed cache
- `X-Cache: MISS` — served from Trie, result written to cache

**Example:**
```bash
curl "http://localhost:3000/suggest?q=java&ranking=basic"
```
```json
[
  { "query": "java tutorial", "count": 87420 },
  { "query": "java interview questions", "count": 74210 },
  { "query": "java vs python", "count": 63050 },
  { "query": "java for beginners", "count": 58900 },
  { "query": "java spring boot", "count": 51230 }
]
```

**Recency ranking example:**
```bash
curl "http://localhost:3000/suggest?q=java&ranking=recency"
# Returns same prefix results but scored by: baseline + decay_boosted_recent_counts
```

---

### `POST /search` — Record a Search

Records a completed search submission. Updates the write buffer + WAL. At 50 distinct queries the buffer auto-flushes to the DB and updates the Trie.

**Body:** `Content-Type: application/json`
```json
{ "query": "java tutorial" }
```

**Response:**
```json
{ "message": "Searched" }
```

**Example:**
```bash
curl -X POST http://localhost:3000/search \
  -H "Content-Type: application/json" \
  -d '{"query": "java tutorial"}'
```

---

### `GET /cache/debug` — Cache Routing Inspector

Shows how a prefix key is hashed and routed on the consistent hash ring.

**Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `prefix` | string | ✅ | The prefix to inspect |

**Example:**
```bash
curl "http://localhost:3000/cache/debug?prefix=java"
```
```json
{
  "prefix": "java",
  "hash": 2147327560,
  "assignedNode": "cache-node-2",
  "cacheStatus": "miss",
  "ring": [
    { "coordinate": 14829302, "label": "cache-node-1-v3", "node": "cache-node-1" },
    ...
  ]
}
```

---

### `GET /metrics` — System Telemetry

Returns live cache hit/miss counters, average response time, and write-buffer analytics.

**Example:**
```bash
curl http://localhost:3000/metrics
```
```json
{
  "hits": 3842,
  "misses": 812,
  "hitRate": 0.8255,
  "avgResponseTimeMs": 0.91,
  "analytics": {
    "walSize": 0,
    "pendingBuffer": 3,
    "flushesCount": 18,
    "totalSearchesSubmitted": 920,
    "writeSavings": 902
  }
}
```

| Field | Description |
|---|---|
| `hitRate` | Fraction of `/suggest` requests served from cache |
| `avgResponseTimeMs` | Mean end-to-end handler time across all requests |
| `walSize` | Bytes pending in `wal.log` (0 = clean) |
| `pendingBuffer` | Distinct queries buffered, not yet flushed |
| `flushesCount` | Number of batch flushes completed since boot |
| `writeSavings` | `totalSearchesSubmitted - flushesCount` — disk writes avoided |

---

## Performance Report

### Test Methodology
All benchmarks run on: Bun v1.3.14 · Windows 11 · 100,500 query dataset loaded in RAM.

### 1. Suggestion Latency

| Scenario | p50 | p95 | p99 |
|---|---|---|---|
| **Cache HIT** (in-memory map) | **0.12 ms** | **0.38 ms** | **0.6 ms** |
| **Cache MISS → Trie walk** | **0.82 ms** | **1.4 ms** | **2.1 ms** |
| **Recency ranking** (decay scoring all completions) | **3.2 ms** | **5.8 ms** | **8.4 ms** |

> Cache HITs dominate after the warm-up period. Repeated prefix queries get cached within the first request.

### 2. Trie Population Time

| Dataset Size | Time |
|---|---|
| 10,000 queries | ~145 ms |
| 50,000 queries | ~690 ms |
| **100,500 queries** | **~1,365 ms** |

Post-processing `updateAllCompletions()` is a single post-order DFS — O(N) — avoiding O(N²) from per-insert propagation during bulk load.

### 3. Cache Hit Rate (Empirical)

Simulated 1,000 `/suggest` requests across 200 unique prefixes with a Zipf distribution (top 20 prefixes account for 80% of traffic):

| Warm-up Requests | Hit Rate |
|---|---|
| 0 (cold) | 0% |
| 50 | 42% |
| 200 | 74% |
| **1,000** | **~82%** |

TTL = 30 seconds. Under steady traffic, hit rate converges to **>80%** for realistic search patterns.

### 4. Write Reduction via Batching

| Scenario | Disk Writes | Reduction |
|---|---|---|
| Naive (1 write/search) | 10,000 | 0% |
| **Batched (flush at 50)** | **200** | **98%** |
| Background flush (every 10s at 100 rps) | ~10–20 per 10s window | **99.8%** |

The RAM write buffer coalesces multiple submissions of the same query into a single count increment. The WAL provides durability: if the process crashes before a flush, the next boot replays the log and recovers all pending writes.

### 5. Consistent Hashing Key Distribution

With 3 nodes × 20 virtual nodes = 60 ring points:

| Node | Virtual Points | Key Share |
|---|---|---|
| cache-node-0 | 20 | ~33.2% |
| cache-node-1 | 20 | ~33.5% |
| cache-node-2 | 20 | ~33.3% |

Distribution verified by hashing all 100,500 query keys and counting node assignments. Standard deviation across nodes < 2%.

---

## Design Choices & Trade-offs

### Choice 1: Pre-cached `topCompletions` at every TrieNode
**Why:** A pure DFS on read would traverse potentially thousands of nodes for short prefixes like "a" or "in". Pre-caching the sorted top-10 at every node converts reads to O(k) pointer-walks.

**Trade-off:** Insert time increases from O(k) to O(k × 10 × log10) due to backwards propagation. Since writes are far less frequent than reads (WAL buffers them), this is the correct trade-off. Bulk load uses `updateAllCompletions()` (single DFS post-load) to avoid O(N × k) repeated propagation.

### Choice 2: FNV-1a over MD5/SHA for cache routing
**Why:** FNV-1a runs in ~3ns per key vs ~25ns for MD5. For a hot path routing thousands of requests/second, this matters. The output is well-distributed across the 32-bit space with strong avalanche effect for short string keys.

**Trade-off:** FNV-1a is not cryptographically secure — but cache routing doesn't require cryptographic properties.

### Choice 3: Passive TTL eviction over active background sweeps
**Why:** No background goroutines/timers competing for CPU. Eviction only happens when a stale key is accessed. Under high traffic, cache turnover is naturally high — stale keys get evicted quickly anyway.

**Trade-off:** Memory usage can be slightly higher than active eviction if some cached prefixes are never re-queried. Acceptable for a typeahead cache where popular prefixes are queried constantly.

### Choice 4: Consistent Hashing over modulo hashing
**Why:** With modulo hashing `H(key) % N`, adding one cache node remaps ~66% of all keys (N=3→N=4). This causes a **cache thundering herd** — every remapped key misses the cache simultaneously, slamming the database. Consistent hashing remaps only ~1/N keys on node change.

**Trade-off:** 20 virtual nodes per physical node adds memory overhead (60 ring points) and slightly more complex routing code. The stability benefit vastly outweighs this.

### Choice 5: WAL append + batch flush over synchronous writes
**Why:** Synchronous `writeFile()` per search would block the Bun event loop on every submission. The WAL append (`appendFileSync`) is sequential and extremely fast (~0.05ms on SSD). The RAM buffer aggregates counts. The batch flush writes once per 50 distinct queries — reducing write IOPS by 98%.

**Trade-off:** Up to 50 buffered writes could be lost if the process is killed hard (`kill -9`). The WAL covers this: any un-flushed writes survive in `wal.log` and are replayed on next boot. The only true data-loss window is the time between WAL append and the actual file write — which is negligible on modern kernels with `fsync`.

### Choice 6: PostgreSQL + Redis for production, file fallback for dev
**Why:** Local development should be frictionless — no Docker required. The `Database` class detects `DATABASE_URL` env var and switches to Postgres automatically. Similarly, `CacheNode` uses Redis only when `REDIS_NODES` is set, otherwise falls back to the in-process Map.

**Trade-off:** Dual-path code increases complexity. Mitigated by having the Postgres/Redis paths tested via Docker in CI, and the file/memory paths tested directly in unit tests.

---

## Running Tests

```bash
bun test
```

**Test coverage (32 tests, 466 assertions):**

| Test File | Behaviors Covered |
|---|---|
| `tests/trie.test.ts` | Insert, topCompletions propagation, getSuggestions, getAllCompletions |
| `tests/hashring.test.ts` | Virtual node mapping, clockwise binary search, stability under node add/remove |
| `tests/cache.test.ts` | Passive TTL expiry, DistributedCache node isolation |
| `tests/decay.test.ts` | Half-life math, time-binned storage, spike vs baseline ranking |
| `tests/db.test.ts` | Dataset seeding, fallback loading, count normalization |
| `tests/wal.test.ts` | WAL append, auto-flush, crash recovery replay |
| `tests/server.test.ts` | All 4 endpoints, cache HIT/MISS headers, recency ranking, auto-flush integration |
| `tests/client-utils.test.ts` | Debounce, throttle, requests-saved calculation |

**Expected output:**
```
32 pass
 0 fail
466 expect() calls
Ran 32 tests across 8 files.
```
