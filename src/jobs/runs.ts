import { sleep as defaultSleep, type FetchLike } from '../adapters/http';
import type { RunKind, Store } from '../adapters/kv';
import type { ReplyMarkup, Telegram } from '../adapters/telegram';
import { ALERT_DAYS_AHEAD, MAX_EXTERNAL_SUBREQUESTS, RADIUS_KM } from '../config';
import { compareReports } from '../engine/delta';
import { addDays, dateOf } from '../engine/time';
import { detailsMarkupFor, esc, renderAlert, renderEvening, renderMorning, renderWeek, type RenderCtx } from '../render/messages';
import type { Lang, Profile, Region, Report, Spot } from '../types';
import { buildReportList, buildReports, minStars, nearbyByPlace, placeKey, WEEK_DAYS, type EvalRequest } from './collect';

export interface JobDeps {
  store: Store;
  telegram: Telegram;
  spots: Spot[];
  regions: Region[];
  fetchFn: FetchLike;
  radiusKm?: number;
  adminChatId?: number;
  /** local time 'YYYY-MM-DDTHH:mm' */
  now: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export interface JobResult { skipped: boolean; sent: number; failed: number; date: string }

const KV_SAME_KEY_INTERVAL_MS = 1100;

// The "📍 Go to" buttons on a push carry coordinates fixed at send time: a message read the
// next morning keeps the link as-is, and there's no way to fix it after the fact (the bot
// never edits a markup it already sent). Accepted: a coordinate correction is rare and is
// measured in hundreds of meters, whereas the push is precisely the moment the button is most
// useful. The 📋 button, on the other hand, is a callback: it recalculates on every tap.

export async function notifyAdmin(deps: Pick<JobDeps, 'telegram' | 'adminChatId'>, text: string): Promise<void> {
  if (deps.adminChatId === undefined) return;
  await deps.telegram.sendMessage(deps.adminChatId, `⚙️ ${esc(text)}`);
}

/**
 * Planned external requests, the only ones counted against the 50 in the free plan (KV has its own limit):
 * 3 per region (marine + forecast + peak period) + 2 per out-of-coverage location (raw calls, shared by
 * friends at the same place, §buildReportList) + 1 send per profile.
 */
export function estimateBudget(profiles: Profile[], deps: JobDeps): number {
  const nearbyAt = nearbyByPlace(deps.spots, deps.radiusKm ?? RADIUS_KM);
  const regions = new Set<string>();
  const farPlaces = new Set<string>();
  for (const p of profiles) {
    const near = nearbyAt(p.location);
    if (near.length === 0) farPlaces.add(placeKey(p.location));
    for (const n of near) regions.add(n.spot.region);
  }
  return 3 * regions.size + 2 * farPlaces.size + profiles.length;
}

export async function runEvening(deps: JobDeps): Promise<JobResult> {
  return runJob('evening', addDays(dateOf(deps.now()), 1), deps);
}

export async function runMorning(deps: JobDeps): Promise<JobResult> {
  return runJob('morning', dateOf(deps.now()), deps);
}

const renderCtx = (lang: Lang, deps: JobDeps): RenderCtx => ({ lang, spots: new Map(deps.spots.map((s) => [s.id, s])) });

/**
 * Same language, same location, same work hours: same report (§buildReportList), so the same message. A send
 * drafts it once per group, not once per friend. The rendering doesn't read anything else from the profile:
 * adding personal text to these messages would require widening this key.
 */
const messageKey = (p: Profile): string => `${p.lang}|${placeKey(p.location)}|${p.workHours.start}-${p.workHours.end}|${minStars(p)}`;

/** The first call computes it, later calls with the same key reuse the result. */
function memoized<T>(compute: (key: string) => T): (key: string) => T {
  const done = new Map<string, T>();
  return (key) => {
    if (!done.has(key)) done.set(key, compute(key));
    return done.get(key) as T;
  };
}

async function runJob(kind: 'evening' | 'morning', date: string, deps: JobDeps): Promise<JobResult> {
  const now = deps.now();
  const sleep = deps.sleep ?? defaultSleep;
  if (!(await deps.store.acquireLock(date, kind, now))) return { skipped: true, sent: 0, failed: 0, date };

  const profiles = await withinBudget(activeProfiles(await deps.store.getProfiles()), deps, kind, date);
  const ctxFor = memoized((lang) => renderCtx(lang as Lang, deps));

  const previous = kind === 'morning' ? await deps.store.getReports(date) : {};
  const reqs: EvalRequest[] = profiles.map((profile) => ({ profile, date, mode: kind }));
  const reports = await buildReports(reqs, { spots: deps.spots, regions: deps.regions, fetchFn: deps.fetchFn, radiusKm: deps.radiusKm, now });

  // 1. decide what to send and what to store
  const toStore: Record<string, Report> = { ...previous };
  const outbox: { profile: Profile; text: string; markup?: ReplyMarkup }[] = [];
  const eveningMessages = new Map<string, { text: string; markup?: ReplyMarkup }>();
  for (const profile of profiles) {
    const report = reports.get(profile.chatId);
    if (!report) continue;
    const key = String(profile.chatId);
    const ctx = ctxFor(profile.lang);
    if (kind === 'evening') {
      toStore[key] = report;
      const group = messageKey(profile);
      let message = eveningMessages.get(group);
      if (!message) {
        message = { text: renderEvening(report, ctx), markup: detailsMarkupFor(report, ctx) };
        eveningMessages.set(group, message);
      }
      outbox.push({ profile, ...message });
      continue;
    }
    const evening = previous[key];
    const delta = compareReports(evening, report);
    // a morning with no data keeps the evening's report (§7.6)
    if (!(report.verdict.kind === 'noData' && evening)) toStore[key] = report;
    // a morning that goes to 🔴 says "go to work" without naming a spot: no 🙋 for a spot that's absent from the message
    if (delta.send) outbox.push({ profile, text: renderMorning(report, delta, evening, ctx), markup: detailsMarkupFor(report, ctx, { redBestNamed: false }) });
  }

  // 2. first write: the 📋 button works as soon as the message is received
  const firstWriteAt = Date.now();
  await deps.store.putReports(date, toStore);

  // 3. sends
  let sent = 0;
  let failed = 0;
  const blocked: number[] = [];
  for (const { profile, text, markup } of outbox) {
    const res = await deps.telegram.sendMessage(profile.chatId, text, markup);
    if (res.ok) {
      sent++;
      const entry = toStore[String(profile.chatId)];
      if (entry) entry.sentAt = now;
    } else {
      failed++;
      if (res.blocked) blocked.push(profile.chatId);
      console.error(`[${kind} ${date}] send to ${profile.chatId} failed — ${res.description}`);
      await notifyAdmin(deps, `${kind} ${date}: send to ${profile.chatId} failed — ${res.description}`);
    }
  }

  // 4. second write (sentAt), respecting 1 write/s/key — only if a send actually happened
  if (sent > 0) {
    const elapsed = Date.now() - firstWriteAt;
    if (elapsed < KV_SAME_KEY_INTERVAL_MS) await sleep(KV_SAME_KEY_INTERVAL_MS - elapsed);
    await deps.store.putReports(date, toStore);
  }

  await deactivateBlocked(blocked, deps);
  return { skipped: false, sent, failed, date };
}

const activeProfiles = (all: Record<string, Profile>): Profile[] =>
  Object.values(all).filter((p) => p.active).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** Budget exceeded (§10.1): defer the most recent profiles until back within budget. */
async function withinBudget(profiles: Profile[], deps: JobDeps, kind: RunKind, date: string): Promise<Profile[]> {
  const kept = [...profiles];
  let deferred = 0;
  while (kept.length > 0 && estimateBudget(kept, deps) > MAX_EXTERNAL_SUBREQUESTS) {
    kept.pop();
    deferred++;
  }
  if (deferred > 0) {
    const text = `${kind} ${date}: over budget — ${deferred} profile(s) deferred, fan-out needed`;
    console.warn(text);
    await notifyAdmin(deps, text);
  }
  return kept;
}

/** A user who has blocked the bot receives nothing further: we deactivate them rather than fail on every send. */
async function deactivateBlocked(blocked: number[], deps: JobDeps): Promise<void> {
  for (const chatId of blocked) {
    try {
      const p = await deps.store.getProfile(chatId);
      if (p) await deps.store.putProfiles({ [String(chatId)]: { ...p, active: false, inactiveReason: 'blocked' } });
    } catch (err) {
      // the messages have already gone out: a failure here must not make the whole send look like it failed; retried on the next send
      console.error(`could not switch ${chatId} off — ${String(err)}`);
    }
  }
}

/**
 * At noon, the big days ahead: for every active friend near a spot, D+2 and D+3. A 🟢 epic (≥ 6★ for long
 * enough) that hasn't been announced to them yet → one message, with all of their dates in it. An announced date
 * stops being announced, even if it moves from D+3 to D+2 the next day; a failed send isn't recorded, so it's
 * retried the next day. Nothing else is stored: the evening verdict, the day before, confirms it or not. Same
 * work-sharing as the other sends: one load per region, one evaluation per spot and per date, one message per
 * identical group of friends.
 */
export async function runAlert(deps: JobDeps): Promise<JobResult> {
  const now = deps.now();
  const today = dateOf(now);
  if (!(await deps.store.acquireLock(today, 'alert', now))) return { skipped: true, sent: 0, failed: 0, date: today };

  const nearbyAt = nearbyByPlace(deps.spots, deps.radiusKm ?? RADIUS_KM);
  const nearSpots = (p: Profile): boolean => nearbyAt(p.location).length > 0;
  const profiles = await withinBudget(activeProfiles(await deps.store.getProfiles()).filter(nearSpots), deps, 'alert', today);
  const dates = ALERT_DAYS_AHEAD.map((n) => addDays(today, n));
  const alerted = await Promise.all(dates.map((date) => deps.store.alertedChatIds(date)));

  const reqs: EvalRequest[] = profiles.flatMap((profile) => dates.map((date): EvalRequest => ({ profile, date, mode: 'evening' })));
  // the last day's tide reads through 3am the next day: today, the days before, this day and the next one
  const forecastDays = Math.max(...ALERT_DAYS_AHEAD) + 2;
  const reports = await buildReportList(reqs, { spots: deps.spots, regions: deps.regions, fetchFn: deps.fetchFn, radiusKm: deps.radiusKm, now }, { forecastDays });
  const ctxFor = memoized((lang) => renderCtx(lang as Lang, deps));
  const messages = new Map<string, string>();

  let sent = 0;
  let failed = 0;
  const blocked: number[] = [];
  for (const [i, profile] of profiles.entries()) {
    const epic = dates.flatMap((date, j) => {
      const report = reports[i * dates.length + j];
      const v = report.verdict;
      return v.kind === 'green' && v.epic && !alerted[j].has(profile.chatId) ? [report] : [];
    });
    if (epic.length === 0) continue;
    const group = `${messageKey(profile)}|${epic.map((r) => r.date).join(',')}`;
    let text = messages.get(group);
    if (text === undefined) {
      text = renderAlert(epic, ctxFor(profile.lang));
      messages.set(group, text);
    }
    const res = await deps.telegram.sendMessage(profile.chatId, text);
    if (!res.ok) {
      failed++;
      if (res.blocked) blocked.push(profile.chatId);
      console.error(`[alert ${today}] send to ${profile.chatId} failed — ${res.description}`);
      await notifyAdmin(deps, `alert ${today}: send to ${profile.chatId} failed — ${res.description}`);
      continue;
    }
    sent++;
    for (const report of epic) {
      try {
        await deps.store.markAlerted(report.date, profile.chatId);
      } catch (err) {
        // the message has gone out: worst case, the same date gets announced a second time tomorrow
        console.error(`the alert for ${report.date} to ${profile.chatId} went unrecorded — ${String(err)}`);
      }
    }
  }
  await deactivateBlocked(blocked, deps);
  return { skipped: false, sent, failed, date: today };
}

/**
 * On Sunday evening, the upcoming week, Monday → Sunday, to every active profile near a spot: profiles
 * far from everything would get seven empty lines, so we skip them. A single load per region for all
 * profiles and all days; the star rating, identical from one profile to another, is only evaluated
 * once (`buildReportList`). Nothing is stored: the week gets recalculated on demand with /week.
 */
export async function runWeek(deps: JobDeps): Promise<JobResult> {
  const now = deps.now();
  const today = dateOf(now);
  const monday = addDays(today, 1);
  if (!(await deps.store.acquireLock(monday, 'week', now))) return { skipped: true, sent: 0, failed: 0, date: monday };

  const nearbyAt = nearbyByPlace(deps.spots, deps.radiusKm ?? RADIUS_KM);
  const nearSpots = (p: Profile): boolean => nearbyAt(p.location).length > 0;
  const profiles = await withinBudget(activeProfiles(await deps.store.getProfiles()).filter(nearSpots), deps, 'week', monday);
  const ctxFor = memoized((lang) => renderCtx(lang as Lang, deps));
  const weekMessages = new Map<string, string>();

  const dates = Array.from({ length: WEEK_DAYS }, (_, i) => addDays(monday, i));
  const reqs: EvalRequest[] = profiles.flatMap((profile) => dates.map((date): EvalRequest => ({ profile, date, mode: 'evening' })));
  const reports = await buildReportList(reqs, { spots: deps.spots, regions: deps.regions, fetchFn: deps.fetchFn, radiusKm: deps.radiusKm, now }, { forecastDays: WEEK_DAYS + 1 });

  let sent = 0;
  let failed = 0;
  const blocked: number[] = [];
  for (const [i, profile] of profiles.entries()) {
    const group = messageKey(profile);
    let text = weekMessages.get(group);
    if (text === undefined) {
      text = renderWeek(reports.slice(i * WEEK_DAYS, (i + 1) * WEEK_DAYS), ctxFor(profile.lang), { today });
      weekMessages.set(group, text);
    }
    const res = await deps.telegram.sendMessage(profile.chatId, text);
    if (res.ok) {
      sent++;
    } else {
      failed++;
      if (res.blocked) blocked.push(profile.chatId);
      console.error(`[week ${monday}] send to ${profile.chatId} failed — ${res.description}`);
      await notifyAdmin(deps, `week ${monday}: send to ${profile.chatId} failed — ${res.description}`);
    }
  }
  await deactivateBlocked(blocked, deps);
  return { skipped: false, sent, failed, date: monday };
}
