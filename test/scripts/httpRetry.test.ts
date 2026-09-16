import { describe, it, expect } from 'vitest';
import { fetchWithRetry } from '../../scripts/lib/httpRetry';

const noSleep = async (): Promise<void> => {};

describe('fetchWithRetry', () => {
  it('returns the response as-is on 200, no retry', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return new Response('ok', { status: 200 });
    };
    const res = await fetchWithRetry('https://example.test/x', fetchFn, { sleep: noSleep });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('returns a 404 as-is without retrying, so the caller can skip it', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return new Response('not found', { status: 404 });
    };
    const res = await fetchWithRetry('https://example.test/x', fetchFn, { sleep: noSleep });
    expect(res.status).toBe(404);
    expect(calls).toBe(1);
  });

  it('retries once on a 5xx and returns the successful retry', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return calls === 1 ? new Response('boom', { status: 503 }) : new Response('ok', { status: 200 });
    };
    const res = await fetchWithRetry('https://example.test/x', fetchFn, { sleep: noSleep });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('gives up after one retry and returns the last (failing) response', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return new Response('boom', { status: 500 });
    };
    const res = await fetchWithRetry('https://example.test/x', fetchFn, { sleep: noSleep });
    expect(res.status).toBe(500);
    expect(calls).toBe(2); // 1 initial + 1 retry, not more
  });

  it('retries once on a network-level rejection, then succeeds', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      if (calls === 1) throw new Error('network down');
      return new Response('ok', { status: 200 });
    };
    const res = await fetchWithRetry('https://example.test/x', fetchFn, { sleep: noSleep });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('throws after exhausting retries on a persistent network-level rejection', async () => {
    const fetchFn = async () => {
      throw new Error('network down');
    };
    await expect(fetchWithRetry('https://example.test/x', fetchFn, { sleep: noSleep })).rejects.toThrow('network down');
  });

  it('waits `delayMs` (via the injected sleep) between the initial attempt and the retry', async () => {
    const waited: number[] = [];
    const fetchFn = async () => new Response('boom', { status: 502 });
    await fetchWithRetry('https://example.test/x', fetchFn, {
      delayMs: 250,
      sleep: async (ms) => {
        waited.push(ms);
      },
    });
    expect(waited).toEqual([250]);
  });
});
