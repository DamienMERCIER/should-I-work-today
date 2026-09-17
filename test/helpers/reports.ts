import type { HourFactors, Report, SpotHour, SpotResult } from '../../src/types';

export const DATE = '2026-09-16';

export function makeHour(time: string, score: number, factors: Partial<HourFactors> = {}): SpotHour {
  return {
    time, heightM: 2, periodS: 12, swellDirDeg: 225, windKt: 8, windDirDeg: 120, windState: 'off',
    tide: { state: 'mid', trend: 'rising' },
    stars: score, clean: true,
    factors: { swell: 0.4, wind: 1, day: 1, weather: 1, ...factors },
    score,
  };
}

/** A spot and its day scored hour by hour from 6h, with no window: enough to break ties between spots level on stars. */
export function makeSpotDay(spotId: string, distanceKm: number, scores: number[], date = DATE): SpotResult {
  const hours = scores.map((score, i) => makeHour(`${date}T${String(6 + i).padStart(2, '0')}:00`, score));
  return { spotId, distanceKm, hours, windows: [], best: undefined, maxScore: Math.max(...scores) };
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
