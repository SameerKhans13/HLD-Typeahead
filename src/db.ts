import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, appendFileSync } from "fs";
import { dirname } from "path";
import { calculateDecayScore } from "./decay";

export interface DatabaseRecord {
  query: string;
  count: number;
  buckets?: { bucketId: number; count: number }[];
}

export class Database {
  private dbPath: string;
  private datasetPath?: string;
  private walPath: string;
  private cache: Map<string, number> = new Map();
  
  // Volatile RAM write buffer for query counts
  private writeBuffer: Map<string, number> = new Map();

  // Time Buckets mapping a query to minutes-since-epoch bucket ID -> count
  private timeBuckets: Map<string, Map<number, number>> = new Map();

  // Metrics & Analytics
  private flushesCount = 0;
  private totalSearchesSubmitted = 0;

  constructor(dbPath: string, datasetPath?: string, walPath: string = "data/wal.log") {
    this.dbPath = dbPath;
    this.datasetPath = datasetPath;
    this.walPath = walPath;
  }

  async load(): Promise<void> {
    this.cache.clear();
    this.timeBuckets.clear();

    if (existsSync(this.dbPath)) {
      this.loadFromFile(this.dbPath);
    } else if (this.datasetPath && existsSync(this.datasetPath)) {
      this.loadFromFile(this.datasetPath);
    }
  }

  private loadFromFile(path: string): void {
    const content = readFileSync(path, "utf-8");
    const records: DatabaseRecord[] = JSON.parse(content);
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
    const records = this.getAllQueries();
    
    // Ensure parent directory exists
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write primary database file using fast writeFileSync
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

  getAllQueries(): DatabaseRecord[] {
    const records: DatabaseRecord[] = [];
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

    // Ensure parent directory of WAL exists
    const walDir = dirname(this.walPath);
    if (!existsSync(walDir)) {
      mkdirSync(walDir, { recursive: true });
    }

    // Append immediately to sequential disk log
    appendFileSync(this.walPath, cleanQuery + "\n", "utf-8");

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

  async flush(onFlushCallback?: (query: string, count: number) => void): Promise<void> {
    if (this.writeBuffer.size === 0) {
      // Truncate WAL anyway to remain consistent
      if (existsSync(this.walPath)) {
        writeFileSync(this.walPath, "", "utf-8");
      }
      return;
    }

    // 1. Merge buffer counts into database cache
    for (const [query, count] of this.writeBuffer.entries()) {
      this.updateQueryCount(query, count);
      if (onFlushCallback) {
        onFlushCallback(query, this.getQueryCount(query));
      }
    }

    // 2. Save database to disk
    await this.save();

    // 3. Clear buffer and increment flush metrics
    this.writeBuffer.clear();
    this.flushesCount++;

    // 4. Truncate WAL log to 0 bytes
    writeFileSync(this.walPath, "", "utf-8");
  }

  async recover(onFlushCallback?: (query: string, count: number) => void): Promise<void> {
    if (!existsSync(this.walPath)) return;

    const content = readFileSync(this.walPath, "utf-8");
    const lines = content.split("\n");
    const recoveryBuffer: Map<string, number> = new Map();
    const currentBucketId = Math.floor(Date.now() / 60000);

    for (const line of lines) {
      const cleanLine = line.trim().toLowerCase();
      if (cleanLine) {
        const current = recoveryBuffer.get(cleanLine) || 0;
        recoveryBuffer.set(cleanLine, current + 1);

        // Populate recovery time buckets
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
      // Replay all events
      for (const [query, increment] of recoveryBuffer.entries()) {
        this.updateQueryCount(query, increment);
        if (onFlushCallback) {
          onFlushCallback(query, this.getQueryCount(query));
        }
      }
      // Save updated database
      await this.save();
      this.flushesCount++;
    }

    // Truncate the recovered log
    writeFileSync(this.walPath, "", "utf-8");
  }

  // --- Recency-Aware Trending Scores ---

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
    if (!existsSync(this.walPath)) return 0;
    try {
      return statSync(this.walPath).size;
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
}

export default Database;
