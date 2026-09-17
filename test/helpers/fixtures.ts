import type { SwellComponent, SwellHour, WindHour } from '../../src/types';
import { addHours, hoursBetween } from '../../src/engine/time';

/** Every full hour from `from` to `to` inclusive. */
export function hourlyTimes(from: string, to: string): string[] {
  const n = hoursBetween(from, to);
  const out: string[] = [];
  for (let i = 0; i <= n; i++) out.push(addHours(from, i));
  return out;
}

export function swellSeries(
  from: string,
  to: string,
  at: (time: string, i: number) => Omit<SwellHour, 'time'>,
): SwellHour[] {
  return hourlyTimes(from, to).map((time, i) => ({ time, ...at(time, i) }));
}

export function windSeries(
  from: string,
  to: string,
  at: (time: string, i: number) => Partial<Omit<WindHour, 'time'>>,
): WindHour[] {
  return hourlyTimes(from, to).map((time, i) => ({
    time, windKt: 0, windDirDeg: 0, gustKt: 0, tempC: 20, precipMm: 0, weatherCode: 1, ...at(time, i),
  }));
}

/** Synthetic tide 0.5·cos(2π·(t−9)/12), t in hours since `date` 00:00 → highs at 09h/21h, lows at 03h/15h. */
export function cosineTide(date: string): (time: string) => number {
  const origin = `${date}T00:00`;
  return (time) => 0.5 * Math.cos((2 * Math.PI * (hoursBetween(origin, time) - 9)) / 12);
}

export const NO_SWELL: SwellComponent = { heightM: 0, periodS: 0, directionDeg: 0 };
