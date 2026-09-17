import { DEFAULT_LOCATION, DEFAULT_WORK_HOURS } from '../src/config';
import { REGIONS, SPOTS } from '../src/data/index';
import { addDays, dateOf, floorHour, nowLocal } from '../src/engine/time';
import { buildReport, buildWeek } from '../src/jobs/collect';
import { renderDetails, renderEvening, renderWeek } from '../src/render/messages';
import type { Profile } from '../src/types';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

/** Closed-set flag: falls back to the default when absent, exits 1 when outside the list. */
function choice<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = arg(name) ?? fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    console.error(`--${name} must be one of: ${allowed.join(', ')} (got "${value}")`);
    process.exit(1);
  }
  return value as T;
}

function numberArg(name: string, fallback: number): number {
  const raw = arg(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (Number.isNaN(value)) {
    console.error(`--${name} must be a number (got "${raw}")`);
    process.exit(1);
  }
  return value;
}

const now = nowLocal();
const date = arg('date') ?? addDays(dateOf(now), 1);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`--date must be in YYYY-MM-DD format (got "${date}")`);
  process.exit(1);
}
const mode = choice('mode', ['evening', 'now'] as const, date === dateOf(now) ? 'now' : 'evening');
const custom = arg('lat') !== undefined || arg('lon') !== undefined;
const profile: Profile = {
  chatId: 0,
  lang: choice('lang', ['en', 'ru'] as const, 'en'),
  workHours: { ...DEFAULT_WORK_HOURS },
  location: { lat: numberArg('lat', DEFAULT_LOCATION.lat), lon: numberArg('lon', DEFAULT_LOCATION.lon), source: custom ? 'custom' : 'default' },
  active: true,
  createdAt: now,
};

const plain = (html: string): string => html.replace(/<\/?b>/g, '');

if (process.argv.includes('--week')) {
  // the upcoming week exactly as /week would send it, on live data
  const collect = { spots: SPOTS, regions: REGIONS, fetchFn: (url: string, init?: RequestInit) => fetch(url, init), now };
  const ctx = { lang: profile.lang, spots: new Map(SPOTS.map((s) => [s.id, s])) };
  console.log(`# week · ${now} · ${profile.location.lat}, ${profile.location.lon}\n`);
  console.log(plain(renderWeek(await buildWeek(profile, collect), ctx, { today: dateOf(now) })));
  process.exit(0);
}

const report = await buildReport(
  { profile, date, mode, fromTime: mode === 'now' ? floorHour(now) : undefined },
  { spots: SPOTS, regions: REGIONS, fetchFn: (url, init) => fetch(url, init), now },
);
const ctx = { lang: profile.lang, spots: new Map(SPOTS.map((s) => [s.id, s])) };

console.log(`# ${mode} · ${date} · ${profile.location.lat}, ${profile.location.lon}\n`);
console.log(plain(renderEvening(report, ctx)));
console.log();
console.log(plain(renderDetails(report, ctx)));
if (process.argv.includes('--json')) console.log(`\n${JSON.stringify(report, null, 2)}`);
