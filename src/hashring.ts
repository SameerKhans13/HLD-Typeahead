export function fnv1a(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export interface VirtualNodeState {
  coordinate: number;
  label: string;
  node: string;
}

export class ConsistentHashRing {
  private virtualNodesCount: number;
  private ring: VirtualNodeState[] = [];
  private nodes: Set<string> = new Set();

  constructor(initialNodes: string[] = [], virtualNodesCount: number = 20) {
    this.virtualNodesCount = virtualNodesCount;
    for (const node of initialNodes) {
      this.addNode(node);
    }
  }

  addNode(node: string): void {
    if (this.nodes.has(node)) return;
    this.nodes.add(node);

    for (let i = 0; i < this.virtualNodesCount; i++) {
      const label = `${node}-v${i}`;
      const coordinate = fnv1a(label);
      this.ring.push({ coordinate, label, node });
    }

    // Sort ring coordinates ascending
    this.ring.sort((a, b) => a.coordinate - b.coordinate);
  }

  removeNode(node: string): void {
    if (!this.nodes.has(node)) return;
    this.nodes.delete(node);
    this.ring = this.ring.filter(v => v.node !== node);
  }

  getNode(key: string): string | null {
    if (this.ring.length === 0) return null;

    const keyHash = fnv1a(key);
    
    let low = 0;
    let high = this.ring.length - 1;
    let idx = 0; // Default wrap-around to index 0

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.ring[mid].coordinate >= keyHash) {
        idx = mid;
        high = mid - 1; // Binary search left side for closer node coordinate
      } else {
        low = mid + 1;
      }
    }

    return this.ring[idx].node;
  }

  getRingState(): VirtualNodeState[] {
    return this.ring;
  }
}
