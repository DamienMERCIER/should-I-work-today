import type { Lang } from './types';

export const DEFAULT_LOCATION = { lat: -34.1085, lon: 18.4715 } as const;
export const DEFAULT_LOCATION_NAME = 'Muizenberg';
export const RADIUS_KM = 20;
export const FAR_FROM_COAST_KM = 150;
export const TZ = 'Africa/Johannesburg';
/** SAST = UTC+2 toute l'année (pas d'heure d'été en Afrique du Sud). */
export const TZ_OFFSET_MIN = 120;
export const DEFAULT_WORK_HOURS = { start: '09:00', end: '18:00' } as const;

/**
 * Seuils du verdict, sur l'échelle des étoiles surf-forecast (0..10, `src/engine/rating.ts`), par vent
 * propre et en houle dirigée vers le spot : 3★ dès 1,1 m, correct et surfable, de quoi former une
 * fenêtre ; 4★ dès 2,0 m, une vraie bonne journée qui justifie de lâcher le travail ; 6★ dès 3,3 m,
 * exceptionnel.
 * Le site dépasse rarement 5 sur la péninsule : sur l'ancienne échelle 0..10 du score perso, `good 7`
 * n'aurait presque jamais sonné.
 */
export const SCORING = {
  windowMin: 3,
  good: 4,
  epic: 6,
  greenWorkOverlapH: 2,
  sessionMinH: 1.5,
  swellWindowToleranceDeg: 20,
  swellOutOfWindowWeight: 0.5,
  daylightMinMinutes: 45,
  thunderstormCodes: [95, 96, 99] as readonly number[],
  /** une cause n'est nommée que si elle pèse au moins une étoile à elle seule */
  deltaCauseThreshold: 1,
  deltaWindowShiftH: 1,
} as const;

/** UTC. evening = 19:00 SAST, morning = 06:00 SAST, week = dimanche 19:05 SAST — après le verdict de 19:00, dans sa propre invocation. */
export const CRON = { evening: '0 17 * * *', morning: '0 4 * * *', week: '5 17 * * 0' } as const;
export const REPORT_TTL_S = 48 * 3600;
export const LOCK_TTL_S = 6 * 3600;
export const MAX_SUBREQUEST_BUDGET = 45;

// Valeurs admises du seul champ fermé du profil : une seule source, lue par le routeur
// (validation des callbacks) et par le Store (données KV écrites par une version antérieure).
export const LANGS: readonly Lang[] = ['en', 'ru'];
