import { fetchForecast, fetchMarine, OpenMeteoError, type FetchLike, type ForecastSeries } from '../adapters/openMeteo';
import { FAR_FROM_COAST_KM, RADIUS_KM } from '../config';
import { haversineKm } from '../engine/geo';
import { evaluateSpot } from '../engine/score';
import { computeTide, type TideInfo } from '../engine/tide';
import { floorHour } from '../engine/time';
import { decideVerdict } from '../engine/verdict';
import type { DailySun, LatLon, Profile, RawConditions, Region, Report, ReportMode, Spot, SpotResult, SwellHour } from '../types';

export interface EvalRequest { profile: Profile; date: string; mode: ReportMode; fromTime?: string }
export interface CollectDeps { spots: Spot[]; regions: Region[]; fetchFn: FetchLike; radiusKm?: number; now: string }

interface Near { spot: Spot; distanceKm: number }
interface RegionData { swell: SwellHour[]; forecasts: Map<string, ForecastSeries>; tide: Map<string, TideInfo> }

const byDistance = (spots: Spot[], at: LatLon): Near[] =>
  spots.map((spot) => ({ spot, distanceKm: haversineKm(at, spot) })).sort((a, b) => a.distanceKm - b.distanceKm);

export function nearbySpots(spots: Spot[], at: LatLon, radiusKm: number): Near[] {
  return byDistance(spots, at).filter((x) => x.distanceKm <= radiusKm);
}

export function nearestSpots(spots: Spot[], at: LatLon, n = 3): Near[] {
  return byDistance(spots, at).slice(0, n);
}

const toError = (err: unknown): OpenMeteoError => (err instanceof OpenMeteoError ? err : new OpenMeteoError(String(err)));

async function loadRegion(region: Region, spots: Spot[], fetchFn: FetchLike): Promise<RegionData> {
  const [[swell], forecasts] = await Promise.all([fetchMarine([region.swellRef], fetchFn), fetchForecast(spots, fetchFn)]);
  return { swell, forecasts: new Map(spots.map((s, i) => [s.id, forecasts[i]])), tide: new Map() };
}

const tideFor = (data: RegionData, date: string): TideInfo => {
  let t = data.tide.get(date);
  if (!t) {
    t = computeTide(data.swell, date);
    data.tide.set(date, t);
  }
  return t;
};

export async function buildReports(reqs: EvalRequest[], deps: CollectDeps): Promise<Map<number, Report>> {
  const radiusKm = deps.radiusKm ?? RADIUS_KM;
  const regionsById = new Map(deps.regions.map((r) => [r.id, r]));
  const perRequest = reqs.map((req) => ({ req, nearby: nearbySpots(deps.spots, req.profile.location, radiusKm) }));

  // 1. spots requis par région
  const needed = new Map<string, Map<string, Spot>>();
  for (const { nearby } of perRequest) {
    for (const { spot } of nearby) {
      const m = needed.get(spot.region) ?? new Map<string, Spot>();
      m.set(spot.id, spot);
      needed.set(spot.region, m);
    }
  }

  // 2. deux appels par région, toutes les régions en parallèle
  const regionData = new Map<string, RegionData | OpenMeteoError>();
  await Promise.all(
    [...needed].map(async ([regionId, spotMap]) => {
      const region = regionsById.get(regionId);
      if (!region) {
        regionData.set(regionId, new OpenMeteoError(`unknown region ${regionId}`));
        return;
      }
      try {
        regionData.set(regionId, await loadRegion(region, [...spotMap.values()], deps.fetchFn));
      } catch (err) {
        regionData.set(regionId, toError(err));
      }
    }),
  );

  // 3. un rapport par profil (les profils hors couverture font leurs appels en parallèle)
  const reports = await Promise.all(
    perRequest.map(async ({ req, nearby }) =>
      [req.profile.chatId, nearby.length === 0 ? await outOfCoverage(req, deps, radiusKm) : assemble(req, nearby, regionData, deps, radiusKm)] as const,
    ),
  );
  return new Map(reports);
}

export async function buildReport(req: EvalRequest, deps: CollectDeps): Promise<Report> {
  const report = (await buildReports([req], deps)).get(req.profile.chatId);
  if (!report) throw new Error('buildReports returned nothing');
  return report;
}

function baseReport(req: EvalRequest, deps: CollectDeps, radiusKm: number): Omit<Report, 'verdict'> {
  return {
    chatId: req.profile.chatId, date: req.date, mode: req.mode, generatedAt: deps.now,
    location: req.profile.location, radiusKm,
    spots: [], tides: [],
    weather: { tempMaxC: 0, tempMinC: 0, precipMm: 0, code: 0 },
    sun: { sunrise: `${req.date}T06:00`, sunset: `${req.date}T18:00` },
  };
}

function assemble(req: EvalRequest, nearby: Near[], regionData: Map<string, RegionData | OpenMeteoError>, deps: CollectDeps, radiusKm: number): Report {
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
    if (!forecast) continue;
    const daily = forecast.daily.find((d) => d.date === req.date);
    if (!daily) {
      errors.push(`no daily forecast for ${req.date}`);
      continue;
    }
    closest ??= { data, forecast, daily };
    results.push(evaluateSpot({
      spot, level: req.profile.level, board: req.profile.board, date: req.date,
      swell: data.swell, wind: forecast.wind, sun: { sunrise: daily.sunrise, sunset: daily.sunset },
      tide: tideFor(data, req.date), distanceKm, fromTime: req.fromTime,
    }));
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
    verdict: decideVerdict(results, { date: req.date, workHours: req.profile.workHours, mode: req.mode === 'now' ? 'now' : 'day' }),
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
    const [[swell], [forecast]] = await Promise.all([fetchMarine([at], deps.fetchFn), fetchForecast([at], deps.fetchFn)]);
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
