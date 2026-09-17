import { describe, it, expect } from 'vitest';
import { decideVerdict, overlapHours, hoursBefore, hoursAfter, primaryPick } from '../../src/engine/verdict';
import type { SpotResult, Window } from '../../src/types';
import { makeSpotDay } from '../helpers/reports';

const DATE = '2026-09-16'; // Wednesday
const SAT = '2026-09-19';
const WORK = { start: '09:00', end: '18:00' };

const W = (date: string, s: string, e: string, peak: number): Window => ({ start: `${date}T${s}`, end: `${date}T${e}`, peak, mean: peak });
const res = (spotId: string, windows: Window[], o: { distanceKm?: number; maxScore?: number } = {}): SpotResult => ({
  spotId, distanceKm: o.distanceKm ?? 10, hours: [], windows, best: windows[0],
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

describe('the bar each friend sets', () => {
  const at = (good: number, windows: Window[]) => decideVerdict([res('kommetjie-long-beach', windows)], { date: DATE, workHours: WORK, mode: 'day', good });
  it('4★ by default; higher, the same day is 🔴; lower, a smaller window is already 🟢', () => {
    const four = [W(DATE, '07:00', '12:00', 4)];
    expect(day([res('kommetjie-long-beach', four)]).kind).toBe('green');
    expect(at(4, four).kind).toBe('green');
    expect(at(5, four)).toEqual({ kind: 'red', bestSpotId: 'kommetjie-long-beach' });
    expect(at(3, [W(DATE, '07:00', '12:00', 3)]).kind).toBe('green');
    expect(day([res('kommetjie-long-beach', [W(DATE, '07:00', '12:00', 3)])]).kind).toBe('red');
  });
  it('the bar moves the dawn and dusk windows too, and never the epic flag', () => {
    expect(at(5, [W(DATE, '07:00', '09:00', 4)])).toEqual({ kind: 'red', bestSpotId: 'kommetjie-long-beach' });
    expect(at(3, [W(DATE, '07:00', '09:00', 3)])).toMatchObject({ kind: 'yellow' });
    // epic stays the shared scale's 6★, whatever the threshold is
    expect(at(3, [W(DATE, '07:00', '12:00', 6)])).toMatchObject({ kind: 'green', epic: true });
    expect(at(6, [W(DATE, '07:00', '12:00', 6)])).toMatchObject({ kind: 'green', epic: true });
  });
});

describe('weekday verdict', () => {
  it('🟢 when a good window (≥ 4★) bites ≥ 2 h into work hours', () => {
    const v = day([res('kommetjie-long-beach', [W(DATE, '07:00', '12:00', 5)])]);
    expect(v).toEqual({ kind: 'green', spotId: 'kommetjie-long-beach', window: W(DATE, '07:00', '12:00', 5), epic: false });
  });
  it('🌅 dawn when the good window sits before work', () => {
    const v = day([res('muizenberg', [W(DATE, '07:00', '09:00', 5)])]);
    expect(v).toEqual({ kind: 'yellow', dawn: { spotId: 'muizenberg', window: W(DATE, '07:00', '09:00', 5) }, dusk: undefined });
  });
  it('a light overflow into work hours does not disqualify dawn', () => {
    const v = day([res('muizenberg', [W(DATE, '07:00', '10:00', 5)])]);
    expect(v.kind).toBe('yellow');
    expect(primaryPick(v)?.window.end).toBe(`${DATE}T10:00`);
  });
  it('🌇 dusk when ≥ 1.5 h remain after work', () => {
    const v = day([res('glen-beach', [W(DATE, '16:00', '19:00', 4)])], { start: '09:00', end: '16:00' });
    expect(v).toEqual({ kind: 'yellow', dawn: undefined, dusk: { spotId: 'glen-beach', window: W(DATE, '16:00', '19:00', 4) } });
  });
  it('both dawn and dusk when both exist', () => {
    const v = day([res('a', [W(DATE, '07:00', '09:00', 4)]), res('b', [W(DATE, '16:00', '19:00', 5)])], { start: '09:00', end: '16:00' });
    expect(v).toEqual({ kind: 'yellow', dawn: { spotId: 'a', window: W(DATE, '07:00', '09:00', 4) }, dusk: { spotId: 'b', window: W(DATE, '16:00', '19:00', 5) } });
  });
  it('🟢 epic: peak ≥ 6★ for ≥ 1.5 h wins even before work', () => {
    const v = day([res('outer-kom', [W(DATE, '07:00', '09:00', 6)])]);
    expect(v).toEqual({ kind: 'green', spotId: 'outer-kom', window: W(DATE, '07:00', '09:00', 6), epic: true });
  });
  it('an epic hour that is too short is not enough', () => {
    const v = day([res('outer-kom', [W(DATE, '07:00', '08:00', 7)])], WORK);
    expect(v).toEqual({ kind: 'red', bestSpotId: 'outer-kom' });
  });
  it('🔴 with the best spot when nothing reaches 4★', () => {
    const v = day([res('a', [W(DATE, '07:00', '10:00', 3)], { maxScore: 3 }), res('b', [], { maxScore: 2 })]);
    expect(v).toEqual({ kind: 'red', bestSpotId: 'a' });
  });
  const spotDay = (spotId: string, distanceKm: number, scores: number[]): SpotResult => makeSpotDay(spotId, distanceKm, scores, DATE);

  it('🔴 two spots at the same stars: the one holding them for more hours wins, not the nearer one', () => {
    // The Hoek even has more hours at one star or better: hours at the higher level are weighed first.
    const v = day([spotDay('noordhoek', 13, [1, 2, 2, 1, 1, 1, 1, 1]), spotDay('kommetjie-long-beach', 15, [0, 2, 2, 2, 2, 2, 0, 0])]);
    expect(v).toEqual({ kind: 'red', bestSpotId: 'kommetjie-long-beach' });
  });
  it('🔴 same stars for as many hours: the one with more hours carrying at least one star wins', () => {
    const v = day([spotDay('short', 5, [0, 2, 2, 1, 0, 0]), spotDay('long', 9, [1, 2, 2, 1, 1, 1])]);
    expect(v).toEqual({ kind: 'red', bestSpotId: 'long' });
  });
  it('🔴 a perfect tie goes to the nearer spot, whatever the order they come in', () => {
    expect(day([spotDay('far', 9, [0, 2, 1]), spotDay('near', 5, [0, 2, 1])])).toEqual({ kind: 'red', bestSpotId: 'near' });
    expect(day([spotDay('near', 5, [0, 2, 1]), spotDay('far', 9, [0, 2, 1])])).toEqual({ kind: 'red', bestSpotId: 'near' });
  });
  it('🔴 a flat day (0★ everywhere) goes to the nearer spot — not to the one with more hours evaluated', () => {
    const v = day([spotDay('far', 20, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), spotDay('near', 5, [0, 0, 0, 0])]);
    expect(v).toEqual({ kind: 'red', bestSpotId: 'near' });
  });
  it('a 3★ window is surfable but not worth skipping work: 🔴', () => {
    expect(day([res('a', [W(DATE, '07:00', '12:00', 3)])]).kind).toBe('red');
  });
  it('ranks candidates by peak, then duration, then distance', () => {
    const tieByDistance = day([
      res('far', [W(DATE, '07:00', '12:00', 5)], { distanceKm: 15 }),
      res('near', [W(DATE, '07:00', '12:00', 5)], { distanceKm: 5 }),
    ]);
    expect(primaryPick(tieByDistance)?.spotId).toBe('near');
    const longerWins = day([
      res('long', [W(DATE, '07:00', '13:00', 5)], { distanceKm: 15 }),
      res('near', [W(DATE, '07:00', '12:00', 5)], { distanceKm: 5 }),
    ]);
    expect(primaryPick(longerWins)?.spotId).toBe('long');
  });
});

describe('weekend and /now rule', () => {
  it('🟢 on Saturday with any good window ≥ 1.5 h, never 🟡', () => {
    const v = decideVerdict([res('muizenberg', [W(SAT, '07:00', '09:00', 4)])], { date: SAT, workHours: WORK, mode: 'day' });
    expect(v).toEqual({ kind: 'green', spotId: 'muizenberg', window: W(SAT, '07:00', '09:00', 4), epic: false });
  });
  it('🔴 on Saturday when the good window is too short', () => {
    const v = decideVerdict([res('muizenberg', [W(SAT, '07:00', '08:00', 5)])], { date: SAT, workHours: WORK, mode: 'day' });
    expect(v).toEqual({ kind: 'red', bestSpotId: 'muizenberg' });
  });
  it('/now on a weekday uses the weekend rule', () => {
    const v = decideVerdict([res('muizenberg', [W(DATE, '07:00', '09:00', 4)])], { date: DATE, workHours: WORK, mode: 'now' });
    expect(v.kind).toBe('green');
  });
});

describe('primaryPick', () => {
  it('returns the green spot, the dawn (then dusk) pick, or nothing', () => {
    expect(primaryPick({ kind: 'green', spotId: 'a', window: W(DATE, '07:00', '09:00', 5), epic: false })?.spotId).toBe('a');
    expect(primaryPick({ kind: 'yellow', dusk: { spotId: 'b', window: W(DATE, '16:00', '19:00', 5) } })?.spotId).toBe('b');
    expect(primaryPick({ kind: 'red' })).toBeUndefined();
    expect(primaryPick({ kind: 'noData', reason: 'x' })).toBeUndefined();
  });
});
