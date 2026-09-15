import { describe, it, expect } from 'vitest';
import { componentWeight, effectiveSwell, periodShoaling, faceHeightFt } from '../../src/engine/swell';
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

describe('periodShoaling k(T)', () => {
  it('follows clamp(1 + 0.05·(T−8), 0.9, 1.3)', () => {
    expect(periodShoaling(6)).toBeCloseTo(0.9, 6);
    expect(periodShoaling(8)).toBeCloseTo(1.0, 6);
    expect(periodShoaling(11)).toBeCloseTo(1.15, 6);
    expect(periodShoaling(14)).toBeCloseTo(1.3, 6);
    expect(periodShoaling(20)).toBeCloseTo(1.3, 6);
  });
});

describe('faceHeightFt', () => {
  it('= H × 3.28 × exposure × k(T)', () => {
    expect(faceHeightFt({ heightM: 2.0, periodS: 10.2, directionDeg: 225 }, 0.6)).toBeCloseTo(4.369, 3);
  });
  it('is 0 for no swell', () => {
    expect(faceHeightFt({ heightM: 0, periodS: 0, directionDeg: 0 }, 1)).toBe(0);
  });
});
