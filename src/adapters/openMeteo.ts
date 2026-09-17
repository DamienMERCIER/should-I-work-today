import type { DailySun, LatLon, SwellHour, WindHour } from '../types';
import { sleep as defaultSleep, type FetchLike } from './http';

export type { FetchLike };

export class OpenMeteoError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'OpenMeteoError';
  }
}

const MARINE_BASE = 'https://marine-api.open-meteo.com/v1/marine';
const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
const TIMEZONE = 'Africa/Johannesburg';
// `sea_surface_temperature` : la température de l'eau, pour la combinaison. Le 17/09/2026, l'ajouter ne changeait
// aucune autre colonne sur six points du Cap (houle, marée identiques à la valeur près).
const MARINE_HOURLY = [
  'swell_wave_height', 'swell_wave_period', 'swell_wave_direction',
  'secondary_swell_wave_height', 'secondary_swell_wave_period', 'secondary_swell_wave_direction',
  'sea_level_height_msl', 'sea_surface_temperature',
];
const FORECAST_HOURLY = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'temperature_2m', 'precipitation', 'weather_code'];
const FORECAST_DAILY = ['sunrise', 'sunset', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum'];

const coords = (points: LatLon[], key: keyof LatLon): string => points.map((p) => p[key].toFixed(4)).join(',');

export function marineUrl(points: LatLon[], forecastDays = 3): string {
  const q = new URLSearchParams({
    latitude: coords(points, 'lat'), longitude: coords(points, 'lon'),
    hourly: MARINE_HOURLY.join(','), timezone: TIMEZONE, forecast_days: String(forecastDays),
  });
  return `${MARINE_BASE}?${q.toString()}`;
}

/**
 * `models=gfs_seamless` : les étoiles reproduisent la note de surf-forecast, dont les courbes de vent
 * basculent à des seuils précis (offshore plein jusqu'à 30 km/h, onshore à zéro dès 20 km/h) — un
 * vent sous-estimé de 10 km/h y change des étoiles entières. Le 16/09/2026, sur huit créneaux de
 * Long Beach et de Muizenberg, GFS tombait à 4,1 et 4,8 km/h du vent affiché par le site ; le modèle
 * par défaut à 10,5 et 10,4 km/h, toujours en dessous ; ECMWF et Météo-France bons sur un spot,
 * faux de 17 à 19 km/h sur l'autre. Mesure courte (un jour, deux spots) : `npm run compare:sf`,
 * lancé dans la durée, dit si elle tient. La houle reste sur le modèle par défaut : à 0,2 m du site,
 * et forcer un modèle de vagues fait perdre la colonne de marée.
 *
 * `cell_selection=nearest` et non `sea` : forcer une cellule en pleine mer éloignait le point de vent
 * jusqu'à 10 km du spot (Long Beach tombait 8,2 km au nord, vers Hout Bay). La grille de GFS est plus
 * lâche que celle du modèle par défaut : avec `nearest`, 24 cellules pour les 35 spots, à 5,3 km en
 * médiane et 6,9 km au plus.
 */
export function forecastUrl(points: LatLon[], forecastDays = 3): string {
  const q = new URLSearchParams({
    latitude: coords(points, 'lat'), longitude: coords(points, 'lon'),
    hourly: FORECAST_HOURLY.join(','), daily: FORECAST_DAILY.join(','),
    wind_speed_unit: 'kn', cell_selection: 'nearest', models: 'gfs_seamless', timezone: TIMEZONE, forecast_days: String(forecastDays),
  });
  return `${FORECAST_BASE}?${q.toString()}`;
}

/**
 * `swell_wave_period` (appel marine principal) est la période MOYENNE ; le modèle par défaut ne publie pas la
 * période PIC (Tp), celle que surf-forecast affiche (« SW 13 s ») et qu'on montre dans les messages. Les
 * étoiles n'en dépendent pas : c'est de l'affichage. `models=gwam` la fournit, mais appliqué à l'appel
 * marine principal il viderait `sea_level_height_msl` et la houle secondaire — d'où un second appel,
 * séparé, ne demandant que cette colonne.
 */
export function peakPeriodUrl(points: LatLon[], forecastDays = 3): string {
  const q = new URLSearchParams({
    latitude: coords(points, 'lat'), longitude: coords(points, 'lon'),
    hourly: 'swell_wave_peak_period', models: 'gwam', timezone: TIMEZONE, forecast_days: String(forecastDays),
  });
  return `${MARINE_BASE}?${q.toString()}`;
}

export interface RetryOptions { retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> }

/** 1 retry après 2 s par défaut (§10.1). Un 4xx (hors 429) ne peut pas réussir au second essai : abandon immédiat. */
export async function fetchJsonWithRetry(url: string, fetchFn: FetchLike, opts: RetryOptions = {}): Promise<unknown> {
  const retries = opts.retries ?? 1;
  const delayMs = opts.delayMs ?? 2000;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchFn(url, { headers: { accept: 'application/json' } });
      if (res.ok) return await res.json();
      const err = new OpenMeteoError(`HTTP ${res.status} for ${url}`, res.status);
      if (res.status !== 429 && res.status < 500) throw err;
      lastError = err;
    } catch (err) {
      if (err instanceof OpenMeteoError && err.status !== undefined && err.status !== 429 && err.status < 500) throw err;
      lastError = err;
    }
    if (attempt < retries) await sleep(delayMs);
  }
  throw lastError instanceof OpenMeteoError ? lastError : new OpenMeteoError(String(lastError));
}

type Num = number | null | undefined;
const num = (v: Num): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const asList = (json: unknown): unknown[] => (Array.isArray(json) ? json : [json]);

interface MarineJson { hourly?: { time?: string[] } & Record<string, Num[] | string[] | undefined> }
interface ForecastJson {
  hourly?: { time?: string[] } & Record<string, Num[] | string[] | undefined>;
  daily?: { time?: string[]; sunrise?: string[]; sunset?: string[] } & Record<string, Num[] | string[] | undefined>;
}

const column = (block: Record<string, Num[] | string[] | undefined>, key: string, i: number): Num => {
  const col = block[key];
  const v = col?.[i];
  return typeof v === 'number' || v === null ? v : undefined;
};

/** Les colonnes que le moteur consomme doivent être des tableaux alignés sur `time` ; sinon, `noData` plutôt qu'une valeur fabriquée. */
function assertColumns(block: Record<string, unknown> | undefined, keys: readonly string[], length: number, kind: 'marine' | 'forecast'): void {
  for (const key of keys) {
    const col = block?.[key];
    if (!Array.isArray(col) || col.length !== length) {
      throw new OpenMeteoError(`Malformed ${kind} response: missing or short column ${key}`);
    }
  }
}

const SEA_TEMP_MIN_C = -5;
const SEA_TEMP_MAX_C = 45;

const MARINE_REQUIRED_HOURLY = [
  'swell_wave_height', 'swell_wave_period', 'swell_wave_direction',
  'secondary_swell_wave_height', 'secondary_swell_wave_period', 'secondary_swell_wave_direction',
  'sea_level_height_msl',
] as const;
// `wind_gusts_10m` est encore demandé (le script de comparaison l'enregistre) mais plus exigé : la note
// ne lit pas la rafale, son absence ne doit pas priver une région de verdict.
const FORECAST_REQUIRED_HOURLY = ['wind_speed_10m', 'wind_direction_10m', 'weather_code'] as const;
const FORECAST_REQUIRED_DAILY = ['time', 'sunrise', 'sunset'] as const;

export function parseMarine(json: unknown): SwellHour[][] {
  return asList(json).map((loc) => {
    const h = (loc as MarineJson)?.hourly;
    if (!h || !Array.isArray(h.time)) throw new OpenMeteoError('Malformed marine response');
    assertColumns(h, MARINE_REQUIRED_HOURLY, h.time.length, 'marine');
    // La température de l'eau n'est que de l'affichage : jamais exigée, et une colonne qui ne s'aligne pas sur
    // `time` est ignorée en entier plutôt que lue au mauvais index. Une heure sans valeur, ou avec une valeur
    // qu'aucune mer n'a (hors de -5..45 °C, NaN et l'infini compris), la laisse absente, jamais à 0.
    const seaTemps = Array.isArray(h.sea_surface_temperature) && h.sea_surface_temperature.length === h.time.length;
    return h.time.map((time, i) => {
      const hour: SwellHour = {
        time,
        primary: { heightM: num(column(h, 'swell_wave_height', i)), periodS: num(column(h, 'swell_wave_period', i)), directionDeg: num(column(h, 'swell_wave_direction', i)) },
        secondary: { heightM: num(column(h, 'secondary_swell_wave_height', i)), periodS: num(column(h, 'secondary_swell_wave_period', i)), directionDeg: num(column(h, 'secondary_swell_wave_direction', i)) },
        seaLevelM: num(column(h, 'sea_level_height_msl', i)),
      };
      const seaTempC = seaTemps ? column(h, 'sea_surface_temperature', i) : undefined;
      if (typeof seaTempC === 'number' && seaTempC > SEA_TEMP_MIN_C && seaTempC < SEA_TEMP_MAX_C) hour.seaTempC = seaTempC;
      return hour;
    });
  });
}

export interface ForecastSeries { wind: WindHour[]; daily: DailySun[] }

export function parseForecast(json: unknown): ForecastSeries[] {
  return asList(json).map((loc) => {
    const f = loc as ForecastJson;
    const h = f?.hourly;
    const d = f?.daily;
    if (!h || !Array.isArray(h.time) || !d || !Array.isArray(d.time)) throw new OpenMeteoError('Malformed forecast response');
    assertColumns(h, FORECAST_REQUIRED_HOURLY, h.time.length, 'forecast');
    assertColumns(d, FORECAST_REQUIRED_DAILY, d.time.length, 'forecast');
    const wind: WindHour[] = h.time.map((time, i) => ({
      time,
      windKt: num(column(h, 'wind_speed_10m', i)), windDirDeg: num(column(h, 'wind_direction_10m', i)), gustKt: num(column(h, 'wind_gusts_10m', i)),
      tempC: num(column(h, 'temperature_2m', i)), precipMm: num(column(h, 'precipitation', i)), weatherCode: num(column(h, 'weather_code', i)),
    }));
    const daily: DailySun[] = d.time.map((date, i) => ({
      date,
      sunrise: String(d.sunrise![i]),
      sunset: String(d.sunset![i]),
      tempMaxC: num(column(d, 'temperature_2m_max', i)), tempMinC: num(column(d, 'temperature_2m_min', i)), precipMm: num(column(d, 'precipitation_sum', i)),
    }));
    return { wind, daily };
  });
}

interface PeakPeriodJson { hourly?: { time?: string[] } & Record<string, Num[] | string[] | undefined> }
const PEAK_PERIOD_REQUIRED_HOURLY = ['swell_wave_peak_period'] as const;

export interface PeakPeriodHour { time: string; peakPeriodS: number | null }

/** `null` = le modèle ne publie pas la période pic pour cette heure (jamais fabriqué en 0, §voir moteur). */
export function parsePeakPeriod(json: unknown): PeakPeriodHour[][] {
  return asList(json).map((loc) => {
    const h = (loc as PeakPeriodJson)?.hourly;
    if (!h || !Array.isArray(h.time)) throw new OpenMeteoError('Malformed marine response');
    assertColumns(h, PEAK_PERIOD_REQUIRED_HOURLY, h.time.length, 'marine');
    return h.time.map((time, i) => {
      const v = column(h, 'swell_wave_peak_period', i);
      return { time, peakPeriodS: typeof v === 'number' ? v : null };
    });
  });
}

function assertCount<T>(list: T[], points: LatLon[]): T[] {
  if (list.length !== points.length) throw new OpenMeteoError(`expected ${points.length} locations, got ${list.length}`);
  return list;
}

export interface FetchOptions extends RetryOptions { forecastDays?: number }

export async function fetchMarine(points: LatLon[], fetchFn: FetchLike, opts: FetchOptions = {}): Promise<SwellHour[][]> {
  return assertCount(parseMarine(await fetchJsonWithRetry(marineUrl(points, opts.forecastDays), fetchFn, opts)), points);
}

export async function fetchForecast(points: LatLon[], fetchFn: FetchLike, opts: FetchOptions = {}): Promise<ForecastSeries[]> {
  return assertCount(parseForecast(await fetchJsonWithRetry(forecastUrl(points, opts.forecastDays), fetchFn, opts)), points);
}

export async function fetchPeakPeriod(points: LatLon[], fetchFn: FetchLike, opts: FetchOptions = {}): Promise<PeakPeriodHour[][]> {
  return assertCount(parsePeakPeriod(await fetchJsonWithRetry(peakPeriodUrl(points, opts.forecastDays), fetchFn, opts)), points);
}
