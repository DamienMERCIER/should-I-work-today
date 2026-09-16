import { describe, it, expect } from 'vitest';
import { fetchBreakPages } from '../../scripts/lib/fetchBreaks';

const blobFor = (name: string, lat: number, lon: number, type = 'Beach') =>
  `<script>var x = {"maps":[{"currentLocation":{"name":"${name}","filename":"${name}","lat":${lat},"lng":${lon},"type":"${type}"}}]};</script>`;

describe('fetchBreakPages', () => {
  it('fetches every slug and returns parsed results with concurrency respected', async () => {
    const slugs = ['A', 'B', 'C', 'D', 'E', 'F'];
    let active = 0;
    let maxActive = 0;
    const fetchFn = async (url: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const slug = url.split('/breaks/')[1].split('/')[0];
      await Promise.resolve();
      active--;
      return new Response(blobFor(slug, -34, 18), { status: 200 });
    };
    const { results, skipped } = await fetchBreakPages(slugs, fetchFn, { concurrency: 4, delayMs: 0, sleep: async () => {} });
    expect(results.map((r) => r.slug).sort()).toEqual(slugs);
    expect(skipped).toEqual([]);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it('skips a 404 (stale sitemap entry) without crashing the run', async () => {
    const fetchFn = async (url: string) => (url.includes('Gone') ? new Response('nope', { status: 404 }) : new Response(blobFor('Here', -1, 1), { status: 200 }));
    const { results, skipped } = await fetchBreakPages(['Here', 'Gone'], fetchFn, { sleep: async () => {} });
    expect(results.map((r) => r.slug)).toEqual(['Here']);
    expect(skipped).toEqual([{ slug: 'Gone', reason: '404' }]);
  });

  it('skips a page with no coordinate blob without crashing the run', async () => {
    const fetchFn = async () => new Response('<html>nothing here</html>', { status: 200 });
    const { results, skipped } = await fetchBreakPages(['NoBlob'], fetchFn, { sleep: async () => {} });
    expect(results).toEqual([]);
    expect(skipped).toEqual([{ slug: 'NoBlob', reason: 'no-coordinate-blob' }]);
  });

  it('retries once on a 5xx, then succeeds', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return calls === 1 ? new Response('boom', { status: 502 }) : new Response(blobFor('Retried', -1, 1), { status: 200 });
    };
    const { results, skipped } = await fetchBreakPages(['Retried'], fetchFn, { sleep: async () => {} });
    expect(results.map((r) => r.slug)).toEqual(['Retried']);
    expect(skipped).toEqual([]);
    expect(calls).toBe(2);
  });

  it('skips (rather than throws) a persistent 5xx after the retry is exhausted', async () => {
    const fetchFn = async () => new Response('boom', { status: 500 });
    const { results, skipped } = await fetchBreakPages(['Down'], fetchFn, { sleep: async () => {} });
    expect(results).toEqual([]);
    expect(skipped).toEqual([{ slug: 'Down', reason: 'http-500' }]);
  });

  it('skips (rather than rejecting the whole run) a slug whose fetch rejects on every attempt — a real network failure surviving the retry', async () => {
    const fetchFn = async () => {
      throw new Error('ECONNRESET');
    };
    const { results, skipped } = await fetchBreakPages(['Flaky'], fetchFn, { sleep: async () => {} });
    expect(results).toEqual([]);
    expect(skipped).toEqual([{ slug: 'Flaky', reason: 'network-error' }]);
  });

  it('one slug rejecting on every attempt does not discard the other slugs in the same chunk — successes included', async () => {
    const fetchFn = async (url: string) => {
      if (url.includes('/breaks/Flaky/')) throw new Error('ECONNRESET');
      const slug = url.split('/breaks/')[1].split('/')[0];
      return new Response(blobFor(slug, -34, 18), { status: 200 });
    };
    const slugs = ['A', 'Flaky', 'B', 'C'];
    const { results, skipped } = await fetchBreakPages(slugs, fetchFn, { concurrency: 4, delayMs: 0, sleep: async () => {} });
    expect(results.map((r) => r.slug).sort()).toEqual(['A', 'B', 'C']);
    expect(skipped).toEqual([{ slug: 'Flaky', reason: 'network-error' }]);
  });

  it('still waits the polite delay after a slug that rejected (finally runs on the error path too)', async () => {
    let sleeps = 0;
    const fetchFn = async () => {
      throw new Error('boom');
    };
    await fetchBreakPages(['Flaky'], fetchFn, {
      delayMs: 42,
      sleep: async () => {
        sleeps++;
      },
    });
    expect(sleeps).toBeGreaterThanOrEqual(1);
  });

  it('waits between requests (a short, polite delay)', async () => {
    let sleeps = 0;
    const fetchFn = async () => new Response(blobFor('S', -1, 1), { status: 200 });
    await fetchBreakPages(['A', 'B', 'C'], fetchFn, {
      concurrency: 1,
      delayMs: 42,
      sleep: async () => {
        sleeps++;
      },
    });
    expect(sleeps).toBeGreaterThanOrEqual(3);
  });
});
