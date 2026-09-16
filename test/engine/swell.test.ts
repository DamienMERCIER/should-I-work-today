import { describe, it, expect } from 'vitest';
import { componentWeight, effectiveSwell } from '../../src/engine/swell';
import type { SwellHour } from '../../src/types';

const WINDOW: [number, number] = [200, 290];
const hour = (p: [number, number, number], s: [number, number, number]): SwellHour => ({
  time: '2026-09-16T07:00',
  primary: { heightM: p[0], periodS: p[1], directionDeg: p[2] },
  secondary: { heightM: s[0], periodS: s[1], directionDeg: s[2] },
  seaLevelM: 0,
});

describe('componentWeight', () => {
  it('is 1 inside the window, 0.5 within 20° outside, 0 beyond', () => {
    expect(componentWeight(225, WINDOW)).toBe(1);
    expect(componentWeight(300, WINDOW)).toBe(0.5);
    expect(componentWeight(320, WINDOW)).toBe(0);
  });
  it('handles a window that wraps north', () => {
    expect(componentWeight(10, [350, 30])).toBe(1);
  });
});

describe('effectiveSwell', () => {
  it('sums energy of weighted components and keeps the leading component period/direction', () => {
    const s = effectiveSwell(hour([2.0, 13, 225], [0.5, 8, 300]), WINDOW);
    expect(s.heightM).toBeCloseTo(Math.sqrt(4 + 0.0625), 6);
    expect(s.periodS).toBe(13);
    expect(s.directionDeg).toBe(225);
  });
  it('lets a bigger in-window secondary lead', () => {
    const s = effectiveSwell(hour([0.4, 6, 100], [1.5, 12, 240]), WINDOW);
    expect(s.heightM).toBeCloseTo(1.5, 6);
    expect(s.periodS).toBe(12);
  });
  it('is zero when nothing enters', () => {
    expect(effectiveSwell(hour([2.0, 13, 100], [0.5, 8, 120]), WINDOW)).toEqual({ heightM: 0, periodS: 0, directionDeg: 0 });
  });
});

describe('effectiveSwell — peak period (Tp) vs mean period', () => {
  // Tp (peak period) is the period surfers and surf-forecast quote ("SW 13 s"); swell_wave_period (the mean
  // period) is only a fallback when the gwam model doesn't publish Tp for this hour.
  it('uses peakPeriodS when present', () => {
    const h: SwellHour = { ...hour([2.0, 9.3, 225], [0, 0, 0]), peakPeriodS: 13.3 };
    expect(effectiveSwell(h, WINDOW).periodS).toBe(13.3);
  });
  it('falls back to the leading component mean period when peakPeriodS is absent (old behaviour unchanged)', () => {
    const h = hour([2.0, 9.3, 225], [0, 0, 0]);
    expect(effectiveSwell(h, WINDOW).periodS).toBe(9.3);
  });
  it('still uses peakPeriodS when the leading (heaviest-weighted) component is the secondary', () => {
    const h: SwellHour = { ...hour([0.4, 6, 100], [1.5, 12, 240]), peakPeriodS: 13 };
    const s = effectiveSwell(h, WINDOW);
    expect(s.periodS).toBe(13); // not 12, the secondary component's own mean period
  });
});
