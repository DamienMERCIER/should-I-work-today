import { describe, it, expect } from 'vitest';
import { buildReports, buildReport, nearbySpots, nearestSpots } from '../../src/jobs/collect';
import { SPOTS, REGIONS } from '../../src/data/index';
import type { Profile } from '../../src/types';
import { fakeFetch } from '../helpers/fakeFetch';
import { openMeteoServer } from '../helpers/openMeteoServer';
import { GOLDEN_DAILY, GOLDEN_DATE, GOLDEN_SPOTS, goldenSwell, goldenWind } from '../helpers/golden';

const profile = (over: Partial<Profile> = {}): Profile => ({
  chatId: 1, lang: 'en', level: 'intermediate', board: 'shortboard', workHours: { start: '09:00', end: '18:00' },
  location: { lat: -34.1085, lon: 18.4715, source: 'default' }, active: true, createdAt: '2026-09-15T19:00', ...over,
});
const server = (over: Partial<Parameters<typeof openMeteoServer>[0]> = {}) =>
  fakeFetch(openMeteoServer({ swell: goldenSwell(), wind: goldenWind(), daily: GOLDEN_DAILY, ...over }));
const deps = (fetchFn: ReturnType<typeof fakeFetch>['fn'], spots = GOLDEN_SPOTS) => ({ spots, regions: REGIONS, fetchFn, now: '2026-09-15T19:00' });

describe('geo helpers', () => {
  it('nearbySpots sorts by distance within the radius', () => {
    const near = nearbySpots(SPOTS, { lat: -34.1085, lon: 18.4715 }, 20);
    expect(near[0].spot.id).toBe('muizenberg');
    expect(near).toHaveLength(11);
  });
  it('nearestSpots returns the 3 closest anywhere', () => {
    const ids = nearestSpots(SPOTS, { lat: -33.9, lon: 18.87 }).map((x) => x.spot.id);
    expect(ids[0]).toBe('strand');
    expect(ids).toHaveLength(3);
  });
});

describe('buildReports', () => {
  it('golden: 2 calls for one region, 🟢 Kommetjie 07:00→12:00', async () => {
    const { fn, calls } = server();
    const reports = await buildReports([{ profile: profile(), date: GOLDEN_DATE, mode: 'evening' }], deps(fn));
    const r = reports.get(1)!;
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.url.includes('marine-api'))!.url).toContain('latitude=-34.5000');
    expect(calls.find((c) => c.url.includes('/v1/forecast'))!.url).toContain('latitude=-34.1085%2C-34.1330');
    expect(r.verdict).toMatchObject({ kind: 'green', spotId: 'kommetjie-long-beach', window: { start: `${GOLDEN_DATE}T07:00`, end: `${GOLDEN_DATE}T12:00`, peak: 8.6 } });
    expect(r.spots.map((s) => s.spotId)).toEqual(['muizenberg', 'kommetjie-long-beach']);
    expect(r.tides.map((t) => t.time)).toEqual([`${GOLDEN_DATE}T03:00`, `${GOLDEN_DATE}T09:00`, `${GOLDEN_DATE}T15:00`, `${GOLDEN_DATE}T21:00`]);
    expect(r.sun).toEqual({ sunrise: `${GOLDEN_DATE}T06:44`, sunset: `${GOLDEN_DATE}T18:38` });
    expect(r.weather).toEqual({ tempMaxC: 22, tempMinC: 14, precipMm: 0, code: 1 });
    expect(r.generatedAt).toBe('2026-09-15T19:00');
    expect(r.mode).toBe('evening');
  });
  it('shares the region calls between two profiles at the same place', async () => {
    const { fn, calls } = server();
    const reports = await buildReports(
      [{ profile: profile(), date: GOLDEN_DATE, mode: 'evening' }, { profile: profile({ chatId: 2, level: 'advanced' }), date: GOLDEN_DATE, mode: 'evening' }],
      deps(fn),
    );
    expect(calls).toHaveLength(2);
    expect(reports.size).toBe(2);
  });
  it('now mode truncates from fromTime', async () => {
    const { fn } = server();
    const r = await buildReport({ profile: profile(), date: GOLDEN_DATE, mode: 'now', fromTime: `${GOLDEN_DATE}T10:00` }, deps(fn));
    expect(r.mode).toBe('now');
    expect(r.verdict).toMatchObject({ kind: 'green', window: { start: `${GOLDEN_DATE}T10:00`, end: `${GOLDEN_DATE}T12:00` } });
  });
  it('out of coverage near the coast: raw conditions at the user position, 3 nearest spots', async () => {
    const { fn, calls } = server();
    const r = await buildReport({ profile: profile({ location: { lat: -33.9, lon: 18.87, source: 'custom' } }), date: GOLDEN_DATE, mode: 'evening' }, deps(fn, SPOTS));
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.url.includes('marine-api'))!.url).toContain('latitude=-33.9000');
    expect(r.verdict).toMatchObject({
      kind: 'outOfCoverage',
      raw: { swellHeightM: 2.0, periodS: 10.2, swellDirDeg: 225, windKt: 8, windDirDeg: 120 },
    });
    expect((r.verdict as { nearest: { spotId: string }[] }).nearest[0].spotId).toBe('strand');
    expect(r.spots).toEqual([]);
  });
  it('far from the coast: no call, no raw', async () => {
    const { fn, calls } = server();
    const r = await buildReport({ profile: profile({ location: { lat: -26.2, lon: 28.04, source: 'custom' } }), date: GOLDEN_DATE, mode: 'evening' }, deps(fn, SPOTS));
    expect(calls).toHaveLength(0);
    expect(r.verdict).toMatchObject({ kind: 'outOfCoverage', raw: undefined });
    expect((r.verdict as { nearest: { distanceKm: number }[] }).nearest[0].distanceKm).toBeGreaterThan(150);
  });
  it('Open-Meteo failure → noData with the reason', async () => {
    const { fn } = server({ failMarine: true });
    const r = await buildReport({ profile: profile(), date: GOLDEN_DATE, mode: 'evening' }, deps(fn));
    expect(r.verdict).toMatchObject({ kind: 'noData' });
    expect((r.verdict as { reason: string }).reason).toMatch(/HTTP 500/);
    expect(r.spots).toEqual([]);
  });
  it('a date outside the fetched window yields noData, never another day\'s data', async () => {
    const { fn } = server();
    const r = await buildReport({ profile: profile(), date: '2026-09-20', mode: 'evening' }, deps(fn));
    expect(r.verdict).toMatchObject({ kind: 'noData' });
    expect((r.verdict as { reason: string }).reason).toContain('no daily forecast for 2026-09-20');
    expect(r.spots).toEqual([]);
  });
  it('an engine exception yields noData for that profile only, never a crashed run', async () => {
    // sunrise null passes the column check but makes the daylight factor throw
    const daily = GOLDEN_DAILY.map((d) => ({ ...d, sunrise: null as unknown as string }));
    const { fn } = server({ daily });
    const reports = await buildReports(
      [{ profile: profile(), date: GOLDEN_DATE, mode: 'evening' }, { profile: profile({ chatId: 5, location: { lat: -26.2, lon: 28.04, source: 'custom' } }), date: GOLDEN_DATE, mode: 'evening' }],
      deps(fn, SPOTS),
    );
    expect(reports.get(1)!.verdict).toMatchObject({ kind: 'noData' });
    expect((reports.get(1)!.verdict as { reason: string }).reason).toMatch(/^engine: /);
    expect(reports.get(5)!.verdict.kind).toBe('outOfCoverage');
  });
  it('forecast failure alone is also noData (no verdict without wind)', async () => {
    const { fn } = server({ failForecast: true });
    const r = await buildReport({ profile: profile(), date: GOLDEN_DATE, mode: 'evening' }, deps(fn));
    expect(r.verdict).toMatchObject({ kind: 'noData' });
    expect((r.verdict as { reason: string }).reason).toMatch(/HTTP 500/);
  });
});
