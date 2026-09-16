import { describe, it, expect } from 'vitest';
import { evaluateSpot, findWindows, pickBest } from '../../src/engine/score';
import { rateLikeSurfForecast } from '../../src/engine/rating';
import { computeTide } from '../../src/engine/tide';
import type { Spot, SpotHour } from '../../src/types';
import { cosineTide, swellSeries, windSeries, NO_SWELL } from '../helpers/fixtures';
import { KOMMETJIE_LONG_BEACH, MUIZENBERG, OUTER_KOM, SUN_SEPT } from '../helpers/spots';

const DATE = '2026-09-16';
const tideFn = cosineTide(DATE);
// 3,5 m : note de base surf-forecast 1,81 + 0,37·3,5 + 0,23·3,5² = 5,92 → 6 étoiles par vent propre,
// c'est-à-dire exactement le seuil `epic`. periodS 10,2 = période moyenne, peakPeriodS 13 = période pic.
const swell = swellSeries('2026-09-15T00:00', '2026-09-17T23:00', (time) => ({
  primary: { heightM: 3.5, periodS: 10.2, directionDeg: 225 }, secondary: NO_SWELL, seaLevelM: tideFn(time),
  peakPeriodS: 13,
}));
const windKtAt = (hour: number): number => (hour <= 9 ? 8 : hour === 10 ? 12 : hour === 11 ? 18 : hour === 12 ? 24 : 30);
const wind = windSeries('2026-09-16T00:00', '2026-09-16T23:00', (time) => ({
  windKt: windKtAt(Number(time.slice(11, 13))), windDirDeg: 120, gustKt: 20,
}));
const tide = computeTide(swell, DATE);
const base = { date: DATE, swell, wind, sun: SUN_SEPT, tide, distanceKm: 13.4 };

describe('evaluateSpot — golden scenario (3.5 m SW, SE wind building from 8 to 30 kt)', () => {
  it('Kommetjie Long Beach: SE is offshore, 6 gold stars until the wind builds, window 07:00→12:00', () => {
    const r = evaluateSpot({ ...base, spot: KOMMETJIE_LONG_BEACH });
    const at = (h: string) => r.hours.find((x) => x.time === `${DATE}T${h}`)!;
    expect(at('07:00').heightM).toBeCloseTo(3.5, 6); // 225° est dans la fenêtre [200, 290] : toute la houle compte
    expect(at('07:00').periodS).toBe(13); // la période pic quand gwam la publie
    expect(at('07:00').windState).toBe('off');
    expect(at('07:00').tide).toEqual({ state: 'high', trend: 'rising' });
    expect(at('07:00').clean).toBe(true);
    // 8 et 12 kt (15 et 22 km/h) : l'offshore ne coûte rien sous 30 km/h
    expect(at('07:00').score).toBe(6);
    expect(at('10:00').score).toBe(6);
    // 18 kt = 33 km/h → ×0,83 → 4,9 → 5 ; 24 kt = 44 km/h → ×0,42 → 2,5 → 2 ; 30 kt = 56 km/h → 0
    expect(at('11:00').score).toBe(5);
    expect(at('12:00').score).toBe(2);
    expect(at('13:00').score).toBe(0);
    // 06:00 n'a que 16 min de jour : la note pure reste 6, mais l'heure ne compte pas pour une session
    expect(at('06:00').stars).toBe(6);
    expect(at('06:00').score).toBe(0);
    // mean of [6, 6, 6, 6, 5] (07:00→11:00) = 29/5 = 5,8
    expect(r.windows).toEqual([{ start: `${DATE}T07:00`, end: `${DATE}T12:00`, peak: 6, mean: 5.8 }]);
    expect(r.best).toEqual(r.windows[0]);
    expect(r.maxScore).toBe(6);
  });

  it('Muizenberg: the same SE is cross-onshore, 2 white stars at 8 kt then nothing', () => {
    const r = evaluateSpot({ ...base, spot: MUIZENBERG, distanceKm: 0 });
    const at = (h: string) => r.hours.find((x) => x.time === `${DATE}T${h}`)!;
    expect(at('07:00').windState).toBe('cross-on');
    expect(at('07:00').clean).toBe(false);
    // 8 kt = 15 km/h cross-onshore → ×0,31 → 1,8 → 2 ; 12 kt = 22 km/h → 0 (tombe à 0 dès 20 km/h)
    expect(at('07:00').score).toBe(2);
    expect(at('10:00').score).toBe(0);
    expect(r.windows).toEqual([]);
    expect(r.best).toBeUndefined();
    expect(r.maxScore).toBe(2);
  });

  it('every star is exactly the surf-forecast reconstruction — no level, board, tide or gust hides in it', () => {
    for (const spot of [KOMMETJIE_LONG_BEACH, MUIZENBERG]) {
      for (const h of evaluateSpot({ ...base, spot }).hours) {
        const expected = rateLikeSurfForecast({ heightM: h.heightM, periodS: h.periodS, windKt: h.windKt, windFromDeg: h.windDirDeg, facingDeg: spot.facing });
        expect(h.stars, `${spot.id} ${h.time}`).toBe(expected.stars);
        expect(h.clean).toBe(expected.clean);
      }
    }
  });

  it('a spot once reserved for advanced surfers is rated like any other: level no longer exists here', () => {
    const r = evaluateSpot({ ...base, spot: OUTER_KOM });
    expect(r.hours.find((h) => h.time === `${DATE}T07:00`)!.score).toBe(6);
    expect(r.windows).toHaveLength(1);
  });

  it('a swell outside the spot window does not reach it: 0 stars', () => {
    const shadowed: Spot = { ...KOMMETJIE_LONG_BEACH, swellWindow: [300, 340] };
    const r = evaluateSpot({ ...base, spot: shadowed });
    expect(r.hours.every((h) => h.heightM === 0 && h.stars === 0)).toBe(true);
  });

  it('a thunderstorm hour keeps its stars but cannot count for a session', () => {
    const stormy = wind.map((w) => (w.time === `${DATE}T08:00` ? { ...w, weatherCode: 95 } : w));
    const h = evaluateSpot({ ...base, wind: stormy, spot: KOMMETJIE_LONG_BEACH }).hours.find((x) => x.time === `${DATE}T08:00`)!;
    expect(h.stars).toBe(6);
    expect(h.score).toBe(0);
  });

  it('fromTime drops earlier slots (/now)', () => {
    const r = evaluateSpot({ ...base, spot: KOMMETJIE_LONG_BEACH, fromTime: `${DATE}T08:00` });
    expect(r.hours[0].time).toBe(`${DATE}T08:00`);
    // mean of [6, 6, 6, 5] (08:00→11:00) = 23/4 = 5,75 → round1 → 5,8
    expect(r.best).toEqual({ start: `${DATE}T08:00`, end: `${DATE}T12:00`, peak: 6, mean: 5.8 });
  });

  it('ignores hours of another day', () => {
    const r = evaluateSpot({ ...base, spot: KOMMETJIE_LONG_BEACH, date: '2026-09-17' });
    expect(r.hours).toEqual([]);
    expect(r.maxScore).toBe(0);
  });
});

describe('findWindows', () => {
  const h = (time: string, score: number): SpotHour => ({
    time, heightM: 2, periodS: 12, swellDirDeg: 225, windKt: 5, windDirDeg: 120, windState: 'off',
    tide: { state: 'mid', trend: 'rising' }, stars: score, clean: true,
    factors: { swell: 0.4, wind: 1, day: 1, weather: 1 }, score,
  });
  it('groups consecutive slots ≥ 3 stars and splits on gaps or low scores', () => {
    const hours = [h(`${DATE}T07:00`, 4), h(`${DATE}T08:00`, 3), h(`${DATE}T09:00`, 2), h(`${DATE}T10:00`, 5), h(`${DATE}T12:00`, 5)];
    expect(findWindows(hours)).toEqual([
      { start: `${DATE}T07:00`, end: `${DATE}T09:00`, peak: 4, mean: 3.5 },
      { start: `${DATE}T10:00`, end: `${DATE}T11:00`, peak: 5, mean: 5 },
      { start: `${DATE}T12:00`, end: `${DATE}T13:00`, peak: 5, mean: 5 },
    ]);
  });
  it('pickBest prefers the highest peak, then the longest', () => {
    const w = [
      { start: `${DATE}T07:00`, end: `${DATE}T09:00`, peak: 4, mean: 4 },
      { start: `${DATE}T12:00`, end: `${DATE}T16:00`, peak: 4, mean: 3.5 },
      { start: `${DATE}T16:00`, end: `${DATE}T17:00`, peak: 5, mean: 5 },
    ];
    expect(pickBest(w)?.start).toBe(`${DATE}T16:00`);
    expect(pickBest(w.slice(0, 2))?.start).toBe(`${DATE}T12:00`);
    expect(pickBest([])).toBeUndefined();
  });
});
