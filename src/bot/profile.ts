import { DEFAULT_LOCATION, DEFAULT_LOCATION_NAME, DEFAULT_WORK_HOURS } from '../config';
import { fill, type Strings } from '../render/i18n';
import { fmtTime } from '../render/messages';
import type { Lang, Profile, WorkHours } from '../types';

export function newProfile(chatId: number, lang: Lang, now: string): Profile {
  return {
    chatId, lang,
    workHours: { ...DEFAULT_WORK_HOURS },
    location: { ...DEFAULT_LOCATION, source: 'default' },
    active: true, createdAt: now,
  };
}

const HOURS_RE = /^(\d{1,2})(?:[h:](\d{2})?)?\s*[-–]\s*(\d{1,2})(?:[h:](\d{2})?)?$/;

function toHhmm(h: string, m?: string): string | null {
  const hh = Number(h);
  const mm = Number(m ?? '0');
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** « 9h-18h », « 09:30 – 17:00 », « 9-18 » → { start, end } ; null si invalide ou start ≥ end. */
export function parseHours(text: string): WorkHours | null {
  const m = HOURS_RE.exec(text.trim());
  if (!m) return null;
  const start = toHhmm(m[1], m[2]);
  const end = toHhmm(m[3], m[4]);
  if (!start || !end || start >= end) return null;
  return { start, end };
}

export function profileSummary(p: Profile, s: Strings): string {
  const location = p.location.source === 'default'
    ? s.profile.locationDefault
    : fill(s.profile.locationCustom, { lat: p.location.lat.toFixed(3), lon: p.location.lon.toFixed(3) });
  return fill(s.profile.summary, { start: fmtTime(p.workHours.start), end: fmtTime(p.workHours.end), location });
}

export const welcomeText = (p: Profile, s: Strings): string =>
  fill(s.onboarding.welcome, { home: DEFAULT_LOCATION_NAME, start: fmtTime(p.workHours.start), end: fmtTime(p.workHours.end) });
