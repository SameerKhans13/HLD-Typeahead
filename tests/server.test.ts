import { expect, test, describe, beforeAll, afterEach, afterAll } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { app, trie, cache, db } from "../src/server";
import { TrieNode } from "../src/trie";

describe("Elysia API Server - /suggest", () => {
  const client = treaty(app);

  beforeAll(() => {
    // Clear trie to ensure test isolation from pre-loaded database
    trie.root = new TrieNode();

    // Populate trie with some test data
    trie.insert("cat", 100);
    trie.insert("car", 200);
    trie.insert("cab", 300);
    trie.insert("dog", 150);
  });

  afterEach(() => {
    // Reset cache and metrics between tests if applicable
    cache.clearAll();
  });

  test("returns suggestions for valid prefix", async () => {
    const res = await client.suggest.get({
      query: { q: "ca" }
    });
    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
    const data = res.data as any[];
    expect(data.length).toBe(3);
    expect(data[0].query).toBe("cab");
    expect(data[1].query).toBe("car");
    expect(data[2].query).toBe("cat");
  });

  test("handles case-insensitivity and padding", async () => {
    const res = await client.suggest.get({
      query: { q: "  Ca  " }
    });
    expect(res.status).toBe(200);
    const data = res.data as any[];
    expect(data.length).toBe(3);
    expect(data[0].query).toBe("cab");
  });

  test("handles missing or empty query gracefully", async () => {
    const resEmpty = await client.suggest.get({
      query: { q: "" }
    });
    expect(resEmpty.status).toBe(200);
    expect(resEmpty.data).toEqual([]);

    const resNoQuery = await client.suggest.get({
      query: { q: undefined as any }
    });
    expect(resNoQuery.status).toBe(200);
    expect(resNoQuery.data).toEqual([]);
  });

  test("returns empty array for unmatched prefix", async () => {
    const res = await client.suggest.get({
      query: { q: "xyz" }
    });
    expect(res.status).toBe(200);
    expect(res.data).toEqual([]);
  });
});

describe("Elysia API Server - /cache/debug", () => {
  const client = treaty(app);

  test("returns routing statistics and ring state for a query prefix", async () => {
    const res = await (client.cache as any).debug.get({
      query: { prefix: "ca" }
    });

    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();

    const data = res.data as any;
    expect(data).toHaveProperty("prefix", "ca");
    expect(data).toHaveProperty("hash");
    expect(typeof data.hash).toBe("number");
    expect(data).toHaveProperty("assignedNode");
    expect(data).toHaveProperty("ring");
    expect(Array.isArray(data.ring)).toBe(true);
    expect(data.ring.length).toBeGreaterThan(0);
  });
});

describe("Elysia API Server - Distributed Caching & Metrics", () => {
  const client = treaty(app);

  beforeAll(() => {
    trie.root = new TrieNode();
    trie.insert("apple", 500);
    trie.insert("banana", 300);
  });

  afterEach(() => {
    cache.clearAll();
  });

  test("Behavior 4 & 5: First request is a cache MISS, second request is a cache HIT with X-Cache header", async () => {
    // 1. First request
    const res1 = await client.suggest.get({
      query: { q: "app" }
    });

    expect(res1.status).toBe(200);
    expect((res1.headers as any).get("x-cache")).toBe("MISS");
    expect(res1.data).toBeDefined();
    const data1 = res1.data as any[];
    expect(data1[0].query).toBe("apple");

    // 2. Second request
    const res2 = await client.suggest.get({
      query: { q: "app" }
    });

    expect(res2.status).toBe(200);
    expect((res2.headers as any).get("x-cache")).toBe("HIT");
    expect(res2.data).toEqual(data1);
  });

  test("Behavior 6: GET /metrics exposes hit count, miss count, hitRate, and average response times", async () => {
    // Reset or perform requests to build stats
    await client.suggest.get({ query: { q: "ban" } }); // MISS
    await client.suggest.get({ query: { q: "ban" } }); // HIT
    await client.suggest.get({ query: { q: "ban" } }); // HIT
    await client.suggest.get({ query: { q: "xyz" } }); // MISS

    const res = await (client as any).metrics.get();
    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();

    const metrics = res.data as any;
    expect(metrics.misses).toBeGreaterThanOrEqual(2);
    expect(metrics.hits).toBeGreaterThanOrEqual(2);
    expect(metrics).toHaveProperty("hitRate");
    expect(typeof metrics.hitRate).toBe("number");
    expect(metrics).toHaveProperty("avgResponseTimeMs");
    expect(typeof metrics.avgResponseTimeMs).toBe("number");
  });
});

describe("Elysia API Server - Search Submissions & WAL", () => {
  const client = treaty(app);

  afterEach(async () => {
    await db.flush();
  });

  test("Behavior 4 & 5: POST /search records submissions to WAL and metrics endpoint returns analytics", async () => {
    const res = await client.search.post({
      query: "react tutorial"
    });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ message: "Searched" });

    // Verify metrics contains the WAL analytics
    const metricsRes = await (client as any).metrics.get();
    expect(metricsRes.status).toBe(200);
    const m = metricsRes.data as any;
    expect(m.analytics).toBeDefined();
    expect(m.analytics.totalSearchesSubmitted).toBeGreaterThanOrEqual(1);
    expect(m.analytics.pendingBuffer).toBeGreaterThanOrEqual(1);
  });

  test("Behavior 6: Auto-flush triggers after 50 distinct queries", async () => {
    // Submit 50 distinct queries to trigger auto-flush
    for (let i = 0; i < 50; i++) {
      await client.search.post({
        query: `unique-query-${i}`
      });
    }

    const metricsRes = await (client as any).metrics.get();
    const m = metricsRes.data as any;
    expect(m.analytics.pendingBuffer).toBe(0);
    expect(m.analytics.flushesCount).toBeGreaterThanOrEqual(1);
  });
});

describe("Elysia API Server - Recency-Aware Trending Ranking", () => {
  const client = treaty(app);

  beforeAll(() => {
    // Insert unique, uncontaminated keys
    db.updateQueryCount("ap_spike_apple", 100);
    trie.insert("ap_spike_apple", 100);

    db.updateQueryCount("ap_spike_apricot", 1);
    trie.insert("ap_spike_apricot", 1);
  });

  afterEach(async () => {
    await db.flush();
    cache.clearAll();
  });

  test("Behavior 1: basic ranking prefers historical baseline; recency ranking prefers recent spikes", async () => {
    // 1. Submit 5 searches for apricot now
    for (let i = 0; i < 5; i++) {
      await client.search.post({
        query: "ap_spike_apricot"
      });
    }

    // 2. Request GET /suggest with ranking=basic (or default)
    const resBasic = await client.suggest.get({
      query: { q: "ap_spike_", ranking: "basic" as any }
    });
    expect(resBasic.status).toBe(200);
    const dataBasic = resBasic.data as any[];
    expect(dataBasic[0].query).toBe("ap_spike_apple");

    // 3. Request GET /suggest with ranking=recency
    const resRecency = await client.suggest.get({
      query: { q: "ap_spike_", ranking: "recency" as any }
    });
    expect(resRecency.status).toBe(200);
    const dataRecency = resRecency.data as any[];
    expect(dataRecency[0].query).toBe("ap_spike_apricot");
  });

  afterAll(async () => {
    await db.close();
    await cache.closeAll();
  });
});
