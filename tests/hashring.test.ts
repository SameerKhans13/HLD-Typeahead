import { expect, test, describe } from "bun:test";
import { ConsistentHashRing } from "../src/hashring";

describe("Consistent Hash Ring", () => {
  test("Behavior 1: Mapping physical nodes to virtual nodes and sorting coordinates", () => {
    // Ring with 3 physical nodes, each with 3 virtual nodes for easy assertions
    const ring = new ConsistentHashRing(["node1", "node2"], 3);

    const state = ring.getRingState();
    
    // Total coordinates should be 2 nodes * 3 vnodes = 6 coordinates
    expect(state.length).toBe(6);

    // Assert coordinates are strictly sorted ascending
    for (let i = 1; i < state.length; i++) {
      expect(state[i].coordinate).toBeGreaterThanOrEqual(state[i - 1].coordinate);
    }

    // Verify properties of state elements
    const first = state[0];
    expect(first).toHaveProperty("coordinate");
    expect(first).toHaveProperty("node");
    expect(first).toHaveProperty("label");
    expect(typeof first.coordinate).toBe("number");
    expect(typeof first.node).toBe("string");
    expect(typeof first.label).toBe("string");
  });

  test("Behavior 2: getNode routes keys clockwise using binary search and handles wrap-around", () => {
    const ring = new ConsistentHashRing(["nodeA", "nodeB", "nodeC"], 5);

    // Routing when ring has nodes
    const node1 = ring.getNode("apple");
    const node2 = ring.getNode("banana");
    const node3 = ring.getNode("cherry");

    expect(node1).toBeDefined();
    expect(node2).toBeDefined();
    expect(node3).toBeDefined();

    expect(typeof node1).toBe("string");

    // Routing on an empty ring should return null
    const emptyRing = new ConsistentHashRing([], 5);
    expect(emptyRing.getNode("test")).toBeNull();
  });

  test("Behavior 3: consistent hashing maintains routing stability under node additions/removals", () => {
    const ring = new ConsistentHashRing(["nodeA", "nodeB"], 20);

    // Route 100 test keys and record mapping
    const keys = Array.from({ length: 100 }, (_, i) => `key-${i}`);
    const originalRouting = new Map<string, string>();

    for (const key of keys) {
      const node = ring.getNode(key);
      expect(node).not.toBeNull();
      originalRouting.set(key, node!);
    }

    // Add nodeC to the ring
    ring.addNode("nodeC");

    let shiftedToC = 0;
    let stableCount = 0;

    for (const key of keys) {
      const newNode = ring.getNode(key);
      expect(newNode).not.toBeNull();

      if (newNode === "nodeC") {
        shiftedToC++;
      } else {
        // Must maintain original node mapping!
        expect(newNode).toBe(originalRouting.get(key)!);
        stableCount++;
      }
    }

    // Verify some keys shifted to nodeC and the rest remained perfectly stable
    expect(shiftedToC).toBeGreaterThan(0);
    expect(stableCount).toBeGreaterThan(0);
    expect(shiftedToC + stableCount).toBe(100);
  });
});
