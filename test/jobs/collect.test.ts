import { describe, it, expect, vi } from 'vitest';
import { buildReports, buildReport, mergePeakPeriod, nearbySpots, nearestSpots } from '../../src/jobs/collect';
import { SPOTS, REGIONS } from '../../src/data/index';
import type { SpotTuple } from '../../src/data/world';
import type { Profile, SwellHour } from '../../src/types';
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
    expect(near).toHaveLength(15);
  });
  it('nearestSpots returns the 3 closest anywhere', () => {
    const ids = nearestSpots(SPOTS, { lat: -33.9, lon: 18.87 }).map((x) => x.spot.id);
    expect(ids[0]).toBe('strand');
    expect(ids).toHaveLength(3);
  });
});

describe('nearbySpots / nearestSpots — world set wiring (§report "Resilience, wiring and dedupe")', () => {
  const MUIZ = SPOTS.find((s) => s.id === 'muizenberg')!;

  it('nearbySpots merges in a world spot that is within the radius, alongside curated', () => {
    const worldTuple: SpotTuple = ['World Twin', 'World Twin', MUIZ.lat, MUIZ.lon, 150, 0];
    const near = nearbySpots(SPOTS, { lat: MUIZ.lat, lon: MUIZ.lon }, 20, [worldTuple]);
    expect(near.some((x) => x.spot.id === MUIZ.id)).toBe(true);
    expect(near.some((x) => x.spot.name === 'World Twin')).toBe(true);
  });

  it('curated wins a tie: at the exact same distance, the curated spot sorts before the world spot', () => {
    const worldTuple: SpotTuple = ['World Twin', 'World Twin', MUIZ.lat, MUIZ.lon, 150, 0];
    const near = nearbySpots(SPOTS, { lat: MUIZ.lat, lon: MUIZ.lon }, 5, [worldTuple]);
    const tied = near.filter((x) => x.distanceKm === 0);
    expect(tied.map((x) => x.spot.name)).toEqual([MUIZ.name, 'World Twin']);
  });

  it('a world spot outside the radius is excluded, exactly like a curated one would be', () => {
    const farTuple: SpotTuple = ['Far World', 'Far World', MUIZ.lat + 5, MUIZ.lon, 150, 0]; // ~555 km away
    const near = nearbySpots(SPOTS, { lat: MUIZ.lat, lon: MUIZ.lon }, 20, [farTuple]);
    expect(near.some((x) => x.spot.name === 'Far World')).toBe(false);
  });

  it('nearestSpots merges the world set too — a world spot can headline the list when it is genuinely the closest', () => {
    const at = { lat: 40.7128, lon: -74.006 }; // New York — nothing curated (South Africa) is remotely close
    const worldTuple: SpotTuple = ['NYC Break', 'NYC Break', at.lat, at.lon, 150, 0];
    const nearest = nearestSpots(SPOTS, at, 3, [worldTuple]);
    expect(nearest[0].spot.name).toBe('NYC Break');
    expect(nearest[0].distanceKm).toBeCloseTo(0, 3);
    expect(nearest).toHaveLength(3);
  });

  it('an empty world set (matching the current placeholder spots-world.json) leaves nearbySpots/nearestSpots unchanged from curated-only behaviour', () => {
    const at = { lat: -34.1085, lon: 18.4715 };
    expect(nearbySpots(SPOTS, at, 20)).toEqual(nearbySpots(SPOTS, at, 20, []));
    expect(nearbySpots(SPOTS, at, 20)).toHaveLength(15);
    const farAt = { lat: -33.9, lon: 18.87 };
    expect(nearestSpots(SPOTS, farAt)).toEqual(nearestSpots(SPOTS, farAt, 3, []));
  });

  it('end-to-end: nearbySpots against curated + an 8000-entry synthetic world set (long UTF-8 names) stays comfortably under the 10 ms Worker CPU budget', () => {
    const at = { lat: -34.1085, lon: 18.4715 };
    const longNames = ['Praia do Guincho – Norte', 'Île de Ré, Pointe du Grouin', 'São Conrado – Barra da Tijuca', 'Işıklar Plajı Sahili', 'Кабардинка – Центральный пляж'];
    const tuples: SpotTuple[] = Array.from({ length: 8000 }, (_, i) => {
      const name = `${longNames[i % longNames.length]} #${i}`;
      return [name, name.slice(0, 11), -80 + ((i * 37) % 160), -180 + ((i * 71) % 360), (i * 13) % 360, i % 4];
    });

    // On mesure la médiane à chaud : le premier appel paie le JIT et la charge de la machine,
    // ce qui faisait échouer un seuil absolu à 5 ms sans rien dire du coût réel par invocation.
    const timings: number[] = [];
    for (let i = 0; i < 11; i++) {
      const t0 = performance.now();
      nearbySpots(SPOTS, at, 20, tuples);
      timings.push(performance.now() - t0);
    }
    const median = timings.sort((a, b) => a - b)[5];
    const near = nearbySpots(SPOTS, at, 20, tuples);

    expect(median).toBeLessThan(5); // budget CPU du Worker : 10 ms pour l'invocation entière
    expect(near.length).toBeGreaterThanOrEqual(15); // still finds at least the 15 curated matches (§ "geo helpers" above)
  });
});

describe('buildReports', () => {
  it('golden: 3 calls for one region (marine + forecast + peak period), 🟢 Kommetjie 07:00→12:00', async () => {
    const { fn, calls } = server();
    const reports = await buildReports([{ profile: profile(), date: GOLDEN_DATE, mode: 'evening' }], deps(fn));
    const r = reports.get(1)!;
    expect(calls).toHaveLength(3);
    expect(calls.find((c) => c.url.includes('marine-api'))!.url).toContain('latitude=-34.5000');
    expect(calls.find((c) => c.url.includes('/v1/forecast'))!.url).toContain('latitude=-34.1085%2C-34.1330');
    expect(r.verdict).toMatchObject({ kind: 'green', spotId: 'kommetjie-long-beach', window: { start: `${GOLDEN_DATE}T07:00`, end: `${GOLDEN_DATE}T12:00`, peak: 10.0 } });
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
    expect(calls).toHaveLength(3);
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
  it('a region whose peak-period call 500s still produces a normal verdict (mean-period fallback, not noData)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { fn, calls } = server({ failPeak: true });
      const r = await buildReport({ profile: profile(), date: GOLDEN_DATE, mode: 'evening' }, deps(fn));
      expect(calls).toHaveLength(3);
      // repli sur la période moyenne (10.2 s) : mêmes chiffres que l'ancien comportement, pic 8.6 (pas 10.0).
      expect(r.verdict).toMatchObject({ kind: 'green', spotId: 'kommetjie-long-beach', window: { peak: 8.6 } });
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(String(warnSpy.mock.calls[0][0])).toContain('peak period');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('mergePeakPeriod', () => {
  const h = (time: string): SwellHour => ({ time, primary: { heightM: 2, periodS: 10.2, directionDeg: 225 }, secondary: { heightM: 0, periodS: 0, directionDeg: 0 }, seaLevelM: 0 });

  it('merges by timestamp, not by array index — series can differ in length and order', () => {
    const swell = [h('T1'), h('T2'), h('T3')];
    const peak = [{ time: 'T3', peakPeriodS: 13 }]; // single entry, index 0, but belongs to swell[2]
    const merged = mergePeakPeriod(swell, peak);
    expect(merged[0].peakPeriodS).toBeUndefined();
    expect(merged[1].peakPeriodS).toBeUndefined();
    expect(merged[2].peakPeriodS).toBe(13);
  });
  it('leaves peakPeriodS unset (not 0) when the peak value is null', () => {
    const merged = mergePeakPeriod([h('T1')], [{ time: 'T1', peakPeriodS: null }]);
    expect(merged[0].peakPeriodS).toBeUndefined();
  });
  it('ignores a peak entry with no matching timestamp in the swell series', () => {
    const merged = mergePeakPeriod([h('T1')], [{ time: 'T9', peakPeriodS: 13 }]);
    expect(merged[0].peakPeriodS).toBeUndefined();
  });
  it('does not mutate the original swell hours', () => {
    const original = h('T1');
    mergePeakPeriod([original], [{ time: 'T1', peakPeriodS: 13 }]);
    expect(original.peakPeriodS).toBeUndefined();
  });
});
