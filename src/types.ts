import type { WindState } from './engine/rating';

/** The six surf-forecast wind states (`src/engine/rating.ts`). */
export type { WindState };

export type Level = 'beginner' | 'intermediate' | 'advanced';
export type Lang = 'en' | 'ru';
export type TideState = 'low' | 'mid' | 'high';
export type TideTrend = 'rising' | 'falling';
export type ReportMode = 'evening' | 'morning' | 'now';

export interface LatLon { lat: number; lon: number }

/** 'HH:MM' */
export interface WorkHours { start: string; end: string }

/**
 * No level, no board: the rating is surf-forecast's, the same for everyone
 * (§ docs/rating.md). A profile written before 16/09/2026 can still carry `level`,
 * `board`, and `onboarding` in KV: `Store` strips them on read.
 */
export interface Profile {
  chatId: number;
  lang: Lang;
  workHours: WorkHours;
  location: LatLon & { source: 'default' | 'custom' };
  active: boolean;
  /** why `active` is false: `/stop`, or the bot got blocked by the friend (absent before 17/09/2026) */
  inactiveReason?: 'stopped' | 'blocked';
  awaiting?: 'hours';
  /** from how many stars the bot says to go surf; absent = the common threshold (`SCORING.good`) */
  minStars?: number;
  createdAt: string;
  /** name and Telegram handle, on one line, for the admin's `/friends` list */
  name?: string;
  username?: string;
}

export interface Region { id: string; name: string; tz: 'Africa/Johannesburg'; swellRef: LatLon }

export interface Spot {
  id: string;
  name: string;
  /** short label for tables (≤ 13 characters) */
  short: string;
  region: string;
  lat: number;
  lon: number;
  facing: number;
  swellWindow: [number, number];
  exposure: number;
  tide: { best: TideState[]; forbidden: TideState[] };
  levels: Partial<Record<Level, [number, number]>>;
  character: 'mellow' | 'punchy' | 'heavy';
  verified: boolean;
  notes?: string;
}

// ---- normalized hourly series (adapter outputs, engine inputs) ----
export interface SwellComponent { heightM: number; periodS: number; directionDeg: number }
export interface SwellHour {
  time: string; primary: SwellComponent; secondary: SwellComponent; seaLevelM: number;
  /** peak swell period (gwam); absent if the model doesn't publish it */
  peakPeriodS?: number;
  /** sea surface temperature (°C); absent if the model doesn't publish it for this hour */
  seaTempC?: number;
}
export interface WindHour {
  time: string; windKt: number; windDirDeg: number; gustKt: number;
  tempC: number; precipMm: number; weatherCode: number;
}
export interface DailySun { date: string; sunrise: string; sunset: string; tempMaxC: number; tempMinC: number; precipMm: number }

// ---- engine outputs ----
/**
 * What makes up an hour's rating. `swell` = the surf-forecast base rating scaled to 0..1 (base / 10),
 * `wind` = the current wind state's multiplier; `day` and `weather` don't affect the stars, they
 * only say whether the hour can count toward a session.
 */
export interface HourFactors { swell: number; wind: number; day: number; weather: number }
export interface SpotHour {
  time: string;
  /** swell directed at the spot, at its cell (m) — the height surf-forecast rates on */
  heightM: number; periodS: number; swellDirDeg: number;
  windKt: number; windDirDeg: number; windState: WindState;
  tide: { state: TideState; trend: TideTrend };
  /** pure surf-forecast rating, 0..10, even at night */
  stars: number;
  /** "gold" stars: no onshore component */
  clean: boolean;
  factors: HourFactors;
  /** the stars if the hour has daylight and no storm, 0 otherwise: this is what windows and the verdict read */
  score: number;
}
export interface Window { start: string; end: string; peak: number; mean: number }
export interface SpotResult {
  spotId: string; distanceKm: number;
  hours: SpotHour[]; windows: Window[]; best?: Window; maxScore: number;
  /** the day's water temperature at the spot, to the degree: average of daylight hours (of evaluated hours if there are none); absent without data */
  waterTempC?: number;
}
export interface TideEvent { time: string; kind: 'high' | 'low'; heightM: number }
/** A friend who said "I'm going": where, and when they said it. */
export interface GoingEntry { chatId: number; spotId: string; at: string }
export interface RawConditions { swellHeightM: number; periodS: number; swellDirDeg: number; windKt: number; windDirDeg: number }
export interface SpotPick { spotId: string; window: Window }

export type Verdict =
  | { kind: 'green'; spotId: string; window: Window; epic: boolean }
  | { kind: 'yellow'; dawn?: SpotPick; dusk?: SpotPick }
  | { kind: 'red'; bestSpotId?: string }
  | { kind: 'outOfCoverage'; raw?: RawConditions; nearest: { spotId: string; distanceKm: number }[] }
  | { kind: 'noData'; reason: string };

export interface Report {
  chatId: number;
  date: string;
  /** the friend's threshold at calculation time; absent in reports written before 17/09/2026 */
  minStars?: number;
  mode: ReportMode;
  generatedAt: string;
  sentAt?: string;
  location: Profile['location'];
  radiusKm: number;
  verdict: Verdict;
  spots: SpotResult[];
  tides: TideEvent[];
  weather: { tempMaxC: number; tempMinC: number; precipMm: number; code: number };
  sun: { sunrise: string; sunset: string };
}
