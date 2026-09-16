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
  peakPeriodS: 13,
}));
const windKtAt = (hour: number): number => (hour <= 9 ? 8 : hour === 10 ? 12 : hour === 11 ? 18 : hour === 12 ? 24 : 30);
const wind = windSeries('2026-09-16T00:00', '2026-09-16T23:00', (time) => ({
  windKt: windKtAt(Number(time.slice(11, 13))), windDirDeg: 120, gustKt: 20,
}));
const tide = computeTide(swell, DATE);
const base = { level: 'intermediate' as const, board: 'shortboard' as const, date: DATE, swell, wind, sun: SUN_SEPT, tide, distanceKm: 13.4 };

/**
 * Le 17 septembre 2026 a Kommetjie, le bot annoncait 9,8/10 « ca envoie » sur une journee que
 * surf-forecast notait 0/10, sur exactement la meme houle (2,2 m 12 s SW). Toute la difference etait
 * dans le vent : un SE de 16 kt en rafales a 31 kt, que l'ancien modele comptait comme un offshore
 * parfait (courbe pleine jusqu'a 15 kt, rafales jamais lues).
 */
describe('evaluateSpot — a gale that happens to blow offshore (defect: Kommetjie, 17 Sept 2026)', () => {
  const gale = (windKt: number, gustKt: number) =>
    evaluateSpot({
      ...base,
      spot: KOMMETJIE_LONG_BEACH,
      wind: windSeries(`${DATE}T00:00`, `${DATE}T23:00`, () => ({ windKt, windDirDeg: 135, gustKt })),
    });
  const at8 = (windKt: number, gustKt: number) => gale(windKt, gustKt).hours.find((h) => h.time === `${DATE}T08:00`)!;

  it('a light offshore still scores a perfect 10 — the fix must not flatten good days', () => {
    expect(at8(8, 14).score).toBeCloseTo(10.0, 1);
  });

  it('16 kt offshore gusting 31 cannot reach the epic threshold, let alone 9.8', () => {
    const h = at8(16, 31);
    expect(h.windRelation).toBe('offshore'); // le SE reste bien offshore ici : c'est sa force, pas sa direction
    expect(h.score).toBeLessThan(6);
    expect(h.score).toBeGreaterThan(3); // et pas un zero non plus : la houle, elle, est bonne
  });

  it('the same sustained wind without the gust scores clearly higher — the gust is what costs', () => {
    expect(at8(16, 18).score).toBeGreaterThan(at8(16, 31).score);
  });

  it('a 22 kt offshore gusting 43 is unsurfable, and no window survives it', () => {
    const r = gale(22, 43);
    expect(r.maxScore).toBeLessThan(1.5);
    expect(r.windows).toEqual([]);
  });
});

describe('evaluateSpot — golden scenario', () => {
  // Tp (peakPeriodS) = 13 s here (mean periodS stays 10.2, only used as fallback — see engine/swell.ts):
  // k(13) = clamp(1 + 0.05·(13−8), 0.9, 1.3) = 1.25 ; periodFactor(13) = 1.0 (≥ periodFullS 11, was 0.86 at 10.2).
  it('Kommetjie Long Beach: offshore SE, 4.9 ft, window 07:00→11:00 peak 10.0 (epic)', () => {
    const r = evaluateSpot({ ...base, spot: KOMMETJIE_LONG_BEACH });
    const at = (h: string) => r.hours.find((x) => x.time === `${DATE}T${h}`)!;
    expect(r.open).toBe(true);
    // faceFt = 2.0 heightM × 3.28 M_TO_FT × 0.6 exposure × 1.25 k(13) = 4.92
    expect(at('07:00').faceFt).toBeCloseTo(4.92, 3);
    expect(at('07:00').windRelation).toBe('offshore');
    expect(at('07:00').tide).toEqual({ state: 'high', trend: 'rising' });
    expect(at('06:00').score).toBe(0); // 16 min de jour seulement
    // size(1) × period(1.0) × wind(1) × tide(1) × day(1) × weather(1) = 1.0 → 10×1.0 = 10.0
    expect(at('07:00').score).toBeCloseTo(10.0, 1);
    // 10:00 wind 12 kt offshore → windFactor 0.90 (l'offshore n'est plein que jusqu'à 10 kt) → 9.0
    expect(at('10:00').score).toBeCloseTo(9.0, 1);
    // 11:00 wind 18 kt offshore → windFactor 0.57 ; 1.0 × 0.57 = 0.57 → 5.7
    expect(at('11:00').score).toBeCloseTo(5.7, 1);
    // 12:00 wind 24 kt offshore → windFactor 0.21 ; 1.0 × 0.21 = 0.21 → 2.1
    expect(at('12:00').score).toBeCloseTo(2.1, 1);
    // 13:00 wind 30 kt offshore → windFactor 0 : au-delà de 30 kt l'offshore ne se surfe plus
    expect(at('13:00').score).toBe(0);
    expect(r.windows).toHaveLength(1);
    // 11:00 tombe sous windowMin (6), donc la fenêtre se ferme à 11:00 et non plus à 12:00
    // mean of [10.0, 10.0, 10.0, 9.0] (07:00→10:00) = 39/4 = 9.75 → round1 → 9.8
    expect(r.best).toEqual({ start: `${DATE}T07:00`, end: `${DATE}T11:00`, peak: 10.0, mean: 9.8 });
    expect(r.maxScore).toBeCloseTo(10.0, 1);
  });

  it('Muizenberg: onshore SE, still too small for a shortboard but now clears windowMin at 07:00→10:00', () => {
    const r = evaluateSpot({ ...base, spot: MUIZENBERG, distanceKm: 0 });
    const at7 = r.hours.find((x) => x.time === `${DATE}T07:00`)!;
    expect(at7.windRelation).toBe('onshore');
    // faceFt = 2.0 × 3.28 × 0.35 exposure × 1.25 k(13) = 2.87 (band [3,6] : still just under min)
    expect(at7.faceFt).toBeCloseTo(2.87, 3);
    // sizeFactor = 1 − (3 − 2.87)/1 = 0.87 (was 0.549 at the old faceFt 2.549)
    expect(at7.factors.size).toBeCloseTo(0.87, 3);
    // size(0.87) × period(1.0) × wind(0.7 onshore@8kt) × tide(1, best=[]) × day(1) × weather(1) = 0.609 → 6.1
    // 6.1 ≥ windowMin (6): unlike the old 3.3, this now forms a (sub-`good`, so verdict-irrelevant) window.
    expect(at7.score).toBeCloseTo(6.1, 1);
    expect(r.windows).toEqual([{ start: `${DATE}T07:00`, end: `${DATE}T10:00`, peak: 6.1, mean: 6.1 }]);
    expect(r.best).toEqual({ start: `${DATE}T07:00`, end: `${DATE}T10:00`, peak: 6.1, mean: 6.1 });
    expect(r.maxScore).toBeCloseTo(6.1, 1);
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
    // mean of [10.0, 10.0, 9.0] (08:00→10:00) = 29/3 = 9.67 → round1 → 9.7
    expect(r.best).toEqual({ start: `${DATE}T08:00`, end: `${DATE}T11:00`, peak: 10.0, mean: 9.7 });
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
