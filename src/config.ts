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
    offshore: [[15, 1], [25, 0.4], [35, 0]] as Curve,
    cross: [[8, 1], [15, 0.5], [25, 0]] as Curve,
    onshore: [[5, 1], [10, 0.5], [18, 0]] as Curve,
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
