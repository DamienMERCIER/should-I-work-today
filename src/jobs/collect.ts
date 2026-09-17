import { fetchForecast, fetchMarine, fetchPeakPeriod, OpenMeteoError, type FetchLike, type ForecastSeries, type PeakPeriodHour } from '../adapters/openMeteo';
import { FAR_FROM_COAST_KM, RADIUS_KM, SCORING } from '../config';
import { nearestWorldSpots, worldSpots, type SpotTuple } from '../data/world';
import { haversineKm } from '../engine/geo';
import { evaluateSpot } from '../engine/score';
import { computeTide, type TideInfo } from '../engine/tide';
import { hasDaylightLeft } from '../engine/factors';
import { addDays, dateOf, floorHour } from '../engine/time';
import { decideVerdict } from '../engine/verdict';
import type { DailySun, LatLon, Profile, RawConditions, Region, Report, ReportMode, Spot, SpotResult, SwellHour } from '../types';

export interface EvalRequest { profile: Profile; date: string; mode: ReportMode; fromTime?: string }
export interface CollectDeps { spots: Spot[]; regions: Region[]; fetchFn: FetchLike; radiusKm?: number; now: string }

interface Near { spot: Spot; distanceKm: number }
interface RegionData {
  /** regional point: used for the tide */
  swell: SwellHour[];
  /** swell at each spot's cell: this is what the stars are calculated from */
  spotSwell: Map<string, SwellHour[]>;
  forecasts: Map<string, ForecastSeries>;
  tide: Map<string, TideInfo>;
}

const byDistance = (spots: Spot[], at: LatLon): Near[] =>
  spots.map((spot) => ({ spot, distanceKm: haversineKm(at, spot) })).sort((a, b) => a.distanceKm - b.distanceKm);

const toNear = (spots: Spot[], at: LatLon): Near[] => spots.map((spot) => ({ spot, distanceKm: haversineKm(at, spot) }));

/**
 * Curated + world, curated first on ties (§report "Resilience, wiring and dedupe"): `curated` is
 * concatenated *before* `world`, and `Array.prototype.sort` is stable, so two entries at the exact
 * same distance keep curated ahead of world without any extra tie-break logic. `worldTuples`/
 * `curatedRegions` are optional DI hooks (mirroring `worldSpots`' own signature) purely for tests —
 * production call sites never pass them, so `worldSpots`'s own defaults (the real `spots-world.json`)
 * apply. That import leaves out every spot within 20 km of a curated one, so where curated spots exist
 * this still returns them alone.
 */
export function nearbySpots(spots: Spot[], at: LatLon, radiusKm: number, worldTuples?: SpotTuple[], curatedRegions?: readonly Region[]): Near[] {
  const curated = byDistance(spots, at).filter((x) => x.distanceKm <= radiusKm);
  const world = toNear(worldSpots(at, radiusKm, worldTuples, curatedRegions), at);
  return [...curated, ...world].sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Same curated-first-on-ties merge as `nearbySpots`, for "closest N regardless of distance" (the
 * out-of-coverage path, §`outOfCoverage`) instead of a radius. */
export function nearestSpots(spots: Spot[], at: LatLon, n = 3, worldTuples?: SpotTuple[], curatedRegions?: readonly Region[]): Near[] {
  const curated = byDistance(spots, at).slice(0, n);
  const world = toNear(nearestWorldSpots(at, n, worldTuples, curatedRegions), at);
  return [...curated, ...world].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, n);
}

const toError = (err: unknown): OpenMeteoError => (err instanceof OpenMeteoError ? err : new OpenMeteoError(String(err)));

/** Merges by timestamp (not by index: the two series can differ in length/order). `null` (or a missing hour) leaves `peakPeriodS` undefined rather than fabricating 0 — `effectiveSwell` then falls back to the mean period. */
export function mergePeakPeriod(swell: SwellHour[], peak: PeakPeriodHour[]): SwellHour[] {
  const byTime = new Map(peak.map((p) => [p.time, p.peakPeriodS]));
  return swell.map((h) => {
    const v = byTime.get(h.time);
    return v === null || v === undefined ? h : { ...h, peakPeriodS: v };
  });
}

/**
 * Swell at the spot's cell, hour by hour; the regional swell × `exposure` for each hour where the
 * cell publishes nothing. Open-Meteo returns `null` for a value it doesn't have and the adapter reads
 * it as 0: an ocean cell never shows exactly 0.00 m on both components, that's a missing value.
 * Hour by hour rather than the whole series, so a cell that goes silent partway through the forecast
 * horizon doesn't turn the next day into "0★ (swell 0.0 m)". On 2026-09-16 the 35 curated spots all
 * had a complete series; the fallback mainly targets the imported world spots.
 *
 * Water temperature follows its own rule: the cell's value when it exists, even when the swell comes
 * from the region — it comes from a different model, on a different grid — otherwise the region's value.
 */
export function spotSwellSeries(atSpot: SwellHour[] | undefined, regional: SwellHour[], exposure: number): SwellHour[] {
  const scaled = (h: SwellHour): SwellHour => ({
    ...h,
    primary: { ...h.primary, heightM: h.primary.heightM * exposure },
    secondary: { ...h.secondary, heightM: h.secondary.heightM * exposure },
  });
  if (!atSpot) return regional.map(scaled);
  const regionalByTime = new Map(regional.map((h) => [h.time, h]));
  return atSpot.map((h) => {
    const hasSwell = h.primary.heightM > 0 || h.secondary.heightM > 0;
    if (hasSwell && h.seaTempC !== undefined) return h;
    const r = regionalByTime.get(h.time);
    const hour = hasSwell || !r ? h : scaled(r);
    const seaTempC = h.seaTempC ?? r?.seaTempC;
    return hour.seaTempC === seaTempC ? hour : { ...hour, seaTempC };
  });
}

/** Forecast days requested per call. Without an option, whatever a single day's verdict needs. */
export interface LoadOptions { forecastDays?: number }

async function loadRegion(region: Region, spots: Spot[], fetchFn: FetchLike, opts: LoadOptions = {}): Promise<RegionData> {
  // A single day's verdict: tide day D−3h .. day D+27h → 3 days; wind/weather, only day D itself is read → 2 days
  // is enough. The upcoming week needs `forecastDays` for all three calls: the responses get bigger,
  // not more numerous.
  // peak period (gwam, §adapters/openMeteo): separate 3rd call, best-effort — a failure must not deprive
  // the region of a verdict (§10.1), it should just fall back to the mean period already handled by effectiveSwell.
  // Swell: the regional point (tide) AND each spot's cell (stars), in the same call —
  // Open-Meteo accepts several points per request, so zero extra sub-requests (§ docs/rating.md 1.2).
  const [[regional, ...atSpots], forecasts, peakSeries] = await Promise.all([
    fetchMarine([region.swellRef, ...spots], fetchFn, { forecastDays: opts.forecastDays ?? 3 }),
    fetchForecast(spots, fetchFn, { forecastDays: opts.forecastDays ?? 2 }),
    // retries: 0 — best-effort: the Promise.all waits for this 3rd request just like the other two, so
    // making it retry (2s delay by default) would delay the whole region for a marginal gain;
    // on failure we simply fall back to the mean period.
    fetchPeakPeriod([region.swellRef], fetchFn, { retries: 0, forecastDays: opts.forecastDays ?? 3 }).catch((err) => {
      console.warn(`[collect] peak period unavailable for region ${region.id}, falling back to mean period: ${String(err)}`);
      return null;
    }),
  ]);
  // the peak period only exists at the regional point (gwam): we merge it into each spot series too
  const withPeak = (series: SwellHour[]): SwellHour[] => (peakSeries ? mergePeakPeriod(series, peakSeries[0]) : series);
  return {
    swell: withPeak(regional),
    spotSwell: new Map(spots.map((s, i) => [s.id, withPeak(spotSwellSeries(atSpots[i], regional, s.exposure))])),
    forecasts: new Map(spots.map((s, i) => [s.id, forecasts[i]])),
    tide: new Map(),
  };
}

const tideFor = (data: RegionData, date: string): TideInfo => {
  let t = data.tide.get(date);
  if (!t) {
    t = computeTide(data.swell, date);
    data.tide.set(date, t);
  }
  return t;
};

/**
 * Evaluations already done in this call, by spot, date and start time. The star rating no longer
 * depends on the profile (neither level nor board): friends at the same place, or the seven days of a
 * week requested by several profiles, reuse the same evaluation instead of redoing the CPU work for each.
 * Only the distance, specific to each profile, is copied over.
 */
type EvalCache = Map<string, SpotResult>;

/** One verdict per profile, for the requested day. Wrapper over `buildReportList` indexed by chat. */
export async function buildReports(reqs: EvalRequest[], deps: CollectDeps): Promise<Map<number, Report>> {
  const list = await buildReportList(reqs, deps);
  return new Map(list.map((report, i) => [reqs[i].profile.chatId, report]));
}

/**
 * One report per request, in the order of the requests — several dates per profile are allowed (the
 * upcoming week). Each region is loaded only once for all requests and all dates.
 */
export async function buildReportList(reqs: EvalRequest[], deps: CollectDeps, opts: LoadOptions = {}): Promise<Report[]> {
  const radiusKm = deps.radiusKm ?? RADIUS_KM;
  const regionsById = new Map(deps.regions.map((r) => [r.id, r]));
  const nearbyAt = nearbyByPlace(deps.spots, radiusKm);
  const perRequest = reqs.map((req) => ({ req, nearby: nearbyAt(req.profile.location) }));

  // 1. spots required per region
  const needed = new Map<string, Map<string, Spot>>();
  for (const { nearby } of perRequest) {
    for (const { spot } of nearby) {
      const m = needed.get(spot.region) ?? new Map<string, Spot>();
      m.set(spot.id, spot);
      needed.set(spot.region, m);
    }
  }

  // 2. two calls per region, all regions in parallel
  const regionData = new Map<string, RegionData | OpenMeteoError>();
  await Promise.all(
    [...needed].map(async ([regionId, spotMap]) => {
      const region = regionsById.get(regionId);
      if (!region) {
        regionData.set(regionId, new OpenMeteoError(`unknown region ${regionId}`));
        return;
      }
      try {
        regionData.set(regionId, await loadRegion(region, [...spotMap.values()], deps.fetchFn, opts));
      } catch (err) {
        regionData.set(regionId, toError(err));
      }
    }),
  );

  // 3. one report per identical group of friends — same date, same place, same work hours: the star rating,
  // the verdict, the tides, and, out of coverage, the raw calls only depend on that. Each one gets this shared
  // body with their own chat and their own location. With 40 friends, Sunday's send would otherwise redo 280
  // verdicts and assemblies.
  const cache: EvalCache = new Map();
  const bodies = new Map<string, Promise<Report>>();
  return Promise.all(
    perRequest.map(async ({ req, nearby }) => {
      const { location, workHours, chatId } = req.profile;
      const key = `${req.date}|${req.mode}|${req.fromTime ?? ''}|${placeKey(location)}|${workHours.start}-${workHours.end}|${minStars(req.profile)}`;
      let body = bodies.get(key);
      if (!body) {
        body = nearby.length === 0 ? outOfCoverage(req, deps, radiusKm) : Promise.resolve(assembleSafely(req, nearby, regionData, deps, radiusKm, cache));
        bodies.set(key, body);
      }
      return { ...(await body), chatId, location };
    }),
  );
}

/** The friend's threshold, or everyone's if they haven't changed it. */
export const minStars = (p: Profile): number => p.minStars ?? SCORING.good;

/** A location as a grouping key: friends at the same place share nearby spots, report and message. */
export const placeKey = (at: LatLon): string => `${at.lat},${at.lon}`;

/** The spots near a location, looked up once per location: ~6,000 imported spots to scan. */
export function nearbyByPlace(spots: Spot[], radiusKm: number): (at: LatLon) => Near[] {
  const byPlace = new Map<string, Near[]>();
  return (at) => {
    const key = placeKey(at);
    let near = byPlace.get(key);
    if (!near) {
      near = nearbySpots(spots, at, radiusKm);
      byPlace.set(key, near);
    }
    return near;
  };
}

/** Days of the upcoming week, for `/week` as well as the Sunday send. */
export const WEEK_DAYS = 7;

/**
 * A profile's upcoming week: today if there's still a surfable hour left (the rest of the day,
 * like /now), otherwise tomorrow, then the following days up to seven — a single load per region for
 * the eight dates requested.
 */
export async function buildWeek(profile: Profile, deps: CollectDeps): Promise<Report[]> {
  const today = dateOf(deps.now);
  const fromTime = floorHour(deps.now);
  const reqs: EvalRequest[] = [
    { profile, date: today, mode: 'now', fromTime },
    ...Array.from({ length: WEEK_DAYS }, (_, i): EvalRequest => ({ profile, date: addDays(today, i + 1), mode: 'evening' })),
  ];
  const [first, ...rest] = await buildReportList(reqs, deps, { forecastDays: WEEK_DAYS + 1 });
  const todayCounts = first.spots.length > 0 && hasDaylightLeft(fromTime, first.sun.sunrise, first.sun.sunset);
  return (todayCounts ? [first, ...rest] : rest).slice(0, WEEK_DAYS);
}

export async function buildReport(req: EvalRequest, deps: CollectDeps): Promise<Report> {
  const report = (await buildReports([req], deps)).get(req.profile.chatId);
  if (!report) throw new Error('buildReports returned nothing');
  return report;
}

function baseReport(req: EvalRequest, deps: CollectDeps, radiusKm: number): Omit<Report, 'verdict'> {
  return {
    chatId: req.profile.chatId, date: req.date, mode: req.mode, generatedAt: deps.now, minStars: minStars(req.profile),
    location: req.profile.location, radiusKm,
    spots: [], tides: [],
    weather: { tempMaxC: 0, tempMinC: 0, precipMm: 0, code: 0 },
    sun: { sunrise: `${req.date}T06:00`, sunset: `${req.date}T18:00` },
  };
}

/** An exception in the engine should only deprive this profile of a verdict (§10.1), never the whole run. */
function assembleSafely(req: EvalRequest, nearby: Near[], regionData: Map<string, RegionData | OpenMeteoError>, deps: CollectDeps, radiusKm: number, cache: EvalCache): Report {
  try {
    return assemble(req, nearby, regionData, deps, radiusKm, cache);
  } catch (err) {
    console.error(`[collect] ${req.profile.chatId} ${req.date}: ${String(err)}`); // engine fault, not a lack of data
    return { ...baseReport(req, deps, radiusKm), verdict: { kind: 'noData', reason: `engine: ${String(err)}` } };
  }
}

function assemble(req: EvalRequest, nearby: Near[], regionData: Map<string, RegionData | OpenMeteoError>, deps: CollectDeps, radiusKm: number, cache: EvalCache): Report {
  const base = baseReport(req, deps, radiusKm);
  const results: SpotResult[] = [];
  const errors: string[] = [];
  let closest: { data: RegionData; forecast: ForecastSeries; daily: DailySun } | undefined;

  for (const { spot, distanceKm } of nearby) {
    const data = regionData.get(spot.region);
    if (!data || data instanceof OpenMeteoError) {
      errors.push(data?.message ?? `no data for region ${spot.region}`);
      continue;
    }
    const forecast = data.forecasts.get(spot.id);
    const swell = data.spotSwell.get(spot.id);
    if (!forecast || !swell) continue;
    const daily = forecast.daily.find((d) => d.date === req.date);
    if (!daily) {
      errors.push(`no daily forecast for ${req.date}`);
      continue;
    }
    closest ??= { data, forecast, daily };
    const key = `${spot.id}|${req.date}|${req.fromTime ?? ''}`;
    let evaluated = cache.get(key);
    if (!evaluated) {
      evaluated = evaluateSpot({
        spot, date: req.date,
        swell, wind: forecast.wind, sun: { sunrise: daily.sunrise, sunset: daily.sunset },
        tide: tideFor(data, req.date), distanceKm, fromTime: req.fromTime,
      });
      cache.set(key, evaluated);
    }
    results.push(evaluated.distanceKm === distanceKm ? evaluated : { ...evaluated, distanceKm });
  }

  if (results.length === 0 || !closest) {
    return { ...base, verdict: { kind: 'noData', reason: errors.join('; ') || 'no usable spot data' } };
  }
  const { daily } = closest;
  const noon = closest.forecast.wind.find((h) => h.time === `${req.date}T12:00`);
  return {
    ...base,
    spots: results,
    tides: tideFor(closest.data, req.date).events,
    weather: { tempMaxC: daily.tempMaxC, tempMinC: daily.tempMinC, precipMm: daily.precipMm, code: noon?.weatherCode ?? 0 },
    sun: { sunrise: daily.sunrise, sunset: daily.sunset },
    verdict: decideVerdict(results, { date: req.date, workHours: req.profile.workHours, mode: req.mode === 'now' ? 'now' : 'day', good: minStars(req.profile) }),
  };
}

async function outOfCoverage(req: EvalRequest, deps: CollectDeps, radiusKm: number): Promise<Report> {
  const base = baseReport(req, deps, radiusKm);
  const nearest = nearestSpots(deps.spots, req.profile.location).map((n) => ({ spotId: n.spot.id, distanceKm: n.distanceKm }));
  if (nearest.length === 0 || nearest[0].distanceKm > FAR_FROM_COAST_KM) {
    return { ...base, verdict: { kind: 'outOfCoverage', raw: undefined, nearest } };
  }
  try {
    const at = req.profile.location;
    // no peak period call here: this branch only shows a line of raw conditions (swell_wave_period,
    // the mean period), never a star rating.
    const [[swell], [forecast]] = await Promise.all([fetchMarine([at], deps.fetchFn), fetchForecast([at], deps.fetchFn, { forecastDays: 2 })]);
    const refTime = req.fromTime ? floorHour(req.fromTime) : `${req.date}T09:00`;
    const s = swell.find((h) => h.time === refTime);
    const w = forecast.wind.find((h) => h.time === refTime);
    const raw: RawConditions | undefined = s && w
      ? { swellHeightM: s.primary.heightM, periodS: s.primary.periodS, swellDirDeg: s.primary.directionDeg, windKt: w.windKt, windDirDeg: w.windDirDeg }
      : undefined;
    return { ...base, verdict: { kind: 'outOfCoverage', raw, nearest } };
  } catch (err) {
    return { ...base, verdict: { kind: 'noData', reason: toError(err).message } };
  }
}
