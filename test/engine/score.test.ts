import { describe, it, expect } from 'vitest';
import { evaluateSpot, findWindows, pickBest } from '../../src/engine/score';
import { computeTide } from '../../src/engine/tide';
import type { SpotHour } from '../../src/types';
import { cosineTide, swellSeries, windSeries, NO_SWELL } from '../helpers/fixtures';
import { KOMMETJIE_LONG_BEACH, MUIZENBERG, OUTER_KOM, SUN_SEPT } from '../helpers/spots';

const DATE = '2026-09-16';
const tideFn = cosineTide(DATE);
const swell = swellSeries('2026-09-15T00:00', '2026-09-17T23:00', (time) => ({
  primary: { heightM: 2.0, periodS: 10.2, directionDeg: 225 }, secondary: NO_SWELL, seaLevelM: tideFn(time),
}));
const windKtAt = (hour: number): number => (hour <= 9 ? 8 : hour === 10 ? 12 : hour === 11 ? 18 : hour === 12 ? 24 : 30);
const wind = windSeries('2026-09-16T00:00', '2026-09-16T23:00', (time) => ({
  windKt: windKtAt(Number(time.slice(11, 13))), windDirDeg: 120, gustKt: 20,
}));
const tide = computeTide(swell, DATE);
const base = { level: 'intermediate' as const, board: 'shortboard' as const, date: DATE, swell, wind, sun: SUN_SEPT, tide, distanceKm: 13.4 };

describe('evaluateSpot — golden scenario', () => {
  it('Kommetjie Long Beach: offshore SE, 4.4 ft, window 07:00→12:00 peak 8.6', () => {
    const r = evaluateSpot({ ...base, spot: KOMMETJIE_LONG_BEACH });
    const at = (h: string) => r.hours.find((x) => x.time === `${DATE}T${h}`)!;
    expect(r.open).toBe(true);
    expect(at('07:00').faceFt).toBeCloseTo(4.369, 3);
    expect(at('07:00').windRelation).toBe('offshore');
    expect(at('07:00').tide).toEqual({ state: 'high', trend: 'rising' });
    expect(at('06:00').score).toBe(0); // 16 min de jour seulement
    expect(at('07:00').score).toBeCloseTo(8.6, 1);
    expect(at('10:00').score).toBeCloseTo(8.6, 1);
    expect(at('11:00').score).toBeCloseTo(7.1, 1);
    expect(at('12:00').score).toBeCloseTo(4.0, 1);
    expect(at('13:00').score).toBeCloseTo(1.0, 1);
    expect(r.windows).toHaveLength(1);
    expect(r.best).toEqual({ start: `${DATE}T07:00`, end: `${DATE}T12:00`, peak: 8.6, mean: 8.3 });
    expect(r.maxScore).toBeCloseTo(8.6, 1);
  });

  it('Muizenberg: onshore SE and too small for a shortboard → no window, max 3.3', () => {
    const r = evaluateSpot({ ...base, spot: MUIZENBERG, distanceKm: 0 });
    const at7 = r.hours.find((x) => x.time === `${DATE}T07:00`)!;
    expect(at7.windRelation).toBe('onshore');
    expect(at7.faceFt).toBeCloseTo(2.549, 3);
    expect(at7.factors.size).toBeCloseTo(0.549, 3);
    expect(at7.score).toBeCloseTo(3.3, 1);
    expect(r.windows).toEqual([]);
    expect(r.best).toBeUndefined();
    expect(r.maxScore).toBeCloseTo(3.3, 1);
  });

  it('a spot closed to the level scores 0 everywhere and is flagged closed', () => {
    const r = evaluateSpot({ ...base, spot: OUTER_KOM });
    expect(r.open).toBe(false);
    expect(r.maxScore).toBe(0);
    expect(r.windows).toEqual([]);
    expect(r.hours.every((h) => h.score === 0)).toBe(true);
  });

  it('fromTime drops earlier slots (/now)', () => {
    const r = evaluateSpot({ ...base, spot: KOMMETJIE_LONG_BEACH, fromTime: `${DATE}T08:00` });
    expect(r.hours[0].time).toBe(`${DATE}T08:00`);
    expect(r.best).toEqual({ start: `${DATE}T08:00`, end: `${DATE}T12:00`, peak: 8.6, mean: 8.2 });
  });

  it('ignores hours of another day', () => {
    const r = evaluateSpot({ ...base, spot: KOMMETJIE_LONG_BEACH, date: '2026-09-17' });
    expect(r.hours).toEqual([]);
    expect(r.maxScore).toBe(0);
  });
});

describe('findWindows', () => {
  const h = (time: string, score: number): SpotHour => ({
    time, faceFt: 4, periodS: 12, swellDirDeg: 225, windKt: 5, windDirDeg: 120, gustKt: 5, windRelation: 'offshore',
    tide: { state: 'mid', trend: 'rising' }, factors: { size: 1, period: 1, wind: 1, tide: 1, day: 1, weather: 1 }, score,
  });
  it('groups consecutive slots ≥ 6 and splits on gaps or low scores', () => {
    const hours = [h(`${DATE}T07:00`, 7), h(`${DATE}T08:00`, 6), h(`${DATE}T09:00`, 5.9), h(`${DATE}T10:00`, 8), h(`${DATE}T12:00`, 8)];
    expect(findWindows(hours)).toEqual([
      { start: `${DATE}T07:00`, end: `${DATE}T09:00`, peak: 7, mean: 6.5 },
      { start: `${DATE}T10:00`, end: `${DATE}T11:00`, peak: 8, mean: 8 },
      { start: `${DATE}T12:00`, end: `${DATE}T13:00`, peak: 8, mean: 8 },
    ]);
  });
  it('pickBest prefers the highest peak, then the longest', () => {
    const w = [
      { start: `${DATE}T07:00`, end: `${DATE}T09:00`, peak: 8, mean: 8 },
      { start: `${DATE}T12:00`, end: `${DATE}T16:00`, peak: 8, mean: 7 },
      { start: `${DATE}T16:00`, end: `${DATE}T17:00`, peak: 9, mean: 9 },
    ];
    expect(pickBest(w)?.start).toBe(`${DATE}T16:00`);
    expect(pickBest(w.slice(0, 2))?.start).toBe(`${DATE}T12:00`);
    expect(pickBest([])).toBeUndefined();
  });
});
