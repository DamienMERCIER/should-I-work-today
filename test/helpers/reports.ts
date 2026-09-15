import type { HourFactors, Report, SpotHour } from '../../src/types';

export const DATE = '2026-09-16';

export function makeHour(time: string, score: number, factors: Partial<HourFactors> = {}): SpotHour {
  return {
    time, faceFt: 4, periodS: 12, swellDirDeg: 225, windKt: 8, windDirDeg: 120, gustKt: 12, windRelation: 'offshore',
    tide: { state: 'mid', trend: 'rising' },
    factors: { size: 1, period: 1, wind: 1, tide: 1, day: 1, weather: 1, ...factors },
    score,
  };
}

export function makeReport(overrides: Partial<Report>): Report {
  return {
    chatId: 1, date: DATE, mode: 'evening', generatedAt: `${DATE}T19:00`,
    location: { lat: -34.1085, lon: 18.4715, source: 'default' }, radiusKm: 20,
    verdict: { kind: 'red' }, spots: [], tides: [],
    weather: { tempMaxC: 22, tempMinC: 14, precipMm: 0, code: 1 },
    sun: { sunrise: `${DATE}T06:44`, sunset: `${DATE}T18:38` },
    ...overrides,
  };
}
