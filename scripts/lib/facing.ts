import { destinationPoint, norm360 } from '../../src/engine/geo';

const RING_RADIUS_KM = 2;
const RING_COUNT = 24;

export interface RingPoint {
  bearing: number;
  lat: number;
  lon: number;
}

/**
 * 24 points on a 2 km ring around `(lat, lon)`, one every 15°, starting at true north. Feeds
 * Open-Meteo's elevation API (§elevation.ts) — `computeFacing` then keeps the ones at or below sea
 * level and takes their circular mean as the spot's facing (verified to ~7° mean error / 22° worst
 * case against five known spots — see the report).
 */
export function ringPoints(lat: number, lon: number, radiusKm = RING_RADIUS_KM, count = RING_COUNT): RingPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const bearing = (360 / count) * i;
    const { lat: rlat, lon: rlon } = destinationPoint(lat, lon, bearing, radiusKm);
    return { bearing, lat: rlat, lon: rlon };
  });
}

/**
 * Mean of angles in degrees via the unit-vector (sin/cos) sum, so a set like [350°, 10°] correctly
 * averages to 0° instead of the arithmetic-mean trap of 180°. `null` for an empty input — there is
 * nothing to average, and callers (`computeFacing`) rely on that to signal "skip this spot".
 */
export function circularMeanDeg(anglesDeg: number[]): number | null {
  if (anglesDeg.length === 0) return null;
  let sumSin = 0;
  let sumCos = 0;
  for (const deg of anglesDeg) {
    const rad = (deg * Math.PI) / 180;
    sumSin += Math.sin(rad);
    sumCos += Math.cos(rad);
  }
  const meanRad = Math.atan2(sumSin / anglesDeg.length, sumCos / anglesDeg.length);
  return norm360((meanRad * 180) / Math.PI);
}

export interface ElevationSample {
  bearing: number;
  elevation: number;
}

/**
 * Facing = circular mean of the bearings whose ring point is at or below sea level (elevation ≤ 0).
 * A ring with no sea point at all (spot entirely surrounded by land in the sample, e.g. a lake or a
 * bad coordinate) yields `null` — the importer must skip that spot rather than guess a facing
 * (§established facts, "no sea point in its ring").
 */
export function computeFacing(ring: ElevationSample[]): number | null {
  const seaBearings = ring.filter((p) => p.elevation <= 0).map((p) => p.bearing);
  return circularMeanDeg(seaBearings);
}
