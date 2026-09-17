import { SCORING } from '../config';
import type { Spot, SpotHour, SpotResult, SwellHour, WindHour, Window } from '../types';
import { daylightFactor, weatherFactor } from './factors';
import { rateLikeSurfForecast } from './rating';
import { effectiveSwell } from './swell';
import type { TideInfo } from './tide';
import { addHours, dateOf, hoursBetween, toMs } from './time';

export interface EvaluateSpotInput {
  spot: Spot;
  date: string;
  /** swell at the spot's cell (`collect.ts` handles the regional fallback when the cell is empty) */
  swell: SwellHour[];
  wind: WindHour[];
  sun: { sunrise: string; sunset: string };
  tide: TideInfo;
  distanceKm: number;
  /** /now: ignore slots that start before this time. */
  fromTime?: string;
}

export const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Rates each hour like surf-forecast: stars 0..10 on the swell directed at the spot and the wind,
 * nothing else (§ docs/rating.md). Skill level, board, tide, period and gusts don't factor in.
 * Daylight and thunderstorms don't touch the star rating: they only decide whether the hour can count
 * toward a session, via `score`.
 */
export function evaluateSpot(input: EvaluateSpotInput): SpotResult {
  const { spot, date } = input;
  const swellByTime = new Map(input.swell.map((h) => [h.time, h]));
  const fromMs = input.fromTime ? toMs(input.fromTime) : Number.NEGATIVE_INFINITY;
  const hours: SpotHour[] = [];
  const water = { daySum: 0, dayCount: 0, sum: 0, count: 0 };

  for (const w of input.wind) {
    if (dateOf(w.time) !== date || toMs(w.time) < fromMs) continue;
    const s = swellByTime.get(w.time);
    const tide = input.tide.states.get(w.time);
    if (!s || !tide) continue;
    const eff = effectiveSwell(s, spot.swellWindow);
    const rating = rateLikeSurfForecast({
      heightM: eff.heightM, periodS: eff.periodS, windKt: w.windKt, windFromDeg: w.windDirDeg, facingDeg: spot.facing,
    });
    const factors = {
      swell: rating.base / 10,
      wind: rating.windFactor,
      day: daylightFactor(w.time, input.sun.sunrise, input.sun.sunset),
      weather: weatherFactor(w.weatherCode),
    };
    if (s.seaTempC !== undefined) {
      water.sum += s.seaTempC;
      water.count++;
      if (factors.day === 1) {
        water.daySum += s.seaTempC;
        water.dayCount++;
      }
    }
    hours.push({
      time: w.time,
      heightM: eff.heightM, periodS: eff.periodS, swellDirDeg: eff.directionDeg,
      windKt: w.windKt, windDirDeg: w.windDirDeg, windState: rating.state,
      tide, stars: rating.stars, clean: rating.clean, factors,
      score: factors.day * factors.weather === 1 ? rating.stars : 0,
    });
  }

  const windows = findWindows(hours);
  // water temperature from the hours we're surfing; at night only (a /now after sunset), from whatever hours remain
  const waterTempC = water.dayCount > 0 ? Math.round(water.daySum / water.dayCount) : water.count > 0 ? Math.round(water.sum / water.count) : undefined;
  return {
    spotId: spot.id, distanceKm: input.distanceKm, hours, windows,
    best: pickBest(windows),
    maxScore: hours.reduce((m, h) => Math.max(m, h.score), 0),
    ...(waterTempC === undefined ? {} : { waterTempC }),
  };
}

/** Consecutive slots (hours that follow one another) with score ≥ windowMin. */
export function findWindows(hours: SpotHour[]): Window[] {
  const windows: Window[] = [];
  let run: SpotHour[] = [];
  const flush = (): void => {
    if (run.length > 0) windows.push(toWindow(run));
    run = [];
  };
  for (const h of hours) {
    if (h.score < SCORING.windowMin) {
      flush();
      continue;
    }
    const last = run[run.length - 1];
    if (last && addHours(last.time, 1) !== h.time) flush();
    run.push(h);
  }
  flush();
  return windows;
}

function toWindow(run: SpotHour[]): Window {
  const peak = Math.max(...run.map((h) => h.score));
  const mean = round1(run.reduce((sum, h) => sum + h.score, 0) / run.length);
  return { start: run[0].time, end: addHours(run[run.length - 1].time, 1), peak, mean };
}

export function windowHours(w: Window): number {
  return hoursBetween(w.start, w.end);
}

/** Highest peak, then the longest. */
export function pickBest(windows: Window[]): Window | undefined {
  return [...windows].sort((a, b) => b.peak - a.peak || windowHours(b) - windowHours(a))[0];
}
