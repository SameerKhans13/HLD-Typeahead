import { expect, test, describe, beforeAll, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { calculateDecayScore, LAMBDA } from "../src/decay";
import { Database } from "../src/db";

const TEST_DB_PATH = "data/test_db_decay.json";
const TEST_WAL_PATH = "data/test_decay_wal.log";

describe("Exponential Time DecayPopularity", () => {
  test("Behavior 1: calculateDecayScore respects half-life mathematical properties", () => {
    // For a 5-minute half-life, score at t=0 should be full, at t=5 should be 50%, at t=10 should be 25%
    const baselineCount = 0;
    const buckets = [{ bucketId: 100, count: 10 }];

    const scoreT0 = calculateDecayScore(baselineCount, buckets, 100);
    // At t=0 (current bucket = 100), no decay
    expect(scoreT0).toBe(10 * 10000);

    const scoreT5 = calculateDecayScore(baselineCount, buckets, 105);
    // At t=5 minutes (current bucket = 105), decayed by 50%
    expect(scoreT5).toBeCloseTo(5 * 10000, 2);

    const scoreT10 = calculateDecayScore(baselineCount, buckets, 110);
    // At t=10 minutes (current bucket = 110), decayed by 75% (25% remaining)
    expect(scoreT10).toBeCloseTo(2.5 * 10000, 2);
  });

  describe("Database Binned Storage & Decay Ranking", () => {
    beforeAll(() => {
      if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
      if (existsSync(TEST_WAL_PATH)) unlinkSync(TEST_WAL_PATH);
    });

    afterEach(() => {
      if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
      if (existsSync(TEST_WAL_PATH)) unlinkSync(TEST_WAL_PATH);
    });

    test("Behavior 2: Database loads and saves binned buckets backward-compatibly", async () => {
      const db = new Database(TEST_DB_PATH, undefined, TEST_WAL_PATH);
      await db.load();

      await db.submitSearch("apple");
      await db.flush();

      // Load another database instance to test persistence
      const db2 = new Database(TEST_DB_PATH, undefined, TEST_WAL_PATH);
      await db2.load();

      expect(db2.getQueryCount("apple")).toBe(1);

      const currentBucketId = Math.floor(Date.now() / 60000);
      const score = db2.getDecayScore("apple", currentBucketId);

      // Should have a high decayed score because it was searched in the current minute bin  
      expect(score).toBeGreaterThan(1000);
    });

    test("Behavior 3: Search spikes rank higher initially, but decay as binned time intervals advance", async () => {
      const db = new Database(TEST_DB_PATH, undefined, TEST_WAL_PATH);
      await db.load();

      // "apple" has high historical baseline (100)
      db.updateQueryCount("apple", 100);

      // "apricot" has low historical baseline (1)
      db.updateQueryCount("apricot", 1);

      const t0 = 1000; // Mock current time bucket ID

      // apricot gets a sudden spike of searches in bucket t0
      // We simulate bucket submission by adding to apricot's buckets map
      const apricotBuckets = new Map<number, number>();
      apricotBuckets.set(t0, 5); // 5 searches in bucket t0
      (db as any).timeBuckets.set("apricot", apricotBuckets);

      // 1. Initially (at t0), apricot's decay score should beat apple's
      const scoreAppleT0 = db.getDecayScore("apple", t0);
      const scoreApricotT0 = db.getDecayScore("apricot", t0);

      expect(scoreApricotT0).toBeGreaterThan(scoreAppleT0);

      // 2. Advance time by 100 minutes (well past 5-minute half-life)
      const t100 = 1100;
      const scoreAppleT100 = db.getDecayScore("apple", t100);
      const scoreApricotT100 = db.getDecayScore("apricot", t100);

      // apricot's spike should have completely decayed, so apple's historical baseline wins 
      expect(scoreAppleT100).toBeGreaterThan(scoreApricotT100);
    });
  });
});
