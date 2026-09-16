import { fetchForecast, fetchMarine, fetchPeakPeriod, OpenMeteoError, type FetchLike, type ForecastSeries, type PeakPeriodHour } from '../adapters/openMeteo';
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

/** Fusionne par timestamp (pas par index : les deux séries peuvent différer en longueur/ordre). `null` (ou une heure absente) laisse `peakPeriodS` non défini plutôt que de fabriquer 0 — `effectiveSwell` retombe alors sur la période moyenne. */
export function mergePeakPeriod(swell: SwellHour[], peak: PeakPeriodHour[]): SwellHour[] {
  const byTime = new Map(peak.map((p) => [p.time, p.peakPeriodS]));
  return swell.map((h) => {
    const v = byTime.get(h.time);
    return v === null || v === undefined ? h : { ...h, peakPeriodS: v };
  });
}

async function loadRegion(region: Region, spots: Spot[], fetchFn: FetchLike): Promise<RegionData> {
  // marée : J−3 h .. J+27 h → 3 jours ; vent/météo : seul le jour J est lu → 2 jours suffisent ;
  // période pic (gwam, §adapters/openMeteo) : 3e appel séparé, best-effort — une panne ne doit pas priver
  // la région de verdict (§10.1), juste la ramener au repli période moyenne déjà géré par effectiveSwell.
  const [[swell], forecasts, peakSeries] = await Promise.all([
    fetchMarine([region.swellRef], fetchFn),
    fetchForecast(spots, fetchFn, { forecastDays: 2 }),
    // retries: 0 — best-effort : le Promise.all attend cette 3e requête comme les deux autres, donc la
    // faire re-essayer (2 s de délai par défaut) retarderait toute la région pour un gain marginal ;
    // en cas d'échec on retombe simplement sur la période moyenne.
    fetchPeakPeriod([region.swellRef], fetchFn, { retries: 0 }).catch((err) => {
      console.warn(`[collect] peak period unavailable for region ${region.id}, falling back to mean period: ${String(err)}`);
      return null;
    }),
  ]);
  return {
    swell: peakSeries ? mergePeakPeriod(swell, peakSeries[0]) : swell,
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
      [req.profile.chatId, nearby.length === 0 ? await outOfCoverage(req, deps, radiusKm) : assembleSafely(req, nearby, regionData, deps, radiusKm)] as const,
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

/** Une exception du moteur ne doit priver que ce profil de verdict (§10.1), jamais tout le run. */
function assembleSafely(req: EvalRequest, nearby: Near[], regionData: Map<string, RegionData | OpenMeteoError>, deps: CollectDeps, radiusKm: number): Report {
  try {
    return assemble(req, nearby, regionData, deps, radiusKm);
  } catch (err) {
    console.error(`[collect] ${req.profile.chatId} ${req.date}: ${String(err)}`); // défaut du moteur, pas une absence de données
    return { ...baseReport(req, deps, radiusKm), verdict: { kind: 'noData', reason: `engine: ${String(err)}` } };
  }
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
    // pas d'appel période pic ici : cette branche n'affiche qu'une ligne de conditions brutes (swell_wave_period,
    // la période moyenne), jamais un score — periodFactor/k(T), les seuls consommateurs de peakPeriodS, n'entrent pas en jeu.
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
