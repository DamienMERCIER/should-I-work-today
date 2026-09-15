import { SCORING } from '../config';
import type { Board, Level, Spot, SpotHour, SpotResult, SwellHour, WindHour, Window } from '../types';
import {
  daylightFactor, effectiveBand, periodFactor, sizeFactor, tideFactor, weatherFactor, windFactor, windRelation,
} from './factors';
import { effectiveSwell, faceHeightFt } from './swell';
import type { TideInfo } from './tide';
import { addHours, dateOf, hoursBetween, toMs } from './time';

export interface EvaluateSpotInput {
  spot: Spot;
  level: Level;
  board: Board;
  date: string;
  swell: SwellHour[];
  wind: WindHour[];
  sun: { sunrise: string; sunset: string };
  tide: TideInfo;
  distanceKm: number;
  /** /now : ignorer les créneaux qui commencent avant cette heure. */
  fromTime?: string;
}

export const round1 = (x: number): number => Math.round(x * 10) / 10;

export function evaluateSpot(input: EvaluateSpotInput): SpotResult {
  const { spot, date } = input;
  const band = effectiveBand(spot, input.level, input.board);
  const open = band !== null;
  const swellByTime = new Map(input.swell.map((h) => [h.time, h]));
  const fromMs = input.fromTime ? toMs(input.fromTime) : Number.NEGATIVE_INFINITY;
  const hours: SpotHour[] = [];

  for (const w of input.wind) {
    if (dateOf(w.time) !== date || toMs(w.time) < fromMs) continue;
    const s = swellByTime.get(w.time);
    const tide = input.tide.states.get(w.time);
    if (!s || !tide) continue;
    const eff = effectiveSwell(s, spot.swellWindow);
    const faceFt = faceHeightFt(eff, spot.exposure);
    const relation = windRelation(w.windDirDeg, spot.facing);
    const factors = {
      size: band ? sizeFactor(faceFt, band) : 0,
      period: periodFactor(eff.periodS),
      wind: windFactor(w.windKt, relation),
      tide: tideFactor(tide.state, spot.tide),
      day: daylightFactor(w.time, input.sun.sunrise, input.sun.sunset),
      weather: weatherFactor(w.weatherCode),
    };
    const product = factors.size * factors.period * factors.wind * factors.tide * factors.day * factors.weather;
    hours.push({
      time: w.time,
      faceFt, periodS: eff.periodS, swellDirDeg: eff.directionDeg,
      windKt: w.windKt, windDirDeg: w.windDirDeg, gustKt: w.gustKt, windRelation: relation,
      tide, factors,
      score: open ? round1(10 * product) : 0,
    });
  }

  const windows = open ? findWindows(hours) : [];
  return {
    spotId: spot.id, distanceKm: input.distanceKm, open, hours, windows,
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
