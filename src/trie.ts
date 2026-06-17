export interface AutocompleteCompletion {
  query: string;
  count: number;
}

export class TrieNode {
  char: string;
  children: { [key: string]: TrieNode } = {};
  isWord: boolean = false;
  count: number = 0;
  queryStr?: string; // Storing the full query string at terminal node
  topCompletions: AutocompleteCompletion[] = [];

  constructor(char: string = "") {
    this.char = char;
  }
}

export class Trie {
  root: TrieNode;

  constructor() {
    this.root = new TrieNode();
  }

  insert(query: string, count: number): void {
    const cleanQuery = query.toLowerCase().trim();
    if (!cleanQuery) return;

    let current = this.root;
    const path: TrieNode[] = [this.root];
    
    for (const char of cleanQuery) {
      if (!current.children[char]) {
        current.children[char] = new TrieNode(char);
      }
      current = current.children[char];
      path.push(current);
    }
    
    current.isWord = true;
    current.count = count;
    current.queryStr = cleanQuery;

    // Traverse the path backwards from terminal node to root to update topCompletions
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i];
      const completionMap = new Map<string, number>();

      // 1. Add node itself if it is a terminal word
      if (node.isWord && node.queryStr) {
        completionMap.set(node.queryStr, node.count);
      }

      // 2. Add children's cached topCompletions
      for (const childChar in node.children) {
        const childNode = node.children[childChar];
        for (const completion of childNode.topCompletions) {
          completionMap.set(completion.query, completion.count);
        }
      }

      // 3. Map back to sorted list of top 10 completions
      node.topCompletions = Array.from(completionMap.entries())
        .map(([q, c]) => ({ query: q, count: c }))
        .sort((a, b) => {
          if (b.count !== a.count) {
            return b.count - a.count; // Sort by count descending
          }
          return a.query.localeCompare(b.query); // Deterministic alphabetic fallback
        })
        .slice(0, 10);
    }
  }

  getSuggestions(prefix: string): AutocompleteCompletion[] {
    const cleanPrefix = prefix.toLowerCase().trim();
    if (!cleanPrefix) return [];

    let current = this.root;
    for (const char of cleanPrefix) {
      if (!current.children[char]) {
        return [];
      }
      current = current.children[char];
    }
    return current.topCompletions;
  }

  getAllCompletions(prefix: string): AutocompleteCompletion[] {
    const cleanPrefix = prefix.toLowerCase().trim();
    if (!cleanPrefix) return [];

    let current = this.root;
    for (const char of cleanPrefix) {
      if (!current.children[char]) {
        return [];
      }
      current = current.children[char];
    }

    const results: AutocompleteCompletion[] = [];
    const collect = (node: TrieNode) => {
      if (node.isWord && node.queryStr) {
        results.push({ query: node.queryStr, count: node.count });
      }
      for (const char in node.children) {
        collect(node.children[char]);
      }
    };

    collect(current);
    return results;
  }
}
export default Trie;
