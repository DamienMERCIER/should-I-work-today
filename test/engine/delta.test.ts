import { describe, it, expect } from 'vitest';
import { compareReports, hasChanged, findCause, isActionable } from '../../src/engine/delta';
import type { Report, SpotResult, Verdict, Window } from '../../src/types';
import { DATE, makeHour, makeReport } from '../helpers/reports';

const W = (s: string, e: string, peak: number): Window => ({ start: `${DATE}T${s}`, end: `${DATE}T${e}`, peak, mean: peak });
const green = (spotId: string, w: Window): Verdict => ({ kind: 'green', spotId, window: w, epic: false });
const spot = (spotId: string, hours: SpotResult['hours'], windows: Window[] = []): SpotResult => ({
  spotId, distanceKm: 10, open: true, hours, windows, best: windows[0], maxScore: Math.max(0, ...hours.map((h) => h.score)),
});
const eveningKom = (windAt9 = 1) => makeReport({
  verdict: green('kom', W('07:00', '12:00', 8.6)),
  // le pic du soir est 09:00 (8.6) sans ambiguïté : c'est l'heure que findCause compare
  spots: [spot('kom', [makeHour(`${DATE}T07:00`, 8.4), makeHour(`${DATE}T09:00`, 8.6, { wind: windAt9 }), makeHour(`${DATE}T11:00`, 7.1)], [W('07:00', '12:00', 8.6)])],
});
const morning = (verdict: Verdict, spots: SpotResult[] = []): Report => makeReport({ mode: 'morning', verdict, spots });

describe('isActionable', () => {
  it('is true for green and yellow only', () => {
    expect(isActionable({ kind: 'green', spotId: 'a', window: W('07:00', '09:00', 8), epic: false })).toBe(true);
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
    const m = morning(green('kom', W('07:00', '12:00', 8.4)), [spot('kom', [makeHour(`${DATE}T09:00`, 8.4)])]);
    expect(compareReports(eveningKom(), m)).toEqual({ send: true, changed: false });
  });
  it('a window shifted by ≥ 1 h is a change, with the factor that moved most as cause', () => {
    const m = morning(green('kom', W('07:00', '11:00', 8.0)), [spot('kom', [makeHour(`${DATE}T09:00`, 8.0, { wind: 0.5, size: 0.95 })])]);
    expect(compareReports(eveningKom(), m)).toEqual({ send: true, changed: true, cause: 'wind' });
  });
  it('🟢 → 🌅 is a change; the cause must be a decrease', () => {
    const m = morning({ kind: 'yellow', dawn: { spotId: 'muizenberg', window: W('07:00', '09:00', 7.2) } }, [
      spot('kom', [makeHour(`${DATE}T09:00`, 5.1, { wind: 0.6, size: 1.2 })]),
    ]);
    expect(compareReports(eveningKom(), m)).toEqual({ send: true, changed: true, cause: 'wind' });
  });
  it('🔴 → 🟢 is sent and changed, without a cause (no evening pick)', () => {
    const m = morning(green('kom', W('07:00', '12:00', 8.0)), [spot('kom', [makeHour(`${DATE}T09:00`, 8.0)])]);
    expect(compareReports(makeReport({ verdict: { kind: 'red', bestSpotId: 'kom' } }), m)).toEqual({ send: true, changed: true });
  });
  it('no evening report counts as 🔴', () => {
    const m = morning(green('kom', W('07:00', '12:00', 8.0)));
    expect(compareReports(undefined, m)).toEqual({ send: true, changed: true });
    expect(compareReports(undefined, morning({ kind: 'red' }))).toEqual({ send: false, changed: false });
  });
  it('morning noData after an actionable evening is sent as unchanged', () => {
    expect(compareReports(eveningKom(), morning({ kind: 'noData', reason: 'marine 500' }))).toEqual({ send: true, changed: false });
  });
  it('🟡 → 🟡 with another dawn spot is a change', () => {
    const e = makeReport({ verdict: { kind: 'yellow', dawn: { spotId: 'a', window: W('07:00', '09:00', 7.5) } } });
    const m = morning({ kind: 'yellow', dawn: { spotId: 'b', window: W('07:00', '09:00', 7.5) } });
    expect(hasChanged(e.verdict, m.verdict)).toBe(true);
  });
  it('a factor change below 0.15 yields no cause', () => {
    const m = morning(green('kom', W('08:00', '12:00', 8.0)), [spot('kom', [makeHour(`${DATE}T09:00`, 8.0, { wind: 0.9 })])]);
    expect(findCause(eveningKom(), m)).toBeUndefined();
  });
});
