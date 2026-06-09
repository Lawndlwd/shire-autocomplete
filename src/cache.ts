// Tiny LRU keyed by a hash of the FIM prompt. Two wins:
//  1. Identical context (cursor bouncing around) serves instantly, no network.
//  2. When the user types exactly the characters we already predicted, we can
//     serve the remaining tail locally instead of round-tripping. That tail
//     logic lives in the provider; this is just the store.

export class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private cap = 200) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // refresh recency
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V) {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
  }

  clear() {
    this.map.clear();
  }
}

// Two FNV-1a passes with different seeds, concatenated → ~64-bit key. A single
// 32-bit hash collides at ~1-in-65k over a 200-entry cache (birthday bound),
// and a collision silently serves the wrong completion; 64 bits makes that
// effectively impossible while staying a couple of cheap integer loops.
export function hash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca77);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
