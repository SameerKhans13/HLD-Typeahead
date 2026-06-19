export interface CacheEntry<T> {
  value: T;
  expiry: number; // timestamp in ms
}

export class CacheNode {
  private store: Map<string, CacheEntry<any>> = new Map();
  public id: string;

  constructor(id: string) {
    this.id = id;
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.store.delete(key); // Passive eviction
      return null;
    }
    return entry.value;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, {
      value,
      expiry: Date.now() + ttlMs
    });
  }

  clear(): void {
    this.store.clear();
  }

  getDebugSize(): number {
    return this.store.size;
  }
}

export class DistributedCache {
  private nodes: Map<string, CacheNode> = new Map();

  constructor(nodeIds: string[]) {
    for (const id of nodeIds) {
      this.nodes.set(id, new CacheNode(id));
    }
  }

  getNode(nodeId: string): CacheNode | undefined {
    return this.nodes.get(nodeId);
  }

  clearAll(): void {
    for (const node of this.nodes.values()) {
      node.clear();
    }
  }
}
