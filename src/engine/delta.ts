import { SCORING } from '../config';
import type { Report, SpotHour, SpotResult, Verdict } from '../types';
import { hoursBetween } from './time';
import { primaryPick } from './verdict';

export type Cause = 'wind' | 'size' | 'period' | 'tide';
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

const CAUSE_KEYS: Cause[] = ['wind', 'size', 'period', 'tide'];

function peakHourIn(r: SpotResult, start: string, end: string): SpotHour | undefined {
  return r.hours.filter((h) => h.time >= start && h.time < end).sort((a, b) => b.score - a.score)[0];
}

/**
 * Facteur qui a le plus varié (≥ 0.15) à l'heure du pic du soir, sur le spot principal du soir.
 * Baisse si le verdict se dégrade, hausse s'il s'améliore, n'importe quel sens sinon.
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
  let cause: Cause | undefined;
  let magnitude: number = SCORING.deltaCauseThreshold;
  for (const key of CAUSE_KEYS) {
    const d = afterHour.factors[key] - peakHour.factors[key];
    if (direction !== 0 && Math.sign(d) !== direction) continue;
    if (Math.abs(d) >= magnitude) {
      magnitude = Math.abs(d);
      cause = key;
    }
  }
  return cause;
}
