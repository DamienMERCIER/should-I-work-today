import { sleep as defaultSleep, type FetchLike } from '../adapters/http';
import type { RunKind, Store } from '../adapters/kv';
import type { ReplyMarkup, Telegram } from '../adapters/telegram';
import { MAX_SUBREQUEST_BUDGET, RADIUS_KM } from '../config';
import { compareReports } from '../engine/delta';
import { addDays, dateOf } from '../engine/time';
import { detailsMarkupFor, esc, renderEvening, renderMorning, renderWeek, type RenderCtx } from '../render/messages';
import type { Lang, Profile, Region, Report, Spot } from '../types';
import { buildReportList, buildReports, nearbySpots, WEEK_DAYS, type EvalRequest } from './collect';

export interface JobDeps {
  store: Store;
  telegram: Telegram;
  spots: Spot[];
  regions: Region[];
  fetchFn: FetchLike;
  radiusKm?: number;
  adminChatId?: number;
  /** heure locale 'YYYY-MM-DDTHH:mm' */
  now: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export interface JobResult { skipped: boolean; sent: number; failed: number; date: string }

const KV_SAME_KEY_INTERVAL_MS = 1100;

// Les boutons « 📍 Go to » du push portent des coordonnées figées à l'envoi : un message lu le
// lendemain matin garde le lien tel quel, et rien ne permet de le corriger après coup (le bot
// n'édite jamais un markup déjà envoyé). Accepté : une correction de coordonnée est rare et se
// compte en centaines de mètres, alors que le push est justement le moment où le bouton sert le
// plus. Le bouton 📋, lui, est un callback : il recalcule à chaque appui.

export async function notifyAdmin(deps: Pick<JobDeps, 'telegram' | 'adminChatId'>, text: string): Promise<void> {
  if (deps.adminChatId === undefined) return;
  await deps.telegram.sendMessage(deps.adminChatId, `⚙️ ${esc(text)}`);
}

/**
 * Sous-requêtes prévues : verrou (2) + profils (1) [+ rapports veille (1)] + 3×régions (marine + forecast +
 * période pic) + 2×hors-couverture + 2 écritures + N envois. La semaine n'écrit pas de rapport : l'estimation
 * la surévalue de 2, ce qui ne fait que la rendre prudente.
 */
export function estimateBudget(profiles: Profile[], deps: JobDeps, kind: RunKind): number {
  const radiusKm = deps.radiusKm ?? RADIUS_KM;
  const regions = new Set<string>();
  let raw = 0;
  for (const p of profiles) {
    const near = nearbySpots(deps.spots, p.location, radiusKm);
    if (near.length === 0) raw += 2;
    for (const n of near) regions.add(n.spot.region);
  }
  return 3 + (kind === 'morning' ? 1 : 0) + 3 * regions.size + raw + 2 + profiles.length;
}

export async function runEvening(deps: JobDeps): Promise<JobResult> {
  return runJob('evening', addDays(dateOf(deps.now()), 1), deps);
}

export async function runMorning(deps: JobDeps): Promise<JobResult> {
  return runJob('morning', dateOf(deps.now()), deps);
}

const renderCtx = (lang: Lang, deps: JobDeps): RenderCtx => ({ lang, spots: new Map(deps.spots.map((s) => [s.id, s])) });

async function runJob(kind: Exclude<RunKind, 'week'>, date: string, deps: JobDeps): Promise<JobResult> {
  const now = deps.now();
  const sleep = deps.sleep ?? defaultSleep;
  if (!(await deps.store.acquireLock(date, kind, now))) return { skipped: true, sent: 0, failed: 0, date };

  const profiles = await withinBudget(activeProfiles(await deps.store.getProfiles()), deps, kind, date);

  const previous = kind === 'morning' ? await deps.store.getReports(date) : {};
  const reqs: EvalRequest[] = profiles.map((profile) => ({ profile, date, mode: kind }));
  const reports = await buildReports(reqs, { spots: deps.spots, regions: deps.regions, fetchFn: deps.fetchFn, radiusKm: deps.radiusKm, now });

  // 1. décider quoi envoyer et quoi stocker
  const toStore: Record<string, Report> = { ...previous };
  const outbox: { profile: Profile; text: string; markup?: ReplyMarkup }[] = [];
  for (const profile of profiles) {
    const report = reports.get(profile.chatId);
    if (!report) continue;
    const key = String(profile.chatId);
    const ctx = renderCtx(profile.lang, deps);
    if (kind === 'evening') {
      toStore[key] = report;
      outbox.push({ profile, text: renderEvening(report, ctx), markup: detailsMarkupFor(report, ctx) });
      continue;
    }
    const evening = previous[key];
    const delta = compareReports(evening, report);
    // un matin sans données garde le rapport du soir (§7.6)
    if (!(report.verdict.kind === 'noData' && evening)) toStore[key] = report;
    if (delta.send) outbox.push({ profile, text: renderMorning(report, delta, evening, ctx), markup: detailsMarkupFor(report, ctx) });
  }

  // 2. première écriture : le bouton 📋 fonctionne dès la réception
  const firstWriteAt = Date.now();
  await deps.store.putReports(date, toStore);

  // 3. envois
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
      console.error(`[${kind} ${date}] envoi à ${profile.chatId} échoué — ${res.description}`);
      await notifyAdmin(deps, `${kind} ${date}: envoi à ${profile.chatId} échoué — ${res.description}`);
    }
  }

  // 4. seconde écriture (sentAt), en respectant 1 écriture/s/clé — seulement si un envoi a eu lieu
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

/** Budget dépassé (§10.1) : reporter les profils les plus récents jusqu'à rentrer dans le budget. */
async function withinBudget(profiles: Profile[], deps: JobDeps, kind: RunKind, date: string): Promise<Profile[]> {
  const kept = [...profiles];
  let deferred = 0;
  while (kept.length > 0 && estimateBudget(kept, deps, kind) > MAX_SUBREQUEST_BUDGET) {
    kept.pop();
    deferred++;
  }
  if (deferred > 0) {
    const text = `${kind} ${date}: budget dépassé — ${deferred} profil(s) reportés, fan-out nécessaire`;
    console.warn(text);
    await notifyAdmin(deps, text);
  }
  return kept;
}

/** Un utilisateur qui a bloqué le bot ne reçoit plus rien : on le désactive plutôt que d'échouer à chaque envoi. */
async function deactivateBlocked(blocked: number[], deps: JobDeps): Promise<void> {
  if (blocked.length === 0) return;
  const all = await deps.store.getProfiles();
  for (const chatId of blocked) {
    const p = all[String(chatId)];
    if (p) p.active = false;
  }
  await deps.store.putProfiles(all);
}

/**
 * Le dimanche soir, la semaine à venir, lundi → dimanche, à chaque profil actif proche d'un spot : les
 * profils loin de tout recevraient sept lignes vides, on les saute. Une seule charge par région pour
 * tous les profils et tous les jours ; les étoiles, identiques d'un profil à l'autre, ne sont évaluées
 * qu'une fois (`buildReportList`). Rien n'est stocké : la semaine se recalcule à la demande avec /week.
 */
export async function runWeek(deps: JobDeps): Promise<JobResult> {
  const now = deps.now();
  const today = dateOf(now);
  const monday = addDays(today, 1);
  if (!(await deps.store.acquireLock(monday, 'week', now))) return { skipped: true, sent: 0, failed: 0, date: monday };

  const radiusKm = deps.radiusKm ?? RADIUS_KM;
  const nearSpots = (p: Profile): boolean => nearbySpots(deps.spots, p.location, radiusKm).length > 0;
  const profiles = await withinBudget(activeProfiles(await deps.store.getProfiles()).filter(nearSpots), deps, 'week', monday);

  const dates = Array.from({ length: WEEK_DAYS }, (_, i) => addDays(monday, i));
  const reqs: EvalRequest[] = profiles.flatMap((profile) => dates.map((date): EvalRequest => ({ profile, date, mode: 'evening' })));
  const reports = await buildReportList(reqs, { spots: deps.spots, regions: deps.regions, fetchFn: deps.fetchFn, radiusKm: deps.radiusKm, now }, { forecastDays: WEEK_DAYS + 1 });

  let sent = 0;
  let failed = 0;
  const blocked: number[] = [];
  for (const [i, profile] of profiles.entries()) {
    const week = reports.slice(i * WEEK_DAYS, (i + 1) * WEEK_DAYS);
    const res = await deps.telegram.sendMessage(profile.chatId, renderWeek(week, renderCtx(profile.lang, deps), { today }));
    if (res.ok) {
      sent++;
    } else {
      failed++;
      if (res.blocked) blocked.push(profile.chatId);
      console.error(`[week ${monday}] envoi à ${profile.chatId} échoué — ${res.description}`);
      await notifyAdmin(deps, `week ${monday}: envoi à ${profile.chatId} échoué — ${res.description}`);
    }
  }
  await deactivateBlocked(blocked, deps);
  return { skipped: false, sent, failed, date: monday };
}
