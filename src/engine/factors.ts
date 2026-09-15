import { SCORING } from '../config';
import type { Board, Level, Spot, TideState, WindRelation } from '../types';
import { angularDistance } from './geo';
import { toMs } from './time';

type Curve = ReadonlyArray<readonly [number, number]>;

/** Linéaire par morceaux : valeur du premier point avant lui, du dernier après lui. */
export function piecewise(curve: Curve, x: number): number {
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const [x0, y0] = curve[i - 1];
    const [x1, y1] = curve[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return last[1];
}

/** Fourchette de taille du niveau, décalée par la planche ; null = spot fermé à ce niveau. */
export function effectiveBand(spot: Spot, level: Level, board: Board): [number, number] | null {
  const band = spot.levels[level];
  if (!band) return null;
  const shift = SCORING.boardShiftFt;
  const [min, max] = band;
  switch (board) {
    case 'longboard':
      return [Math.max(min - shift, 1), max - shift];
    case 'shortboard':
      return [min + shift, max + shift];
    case 'both':
      return [Math.max(min - shift, 1), max + shift];
  }
}

export function sizeFactor(faceFt: number, band: [number, number]): number {
  const [min, max] = band;
  if (faceFt >= min && faceFt <= max) return 1;
  if (faceFt < min) return Math.max(0, 1 - (min - faceFt) / SCORING.sizeBelowFalloffFt);
  return Math.max(0, 1 - (faceFt - max) / SCORING.sizeAboveFalloffFt);
}

export function periodFactor(periodS: number): number {
  const { periodFloorS: lo, periodFullS: hi, periodFloorFactor: floor } = SCORING;
  if (periodS <= lo) return floor;
  if (periodS >= hi) return 1;
  return floor + ((1 - floor) * (periodS - lo)) / (hi - lo);
}

export function windRelation(windFromDeg: number, facingDeg: number): WindRelation {
  const angle = angularDistance(windFromDeg, facingDeg + 180);
  if (angle <= SCORING.wind.offshoreMaxAngle) return 'offshore';
  if (angle <= SCORING.wind.crossMaxAngle) return 'cross';
  return 'onshore';
}

export function windFactor(windKt: number, relation: WindRelation): number {
  return piecewise(SCORING.wind[relation], windKt);
}

export function tideFactor(state: TideState, tide: Spot['tide']): number {
  if (tide.forbidden.includes(state)) return 0;
  if (tide.best.length === 0 || tide.best.includes(state)) return 1;
  return SCORING.tideOffPreferenceFactor;
}

/** 1 si le créneau [slotStart, slotStart + 1 h) contient ≥ 45 min de jour. */
export function daylightFactor(slotStart: string, sunrise: string, sunset: string): number {
  const start = toMs(slotStart);
  const end = start + 3_600_000;
  const overlapMs = Math.min(end, toMs(sunset)) - Math.max(start, toMs(sunrise));
  return overlapMs >= SCORING.daylightMinMinutes * 60_000 ? 1 : 0;
}

export function weatherFactor(code: number): number {
  return SCORING.thunderstormCodes.includes(code) ? 0 : 1;
}
