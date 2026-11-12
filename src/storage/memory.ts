import type { KeyValueStore } from './backend.ts';

/** In-memory backend with JSON cloning, used by unit tests and benchmarks. */
export class MemoryStore implements KeyValueStore {
  private data = new Map<string, unknown>();
  /** When > 0, every set() throws — used to test write-error handling. */
  public failWrites = 0;

  constructor(initial?: Record<string, unknown>) {
    if (initial) {
      for (const [key, value] of Object.entries(initial)) {
        this.data.set(key, structuredClone(value));
      }
    }
  }

  async get(keys?: string[] | null): Promise<Record<string, unknown>> {
    if (keys == null) {
      return Object.fromEntries([...this.data.entries()].map(([key, value]) => [key, structuredClone(value)]));
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (this.data.has(key)) result[key] = structuredClone(this.data.get(key));
    }
    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new Error('Simulated storage write failure');
    }
    for (const [key, value] of Object.entries(items)) {
      this.data.set(key, structuredClone(value));
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) this.data.delete(key);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  size(): number {
    return this.data.size;
  }

  keys(): string[] {
    return [...this.data.keys()];
  }
}
