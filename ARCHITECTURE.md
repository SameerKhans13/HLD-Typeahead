# System Architecture Document

This document provides a detailed breakdown of the distributed, high-performance prefix-tree (Trie) query completion architecture.

---

## 1. System Overview and Flow Diagram

The service is structured as a load-balanced, multi-tier system with distributed in-memory lookups, localized write-ahead logging (WAL), batch database persistence, and consistent-hash routed caching.

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

---

## 2. Component Explanations

### 2.1 Prefix Tree (Trie)
- Fully loaded into RAM.
- O(k) query prefix lookup path, where `k` is the prefix length.
- Avoids subtree traversal during query time by storing a pre-sorted cache of the top 10 suggestions directly on each node.
- Merges additions backwards on insertion to propagate metrics to root.

### 2.2 Consistent Hash Ring
- Partitions cache keys dynamically across physical Redis instances.
- Uses **FNV-1a** 32-bit hashing algorithm.
- Employs virtual nodes (20 per physical server) to ensure uniform keyspace distribution and minimize hot-spotting.
- Fast clockwise binary search to map query prefixes to node segments.

### 2.3 Distributed Cache Layer
- Routes read queries to their mapped Redis instances using the Hash Ring.
- Cache hits skip the Trie lookup entirely.
- Includes passive 30-second TTL logic with automatic fallback to in-memory local caches if Redis servers disconnect.

### 2.4 Write-Ahead Log (WAL) & RAM Buffer
- Intercepts writes on `/search` submissions.
- Commits transactions to `wal.log` instantly for durability.
- Buffers query increments in memory.
- Triggers a batch database flush once the write buffer hits 50 records or after 10 seconds, keeping database query costs low.

### 2.5 Relational Database (PostgreSQL)
- Acts as the cold-storage durability repository.
- Stores raw queries, total counts, and binned historical increments for exponential decay calculations.
