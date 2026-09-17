import { SCORING } from '../config';
import { toMs } from './time';

/**
 * What decides whether an hour can count toward a session, without touching the star rating: daylight
 * and thunderstorms. The rating itself comes from `rating.ts`, the surf-forecast reconstruction.
 */

/** 1 if the slot [slotStart, slotStart + 1h) contains ≥ 45 min of daylight. */
export function daylightFactor(slotStart: string, sunrise: string, sunset: string): number {
  const start = toMs(slotStart);
  const end = start + 3_600_000;
  const overlapMs = Math.min(end, toMs(sunset)) - Math.max(start, toMs(sunrise));
  return overlapMs >= SCORING.daylightMinMinutes * 60_000 ? 1 : 0;
}

/**
 * Is there at least one daylight slot left before the end of the day? We scan the hours rather
 * than comparing against `sunset` directly: `daylightFactor` already zeroes out any hour that overlaps
 * daylight by less than 45 min, so the last surfable hour dies before sunset, not exactly at it
 * (18:00 is already dead when the sun sets at 18:38). And before sunrise, the whole day is still
 * ahead: only a scan sees that.
 */
export function hasDaylightLeft(fromTime: string, sunrise: string, sunset: string): boolean {
  const date = fromTime.slice(0, 10);
  for (let h = Number(fromTime.slice(11, 13)); h <= 23; h++) {
    if (daylightFactor(`${date}T${String(h).padStart(2, '0')}:00`, sunrise, sunset) === 1) return true;
  }
  return false;
}

export function weatherFactor(code: number): number {
  return SCORING.thunderstormCodes.includes(code) ? 0 : 1;
}
