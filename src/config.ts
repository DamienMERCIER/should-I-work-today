import type { Lang } from './types';

export const DEFAULT_LOCATION = { lat: -34.1085, lon: 18.4715 } as const;
export const DEFAULT_LOCATION_NAME = 'Muizenberg';
export const RADIUS_KM = 20;
export const FAR_FROM_COAST_KM = 150;
export const TZ = 'Africa/Johannesburg';
/** SAST = UTC+2 year round (no daylight saving time in South Africa). */
export const TZ_OFFSET_MIN = 120;
export const DEFAULT_WORK_HOURS = { start: '09:00', end: '18:00' } as const;

/**
 * Verdict thresholds, on the surf-forecast star scale (0..10, `src/engine/rating.ts`), for clean wind
 * and swell directed at the spot: 3★ from 1.1 m, decent and surfable, enough to form a window; 4★
 * from 2.0 m, a genuinely good day that justifies dropping work; 6★ from 3.3 m, exceptional.
 * The site rarely goes above 5 on the peninsula: on the old 0..10 scale of the personal score, `good 7`
 * would almost never have triggered.
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
  /** a cause is only named if it's worth at least one star on its own */
  deltaCauseThreshold: 1,
  deltaWindowShiftH: 1,
} as const;

/**
 * UTC. evening = 19:00 SAST, morning = 06:00 SAST, week = Sunday 19:05 SAST — after the 19:00 verdict, in its own invocation;
 * alert = 12:00 SAST, upcoming big days, kept apart from the other sends.
 * Cloudflare numbers days 1 (Sunday) through 7 and rejects Unix's 0 at deploy time: `SUN` removes the ambiguity. The handler
 * receives the string as-is; it must stay identical to wrangler.toml.
 */
export const CRON = { evening: '0 17 * * *', morning: '0 4 * * *', week: '5 17 * * SUN', alert: '0 10 * * *' } as const;
/** The days the noon alert looks at, after today: early enough to free up your day, close enough for the forecast to hold. */
export const ALERT_DAYS_AHEAD: readonly number[] = [2, 3];
/** Who was notified about which date: kept past the furthest date (D+3), then forgotten. */
export const ALERTED_TTL_S = 5 * 24 * 3600;
export const REPORT_TTL_S = 48 * 3600;
export const LOCK_TTL_S = 6 * 3600;
/** Who's surfing which day (🙋 button): kept until at least the day after that date, then forgotten. */
export const GOING_TTL_S = 3 * 24 * 3600;
/**
 * External requests (fetch: Open-Meteo, Telegram) per invocation: 50 on the free plan, with KV reads
 * and writes having their own limit of 1,000. 3 held back for admin alerts about a failed send. Transient
 * retries (one per Open-Meteo call, one per Telegram send rejected with 429) also eat into this margin:
 * at 40 friends in one zone (43 requests), 7 remain.
 */
export const MAX_EXTERNAL_SUBREQUESTS = 47;

// Accepted values for the profile's only closed field: a single source, read by the router
// (callback validation) and by the Store (KV data written by an earlier version).
export const LANGS: readonly Lang[] = ['en', 'ru'];

/**
 * The thresholds a friend can pick in `/profile`: from how many stars the bot tells them to go surf.
 * Below 3★ there's no window at all (`SCORING.windowMin`), above 6★ such days are counted per year.
 */
export const STAR_CHOICES: readonly number[] = [3, 4, 5, 6];
