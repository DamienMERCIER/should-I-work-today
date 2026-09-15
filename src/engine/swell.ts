import { M_TO_FT, SCORING } from '../config';
import type { SwellHour } from '../types';
import { distanceOutsideArc } from './geo';

export interface EffectiveSwell { heightM: number; periodS: number; directionDeg: number }

/** 1 dans la fenêtre, 0.5 à ≤ 20° hors fenêtre, 0 au-delà (§7.1). */
export function componentWeight(directionDeg: number, window: [number, number]): number {
  const outside = distanceOutsideArc(directionDeg, window[0], window[1]);
  if (outside === 0) return 1;
  if (outside <= SCORING.swellWindowToleranceDeg) return SCORING.swellOutOfWindowWeight;
  return 0;
}

export function effectiveSwell(hour: SwellHour, window: [number, number]): EffectiveSwell {
  const parts = [hour.primary, hour.secondary]
    .map((c) => ({ c, weighted: c.heightM * componentWeight(c.directionDeg, window) }))
    .filter((p) => p.weighted > 0);
  if (parts.length === 0) return { heightM: 0, periodS: 0, directionDeg: 0 };
  const heightM = Math.sqrt(parts.reduce((sum, p) => sum + p.weighted * p.weighted, 0));
  const lead = parts.reduce((a, b) => (b.weighted > a.weighted ? b : a));
  return { heightM, periodS: lead.c.periodS, directionDeg: lead.c.directionDeg };
}

/** k(T) = clamp(1 + 0.05·(T − 8), 0.9, 1.3) (§7.2). */
export function periodShoaling(periodS: number): number {
  const { perSecond, refS, min, max } = SCORING.kPeriod;
  return Math.min(max, Math.max(min, 1 + perSecond * (periodS - refS)));
}

export function faceHeightFt(swell: EffectiveSwell, exposure: number): number {
  if (swell.heightM <= 0) return 0;
  return swell.heightM * M_TO_FT * exposure * periodShoaling(swell.periodS);
}
