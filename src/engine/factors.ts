import { SCORING } from '../config';
import { toMs } from './time';

/**
 * Ce qui décide si une heure peut compter pour une session, sans toucher aux étoiles : la lumière et
 * l'orage. La note elle-même vient de `rating.ts`, la reconstruction de surf-forecast.
 */

/** 1 si le créneau [slotStart, slotStart + 1 h) contient ≥ 45 min de jour. */
export function daylightFactor(slotStart: string, sunrise: string, sunset: string): number {
  const start = toMs(slotStart);
  const end = start + 3_600_000;
  const overlapMs = Math.min(end, toMs(sunset)) - Math.max(start, toMs(sunrise));
  return overlapMs >= SCORING.daylightMinMinutes * 60_000 ? 1 : 0;
}

/**
 * Reste-t-il au moins un creneau de jour d'ici la fin de la journee ? On balaie les heures plutot
 * que de comparer a `sunset` : `daylightFactor` annule deja toute heure qui chevauche le jour de
 * moins de 45 min, donc la derniere heure surfable meurt avant le coucher du soleil, pas avec lui
 * (18:00 est deja mort quand le soleil se couche a 18:38). Et avant le lever, la journee est encore
 * entiere : seul un balayage le voit.
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
