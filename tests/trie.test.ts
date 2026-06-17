import { expect, test, describe } from "bun:test";
import { Trie } from "../src/trie";

describe("Trie Data Structure & Node Caching", () => {
  test("Behavior 1: Inserting words into the Trie correctly registers them", () => {
    const trie = new Trie();
    
    trie.insert("cat", 100);
    trie.insert("car", 200);

    // Verify root is populated
    expect(trie.root.children["c"]).toBeDefined();

    // Verify path "c" -> "a" -> "t"
    const nodeC = trie.root.children["c"];
    expect(nodeC.char).toBe("c");

    const nodeA = nodeC.children["a"];
    expect(nodeA).toBeDefined();
    expect(nodeA.char).toBe("a");

    const nodeT = nodeA.children["t"];
    expect(nodeT).toBeDefined();
    expect(nodeT.char).toBe("t");
    expect(nodeT.isWord).toBe(true);
    expect(nodeT.count).toBe(100);

    const nodeR = nodeA.children["r"];
    expect(nodeR).toBeDefined();
    expect(nodeR.char).toBe("r");
    expect(nodeR.isWord).toBe(true);
    expect(nodeR.count).toBe(200);
  });

  test("Behavior 2: TrieNode dynamically caches sorted topCompletions along its path", () => {
    const trie = new Trie();

    trie.insert("cat", 100);
    trie.insert("car", 200);
    trie.insert("cab", 300);
    trie.insert("dog", 150);

    const nodeC = trie.root.children["c"];
    expect(nodeC).toBeDefined();

    // Check nodeC.topCompletions
    const cCompletions = nodeC.topCompletions;
    expect(cCompletions.length).toBe(3);

    // Should be sorted by count desc
    expect(cCompletions[0]).toEqual({ query: "cab", count: 300 });
    expect(cCompletions[1]).toEqual({ query: "car", count: 200 });
    expect(cCompletions[2]).toEqual({ query: "cat", count: 100 });

    // Check root.topCompletions (should include dog)
    const rootCompletions = trie.root.topCompletions;
    expect(rootCompletions.length).toBe(4);
    expect(rootCompletions[0]).toEqual({ query: "cab", count: 300 });
    expect(rootCompletions[1]).toEqual({ query: "car", count: 200 });
    expect(rootCompletions[2]).toEqual({ query: "dog", count: 150 });
    expect(rootCompletions[3]).toEqual({ query: "cat", count: 100 });
  });

  test("Behavior 3: Trie.getSuggestions returns correct matching suggestions", () => {       
    const trie = new Trie();

    trie.insert("cat", 100);
    trie.insert("car", 200);
    trie.insert("cab", 300);
    trie.insert("dog", 150);

    // Prefix "ca" should return cab, car, cat
    const suggestionsCA = trie.getSuggestions("ca");
    expect(suggestionsCA.length).toBe(3);
    expect(suggestionsCA[0].query).toBe("cab");
    expect(suggestionsCA[1].query).toBe("car");
    expect(suggestionsCA[2].query).toBe("cat");

    // Case-insensitivity and padding whitespace check
    const suggestionsCA_noisy = trie.getSuggestions("  Ca  ");
    expect(suggestionsCA_noisy).toEqual(suggestionsCA);

    // Empty or empty-space queries should return empty suggestions array
    expect(trie.getSuggestions("")).toEqual([]);
    expect(trie.getSuggestions("   ")).toEqual([]);

    // Missing prefixes with no matches should return empty suggestions array
    expect(trie.getSuggestions("xyz")).toEqual([]);
  });

  test("Behavior 4: Trie.getAllCompletions recursively finds all terminal words under prefix", () => {
    const trie = new Trie();

    trie.insert("cat", 100);
    trie.insert("car", 200);
    trie.insert("cabin", 300);
    trie.insert("dog", 150);

    const allCA = trie.getAllCompletions("ca");
    expect(allCA.length).toBe(3);

    const queries = allCA.map((c: any) => c.query);
    expect(queries).toContain("cat");
    expect(queries).toContain("car");
    expect(queries).toContain("cabin");
    expect(queries).not.toContain("dog");

    expect(trie.getAllCompletions("xyz")).toEqual([]);
    expect(trie.getAllCompletions("")).toEqual([]);
  });
});
