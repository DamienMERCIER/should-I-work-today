import { describe, it, expect } from 'vitest';
import { Store } from '../../src/adapters/kv';
import { Telegram, type TgMessage, type TgUpdate } from '../../src/adapters/telegram';
import { handleUpdate, type BotDeps } from '../../src/bot/router';
import { parseHours } from '../../src/bot/profile';
import { REGIONS } from '../../src/data/index';
import type { Profile } from '../../src/types';
import { fakeFetch, jsonResponse } from '../helpers/fakeFetch';
import { GOLDEN_DAILY, GOLDEN_SPOTS, goldenReport, goldenSwell, goldenWind } from '../helpers/golden';
import { MemoryKV } from '../helpers/memoryKv';
import { openMeteoServer } from '../helpers/openMeteoServer';

const NOW = '2026-09-16T08:30';

function setup(opts: { inviteCode?: string } = {}) {
  const store = new Store(new MemoryKV());
  const tg = fakeFetch(() => jsonResponse({ ok: true }));
  const om = fakeFetch(openMeteoServer({ swell: goldenSwell(), wind: goldenWind(), daily: GOLDEN_DAILY }));
  const deps: BotDeps = {
    telegram: new Telegram('t', tg.fn), store, spots: GOLDEN_SPOTS, regions: REGIONS, fetchFn: om.fn,
    inviteCode: opts.inviteCode, now: () => NOW,
  };
  const sent = () => tg.calls.filter((c) => c.url.endsWith('/sendMessage')).map((c) => JSON.parse(String(c.init?.body)) as { chat_id: number; text: string; reply_markup?: any });
  const answered = () => tg.calls.filter((c) => c.url.endsWith('/answerCallbackQuery')).length;
  return { deps, store, sent, answered, omCalls: om.calls };
}

const msg = (text?: string, extra: Partial<TgMessage> = {}, chatId = 1): TgUpdate => ({
  update_id: 1,
  message: { message_id: 1, chat: { id: chatId, type: 'private' }, from: { id: chatId, language_code: 'fr' }, text, ...extra },
});
const cb = (data: string, chatId = 1): TgUpdate => ({
  update_id: 2,
  callback_query: { id: 'cb1', from: { id: chatId }, message: { message_id: 1, chat: { id: chatId, type: 'private' } }, data },
});
const ready = (over: Partial<Profile> = {}): Profile => ({
  chatId: 1, lang: 'en', level: 'intermediate', board: 'shortboard', workHours: { start: '09:00', end: '18:00' },
  location: { lat: -34.1085, lon: 18.4715, source: 'default' }, active: true, createdAt: '2026-09-15T19:00', ...over,
});

describe('parseHours', () => {
  it('accepts 9h-18h, 09:30-17:00, 9-18 and rejects the rest', () => {
    expect(parseHours('9h-18h')).toEqual({ start: '09:00', end: '18:00' });
    expect(parseHours('09:30 – 17:00')).toEqual({ start: '09:30', end: '17:00' });
    expect(parseHours('9-18')).toEqual({ start: '09:00', end: '18:00' });
    expect(parseHours('9h30-18h')).toEqual({ start: '09:30', end: '18:00' });
    expect(parseHours('8h15 - 17h45')).toEqual({ start: '08:15', end: '17:45' });
    expect(parseHours('18h-9h')).toBeNull();
    expect(parseHours('25h-3h')).toBeNull();
    expect(parseHours('hello')).toBeNull();
  });
});

describe('/start and onboarding', () => {
  it('refuses strangers without the invite code', async () => {
    const { deps, store, sent } = setup({ inviteCode: 'surf' });
    await handleUpdate(msg('/start'), deps);
    expect(sent()[0].text).toBe('Private bot — you need the invite link.');
    expect(await store.getProfile(1)).toBeUndefined();
  });
  it('creates a profile in the detected language and walks the two taps', async () => {
    const { deps, store, sent, answered } = setup({ inviteCode: 'surf' });
    await handleUpdate(msg('/start surf', { from: { id: 1, language_code: 'ru' } }), deps);
    expect((await store.getProfile(1))?.onboarding).toBe('level');
    expect((await store.getProfile(1))?.lang).toBe('ru');
    expect(sent()[0].text).toBe('Привет! Два вопроса — и поехали. Твой уровень?');
    expect(sent()[0].reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data)).toEqual(['lvl:beginner', 'lvl:intermediate', 'lvl:advanced']);

    await handleUpdate(cb('lvl:intermediate'), deps);
    expect((await store.getProfile(1))?.level).toBe('intermediate');
    expect((await store.getProfile(1))?.onboarding).toBe('board');
    expect(sent()[1].text).toBe('На чём катаешься?');

    await handleUpdate(cb('board:both'), deps);
    const p = await store.getProfile(1);
    expect(p?.board).toBe('both');
    expect(p?.onboarding).toBeUndefined();
    expect(sent()[2].text.startsWith('Готово.')).toBe(true);
    expect(sent()[2].reply_markup.keyboard[0][0]).toEqual({ text: '📍 Использовать моё местоположение', request_location: true });
    expect(answered()).toBe(2);
  });
  it('refuses every /start when no invite code is configured', async () => {
    const { deps, store, sent } = setup();
    await handleUpdate(msg('/start'), deps);
    expect(sent()[0].text).toBe('Private bot — you need the invite link.');
    expect(await store.getProfile(1)).toBeUndefined();
  });
  it('re-asks the pending question on /start during onboarding', async () => {
    const { deps, sent } = setup({ inviteCode: 'surf' });
    await handleUpdate(msg('/start surf'), deps);
    await handleUpdate(msg('/start surf'), deps);
    expect(sent().map((m) => m.text)).toEqual(['Hey! Two questions and we are set. Your level?', 'Hey! Two questions and we are set. Your level?']);
  });
  it('/stop deactivates, /start reactivates with the keyboard and the profile summary', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/stop'), deps);
    expect((await store.getProfile(1))?.active).toBe(false);
    await handleUpdate(msg('/start'), deps);
    expect((await store.getProfile(1))?.active).toBe(true);
    expect(sent()[1].text.startsWith('Good to see you again — your profile is still here.')).toBe(true);
    expect(sent()[1].text).toContain('Level: Intermediate');
    expect(sent()[1].reply_markup.keyboard[1].map((b: { text: string }) => b.text)).toEqual(['🏠 Back to Muizenberg', '🔎 Right now']);
  });
});

describe('location and /now', () => {
  it('a shared location is stored and answered with the rest-of-day verdict', async () => {
    const { deps, store, sent, omCalls } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg(undefined, { location: { latitude: -34.12, longitude: 18.45 } }), deps);
    expect((await store.getProfile(1))?.location).toEqual({ lat: -34.12, lon: 18.45, source: 'custom' });
    expect(omCalls).toHaveLength(3); // marine + forecast + période pic
    expect(sent()[0].text.startsWith('🟢 <b>GO SURF</b> (today)')).toBe(true);
    expect(sent()[0].text.endsWith('Location saved — the 19:00 verdict will use it.')).toBe(true);
    expect(sent()[0].reply_markup).toEqual({ inline_keyboard: [[{ text: '📋 All spots', callback_data: 'rep:2026-09-16' }]] });
  });
  it('the home button resets the location', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready({ location: { lat: -34.12, lon: 18.45, source: 'custom' } }) });
    await handleUpdate(msg('🏠 Back to Muizenberg'), deps);
    expect((await store.getProfile(1))?.location).toEqual({ lat: -34.1085, lon: 18.4715, source: 'default' });
    expect(sent()[0].text).toBe('Location: back to Muizenberg.');
  });
  it('/now and the 🔎 button (in either language) evaluate the rest of the day', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/now'), deps);
    await handleUpdate(msg('🔎 Сейчас'), deps);
    expect(sent()).toHaveLength(2);
    expect(sent()[1].text).toContain('Kommetjie – Long Beach · 8:00–12:00 · 10.0/10');
  });
});

describe('/profil, hours, /lang, help', () => {
  it('shows the summary and edits hours through the awaiting state', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/profil'), deps);
    expect(sent()[0].text).toBe('Profile\nLevel: Intermediate\nBoard: Shortboard\nWork: 9:00–18:00\nLocation: Muizenberg (default)');
    expect(sent()[0].reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data)).toEqual(['prof:level', 'prof:board', 'prof:hours']);

    await handleUpdate(cb('prof:hours'), deps);
    expect((await store.getProfile(1))?.awaiting).toBe('hours');
    expect(sent()[1].text).toBe('Send your work hours, e.g. 9-18');

    await handleUpdate(msg('25h-3h'), deps);
    expect(sent()[2].text).toBe("I didn't get that. Format: 9-18");
    expect((await store.getProfile(1))?.awaiting).toBe('hours');

    await handleUpdate(msg('10h-19h'), deps);
    const p = await store.getProfile(1);
    expect(p?.workHours).toEqual({ start: '10:00', end: '19:00' });
    expect(p?.awaiting).toBeUndefined();
    expect(sent()[3].text.startsWith('Saved.')).toBe(true);
  });
  it('a command escapes the awaiting state', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready({ awaiting: 'hours' }) });
    await handleUpdate(msg('/now'), deps);
    expect((await store.getProfile(1))?.awaiting).toBeUndefined();
    expect(sent()[0].text.startsWith('🟢')).toBe(true);
  });
  it('prof:level / prof:board re-ask with inline keyboards and save outside onboarding', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(cb('prof:level'), deps);
    expect(sent()[0].reply_markup.inline_keyboard[0][2].callback_data).toBe('lvl:advanced');
    await handleUpdate(cb('lvl:advanced'), deps);
    expect((await store.getProfile(1))?.level).toBe('advanced');
    expect((await store.getProfile(1))?.onboarding).toBeUndefined();
    expect(sent()[1].text.startsWith('Saved.\nProfile')).toBe(true);
  });
  it('/lang switches the language and the keyboard', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/lang'), deps);
    expect(sent()[0].reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data)).toEqual(['lang:en', 'lang:ru']);
    await handleUpdate(cb('lang:ru'), deps);
    expect((await store.getProfile(1))?.lang).toBe('ru');
    expect(sent()[1].text).toBe('Язык: русский');
    expect(sent()[1].reply_markup.keyboard[1][1].text).toBe('🔎 Сейчас');
  });
  it('unknown text gets the help, unknown users and groups get nothing', async () => {
    const { deps, store, sent } = setup();
    await handleUpdate(msg('hello'), deps);
    expect(sent()).toHaveLength(0);
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('hello', { chat: { id: -5, type: 'group' } }), deps);
    expect(sent()).toHaveLength(0);
    await handleUpdate(msg('hello'), deps);
    expect(sent()[0].text.startsWith('Commands:')).toBe(true);
  });
});

describe('input validation', () => {
  it('ignores an update whose chat id is not a number (prototype pollution guard)', async () => {
    const { deps, store, sent } = setup();
    const badUpdate = {
      update_id: 9,
      message: { message_id: 1, chat: { id: '__proto__', type: 'private' }, from: { id: 1, language_code: 'fr' }, text: '/now' },
    } as unknown as TgUpdate;
    await handleUpdate(badUpdate, deps);
    expect(sent()).toHaveLength(0);
    expect(await store.getProfiles()).toEqual({});
    expect(({} as Record<string, unknown>).lang).toBeUndefined();
  });
  it('ignores a location with an out-of-range latitude', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg(undefined, { location: { latitude: 999, longitude: 18.45 } }), deps);
    expect(sent()).toHaveLength(0);
    expect((await store.getProfile(1))?.location).toEqual({ lat: -34.1085, lon: 18.4715, source: 'default' });
  });
});

describe('📋 details callback', () => {
  it('serves the stored report, recomputes tomorrow, refuses old dates', async () => {
    const { deps, store, sent, answered } = setup();
    await store.putProfiles({ '1': ready() });
    await store.putReports('2026-09-16', { '1': goldenReport() });
    await handleUpdate(cb('rep:2026-09-16'), deps);
    expect(sent()[0].text.startsWith('📋 <b>Your day</b> (Wed 16 Sept)')).toBe(true);
    await handleUpdate(cb('rep:2026-09-17'), deps);
    expect(sent()[1].text.startsWith('📋 <b>Your day</b> (Thu 17 Sept)')).toBe(true);
    await handleUpdate(cb('rep:2020-01-01'), deps);
    expect(sent()[2].text).toBe('Too old — run /now.');
    expect(answered()).toBe(3);
  });
});
