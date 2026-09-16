import { describe, it, expect } from 'vitest';
import { destinationPoint, haversineKm } from '../../src/engine/geo';
import { dedupeAdjacentWorld, dedupeAgainstCurated } from '../../scripts/lib/dedupe';
import spotsJson from '../../src/data/spots.json';

const CURATED = [
  { lat: -34.1085, lon: 18.4715 }, // Muizenberg (curated)
  { lat: -34.133, lon: 18.329 }, // Kommetjie Long Beach (curated)
];

describe('dedupeAgainstCurated', () => {
  it('drops a world spot within 500 m of a curated spot', () => {
    const close = destinationPoint(CURATED[0].lat, CURATED[0].lon, 45, 0.05); // 50 m away
    const { kept, droppedCount } = dedupeAgainstCurated([{ id: 'w1', ...close }], CURATED);
    expect(kept).toEqual([]);
    expect(droppedCount).toBe(1);
  });

  it('keeps a world spot just outside 500 m and drops one just inside (boundary)', () => {
    const outside = destinationPoint(CURATED[0].lat, CURATED[0].lon, 10, 0.501);
    const inside = destinationPoint(CURATED[0].lat, CURATED[0].lon, 10, 0.499);
    const { kept, droppedCount } = dedupeAgainstCurated(
      [
        { id: 'outside', ...outside },
        { id: 'inside', ...inside },
      ],
      CURATED,
    );
    expect(kept.map((s) => s.id)).toEqual(['outside']);
    expect(droppedCount).toBe(1);
  });

  it('keeps the real surf-forecast Muizenberg coordinate (~685 m from the curated one, outside the 500 m threshold)', () => {
    const surfForecastMuizenberg = { id: 'sf-muizenberg', lat: -34.1026, lon: 18.4737 };
    const { kept, droppedCount } = dedupeAgainstCurated([surfForecastMuizenberg], CURATED);
    expect(kept).toEqual([surfForecastMuizenberg]);
    expect(droppedCount).toBe(0);
  });

  it('drops when close to ANY curated spot, not just the first one in the list', () => {
    const nearSecond = destinationPoint(CURATED[1].lat, CURATED[1].lon, 200, 0.1);
    const { kept, droppedCount } = dedupeAgainstCurated([{ id: 'w', ...nearSecond }], CURATED);
    expect(kept).toEqual([]);
    expect(droppedCount).toBe(1);
  });

  it('keeps spots far from every curated spot and preserves their order', () => {
    const farA = { id: 'a', lat: 40.7128, lon: -74.006 };
    const farB = { id: 'b', lat: 51.5072, lon: -0.1276 };
    const { kept, droppedCount } = dedupeAgainstCurated([farA, farB], CURATED);
    expect(kept).toEqual([farA, farB]);
    expect(droppedCount).toBe(0);
  });

  it('returns zero drops against an empty curated list', () => {
    const spot = { id: 'w', lat: 0, lon: 0 };
    const { kept, droppedCount } = dedupeAgainstCurated([spot], []);
    expect(kept).toEqual([spot]);
    expect(droppedCount).toBe(0);
  });
});

describe('dedupeAdjacentWorld', () => {
  it('drops a world spot within 200 m of an earlier world spot', () => {
    const a = { id: 'a', lat: -34.5, lon: 18.5 };
    const close = { id: 'close', ...destinationPoint(a.lat, a.lon, 45, 0.05) }; // 50 m away
    const { kept, droppedCount } = dedupeAdjacentWorld([a, close]);
    expect(kept.map((s) => s.id)).toEqual(['a']);
    expect(droppedCount).toBe(1);
  });

  it('keeps a world spot just outside 200 m and drops one just inside (boundary)', () => {
    const a = { id: 'a', lat: -34.5, lon: 18.5 };
    const inside = { id: 'inside', ...destinationPoint(a.lat, a.lon, 10, 0.199) };
    const outside = { id: 'outside', ...destinationPoint(a.lat, a.lon, 190, 0.201) };
    const { kept, droppedCount } = dedupeAdjacentWorld([a, inside, outside]);
    expect(kept.map((s) => s.id)).toEqual(['a', 'outside']);
    expect(droppedCount).toBe(1);
  });

  it('is deterministic: the earlier spot in input order always wins a cluster, regardless of which one is closer to being "first" geographically', () => {
    const a = { id: 'a', lat: -34.5, lon: 18.5 };
    const b = { id: 'b', ...destinationPoint(a.lat, a.lon, 0, 0.05) }; // 50 m north of a
    const { kept: keptAB } = dedupeAdjacentWorld([a, b]);
    expect(keptAB.map((s) => s.id)).toEqual(['a']);
    const { kept: keptBA } = dedupeAdjacentWorld([b, a]);
    expect(keptBA.map((s) => s.id)).toEqual(['b']); // same pair, reversed order -> the (now-)earlier one wins
  });

  it('a chain of spots each ~150 m from the next does not collapse into a single survivor for the whole chain (only checked against already-kept spots, never retroactively)', () => {
    // A -150m-> B -150m-> C -150m-> D, colinear. Greedy against kept-so-far: A kept; B (150 m from A)
    // dropped; C (~300 m from A, the only kept spot) kept; D (150 m from C) dropped.
    const a = { id: 'a', lat: -34.5, lon: 18.5 };
    const b = { id: 'b', ...destinationPoint(a.lat, a.lon, 0, 0.15) };
    const c = { id: 'c', ...destinationPoint(a.lat, a.lon, 0, 0.30) };
    const d = { id: 'd', ...destinationPoint(a.lat, a.lon, 0, 0.45) };
    const { kept, droppedCount } = dedupeAdjacentWorld([a, b, c, d]);
    expect(kept.map((s) => s.id)).toEqual(['a', 'c']);
    expect(droppedCount).toBe(2);
  });

  it('handles multiple independent clusters, far apart from each other, without cross-contamination', () => {
    const clusterA = { id: 'a1', lat: -34.5, lon: 18.5 };
    const clusterA2 = { id: 'a2', ...destinationPoint(clusterA.lat, clusterA.lon, 0, 0.05) };
    const clusterB = { id: 'b1', lat: 40.7128, lon: -74.006 };
    const clusterB2 = { id: 'b2', ...destinationPoint(clusterB.lat, clusterB.lon, 90, 0.05) };
    const { kept, droppedCount } = dedupeAdjacentWorld([clusterA, clusterA2, clusterB, clusterB2]);
    expect(kept.map((s) => s.id)).toEqual(['a1', 'b1']);
    expect(droppedCount).toBe(2);
  });

  it('returns zero drops for an empty or single-spot input', () => {
    expect(dedupeAdjacentWorld([]).droppedCount).toBe(0);
    const spot = { id: 'w', lat: 0, lon: 0 };
    expect(dedupeAdjacentWorld([spot])).toEqual({ kept: [spot], droppedCount: 0 });
  });

  it('honours a custom threshold', () => {
    const a = { id: 'a', lat: -34.5, lon: 18.5 };
    const b = { id: 'b', ...destinationPoint(a.lat, a.lon, 0, 0.3) }; // 300 m away — survives the 200 m default
    expect(dedupeAdjacentWorld([a, b]).kept.map((s) => s.id)).toEqual(['a', 'b']);
    expect(dedupeAdjacentWorld([a, b], 500).kept.map((s) => s.id)).toEqual(['a']); // but not a 500 m threshold
  });

  it('the real curated Inner Kom / Outer Kom gap (~298 m, verified against src/data/spots.json) survives the 200 m default — genuinely distinct neighbours are never merged', () => {
    const innerKom = (spotsJson as { id: string; lat: number; lon: number }[]).find((s) => s.id === 'inner-kom')!;
    const outerKom = (spotsJson as { id: string; lat: number; lon: number }[]).find((s) => s.id === 'outer-kom')!;
    const gapM = haversineKm(innerKom, outerKom) * 1000;
    expect(gapM).toBeGreaterThan(290); // sanity: pins the real-world fact this threshold is chosen against
    expect(gapM).toBeLessThan(310);
    expect(gapM).toBeGreaterThan(200); // the actual property the 200 m threshold relies on
    const { kept, droppedCount } = dedupeAdjacentWorld([
      { id: 'world-inner-kom', lat: innerKom.lat, lon: innerKom.lon },
      { id: 'world-outer-kom', lat: outerKom.lat, lon: outerKom.lon },
    ]);
    expect(kept.map((s) => s.id).sort()).toEqual(['world-inner-kom', 'world-outer-kom']);
    expect(droppedCount).toBe(0);
  });
});
