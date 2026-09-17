import { describe, it, expect } from 'vitest';
import { daylightFactor, hasDaylightLeft, weatherFactor } from '../../src/engine/factors';

describe('hasDaylightLeft', () => {
  const sunrise = '2026-09-16T06:44';
  const sunset = '2026-09-16T18:38';

  it('is false from 18:00 on — the 18:00 slot holds only 38 min of day, so nothing surfable remains', () => {
    expect(hasDaylightLeft('2026-09-16T18:00', sunrise, sunset)).toBe(false);
    expect(hasDaylightLeft('2026-09-16T19:00', sunrise, sunset)).toBe(false);
    expect(hasDaylightLeft('2026-09-16T23:00', sunrise, sunset)).toBe(false);
  });

  it('is true at 17:00, the last hour that still counts — the cutoff is not sunset itself', () => {
    expect(hasDaylightLeft('2026-09-16T17:00', sunrise, sunset)).toBe(true);
  });

  it('is true before sunrise: the whole day is still ahead even though this very slot scores 0', () => {
    expect(daylightFactor('2026-09-16T04:00', sunrise, sunset)).toBe(0);
    expect(hasDaylightLeft('2026-09-16T04:00', sunrise, sunset)).toBe(true);
  });

  it('follows a winter day, where the last usable hour comes earlier', () => {
    const [rise, set] = ['2026-06-21T07:50', '2026-06-21T17:45'];
    expect(hasDaylightLeft('2026-06-21T16:00', rise, set)).toBe(true);
    expect(hasDaylightLeft('2026-06-21T17:00', rise, set)).toBe(true); // exactly 45 min of daylight: the threshold is `>=`
    expect(hasDaylightLeft('2026-06-21T18:00', rise, set)).toBe(false);
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
