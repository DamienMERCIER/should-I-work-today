import { fetchForecast, fetchMarine, fetchPeakPeriod, OpenMeteoError, type FetchLike, type ForecastSeries, type PeakPeriodHour } from '../adapters/openMeteo';
import { FAR_FROM_COAST_KM, RADIUS_KM } from '../config';
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
  /** point régional : sert à la marée */
  swell: SwellHour[];
  /** houle à la cellule de chaque spot : c'est sur elle que se calculent les étoiles */
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

/** Fusionne par timestamp (pas par index : les deux séries peuvent différer en longueur/ordre). `null` (ou une heure absente) laisse `peakPeriodS` non défini plutôt que de fabriquer 0 — `effectiveSwell` retombe alors sur la période moyenne. */
export function mergePeakPeriod(swell: SwellHour[], peak: PeakPeriodHour[]): SwellHour[] {
  const byTime = new Map(peak.map((p) => [p.time, p.peakPeriodS]));
  return swell.map((h) => {
    const v = byTime.get(h.time);
    return v === null || v === undefined ? h : { ...h, peakPeriodS: v };
  });
}

/**
 * La houle à la cellule du spot, heure par heure ; la régionale × `exposure` pour chaque heure où la
 * cellule ne publie rien. Open-Meteo rend `null` pour une valeur qu'il n'a pas et l'adaptateur le lit
 * comme 0 : une cellule océanique n'affiche jamais exactement 0,00 m sur les deux composantes, c'est
 * une valeur absente. Heure par heure et non série entière, pour qu'une cellule qui se tait au milieu
 * de l'échéance ne transforme pas le lendemain en « 0★ (swell 0.0 m) ». Le 16/09/2026 les 35 spots
 * curatés avaient tous une série complète ; le repli vise surtout les spots du monde importés.
 *
 * La température de l'eau suit sa propre règle : celle de la cellule quand elle existe, même quand la houle
 * vient de la région — elle sort d'un autre modèle, sur une autre grille —, sinon celle de la région.
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

/** Jours de prévision demandés par appel. Sans option, ceux qu'il faut au verdict d'un seul jour. */
export interface LoadOptions { forecastDays?: number }

async function loadRegion(region: Region, spots: Spot[], fetchFn: FetchLike, opts: LoadOptions = {}): Promise<RegionData> {
  // Un verdict d'un jour : marée J−3 h .. J+27 h → 3 jours ; vent/météo, seul le jour J est lu → 2 jours
  // suffisent. La semaine à venir demande `forecastDays` pour les trois appels : les réponses grossissent,
  // pas leur nombre.
  // période pic (gwam, §adapters/openMeteo) : 3e appel séparé, best-effort — une panne ne doit pas priver
  // la région de verdict (§10.1), juste la ramener au repli période moyenne déjà géré par effectiveSwell.
  // Houle : le point régional (marée) ET la cellule de chaque spot (étoiles), dans le même appel —
  // Open-Meteo accepte plusieurs points par requête, donc zéro sous-requête de plus (§ RAPPORT 1.2).
  const [[regional, ...atSpots], forecasts, peakSeries] = await Promise.all([
    fetchMarine([region.swellRef, ...spots], fetchFn, { forecastDays: opts.forecastDays ?? 3 }),
    fetchForecast(spots, fetchFn, { forecastDays: opts.forecastDays ?? 2 }),
    // retries: 0 — best-effort : le Promise.all attend cette 3e requête comme les deux autres, donc la
    // faire re-essayer (2 s de délai par défaut) retarderait toute la région pour un gain marginal ;
    // en cas d'échec on retombe simplement sur la période moyenne.
    fetchPeakPeriod([region.swellRef], fetchFn, { retries: 0, forecastDays: opts.forecastDays ?? 3 }).catch((err) => {
      console.warn(`[collect] peak period unavailable for region ${region.id}, falling back to mean period: ${String(err)}`);
      return null;
    }),
  ]);
  // la période pic n'existe qu'au point régional (gwam) : on la fusionne aussi dans chaque série spot
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
 * Évaluations déjà faites dans cet appel, par spot, date et heure de départ. Les étoiles ne dépendent
 * plus du profil (ni niveau ni planche) : des amis au même endroit, ou les sept jours d'une semaine
 * demandés par plusieurs profils, réutilisent la même évaluation au lieu de refaire le CPU pour chacun.
 * Seule la distance, propre à chaque profil, est recopiée.
 */
type EvalCache = Map<string, SpotResult>;

/** Un verdict par profil, pour le jour demandé. Enveloppe de `buildReportList` indexée par chat. */
export async function buildReports(reqs: EvalRequest[], deps: CollectDeps): Promise<Map<number, Report>> {
  const list = await buildReportList(reqs, deps);
  return new Map(list.map((report, i) => [reqs[i].profile.chatId, report]));
}

/**
 * Un rapport par requête, dans l'ordre des requêtes — plusieurs dates par profil sont permises (semaine
 * à venir). Chaque région n'est chargée qu'une fois pour toutes les requêtes et toutes les dates.
 */
export async function buildReportList(reqs: EvalRequest[], deps: CollectDeps, opts: LoadOptions = {}): Promise<Report[]> {
  const radiusKm = deps.radiusKm ?? RADIUS_KM;
  const regionsById = new Map(deps.regions.map((r) => [r.id, r]));
  const nearbyAt = nearbyByPlace(deps.spots, radiusKm);
  const perRequest = reqs.map((req) => ({ req, nearby: nearbyAt(req.profile.location) }));

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
        regionData.set(regionId, await loadRegion(region, [...spotMap.values()], deps.fetchFn, opts));
      } catch (err) {
        regionData.set(regionId, toError(err));
      }
    }),
  );

  // 3. un rapport par groupe d'amis identique — même date, même lieu, mêmes horaires : les étoiles, le verdict,
  // les marées et, hors couverture, les appels bruts ne dépendent que de ça. Chacun reçoit ce corps partagé avec
  // son propre chat et sa propre position. À 40 amis, le dimanche refaisait sinon 280 verdicts et assemblages.
  const cache: EvalCache = new Map();
  const bodies = new Map<string, Promise<Report>>();
  return Promise.all(
    perRequest.map(async ({ req, nearby }) => {
      const { location, workHours, chatId } = req.profile;
      const key = `${req.date}|${req.mode}|${req.fromTime ?? ''}|${placeKey(location)}|${workHours.start}-${workHours.end}`;
      let body = bodies.get(key);
      if (!body) {
        body = nearby.length === 0 ? outOfCoverage(req, deps, radiusKm) : Promise.resolve(assembleSafely(req, nearby, regionData, deps, radiusKm, cache));
        bodies.set(key, body);
      }
      return { ...(await body), chatId, location };
    }),
  );
}

/** Une position comme clé de regroupement : les amis au même endroit partagent spots proches, rapport et message. */
export const placeKey = (at: LatLon): string => `${at.lat},${at.lon}`;

/** Les spots proches d'une position, cherchés une fois par position : ~6 000 spots importés à parcourir. */
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

/** Jours de la semaine à venir, pour `/week` comme pour l'envoi du dimanche. */
export const WEEK_DAYS = 7;

/**
 * La semaine à venir d'un profil : aujourd'hui s'il reste une heure surfable (le reste de la journée,
 * comme /now), sinon demain, puis les jours suivants jusqu'à sept — une seule charge par région pour
 * les huit dates demandées.
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
    chatId: req.profile.chatId, date: req.date, mode: req.mode, generatedAt: deps.now,
    location: req.profile.location, radiusKm,
    spots: [], tides: [],
    weather: { tempMaxC: 0, tempMinC: 0, precipMm: 0, code: 0 },
    sun: { sunrise: `${req.date}T06:00`, sunset: `${req.date}T18:00` },
  };
}

/** Une exception du moteur ne doit priver que ce profil de verdict (§10.1), jamais tout le run. */
function assembleSafely(req: EvalRequest, nearby: Near[], regionData: Map<string, RegionData | OpenMeteoError>, deps: CollectDeps, radiusKm: number, cache: EvalCache): Report {
  try {
    return assemble(req, nearby, regionData, deps, radiusKm, cache);
  } catch (err) {
    console.error(`[collect] ${req.profile.chatId} ${req.date}: ${String(err)}`); // défaut du moteur, pas une absence de données
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
    // la période moyenne), jamais d'étoiles.
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
