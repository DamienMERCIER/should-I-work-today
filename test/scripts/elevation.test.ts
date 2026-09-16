import { describe, it, expect } from 'vitest';
import { elevationUrl, fetchElevations } from '../../scripts/lib/elevation';

describe('elevationUrl', () => {
  it('builds an Open-Meteo elevation URL carrying all the given points, comma-joined, 4 decimals', () => {
    const url = new URL(elevationUrl([{ lat: -34.1, lon: 18.5 }, { lat: -34.2, lon: 18.6 }]));
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/elevation');
    expect(url.searchParams.get('latitude')).toBe('-34.1000,-34.2000');
    expect(url.searchParams.get('longitude')).toBe('18.5000,18.6000');
  });
});

describe('fetchElevations', () => {
  it('batches at most 100 coordinates per request', async () => {
    const points = Array.from({ length: 250 }, (_, i) => ({ lat: i, lon: 0 }));
    const requestSizes: number[] = [];
    const fetchFn = async (url: string) => {
      const u = new URL(url);
      const lats = u.searchParams.get('latitude')!.split(',');
      requestSizes.push(lats.length);
      return new Response(JSON.stringify({ elevation: lats.map(Number) }), { status: 200 });
    };
    await fetchElevations(points, fetchFn, { sleep: async () => {} });
    expect(requestSizes).toEqual([100, 100, 50]);
  });

  it('returns elevations in the same order as the input points, across multiple batches', async () => {
    const points = Array.from({ length: 250 }, (_, i) => ({ lat: i, lon: 0 }));
    const fetchFn = async (url: string) => {
      const u = new URL(url);
      const lats = u.searchParams.get('latitude')!.split(',').map(Number);
      return new Response(JSON.stringify({ elevation: lats }), { status: 200 });
    };
    const elevations = await fetchElevations(points, fetchFn, { sleep: async () => {} });
    expect(elevations).toEqual(points.map((p) => p.lat));
  });

  it('returns an empty array for no points, without making a request', async () => {
    let called = false;
    const fetchFn = async () => {
      called = true;
      return new Response(JSON.stringify({ elevation: [] }), { status: 200 });
    };
    expect(await fetchElevations([], fetchFn, { sleep: async () => {} })).toEqual([]);
    expect(called).toBe(false);
  });

  it('retries once on a 5xx batch response, per the shared retry policy', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      if (calls === 1) return new Response('boom', { status: 503 });
      return new Response(JSON.stringify({ elevation: [12] }), { status: 200 });
    };
    const elevations = await fetchElevations([{ lat: 1, lon: 2 }], fetchFn, { sleep: async () => {} });
    expect(elevations).toEqual([12]);
    expect(calls).toBe(2);
  });

  it('yields null for every point in a batch (never throws) after a persistent 5xx exhausts the retry', async () => {
    const fetchFn = async () => new Response('boom', { status: 503 });
    const points = [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }];
    const elevations = await fetchElevations(points, fetchFn, { sleep: async () => {} });
    expect(elevations).toEqual([null, null]);
  });

  it('yields null for every point in a batch (never throws) when the fetch itself rejects on every attempt', async () => {
    const fetchFn = async () => {
      throw new Error('ECONNRESET');
    };
    const points = [{ lat: 1, lon: 2 }];
    expect(await fetchElevations(points, fetchFn, { sleep: async () => {} })).toEqual([null]);
  });

  it('yields null for every point in a batch (never throws) whose body is malformed (missing/short elevation array)', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ elevation: [1] }), { status: 200 }); // 2 points requested, 1 returned
    const points = [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }];
    expect(await fetchElevations(points, fetchFn, { sleep: async () => {} })).toEqual([null, null]);
  });

  it('a failed batch only nulls its own points — other batches in the same call still resolve normally', async () => {
    // 250 points -> batches of [100, 100, 50] (§ "batches at most 100 coordinates per request"). Only
    // the middle batch (points 100..199, identified by its first coordinate) fails PERSISTENTLY — every
    // attempt, retry included — so the first and last 100/50 points must come back as real numbers.
    const points = Array.from({ length: 250 }, (_, i) => ({ lat: i, lon: 0 }));
    const fetchFn = async (url: string) => {
      const lats = new URL(url).searchParams.get('latitude')!.split(',').map(Number);
      if (lats[0] === 100) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ elevation: lats }), { status: 200 });
    };
    const elevations = await fetchElevations(points, fetchFn, { sleep: async () => {} });
    expect(elevations.slice(0, 100)).toEqual(points.slice(0, 100).map((p) => p.lat));
    expect(elevations.slice(100, 200)).toEqual(Array(100).fill(null));
    expect(elevations.slice(200, 250)).toEqual(points.slice(200, 250).map((p) => p.lat));
  });
});
