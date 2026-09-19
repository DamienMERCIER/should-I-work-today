import { safeEqual, type FetchLike } from '../adapters/http';
import type { Store } from '../adapters/kv';
import type { Telegram, TgCallbackQuery, TgMessage, TgUpdate, TgUser } from '../adapters/telegram';
import { LANGS, DEFAULT_LOCATION, RADIUS_KM, STAR_CHOICES } from '../config';
import { hasDaylightLeft } from '../engine/factors';
import { haversineKm } from '../engine/geo';
import { addDays, dateOf, floorHour } from '../engine/time';
import type { SpotTuple } from '../data/world';
import { buildReport, buildWeek, nearbySpots, type CollectDeps } from '../jobs/collect';
import { notifyAdmin } from '../jobs/runs';
import { detectLang, fill, STRINGS, type Strings } from '../render/i18n';
import {
  detailsMarkupFor, expandCompactDate, fmtDate, notGoingData, renderDetails, renderEvening, renderSpotDay, renderWeek, spotById,
  spotMarkupFor, spotName, withSpotButtons, type RenderCtx,
} from '../render/messages';
import type { Lang, Profile, Region, Report, Spot } from '../types';
import { langKeyboard, letInKeyboard, persistentKeyboard, profileKeyboard, starsKeyboard } from './keyboards';
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
  /** notified of every arrival, refusal and message from a stranger — and the one who can let a stranger in */
  adminChatId?: number;
  radiusKm?: number;
  /** spots imported for `/<spot>` and `/about`; defaults to the whole `spots-world.json` (tests pass the list they need) */
  worldTuples?: SpotTuple[];
  /** local time 'YYYY-MM-DDTHH:mm' */
  now: () => string;
}

/** "Ivan Petrov (@ivan, id 42)" for messages to the admin: the id tells apart two people sharing a name, and shows up in the logs. */
function whoIs(user: TgUser | undefined, chatId: number): string {
  const name = oneLine(`${user?.first_name ?? ''} ${user?.last_name ?? ''}`);
  const handle = oneLine(user?.username);
  const id = `id ${chatId}`;
  if (name) return `${name} (${handle ? `@${handle}, ` : ''}${id})`;
  return handle ? `@${handle} (${id})` : id;
}

const who = (msg: TgMessage): string => whoIs(msg.from, msg.chat.id);

const isButton = (text: string, key: 'backHome' | 'now' | 'useMyLocation'): boolean =>
  text === STRINGS.en.buttons[key] || text === STRINGS.ru.buttons[key];

/** A Telegram chat_id is always an integer; reject any other value (e.g. "__proto__") before any access to the store. */
const isChatId = (x: unknown): x is number => Number.isInteger(x);

/** A user id typed or carried by a button: digits only, positive (group chats are negative), and exact in a JS number. */
const userIdFrom = (text: string): number | undefined => {
  const id = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

const isAdmin = (id: number, deps: BotDeps): boolean => deps.adminChatId !== undefined && id === deps.adminChatId;

const isValidLocation = (loc: { latitude: number; longitude: number }): boolean =>
  Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude) && Math.abs(loc.latitude) <= 90 && Math.abs(loc.longitude) <= 180;

const renderCtx = (lang: Lang, deps: BotDeps): RenderCtx => ({ lang, spots: new Map(deps.spots.map((s) => [s.id, s])) });

const collectDeps = (deps: BotDeps, now: string): CollectDeps =>
  ({ spots: deps.spots, regions: deps.regions, fetchFn: deps.fetchFn, radiusKm: deps.radiusKm, now });

/**
 * "Now" only makes sense while there is still daylight left: past the last surfable hour, every
 * remaining slot scores 0 and the report is just a wall of zeros that teaches nothing. We then answer
 * for tomorrow instead (evening mode), and the caller prefixes `dayIsDone` since the date is no longer
 * today's. A report with no spot evaluated at all (Open-Meteo silent, out of coverage) is not rolled
 * over: tomorrow would be just as empty, and that would be a second round of calls for nothing.
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
 * The week ahead (`buildWeek`). Far from any known spot, we answer like /now: seven out-of-coverage
 * reports would cost two calls each just to say the same thing seven times over.
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

/** The prefix to stick in front of a "now" report that `nowReport` rolled over to tomorrow. */
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
 * `/<spot>`: resolve the text after `/` against the whole spot database (`deps.spots`, not just
 * today's report — a spot can be known but outside the user's radius). Returns `false` when nothing
 * matched, so the caller falls back to the help text like any other unrecognised command.
 */
async function handleSpotCommand(chatId: number, query: string, profile: Profile, deps: BotDeps): Promise<boolean> {
  const s = STRINGS[profile.lang];
  const match = matchSpot(query, deps.spots, deps.worldTuples);
  if (match.kind === 'none') return false;

  if (match.kind === 'ambiguous') {
    const list = match.spots.map((spot) => `/${spotSlug(spot)}`).join(', ');
    await deps.telegram.sendMessage(chatId, fill(s.spotCommand.ambiguous, { list }));
    return true;
  }

  await sendSpotDay(chatId, match.spot, profile, deps);
  return true;
}

/** A spot's day, requested via its command or its button (📋, `/all`): the same response either way. */
async function sendSpotDay(chatId: number, spot: Spot, profile: Profile, deps: BotDeps): Promise<void> {
  const s = STRINGS[profile.lang];
  const ctx = renderCtx(profile.lang, deps);
  ctx.spots.set(spot.id, spot); // an imported spot isn't in the context, which only holds curated spots
  const radiusKm = deps.radiusKm ?? RADIUS_KM;
  const distanceKm = haversineKm(profile.location, spot);
  if (distanceKm > radiusKm) {
    await deps.telegram.sendMessage(chatId, fill(s.spotCommand.outOfRadius, {
      spot: spotName(spot.id, ctx, s), km: Math.round(distanceKm), radius: radiusKm,
    }));
    return;
  }

  const report = await todayReport(chatId, profile, deps);
  // `renderSpotDay` carries no date: without this prefix, a report rolled over to tomorrow would pass
  // for today's.
  await deps.telegram.sendMessage(chatId, `${rolloverPrefix(report, deps, s)}${renderSpotDay(report, spot.id, ctx)}`, spotMarkupFor(report, spot.id, ctx));
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
  // `/amis` is the name this command was born with; it keeps working for the admin who has it in muscle memory.
  if ((text.startsWith('/friends') || text.startsWith('/amis')) && isAdmin(chatId, deps)) {
    if (profile) await refreshName(chatId, profile, msg.from, deps);
    return handleFriends(chatId, deps);
  }
  if (text.startsWith('/letin') && isAdmin(chatId, deps)) return handleLetInCommand(text, deps);
  // a stranger without /start: silence for them (private bot), but the admin sees who's knocking, and can let them in
  if (!profile) {
    return notifyAdmin(deps, `${who(msg)} wrote to the bot without joining it.`, letInKeyboard(chatId, detectLang(msg.from?.language_code)));
  }
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
  // The 📍 button asks Telegram for the location. When Telegram can't obtain it (location denied or turned
  // off for the app), some apps send the button's text instead: say what to turn on rather than
  // answering with the help text.
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
    const { text: allText, markup } = withSpotButtons(renderDetails(report, ctx, { all: true }), report, ctx, { all: true });
    await telegram.sendMessage(chatId, allText, markup);
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
      const why = !deps.inviteCode ? 'INVITE_CODE is not set' : code ? 'wrong invite code' : '/start without an invite code';
      await notifyAdmin(deps, `Access refused for ${who(msg)}: ${why}.`, letInKeyboard(chatId, lang));
      return;
    }
    // No more questions: the rating depends on neither skill level nor board, so the profile is ready right away.
    const created = await deps.store.updateProfile(chatId, () => ({ ...newProfile(chatId, lang, deps.now()), ...telegramName(msg.from) }));
    const s = STRINGS[created.lang];
    await deps.telegram.sendMessage(chatId, welcomeText(created, s), persistentKeyboard(s));
    await notifyAdmin(deps, `${who(msg)} joined the bot.`);
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

/**
 * In on the admin's word, without the invite link: the same profile and welcome as `/start <code>`, with the
 * name Telegram gives for them (none of their messages carries it here). Someone already in stays as they are.
 * A welcome Telegram refuses leaves the profile in place: the next send finds out whether they blocked the bot.
 */
async function letIn(target: number, langText: string, deps: BotDeps): Promise<void> {
  // a read first, so that someone already in costs no write…
  if (await deps.store.getProfile(target)) return notifyAdmin(deps, `id ${target} is already in.`);
  const lang: Lang = LANGS.includes(langText as Lang) ? (langText as Lang) : 'en';
  const user = await deps.telegram.getChat(target);
  // …and a profile that appeared since (their own /start at the same moment) is kept, never reset to the defaults
  let joinedMeanwhile = false;
  const created = await deps.store.updateProfile(target, (current) => {
    joinedMeanwhile = current !== undefined;
    return current ?? { ...newProfile(target, lang, deps.now()), ...telegramName(user) };
  });
  if (joinedMeanwhile) return notifyAdmin(deps, `id ${target} is already in.`);
  const s = STRINGS[created.lang];
  const sent = await deps.telegram.sendMessage(target, welcomeText(created, s), persistentKeyboard(s));
  const label = whoIs(user, target);
  await notifyAdmin(deps, sent.ok ? `${label} let in — welcome sent.` : `${label} let in, but the welcome did not go through: ${sent.description}.`);
}

/** `/letin <id> [en|ru]`, for the admin: the ✅ Let in button, for a notification that arrived without one. */
async function handleLetInCommand(text: string, deps: BotDeps): Promise<void> {
  const [, idText = '', lang = 'en'] = text.split(/\s+/);
  const target = userIdFrom(idText);
  if (target === undefined) return notifyAdmin(deps, 'Usage: /letin <id> [en|ru] — the id is in the notification.');
  await letIn(target, lang, deps);
}

/**
 * A friend known only by an id — joined before names were kept, or let in by hand and silent since — is asked
 * about to Telegram, at most this many per `/friends`: one subrequest each, and a write only once a name is found.
 */
const NAME_LOOKUPS_PER_LIST = 10;

/** `/friends`, for the admin only: who's registered, where, at what hours, and who has paused or blocked the bot. */
async function handleFriends(chatId: number, deps: BotDeps): Promise<void> {
  const profiles = Object.values(await deps.store.getProfiles()).filter((p): p is Profile => Boolean(p) && typeof p === 'object');
  for (const p of profiles.filter((p) => !p.name && !p.username).slice(0, NAME_LOOKUPS_PER_LIST)) {
    const user = await deps.telegram.getChat(p.chatId);
    if (!user?.first_name) continue;
    profiles[profiles.indexOf(p)] = await deps.store.updateProfile(p.chatId, (cur) => withName(cur ?? p, user));
  }
  for (const text of renderFriends(profiles, deps.spots, deps.radiusKm ?? RADIUS_KM)) await deps.telegram.sendMessage(chatId, text);
}

/** The profile with today's Telegram name. A sender with no first name isn't an ordinary Telegram account: nothing changes. */
function withName(profile: Profile, from: TgUser | undefined): Profile {
  if (!from?.first_name) return profile;
  const { name, username } = telegramName(from);
  const next = { ...profile, name, username };
  if (!name) delete next.name;
  if (!username) delete next.username;
  return next;
}

/** The Telegram name follows what the friend displays today, for `/amis`: a write only when it has changed. */
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
  const [kind, value = '', rest = ''] = (cb.data ?? '').split(':');
  // ✅ Let in: before any profile (the admin needs none), and for the admin alone — a button's data can be forged
  if (kind === 'admit') {
    const target = userIdFrom(value);
    if (isAdmin(cb.from.id, deps) && target !== undefined) await letIn(target, rest, deps);
    return;
  }
  const stored = await deps.store.getProfile(chatId);
  if (!stored) return;
  const profile = await refreshName(chatId, stored, cb.from, deps);
  const s = STRINGS[profile.lang];
  const { telegram, store } = deps;

  // `lvl:*`, `board:*`, `prof:level` and `prof:board` came from the old onboarding: their buttons
  // can still be lying around in a chat's history; they fall into `default` and do nothing.
  switch (kind) {
    case 'prof': {
      if (value === 'hours') {
        await store.updateProfile(chatId, (cur) => ({ ...(cur ?? profile), awaiting: 'hours' }));
        await telegram.sendMessage(chatId, s.profile.askHours);
      }
      else if (value === 'stars') await telegram.sendMessage(chatId, s.profile.askStars, starsKeyboard());
      return;
    }
    case 'stars': {
      // a threshold the keyboard doesn't offer comes from a fabricated button
      const minStars = Number(value);
      if (!STAR_CHOICES.includes(minStars)) return;
      // the same threshold again isn't worth a write: the day's 1,000 also serve the scheduled sends
      const p = profile.minStars === minStars ? profile : await store.updateProfile(chatId, (cur) => ({ ...(cur ?? profile), minStars }));
      await telegram.sendMessage(chatId, `${s.profile.saved}\n${profileSummary(p, s)}`);
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
    case 'spot': {
      // a button from 📋 or from /all; an unknown — or fabricated — id gets no response
      const spot = spotById(value, renderCtx(profile.lang, deps));
      if (spot) await sendSpotDay(chatId, spot, profile, deps);
      return;
    }
    case 'go':
      return handleGoing(chatId, value, rest, profile, deps);
    case 'nogo':
      return handleNotGoing(chatId, value, profile, deps);
    default:
      return;
  }
}

/**
 * How far ahead a 🙋 button can target: message buttons talk about today (/now, morning) or tomorrow
 * (evening). Beyond that, it's a fabricated button — and an entry kept for 3 days from the tap would expire before its date.
 */
const GOING_MAX_DAYS_AHEAD = 1;

/** A 🙋 button's date: a real calendar date, at most one week after today, and whether that day is already over. */
function goingDate(compact: string, today: string): { date: string; past: boolean } | undefined {
  const date = expandCompactDate(compact);
  if (!date) return undefined;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date > addDays(today, GOING_MAX_DAYS_AHEAD)) return undefined;
  return { date, past: date < today };
}

/**
 * 🙋 "I'm going": record where the friend is going that day, then show them — them alone, nobody else is
 * notified — who else is going, with a way to back out. A button's data can be forged: date and spot are
 * verified before any write. The day's 1,000 KV writes also serve the scheduled sends: a tap that changes nothing costs none of them.
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
  // `list` may not have seen this tap yet, or may show the friend's old choice: their place is the one they just picked
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
  const { text, markup } = withSpotButtons(renderDetails(report, ctx), report, ctx);
  await deps.telegram.sendMessage(chatId, text, markup);
}
