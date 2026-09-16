/**
 * Runs `fn` over `items` with at most `limit` in flight at once, resolving to results in the same
 * order as `items` (not completion order). Shared by stage 2 (fetching break pages, concurrency 4 per
 * the import spec) and stage 3 (elevation batch requests) — a plain `Promise.all` would fire every
 * request at once, which is not "an honest identifying User-Agent" behaving politely toward a site
 * that does not require a key.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}
