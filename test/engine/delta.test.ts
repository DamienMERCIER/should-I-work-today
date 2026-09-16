import { describe, it, expect } from 'vitest';
import { compareReports, hasChanged, findCause, isActionable } from '../../src/engine/delta';
import type { Report, SpotResult, Verdict, Window } from '../../src/types';
import { DATE, makeHour, makeReport } from '../helpers/reports';

const W = (s: string, e: string, peak: number): Window => ({ start: `${DATE}T${s}`, end: `${DATE}T${e}`, peak, mean: peak });
const green = (spotId: string, w: Window): Verdict => ({ kind: 'green', spotId, window: w, epic: false });
const spot = (spotId: string, hours: SpotResult['hours'], windows: Window[] = []): SpotResult => ({
  spotId, distanceKm: 10, hours, windows, best: windows[0], maxScore: Math.max(0, ...hours.map((h) => h.score)),
});
const eveningKom = (windAt9 = 1) => makeReport({
  verdict: green('kom', W('07:00', '12:00', 5)),
  // le pic du soir est 09:00 (5★ = base 5 × vent 1) sans ambiguïté : c'est l'heure que findCause compare
  spots: [spot('kom', [makeHour(`${DATE}T07:00`, 4, { swell: 0.5, wind: 0.8 }), makeHour(`${DATE}T09:00`, 5, { swell: 0.5, wind: windAt9 }), makeHour(`${DATE}T11:00`, 4, { swell: 0.5, wind: 0.8 })], [W('07:00', '12:00', 5)])],
});
const morning = (verdict: Verdict, spots: SpotResult[] = []): Report => makeReport({ mode: 'morning', verdict, spots });

describe('isActionable', () => {
  it('is true for green and yellow only', () => {
    expect(isActionable({ kind: 'green', spotId: 'a', window: W('07:00', '09:00', 5), epic: false })).toBe(true);
    expect(isActionable({ kind: 'yellow' })).toBe(true);
    expect(isActionable({ kind: 'red' })).toBe(false);
    expect(isActionable({ kind: 'noData', reason: 'x' })).toBe(false);
    expect(isActionable(undefined)).toBe(false);
  });
});

describe('compareReports', () => {
  it('🔴 → 🔴 is silent', () => {
    expect(compareReports(makeReport({}), morning({ kind: 'red' }))).toEqual({ send: false, changed: false });
  });
  it('🟢 → same 🟢 is confirmed', () => {
    const m = morning(green('kom', W('07:00', '12:00', 5)), [spot('kom', [makeHour(`${DATE}T09:00`, 5)])]);
    expect(compareReports(eveningKom(), m)).toEqual({ send: true, changed: false });
  });
  it('a window shifted by ≥ 1 h is a change, with the factor that moved most as cause', () => {
    // vent seul : 5 × 0,5 = 2,5 (−2,5★) ; houle seule : 4,5 × 1 (−0,5★)
    const m = morning(green('kom', W('07:00', '11:00', 4)), [spot('kom', [makeHour(`${DATE}T09:00`, 2, { wind: 0.5, swell: 0.45 })])]);
    expect(compareReports(eveningKom(), m)).toEqual({ send: true, changed: true, cause: 'wind' });
  });
  it('🟢 → 🌅 is a change; the cause must be a decrease', () => {
    // la houle monte (+1★) mais le verdict se dégrade : seule une baisse peut l'expliquer, donc le vent (−2★)
    const m = morning({ kind: 'yellow', dawn: { spotId: 'muizenberg', window: W('07:00', '09:00', 4) } }, [
      spot('kom', [makeHour(`${DATE}T09:00`, 4, { wind: 0.6, swell: 0.6 })]),
    ]);
    expect(compareReports(eveningKom(), m)).toEqual({ send: true, changed: true, cause: 'wind' });
  });
  it('🔴 → 🟢 is sent and changed, without a cause (no evening pick)', () => {
    const m = morning(green('kom', W('07:00', '12:00', 4)), [spot('kom', [makeHour(`${DATE}T09:00`, 4)])]);
    expect(compareReports(makeReport({ verdict: { kind: 'red', bestSpotId: 'kom' } }), m)).toEqual({ send: true, changed: true });
  });
  it('no evening report counts as 🔴', () => {
    const m = morning(green('kom', W('07:00', '12:00', 4)));
    expect(compareReports(undefined, m)).toEqual({ send: true, changed: true });
    expect(compareReports(undefined, morning({ kind: 'red' }))).toEqual({ send: false, changed: false });
  });
  it('morning noData after an actionable evening is sent as unchanged', () => {
    expect(compareReports(eveningKom(), morning({ kind: 'noData', reason: 'marine 500' }))).toEqual({ send: true, changed: false });
  });
  it('🟡 → 🟡 with another dawn spot is a change', () => {
    const e = makeReport({ verdict: { kind: 'yellow', dawn: { spotId: 'a', window: W('07:00', '09:00', 4) } } });
    const m = morning({ kind: 'yellow', dawn: { spotId: 'b', window: W('07:00', '09:00', 4) } });
    expect(hasChanged(e.verdict, m.verdict)).toBe(true);
  });
  it('weighs each change in stars: a smaller swell that costs 1.5★ beats a stronger wind that costs 0.9★', () => {
    // soir 3,2 m offshore 10 kt (5★) ; matin 2,3 m et offshore 18 kt (3★). Houle seule : 5,35 → 3,88 (−1,5★) ;
    // vent seul : ×1 → ×0,83 (−0,9★). En facteurs bruts, le vent bougeait plus (0,17 contre 0,15).
    const e = makeReport({
      verdict: green('kom', W('07:00', '12:00', 5)),
      spots: [spot('kom', [makeHour(`${DATE}T09:00`, 5, { swell: 0.535, wind: 1 })], [W('07:00', '12:00', 5)])],
    });
    const m = morning({ kind: 'red', bestSpotId: 'kom' }, [spot('kom', [makeHour(`${DATE}T09:00`, 3, { swell: 0.388, wind: 0.833 })])]);
    expect(findCause(e, m)).toBe('size');
  });
  it('a swell drop is reported as a size cause — the only other thing stars depend on', () => {
    const m = morning({ kind: 'red', bestSpotId: 'kom' }, [spot('kom', [makeHour(`${DATE}T09:00`, 2, { swell: 0.2, wind: 1 })])]);
    expect(compareReports(eveningKom(), m)).toEqual({ send: true, changed: true, cause: 'size' });
  });
  it('a change worth less than one star yields no cause', () => {
    // 5 × 0,9 = 4,5 : un demi-point, pas une étoile
    const m = morning(green('kom', W('08:00', '12:00', 4)), [spot('kom', [makeHour(`${DATE}T09:00`, 4, { swell: 0.5, wind: 0.9 })])]);
    expect(findCause(eveningKom(), m)).toBeUndefined();
  });
});
