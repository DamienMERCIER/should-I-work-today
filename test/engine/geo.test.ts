import { describe, it, expect } from 'vitest';
import { haversineKm, norm360, angularDistance, inArc, distanceOutsideArc, cardinal8 } from '../../src/engine/geo';

const MUIZENBERG = { lat: -34.1085, lon: 18.4715 };

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm(MUIZENBERG, MUIZENBERG)).toBe(0);
  });
  it('Muizenberg → Kommetjie Long Beach ≈ 13.4 km', () => {
    expect(haversineKm(MUIZENBERG, { lat: -34.133, lon: 18.329 })).toBeCloseTo(13.4, 0);
  });
  it('Muizenberg → Big Bay ≈ 35 km (outside the 20 km radius)', () => {
    expect(haversineKm(MUIZENBERG, { lat: -33.793, lon: 18.456 })).toBeCloseTo(35.1, 0);
  });
});

describe('angles', () => {
  it('normalises to [0, 360)', () => {
    expect(norm360(-10)).toBe(350);
    expect(norm360(370)).toBe(10);
    expect(norm360(360)).toBe(0);
  });
  it('angularDistance wraps around north', () => {
    expect(angularDistance(350, 10)).toBe(20);
    expect(angularDistance(120, 350)).toBe(130);
    expect(angularDistance(0, 180)).toBe(180);
  });
  it('inArc handles plain and wrapping arcs', () => {
    expect(inArc(200, 150, 250)).toBe(true);
    expect(inArc(260, 150, 250)).toBe(false);
    expect(inArc(10, 350, 30)).toBe(true);
    expect(inArc(100, 350, 30)).toBe(false);
  });
  it('distanceOutsideArc is 0 inside, nearest edge outside', () => {
    expect(distanceOutsideArc(200, 150, 250)).toBe(0);
    expect(distanceOutsideArc(260, 150, 250)).toBe(10);
    expect(distanceOutsideArc(130, 150, 250)).toBe(20);
  });
  it('cardinal8 buckets 45° sectors', () => {
    expect(cardinal8(0)).toBe(0);
    expect(cardinal8(225)).toBe(5);
    expect(cardinal8(337)).toBe(7);
    expect(cardinal8(338)).toBe(0);
  });
});
