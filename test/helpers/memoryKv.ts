import type { KVListResult, KVStore } from '../../src/adapters/kv';

export class MemoryKV implements KVStore {
  readonly data = new Map<string, { value: string; ttl?: number; metadata?: unknown }>();
  readonly writes: string[] = [];
  readonly gets: string[] = [];

  /** `pageSize` : clés par page de `list` (1 000 chez Cloudflare), réduit en test pour exercer le curseur. */
  constructor(private readonly pageSize = 1000) {}

  async get(key: string, _type: 'json'): Promise<unknown> {
    this.gets.push(key);
    const entry = this.data.get(key);
    return entry ? JSON.parse(entry.value) : null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void> {
    // KV sérialise les métadonnées : une copie, jamais l'objet de l'appelant
    const metadata = options?.metadata === undefined ? undefined : JSON.parse(JSON.stringify(options.metadata));
    this.data.set(key, { value, ttl: options?.expirationTtl, metadata });
    this.writes.push(key);
  }

  async list(options: { prefix: string; cursor?: string }): Promise<KVListResult> {
    const names = [...this.data.keys()].filter((k) => k.startsWith(options.prefix)).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const page = names.slice(start, start + this.pageSize);
    const next = start + page.length;
    const complete = next >= names.length;
    return { keys: page.map((name) => ({ name, metadata: this.data.get(name)?.metadata })), list_complete: complete, cursor: complete ? undefined : String(next) };
  }
}
