import { safeEqual, type FetchLike } from '../adapters/http';
import type { Store } from '../adapters/kv';
import type { Telegram, TgCallbackQuery, TgMessage, TgUpdate, TgUser } from '../adapters/telegram';
import { LANGS, DEFAULT_LOCATION, RADIUS_KM } from '../config';
import { hasDaylightLeft } from '../engine/factors';
import { haversineKm } from '../engine/geo';
import { addDays, dateOf, floorHour } from '../engine/time';
import type { SpotTuple } from '../data/world';
import { buildReport, buildWeek, nearbySpots, type CollectDeps } from '../jobs/collect';
import { notifyAdmin } from '../jobs/runs';
import { detectLang, fill, STRINGS, type Strings } from '../render/i18n';
import {
  detailsMarkupFor, expandCompactDate, fmtDate, goButtonsMarkup, notGoingData, renderDetails, renderEvening, renderSpotDay, renderWeek, spotById, spotMarkupFor, spotName,
  type RenderCtx, dayViewSpotOrder,
} from '../render/messages';
import type { Lang, Profile, Region, Report, Spot } from '../types';
import { langKeyboard, persistentKeyboard, profileKeyboard } from './keyboards';
import { renderFriends, telegramName } from './friends';
import { renderGoing } from './going';
import { newProfile, parseHours, profileSummary, welcomeText } from './profile';
import { matchSpot, spotSlug, totalSpotCount } from './spotMatch';
import { oneLine } from './text';

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

/** « Ivan Petrov (@ivan, id 42) » pour les messages à l'admin : l'id départage deux homonymes et se retrouve dans les logs. */
function who(msg: TgMessage): string {
  const name = oneLine(`${msg.from?.first_name ?? ''} ${msg.from?.last_name ?? ''}`);
  const handle = oneLine(msg.from?.username);
  const id = `id ${msg.chat.id}`;
  if (name) return `${name} (${handle ? `@${handle}, ` : ''}${id})`;
  return handle ? `@${handle} (${id})` : id;
}

const isButton = (text: string, key: 'backHome' | 'now' | 'useMyLocation'): boolean =>
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
 * Telegram does not linkify a command inside a `<code>` span, so the per-spot sparkline rows of 📋 and `/all` are not
 * tappable — this plain-text line after them repeats the spots shown as `/slug` commands, in the same order, and says
 * what tapping one gives. `ids` comes from `dayViewSpotOrder`, the same list as the rows (capped for `/all`, see
 * `ALL_SPOTS_CAP`), so the line never lists a spot the view does not show.
 */
function spotsCommandLine(ids: string[], ctx: RenderCtx, s: Strings): string {
  const list = ids
    .map((id) => spotById(id, ctx))
    .filter((spot): spot is Spot => spot !== undefined)
    .map((spot) => `/${spotSlug(spot)}`)
    .join(' · ');
  return list ? fill(s.spotCommand.detailsHint, { list }) : '';
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
  await deps.telegram.sendMessage(chatId, `${rolloverPrefix(report, deps, s)}${renderSpotDay(report, spot.id, ctx)}`, spotMarkupFor(report, spot.id, ctx));
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
  if (text.startsWith('/amis') && deps.adminChatId !== undefined && chatId === deps.adminChatId) {
    if (profile) await refreshName(chatId, profile, msg.from, deps);
    return handleFriends(chatId, deps);
  }
  // inconnu sans /start : silence pour lui (bot privé), mais l'admin voit qui frappe à la porte
  if (!profile) return notifyAdmin(deps, `${who(msg)} a écrit au bot sans l'avoir rejoint.`);
  profile = await refreshName(chatId, profile, msg.from, deps);
  const s = STRINGS[profile.lang];
  const { telegram, store } = deps;

  if (text.length > 512) return void (await telegram.sendMessage(chatId, s.help));

  if (profile.awaiting === 'hours') {
    const escapes = text.startsWith('/') || isButton(text, 'now') || isButton(text, 'backHome') || isButton(text, 'useMyLocation') || Boolean(msg.location);
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
  // Le bouton 📍 demande la position à Telegram. Quand Telegram ne peut pas la joindre (localisation refusée ou coupée
  // pour l'application), certaines applications envoient à la place le texte du bouton : dire quoi activer plutôt que
  // de répondre par l'aide.
  if (isButton(text, 'useMyLocation')) {
    await telegram.sendMessage(chatId, fill(s.locationNeeded, { button: s.buttons.useMyLocation }));
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
    await store.updateProfile(chatId, (cur) => ({ ...(cur ?? profile!), active: false, inactiveReason: 'stopped' }));
    await telegram.sendMessage(chatId, s.stopped);
    return;
  }
  if (text.startsWith('/all')) {
    const report = await todayReport(chatId, profile, deps);
    const ctx = renderCtx(profile.lang, deps);
    const body = renderDetails(report, ctx, { all: true });
    const commandLine = spotsCommandLine(dayViewSpotOrder(report, { all: true }), ctx, s);
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
    const created = await deps.store.updateProfile(chatId, () => ({ ...newProfile(chatId, lang, deps.now()), ...telegramName(msg.from) }));
    const s = STRINGS[created.lang];
    await deps.telegram.sendMessage(chatId, welcomeText(created, s), persistentKeyboard(s));
    await notifyAdmin(deps, `${who(msg)} a rejoint le bot.`);
    return;
  }
  const s = STRINGS[profile.lang];
  const p = await deps.store.updateProfile(chatId, (cur) => {
    const next = { ...withName(cur ?? profile, msg.from), active: true };
    delete next.inactiveReason;
    return next;
  });
  await deps.telegram.sendMessage(chatId, `${s.reactivated}\n${profileSummary(p, s)}`, persistentKeyboard(s));
}

/** `/amis`, pour l'admin seulement : qui est inscrit, où, à quelles heures, et qui s'est mis en pause ou a bloqué le bot. */
async function handleFriends(chatId: number, deps: BotDeps): Promise<void> {
  const profiles = Object.values(await deps.store.getProfiles()).filter((p): p is Profile => Boolean(p) && typeof p === 'object');
  for (const text of renderFriends(profiles, deps.spots, deps.radiusKm ?? RADIUS_KM)) await deps.telegram.sendMessage(chatId, text);
}

/** Le profil avec le nom Telegram d'aujourd'hui. Un expéditeur sans prénom n'est pas un compte Telegram ordinaire : rien ne change. */
function withName(profile: Profile, from: TgUser | undefined): Profile {
  if (!from?.first_name) return profile;
  const { name, username } = telegramName(from);
  const next = { ...profile, name, username };
  if (!name) delete next.name;
  if (!username) delete next.username;
  return next;
}

/** Le nom Telegram suit ce que l'ami affiche aujourd'hui, pour `/amis` : une écriture seulement quand il a changé. */
async function refreshName(chatId: number, profile: Profile, from: TgUser | undefined, deps: BotDeps): Promise<Profile> {
  const named = withName(profile, from);
  if (named.name === profile.name && named.username === profile.username) return profile;
  return deps.store.updateProfile(chatId, (cur) => withName(cur ?? profile, from));
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
  const stored = await deps.store.getProfile(chatId);
  if (!stored) return;
  const profile = await refreshName(chatId, stored, cb.from, deps);
  const s = STRINGS[profile.lang];
  const [kind, value = '', rest = ''] = (cb.data ?? '').split(':');
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
    case 'go':
      return handleGoing(chatId, value, rest, profile, deps);
    case 'nogo':
      return handleNotGoing(chatId, value, profile, deps);
    default:
      return;
  }
}

/**
 * Jusqu'où un bouton 🙋 peut viser : ceux des messages parlent d'aujourd'hui (/now, matin) ou de demain (soir). Plus loin,
 * c'est un bouton fabriqué — et une entrée gardée 3 jours à partir de l'appui expirerait avant sa date.
 */
const GOING_MAX_DAYS_AHEAD = 1;

/** La date d'un bouton 🙋 : une vraie date du calendrier, au plus une semaine après aujourd'hui, et si ce jour est déjà fini. */
function goingDate(compact: string, today: string): { date: string; past: boolean } | undefined {
  const date = expandCompactDate(compact);
  if (!date) return undefined;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date > addDays(today, GOING_MAX_DAYS_AHEAD)) return undefined;
  return { date, past: date < today };
}

/**
 * 🙋 « J'y vais » : noter où l'ami va ce jour-là, puis lui montrer — à lui seul, personne d'autre n'est prévenu — qui y va,
 * avec de quoi se désister. Les données d'un bouton se falsifient : date et spot sont vérifiés avant toute écriture. Les
 * 1 000 écritures KV du jour servent aussi aux envois programmés : un appui qui ne change rien n'en coûte aucune.
 */
async function handleGoing(chatId: number, compact: string, spotId: string, profile: Profile, deps: BotDeps): Promise<void> {
  const s = STRINGS[profile.lang];
  const ctx = renderCtx(profile.lang, deps);
  const now = deps.now();
  const day = goingDate(compact, dateOf(now));
  if (!day || !spotById(spotId, ctx)) return;
  if (day.past) return void (await deps.telegram.sendMessage(chatId, s.details.tooOld));
  const current = await deps.store.goingOf(day.date, chatId);
  const mine = current?.spotId === spotId ? current : { chatId, spotId, at: now };
  if (mine !== current) await deps.store.setGoing(day.date, chatId, spotId, now);
  const [listed, profiles] = await Promise.all([deps.store.goingOn(day.date), deps.store.getProfiles()]);
  // `list` peut ne pas avoir encore vu cet appui, ou montrer l'ancien choix de l'ami : sa place est celle qu'il vient de choisir
  const going = [...listed.filter((e) => e.chatId !== chatId), mine];
  await deps.telegram.sendMessage(chatId, renderGoing(day.date, going, chatId, profiles, ctx), {
    inline_keyboard: [[{ text: s.buttons.notGoing, callback_data: notGoingData(day.date) }]],
  });
}

async function handleNotGoing(chatId: number, compact: string, profile: Profile, deps: BotDeps): Promise<void> {
  const s = STRINGS[profile.lang];
  const day = goingDate(compact, dateOf(deps.now()));
  if (!day) return;
  if (day.past) return void (await deps.telegram.sendMessage(chatId, s.details.tooOld));
  if (await deps.store.goingOf(day.date, chatId)) await deps.store.cancelGoing(day.date, chatId);
  await deps.telegram.sendMessage(chatId, fill(s.going.cancelled, { date: fmtDate(day.date, profile.lang) }));
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
  const ctx = renderCtx(profile.lang, deps);
  const body = renderDetails(report, ctx);
  const commandLine = spotsCommandLine(dayViewSpotOrder(report), ctx, s);
  await deps.telegram.sendMessage(chatId, commandLine ? `${body}\n\n${commandLine}` : body);
}
