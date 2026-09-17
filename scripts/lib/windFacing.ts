import { windState, type WindState } from '../../src/engine/rating';

/**
 * The facing surf-forecast assigns to a spot, recovered from its own page: for each time slot,
 * the "Wind" row gives the direction and the "Wind State" row the effect (offshore, cross-shore…),
 * computed by the site from that facing. We invert it using the same sectors as the star rating
 * (`windState`): no request beyond the page already fetched, and wind states that match the site
 * by construction.
 */
export interface WindSlot { windDir: string; state: WindState }

export interface WindFacing {
  /** midpoint of the arc of facings that explain the most time slots, in degrees */
  facing: number;
  /** width of that arc, to the nearest degree: the precision of the facing (about twenty degrees at best, the compass's resolution) */
  widthDeg: number;
  /** time slots explained by these facings */
  explained: number;
  /** usable time slots: known compass direction, and not "glassy", which says nothing about the angle */
  usable: number;
}

export const WIND_FACING = {
  minSlots: 4,
  /** below this, the displayed states don't fit within any single facing: the page doesn't decide it */
  minExplainedShare: 0.75,
  /** beyond this, the time slots leave two possible sides open (a single wind direction read as cross-shore) or almost everything */
  maxArcDeg: 90,
} as const;

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** enough wind to never be "glassy": only the angle matters for the inversion */
const NOT_GLASSY_KT = 99;

/** The facing, or `null` when the page's wind doesn't allow deciding it (§WIND_FACING). */
export function facingFromWind(slots: WindSlot[]): WindFacing | null {
  const usable = slots.flatMap((s) => {
    const i = COMPASS_16.indexOf(s.windDir.toUpperCase());
    return i < 0 || s.state === 'glassy' ? [] : [{ windFromDeg: i * 22.5, state: s.state }];
  });
  if (usable.length < WIND_FACING.minSlots) return null;

  const scores = Array.from({ length: 360 }, (_, facing) =>
    usable.filter((s) => windState(s.windFromDeg, facing, NOT_GLASSY_KT) === s.state).length);
  const explained = Math.max(...scores);
  if (explained < WIND_FACING.minExplainedShare * usable.length) return null;

  // The arc that covers all the best facings is the complement of the largest gap between
  // two of them, going around the dial: 349°…11° is centered on 0°, not on 180°.
  const best = scores.flatMap((n, facing) => (n === explained ? [facing] : []));
  let largestGap = 0;
  let arcStart = best[0];
  best.forEach((facing, i) => {
    const next = i + 1 < best.length ? best[i + 1] : best[0] + 360;
    if (next - facing > largestGap) {
      largestGap = next - facing;
      arcStart = next % 360;
    }
  });
  const widthDeg = 360 - largestGap;
  // Separated ties (315° and 0°, with nothing in between) don't form an arc: their midpoint would explain fewer
  // time slots than either one alone. A real arc contains every degree between its edges.
  if (best.length !== widthDeg + 1 || widthDeg > WIND_FACING.maxArcDeg) return null;
  return { facing: Math.round(arcStart + widthDeg / 2) % 360, widthDeg, explained, usable: usable.length };
}
