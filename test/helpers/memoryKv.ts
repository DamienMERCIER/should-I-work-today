import type { KVStore } from '../../src/adapters/kv';

export class MemoryKV implements KVStore {
  readonly data = new Map<string, { value: string; ttl?: number }>();
  readonly writes: string[] = [];

  async get(key: string, _type: 'json'): Promise<unknown> {
    const entry = this.data.get(key);
    return entry ? JSON.parse(entry.value) : null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.data.set(key, { value, ttl: options?.expirationTtl });
    this.writes.push(key);
  }
}
