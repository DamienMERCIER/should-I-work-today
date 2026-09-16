import { SCORING } from '../config';
import type { Report, SpotHour, SpotResult, Verdict } from '../types';
import { rawStars } from './rating';
import { hoursBetween } from './time';
import { primaryPick } from './verdict';

/** Les étoiles ne dépendent que du vent et de la houle : ce sont les deux seules causes possibles. */
export type Cause = 'wind' | 'size';
export interface Delta { send: boolean; changed: boolean; cause?: Cause }

export const isActionable = (v: Verdict | undefined): boolean => v?.kind === 'green' || v?.kind === 'yellow';

const rank = (v: Verdict | undefined): number => (v?.kind === 'green' ? 2 : v?.kind === 'yellow' ? 1 : 0);

export function compareReports(evening: Report | undefined, morning: Report): Delta {
  const prev = evening?.verdict;
  const send = isActionable(prev) || isActionable(morning.verdict);
  if (!send) return { send: false, changed: false };
  if (morning.verdict.kind === 'noData') return { send: true, changed: false };
  if (!hasChanged(prev, morning.verdict)) return { send: true, changed: false };
  const cause = evening ? findCause(evening, morning) : undefined;
  return cause ? { send: true, changed: true, cause } : { send: true, changed: true };
}

/** Verdict différent, spot principal différent, ou fenêtre décalée de ≥ 1 h. */
export function hasChanged(prev: Verdict | undefined, next: Verdict): boolean {
  if (rank(prev) !== rank(next)) return true;
  const a = prev ? primaryPick(prev) : undefined;
  const b = primaryPick(next);
  if (!a || !b) return Boolean(a) !== Boolean(b);
  if (a.spotId !== b.spotId) return true;
  const shift = SCORING.deltaWindowShiftH;
  return (
    Math.abs(hoursBetween(a.window.start, b.window.start)) >= shift ||
    Math.abs(hoursBetween(a.window.end, b.window.end)) >= shift
  );
}



function peakHourIn(r: SpotResult, start: string, end: string): SpotHour | undefined {
  return r.hours.filter((h) => h.time >= start && h.time < end).sort((a, b) => b.score - a.score)[0];
}

/**
 * Ce qui a le plus changé les étoiles à l'heure du pic du soir, sur le spot principal du soir : on
 * rejoue le pic avec le seul vent du matin, puis avec la seule houle du matin, et on garde l'écart le
 * plus grand s'il vaut au moins une étoile. Baisse si le verdict se dégrade, hausse s'il s'améliore,
 * n'importe quel sens sinon. En étoiles et pas en facteurs bruts : la houle y est une note de base
 * ramenée sur 0..1, le vent un multiplicateur, et 0,15 de l'un ne pèse pas 0,15 de l'autre.
 */
export function findCause(evening: Report, morning: Report): Cause | undefined {
  const pick = primaryPick(evening.verdict);
  if (!pick) return undefined;
  const before = evening.spots.find((s) => s.spotId === pick.spotId);
  const after = morning.spots.find((s) => s.spotId === pick.spotId);
  if (!before || !after) return undefined;
  const peakHour = peakHourIn(before, pick.window.start, pick.window.end);
  const afterHour = peakHour && after.hours.find((h) => h.time === peakHour.time);
  if (!peakHour || !afterHour) return undefined;

  const direction = Math.sign(rank(morning.verdict) - rank(evening.verdict));
  const base = (h: SpotHour): number => h.factors.swell * 10;
  const atPeak = rawStars(base(peakHour), peakHour.factors.wind);
  const changes: [Cause, number][] = [
    ['wind', rawStars(base(peakHour), afterHour.factors.wind) - atPeak],
    ['size', rawStars(base(afterHour), peakHour.factors.wind) - atPeak],
  ];
  let cause: Cause | undefined;
  let magnitude: number = SCORING.deltaCauseThreshold;
  for (const [key, d] of changes) {
    if (direction !== 0 && Math.sign(d) !== direction) continue;
    if (Math.abs(d) >= magnitude) {
      magnitude = Math.abs(d);
      cause = key;
    }
  }
  return cause;
}
