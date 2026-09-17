import { angularDistance } from './geo';

/**
 * A "surf-forecast style" rating: stars 0..10 + color (gold = clean, white = messed up by onshore wind).
 *
 * Reconstructed on 2026-09-16 from 78 lines read on surf-forecast.com (Muizenberg, Long Beach,
 * Cape Town wavefinder, Papatowai NZ, Cathedral Rock AU): rating, height, period, energy, wind,
 * wind state. On those 78 lines the model below lands exactly right 71% of the time and within
 * ±1 star 97% of the time (the site's tables round height to 0.1 m / 0.5 m and wind to 5 km/h, hence
 * the residual noise). What the data says, in order of importance:
 *
 *  1. The base rating depends (almost) only on the HEIGHT of swell directed at the spot, roughly
 *     "half a star per foot": 0.7 m → 2, 1.5 m → 3, 2.3 m → 4, 3 m → 5, 3.5 m → 6, 4 m → 7-8,
 *     5 m → 9. Period only moves the rating at the margin (±1 over 10s vs 18s), unlike what the
 *     site's FAQ suggests. The displayed energy is ≈ 2·H²·T² kJ.
 *  2. Wind is a brutal, asymmetric MULTIPLIER, in six states (glassy, off, cross-off,
 *     cross, cross-on, on) split into 45° sectors around the offshore direction:
 *     onshore and cross-onshore drop to 0 as early as 20 km/h (11 kt); cross-off holds up to 25 km/h
 *     then collapses (35 km/h → ×0.4, 45 km/h → ×0.07); offshore costs nothing up to 30 km/h.
 *  3. Color: gold when the wind has no onshore component (glassy, off, cross-off), white
 *     otherwise (App Store: "gold = clean waves, white = onshore").
 *
 * This is the bot's rating: `score.ts` applies it to every hour of every spot, and keeps from the
 * rest (daylight, thunderstorm) only what decides whether an hour can count toward a session.
 */

export type WindState = 'glassy' | 'off' | 'cross-off' | 'cross' | 'cross-on' | 'on';

type Curve = ReadonlyArray<readonly [kmh: number, factor: number]>;

export const RATING = {
  /** Below this, the site shows "glassy" regardless of angle (wind is rounded to the nearest 5 km/h). */
  glassyMaxKmh: 5,
  /** Half-width of the "off" / "on" sector; the intermediate states each take 45°. */
  sectorHalfWidthDeg: 22.5,
  /**
   * Base rating = 1.81 + 0.37·H + 0.23·H² (H in m, swell directed at the spot), capped at 10.
   * Quadratic fit on 44 clean-wind lines (rmse 0.53). The linear alternative
   * "0.5 star per foot + 0.4" does just as well up to 3.5 m but underestimates 4 m and beyond.
   */
  base: { c0: 1.81, c1: 0.37, c2: 0.23 },
  /** Height (m) below which it's flat: 0 stars no matter what. */
  flatBelowM: 0.3,
  /** Wind factor per state, in km/h (the unit of the site's tables; the caller passes knots). */
  wind: {
    glassy: [[0, 1]] as Curve,
    off: [[30, 1], [35, 0.75], [45, 0.4], [55, 0]] as Curve,
    'cross-off': [[15, 1], [25, 0.9], [35, 0.4], [40, 0.2], [45, 0.07], [50, 0]] as Curve,
    cross: [[5, 1], [10, 0.83], [15, 0.65], [20, 0.4], [25, 0.15], [30, 0]] as Curve,
    'cross-on': [[3, 1], [5, 0.75], [10, 0.6], [15, 0.3], [20, 0]] as Curve,
    on: [[3, 1], [5, 0.7], [10, 0.45], [15, 0.1], [18, 0]] as Curve,
  },
  /** States with no onshore component: "gold" stars. */
  cleanStates: ['glassy', 'off', 'cross-off'] as readonly WindState[],
  /** kJ ≈ k·H²·T²; k fitted from the tables (0.9..1.0 once rounding is accounted for). */
  energyK: 2,
} as const;

export const KT_TO_KMH = 1.852;

/** Piecewise linear: value of the first point before it, of the last point after it. */
function piecewise(curve: Curve, x: number): number {
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

/**
 * Wind state, surf-forecast style: angle between the direction the wind is coming FROM and the
 * offshore direction (facing + 180), in 45° sectors: off ≤ 22.5°, cross-off ≤ 67.5°, cross ≤ 112.5°,
 * cross-on ≤ 157.5°, on beyond that. A wind under `glassyMaxKmh` is "glassy" regardless of angle.
 */
export function windState(windFromDeg: number, facingDeg: number, windKt: number): WindState {
  if (windKt * KT_TO_KMH < RATING.glassyMaxKmh) return 'glassy';
  const angle = angularDistance(windFromDeg, facingDeg + 180);
  const half = RATING.sectorHalfWidthDeg;
  if (angle <= half) return 'off';
  if (angle <= half + 45) return 'cross-off';
  if (angle <= half + 90) return 'cross';
  if (angle <= half + 135) return 'cross-on';
  return 'on';
}

/** Continuous base rating 0..10, before wind. `heightM` = swell directed at the spot, near shore. */
export function starBase(heightM: number): number {
  if (heightM < RATING.flatBelowM) return 0;
  const { c0, c1, c2 } = RATING.base;
  return Math.min(10, c0 + c1 * heightM + c2 * heightM * heightM);
}

/**
 * Stars before rounding: what a base rating and a wind factor are worth together. Rounded, it's
 * the displayed rating; raw, it's the common unit that lets you weigh what wind or swell costs
 * — 📋 explanations, the reason for a 🔴, the cause of a morning change — without comparing two
 * factors that aren't on the same scale.
 */
export function rawStars(base: number, windFactor: number): number {
  return base < 0.5 ? 0 : base * windFactor;
}

export function windStarFactor(state: WindState, windKt: number): number {
  return piecewise(RATING.wind[state], windKt * KT_TO_KMH);
}

/** Energy "kJ" the way the site displays it: ≈ 2·H²·T². Used to speak the same language as it. */
export function energyKJ(heightM: number, periodS: number): number {
  return Math.round(RATING.energyK * heightM * heightM * periodS * periodS);
}

export interface StarInput {
  /** swell directed at the spot, in meters (near shore, NOT the face height in feet) */
  heightM: number;
  periodS: number;
  windKt: number;
  windFromDeg: number;
  facingDeg: number;
}

export interface StarRating {
  /** 0..10 integer, comparable to the site's "Rating (10 max)" column */
  stars: number;
  /** true = gold stars (glassy, offshore, cross-offshore); false = white (the wind has an onshore component) */
  clean: boolean;
  state: WindState;
  /** base rating before wind, continuous, for debugging and calibration */
  base: number;
  windFactor: number;
  energyKJ: number;
}

export function rateLikeSurfForecast(input: StarInput): StarRating {
  const state = windState(input.windFromDeg, input.facingDeg, input.windKt);
  const base = starBase(input.heightM);
  const windFactor = windStarFactor(state, input.windKt);
  const stars = Math.round(rawStars(base, windFactor));
  return {
    stars, base, windFactor, state,
    clean: RATING.cleanStates.includes(state),
    energyKJ: energyKJ(input.heightM, input.periodS),
  };
}

/**
 * Text rendering for Telegram, where text has no color: the ⭐ emoji, yellow everywhere, for gold (clean), hollow ☆
 * for white (onshore). A solid ★ took on the text color: white in dark mode, so gold didn't show.
 * `⭐⭐⭐⭐☆☆` doesn't happen: it's all one or all the other, just like on the site.
 */
export function starGlyphs(rating: Pick<StarRating, 'stars' | 'clean'>): string {
  if (rating.stars === 0) return '·';
  return (rating.clean ? '⭐' : '☆').repeat(rating.stars);
}
