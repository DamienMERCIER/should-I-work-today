import { TZ_OFFSET_MIN } from '../config';

const HOUR_MS = 3_600_000;

/** Les chiffres de `t` entre `from` et `to`, ou -1 s'il y a autre chose qu'un chiffre. */
function digits(t: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    const d = t.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return -1;
    n = n * 10 + d;
  }
  return n;
}

/** 'YYYY-MM-DDTHH:mm' (heure locale, traitée comme un UTC fictif) → millisecondes. */
export function toMs(t: string): number {
  // Le moteur convertit ainsi des milliers d'heures par envoi : recomposer une chaîne pour Date.parse coûtait ~12 %
  // de l'envoi du dimanche (profil du 17/09/2026). La forme courante est donc lue chiffre par chiffre ; ce qui sort
  // des bornes où Date.UTC donne le même instant que Date.parse (an < 1000, 24:30…) repasse par Date.parse.
  if (t.length === 16 && t.charCodeAt(4) === 45 && t.charCodeAt(7) === 45 && t.charCodeAt(10) === 84 && t.charCodeAt(13) === 58) {
    const year = digits(t, 0, 4);
    const month = digits(t, 5, 7);
    const day = digits(t, 8, 10);
    const hour = digits(t, 11, 13);
    const minute = digits(t, 14, 16);
    const inRange = year >= 1000 && month >= 1 && month <= 12 && day >= 1 && day <= 31 &&
      minute >= 0 && minute <= 59 && hour >= 0 && (hour <= 23 || (hour === 24 && minute === 0));
    if (inRange) return Date.UTC(year, month - 1, day, hour, minute);
  }
  const ms = Date.parse(`${t.length === 16 ? `${t}:00` : t}Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid local time: ${t}`);
  return ms;
}

export function fromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

export function addHours(t: string, h: number): string {
  return fromMs(toMs(t) + h * HOUR_MS);
}

export function addDays(date: string, n: number): string {
  return fromMs(toMs(`${date}T00:00`) + n * 24 * HOUR_MS).slice(0, 10);
}

export function hoursBetween(a: string, b: string): number {
  return (toMs(b) - toMs(a)) / HOUR_MS;
}

export function dateOf(t: string): string {
  return t.slice(0, 10);
}

export function hhmm(t: string): string {
  return t.slice(11, 16);
}

export function atTime(date: string, hhmmStr: string): string {
  return `${date}T${hhmmStr}`;
}

export function isWeekend(date: string): boolean {
  const day = new Date(toMs(`${date}T00:00`)).getUTCDay();
  return day === 0 || day === 6;
}

/** Instant UTC (ms) → heure locale SAST 'YYYY-MM-DDTHH:mm'. */
export function nowLocal(nowMs: number = Date.now()): string {
  return fromMs(nowMs + TZ_OFFSET_MIN * 60_000);
}

export function floorHour(t: string): string {
  return `${t.slice(0, 13)}:00`;
}
