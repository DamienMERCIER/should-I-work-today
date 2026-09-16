import { describe, it, expect } from 'vitest';
import { ringPoints, circularMeanDeg } from '../../scripts/lib/facing';
import { computeFacingsForSpots } from '../../scripts/lib/spotFacing';

describe('computeFacingsForSpots', () => {
  it('packs multiple spots\' rings into shared ≤100-point batches and reassembles facing per spot correctly', async () => {
    // 5 spots × 24 ring points = 120 points → batches of [100, 20]. Spot 4's own ring (points
    // 96..119) straddles that boundary: its first 4 points land in batch 1, the other 20 in batch 2.
    // If reassembly ever mixed spots up, this spot's facing would come out wrong.
    const spots = Array.from({ length: 5 }, (_, i) => ({ lat: i, lon: 0 }));
    // Elevation map keyed by rounded "lat,lon" so the fake server can answer regardless of batching.
    const seaBearings = [30, 330]; // one before the split (ring idx 2), one after (ring idx 22)
    const elevationFor = new Map<string, number>();
    const key = (lat: number, lon: number) => `${lat.toFixed(4)},${lon.toFixed(4)}`;
    for (const spot of spots) {
      for (const p of ringPoints(spot.lat, spot.lon)) {
        elevationFor.set(key(p.lat, p.lon), seaBearings.includes(p.bearing) ? -5 : 80);
      }
    }

    const requestSizes: number[] = [];
    const fetchFn = async (url: string) => {
      const u = new URL(url);
      const lats = u.searchParams.get('latitude')!.split(',').map(Number);
      const lons = u.searchParams.get('longitude')!.split(',').map(Number);
      requestSizes.push(lats.length);
      const elevation = lats.map((lat, i) => elevationFor.get(key(lat, lons[i])) ?? 80);
      return new Response(JSON.stringify({ elevation }), { status: 200 });
    };

    const outcomes = await computeFacingsForSpots(spots, fetchFn, { sleep: async () => {} });

    expect(requestSizes).toEqual([100, 20]);
    expect(outcomes).toHaveLength(5);
    const expected = circularMeanDeg(seaBearings)!;
    for (const outcome of outcomes) {
      expect('facing' in outcome && outcome.facing).toBeCloseTo(expected, 6);
    }
  });

  it('skips (reason "no-sea-point") for a spot with no sea point in its ring — never guesses', async () => {
    const spots = [{ lat: 10, lon: 10 }];
    const fetchFn = async (url: string) => {
      const count = new URL(url).searchParams.get('latitude')!.split(',').length;
      return new Response(JSON.stringify({ elevation: Array(count).fill(200) }), { status: 200 }); // all land
    };
    const outcomes = await computeFacingsForSpots(spots, fetchFn, { sleep: async () => {} });
    expect(outcomes).toEqual([{ skipped: { reason: 'no-sea-point' } }]);
  });

  it('returns an empty array for no spots', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ elevation: [] }), { status: 200 });
    expect(await computeFacingsForSpots([], fetchFn, { sleep: async () => {} })).toEqual([]);
  });

  it('skips (reason "elevation-error"), never throws, when the elevation batch persistently fails — a null must never be read as "sea"', async () => {
    const spots = [{ lat: 10, lon: 10 }];
    const fetchFn = async () => new Response('boom', { status: 500 });
    const outcomes = await computeFacingsForSpots(spots, fetchFn, { sleep: async () => {} });
    expect(outcomes).toEqual([{ skipped: { reason: 'elevation-error' } }]);
  });

  it('only the spot(s) whose ring lands inside a failed batch are skipped — a spot in a healthy batch still gets its facing', async () => {
    // spotA (24 pts) + 5 filler spots (120 pts) push spotB's whole 24-point ring past index 100
    // (§elevation.ts MAX_POINTS_PER_REQUEST) — spotA lands entirely in batch 1, spotB entirely in
    // batch 2. Only batch 2 (identified by carrying a point near spotB's own latitude) is made to
    // fail persistently.
    const spotA = { lat: 0, lon: 0 };
    const fillers = Array.from({ length: 5 }, (_, i) => ({ lat: 20 + i, lon: 0 }));
    const spotB = { lat: 60, lon: 0 };
    const seaBearings = [90];
    // Keyed by the same 4-decimal rounding the real request URL uses (`elevationUrl`'s `toFixed(4)`),
    // so comparing against the URL-parsed value never trips on float precision.
    const key = (lat: number, lon: number) => `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const bearingByKey = new Map(ringPoints(spotA.lat, spotA.lon).map((p) => [key(p.lat, p.lon), p.bearing]));
    const fetchFn = async (url: string) => {
      const u = new URL(url);
      const lats = u.searchParams.get('latitude')!.split(',').map(Number);
      if (lats.some((l) => Math.abs(l - spotB.lat) < 0.5)) return new Response('boom', { status: 500 });
      const lons = u.searchParams.get('longitude')!.split(',').map(Number);
      const elevation = lats.map((lat, i) => {
        const bearing = bearingByKey.get(key(lat, lons[i]));
        return bearing !== undefined && seaBearings.includes(bearing) ? -5 : 80;
      });
      return new Response(JSON.stringify({ elevation }), { status: 200 });
    };
    const outcomes = await computeFacingsForSpots([spotA, ...fillers, spotB], fetchFn, { sleep: async () => {} });
    expect(outcomes).toHaveLength(7);
    expect('facing' in outcomes[0]).toBe(true); // spotA: whole batch healthy
    expect(outcomes[6]).toEqual({ skipped: { reason: 'elevation-error' } }); // spotB: whole batch failed
  });
});
