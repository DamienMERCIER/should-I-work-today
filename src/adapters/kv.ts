import { ALERTED_TTL_S, GOING_TTL_S, LANGS, LOCK_TTL_S, REPORT_TTL_S } from '../config';
import type { GoingEntry, Profile, Report, SpotHour, SpotResult } from '../types';
import { sleep as defaultSleep } from './http';

/**
 * Fields an earlier version wrote that nothing reads anymore: level, board, and the step of the old
 * two-question onboarding (removed on 2026-09-16, now that the rating is surf-forecast's). Keeping them
 * would leave a friend stuck between the two questions stranded outside the evening sends, which used
 * to filter out profiles still mid-onboarding.
 */
const LEGACY_KEYS = ['level', 'board', 'onboarding'] as const;

/**
 * The profile's closed fields come from KV, not from code: a removed language (French,
 * on 2026-09-16) or a corrupted one would index `STRINGS` with `undefined`, which `fill` turns into
 * an exception — so a rendering failure rather than a simple degradation.
 * An entry that isn't an object passes through as-is: consumers already handle that case,
 * and failing here would deprive every other profile of its run.
 */
function withSupportedFields(p: Profile): Profile {
  if (!p || typeof p !== 'object') return p;
  const lang = LANGS.includes(p.lang) ? p.lang : 'en';
  const legacy = LEGACY_KEYS.some((k) => k in p);
  if (lang === p.lang && !legacy) return p;
  const next: Record<string, unknown> = { ...p, lang };
  for (const k of LEGACY_KEYS) delete next[k];
  return next as unknown as Profile;
}

/**
 * All of a day's reports share a single KV key: this check must never throw, or one corrupted
 * record (partial write, future schema) would fail the read for everyone.
 * Each level is therefore checked before being read, and a suspect report is simply discarded.
 */
const hasCurrentShape = (r: Report): boolean =>
  Boolean(r) && Array.isArray(r.spots) &&
  r.spots.every((s) => Boolean(s) && Array.isArray(s.hours) && s.hours.every((h) => Boolean(h) && typeof h.stars === 'number'));

export interface KVListResult {
  keys: { name: string; metadata?: unknown }[];
  list_complete: boolean;
  cursor?: string;
}

/**
 * A day's reports store each spot-day only once. All friends in one send share the same evaluation
 * of a spot (§buildReportList) and differ only by distance: at 40 friends, the old format (one full
 * report per friend) weighed 2.7 MB, serialized twice in the evening and read back again in the morning
 * (17/09/2026).
 * The `hours` array acts as identity: the `{ ...evaluated, distanceKm }` copies share it, and two
 * different days for the same spot — e.g. the morning keeping an evening report for a friend with no data — stay separate.
 */
type StoredSpotDay = Omit<SpotResult, 'spotId' | 'distanceKm'>;
interface StoredSpotRef { spotId: string; distanceKm: number; day: number }
interface StoredReports {
  v: 2;
  days: StoredSpotDay[];
  reports: Record<string, Omit<Report, 'spots'> & { spots: StoredSpotRef[] }>;
}

function packReports(reports: Record<string, Report>): StoredReports {
  const dayIndex = new Map<SpotHour[], number>();
  const days: StoredSpotDay[] = [];
  const packed: StoredReports['reports'] = {};
  for (const [id, report] of Object.entries(reports)) {
    const spots = report.spots.map(({ spotId, distanceKm, ...day }) => {
      let index = dayIndex.get(day.hours);
      if (index === undefined) {
        index = days.push(day) - 1;
        dayIndex.set(day.hours, index);
      }
      return { spotId, distanceKm, day: index };
    });
    packed[id] = { ...report, spots };
  }
  return { v: 2, days, reports: packed };
}

const isPacked = (stored: unknown): stored is StoredReports =>
  typeof stored === 'object' && stored !== null && (stored as StoredReports).v === 2 &&
  Array.isArray((stored as StoredReports).days) && typeof (stored as StoredReports).reports === 'object';

/** A report that points to a missing day keeps a `null` spot, which `hasCurrentShape` then discards. */
function unpackReports(stored: unknown): Record<string, Report> {
  if (!isPacked(stored)) return (stored as Record<string, Report> | null) ?? {};
  const out: Record<string, Report> = {};
  for (const [id, report] of Object.entries(stored.reports ?? {})) {
    if (!report || !Array.isArray(report.spots)) {
      out[id] = report as unknown as Report;
      continue;
    }
    const spots = report.spots.map((ref) => {
      const day = ref ? stored.days[ref.day] : undefined;
      return day ? { spotId: ref.spotId, distanceKm: ref.distanceKm, ...day } : null;
    });
    out[id] = { ...report, spots } as unknown as Report;
  }
  return out;
}

/** Subset of KVNamespace used by the app (easy to mock in tests). */
export interface KVStore {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<KVListResult>;
}

const isGoing = (x: unknown): x is Omit<GoingEntry, 'chatId'> =>
  typeof x === 'object' && x !== null && typeof (x as GoingEntry).spotId === 'string' && typeof (x as GoingEntry).at === 'string';

export type RunKind = 'evening' | 'morning' | 'week' | 'alert';

/**
 * One profile per key: two friends never overwrite the same entry. Until 17/09/2026, all profiles
 * shared the `profiles` key, read back then rewritten whole: two signups in the same second would
 * erase each other (KV keeps the last write), or the second one would be rejected (one write per second per key).
 */
const PROFILE_PREFIX = 'profile:';
/** The old shared key: read as a fallback for friends who haven't changed anything yet, never written again. */
const LEGACY_PROFILES_KEY = 'profiles';
/** The profile also travels in metadata (1,024 bytes allowed, ~200 used): a single `list` reads everyone. */
const METADATA_MAX_BYTES = 1024;
/** KV refuses a second write to the same key within the same second (429): a retry waits a bit longer. */
const SAME_KEY_RETRY_MS = 1100;

export interface StoreOptions {
  sleep?: (ms: number) => Promise<void>;
}

export class Store {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly kv: KVStore, opts: StoreOptions = {}) {
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private async legacyProfiles(): Promise<Record<string, Profile>> {
    const stored = ((await this.kv.get(LEGACY_PROFILES_KEY, 'json')) as Record<string, Profile> | null) ?? {};
    return Object.fromEntries(Object.entries(stored).map(([id, p]) => [id, withSupportedFields(p)]));
  }

  /**
   * All profiles: the old shared key first, then one `list` page after another, with the profile's
   * own entry taking priority. `list` can lag writes by up to a minute elsewhere on the network: a
   * friend who signed up or made a change right before a send may be missing from it or show up in
   * their previous state, and gets the next send instead.
   */
  async getProfiles(): Promise<Record<string, Profile>> {
    const all = await this.legacyProfiles();
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix: PROFILE_PREFIX, cursor });
      for (const { name, metadata } of page.keys) {
        const profile = (metadata ?? (await this.kv.get(name, 'json'))) as Profile | null;
        if (profile) all[name.slice(PROFILE_PREFIX.length)] = withSupportedFields(profile);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return all;
  }

  async getProfile(chatId: number): Promise<Profile | undefined> {
    const own = (await this.kv.get(`${PROFILE_PREFIX}${chatId}`, 'json')) as Profile | null;
    if (own) return withSupportedFields(own);
    return (await this.legacyProfiles())[String(chatId)];
  }

  /** Writes each profile under its own key (the others are left untouched). */
  async putProfiles(profiles: Record<string, Profile>): Promise<void> {
    for (const [id, profile] of Object.entries(profiles)) await this.putProfileAt(id, profile);
  }

  /** Read-modify-write of just this one profile: another friend can no longer erase it. */
  async updateProfile(chatId: number, update: (current: Profile | undefined) => Profile): Promise<Profile> {
    const next = update(await this.getProfile(chatId));
    await this.putProfileAt(String(chatId), next);
    return next;
  }

  private async putProfileAt(id: string, profile: Profile): Promise<void> {
    const key = `${PROFILE_PREFIX}${id}`;
    const value = JSON.stringify(profile);
    const options = new TextEncoder().encode(value).length <= METADATA_MAX_BYTES ? { metadata: profile } : undefined;
    await this.twice(() => this.kv.put(key, value, options));
  }

  /**
   * The 429 from a second write within the same second on the same key, or a transient failure: the same
   * write, once, a bit later. Without depending on the error's text; a second failure propagates as-is.
   */
  private async twice(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch {
      await this.sleep(SAME_KEY_RETRY_MS);
      await write();
    }
  }

  /**
   * "I'm going": one key per friend per date (`going:<date>:<chatId>`), with the spot and time also in
   * metadata so a single `list` reads everything back. A friend only goes to one spot per day: the new
   * entry replaces the old one. A double tap lands within the same second on the same key, hence the retry.
   */
  async setGoing(date: string, chatId: number, spotId: string, at: string): Promise<void> {
    const entry = { spotId, at };
    await this.twice(() => this.kv.put(`going:${date}:${chatId}`, JSON.stringify(entry), { expirationTtl: GOING_TTL_S, metadata: entry }));
  }

  /** Where a friend said they were going that day: one read, so only what changes gets written. */
  async goingOf(date: string, chatId: number): Promise<GoingEntry | undefined> {
    const entry = await this.kv.get(`going:${date}:${chatId}`, 'json');
    return isGoing(entry) ? { chatId, spotId: entry.spotId, at: entry.at } : undefined;
  }

  async cancelGoing(date: string, chatId: number): Promise<void> {
    await this.twice(() => this.kv.delete(`going:${date}:${chatId}`));
  }

  /**
   * Who's going that day. `list` can lag writes by up to a minute: the tap we just recorded might be
   * missing, and the caller adds it back in. An unreadable entry is skipped, never fatal to the list.
   */
  async goingOn(date: string): Promise<GoingEntry[]> {
    const prefix = `going:${date}:`;
    const entries: GoingEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix, cursor });
      for (const { name, metadata } of page.keys) {
        const chatId = Number(name.slice(prefix.length));
        if (!Number.isInteger(chatId)) continue;
        const entry = metadata ?? (await this.kv.get(name, 'json'));
        if (isGoing(entry)) entries.push({ chatId, spotId: entry.spotId, at: entry.at });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return entries;
  }

  /**
   * A report written before stars existed (16/09/2026) has no `stars`, `heightM`, or `windState`:
   * rendered as-is it produced "NaN–NaN m · undefined SE" and ten hollow stars, and the morning run
   * would have compared it to a fresh report and announced a fake change. We treat it as absent:
   * today gets recomputed, an older day answers "too old". These expire after 48h.
   */
  async getReports(date: string): Promise<Record<string, Report>> {
    const stored = unpackReports(await this.kv.get(`reports:${date}`, 'json'));
    return Object.fromEntries(Object.entries(stored).filter(([, r]) => hasCurrentShape(r)));
  }

  async putReports(date: string, reports: Record<string, Report>): Promise<void> {
    await this.kv.put(`reports:${date}`, JSON.stringify(packReports(reports)), { expirationTtl: REPORT_TTL_S });
  }

  /**
   * Friends already notified about a big day on this date. One key per friend (`alerted:<date>:<chatId>`):
   * two writes never collide, and a single `list` reads everyone back. These keys are written the day
   * before at the latest, well more than a minute before being read back: `list`'s lag never misses them.
   */
  async alertedChatIds(date: string): Promise<Set<number>> {
    const prefix = `alerted:${date}:`;
    const ids = new Set<number>();
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix, cursor });
      for (const { name } of page.keys) {
        const chatId = Number(name.slice(prefix.length));
        if (Number.isInteger(chatId)) ids.add(chatId);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return ids;
  }

  async markAlerted(date: string, chatId: number): Promise<void> {
    await this.kv.put(`alerted:${date}:${chatId}`, '1', { expirationTtl: ALERTED_TTL_S });
  }

  /** true if the lock was just acquired, false if it already existed (cron replayed, §11). */
  async acquireLock(date: string, run: RunKind, now: string): Promise<boolean> {
    const key = `run:${date}:${run}`;
    if (await this.kv.get(key, 'json')) return false;
    await this.kv.put(key, JSON.stringify({ startedAt: now }), { expirationTtl: LOCK_TTL_S });
    return true;
  }
}
