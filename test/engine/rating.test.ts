import { describe, it, expect } from 'vitest';
import { energyKJ, rateLikeSurfForecast, starBase, starGlyphs, windStarFactor, windState, type WindState } from '../../src/engine/rating';

/**
 * 78 rows recorded from surf-forecast.com on 2026-09-16 (the "hourly" and "16 day" tables):
 * [spot, height m, period s, energy kJ, wind km/h, wind state, displayed rating].
 * Muizenberg, Long Beach (Kommetjie) and the Cape Town wavefinder for the low end of the scale and
 * strong winds; Papatowai (NZ) and Cathedral Rock (AU) for ratings 4..9.
 */
const ROWS: ReadonlyArray<readonly [string, number, number, number, number, WindState, number]> = [
  ['papatowai', 2.5, 14, 2191, 10, 'cross-off', 4],
  ['papatowai', 2.3, 14, 2006, 5, 'cross-off', 4],
  ['papatowai', 2.3, 14, 2090, 10, 'cross-off', 4],
  ['papatowai', 2.3, 14, 2119, 10, 'off', 4],
  ['papatowai', 2.1, 14, 1688, 15, 'cross-off', 4],
  ['papatowai', 3.0, 17, 4183, 20, 'off', 5],
  ['papatowai', 3.0, 16, 4549, 20, 'off', 5],
  ['papatowai', 3.0, 16, 4605, 20, 'off', 5],
  ['papatowai', 3.5, 16, 5879, 20, 'cross-off', 5],
  ['papatowai', 4.0, 16, 6967, 25, 'off', 8],
  ['papatowai', 3.5, 15, 6324, 20, 'cross-off', 6],
  ['papatowai', 3.5, 15, 6080, 30, 'off', 6],
  ['papatowai', 4.0, 15, 7635, 20, 'off', 8],
  ['papatowai', 4.5, 15, 7703, 20, 'off', 8],
  ['papatowai', 4.0, 15, 7262, 10, 'off', 8],
  ['papatowai', 4.0, 15, 6580, 10, 'cross-off', 7],
  ['papatowai', 5.0, 14, 10063, 35, 'off', 7],
  ['papatowai', 5.0, 16, 12373, 20, 'off', 9],
  ['papatowai', 2.3, 15, 2278, 10, 'off', 5],
  ['papatowai', 3.5, 16, 6461, 25, 'cross-off', 6],
  ['papatowai', 4.5, 15, 8299, 30, 'off', 8],
  ['papatowai', 4.5, 16, 11324, 25, 'cross-off', 8],
  ['papatowai', 3.0, 14, 3636, 25, 'cross-off', 4],
  ['papatowai', 3.0, 16, 4772, 20, 'cross-off', 4],
  ['papatowai', 2.5, 14, 2967, 15, 'cross-off', 4],
  ['cathedral', 1.5, 18, 1342, 5, 'glassy', 4],
  ['cathedral', 2.4, 17, 3287, 5, 'glassy', 4],
  ['cathedral', 3.0, 16, 4657, 5, 'glassy', 5],
  ['cathedral', 3.0, 16, 3745, 10, 'off', 4],
  ['cathedral', 2.4, 15, 2662, 10, 'cross-off', 4],
  ['cathedral', 2.0, 14, 1572, 15, 'cross-off', 3],
  ['capetown', 1.4, 13, 594, 25, 'off', 2],
  ['capetown', 1.6, 11, 685, 20, 'off', 3],
  ['capetown', 1.6, 11, 640, 10, 'off', 3],
  ['capetown', 1.6, 12, 811, 15, 'off', 3],
  ['capetown', 1.4, 12, 514, 25, 'off', 3],
  ['capetown', 1.9, 13, 1216, 20, 'off', 4],
  ['capetown', 1.5, 12, 657, 15, 'off', 3],
  ['capetown', 1.4, 12, 545, 10, 'off', 3],
  ['capetown', 1.3, 12, 456, 15, 'cross-off', 3],
  ['capetown', 1.1, 11, 283, 10, 'cross-off', 2],
  ['capetown', 1.0, 13, 331, 5, 'glassy', 3],
  ['capetown', 1.0, 12, 287, 10, 'cross-off', 2],
  ['capetown', 1.2, 10, 313, 10, 'off', 2],
  ['muizenberg', 0.7, 13, 172, 0, 'glassy', 2],
  ['cathedral', 2.5, 14, 2267, 5, 'cross', 4],
  ['cathedral', 2.5, 12, 2177, 10, 'cross', 3],
  ['cathedral', 4.5, 17, 13120, 10, 'cross', 8],
  ['cathedral', 3.0, 15, 4306, 10, 'cross', 4],
  ['papatowai', 3.5, 15, 5785, 10, 'cross', 5],
  ['papatowai', 3.5, 14, 4881, 15, 'cross', 4],
  ['cathedral', 2.5, 14, 2526, 5, 'cross-on', 3],
  ['cathedral', 1.8, 11, 757, 10, 'cross-on', 3],
  ['cathedral', 3.0, 14, 3110, 10, 'cross-on', 3],
  ['cathedral', 4.0, 17, 9768, 10, 'cross-on', 6],
  ['cathedral', 4.0, 16, 7113, 15, 'cross-on', 4],
  ['cathedral', 3.0, 16, 4915, 25, 'cross-on', 0],
  ['cathedral', 4.0, 16, 6762, 25, 'cross-on', 0],
  ['cathedral', 4.5, 18, 11917, 20, 'cross-on', 0],
  ['cathedral', 3.0, 14, 3669, 15, 'on', 1],
  ['cathedral', 1.1, 12, 392, 20, 'on', 0],
  ['cathedral', 2.2, 9, 695, 20, 'on', 0],
  ['muizenberg', 2.1, 14, 1812, 25, 'cross-on', 0],
  ['muizenberg', 2.1, 14, 1665, 30, 'cross-on', 0],
  ['muizenberg', 0.8, 11, 150, 10, 'on', 1],
  ['muizenberg', 0.9, 12, 240, 15, 'on', 0],
  ['muizenberg', 0.8, 12, 197, 25, 'on', 0],
  ['muizenberg', 0.8, 11, 180, 10, 'cross-on', 0],
  ['muizenberg', 0.8, 10, 132, 15, 'cross-on', 0],
  ['muizenberg', 1.0, 12, 301, 25, 'on', 0],
  ['longbeach', 3.0, 13, 2682, 35, 'cross-off', 2],
  ['longbeach', 2.5, 13, 2207, 40, 'cross-off', 1],
  ['longbeach', 1.7, 13, 999, 40, 'cross-off', 1],
  ['longbeach', 1.8, 13, 1155, 45, 'cross-off', 0],
  ['longbeach', 2.2, 13, 1594, 45, 'cross-off', 0],
  ['longbeach', 2.2, 12, 1404, 45, 'cross-off', 1],
  ['longbeach', 2.2, 12, 1381, 45, 'cross-off', 0],
  ['longbeach', 1.7, 13, 917, 40, 'cross-off', 0],
];

const KMH = 1.852;

describe('rating: reproducing surf-forecast\'s own ratings', () => {
  it('stays within ±1 star on at least 95% of the rows and lands exactly on at least 65%', () => {
    let exact = 0;
    let within1 = 0;
    for (const [, h, , , kmh, state, obs] of ROWS) {
      const base = starBase(h);
      const stars = base < 0.5 ? 0 : Math.round(base * windStarFactor(state, kmh / KMH));
      const diff = Math.abs(stars - obs);
      if (diff === 0) exact++;
      if (diff <= 1) within1++;
    }
    expect(within1 / ROWS.length).toBeGreaterThanOrEqual(0.95);
    expect(exact / ROWS.length).toBeGreaterThanOrEqual(0.65);
  });

  it('energy ≈ 2·H²·T², like the site\'s kJ column (±25%: heights and periods are rounded)', () => {
    let ok = 0;
    for (const [, h, t, e] of ROWS) {
      if (Math.abs(energyKJ(h, t) - e) / e <= 0.25) ok++;
    }
    expect(ok / ROWS.length).toBeGreaterThanOrEqual(0.85);
  });

  it('onshore and cross-onshore drop to 0 from 20 km/h on, whatever the swell (Cathedral Rock 4.5 m 18 s → 0)', () => {
    expect(windStarFactor('on', 20 / KMH)).toBe(0);
    expect(windStarFactor('cross-on', 20 / KMH)).toBe(0);
    expect(rateLikeSurfForecast({ heightM: 4.5, periodS: 18, windKt: 20 / KMH, windFromDeg: 0, facingDeg: 0 }).stars).toBe(0);
  });

  it('offshore costs nothing up to 30 km/h', () => {
    expect(windStarFactor('off', 30 / KMH)).toBe(1);
    expect(windStarFactor('off', 10 / KMH)).toBe(1);
  });
});

describe('windState', () => {
  const facing = 300; // Long Beach: offshore = 120 (ESE)
  it('cuts 45° sectors around the offshore direction', () => {
    expect(windState(120, facing, 10)).toBe('off');
    expect(windState(135, facing, 10)).toBe('off'); // SE, 15° off the offshore direction
    expect(windState(165, facing, 10)).toBe('cross-off'); // 45°
    expect(windState(210, facing, 10)).toBe('cross'); // 90°
    expect(windState(255, facing, 10)).toBe('cross-on'); // 135°
    expect(windState(300, facing, 10)).toBe('on'); // fully onshore
  });
  it('glassy under 5 km/h whatever the angle', () => {
    expect(windState(300, facing, 2)).toBe('glassy');
    expect(windState(300, facing, 3)).toBe('on');
  });
});

describe('rateLikeSurfForecast', () => {
  it('Muizenberg 16/09 5am: 2.1 m 14 s, 25 km/h SSE cross-on → 0 stars, white', () => {
    const r = rateLikeSurfForecast({ heightM: 2.1, periodS: 14, windKt: 25 / KMH, windFromDeg: 157, facingDeg: 150 });
    expect(r.stars).toBe(0);
    expect(r.clean).toBe(false);
  });
  it('Papatowai 18/09 3pm: 4.5 m 15 s, 20 km/h offshore → 8 stars, gold', () => {
    const r = rateLikeSurfForecast({ heightM: 4.5, periodS: 15, windKt: 20 / KMH, windFromDeg: 270, facingDeg: 90 });
    expect(r.stars).toBe(8);
    expect(r.clean).toBe(true);
    expect(r.state).toBe('off');
  });
  it('flat = 0 stars', () => {
    expect(rateLikeSurfForecast({ heightM: 0.2, periodS: 12, windKt: 0, windFromDeg: 0, facingDeg: 0 }).stars).toBe(0);
  });
});

describe('starGlyphs', () => {
  it('full when it is clean, hollow under onshore wind, a dot at 0', () => {
    expect(starGlyphs({ stars: 4, clean: true })).toBe('⭐⭐⭐⭐');
    expect(starGlyphs({ stars: 3, clean: false })).toBe('☆☆☆');
    expect(starGlyphs({ stars: 0, clean: true })).toBe('·');
  });
});
