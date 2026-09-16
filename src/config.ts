import type { Board, Lang, Level } from './types';

export const DEFAULT_LOCATION = { lat: -34.1085, lon: 18.4715 } as const;
export const DEFAULT_LOCATION_NAME = 'Muizenberg';
export const RADIUS_KM = 20;
export const FAR_FROM_COAST_KM = 150;
export const TZ = 'Africa/Johannesburg';
/** SAST = UTC+2 toute l'année (pas d'heure d'été en Afrique du Sud). */
export const TZ_OFFSET_MIN = 120;
export const DEFAULT_WORK_HOURS = { start: '09:00', end: '18:00' } as const;
export const M_TO_FT = 3.28;

type Curve = ReadonlyArray<readonly [kt: number, factor: number]>;

export const SCORING = {
  windowMin: 6,
  good: 7,
  epic: 9,
  greenWorkOverlapH: 2,
  sessionMinH: 1.5,
  swellWindowToleranceDeg: 20,
  swellOutOfWindowWeight: 0.5,
  periodFloorS: 7,
  periodFullS: 11,
  periodFloorFactor: 0.3,
  kPeriod: { perSecond: 0.05, refS: 8, min: 0.9, max: 1.3 },
  sizeBelowFalloffFt: 1,
  sizeAboveFalloffFt: 2,
  boardShiftFt: 1,
  wind: {
    offshoreMaxAngle: 45,
    crossMaxAngle: 100,
    // L'offshore n'est pas « gratuit » : au-dela d'une dizaine de noeuds il tient la levre debout,
    // envoie les embruns dans les yeux et rend la rame et le decollage tres durs. L'ancienne courbe
    // donnait 1,0 plein jusqu'a 15 kt, si bien qu'un SE de 16 kt a Kommetjie sortait a 9,8/10 quand
    // surf-forecast donnait 0/10 sur exactement la meme houle (2,2 m 12 s SW).
    offshore: [[10, 1], [15, 0.75], [20, 0.45], [25, 0.15], [30, 0]] as Curve,
    cross: [[8, 1], [15, 0.5], [25, 0]] as Curve,
    onshore: [[5, 1], [10, 0.5], [18, 0]] as Curve,
    // La rafale, toutes directions confondues : c'est elle qui hache la surface et fait rater les
    // decollages. Elle etait relevee a chaque heure et n'entrait dans aucun facteur. En dessous de
    // 25 kt c'est le bruit de fond d'une brise, donc sans effet.
    gust: [[25, 1], [35, 0.6], [45, 0.25], [55, 0]] as Curve,
  },
  tideOffPreferenceFactor: 0.6,
  daylightMinMinutes: 45,
  thunderstormCodes: [95, 96, 99] as readonly number[],
  deltaCauseThreshold: 0.15,
  deltaWindowShiftH: 1,
} as const;

export const CRON = { evening: '0 17 * * *', morning: '0 4 * * *' } as const;
export const REPORT_TTL_S = 48 * 3600;
export const LOCK_TTL_S = 6 * 3600;
export const MAX_SUBREQUEST_BUDGET = 45;

// Valeurs admises des champs fermés du profil : une seule source, lue par le routeur
// (validation des callbacks) et par le Store (données KV écrites par une version antérieure).
export const LANGS: readonly Lang[] = ['en', 'ru'];
export const LEVELS: readonly Level[] = ['beginner', 'intermediate', 'advanced'];
export const BOARDS: readonly Board[] = ['longboard', 'shortboard', 'both'];
