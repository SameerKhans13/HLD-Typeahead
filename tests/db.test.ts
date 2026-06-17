import { expect, test, describe, afterAll } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { runSeed } from "../scripts/seed-logic";
import { Database } from "../src/db";

describe("Search Typeahead DB Seeding & Storage Seam", () => {
  const TEST_DATASET_PATH = "data/test_dataset.json";
  const TEST_DB_PATH = "data/test_db.json";

  afterAll(() => {
    if (existsSync(TEST_DATASET_PATH)) {
      unlinkSync(TEST_DATASET_PATH);
    }
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  test("Behavior 1: Seeder script generates 100,000+ unique search queries", async () => {   
    // Generate 100,100 records for the test
    await runSeed(TEST_DATASET_PATH, 100100);

    expect(existsSync(TEST_DATASET_PATH)).toBe(true);
    const fileContent = await Bun.file(TEST_DATASET_PATH).json();
    expect(Array.isArray(fileContent)).toBe(true);
    expect(fileContent.length).toBeGreaterThanOrEqual(100000);

    const first = fileContent[0];
    expect(first).toHaveProperty("query");
    expect(first).toHaveProperty("count");
    expect(typeof first.query).toBe("string");
    expect(typeof first.count).toBe("number");
  });

  test("Behavior 2: Database loads fallback dataset if primary path is missing, and loads from primary on reboot", async () => {
    // Ensure primary path doesn't exist
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }

    // Instantiating database with missing DB path and our test dataset fallback
    const db = new Database(TEST_DB_PATH, TEST_DATASET_PATH);
    await db.load();

    // Verify it fell back to loading the 100k+ dataset
    const queries = db.getAllQueries();
    expect(queries.length).toBeGreaterThanOrEqual(100000);

    // Save database to generate the primary DB file
    await db.save();
    expect(existsSync(TEST_DB_PATH)).toBe(true);

    // Instantiate a new DB instance targeting the primary DB path, without fallback dataset 
    const dbReboot = new Database(TEST_DB_PATH);
    await dbReboot.load();

    expect(dbReboot.getAllQueries().length).toBe(queries.length);
  });

  test("Behavior 3: Database updates query counts correctly with normalization", async () => {
    const db = new Database(TEST_DB_PATH);
    await db.load();

    const query = "test query unique";

    // Initial state
    expect(db.getQueryCount(query)).toBe(0);

    // Initial update (create)
    db.updateQueryCount(query, 5);
    expect(db.getQueryCount(query)).toBe(5);

    // Subsequent update (increment)
    db.updateQueryCount(query, 10);
    expect(db.getQueryCount(query)).toBe(15);

    // Normalization check (mixed-case, leading/trailing whitespace)
    db.updateQueryCount("  TeSt QuErY UnIqUe  ", 5);
    expect(db.getQueryCount(query)).toBe(20);
    expect(db.getQueryCount("test query unique")).toBe(20);
  });
});
