import { describe, it, expect } from 'vitest';
import { computeTide, tideWindow } from '../../src/engine/tide';
import { cosineTide, swellSeries, NO_SWELL } from '../helpers/fixtures';

const DATE = '2026-09-16';
const tide = cosineTide(DATE);
const series = swellSeries('2026-09-15T00:00', '2026-09-17T23:00', (time) => ({
  primary: NO_SWELL, secondary: NO_SWELL, seaLevelM: tide(time),
}));

describe('tideWindow', () => {
  it('spans J−3h .. J+24h+3h', () => {
    expect(tideWindow(DATE)).toEqual({ from: '2026-09-15T21:00', to: '2026-09-17T03:00' });
  });
});

describe('computeTide', () => {
  const info = computeTide(series, DATE);

  it('finds the four extrema of the day with exact times on a symmetric series', () => {
    expect(info.events).toEqual([
      { time: '2026-09-16T03:00', kind: 'low', heightM: -0.5 },
      { time: '2026-09-16T09:00', kind: 'high', heightM: 0.5 },
      { time: '2026-09-16T15:00', kind: 'low', heightM: -0.5 },
      { time: '2026-09-16T21:00', kind: 'high', heightM: 0.5 },
    ]);
  });

  it('classifies states by thirds of the day range and gives the trend', () => {
    expect(info.states.get('2026-09-16T06:00')).toEqual({ state: 'mid', trend: 'rising' });
    expect(info.states.get('2026-09-16T07:00')).toEqual({ state: 'high', trend: 'rising' });
    expect(info.states.get('2026-09-16T09:00')).toEqual({ state: 'high', trend: 'falling' });
    expect(info.states.get('2026-09-16T12:00')).toEqual({ state: 'mid', trend: 'falling' });
    expect(info.states.get('2026-09-16T15:00')).toEqual({ state: 'low', trend: 'rising' });
    expect(info.states.get('2026-09-16T18:00')).toEqual({ state: 'mid', trend: 'rising' });
  });

  it('refines an asymmetric extremum by parabolic interpolation (0.3 h → +18 min)', () => {
    const pts = [0.3, 0.5, 0.45];
    const s = swellSeries('2026-09-16T08:00', '2026-09-16T10:00', (_t, i) => ({
      primary: NO_SWELL, secondary: NO_SWELL, seaLevelM: pts[i],
    }));
    const { events } = computeTide(s, DATE);
    expect(events).toHaveLength(1);
    expect(events[0].time).toBe('2026-09-16T09:18');
    expect(events[0].kind).toBe('high');
    expect(events[0].heightM).toBeCloseTo(0.51, 2);
  });

  it('is empty on a series that is too short', () => {
    expect(computeTide([], DATE)).toEqual({ states: new Map(), events: [] });
  });
});
