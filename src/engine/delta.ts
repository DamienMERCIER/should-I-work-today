import { SCORING } from '../config';
import type { Report, SpotHour, SpotResult, Verdict } from '../types';
import { rawStars } from './rating';
import { hoursBetween } from './time';
import { primaryPick } from './verdict';

/** The star rating depends only on wind and swell: those are the only two possible causes. */
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

/** Different verdict, different primary spot, or a window shifted by ≥ 1h. */
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
 * What changed the star rating the most at the evening's peak hour, on the evening's primary spot: we
 * replay the peak with only the morning's wind, then with only the morning's swell, and keep whichever
 * gap is larger, provided it's worth at least one star. Downward if the verdict gets worse, upward if
 * it improves, either direction otherwise. In stars, not in raw factors: swell there is a base rating
 * brought down to 0..1, wind is a multiplier, and 0.15 of one doesn't weigh the same as 0.15 of the other.
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
