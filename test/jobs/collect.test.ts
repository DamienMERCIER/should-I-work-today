import { describe, it, expect, vi } from 'vitest';
import { buildReportList, buildReports, buildReport, buildWeek, mergePeakPeriod, nearbySpots, nearestSpots, spotSwellSeries } from '../../src/jobs/collect';
import { SPOTS, REGIONS } from '../../src/data/index';
import type { SpotTuple } from '../../src/data/world';
import { addDays, addHours } from '../../src/engine/time';
import type { Profile, Report, SwellHour } from '../../src/types';
import { fakeFetch, jsonResponse } from '../helpers/fakeFetch';
import { forecastJson, marineJson, openMeteoServer, peakJson } from '../helpers/openMeteoServer';
import { GOLDEN_DAILY, GOLDEN_DATE, GOLDEN_SPOTS, goldenSwell, goldenWind, weekData } from '../helpers/golden';

const profile = (over: Partial<Profile> = {}): Profile => ({
  chatId: 1, lang: 'en', workHours: { start: '09:00', end: '18:00' },
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

  it('with no world set, nearbySpots/nearestSpots are the curated spots alone', () => {
    const at = { lat: -34.1085, lon: 18.4715 };
    const near = nearbySpots(SPOTS, at, 20, []);
    expect(near).toHaveLength(15);
    expect(near.every((n) => SPOTS.includes(n.spot))).toBe(true);
    const farAt = { lat: -33.9, lon: 18.87 };
    const nearest = nearestSpots(SPOTS, farAt, 3, []);
    expect(nearest).toHaveLength(3);
    expect(nearest.every((n) => SPOTS.includes(n.spot))).toBe(true);
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
    // la houle au point régional (marée) ET à la cellule de chaque spot (étoiles), dans le même appel
    expect(calls.find((c) => c.url.includes('marine-api') && !c.url.includes('peak'))!.url).toContain('latitude=-34.5000%2C-34.1085%2C-34.1330');
    expect(calls.find((c) => c.url.includes('/v1/forecast'))!.url).toContain('latitude=-34.1085%2C-34.1330');
    expect(r.verdict).toMatchObject({ kind: 'green', spotId: 'kommetjie-long-beach', window: { start: `${GOLDEN_DATE}T07:00`, end: `${GOLDEN_DATE}T12:00`, peak: 6 } });
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
      [{ profile: profile(), date: GOLDEN_DATE, mode: 'evening' }, { profile: profile({ chatId: 2 }), date: GOLDEN_DATE, mode: 'evening' }],
      deps(fn),
    );
    expect(calls).toHaveLength(3);
    expect(reports.size).toBe(2);
  });
  it('now mode truncates from fromTime', async () => {
    const { fn } = server();
    const r = await buildReport({ profile: profile(), date: GOLDEN_DATE, mode: 'now', fromTime: `${GOLDEN_DATE}T08:00` }, deps(fn));
    expect(r.mode).toBe('now');
    expect(r.verdict).toMatchObject({ kind: 'green', window: { start: `${GOLDEN_DATE}T08:00`, end: `${GOLDEN_DATE}T12:00` } });
  });
  it('out of coverage near the coast: raw conditions at the user position, 3 nearest spots', async () => {
    const { fn, calls } = server();
    const r = await buildReport({ profile: profile({ location: { lat: -33.9, lon: 18.87, source: 'custom' } }), date: GOLDEN_DATE, mode: 'evening' }, deps(fn, SPOTS));
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.url.includes('marine-api'))!.url).toContain('latitude=-33.9000');
    expect(r.verdict).toMatchObject({
      kind: 'outOfCoverage',
      raw: { swellHeightM: 3.5, periodS: 10.2, swellDirDeg: 225, windKt: 8, windDirDeg: 120 },
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
      // les étoiles ne dépendent pas de la période : la panne ne change que la période affichée, repliée
      // sur la période moyenne (10,2 s au lieu de 13 s)
      expect(r.verdict).toMatchObject({ kind: 'green', spotId: 'kommetjie-long-beach', window: { peak: 6 } });
      expect(r.spots.find((s) => s.spotId === 'kommetjie-long-beach')!.hours[0].periodS).toBe(10.2);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(String(warnSpy.mock.calls[0][0])).toContain('peak period');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('buildReportList — several dates per profile (week ahead)', () => {
  const kom = (r: Report) => r.spots.find((s) => s.spotId === 'kommetjie-long-beach')!;

  it('returns one report per request, in request order, loading each region once for every date', async () => {
    // mer 16 → mar 22 : 3,5 / 2,3 / 1,2 / 0,2 m, puis on recommence
    const { fn, calls } = fakeFetch(openMeteoServer(weekData(GOLDEN_DATE, 9, (i) => [3.5, 2.3, 1.2, 0.2][i % 4])));
    const dates = Array.from({ length: 7 }, (_, i) => addDays(GOLDEN_DATE, i));
    const reports = await buildReportList(dates.map((date) => ({ profile: profile(), date, mode: 'evening' as const })), deps(fn), { forecastDays: 8 });
    expect(reports.map((r) => r.date)).toEqual(dates);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.url.includes('forecast_days=8'))).toBe(true);
    // 6★ et 4★ font un 🟢 (le dimanche aussi, règle du week-end) ; 3★ et 0★ restent 🔴
    expect(reports.map((r) => r.verdict.kind)).toEqual(['green', 'green', 'red', 'red', 'green', 'green', 'red']);
    expect(reports.map((r) => kom(r).maxScore)).toEqual([6, 4, 3, 0, 6, 4, 3]);
  });

  it('evaluates a spot once per date for friends at the same place, each keeping their own distance', async () => {
    const { fn } = fakeFetch(openMeteoServer(weekData()));
    const [a, b] = await buildReportList([
      { profile: profile({ chatId: 1 }), date: GOLDEN_DATE, mode: 'evening' },
      { profile: profile({ chatId: 2, location: { lat: -34.12, lon: 18.46, source: 'custom' } }), date: GOLDEN_DATE, mode: 'evening' },
    ], deps(fn));
    // les étoiles ne dépendent plus du profil : même évaluation, pas une seconde passe CPU
    expect(kom(b).hours).toBe(kom(a).hours);
    expect(kom(b).distanceKm).not.toBe(kom(a).distanceKm);
  });

  it('never shares an evaluation across different start hours', async () => {
    const { fn } = fakeFetch(openMeteoServer(weekData()));
    const [whole, rest] = await buildReportList([
      { profile: profile({ chatId: 1 }), date: GOLDEN_DATE, mode: 'evening' },
      { profile: profile({ chatId: 2 }), date: GOLDEN_DATE, mode: 'now', fromTime: `${GOLDEN_DATE}T12:00` },
    ], deps(fn));
    expect(kom(rest).hours[0].time).toBe(`${GOLDEN_DATE}T12:00`);
    expect(kom(whole).hours[0].time).toBe(`${GOLDEN_DATE}T00:00`);
  });

  it('buildWeek starts tomorrow when today has no usable data, and still returns seven days', async () => {
    const data = weekData(GOLDEN_DATE, 10);
    // pas de lever/coucher pour aujourd'hui : le rapport du jour est noData, sans spot évalué
    const { fn } = fakeFetch(openMeteoServer({ ...data, daily: data.daily.filter((d) => d.date !== GOLDEN_DATE) }));
    const week = await buildWeek(profile(), { ...deps(fn), now: `${GOLDEN_DATE}T08:30` });
    expect(week.map((r) => r.date)).toEqual(Array.from({ length: 7 }, (_, i) => addDays(GOLDEN_DATE, i + 1)));
  });

  it('buildReports keeps the daily runs lean: 3 days of swell, 2 of wind, 3 of peak period', async () => {
    const { fn, calls } = server();
    await buildReports([{ profile: profile(), date: GOLDEN_DATE, mode: 'evening' }], deps(fn));
    expect(calls.find((c) => c.url.includes('marine-api') && !c.url.includes('peak'))!.url).toContain('forecast_days=3');
    expect(calls.find((c) => c.url.includes('/v1/forecast'))!.url).toContain('forecast_days=2');
    expect(calls.find((c) => c.url.includes('swell_wave_peak_period'))!.url).toContain('forecast_days=3');
  });
});

describe('swell at the spot cell (§ RAPPORT-surf-forecast.md 1.2)', () => {
  const series = (heightM: number, seaLevel = (h: SwellHour) => h.seaLevelM): SwellHour[] =>
    goldenSwell().map((h) => ({ ...h, primary: { ...h.primary, heightM }, seaLevelM: seaLevel(h), peakPeriodS: undefined }));
  // marée des cellules de spots décalée de 3 h : si la marée venait d'un spot, ses pleines et basses mers bougeraient
  const shifted = (h: SwellHour): number => goldenSwell().find((g) => g.time === addHours(h.time, 3))?.seaLevelM ?? 0;

  /**
   * Open-Meteo multi-points : le premier point est la référence régionale, les suivants les spots, dans
   * l'ordre de la requête. Chaque point a ici sa propre hauteur et les spots leur propre marée, pour
   * qu'un décalage d'index, un ordre inversé ou une marée lue au mauvais point se voie.
   */
  const perPointServer = (regional: SwellHour[], atSpot: (i: number) => unknown) => fakeFetch((url: string) => {
    const n = (new URL(url).searchParams.get('latitude') ?? '').split(',').length;
    if (url.includes('swell_wave_peak_period')) return jsonResponse(Array.from({ length: n }, () => peakJson(goldenSwell())));
    if (url.includes('marine-api')) return jsonResponse([marineJson(regional), ...Array.from({ length: n - 1 }, (_, i) => atSpot(i))]);
    const one = forecastJson(goldenWind(), GOLDEN_DAILY);
    return jsonResponse(n === 1 ? one : Array.from({ length: n }, () => one));
  });
  const at7 = (r: { spots: { spotId: string; hours: { time: string; heightM: number; periodS: number }[] }[] }, id: string) =>
    r.spots.find((s) => s.spotId === id)!.hours.find((h) => h.time === `${GOLDEN_DATE}T07:00`)!;

  it('rates each spot on its own cell, in request order: Muizenberg first (closest), then Kommetjie', async () => {
    // point 0 régional plat, point 1 = Muizenberg 1,2 m, point 2 = Kommetjie 3,5 m
    const heights = [1.2, 3.5];
    const { fn } = perPointServer(series(0.5), (i) => marineJson(series(heights[i], shifted)));
    const r = await buildReport({ profile: profile(), date: GOLDEN_DATE, mode: 'evening' }, deps(fn));
    expect(at7(r, 'muizenberg').heightM).toBeCloseTo(1.2, 6);
    expect(at7(r, 'kommetjie-long-beach').heightM).toBeCloseTo(3.5, 6);
    expect(r.spots.find((s) => s.spotId === 'kommetjie-long-beach')!.maxScore).toBe(6);
  });

  it('reads the tides at the regional point, never at a spot cell', async () => {
    const { fn } = perPointServer(series(0.5), () => marineJson(series(3.5, shifted)));
    const r = await buildReport({ profile: profile(), date: GOLDEN_DATE, mode: 'evening' }, deps(fn));
    expect(r.tides.map((e) => e.time)).toEqual([`${GOLDEN_DATE}T03:00`, `${GOLDEN_DATE}T09:00`, `${GOLDEN_DATE}T15:00`, `${GOLDEN_DATE}T21:00`]);
  });

  it('merges the regional peak period into every spot series — the message says 13 s, not the 10.2 s mean', async () => {
    const { fn } = perPointServer(series(0.5), () => marineJson(series(3.5)));
    const r = await buildReport({ profile: profile(), date: GOLDEN_DATE, mode: 'evening' }, deps(fn));
    expect(at7(r, 'kommetjie-long-beach').periodS).toBe(13);
    expect(at7(r, 'muizenberg').periodS).toBe(13);
  });

  it('falls back to the regional swell × exposure when the spot cell publishes nothing (all nulls)', async () => {
    const empty = () => {
      const json = marineJson(series(0)) as { hourly: Record<string, unknown[]> };
      for (const key of ['swell_wave_height', 'secondary_swell_wave_height']) json.hourly[key] = json.hourly[key].map(() => null);
      return json;
    };
    const { fn } = perPointServer(series(3.5), empty);
    const r = await buildReport({ profile: profile(), date: GOLDEN_DATE, mode: 'evening' }, deps(fn));
    // Kommetjie : exposure 0,6 → 3,5 × 0,6 = 2,1 m, pas les 0 m d'une cellule vide
    expect(at7(r, 'kommetjie-long-beach').heightM).toBeCloseTo(2.1, 6);
  });

  it('spotSwellSeries fills each empty hour from the region, and keeps every hour that has data', () => {
    const regional = series(3.5);
    // valeurs jusqu'à midi le 16, puis plus rien : la cellule ne publie plus, ce n'est pas une mer d'huile
    const atSpot = series(1.2).map((h) => (h.time >= `${GOLDEN_DATE}T12:00` ? { ...h, primary: { ...h.primary, heightM: 0 } } : h));
    const out = spotSwellSeries(atSpot, regional, 0.6);
    expect(out.find((h) => h.time === `${GOLDEN_DATE}T11:00`)!.primary.heightM).toBeCloseTo(1.2, 6);
    expect(out.find((h) => h.time === `${GOLDEN_DATE}T12:00`)!.primary.heightM).toBeCloseTo(2.1, 6);
    expect(out).toHaveLength(atSpot.length);
  });

  it('spotSwellSeries counts a secondary swell alone as data', () => {
    const atSpot = series(0).map((h) => ({ ...h, secondary: { heightM: 0.8, periodS: 9, directionDeg: 230 } }));
    expect(spotSwellSeries(atSpot, series(3.5), 0.6)[0].secondary.heightM).toBe(0.8);
    expect(spotSwellSeries(atSpot, series(3.5), 0.6)[0].primary.heightM).toBe(0);
  });

  it('spotSwellSeries scales both components of the regional series when the spot series is missing', () => {
    const regional = series(2).map((h) => ({ ...h, secondary: { heightM: 1, periodS: 8, directionDeg: 200 } }));
    const out = spotSwellSeries(undefined, regional, 0.5);
    expect(out[0].primary.heightM).toBe(1);
    expect(out[0].secondary.heightM).toBe(0.5);
    expect(out[0].seaLevelM).toBe(regional[0].seaLevelM);
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
