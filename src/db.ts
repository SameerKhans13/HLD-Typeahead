import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import postgres from "postgres";
import { calculateDecayScore } from "./decay";

export class Database {
  private dbPath: string;
  private datasetPath?: string;
  private walPath?: string;

  // In-memory caches for fast read access and write buffering
  private cache: Map<string, number> = new Map();
  private timeBuckets: Map<string, Map<number, number>> = new Map();
  private writeBuffer: Map<string, number> = new Map();

  // PostgreSQL client
  private sql?: postgres.Sql;

  constructor(dbPath: string, datasetPath?: string, walPath?: string) {
    this.dbPath = dbPath;
    this.datasetPath = datasetPath;
    this.walPath = walPath;

    // Check for PostgreSQL connection string
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      console.log(`[Database] Connecting to PostgreSQL at ${dbUrl.replace(/:[^:]+@/, ':****@')}`);
      this.sql = postgres(dbUrl, {
        max: 5,
        idle_timeout: 20,
        connect_timeout: 10
      });
    }
  }

  async load(): Promise<void> {
    this.cache.clear();
    this.timeBuckets.clear();
    this.writeBuffer.clear();

    if (this.sql) {
      try {
        await this.initializePostgresTables();
        await this.loadFromPostgres();
      } catch (err) {
        console.error("[Database] Failed to load data from PostgreSQL. Falling back to local file...", err);
        await this.loadFromFileSystem();
      }
    } else {
      await this.loadFromFileSystem();
    }
  }

  private async initializePostgresTables(): Promise<void> {
    if (!this.sql) return;

    // Create tables inside transactional block
    await this.sql.begin(async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS search_queries (
          query VARCHAR(255) PRIMARY KEY,
          count INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS time_buckets (
          query VARCHAR(255) NOT NULL,
          bucket_id INTEGER NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (query, bucket_id)
        )
      `;
    });
    console.log("[Database] PostgreSQL tables initialized successfully.");
  }

  private async loadFromPostgres(): Promise<void> {
    if (!this.sql) return;

    console.log("[Database] Hydrating RAM cache from PostgreSQL search_queries...");
    const queries = await this.sql`SELECT query, count FROM search_queries`;
    for (const row of queries) {
      this.cache.set(row.query, row.count);
    }

    console.log("[Database] Hydrating RAM cache from PostgreSQL time_buckets...");
    const buckets = await this.sql`SELECT query, bucket_id, count FROM time_buckets`;
    for (const row of buckets) {
      let queryBucketsMap = this.timeBuckets.get(row.query);
      if (!queryBucketsMap) {
        queryBucketsMap = new Map<number, number>();
        this.timeBuckets.set(row.query, queryBucketsMap);
      }
      queryBucketsMap.set(row.bucket_id, row.count);
    }
    console.log(`[Database] Hydration complete. Loaded ${this.cache.size} queries.`);
  }

  private async loadFromFileSystem(): Promise<void> {
    if (existsSync(this.dbPath)) {
      this.loadFromFile(this.dbPath);
    } else if (this.datasetPath && existsSync(this.datasetPath)) {
      console.log(`[Database] Primary DB missing. Loading fallback dataset from ${this.datasetPath}`);
      this.loadFromFile(this.datasetPath);
    }
  }

  private loadFromFile(path: string): void {
    const content = readFileSync(path, "utf-8");
    const records = JSON.parse(content);
    for (const record of records) {
      const query = record.query.toLowerCase().trim();
      if (query) {
        this.cache.set(query, record.count);
        if (record.buckets) {
          const map = new Map<number, number>();
          for (const b of record.buckets) {
            map.set(b.bucketId, b.count);
          }
          this.timeBuckets.set(query, map);
        }
      }
    }
  }

  async save(): Promise<void> {
    if (this.sql) {
      // Postgres relies on flush() to persist state, but we save on demand if needed
      return;
    }

    const records = this.getAllQueries();
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.dbPath, JSON.stringify(records, null, 2), "utf-8");
  }

  getQueryCount(query: string): number {
    return this.cache.get(query.toLowerCase().trim()) || 0;
  }

  updateQueryCount(query: string, count: number): void {
    const cleanQuery = query.toLowerCase().trim();
    if (!cleanQuery) return;
    
    const current = this.cache.get(cleanQuery) || 0;
    this.cache.set(cleanQuery, current + count);
  }

  getAllQueries() {
    const records = [];
    for (const [query, count] of this.cache.entries()) {
      const bucketsMap = this.timeBuckets.get(query);
      const buckets = bucketsMap
        ? Array.from(bucketsMap.entries()).map(([bucketId, c]) => ({ bucketId, count: c }))
        : [];
      records.push({ query, count, buckets });
    }
    return records;
  }

  // --- Write Buffering & Write-Ahead Log (WAL) ---

  async submitSearch(query: string, onFlushCallback?: (query: string, count: number) => void): Promise<void> {
    const cleanQuery = query.toLowerCase().trim();
    if (!cleanQuery) return;

    // Only write to WAL if we are NOT using PostgreSQL (Postgres has native WAL durability!)
    if (!this.sql && this.walPath) {
      const walDir = dirname(this.walPath);
      if (!existsSync(walDir)) {
        mkdirSync(walDir, { recursive: true });
      }
      appendFileSyncCustom(this.walPath, cleanQuery + "\n");
    }

    // Buffer count in memory
    const current = this.writeBuffer.get(cleanQuery) || 0;
    this.writeBuffer.set(cleanQuery, current + 1);
    this.totalSearchesSubmitted++;

    // Record to discrete 1-minute Time-Binned Buckets
    const currentBucketId = Math.floor(Date.now() / 60000);
    let queryBuckets = this.timeBuckets.get(cleanQuery);
    if (!queryBuckets) {
      queryBuckets = new Map<number, number>();
      this.timeBuckets.set(cleanQuery, queryBuckets);
    }
    const bucketCount = queryBuckets.get(currentBucketId) || 0;
    queryBuckets.set(currentBucketId, bucketCount + 1);

    // Auto-flush when reaching 50 distinct queries in the buffer
    if (this.writeBuffer.size >= 50) {
      await this.flush(onFlushCallback);
    }
  }

  private totalSearchesSubmitted = 0;
  private flushesCount = 0;

  async flush(onFlushCallback?: (query: string, count: number) => void): Promise<void> {
    if (this.writeBuffer.size === 0) {
      return;
    }

    if (this.sql) {
      try {
        await this.flushToPostgres();
      } catch (err) {
        console.error("[Database] Failed to flush batch to PostgreSQL:", err);
        // Retain buffer on error so we can retry on next interval
        return;
      }
    }

    // Merge buffer counts into database cache
    for (const [query, count] of this.writeBuffer.entries()) {
      this.updateQueryCount(query, count);
      if (onFlushCallback) {
        onFlushCallback(query, this.getQueryCount(query));
      }
    }

    if (!this.sql) {
      await this.save();
      // Truncate file-based WAL log
      if (this.walPath && existsSync(this.walPath)) {
        writeFileSync(this.walPath, "", "utf-8");
      }
    }

    this.writeBuffer.clear();
    this.flushesCount++;
  }

  private async flushToPostgres(): Promise<void> {
    if (!this.sql || this.writeBuffer.size === 0) return;

    // Use Postgres.js transactional multi-row UPSERTs
    const queryRows = Array.from(this.writeBuffer.entries()).map(([query, count]) => ({
      query,
      count
    }));

    const currentBucketId = Math.floor(Date.now() / 60000);
    const bucketRows: { query: string; bucket_id: number; count: number }[] = [];

    for (const [query] of this.writeBuffer.entries()) {
      const qBuckets = this.timeBuckets.get(query);
      if (qBuckets) {
        const countInCurrentBucket = qBuckets.get(currentBucketId) || 0;
        if (countInCurrentBucket > 0) {
          bucketRows.push({
            query,
            bucket_id: currentBucketId,
            count: countInCurrentBucket
          });
        }
      }
    }

    await this.sql.begin(async (sql) => {
      // 1. Bulk Upsert search_queries
      for (const row of queryRows) {
        await sql`
          INSERT INTO search_queries (query, count, updated_at)
          VALUES (${row.query}, ${row.count}, NOW())
          ON CONFLICT (query) DO UPDATE SET
            count = search_queries.count + EXCLUDED.count,
            updated_at = NOW()
        `;
      }

      // 2. Bulk Upsert time_buckets
      for (const row of bucketRows) {
        await sql`
          INSERT INTO time_buckets (query, bucket_id, count)
          VALUES (${row.query}, ${row.bucket_id}, ${row.count})
          ON CONFLICT (query, bucket_id) DO UPDATE SET
            count = EXCLUDED.count
        `;
      }
    });
  }

  async recover(onFlushCallback?: (query: string, count: number) => void): Promise<void> {
    if (this.sql) {
      // PostgreSQL handles crash recovery naturally through its native transactions/WAL
      return;
    }

    if (!this.walPath || !existsSync(this.walPath)) return;

    const content = readFileSync(this.walPath, "utf-8");
    const lines = content.split("\n");
    const recoveryBuffer: Map<string, number> = new Map();
    const currentBucketId = Math.floor(Date.now() / 60000);

    for (const line of lines) {
      const cleanLine = line.trim().toLowerCase();
      if (cleanLine) {
        const current = recoveryBuffer.get(cleanLine) || 0;
        recoveryBuffer.set(cleanLine, current + 1);

        let queryBuckets = this.timeBuckets.get(cleanLine);
        if (!queryBuckets) {
          queryBuckets = new Map<number, number>();
          this.timeBuckets.set(cleanLine, queryBuckets);
        }
        const bCount = queryBuckets.get(currentBucketId) || 0;
        queryBuckets.set(currentBucketId, bCount + 1);
      }
    }

    if (recoveryBuffer.size > 0) {
      for (const [query, increment] of recoveryBuffer.entries()) {
        this.updateQueryCount(query, increment);
        if (onFlushCallback) {
          onFlushCallback(query, this.getQueryCount(query));
        }
      }
      await this.save();
      this.flushesCount++;
    }

    writeFileSync(this.walPath, "", "utf-8");
  }

  getDecayScore(query: string, currentBucketId: number): number {
    const cleanQuery = query.toLowerCase().trim();
    const baseline = this.getQueryCount(cleanQuery);
    const bucketsMap = this.timeBuckets.get(cleanQuery);
    const buckets = bucketsMap
      ? Array.from(bucketsMap.entries()).map(([bucketId, count]) => ({ bucketId, count }))
      : [];
    return calculateDecayScore(baseline, buckets, currentBucketId);
  }

  getPendingBufferSize(): number {
    return this.writeBuffer.size;
  }

  getWalSize(): number {
    if (this.sql) return 0; // Native Postgres WAL
    if (!this.walPath || !existsSync(this.walPath)) return 0;
    try {
      return statSyncCustom(this.walPath);
    } catch {
      return 0;
    }
  }

  getAnalytics() {
    return {
      walSize: this.getWalSize(),
      pendingBuffer: this.getPendingBufferSize(),
      flushesCount: this.flushesCount,
      totalSearchesSubmitted: this.totalSearchesSubmitted,
      writeSavings: Math.max(0, this.totalSearchesSubmitted - this.flushesCount)
    };
  }

  async close(): Promise<void> {
    if (this.sql) {
      await this.sql.end();
    }
  }
}

// Custom fast FS append helper
function appendFileSyncCustom(path: string, content: string): void {
  const fs = require("fs");
  fs.appendFileSync(path, content, "utf-8");
}

function statSyncCustom(path: string): number {
  const fs = require("fs");
  return fs.statSync(path).size;
}

export default Database;
