import { evaluateSpot } from '../../src/engine/score';
import { computeTide } from '../../src/engine/tide';
import { decideVerdict } from '../../src/engine/verdict';
import type { DailySun, Report, Spot, SwellHour, WindHour } from '../../src/types';
import { addDays } from '../../src/engine/time';
import { cosineTide, swellSeries, windSeries, NO_SWELL } from './fixtures';
import { KOMMETJIE_LONG_BEACH, MUIZENBERG, SUN_SEPT } from './spots';

export const GOLDEN_DATE = '2026-09-16';
export const GOLDEN_SPOTS: Spot[] = [KOMMETJIE_LONG_BEACH, MUIZENBERG];

export function goldenSwell(): SwellHour[] {
  const tide = cosineTide(GOLDEN_DATE);
  // 3,5 m: surf-forecast base rating 5,92 → 6★ in clean wind, exactly the `epic` threshold.
  // periodS 10.2 = mean period (swell_wave_period); peakPeriodS 13 = peak period (separate gwam call).
  return swellSeries('2026-09-15T00:00', '2026-09-17T23:00', (time) => ({
    primary: { heightM: 3.5, periodS: 10.2, directionDeg: 225 }, secondary: NO_SWELL, seaLevelM: tide(time),
    peakPeriodS: 13,
  }));
}

export const goldenWindKt = (hour: number): number => (hour <= 9 ? 8 : hour === 10 ? 12 : hour === 11 ? 18 : hour === 12 ? 24 : 30);

export const GOLDEN_DAILY: DailySun[] = [
  { date: '2026-09-15', sunrise: '2026-09-15T06:45', sunset: '2026-09-15T18:37', tempMaxC: 16, tempMinC: 13, precipMm: 4.6 },
  { date: '2026-09-16', sunrise: '2026-09-16T06:44', sunset: '2026-09-16T18:38', tempMaxC: 22, tempMinC: 14, precipMm: 0 },
  { date: '2026-09-17', sunrise: '2026-09-17T06:43', sunset: '2026-09-17T18:39', tempMaxC: 20, tempMinC: 13, precipMm: 0 },
];

export function goldenWind(date = GOLDEN_DATE): WindHour[] {
  return windSeries(`${date}T00:00`, `${date}T23:00`, (time) => ({
    windKt: goldenWindKt(Number(time.slice(11, 13))), windDirDeg: 120, gustKt: 20,
  }));
}

/**
 * 🟢 epic: Kommetjie Long Beach 07:00→12:00, 6★ gold (the SE is offshore there); Muizenberg at 2☆ white
 * from 07:00 to 09:00 (the same SE is cross-onshore there), no window, so no 🥈.
 */
export function goldenReport(overrides: Partial<Report> = {}): Report {
  const swell = goldenSwell();
  const wind = goldenWind();
  const tide = computeTide(swell, GOLDEN_DATE);
  const common = { date: GOLDEN_DATE, swell, wind, sun: SUN_SEPT, tide };
  const spots = [
    evaluateSpot({ ...common, spot: KOMMETJIE_LONG_BEACH, distanceKm: 13.4 }),
    evaluateSpot({ ...common, spot: MUIZENBERG, distanceKm: 0 }),
  ];
  const verdict = decideVerdict(spots, { date: GOLDEN_DATE, workHours: { start: '09:00', end: '18:00' }, mode: 'day' });
  return {
    chatId: 1, date: GOLDEN_DATE, mode: 'evening', generatedAt: '2026-09-15T19:00',
    location: { lat: -34.1085, lon: 18.4715, source: 'default' }, radiusKm: 20,
    verdict, spots, tides: tide.events,
    weather: { tempMaxC: 22, tempMinC: 14, precipMm: 0, code: 1 },
    sun: SUN_SEPT,
    ...overrides,
  };
}

/**
 * Several days of data for the week view: 225° swell with one height per day (`heightByDay(i)`,
 * i = 0 being `start`'s day), a steady SE wind at 8 kt — clean offshore at Kommetjie, cross-onshore at
 * Muizenberg. A day's verdict therefore only depends on its height: 3,5 m → 6★, 2,3 m → 4★,
 * 1,2 m → 3★, 0,2 m → 0★ at Kommetjie. Covers the day before `start` (tide J−3 h) and `days` days.
 */
export function weekData(start = GOLDEN_DATE, days = 9, heightByDay: (i: number) => number = () => 3.5): { swell: SwellHour[]; wind: WindHour[]; daily: DailySun[] } {
  const from = `${addDays(start, -1)}T00:00`;
  const to = `${addDays(start, days - 1)}T23:00`;
  const tide = cosineTide(start);
  const dayIndex = (time: string): number => Math.round(daysBetween(start, time.slice(0, 10)));
  const swell = swellSeries(from, to, (time) => ({
    primary: { heightM: heightByDay(Math.max(0, dayIndex(time))), periodS: 10.2, directionDeg: 225 },
    secondary: NO_SWELL, seaLevelM: tide(time), peakPeriodS: 13,
  }));
  const wind = windSeries(from, to, () => ({ windKt: 8, windDirDeg: 120, gustKt: 12 }));
  const daily: DailySun[] = Array.from({ length: days + 1 }, (_, i) => {
    const date = addDays(start, i - 1);
    return { date, sunrise: `${date}T06:44`, sunset: `${date}T18:38`, tempMaxC: 20, tempMinC: 13, precipMm: 0 };
  });
  return { swell, wind, daily };
}

const daysBetween = (a: string, b: string): number => (Date.parse(`${b}T00:00Z`) - Date.parse(`${a}T00:00Z`)) / 86_400_000;
