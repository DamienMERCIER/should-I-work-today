import { safeEqual, type FetchLike } from '../adapters/http';
import type { Store } from '../adapters/kv';
import type { Telegram, TgCallbackQuery, TgMessage, TgUpdate } from '../adapters/telegram';
import { LANGS, DEFAULT_LOCATION, RADIUS_KM } from '../config';
import { hasDaylightLeft } from '../engine/factors';
import { haversineKm } from '../engine/geo';
import { addDays, dateOf, floorHour } from '../engine/time';
import type { SpotTuple } from '../data/world';
import { buildReport, buildWeek, nearbySpots, type CollectDeps } from '../jobs/collect';
import { notifyAdmin } from '../jobs/runs';
import { detectLang, fill, STRINGS, type Strings } from '../render/i18n';
import { detailsMarkupFor, goButtonsMarkup, renderDetails, renderEvening, renderSpotDay, renderWeek, spotById, spotName, type RenderCtx, allSpotOrder } from '../render/messages';
import type { Lang, Profile, Region, Report, Spot } from '../types';
import { langKeyboard, persistentKeyboard, profileKeyboard } from './keyboards';
import { newProfile, parseHours, profileSummary, welcomeText } from './profile';
import { matchSpot, spotSlug, totalSpotCount } from './spotMatch';

export interface BotDeps {
  telegram: Telegram;
  store: Store;
  spots: Spot[];
  regions: Region[];
  fetchFn: FetchLike;
  inviteCode?: string;
  /** prévenu de chaque arrivée, refus et message d'inconnu */
  adminChatId?: number;
  radiusKm?: number;
  /** spots importés pour `/<spot>` et `/about` ; par défaut tout `spots-world.json` (les tests passent la liste qu'il leur faut) */
  worldTuples?: SpotTuple[];
  /** heure locale 'YYYY-MM-DDTHH:mm' */
  now: () => string;
}

/**
 * Un nom Telegram est libre : retours à la ligne, caractères de contrôle et inversions bidi y
 * fabriqueraient une fausse ligne « ⚙️ … a rejoint le bot » dans le message à l'admin. Le HTML, lui,
 * est échappé par `notifyAdmin`.
 */
const oneLine = (s = ''): string =>
  s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();

/** « Ivan Petrov (@ivan, id 42) » pour les messages à l'admin : l'id départage deux homonymes et se retrouve dans les logs. */
function who(msg: TgMessage): string {
  const name = oneLine(`${msg.from?.first_name ?? ''} ${msg.from?.last_name ?? ''}`);
  const handle = oneLine(msg.from?.username);
  const id = `id ${msg.chat.id}`;
  if (name) return `${name} (${handle ? `@${handle}, ` : ''}${id})`;
  return handle ? `@${handle} (${id})` : id;
}

const isButton = (text: string, key: 'backHome' | 'now'): boolean =>
  text === STRINGS.en.buttons[key] || text === STRINGS.ru.buttons[key];

/** Un chat_id Telegram est toujours un entier ; refuse toute autre valeur (ex. "__proto__") avant tout accès au store. */
const isChatId = (x: unknown): x is number => Number.isInteger(x);

const isValidLocation = (loc: { latitude: number; longitude: number }): boolean =>
  Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude) && Math.abs(loc.latitude) <= 90 && Math.abs(loc.longitude) <= 180;

const renderCtx = (lang: Lang, deps: BotDeps): RenderCtx => ({ lang, spots: new Map(deps.spots.map((s) => [s.id, s])) });

const collectDeps = (deps: BotDeps, now: string): CollectDeps =>
  ({ spots: deps.spots, regions: deps.regions, fetchFn: deps.fetchFn, radiusKm: deps.radiusKm, now });

/**
 * « Maintenant » n'a de sens que tant qu'il reste du jour : passe la derniere heure surfable, chaque
 * creneau restant vaut 0 et le rapport n'est qu'un mur de zeros qui n'apprend rien. On repond alors
 * pour demain (mode soiree), et l'appelant prefixe `dayIsDone` puisque la date n'est plus celle du
 * jour. Un rapport sans aucun spot evalue (Open-Meteo muet, hors couverture) n'est pas bascule :
 * demain serait tout aussi vide, et ce serait une seconde serie d'appels pour rien.
 */
async function nowReport(profile: Profile, deps: BotDeps): Promise<Report> {
  const now = deps.now();
  const today = dateOf(now);
  const fromTime = floorHour(now);
  const report = await buildReport({ profile, date: today, mode: 'now', fromTime }, collectDeps(deps, now));
  if (report.spots.length === 0 || hasDaylightLeft(fromTime, report.sun.sunrise, report.sun.sunset)) return report;
  return buildReport({ profile, date: addDays(today, 1), mode: 'evening' }, collectDeps(deps, now));
}

/**
 * La semaine à venir (`buildWeek`). Loin de tout spot connu, on répond comme /now : sept rapports hors
 * couverture coûteraient deux appels chacun pour dire sept fois la même chose.
 */
async function handleWeek(chatId: number, profile: Profile, deps: BotDeps): Promise<void> {
  const ctx = renderCtx(profile.lang, deps);
  if (nearbySpots(deps.spots, profile.location, deps.radiusKm ?? RADIUS_KM).length === 0) {
    await deps.telegram.sendMessage(chatId, renderEvening(await nowReport(profile, deps), ctx));
    return;
  }
  const now = deps.now();
  await deps.telegram.sendMessage(chatId, renderWeek(await buildWeek(profile, collectDeps(deps, now)), ctx, { today: dateOf(now) }));
}

/** Le prefixe a coller devant un rapport « maintenant » que `nowReport` a bascule sur demain. */
const rolloverPrefix = (report: Report, deps: BotDeps, s: Strings): string =>
  report.date === dateOf(deps.now()) ? '' : `${s.dayIsDone}\n\n`;

/**
 * The report `/all`, `/<spot>` and the `rep:<today>` callback all show: today's report from KV if a
 * run already stored one, otherwise a fresh `now`-mode computation (same fallback `handleDetails`
 * already used for `date === today`, factored out here rather than duplicated).
 */
async function todayReport(chatId: number, profile: Profile, deps: BotDeps): Promise<Report> {
  const today = dateOf(deps.now());
  const stored = (await deps.store.getReports(today))[String(chatId)];
  return stored ?? nowReport(profile, deps);
}

/**
 * Telegram does not linkify a command inside a `<pre>` block, so `/all`'s per-spot sparkline rows
 * are not tappable there — this plain-text line after the block repeats them as `/slug` commands, in
 * the same order, so they are. Uses `allSpotOrder` (capped), not `openSpotOrder`, so this line can
 * never list more spots than the rows shown above it — see `ALL_SPOTS_CAP`.
 */
function allSpotsCommandLine(report: Report, ctx: RenderCtx): string {
  return allSpotOrder(report)
    .map((id) => spotById(id, ctx))
    .filter((spot): spot is Spot => spot !== undefined)
    .map((spot) => `/${spotSlug(spot)}`)
    .join(' · ');
}

/**
 * `/<spot>`: resolve the text after `/` against the whole spot database (`deps.spots`, not just
 * today's report — a spot can be known but outside the user's radius). Returns `false` when nothing
 * matched, so the caller falls back to the help text like any other unrecognised command.
 */
async function handleSpotCommand(chatId: number, query: string, profile: Profile, deps: BotDeps): Promise<boolean> {
  const s = STRINGS[profile.lang];
  const match = matchSpot(query, deps.spots, deps.worldTuples);
  if (match.kind === 'none') return false;

  const ctx = renderCtx(profile.lang, deps);
  if (match.kind === 'ambiguous') {
    const list = match.spots.map((spot) => `/${spotSlug(spot)}`).join(', ');
    await deps.telegram.sendMessage(chatId, fill(s.spotCommand.ambiguous, { list }));
    return true;
  }

  const { spot } = match;
  ctx.spots.set(spot.id, spot); // un spot importé n'est pas dans le contexte, qui ne tient que les spots curatés
  const radiusKm = deps.radiusKm ?? RADIUS_KM;
  const distanceKm = haversineKm(profile.location, spot);
  if (distanceKm > radiusKm) {
    await deps.telegram.sendMessage(chatId, fill(s.spotCommand.outOfRadius, {
      spot: spotName(spot.id, ctx, s), km: Math.round(distanceKm), radius: radiusKm,
    }));
    return true;
  }

  const report = await todayReport(chatId, profile, deps);
  // `renderSpotDay` ne porte aucune date : sans ce prefixe, un rapport bascule sur demain passerait
  // pour celui d'aujourd'hui.
  await deps.telegram.sendMessage(chatId, `${rolloverPrefix(report, deps, s)}${renderSpotDay(report, spot.id, ctx)}`, goButtonsMarkup(report, ctx, { spotId: spot.id }));
  return true;
}

export async function handleUpdate(update: TgUpdate, deps: BotDeps): Promise<void> {
  if (update.callback_query) return handleCallback(update.callback_query, deps);
  const msg = update.message;
  if (!msg || msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  if (!isChatId(chatId)) return;
  const text = msg.text?.trim() ?? '';
  let profile = await deps.store.getProfile(chatId);

  if (text.startsWith('/start')) return handleStart(msg, profile, deps);
  // inconnu sans /start : silence pour lui (bot privé), mais l'admin voit qui frappe à la porte
  if (!profile) return notifyAdmin(deps, `${who(msg)} a écrit au bot sans l'avoir rejoint.`);
  const s = STRINGS[profile.lang];
  const { telegram, store } = deps;

  if (text.length > 512) return void (await telegram.sendMessage(chatId, s.help));

  if (profile.awaiting === 'hours') {
    const escapes = text.startsWith('/') || isButton(text, 'now') || isButton(text, 'backHome') || Boolean(msg.location);
    if (!escapes) return handleHours(chatId, text, profile, deps);
    profile = await store.updateProfile(chatId, (cur) => {
      const next = { ...(cur ?? profile!) };
      delete next.awaiting;
      return next;
    });
  }

  if (msg.location) {
    if (!isValidLocation(msg.location)) return;
    const { latitude: lat, longitude: lon } = msg.location;
    const updated = await store.updateProfile(chatId, (cur) => ({ ...(cur ?? profile!), location: { lat, lon, source: 'custom' } }));
    const report = await nowReport(updated, deps);
    const ctx = renderCtx(profile.lang, deps);
    await telegram.sendMessage(chatId, `${rolloverPrefix(report, deps, s)}${renderEvening(report, ctx)}\n\n${s.locationSaved}`, detailsMarkupFor(report, ctx));
    return;
  }
  if (text === '/now' || isButton(text, 'now')) {
    const report = await nowReport(profile, deps);
    const ctx = renderCtx(profile.lang, deps);
    await telegram.sendMessage(chatId, `${rolloverPrefix(report, deps, s)}${renderEvening(report, ctx)}`, detailsMarkupFor(report, ctx));
    return;
  }
  if (text.startsWith('/week')) {
    await handleWeek(chatId, profile, deps);
    return;
  }
  if (isButton(text, 'backHome')) {
    await store.updateProfile(chatId, (cur) => ({ ...(cur ?? profile!), location: { ...DEFAULT_LOCATION, source: 'default' } }));
    await telegram.sendMessage(chatId, s.backHomeDone);
    return;
  }
  if (text.startsWith('/profil')) {
    await telegram.sendMessage(chatId, profileSummary(profile, s), profileKeyboard(s));
    return;
  }
  if (text.startsWith('/lang')) {
    await telegram.sendMessage(chatId, s.lang.ask, langKeyboard());
    return;
  }
  if (text.startsWith('/stop')) {
    await store.updateProfile(chatId, (cur) => ({ ...(cur ?? profile!), active: false }));
    await telegram.sendMessage(chatId, s.stopped);
    return;
  }
  if (text.startsWith('/all')) {
    const report = await todayReport(chatId, profile, deps);
    const ctx = renderCtx(profile.lang, deps);
    const body = renderDetails(report, ctx, { all: true });
    const commandLine = allSpotsCommandLine(report, ctx);
    await telegram.sendMessage(chatId, commandLine ? `${body}\n\n${commandLine}` : body, goButtonsMarkup(report, ctx));
    return;
  }
  if (text.startsWith('/about')) {
    await telegram.sendMessage(chatId, fill(s.about.text, { count: totalSpotCount(deps.spots, deps.worldTuples) }));
    return;
  }
  if (text.startsWith('/')) {
    const query = text.slice(1).split(/[\s@]/)[0];
    if (await handleSpotCommand(chatId, query, profile, deps)) return;
  }
  await telegram.sendMessage(chatId, s.help);
}

async function handleStart(msg: TgMessage, profile: Profile | undefined, deps: BotDeps): Promise<void> {
  const chatId = msg.chat.id;
  const code = (msg.text ?? '').split(/\s+/)[1];
  if (!profile) {
    const lang = detectLang(msg.from?.language_code);
    if (!deps.inviteCode || !safeEqual(code ?? '', deps.inviteCode)) {
      console.warn(`invite refused for chat ${chatId}`);
      await deps.telegram.sendMessage(chatId, STRINGS[lang].privateBot);
      const why = !deps.inviteCode ? "INVITE_CODE n'est pas configuré" : code ? "mauvais code d'invitation" : "/start sans code d'invitation";
      await notifyAdmin(deps, `Accès refusé à ${who(msg)} : ${why}.`);
      return;
    }
    // Plus de questions : la note ne dépend ni du niveau ni de la planche, le profil est prêt tout de suite.
    const created = await deps.store.updateProfile(chatId, () => newProfile(chatId, lang, deps.now()));
    const s = STRINGS[created.lang];
    await deps.telegram.sendMessage(chatId, welcomeText(created, s), persistentKeyboard(s));
    await notifyAdmin(deps, `${who(msg)} a rejoint le bot.`);
    return;
  }
  const s = STRINGS[profile.lang];
  const p = await deps.store.updateProfile(chatId, (cur) => ({ ...(cur ?? profile), active: true }));
  await deps.telegram.sendMessage(chatId, `${s.reactivated}\n${profileSummary(p, s)}`, persistentKeyboard(s));
}

async function handleHours(chatId: number, text: string, profile: Profile, deps: BotDeps): Promise<void> {
  const s = STRINGS[profile.lang];
  const hours = parseHours(text);
  if (!hours) {
    await deps.telegram.sendMessage(chatId, s.profile.badHours);
    return;
  }
  const p = await deps.store.updateProfile(chatId, (cur) => {
    const next = { ...(cur ?? profile), workHours: hours };
    delete next.awaiting;
    return next;
  });
  await deps.telegram.sendMessage(chatId, `${s.profile.saved}\n${profileSummary(p, s)}`);
}

async function handleCallback(cb: TgCallbackQuery, deps: BotDeps): Promise<void> {
  await deps.telegram.answerCallbackQuery(cb.id);
  if (cb.message && cb.message.chat.type !== 'private') return;
  const chatId = cb.message?.chat.id ?? cb.from.id;
  if (!isChatId(chatId)) return;
  const profile = await deps.store.getProfile(chatId);
  if (!profile) return;
  const s = STRINGS[profile.lang];
  const [kind, value = ''] = (cb.data ?? '').split(':');
  const { telegram, store } = deps;

  // `lvl:*`, `board:*`, `prof:level` et `prof:board` venaient de l'ancien onboarding : leurs boutons
  // peuvent encore traîner dans l'historique d'un chat, ils tombent dans `default` et ne font rien.
  switch (kind) {
    case 'prof': {
      if (value === 'hours') {
        await store.updateProfile(chatId, (cur) => ({ ...(cur ?? profile), awaiting: 'hours' }));
        await telegram.sendMessage(chatId, s.profile.askHours);
      }
      return;
    }
    case 'lang': {
      if (!LANGS.includes(value as Lang)) return;
      const lang = value as Lang;
      await store.updateProfile(chatId, (cur) => ({ ...(cur ?? profile), lang }));
      await telegram.sendMessage(chatId, STRINGS[lang].lang.set, persistentKeyboard(STRINGS[lang]));
      return;
    }
    case 'rep':
      return handleDetails(chatId, value, profile, deps);
    default:
      return;
  }
}

async function handleDetails(chatId: number, date: string, profile: Profile, deps: BotDeps): Promise<void> {
  const s = STRINGS[profile.lang];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const now = deps.now();
  const today = dateOf(now);
  let report: Report | undefined = date === today
    ? await todayReport(chatId, profile, deps)
    : (await deps.store.getReports(date))[String(chatId)];
  if (!report && date === addDays(today, 1)) {
    report = await buildReport({ profile, date, mode: 'evening' }, collectDeps(deps, now));
  }
  if (!report) {
    await deps.telegram.sendMessage(chatId, s.details.tooOld);
    return;
  }
  await deps.telegram.sendMessage(chatId, renderDetails(report, renderCtx(profile.lang, deps)));
}
