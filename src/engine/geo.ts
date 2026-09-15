import type { LatLon } from '../types';

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}

export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Plus petit angle entre deux directions, 0..180. */
export function angularDistance(a: number, b: number): number {
  const d = Math.abs(norm360(a) - norm360(b));
  return d > 180 ? 360 - d : d;
}

/** x est-il dans l'arc [from → to] parcouru dans le sens horaire ? */
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
