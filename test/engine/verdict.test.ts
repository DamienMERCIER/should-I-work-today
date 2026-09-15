import { describe, it, expect } from 'vitest';
import { decideVerdict, overlapHours, hoursBefore, hoursAfter, primaryPick } from '../../src/engine/verdict';
import type { SpotResult, Window } from '../../src/types';

const DATE = '2026-09-16'; // mercredi
const SAT = '2026-09-19';
const WORK = { start: '09:00', end: '18:00' };

const W = (date: string, s: string, e: string, peak: number): Window => ({ start: `${date}T${s}`, end: `${date}T${e}`, peak, mean: peak });
const res = (spotId: string, windows: Window[], o: { distanceKm?: number; open?: boolean; maxScore?: number } = {}): SpotResult => ({
  spotId, distanceKm: o.distanceKm ?? 10, open: o.open ?? true, hours: [], windows, best: windows[0],
  maxScore: o.maxScore ?? (windows[0]?.peak ?? 0),
});
const day = (results: SpotResult[], workHours = WORK) => decideVerdict(results, { date: DATE, workHours, mode: 'day' });

describe('window arithmetic', () => {
  const w = W(DATE, '07:00', '12:00', 8);
  it('overlapHours with work hours', () => {
    expect(overlapHours(w, '09:00', '18:00')).toBe(3);
    expect(overlapHours(w, '13:00', '18:00')).toBe(0);
  });
  it('hoursBefore / hoursAfter a limit', () => {
    expect(hoursBefore(w, '09:00')).toBe(2);
    expect(hoursBefore(w, '06:00')).toBe(0);
    expect(hoursAfter(w, '10:00')).toBe(2);
    expect(hoursAfter(w, '13:00')).toBe(0);
  });
});

describe('weekday verdict', () => {
  it('🟢 when a good window bites ≥ 2 h into work hours', () => {
    const v = day([res('kommetjie-long-beach', [W(DATE, '07:00', '12:00', 8.6)])]);
    expect(v).toEqual({ kind: 'green', spotId: 'kommetjie-long-beach', window: W(DATE, '07:00', '12:00', 8.6), epic: false });
  });
  it('🌅 dawn when the good window sits before work', () => {
    const v = day([res('muizenberg', [W(DATE, '07:00', '09:00', 8)])]);
    expect(v).toEqual({ kind: 'yellow', dawn: { spotId: 'muizenberg', window: W(DATE, '07:00', '09:00', 8) }, dusk: undefined });
  });
  it('a light overflow into work hours does not disqualify dawn', () => {
    const v = day([res('muizenberg', [W(DATE, '07:00', '10:00', 8)])]);
    expect(v.kind).toBe('yellow');
    expect(primaryPick(v)?.window.end).toBe(`${DATE}T10:00`);
  });
  it('🌇 dusk when ≥ 1.5 h remain after work', () => {
    const v = day([res('glen-beach', [W(DATE, '16:00', '19:00', 7.5)])], { start: '09:00', end: '16:00' });
    expect(v).toEqual({ kind: 'yellow', dawn: undefined, dusk: { spotId: 'glen-beach', window: W(DATE, '16:00', '19:00', 7.5) } });
  });
  it('both dawn and dusk when both exist', () => {
    const v = day([res('a', [W(DATE, '07:00', '09:00', 7.5)]), res('b', [W(DATE, '16:00', '19:00', 8)])], { start: '09:00', end: '16:00' });
    expect(v).toEqual({ kind: 'yellow', dawn: { spotId: 'a', window: W(DATE, '07:00', '09:00', 7.5) }, dusk: { spotId: 'b', window: W(DATE, '16:00', '19:00', 8) } });
  });
  it('🟢 epic: peak ≥ 9 for ≥ 1.5 h wins even before work', () => {
    const v = day([res('outer-kom', [W(DATE, '07:00', '09:00', 9.2)])]);
    expect(v).toEqual({ kind: 'green', spotId: 'outer-kom', window: W(DATE, '07:00', '09:00', 9.2), epic: true });
  });
  it('an epic hour that is too short is not enough', () => {
    const v = day([res('outer-kom', [W(DATE, '07:00', '08:00', 9.5)])], WORK);
    expect(v).toEqual({ kind: 'red', bestSpotId: 'outer-kom' });
  });
  it('🔴 with the best open spot when nothing reaches 7', () => {
    const v = day([res('a', [W(DATE, '07:00', '10:00', 6.5)], { maxScore: 6.5 }), res('b', [], { maxScore: 4.2 })]);
    expect(v).toEqual({ kind: 'red', bestSpotId: 'a' });
  });
  it('ignores windows of spots closed to the level', () => {
    const v = day([res('outer-kom', [W(DATE, '07:00', '12:00', 9)], { open: false, maxScore: 0 })]);
    expect(v).toEqual({ kind: 'red', bestSpotId: undefined });
  });
  it('ranks candidates by peak, then duration, then distance', () => {
    const tieByDistance = day([
      res('far', [W(DATE, '07:00', '12:00', 8)], { distanceKm: 15 }),
      res('near', [W(DATE, '07:00', '12:00', 8)], { distanceKm: 5 }),
    ]);
    expect(primaryPick(tieByDistance)?.spotId).toBe('near');
    const longerWins = day([
      res('long', [W(DATE, '07:00', '13:00', 8)], { distanceKm: 15 }),
      res('near', [W(DATE, '07:00', '12:00', 8)], { distanceKm: 5 }),
    ]);
    expect(primaryPick(longerWins)?.spotId).toBe('long');
  });
});

describe('weekend and /now rule', () => {
  it('🟢 on Saturday with any good window ≥ 1.5 h, never 🟡', () => {
    const v = decideVerdict([res('muizenberg', [W(SAT, '07:00', '09:00', 7.5)])], { date: SAT, workHours: WORK, mode: 'day' });
    expect(v).toEqual({ kind: 'green', spotId: 'muizenberg', window: W(SAT, '07:00', '09:00', 7.5), epic: false });
  });
  it('🔴 on Saturday when the good window is too short', () => {
    const v = decideVerdict([res('muizenberg', [W(SAT, '07:00', '08:00', 8)])], { date: SAT, workHours: WORK, mode: 'day' });
    expect(v).toEqual({ kind: 'red', bestSpotId: 'muizenberg' });
  });
  it('/now on a weekday uses the weekend rule', () => {
    const v = decideVerdict([res('muizenberg', [W(DATE, '07:00', '09:00', 7.5)])], { date: DATE, workHours: WORK, mode: 'now' });
    expect(v.kind).toBe('green');
  });
});

describe('primaryPick', () => {
  it('returns the green spot, the dawn (then dusk) pick, or nothing', () => {
    expect(primaryPick({ kind: 'green', spotId: 'a', window: W(DATE, '07:00', '09:00', 8), epic: false })?.spotId).toBe('a');
    expect(primaryPick({ kind: 'yellow', dusk: { spotId: 'b', window: W(DATE, '16:00', '19:00', 8) } })?.spotId).toBe('b');
    expect(primaryPick({ kind: 'red' })).toBeUndefined();
    expect(primaryPick({ kind: 'noData', reason: 'x' })).toBeUndefined();
  });
});
