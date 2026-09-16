import { sleep as defaultSleep, type FetchLike } from '../../src/adapters/http';

export interface RetryOptions {
  retries?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One retry after a short delay on a 5xx or a network-level failure (timeout, DNS, ...) — mirrors
 * `src/adapters/openMeteo.ts`'s `fetchJsonWithRetry`, but returns the raw `Response` instead of
 * parsed JSON, since stage 1 (sitemap XML, gzipped) and stage 2 (break page HTML) aren't JSON. A 404
 * is returned as-is, not retried: it means "this slug doesn't exist" (a stale sitemap entry, most
 * likely), and the caller (stage 2) is expected to count it and move on rather than treat it as
 * transient.
 */
export async function fetchWithRetry(url: string, fetchFn: FetchLike, opts: RetryOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 1;
  const delayMs = opts.delayMs ?? 2000;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchFn(url);
      if (res.ok || res.status === 404) return res;
      lastError = new Error(`HTTP ${res.status} for ${url}`);
      if (attempt === retries) return res; // exhausted: hand the last failing response back
    } catch (err) {
      lastError = err;
      if (attempt === retries) throw err;
    }
    await sleep(delayMs);
  }
  throw lastError;
}
