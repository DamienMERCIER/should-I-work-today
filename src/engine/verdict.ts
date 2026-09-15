import { SCORING } from '../config';
import type { SpotPick, SpotResult, Verdict, WorkHours, Window } from '../types';
import { windowHours } from './score';
import { atTime, dateOf, isWeekend, toMs } from './time';

export interface VerdictOptions {
  date: string;
  workHours: WorkHours;
  /** 'now' = reste de la journée, règle week-end (§7.7). */
  mode: 'day' | 'now';
}

interface Candidate extends SpotPick { distanceKm: number }

const HOUR_MS = 3_600_000;

/** Recouvrement (h) entre la fenêtre et [start, end) du même jour. */
export function overlapHours(w: Window, start: string, end: string): number {
  const date = dateOf(w.start);
  const s = Math.max(toMs(w.start), toMs(atTime(date, start)));
  const e = Math.min(toMs(w.end), toMs(atTime(date, end)));
  return Math.max(0, (e - s) / HOUR_MS);
}

export function hoursBefore(w: Window, limit: string): number {
  const l = toMs(atTime(dateOf(w.start), limit));
  return Math.max(0, (Math.min(toMs(w.end), l) - toMs(w.start)) / HOUR_MS);
}

export function hoursAfter(w: Window, limit: string): number {
  const l = toMs(atTime(dateOf(w.start), limit));
  return Math.max(0, (toMs(w.end) - Math.max(toMs(w.start), l)) / HOUR_MS);
}

function candidates(results: SpotResult[]): Candidate[] {
  return results
    .filter((r) => r.open)
    .flatMap((r) =>
      r.windows
        .filter((w) => w.peak >= SCORING.good)
        .map((window) => ({ spotId: r.spotId, window, distanceKm: r.distanceKm })),
    );
}

/** Pic le plus haut, puis durée, puis distance (§7.5). */
function best(cands: Candidate[]): Candidate | undefined {
  return [...cands].sort(
    (a, b) =>
      b.window.peak - a.window.peak ||
      windowHours(b.window) - windowHours(a.window) ||
      a.distanceKm - b.distanceKm,
  )[0];
}

const toPick = (c: Candidate): SpotPick => ({ spotId: c.spotId, window: c.window });
const longEnough = (w: Window): boolean => windowHours(w) >= SCORING.sessionMinH;
const isEpic = (w: Window): boolean => w.peak >= SCORING.epic && longEnough(w);

export function decideVerdict(results: SpotResult[], opts: VerdictOptions): Verdict {
  const cands = candidates(results);
  const bestSpotId = [...results].filter((r) => r.open).sort((a, b) => b.maxScore - a.maxScore)[0]?.spotId;

  if (opts.mode === 'now' || isWeekend(opts.date)) {
    const c = best(cands.filter((x) => longEnough(x.window)));
    return c
      ? { kind: 'green', spotId: c.spotId, window: c.window, epic: c.window.peak >= SCORING.epic }
      : { kind: 'red', bestSpotId };
  }

  const { start, end } = opts.workHours;
  const green = best(cands.filter((x) => overlapHours(x.window, start, end) >= SCORING.greenWorkOverlapH || isEpic(x.window)));
  if (green) return { kind: 'green', spotId: green.spotId, window: green.window, epic: green.window.peak >= SCORING.epic };

  const dawn = best(cands.filter((x) => hoursBefore(x.window, start) >= SCORING.sessionMinH));
  const dusk = best(cands.filter((x) => hoursAfter(x.window, end) >= SCORING.sessionMinH));
  if (dawn || dusk) return { kind: 'yellow', dawn: dawn && toPick(dawn), dusk: dusk && toPick(dusk) };

  return { kind: 'red', bestSpotId };
}

export function primaryPick(v: Verdict): SpotPick | undefined {
  switch (v.kind) {
    case 'green':
      return { spotId: v.spotId, window: v.window };
    case 'yellow':
      return v.dawn ?? v.dusk;
    default:
      return undefined;
  }
}
