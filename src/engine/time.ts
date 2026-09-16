import { TZ_OFFSET_MIN } from '../config';

const HOUR_MS = 3_600_000;

/** 'YYYY-MM-DDTHH:mm' (heure locale, traitée comme un UTC fictif) → millisecondes. */
export function toMs(t: string): number {
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
