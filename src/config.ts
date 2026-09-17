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

/**
 * UTC. evening = 19:00 SAST, morning = 06:00 SAST, week = dimanche 19:05 SAST — après le verdict de 19:00, dans sa propre invocation ;
 * alert = 12:00 SAST, les grosses journées à venir, loin des autres envois.
 * Cloudflare compte les jours de 1 (dimanche) à 7 et refuse le 0 d'Unix au déploiement : `SUN` lève l'ambiguïté. Le handler
 * reçoit la chaîne telle quelle, elle doit rester identique à wrangler.toml.
 */
export const CRON = { evening: '0 17 * * *', morning: '0 4 * * *', week: '5 17 * * SUN', alert: '0 10 * * *' } as const;
/** Les jours que regarde l'alerte de midi, après aujourd'hui : assez tôt pour libérer sa journée, assez près pour que la prévision tienne. */
export const ALERT_DAYS_AHEAD: readonly number[] = [2, 3];
/** Qui a été prévenu de quelle date : gardé au-delà de la date la plus lointaine (J+3), puis oublié. */
export const ALERTED_TTL_S = 5 * 24 * 3600;
export const REPORT_TTL_S = 48 * 3600;
export const LOCK_TTL_S = 6 * 3600;
/** Qui va surfer quel jour (bouton 🙋) : gardé jusqu'au lendemain de la date au moins, puis oublié. */
export const GOING_TTL_S = 3 * 24 * 3600;
/**
 * Requêtes externes (fetch : Open-Meteo, Telegram) par invocation : 50 sur le plan gratuit, les lectures et écritures
 * KV ayant leur propre limite de 1 000. 3 gardées pour les alertes admin d'un envoi qui échoue. Les nouveaux essais
 * passagers (un par appel Open-Meteo, un par envoi Telegram refusé en 429) entament aussi cette marge : à 40 amis sur
 * une zone (43 requêtes), il en reste 7.
 */
export const MAX_EXTERNAL_SUBREQUESTS = 47;

// Valeurs admises du seul champ fermé du profil : une seule source, lue par le routeur
// (validation des callbacks) et par le Store (données KV écrites par une version antérieure).
export const LANGS: readonly Lang[] = ['en', 'ru'];

/**
 * Les seuils qu'un ami peut choisir dans `/profil` : à partir de combien d'étoiles le bot lui dit d'aller surfer.
 * Sous 3★ il n'y a pas de créneau du tout (`SCORING.windowMin`), au-delà de 6★ les journées se comptent dans l'année.
 */
export const STAR_CHOICES: readonly number[] = [3, 4, 5, 6];
