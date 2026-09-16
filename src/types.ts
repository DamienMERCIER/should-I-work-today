export type Level = 'beginner' | 'intermediate' | 'advanced';
export type Board = 'longboard' | 'shortboard' | 'both';
export type Lang = 'en' | 'ru';
export type TideState = 'low' | 'mid' | 'high';
export type TideTrend = 'rising' | 'falling';
export type WindRelation = 'offshore' | 'cross' | 'onshore';
export type ReportMode = 'evening' | 'morning' | 'now';

export interface LatLon { lat: number; lon: number }

/** 'HH:MM' */
export interface WorkHours { start: string; end: string }

export interface Profile {
  chatId: number;
  lang: Lang;
  level: Level;
  board: Board;
  workHours: WorkHours;
  location: LatLon & { source: 'default' | 'custom' };
  active: boolean;
  onboarding?: 'level' | 'board';
  awaiting?: 'hours';
  createdAt: string;
}

export interface Region { id: string; name: string; tz: 'Africa/Johannesburg'; swellRef: LatLon }

export interface Spot {
  id: string;
  name: string;
  /** libellé court pour les tableaux (≤ 13 caractères) */
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

// ---- séries horaires normalisées (sorties des adaptateurs, entrées du moteur) ----
export interface SwellComponent { heightM: number; periodS: number; directionDeg: number }
export interface SwellHour {
  time: string; primary: SwellComponent; secondary: SwellComponent; seaLevelM: number;
  /** période pic de la houle (gwam) ; absente si le modèle ne la publie pas */
  peakPeriodS?: number;
}
export interface WindHour {
  time: string; windKt: number; windDirDeg: number; gustKt: number;
  tempC: number; precipMm: number; weatherCode: number;
}
export interface DailySun { date: string; sunrise: string; sunset: string; tempMaxC: number; tempMinC: number; precipMm: number }

// ---- sorties du moteur ----
export interface HourFactors { size: number; period: number; wind: number; tide: number; day: number; weather: number }
export interface SpotHour {
  time: string;
  faceFt: number; periodS: number; swellDirDeg: number;
  windKt: number; windDirDeg: number; gustKt: number; windRelation: WindRelation;
  tide: { state: TideState; trend: TideTrend };
  factors: HourFactors;
  score: number;
}
export interface Window { start: string; end: string; peak: number; mean: number }
export interface SpotResult {
  spotId: string; distanceKm: number; open: boolean;
  hours: SpotHour[]; windows: Window[]; best?: Window; maxScore: number;
}
export interface TideEvent { time: string; kind: 'high' | 'low'; heightM: number }
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
