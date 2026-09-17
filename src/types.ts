import type { WindState } from './engine/rating';

/** Les six états de vent de surf-forecast (`src/engine/rating.ts`). */
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
 * Ni niveau ni planche : la note est celle de surf-forecast, la même pour tout le monde
 * (§ RAPPORT-surf-forecast.md). Un profil écrit avant le 16/09/2026 peut encore porter `level`,
 * `board` et `onboarding` en KV : `Store` les retire à la lecture.
 */
export interface Profile {
  chatId: number;
  lang: Lang;
  workHours: WorkHours;
  location: LatLon & { source: 'default' | 'custom' };
  active: boolean;
  /** pourquoi `active` est faux : `/stop`, ou le bot bloqué par l'ami (absent avant le 17/09/2026) */
  inactiveReason?: 'stopped' | 'blocked';
  awaiting?: 'hours';
  createdAt: string;
  /** nom et pseudo Telegram, sur une ligne, pour la liste `/amis` de l'admin */
  name?: string;
  username?: string;
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
  /** température de l'eau en surface (°C) ; absente si le modèle ne la publie pas pour cette heure */
  seaTempC?: number;
}
export interface WindHour {
  time: string; windKt: number; windDirDeg: number; gustKt: number;
  tempC: number; precipMm: number; weatherCode: number;
}
export interface DailySun { date: string; sunrise: string; sunset: string; tempMaxC: number; tempMinC: number; precipMm: number }

// ---- sorties du moteur ----
/**
 * Ce qui fait la note d'une heure. `swell` = note de base surf-forecast ramenée sur 0..1 (base / 10),
 * `wind` = multiplicateur vent de l'état courant ; `day` et `weather` ne touchent pas les étoiles, ils
 * disent seulement si l'heure peut compter pour une session.
 */
export interface HourFactors { swell: number; wind: number; day: number; weather: number }
export interface SpotHour {
  time: string;
  /** houle dirigée vers le spot, à sa cellule (m) — la hauteur sur laquelle surf-forecast note */
  heightM: number; periodS: number; swellDirDeg: number;
  windKt: number; windDirDeg: number; windState: WindState;
  tide: { state: TideState; trend: TideTrend };
  /** note surf-forecast pure, 0..10, même de nuit */
  stars: number;
  /** étoiles « or » : pas de composante onshore */
  clean: boolean;
  factors: HourFactors;
  /** les étoiles si l'heure a du jour et pas d'orage, 0 sinon : c'est ce que lisent fenêtres et verdict */
  score: number;
}
export interface Window { start: string; end: string; peak: number; mean: number }
export interface SpotResult {
  spotId: string; distanceKm: number;
  hours: SpotHour[]; windows: Window[]; best?: Window; maxScore: number;
  /** l'eau du jour au spot, au degré : moyenne des heures de jour (des heures évaluées s'il n'y en a pas) ; absente sans donnée */
  waterTempC?: number;
}
export interface TideEvent { time: string; kind: 'high' | 'low'; heightM: number }
/** Un ami qui a dit « j'y vais » : où, et quand il l'a dit. */
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
