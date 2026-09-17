import { SCORING } from '../config';
import type { SwellHour } from '../types';
import { distanceOutsideArc } from './geo';

export interface EffectiveSwell { heightM: number; periodS: number; directionDeg: number }

/** 1 inside the window, 0.5 at ≤ 20° outside the window, 0 beyond that (§7.1). */
export function componentWeight(directionDeg: number, window: [number, number]): number {
  const outside = distanceOutsideArc(directionDeg, window[0], window[1]);
  if (outside === 0) return 1;
  if (outside <= SCORING.swellWindowToleranceDeg) return SCORING.swellOutOfWindowWeight;
  return 0;
}

/**
 * The "swell directed at the spot" the way surf-forecast defines it: components inside the spot's
 * window count in full, those at ≤ 20° outside the window count at half, the rest not at all.
 * periodS: PEAK period (Tp) when the gwam model publishes it for that hour (`hour.peakPeriodS`);
 * otherwise falls back to the MEAN period of the dominant component.
 */
export function effectiveSwell(hour: SwellHour, window: [number, number]): EffectiveSwell {
  const parts = [hour.primary, hour.secondary]
    .map((c) => ({ c, weighted: c.heightM * componentWeight(c.directionDeg, window) }))
    .filter((p) => p.weighted > 0);
  if (parts.length === 0) return { heightM: 0, periodS: 0, directionDeg: 0 };
  const heightM = Math.sqrt(parts.reduce((sum, p) => sum + p.weighted * p.weighted, 0));
  const lead = parts.reduce((a, b) => (b.weighted > a.weighted ? b : a));
  return { heightM, periodS: hour.peakPeriodS ?? lead.c.periodS, directionDeg: lead.c.directionDeg };
}
