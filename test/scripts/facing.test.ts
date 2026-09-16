import { describe, it, expect } from 'vitest';
import { haversineKm } from '../../src/engine/geo';
import { circularMeanDeg, computeFacing, ringPoints } from '../../scripts/lib/facing';

describe('circularMeanDeg', () => {
  it('averages two bearings with no wrap', () => {
    expect(circularMeanDeg([80, 100])).toBeCloseTo(90, 6);
  });
  it('wraps correctly across 0°/360° (350° and 10° average to 0°, not 180°)', () => {
    expect(circularMeanDeg([350, 10])).toBeCloseTo(0, 6);
  });
  it('wraps correctly for a mean that lands just past 360°', () => {
    // 355 and 15 should average to 5 (5 either side of 0/360), not to 185
    expect(circularMeanDeg([355, 15])).toBeCloseTo(5, 6);
  });
  it('returns null for an empty list (nothing to average)', () => {
    expect(circularMeanDeg([])).toBeNull();
  });
  it('a single bearing averages to itself', () => {
    expect(circularMeanDeg([222])).toBeCloseTo(222, 6);
  });
});

describe('computeFacing', () => {
  it('averages only the bearings whose elevation is at or below sea level', () => {
    const ring = [
      { bearing: 80, elevation: -2 }, // sea
      { bearing: 100, elevation: 0 }, // sea (boundary, "≤ 0")
      { bearing: 200, elevation: 15 }, // land — excluded
      { bearing: 300, elevation: 120 }, // land — excluded
    ];
    expect(computeFacing(ring)).toBeCloseTo(90, 6);
  });
  it('returns null when no ring point is at or below sea level (spot skipped, not guessed)', () => {
    const ring = [
      { bearing: 0, elevation: 5 },
      { bearing: 90, elevation: 20 },
      { bearing: 180, elevation: 3 },
      { bearing: 270, elevation: 50 },
    ];
    expect(computeFacing(ring)).toBeNull();
  });
  it('returns null for an empty ring', () => {
    expect(computeFacing([])).toBeNull();
  });
});

describe('ringPoints', () => {
  it('defaults to 24 points evenly spaced by 15°', () => {
    const pts = ringPoints(-34.1026, 18.4737);
    expect(pts).toHaveLength(24);
    expect(pts.map((p) => p.bearing)).toEqual(Array.from({ length: 24 }, (_, i) => i * 15));
  });
  it('every point sits ~2 km (the default radius) from the centre', () => {
    const center = { lat: -34.1026, lon: 18.4737 };
    const pts = ringPoints(center.lat, center.lon);
    for (const p of pts) {
      expect(haversineKm(center, p)).toBeCloseTo(2, 2);
    }
  });
  it('honours a custom count and radius', () => {
    const pts = ringPoints(0, 0, 5, 4);
    expect(pts.map((p) => p.bearing)).toEqual([0, 90, 180, 270]);
    for (const p of pts) {
      expect(haversineKm({ lat: 0, lon: 0 }, p)).toBeCloseTo(5, 2);
    }
  });
});
