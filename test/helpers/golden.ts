import { evaluateSpot } from '../../src/engine/score';
import { computeTide } from '../../src/engine/tide';
import { decideVerdict } from '../../src/engine/verdict';
import type { DailySun, Report, Spot, SwellHour, WindHour } from '../../src/types';
import { cosineTide, swellSeries, windSeries, NO_SWELL } from './fixtures';
import { KOMMETJIE_LONG_BEACH, MUIZENBERG, SUN_SEPT } from './spots';

export const GOLDEN_DATE = '2026-09-16';
export const GOLDEN_SPOTS: Spot[] = [KOMMETJIE_LONG_BEACH, MUIZENBERG];

export function goldenSwell(): SwellHour[] {
  const tide = cosineTide(GOLDEN_DATE);
  return swellSeries('2026-09-15T00:00', '2026-09-17T23:00', (time) => ({
    primary: { heightM: 2.0, periodS: 10.2, directionDeg: 225 }, secondary: NO_SWELL, seaLevelM: tide(time),
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

/** 🟢 Kommetjie Long Beach 07:00→12:00 pic 8.6 ; Muizenberg sans fenêtre (max 3.3). */
export function goldenReport(overrides: Partial<Report> = {}): Report {
  const swell = goldenSwell();
  const wind = goldenWind();
  const tide = computeTide(swell, GOLDEN_DATE);
  const common = { level: 'intermediate' as const, board: 'shortboard' as const, date: GOLDEN_DATE, swell, wind, sun: SUN_SEPT, tide };
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
