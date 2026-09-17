import type { LatLon } from '../types';

export const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}

/**
 * Destination point at `distanceKm` from `(lat, lon)` along the great circle on bearing `bearingDeg`
 * (0 = N, 90 = E). Geodesic inverse of `haversineKm` (standard spherical formula). Used by the world
 * import (`scripts/import-spots.ts`, `src/data/world.ts`) for the elevation ring and to place the
 * `swellRef` of a synthetic offshore region (§`world-import.md`).
 */
export function destinationPoint(lat: number, lon: number, bearingDeg: number, distanceKm: number): LatLon {
  const delta = distanceKm / EARTH_RADIUS_KM;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 = lambda1 + Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
  return { lat: toDeg(phi2), lon: ((toDeg(lambda2) + 540) % 360) - 180 };
}

export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Smallest angle between two directions, 0..180. */
export function angularDistance(a: number, b: number): number {
  const d = Math.abs(norm360(a) - norm360(b));
  return d > 180 ? 360 - d : d;
}

/** Is x within the arc [from → to] traveled clockwise? */
export function inArc(x: number, from: number, to: number): boolean {
  const v = norm360(x);
  const f = norm360(from);
  const t = norm360(to);
  return f <= t ? v >= f && v <= t : v >= f || v <= t;
}

export function distanceOutsideArc(x: number, from: number, to: number): number {
  if (inArc(x, from, to)) return 0;
  return Math.min(angularDistance(x, from), angularDistance(x, to));
}

/** 0 = N, 1 = NE, 2 = E, 3 = SE, 4 = S, 5 = SW, 6 = W, 7 = NW. */
export function cardinal8(deg: number): number {
  return Math.round(norm360(deg) / 45) % 8;
}
