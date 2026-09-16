import { safeEqual, type FetchLike } from '../adapters/http';
import type { Store } from '../adapters/kv';
import type { Telegram, TgCallbackQuery, TgMessage, TgUpdate } from '../adapters/telegram';
import { DEFAULT_LOCATION } from '../config';
import { addDays, dateOf, floorHour } from '../engine/time';
import { buildReport, type CollectDeps } from '../jobs/collect';
import { detectLang, STRINGS } from '../render/i18n';
import { detailsMarkupFor, renderDetails, renderEvening, type RenderCtx } from '../render/messages';
import type { Board, Lang, Level, Profile, Region, Report, Spot } from '../types';
import { boardKeyboard, langKeyboard, levelKeyboard, persistentKeyboard, profileKeyboard } from './keyboards';
import { newProfile, parseHours, profileSummary, welcomeText } from './profile';

export interface BotDeps {
  telegram: Telegram;
  store: Store;
  spots: Spot[];
  regions: Region[];
  fetchFn: FetchLike;
  inviteCode?: string;
  radiusKm?: number;
  /** heure locale 'YYYY-MM-DDTHH:mm' */
  now: () => string;
}

const LEVELS: readonly Level[] = ['beginner', 'intermediate', 'advanced'];
const BOARDS: readonly Board[] = ['longboard', 'shortboard', 'both'];
const LANGS: readonly Lang[] = ['en', 'ru'];

const isButton = (text: string, key: 'backHome' | 'now'): boolean =>
  text === STRINGS.en.buttons[key] || text === STRINGS.ru.buttons[key];

/** Un chat_id Telegram est toujours un entier ; refuse toute autre valeur (ex. "__proto__") avant tout accès au store. */
const isChatId = (x: unknown): x is number => Number.isInteger(x);

const isValidLocation = (loc: { latitude: number; longitude: number }): boolean =>
  Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude) && Math.abs(loc.latitude) <= 90 && Math.abs(loc.longitude) <= 180;

const renderCtx = (lang: Lang, deps: BotDeps): RenderCtx => ({ lang, spots: new Map(deps.spots.map((s) => [s.id, s])) });

const collectDeps = (deps: BotDeps, now: string): CollectDeps =>
  ({ spots: deps.spots, regions: deps.regions, fetchFn: deps.fetchFn, radiusKm: deps.radiusKm, now });

async function nowReport(profile: Profile, deps: BotDeps): Promise<Report> {
  const now = deps.now();
  return buildReport({ profile, date: dateOf(now), mode: 'now', fromTime: floorHour(now) }, collectDeps(deps, now));
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
  if (!profile) return; // inconnu sans /start : silence (bot privé)
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
    await telegram.sendMessage(chatId, `${renderEvening(report, renderCtx(profile.lang, deps))}\n\n${s.locationSaved}`, detailsMarkupFor(report, profile.lang));
    return;
  }
  if (text === '/now' || isButton(text, 'now')) {
    const report = await nowReport(profile, deps);
    await telegram.sendMessage(chatId, renderEvening(report, renderCtx(profile.lang, deps)), detailsMarkupFor(report, profile.lang));
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
      return;
    }
    const created = await deps.store.updateProfile(chatId, () => newProfile(chatId, lang, deps.now()));
    const s = STRINGS[created.lang];
    await deps.telegram.sendMessage(chatId, s.onboarding.askLevel, levelKeyboard(s));
    return;
  }
  const s = STRINGS[profile.lang];
  const p = await deps.store.updateProfile(chatId, (cur) => ({ ...(cur ?? profile), active: true }));
  if (p.onboarding === 'level') return void (await deps.telegram.sendMessage(chatId, s.onboarding.askLevel, levelKeyboard(s)));
  if (p.onboarding === 'board') return void (await deps.telegram.sendMessage(chatId, s.onboarding.askBoard, boardKeyboard(s)));
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

  switch (kind) {
    case 'lvl': {
      if (!LEVELS.includes(value as Level)) return;
      const p = await store.updateProfile(chatId, (cur) => {
        const next = { ...(cur ?? profile), level: value as Level };
        if (next.onboarding === 'level') next.onboarding = 'board';
        return next;
      });
      if (p.onboarding === 'board') await telegram.sendMessage(chatId, s.onboarding.askBoard, boardKeyboard(s));
      else await telegram.sendMessage(chatId, `${s.profile.saved}\n${profileSummary(p, s)}`);
      return;
    }
    case 'board': {
      if (!BOARDS.includes(value as Board)) return;
      const wasOnboarding = profile.onboarding === 'board';
      const p = await store.updateProfile(chatId, (cur) => {
        const next = { ...(cur ?? profile), board: value as Board };
        if (next.onboarding === 'board') delete next.onboarding;
        return next;
      });
      if (wasOnboarding) await telegram.sendMessage(chatId, welcomeText(p, s), persistentKeyboard(s));
      else await telegram.sendMessage(chatId, `${s.profile.saved}\n${profileSummary(p, s)}`);
      return;
    }
    case 'prof': {
      if (value === 'level') await telegram.sendMessage(chatId, s.onboarding.askLevel, levelKeyboard(s));
      else if (value === 'board') await telegram.sendMessage(chatId, s.onboarding.askBoard, boardKeyboard(s));
      else if (value === 'hours') {
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
  let report: Report | undefined = (await deps.store.getReports(date))[String(chatId)];
  if (!report) {
    const now = deps.now();
    const today = dateOf(now);
    if (date === today) report = await nowReport(profile, deps);
    else if (date === addDays(today, 1)) report = await buildReport({ profile, date, mode: 'evening' }, collectDeps(deps, now));
  }
  if (!report) {
    await deps.telegram.sendMessage(chatId, s.details.tooOld);
    return;
  }
  await deps.telegram.sendMessage(chatId, renderDetails(report, renderCtx(profile.lang, deps)));
}
