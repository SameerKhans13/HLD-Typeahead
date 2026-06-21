# API Documentation

This document describes the API endpoints provided by the distributed autocomplete system.

## Endpoints

### 1. Retrieve Suggestions (`GET /suggest`)
Fetches the top 10 completions matching a query prefix.

- **URL Parameters**:
  - `q` (string): The search term prefix (required).
  - `ranking` (string, optional): Sorting algorithm.
    - `basic` (default): Sorts queries by raw popularity.
    - `recency`: Applies dynamic exponential time-decay (5-minute half-life) to rank trending queries higher.

- **Headers Returned**:
  - `X-Cache`: `HIT` if served from the consistent hash cache, `MISS` otherwise.

#### Request Examples
```http
GET /suggest?q=fam&ranking=basic
```

#### Response Example (200 OK)
```json
[
  { "query": "family guy", "count": 2840 },
  { "query": "family guy episodes", "count": 145 },
  { "query": "family dollar", "count": 92 }
]
```

---

### 2. Submit Search Query (`POST /search`)
Increments the popularity count of a search query. Writes to the WAL immediately and batches commits to PostgreSQL.

- **Request Body**:
  - `query` (string, required): The search query being submitted.

#### Request Example
```http
POST /search
Content-Type: application/json

{
  "query": "hello kitty"
}
```

#### Response Example (200 OK)
```json
{
  "message": "Search query registered successfully"
}
```

---

### 3. Get Cluster Metrics (`GET /metrics`)
Provides telemetry statistics about cache efficiency, request latency, and write operations.

#### Request Example
```http
GET /metrics
```

#### Response Example (200 OK)
```json
{
  "totalRequests": 1420,
  "cacheHits": 1210,
  "cacheMisses": 210,
  "cacheHitRate": "85.21%",
  "avgLatencyMs": "0.45",
  "writesSubmitted": 1500,
  "databaseFlushes": 30
}
```

---

### 4. Database Reset (`POST /reset`)
Clears runtime databases, trashing cached Redis indexes, local WAL logs, PostgreSQL query tables, and RAM Trie registers. Useful for staging/testing.

#### Request Example
```http
POST /reset
```

#### Response Example (200 OK)
```json
{
  "message": "Database and runtime caches reset successfully"
}
```
