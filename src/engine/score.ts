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
  /** houle à la cellule du spot (`collect.ts` s'occupe du repli régional quand la cellule est vide) */
  swell: SwellHour[];
  wind: WindHour[];
  sun: { sunrise: string; sunset: string };
  tide: TideInfo;
  distanceKm: number;
  /** /now : ignorer les créneaux qui commencent avant cette heure. */
  fromTime?: string;
}

export const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Note chaque heure comme surf-forecast : étoiles 0..10 sur la houle dirigée vers le spot et le vent,
 * rien d'autre (§ RAPPORT-surf-forecast.md). Niveau, planche, marée, période et rafale n'y entrent pas.
 * La lumière et l'orage ne touchent pas les étoiles : ils décident seulement si l'heure peut compter
 * pour une session, via `score`.
 */
export function evaluateSpot(input: EvaluateSpotInput): SpotResult {
  const { spot, date } = input;
  const swellByTime = new Map(input.swell.map((h) => [h.time, h]));
  const fromMs = input.fromTime ? toMs(input.fromTime) : Number.NEGATIVE_INFINITY;
  const hours: SpotHour[] = [];

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
    hours.push({
      time: w.time,
      heightM: eff.heightM, periodS: eff.periodS, swellDirDeg: eff.directionDeg,
      windKt: w.windKt, windDirDeg: w.windDirDeg, windState: rating.state,
      tide, stars: rating.stars, clean: rating.clean, factors,
      score: factors.day * factors.weather === 1 ? rating.stars : 0,
    });
  }

  const windows = findWindows(hours);
  return {
    spotId: spot.id, distanceKm: input.distanceKm, hours, windows,
    best: pickBest(windows),
    maxScore: hours.reduce((m, h) => Math.max(m, h.score), 0),
  };
}

/** Créneaux consécutifs (heures qui se suivent) à score ≥ windowMin. */
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

/** Pic le plus haut, puis la plus longue. */
export function pickBest(windows: Window[]): Window | undefined {
  return [...windows].sort((a, b) => b.peak - a.peak || windowHours(b) - windowHours(a))[0];
}
