import { expect, test, describe, beforeAll, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { Database } from "../src/db";

const TEST_DB_PATH = "data/test_db_wal.json";
const TEST_WAL_PATH = "data/test_wal.log";

describe("Database Write-Ahead Log (WAL) & Write Buffer", () => {
  beforeAll(() => {
    // Clean up any stale files
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
    if (existsSync(TEST_WAL_PATH)) unlinkSync(TEST_WAL_PATH);
  });

  afterEach(() => {
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
    if (existsSync(TEST_WAL_PATH)) unlinkSync(TEST_WAL_PATH);
  });

  test("Behavior 1: submitSearch appends to WAL and buffers in memory without updating database file", async () => {
    const db = new Database(TEST_DB_PATH, undefined, TEST_WAL_PATH);
    await db.load();

    expect(db.getPendingBufferSize()).toBe(0);

    await db.submitSearch("iphone");
    await db.submitSearch("iphone 15");
    await db.submitSearch("iphone");

    // RAM buffer should have 2 unique queries
    expect(db.getPendingBufferSize()).toBe(2);

    // Primary database count should still be 0 (not flushed yet!)
    expect(db.getQueryCount("iphone")).toBe(0);

    // WAL log file should exist and have 3 lines
    expect(existsSync(TEST_WAL_PATH)).toBe(true);
    const walContent = readFileSync(TEST_WAL_PATH, "utf-8");
    const lines = walContent.trim().split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe("iphone");
    expect(lines[1]).toBe("iphone 15");
    expect(lines[2]).toBe("iphone");
  });

  test("Behavior 2: flush merges counts into database, clears buffer, and truncates WAL", async () => {
    const db = new Database(TEST_DB_PATH, undefined, TEST_WAL_PATH);
    await db.load();

    await db.submitSearch("iphone");
    await db.submitSearch("iphone");

    expect(db.getQueryCount("iphone")).toBe(0);

    // Run flush
    await db.flush();

    // Query count should now be updated to 2
    expect(db.getQueryCount("iphone")).toBe(2);

    // Buffer should be empty
    expect(db.getPendingBufferSize()).toBe(0);

    // WAL file should be truncated to 0 bytes
    expect(existsSync(TEST_WAL_PATH)).toBe(true);
    const walContent = readFileSync(TEST_WAL_PATH, "utf-8");
    expect(walContent).toBe("");

    // Database file should exist and contain the record
    expect(existsSync(TEST_DB_PATH)).toBe(true);
    const dbContent = JSON.parse(readFileSync(TEST_DB_PATH, "utf-8"));
    expect(dbContent.length).toBe(1);
    expect(dbContent[0].query).toBe("iphone");
    expect(dbContent[0].count).toBe(2);
  });

  test("Behavior 3: recover replays WAL log on boot and truncates it", async () => {
    // Simulate a crash: raw log with 4 appends exists on disk, but db is empty
    writeFileSync(TEST_WAL_PATH, "iphone\njava tutorial\niphone\n", "utf-8");

    const db = new Database(TEST_DB_PATH, undefined, TEST_WAL_PATH);
    await db.load();

    expect(db.getQueryCount("iphone")).toBe(0);

    // Recover on boot
    await db.recover();

    // Query counts should be successfully replayed
    expect(db.getQueryCount("iphone")).toBe(2);
    expect(db.getQueryCount("java tutorial")).toBe(1);

    // WAL should be truncated
    const walContent = readFileSync(TEST_WAL_PATH, "utf-8");
    expect(walContent).toBe("");

    // Database should be saved
    expect(existsSync(TEST_DB_PATH)).toBe(true);
  });
});
