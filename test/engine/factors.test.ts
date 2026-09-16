import { describe, it, expect } from 'vitest';
import {
  piecewise, effectiveBand, sizeFactor, periodFactor, windRelation, windFactor, tideFactor, daylightFactor, weatherFactor,
} from '../../src/engine/factors';
import { SCORING } from '../../src/config';
import type { Spot } from '../../src/types';

const spot = (levels: Spot['levels']): Spot => ({
  id: 's', name: 'S', region: 'r', lat: 0, lon: 0, facing: 300, swellWindow: [200, 290], exposure: 1,
  tide: { best: [], forbidden: [] }, levels, character: 'mellow', verified: true,
});

describe('piecewise', () => {
  it('interpolates the offshore wind curve', () => {
    const c = SCORING.wind.offshore;
    expect(piecewise(c, 10)).toBe(1);
    expect(piecewise(c, 15)).toBe(1);
    expect(piecewise(c, 18)).toBeCloseTo(0.82, 6);
    expect(piecewise(c, 25)).toBeCloseTo(0.4, 6);
    expect(piecewise(c, 30)).toBeCloseTo(0.2, 6);
    expect(piecewise(c, 35)).toBe(0);
    expect(piecewise(c, 40)).toBe(0);
  });
});

describe('effectiveBand', () => {
  const s = spot({ beginner: [1, 3], intermediate: [2, 5] });
  it('shifts by board', () => {
    expect(effectiveBand(s, 'intermediate', 'shortboard')).toEqual([3, 6]);
    expect(effectiveBand(s, 'intermediate', 'longboard')).toEqual([1, 4]);
    expect(effectiveBand(s, 'intermediate', 'both')).toEqual([1, 6]);
  });
  it('never goes below 1 ft', () => {
    expect(effectiveBand(s, 'beginner', 'longboard')).toEqual([1, 2]);
  });
  it('is null when the level is closed', () => {
    expect(effectiveBand(s, 'advanced', 'both')).toBeNull();
  });
});

describe('sizeFactor (band 3–6 ft)', () => {
  const band: [number, number] = [3, 6];
  it('is 1 inside, fades to 0 at min−1 and max+2', () => {
    expect(sizeFactor(4, band)).toBe(1);
    expect(sizeFactor(3, band)).toBe(1);
    expect(sizeFactor(6, band)).toBe(1);
    expect(sizeFactor(2.5, band)).toBeCloseTo(0.5, 6);
    expect(sizeFactor(2, band)).toBe(0);
    expect(sizeFactor(1, band)).toBe(0);
    expect(sizeFactor(7, band)).toBeCloseTo(0.5, 6);
    expect(sizeFactor(8, band)).toBe(0);
    expect(sizeFactor(9, band)).toBe(0);
  });
});

describe('periodFactor', () => {
  it('0.3 at ≤7 s, 1 at ≥11 s, linear between', () => {
    expect(periodFactor(6)).toBeCloseTo(0.3, 6);
    expect(periodFactor(7)).toBeCloseTo(0.3, 6);
    expect(periodFactor(9)).toBeCloseTo(0.65, 6);
    expect(periodFactor(11)).toBe(1);
    expect(periodFactor(14)).toBe(1);
  });
});

describe('windRelation (spot facing 300 → offshore = 120)', () => {
  it('classifies by angle to the offshore direction', () => {
    expect(windRelation(120, 300)).toBe('offshore');
    expect(windRelation(90, 300)).toBe('offshore');
    expect(windRelation(200, 300)).toBe('cross');
    expect(windRelation(230, 300)).toBe('onshore');
  });
  it('SE wind is onshore on a south-facing beach (facing 170)', () => {
    expect(windRelation(120, 170)).toBe('onshore');
    expect(windRelation(340, 170)).toBe('offshore');
  });
});

describe('windFactor', () => {
  it('cross and onshore curves', () => {
    expect(windFactor(8, 'cross')).toBe(1);
    expect(windFactor(15, 'cross')).toBeCloseTo(0.5, 6);
    expect(windFactor(20, 'cross')).toBeCloseTo(0.25, 6);
    expect(windFactor(5, 'onshore')).toBe(1);
    expect(windFactor(8, 'onshore')).toBeCloseTo(0.7, 6);
    expect(windFactor(10, 'onshore')).toBeCloseTo(0.5, 6);
    expect(windFactor(18, 'onshore')).toBe(0);
  });
});

describe('tideFactor', () => {
  it('forbidden → 0, any → 1, preferred → 1, otherwise 0.6', () => {
    expect(tideFactor('low', { best: ['mid', 'high'], forbidden: ['low'] })).toBe(0);
    expect(tideFactor('low', { best: [], forbidden: [] })).toBe(1);
    expect(tideFactor('mid', { best: ['mid', 'high'], forbidden: [] })).toBe(1);
    expect(tideFactor('low', { best: ['mid', 'high'], forbidden: [] })).toBe(0.6);
  });
});

describe('daylightFactor (≥ 45 min of daylight in the slot)', () => {
  const sunrise = '2026-09-16T06:44';
  const sunset = '2026-09-16T18:38';
  it('excludes the sunrise slot with 16 min, includes full slots, excludes the 38-min sunset slot', () => {
    expect(daylightFactor('2026-09-16T06:00', sunrise, sunset)).toBe(0);
    expect(daylightFactor('2026-09-16T07:00', sunrise, sunset)).toBe(1);
    expect(daylightFactor('2026-09-16T17:00', sunrise, sunset)).toBe(1);
    expect(daylightFactor('2026-09-16T18:00', sunrise, sunset)).toBe(0);
  });
  it('winter sunrise 07:50 opens the 08:00 slot, not 07:00', () => {
    expect(daylightFactor('2026-06-21T07:00', '2026-06-21T07:50', '2026-06-21T17:45')).toBe(0);
    expect(daylightFactor('2026-06-21T08:00', '2026-06-21T07:50', '2026-06-21T17:45')).toBe(1);
  });
});

describe('weatherFactor', () => {
  it('zeroes thunderstorms only', () => {
    expect(weatherFactor(95)).toBe(0);
    expect(weatherFactor(99)).toBe(0);
    expect(weatherFactor(61)).toBe(1);
  });
});
