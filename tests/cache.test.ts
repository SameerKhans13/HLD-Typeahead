import { expect, test, describe } from "bun:test";
import { CacheNode, DistributedCache } from "../src/cache";

describe("Distributed Cache & Passive TTL", () => {
  test("Behavior 1: CacheNode returns value before expiration and null after", async () => {
    const node = new CacheNode("node-1");
    
    // Set value with 50ms TTL
    await node.set("key1", "value1", 50);
    
    // Immediate retrieval should hit
    expect(await node.get<string>("key1")).toBe("value1");

    // Wait for 60ms to guarantee expiration
    await new Promise(resolve => setTimeout(resolve, 60));

    // Retrieval should now miss (return null)
    expect(await node.get<string>("key1")).toBeNull();
  });

  test("Behavior 2: CacheNode implements passive deletion of expired entries", async () => { 
    const node = new CacheNode("node-1");

    await node.set("key1", "value1", 10);

    await new Promise(resolve => setTimeout(resolve, 20));

    // Triggers passive deletion
    expect(await node.get<string>("key1")).toBeNull();
    expect(node.getDebugSize()).toBe(0);
  });

  test("Behavior 3: DistributedCache routes to correct logical nodes and isolates state", async () => {
    const cache = new DistributedCache(["nodeA", "nodeB"]);

    const nodeA = cache.getNode("nodeA");
    const nodeB = cache.getNode("nodeB");

    expect(nodeA).toBeDefined();
    expect(nodeB).toBeDefined();
    expect(nodeA?.id).toBe("nodeA");
    expect(nodeB?.id).toBe("nodeB");

    // State isolation
    await nodeA?.set("key", "valA", 1000);
    await nodeB?.set("key", "valB", 1000);

    expect(await nodeA?.get<string>("key")).toBe("valA");
    expect(await nodeB?.get<string>("key")).toBe("valB");

    // Non-existent node
    expect(cache.getNode("nodeC")).toBeUndefined();
  });
});
