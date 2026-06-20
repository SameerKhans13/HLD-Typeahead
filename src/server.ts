import { Elysia } from "elysia";
import { Database } from "./db";
import { Trie } from "./trie";
import { ConsistentHashRing, fnv1a } from "./hashring";
import { DistributedCache } from "./cache";

export const trie = new Trie();

// Initialize physical nodes for consistent hash ring and cache
const PHYSICAL_NODES = ["cache-node-0", "cache-node-1", "cache-node-2"];

// Initialize consistent hashing ring
export const hashRing = new ConsistentHashRing(PHYSICAL_NODES, 20);

// Initialize distributed cache layer
export const cache = new DistributedCache(PHYSICAL_NODES);

// Initialize database with default production paths and WAL log path
const PRIMARY_DB_PATH = "data/db.json";
const FALLBACK_DATASET_PATH = "data/dataset.json";
const WAL_LOG_PATH = "data/wal.log";

export const db = new Database(PRIMARY_DB_PATH, FALLBACK_DATASET_PATH, WAL_LOG_PATH);        

// Initialize metrics counters
let metricsHits = 0;
let metricsMisses = 0;
let totalResponseTimeMs = 0;
let totalRequestsCount = 0;

// Load data into the database
console.log("Loading database...");
await db.load();

// Recover WAL on boot to prevent data loss
console.log("Recovering WAL on boot...");
await db.recover((query, count) => {
  trie.insert(query, count);
});

// Populate the Trie with existing primary database records
console.log("Populating Trie...");
const start = performance.now();
let count = 0;
for (const record of db.getAllQueries()) {
  trie.insert(record.query, record.count);
  count++;
}
const end = performance.now();
console.log(`Trie populated with ${count} queries in ${(end - start).toFixed(2)}ms.`);       

// Background task executing Flush-and-Truncate every 10 seconds
const flushInterval = setInterval(async () => {
  try {
    await db.flush((query, count) => {
      trie.insert(query, count);
    });
  } catch (err) {
    console.error("Failed to background-flush WAL and database:", err);
  }
}, 10000);

// Unref background timer in Node/Bun to allow testing suites to exit cleanly
if (flushInterval.unref) {
  flushInterval.unref();
}

// Graceful shutdown handling for distributed environment
const handleShutdown = async () => {
  console.log("\n[Server] Shutting down gracefully...");
  clearInterval(flushInterval);
  try {
    await db.flush((query, count) => {
      trie.insert(query, count);
    });
    await cache.closeAll();
    await db.close();
    console.log("[Server] Shutdown complete.");
    process.exit(0);
  } catch (err) {
    console.error("[Server] Error during graceful shutdown:", err);
    process.exit(1);
  }
};

process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);

export const app = new Elysia()
  .get("/suggest", async ({ query, set }) => {
    const startTime = performance.now();
    const q = (query.q || "").trim();

    if (!q) {
      set.headers["X-Cache"] = "MISS";
      const duration = performance.now() - startTime;
      metricsMisses++;
      totalRequestsCount++;
      totalResponseTimeMs += duration;
      return [];
    }

    const normalized = q.toLowerCase().trim();
    const assignedNodeId = hashRing.getNode(normalized);

    let cachedValue: any = null;
    let cacheNode: any = null;

    if (assignedNodeId) {
      cacheNode = cache.getNode(assignedNodeId);
      if (cacheNode) {
        cachedValue = await cacheNode.get(normalized);
      }
    }

    let result: any[];
    const ranking = (query as any).ranking || "basic";

    if (ranking === "recency") {
      // Recency-Aware Dynamic Decay Ranking
      const allCompletions = trie.getAllCompletions(normalized);
      const currentBucketId = Math.floor(Date.now() / 60000);

      const scored = allCompletions.map(c => {
        const score = db.getDecayScore(c.query, currentBucketId);
        return { query: c.query, count: score };
      });

      scored.sort((a, b) => b.count - a.count || a.query.localeCompare(b.query));
      result = scored.slice(0, 10);
      set.headers["X-Cache"] = "MISS";
      metricsMisses++;
    } else {
      // Basic Frequency Ranking with Distributed Cache
      if (cachedValue) {
        result = cachedValue;
        set.headers["X-Cache"] = "HIT";
        metricsHits++;
      } else {
        result = trie.getSuggestions(normalized);
        set.headers["X-Cache"] = "MISS";
        metricsMisses++;
        if (cacheNode && assignedNodeId) {
          // Cache suggestions with a 30-second passive TTL
          await cacheNode.set(normalized, result, 30000);
        }
      }
    }

    const duration = performance.now() - startTime;
    totalRequestsCount++;
    totalResponseTimeMs += duration;

    return result;
  })
  .get("/cache/debug", async ({ query }) => {
    const prefix = (query.prefix || "").trim().toLowerCase();
    const hash = fnv1a(prefix);
    const assignedNode = hashRing.getNode(prefix);
    const ring = hashRing.getRingState();

    let cacheStatus = "miss";
    if (assignedNode) {
      const cacheNode = cache.getNode(assignedNode);
      if (cacheNode) {
        const isCached = await cacheNode.get(prefix);
        if (isCached) {
          cacheStatus = "hit";
        }
      }
    }

    return {
      prefix,
      hash,
      assignedNode,
      ring,
      cacheStatus
    };
  })
  .get("/metrics", () => {
    const hitRate = metricsHits + metricsMisses > 0
      ? metricsHits / (metricsHits + metricsMisses)
      : 0;
    const avgResponseTimeMs = totalRequestsCount > 0
      ? totalResponseTimeMs / totalRequestsCount
      : 0;
    const analytics = db.getAnalytics();

    return {
      hits: metricsHits,
      misses: metricsMisses,
      hitRate,
      avgResponseTimeMs,
      analytics
    };
  })
  .post("/search", async ({ body }) => {
    const q = (body as any)?.query || "";
    const normalized = q.toLowerCase().trim();
    if (normalized) {
      await db.submitSearch(normalized, (query, count) => {
        trie.insert(query, count);
      });
    }
    return { message: "Searched" };
  });
export default app;
