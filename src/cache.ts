import Redis from "ioredis";

export interface CacheEntry<T> {
  value: T;
  expiry: number; // timestamp in ms
}

export class CacheNode {
  private store: Map<string, CacheEntry<any>> = new Map();
  private redis?: Redis;
  public id: string;

  constructor(id: string, redisUrl?: string) {
    this.id = id;
    if (redisUrl) {
      console.log(`[CacheNode] Connecting ${id} to Redis at ${redisUrl}`);
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        lazyConnect: true
      });
      // Handle connection errors gracefully without crashing the app
      this.redis.connect().catch((err) => {
        console.error(`[CacheNode] Redis connection failed for node ${id}:`, err);
      });
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.redis) {
      try {
        const val = await this.redis.get(key);
        if (!val) return null;
        return JSON.parse(val) as T;
      } catch (err) {
        console.error(`[CacheNode] Redis GET failed on ${this.id}:`, err);
        return null;
      }
    }

    // Memory cache fallback
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.store.delete(key); // Passive eviction
      return null;
    }
    return entry.value;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (this.redis) {
      try {
        const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
        await this.redis.setex(key, ttlSeconds, JSON.stringify(value));
        return;
      } catch (err) {
        console.error(`[CacheNode] Redis SETEX failed on ${this.id}:`, err);
      }
    }

    // Memory cache fallback
    this.store.set(key, {
      value,
      expiry: Date.now() + ttlMs
    });
  }

  async clear(): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.flushdb();
      } catch (err) {
        console.error(`[CacheNode] Redis FLUSHDB failed on ${this.id}:`, err);
      }
    }
    this.store.clear();
  }

  getDebugSize(): number {
    return this.store.size;
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }
}

export class DistributedCache {
  private nodes: Map<string, CacheNode> = new Map();

  constructor(nodeIds: string[]) {
    // Parse environment REDIS_NODES variable (e.g. "cache-node-0:redis-0:6379,cache-node-1:redis-1:6379")
    const envNodesStr = process.env.REDIS_NODES;
    const parsedUrls = new Map<string, string>();

    if (envNodesStr) {
      const parts = envNodesStr.split(",");
      for (const part of parts) {
        const subparts = part.split(":");
        if (subparts.length === 3) {
          const [nodeId, host, port] = subparts;
          parsedUrls.set(nodeId, `redis://${host}:${port}`);
        }
      }
    }

    for (const id of nodeIds) {
      const redisUrl = parsedUrls.get(id);
      this.nodes.set(id, new CacheNode(id, redisUrl));
    }
  }

  getNode(nodeId: string): CacheNode | undefined {
    return this.nodes.get(nodeId);
  }

  async clearAll(): Promise<void> {
    for (const node of this.nodes.values()) {
      await node.clear();
    }
  }

  async closeAll(): Promise<void> {
    for (const node of this.nodes.values()) {
      await node.close();
    }
  }
}
export default DistributedCache;
