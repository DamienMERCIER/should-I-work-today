import { describe, it, expect } from 'vitest';
import { Store } from '../../src/adapters/kv';
import { Telegram, type TgMessage, type TgUpdate } from '../../src/adapters/telegram';
import { handleUpdate, type BotDeps } from '../../src/bot/router';
import { parseHours } from '../../src/bot/profile';
import { REGIONS, SPOTS } from '../../src/data/index';
import type { Profile, Spot, SpotResult } from '../../src/types';
import { fakeFetch, jsonResponse } from '../helpers/fakeFetch';
import { GOLDEN_DAILY, GOLDEN_DATE, GOLDEN_SPOTS, goldenReport, goldenSwell, goldenWind, weekData } from '../helpers/golden';
import { MemoryKV } from '../helpers/memoryKv';
import { openMeteoServer, type ServerData } from '../helpers/openMeteoServer';
import { OUTER_KOM } from '../helpers/spots';
import { ALL_SPOTS_CAP, fmtDate } from '../../src/render/messages';
import { allWorldTuples, worldSpotId, worldTupleSlug, type SpotTuple } from '../../src/data/world';
import { haversineKm } from '../../src/engine/geo';

const NOW = '2026-09-16T08:30';
const TOMORROW = '2026-09-17';

const ADMIN = 999;

function setup(opts: { inviteCode?: string; adminChatId?: number; spots?: Spot[]; now?: string; data?: ServerData; worldTuples?: SpotTuple[] } = {}) {
  const kv = new MemoryKV();
  const store = new Store(kv);
  const tg = fakeFetch(() => jsonResponse({ ok: true }));
  // Vent sur aujourd'hui ET demain : un rapport bascule sur le lendemain (§nowReport) n'a de
  // données que si la série les couvre, sinon il retombe en noData et le test ne prouve rien.
  const wind = [...goldenWind(), ...goldenWind(TOMORROW)];
  const om = fakeFetch(openMeteoServer(opts.data ?? { swell: goldenSwell(), wind, daily: GOLDEN_DAILY }));
  const deps: BotDeps = {
    telegram: new Telegram('t', tg.fn), store, spots: opts.spots ?? GOLDEN_SPOTS, regions: REGIONS, fetchFn: om.fn,
    inviteCode: opts.inviteCode, adminChatId: opts.adminChatId, now: () => opts.now ?? NOW,
    worldTuples: opts.worldTuples ?? [], // the routing, not the real world import (which grows with every resume): its own tests are in spotMatch/world
  };
  const sent = () => tg.calls.filter((c) => c.url.endsWith('/sendMessage')).map((c) => JSON.parse(String(c.init?.body)) as { chat_id: number; text: string; reply_markup?: any });
  const answered = () => tg.calls.filter((c) => c.url.endsWith('/answerCallbackQuery')).length;
  return { deps, store, kv, sent, answered, omCalls: om.calls };
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
  chatId: 1, lang: 'en', workHours: { start: '09:00', end: '18:00' },
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
  it('creates a ready profile in the detected language and welcomes right away — no level or board question', async () => {
    const { deps, store, sent } = setup({ inviteCode: 'surf' });
    await handleUpdate(msg('/start surf', { from: { id: 1, language_code: 'ru' } }), deps);
    const p = await store.getProfile(1);
    expect(p?.lang).toBe('ru');
    expect(p?.active).toBe(true);
    expect(p).not.toHaveProperty('level');
    expect(p).not.toHaveProperty('board');
    expect(p).not.toHaveProperty('onboarding');
    expect(sent()).toHaveLength(1);
    expect(sent()[0].text).toBe("🏄 Готово! Каждый вечер в 19:00 я скажу, работать завтра или идти сёрфить.\n📍 Muizenberg · работа 9:00–18:00 — отправь позицию, если переехал.\n\n<b>Когда я пишу</b>\n🌅 6:00 — подтверждаю или поправляю день сёрфа\n🔥 12:00 — большой день через 2–3 дня\n📅 воскресенье 19:05 — неделя вперёд\n\n<b>Как читать</b>\n⭐ чистая волна · ☆ испорчена оншором\n🕐 часы · 🌊 уровень · ⭐ часы с жёлтыми звёздами\n🌡️ температура воды и какой гидрик взять\n\n<b>Кнопки и команды</b>\n🙋 Я еду — скажи, где катаешь, и посмотри, кто ещё едет\n🔎 /now — остаток дня · /week — неделя вперёд\n/all — все споты · /long_beach — день любого спота\n/profile — рабочие часы · /lang · /stop\n\nДанные: Open-Meteo.com (CC-BY 4.0)");
    expect(sent()[0].reply_markup.keyboard[0][0]).toEqual({ text: '🔎 Сейчас' });
    expect(sent()[0].reply_markup.keyboard[1][1]).toEqual({ text: '📍 Использовать моё местоположение', request_location: true });
  });
  it('welcomes with when it writes, how to read a forecast, and the buttons and commands', async () => {
    const { deps, sent } = setup({ inviteCode: 'surf' });
    await handleUpdate(msg('/start surf', { from: { id: 1, language_code: 'en' } }), deps);
    expect(sent()[0].text).toBe("🏄 All set! Every evening at 19:00 I tell you whether to work tomorrow or go surf.\n📍 Muizenberg · work 9:00–18:00 — send your location if you move.\n\n<b>When I write</b>\n🌅 6:00 — I confirm or update a surf day\n🔥 12:00 — a big day coming in 2–3 days\n📅 Sunday 19:05 — the week ahead\n\n<b>How to read it</b>\n⭐ clean waves · ☆ spoilt by onshore wind\n🕐 hours · 🌊 level · ⭐ hours with yellow stars\n🌡️ water temperature and the wetsuit to take\n\n<b>Buttons and commands</b>\n🙋 I'm going — say where you surf, see who else goes\n🔎 /now — the rest of today · /week — the week ahead\n/all — every spot · /long_beach — any spot's day\n/profile — work hours · /lang · /stop\n\nData: Open-Meteo.com (CC-BY 4.0)");
  });
  it('refuses every /start when no invite code is configured', async () => {
    const { deps, store, sent } = setup();
    await handleUpdate(msg('/start'), deps);
    expect(sent()[0].text).toBe('Private bot — you need the invite link.');
    expect(await store.getProfile(1)).toBeUndefined();
  });
  it('tells the admin, by name, who just joined — once they have been welcomed', async () => {
    const { deps, sent } = setup({ inviteCode: 'surf', adminChatId: ADMIN });
    await handleUpdate(msg('/start surf', { from: { id: 1, language_code: 'ru', first_name: 'Ivan', last_name: 'Petrov', username: 'ivan' } }), deps);
    expect(sent().map((m) => m.chat_id)).toEqual([1, ADMIN]);
    expect(sent()[1].text).toBe('⚙️ Ivan Petrov (@ivan, id 1) a rejoint le bot.');
  });
  it('tells the admin who was refused, and why', async () => {
    const { deps, sent } = setup({ inviteCode: 'surf', adminChatId: ADMIN });
    const olga = { id: 2, first_name: 'Olga', username: 'olga' };
    await handleUpdate(msg('/start', { from: olga }, 2), deps);
    await handleUpdate(msg('/start nope', { from: olga }, 2), deps);
    expect(sent().filter((m) => m.chat_id === 2).map((m) => m.text)).toEqual(['Private bot — you need the invite link.', 'Private bot — you need the invite link.']);
    expect(sent().filter((m) => m.chat_id === ADMIN).map((m) => m.text)).toEqual([
      "⚙️ Accès refusé à Olga (@olga, id 2) : /start sans code d'invitation.",
      "⚙️ Accès refusé à Olga (@olga, id 2) : mauvais code d'invitation.",
    ]);
  });
  it('tells the admin when every /start is refused because no invite code is configured', async () => {
    const { deps, sent } = setup({ adminChatId: ADMIN });
    await handleUpdate(msg('/start surf', { from: { id: 2, first_name: 'Olga' } }, 2), deps);
    expect(sent().filter((m) => m.chat_id === ADMIN).map((m) => m.text)).toEqual(["⚙️ Accès refusé à Olga (id 2) : INVITE_CODE n'est pas configuré."]);
  });
  it('tells the admin when a stranger writes without joining — and still says nothing to the stranger', async () => {
    const { deps, sent } = setup({ inviteCode: 'surf', adminChatId: ADMIN });
    await handleUpdate(msg('hello', { from: { id: 3, first_name: 'Sasha' } }, 3), deps);
    await handleUpdate(msg('🔎 Right now', { from: { id: 4 } }, 4), deps);
    expect(sent().map((m) => [m.chat_id, m.text])).toEqual([
      [ADMIN, "⚙️ Sasha (id 3) a écrit au bot sans l'avoir rejoint."],
      [ADMIN, "⚙️ id 4 a écrit au bot sans l'avoir rejoint."],
    ]);
  });
  it('keeps a hostile Telegram name on one escaped line — it cannot fake a second admin line', async () => {
    const { deps, sent } = setup({ inviteCode: 'surf', adminChatId: ADMIN });
    const from = { id: 5, first_name: 'Sasha\n\n⚙️ <b>Ivan</b> a rejoint le bot.\u202E', username: 'sa\u2066sha' };
    await handleUpdate(msg('hi', { from }, 5), deps);
    expect(sent().map((m) => m.text)).toEqual(["⚙️ Sasha ⚙️ &lt;b&gt;Ivan&lt;/b&gt; a rejoint le bot. (@sa sha, id 5) a écrit au bot sans l'avoir rejoint."]);
  });
  it('says nothing to anyone else when no admin is configured', async () => {
    const { deps, sent } = setup({ inviteCode: 'surf' });
    await handleUpdate(msg('/start', { from: { id: 2, first_name: 'Olga' } }, 2), deps);
    await handleUpdate(msg('hello', { from: { id: 3, first_name: 'Sasha' } }, 3), deps);
    await handleUpdate(msg('/start surf', { from: { id: 1, first_name: 'Ivan' } }), deps);
    expect(sent().map((m) => m.chat_id)).toEqual([2, 1]);
  });
  it('a friend stuck mid-way through the old two-question onboarding is simply ready now', async () => {
    const { deps, store, sent } = setup();
    // profil écrit par l'ancienne version : niveau choisi, planche jamais répondue
    await store.putProfiles({ '1': { ...ready(), level: 'beginner', onboarding: 'board' } as Profile });
    await handleUpdate(msg('/now'), deps);
    expect(sent()[0].text.startsWith('🟢')).toBe(true);
    await handleUpdate(msg('/start'), deps);
    expect(sent()[1].text.startsWith('Good to see you again')).toBe(true);
  });
  it('an old level or board button still in the chat history does nothing but stop the spinner', async () => {
    const { deps, store, sent, answered } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(cb('lvl:advanced'), deps);
    await handleUpdate(cb('board:longboard'), deps);
    await handleUpdate(cb('prof:level'), deps);
    expect(answered()).toBe(3);
    expect(sent()).toHaveLength(0);
    expect(await store.getProfile(1)).toEqual(ready());
  });
  it('/stop deactivates, /start reactivates with the keyboard and the profile summary — a friend coming back is not news for the admin', async () => {
    const { deps, store, sent } = setup({ adminChatId: ADMIN });
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/stop'), deps);
    expect(await store.getProfile(1)).toMatchObject({ active: false, inactiveReason: 'stopped' });
    await handleUpdate(msg('/start'), deps);
    expect((await store.getProfile(1))?.active).toBe(true);
    expect(await store.getProfile(1)).not.toHaveProperty('inactiveReason');
    expect(sent()[1].text.startsWith('Good to see you again — your profile is still here.')).toBe(true);
    expect(sent()[1].text).toContain('Work: 9:00–18:00');
    expect(sent()[1].text).not.toMatch(/Level|Board/);
    expect(sent()[1].reply_markup.keyboard[0].map((b: { text: string }) => b.text)).toEqual(['🔎 Right now']);
    expect(sent()[1].reply_markup.keyboard[1].map((b: { text: string }) => b.text)).toEqual(['🏠 Back to Muizenberg', '📍 Use my location']);
    expect(sent().filter((m) => m.chat_id === ADMIN)).toEqual([]);
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
    // go buttons (ordered by peak) before the 📋 row — same verdict rendering path as the evening/morning push.
    expect(sent()[0].reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "🙋 I'm going: Long Beach", callback_data: 'go:260916:kommetjie-long-beach' }],
        [{ text: '📍 Go to Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
        [{ text: '📋 All spots', callback_data: 'rep:2026-09-16' }],
      ],
    });
  });
  it('asks to turn location on when the 📍 button arrives as plain text — Telegram could not attach the position', async () => {
    const { deps, store, sent, omCalls } = setup();
    await store.putProfiles({ '1': ready(), '2': ready({ chatId: 2, lang: 'ru' }) });
    await handleUpdate(msg('📍 Use my location'), deps);
    expect(sent()[0].text).toBe("📍 Your location didn't come through. Turn on location access for Telegram in your phone settings, then tap “📍 Use my location” again (or send it via 📎 → Location).");
    await handleUpdate(msg('📍 Использовать моё местоположение', {}, 2), deps);
    expect(sent()[1].text).toBe('📍 Местоположение не пришло. Включи доступ к геолокации для Telegram в настройках телефона и снова нажми «📍 Использовать моё местоположение» (или отправь через 📎 → Геопозиция).');
    expect(omCalls).toHaveLength(0);
    expect((await store.getProfile(1))?.location.source).toBe('default');
  });
  it('the 📍 button leaves the hours question instead of being read as badly written hours', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready({ awaiting: 'hours' }) });
    await handleUpdate(msg('📍 Use my location'), deps);
    expect(sent()[0].text.startsWith("📍 Your location didn't come through.")).toBe(true);
    expect((await store.getProfile(1))?.awaiting).toBeUndefined();
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
    expect(sent()[1].text).toContain('Kommetjie – Long Beach · 8:00–12:00 · ⭐⭐⭐⭐⭐⭐');
  });
});

describe('/now on a 🔴 day', () => {
  it('offers 🙋 for the best spot the message names', async () => {
    const { deps, store, sent } = setup({ data: weekData(GOLDEN_DATE, 9, () => 1.2) });
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/now'), deps);
    expect(sent()[0].text).toContain('🥇 Kommetjie – Long Beach');
    expect(sent()[0].reply_markup.inline_keyboard[0]).toEqual([{ text: "🙋 I'm going: Long Beach", callback_data: 'go:260916:kommetjie-long-beach' }]);
  });
});

describe('/now once the light has gone', () => {
  // 19:30 : le soleil s'est couché à 18:38, donc plus une seule heure de la journée ne passe le
  // seuil des 45 min de jour. Répondre « pour le reste d'aujourd'hui » ne peut donner que des zéros.
  const evening = { now: `${GOLDEN_DATE}T19:30` };

  it('answers for tomorrow, and says so, instead of a wall of zeros', async () => {
    const { deps, store, sent } = setup(evening);
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/now'), deps);
    expect(sent()[0].text).toContain('Today is done');
    expect(sent()[0].text).toContain(fmtDate(TOMORROW, 'en'));
  });

  it('the tomorrow report actually has data (not a silent noData fallback)', async () => {
    const { deps, store, sent } = setup(evening);
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/now'), deps);
    expect(sent()[0].text).not.toContain('No data');
    expect(sent()[0].reply_markup?.inline_keyboard?.length).toBeGreaterThan(0);
  });

  it('/<spot> after dark shows tomorrow, so its 🙋 is for tomorrow', async () => {
    const { deps, store, sent } = setup(evening);
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/long_beach'), deps);
    expect(sent()[0].reply_markup.inline_keyboard[0]).toEqual([{ text: "🙋 I'm going: Long Beach", callback_data: 'go:260917:kommetjie-long-beach' }]);
  });

  it('says it in Russian for a Russian profile', async () => {
    const { deps, store, sent } = setup(evening);
    await store.putProfiles({ '1': ready({ lang: 'ru' }) });
    await handleUpdate(msg('/now'), deps);
    expect(sent()[0].text).toContain('На сегодня всё');
  });

  it('a live location sent after dark also answers for tomorrow', async () => {
    const { deps, store, sent } = setup(evening);
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg(undefined, { location: { latitude: -34.1085, longitude: 18.4715 } }), deps);
    expect(sent()[0].text).toContain('Today is done');
  });

  it('still answers for today while a daylight hour remains', async () => {
    const { deps, store, sent } = setup({ now: `${GOLDEN_DATE}T17:00` }); // coucher 18:38 : 17:00 et 18:00 comptent encore
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/now'), deps);
    expect(sent()[0].text).not.toContain('Today is done');
  });

  it('does not roll over before sunrise — the whole day is still ahead', async () => {
    const { deps, store, sent } = setup({ now: `${GOLDEN_DATE}T04:00` });
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/now'), deps);
    expect(sent()[0].text).not.toContain('Today is done');
  });
});

describe('/week — the week ahead', () => {
  // mer 16 (aujourd'hui) → : 3,5 / 2,3 / 1,2 / 0,2 m, puis on recommence ; vent de SE 8 kt partout
  const week = weekData(GOLDEN_DATE, 10, (i) => [3.5, 2.3, 1.2, 0.2][i % 4]);
  const dayLines = (text: string): string[] => text.split('\n').filter((l) => /^(🟢|🌅|🌇|🔴|⚠️) <b>/.test(l));

  it('includes the rest of today while daylight remains, then six more days, from one load per region', async () => {
    const { deps, store, sent, omCalls } = setup({ data: week });
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/week'), deps);
    expect(sent()).toHaveLength(1);
    const text = sent()[0].text;
    expect(text.startsWith('📅 <b>THE WEEK AHEAD</b>')).toBe(true);
    const lines = dayLines(text);
    expect(lines).toHaveLength(7);
    // 18:00 n'a que 38 min de jour (coucher 18:38) : les fenêtres se ferment à 18:00
    expect(lines[0]).toBe('🟢 <b>Today</b> · Long Beach ⭐⭐⭐⭐⭐⭐ · 8:00–18:00');
    expect(lines[1]).toBe('🟢 <b>Thu 17</b> · Long Beach ⭐⭐⭐⭐ · 7:00–18:00');
    expect(lines[2]).toBe('🔴 <b>Fri 18</b> · Long Beach ⭐⭐⭐');
    expect(lines[3]).toBe('🔴 <b>Sat 19</b> · 0★ everywhere');
    expect(lines[6]).toBe('🔴 <b>Tue 22</b> · Long Beach ⭐⭐⭐');
    // dimanche 20 fait aussi 6★ : à égalité, le plus tôt gagne
    expect(text).toContain(`⭐ Best: Today · Kommetjie – Long Beach ⭐⭐⭐⭐⭐⭐ · 8:00–18:00`);
    expect(omCalls).toHaveLength(3);
    expect(omCalls.every((c) => c.url.includes('forecast_days=8'))).toBe(true);
  });

  it('starts tomorrow once the light has gone — never a day of zeros', async () => {
    const { deps, store, sent } = setup({ data: week, now: `${GOLDEN_DATE}T19:30` });
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/week'), deps);
    const lines = dayLines(sent()[0].text);
    expect(lines).toHaveLength(7);
    expect(lines[0].startsWith('🟢 <b>Thu 17</b>')).toBe(true);
    expect(lines[6]).toBe('🔴 <b>Wed 23</b> · 0★ everywhere');
    expect(sent()[0].text).not.toContain('Today');
  });

  it('answers like /now far from any known spot, without fetching a week for nothing', async () => {
    const { deps, store, sent, omCalls } = setup({ data: week });
    await store.putProfiles({ '1': ready({ location: { lat: -33.9, lon: 18.87, source: 'custom' } }) });
    await handleUpdate(msg('/week'), deps);
    expect(sent()[0].text.startsWith('📍 No known spot within 20 km.')).toBe(true);
    expect(omCalls.length).toBeLessThanOrEqual(2);
  });
});

describe('/profil, hours, /lang, help', () => {
  it('shows the summary and edits hours through the awaiting state', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/profil'), deps);
    expect(sent()[0].text).toBe('Profile\nWork: 9:00–18:00\nLocation: Muizenberg (default)');
    expect(sent()[0].reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data)).toEqual(['prof:hours']);

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
  it('/lang switches the language and the keyboard', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/lang'), deps);
    expect(sent()[0].reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data)).toEqual(['lang:en', 'lang:ru']);
    await handleUpdate(cb('lang:ru'), deps);
    expect((await store.getProfile(1))?.lang).toBe('ru');
    expect(sent()[1].text).toBe('Язык: русский');
    expect(sent()[1].reply_markup.keyboard[0][0].text).toBe('🔎 Сейчас');
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
    // les spots dont la vue montre une rangée, en boutons qui ouvrent leur journée
    expect(sent()[0].text.split('\n').pop()).toBe('👇 Tap a spot for its day');
    expect(sent()[0].reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Long Beach 6⭐', callback_data: 'spot:kommetjie-long-beach' }, { text: 'Muizenberg 2☆', callback_data: 'spot:muizenberg' }]],
    });
    await handleUpdate(cb('rep:2026-09-17'), deps);
    expect(sent()[1].text.startsWith('📋 <b>Your day</b> (Thu 17 Sept)')).toBe(true);
    await handleUpdate(cb('rep:2020-01-01'), deps);
    expect(sent()[2].text).toBe('Too old — run /now.');
    expect(answered()).toBe(3);
  });
});

describe('📋 and /all end with a button per spot', () => {
  it('offers only the spots the 📋 view shows — a spot at 0★ all day is counted, not offered —, the name alone without stars, and says it in Russian too', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready(), '2': ready({ chatId: 2, lang: 'ru' }) });
    const flat: SpotResult = { spotId: 'muizenberg', distanceKm: 0, hours: [], windows: [], best: undefined, maxScore: 0 };
    const report = goldenReport({ spots: [goldenReport().spots[0], flat] });
    await store.putReports('2026-09-16', { '1': report, '2': { ...report, chatId: 2 } });
    await handleUpdate(cb('rep:2026-09-16'), deps);
    expect(sent()[0].text).toContain('1 spots at 0★ all day');
    expect(sent()[0].reply_markup).toEqual({ inline_keyboard: [[{ text: 'Long Beach 6⭐', callback_data: 'spot:kommetjie-long-beach' }]] });
    await handleUpdate(msg('/all', {}, 2), deps);
    expect(sent()[1].text.trim().split('\n').pop()).toBe('👇 Нажми на спот, чтобы открыть его день');
    expect(sent()[1].reply_markup.inline_keyboard[0]).toEqual([
      { text: 'Long Beach 6⭐', callback_data: 'spot:kommetjie-long-beach' }, { text: 'Muizenberg', callback_data: 'spot:muizenberg' },
    ]);
  });

  it('a spot button opens that spot\'s day, exactly like its command', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await store.putReports('2026-09-16', { '1': goldenReport() });
    await handleUpdate(msg('/long_beach'), deps);
    await handleUpdate(cb('spot:kommetjie-long-beach'), deps);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toEqual({ ...sent()[0] });
    await handleUpdate(cb('spot:nope'), deps);
    expect(sent()).toHaveLength(2);
  });
});

describe('🙋 going — who is surfing that day', () => {
  const LB = 'kommetjie-long-beach';
  const KOM = 'Kommetjie – Long Beach';
  const MUIZ = "Muizenberg – Surfer's Corner";

  it('saves where the friend goes and answers them alone with who is going that day, them first', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({
      '1': ready({ name: 'Damien' }), '2': ready({ chatId: 2, name: '<b>Ivan</b>' }), '3': ready({ chatId: 3, username: 'olga' }), '4': ready({ chatId: 4 }),
    });
    await store.setGoing('2026-09-16', 2, LB, '2026-09-15T19:10');
    await store.setGoing('2026-09-16', 3, 'muizenberg', '2026-09-15T19:20');
    await store.setGoing('2026-09-16', 4, LB, '2026-09-15T19:30');
    await handleUpdate(cb(`go:260916:${LB}`), deps);
    expect(await store.goingOn('2026-09-16')).toContainEqual({ chatId: 1, spotId: LB, at: NOW });
    expect(sent().map((m) => m.chat_id)).toEqual([1]);
    expect(sent()[0].text).toBe(["🙋 <b>Who's going</b> (Wed 16 Sept)", `${KOM}: you, &lt;b&gt;Ivan&lt;/b&gt;, a friend`, `${MUIZ}: @olga`].join('\n'));
    expect(sent()[0].reply_markup).toEqual({ inline_keyboard: [[{ text: "✖️ I'm not going any more", callback_data: 'nogo:260916' }]] });
  });

  it('shows the friend where they just chose even when the list has not caught up yet — they can only be at one spot a day', async () => {
    const { deps, store, kv, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await store.setGoing('2026-09-16', 1, 'muizenberg', '2026-09-16T07:00');
    const stale = await kv.list({ prefix: 'going:2026-09-16:' });
    const list = kv.list.bind(kv);
    kv.list = async (o) => (o.prefix.startsWith('going:') ? stale : list(o));
    await handleUpdate(cb(`go:260916:${LB}`), deps);
    expect(sent()[0].text).toBe(["🙋 <b>Who's going</b> (Wed 16 Sept)", `${KOM}: you`].join('\n'));
  });

  it('spends no KV write on a tap that changes nothing — the same spot again, or ✖️ with nothing to cancel', async () => {
    const { deps, store, kv, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(cb(`go:260916:${LB}`), deps);
    deps.now = () => '2026-09-16T08:45';
    await handleUpdate(cb(`go:260916:${LB}`), deps);
    expect(kv.writes.filter((k) => k.startsWith('going:'))).toEqual(['going:2026-09-16:1']);
    expect(await store.goingOf('2026-09-16', 1)).toMatchObject({ at: NOW }); // l'heure du premier appui reste
    await handleUpdate(cb('nogo:260917'), deps);
    expect(kv.writes.filter((k) => k.startsWith('going:'))).toEqual(['going:2026-09-16:1']);
    expect(sent().at(-1)?.text).toBe("👌 Noted, you're not going on Thu 17 Sept.");
  });

  it('✖️ removes the entry and says so, in the friend\'s language', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready(), '2': ready({ chatId: 2, lang: 'ru' }) });
    await store.setGoing('2026-09-16', 1, LB, '2026-09-16T07:00');
    await handleUpdate(cb('nogo:260916'), deps);
    expect(await store.goingOn('2026-09-16')).toEqual([]);
    expect(sent()[0].text).toBe("👌 Noted, you're not going on Wed 16 Sept.");
    await handleUpdate(cb(`go:260916:${LB}`, 2), deps);
    expect(sent()[1].text.split('\n')).toEqual([`🙋 <b>Кто едет</b> (${fmtDate('2026-09-16', 'ru')})`, `${KOM}: ты`]);
  });

  it('ignores a forged or broken button, and says a past day is over', async () => {
    const { deps, store, kv, sent } = setup();
    await store.putProfiles({ '1': ready() });
    // 30 février : `Date` le lirait comme le 2 mars
    // les boutons ne visent qu'aujourd'hui ou demain : après-demain vient d'un bouton fabriqué
    for (const data of ['go:260916:nope', `go:2609:${LB}`, `go:260918:${LB}`, `go:260230:${LB}`, 'go:260916', 'nogo:xx']) await handleUpdate(cb(data), deps);
    expect(sent()).toEqual([]);
    await handleUpdate(cb(`go:260915:${LB}`), deps);
    expect(sent().map((m) => m.text)).toEqual(['Too old — run /now.']);
    expect(kv.writes.filter((k) => k.startsWith('going:'))).toEqual([]);
  });
});

describe('/amis — the admin sees who is in', () => {
  it('lists every friend with the Telegram name they joined with, to the admin', async () => {
    const { deps, store, sent } = setup({ inviteCode: 'surf', adminChatId: ADMIN });
    await store.putProfiles({ [String(ADMIN)]: ready({ chatId: ADMIN, createdAt: '2026-09-15T08:00' }) });
    await handleUpdate(msg('/start surf', { from: { id: 5, first_name: 'Ivan', last_name: 'Petrov', username: 'ivan' } }, 5), deps);
    expect(await store.getProfile(5)).toMatchObject({ name: 'Ivan Petrov', username: 'ivan' });
    await handleUpdate(msg('/amis', {}, ADMIN), deps);
    const list = sent().filter((m) => m.chat_id === ADMIN).map((m) => m.text).find((t) => t.startsWith('👥'));
    expect(list).toContain('· 2 inscrits · 2 actifs');
    expect(list).toContain('Ivan Petrov (@ivan) · 🇬🇧 · Muizenberg');
  });

  it("keeps the admin's own name up to date too", async () => {
    const { deps, store } = setup({ adminChatId: ADMIN });
    await store.putProfiles({ [String(ADMIN)]: ready({ chatId: ADMIN, name: 'Old' }) });
    await handleUpdate(msg('/amis', { from: { id: ADMIN, first_name: 'Damien' } }, ADMIN), deps);
    expect((await store.getProfile(ADMIN))?.name).toBe('Damien');
  });

  it('works for the admin even without a profile of their own', async () => {
    const { deps, store, sent } = setup({ adminChatId: ADMIN });
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/amis', {}, ADMIN), deps);
    expect(sent().map((m) => [m.chat_id, m.text.split('\n')[0]])).toEqual([[ADMIN, '👥 <b>Amis</b> · 1 inscrit · 1 actif']]);
  });

  it('is just an unknown command for any other friend', async () => {
    const { deps, store, sent } = setup({ adminChatId: ADMIN });
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/amis'), deps);
    expect(sent().map((m) => m.chat_id)).toEqual([1]);
    expect(sent()[0].text.startsWith('Commands:')).toBe(true);
  });

  it('also picks up a new name from a button press, and from a friend coming back with /start', async () => {
    const { deps, store } = setup();
    await store.putProfiles({ '1': ready({ name: 'Ivan', active: false, inactiveReason: 'stopped' }) });
    const press = cb('lang:en');
    press.callback_query!.from = { id: 1, first_name: 'Vanya' };
    await handleUpdate(press, deps);
    expect((await store.getProfile(1))?.name).toBe('Vanya');
    await handleUpdate(msg('/start', { from: { id: 1, first_name: 'Ivan', username: 'ivan' } }), deps);
    expect(await store.getProfile(1)).toMatchObject({ active: true, name: 'Ivan', username: 'ivan' });
  });

  it('keeps each Telegram name up to date — a write only when it changed', async () => {
    const { deps, store, kv } = setup();
    await store.putProfiles({ '1': ready({ name: 'Ivan', username: 'ivan' }) });
    kv.writes.length = 0;
    await handleUpdate(msg('/profil', { from: { id: 1, first_name: 'Ivan', username: 'ivan' } }), deps);
    expect(kv.writes).toEqual([]);
    await handleUpdate(msg('/profil', { from: { id: 1, first_name: 'Ivan', last_name: 'Petrov' } }), deps);
    expect(kv.writes).toEqual(['profile:1']);
    const updated = await store.getProfile(1);
    expect(updated?.name).toBe('Ivan Petrov');
    expect(updated).not.toHaveProperty('username');
  });
});

describe('/all, /<spot> and /about', () => {
  it('/all uses the stored report, titles "All spots", shows every spot and ends with a tappable command line ordered like the rows above', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await store.putReports('2026-09-16', { '1': goldenReport() });
    await handleUpdate(msg('/all'), deps);
    expect(sent()).toHaveLength(1);
    const text = sent()[0].text;
    expect(text.startsWith('📋 <b>All spots</b> (Wed 16 Sept)')).toBe(true);
    expect(text).toContain('🏄 Kommetjie – Long Beach');
    expect(text.trim().split('\n').pop()).toBe('👇 Tap a spot for its day');
    // a button per spot, two per row, in the rows' order; then the go buttons (ordered by peak), no 📋 row —
    // /all already lists everything, so opening the same panel again would be redundant.
    expect(sent()[0].reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'Long Beach 6⭐', callback_data: 'spot:kommetjie-long-beach' }, { text: 'Muizenberg 2☆', callback_data: 'spot:muizenberg' }],
        [{ text: '📍 Go to Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
      ],
    });
  });

  it('/all offers an imported spot a button too', async () => {
    const tuple = allWorldTuples()[0];
    const imported: SpotResult = { spotId: worldSpotId(tuple[0], tuple[2], tuple[3]), distanceKm: 5, hours: [], windows: [], best: undefined, maxScore: 3 };
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await store.putReports('2026-09-16', { '1': goldenReport({ spots: [...goldenReport().spots, imported] }) });
    await handleUpdate(msg('/all'), deps);
    const buttons = sent()[0].reply_markup.inline_keyboard.flat() as { text: string; callback_data?: string }[];
    expect(buttons).toContainEqual({ text: `${tuple[1]} 3⭐`, callback_data: `spot:${imported.spotId}` });
  });

  it('/all in a dense cluster caps at ALL_SPOTS_CAP rows and keeps its spot buttons in exact sync with them (§report "Resilience, wiring and dedupe")', async () => {
    const n = 80;
    const manySpots: Spot[] = Array.from({ length: n }, (_, i) => ({
      id: `world-${i}`, name: `World Spot ${i}`, short: `W${i}`, region: 'cape-peninsula', lat: 0, lon: 0, facing: 0,
      swellWindow: [0, 90], exposure: 0.7, tide: { best: [], forbidden: [] }, levels: {}, character: 'punchy', verified: false,
    }));
    // de 10★ à 1★, jamais croissant : le tri stable garde world-0 en tête et l'ordre d'insertion ensuite
    const manyResults: SpotResult[] = manySpots.map((s, i) => ({ spotId: s.id, distanceKm: 1, hours: [], windows: [], best: undefined, maxScore: 10 - Math.floor((10 * i) / n) }));

    const { deps, store, sent } = setup({ spots: manySpots });
    await store.putProfiles({ '1': ready() });
    // verdict: 'red' (no spotId pick) so openSpotOrder falls back to the highest-rated spot in
    // `spots` (world-0) — goldenReport()'s default verdict picks kommetjie-long-beach, which isn't in
    // this report's (fully replaced) spots array at all.
    await store.putReports('2026-09-16', { '1': goldenReport({ spots: manyResults, verdict: { kind: 'red' } }) });
    await handleUpdate(msg('/all'), deps);

    const text = sent()[0].text;
    expect(text.length).toBeLessThan(2500); // comfortably under Telegram's 4096-char limit
    expect(text).toContain('+49 more spots not shown'); // 80 - 1 primary - 30 shown

    const spotButtons = (sent()[0].reply_markup.inline_keyboard.flat() as { callback_data?: string }[]).filter((b) => b.callback_data?.startsWith('spot:'));
    expect(spotButtons).toHaveLength(1 + ALL_SPOTS_CAP); // primary + capped others, never all 80
    expect(spotButtons[0].callback_data).toBe('spot:world-0'); // primary: highest score
    expect(spotButtons[spotButtons.length - 1].callback_data).toBe(`spot:world-${ALL_SPOTS_CAP}`); // the ALL_SPOTS_CAP-th other — same set as the rows above
  });

  it('/<spot> renders that spot\'s day for a spot with a window (fresh now-mode computation, nothing stored)', async () => {
    const { deps, store, sent, omCalls } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/long_beach'), deps);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].text.startsWith('🏄 Kommetjie – Long Beach · 8:00–12:00')).toBe(true);
    expect(omCalls.length).toBeGreaterThan(0);
    // the per-spot command's 🙋 for that spot and day, then its go button, in English.
    expect(sent()[0].reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "🙋 I'm going: Long Beach", callback_data: 'go:260916:kommetjie-long-beach' }],
        [{ text: '📍 Go to Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
      ],
    });
  });

  it('Russian: the per-spot buttons use the localized templates', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready({ lang: 'ru' }) });
    await handleUpdate(msg('/long_beach'), deps);
    expect(sent()[0].reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '🙋 Я еду: Long Beach', callback_data: 'go:260916:kommetjie-long-beach' }],
        [{ text: '📍 Маршрут до Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
      ],
    });
  });

  it('a per-spot command always offers that spot\'s 🙋 and go buttons, even at 0★ or without a window today', async () => {
    const { deps, store, sent } = setup({ spots: [...GOLDEN_SPOTS, OUTER_KOM] });
    await store.putProfiles({ '1': ready() });
    const nothing: SpotResult = { spotId: 'outer-kom', distanceKm: 14.5, hours: [], windows: [], best: undefined, maxScore: 0 };
    const flat: SpotResult = { spotId: 'muizenberg', distanceKm: 0, hours: [], windows: [], best: undefined, maxScore: 2 };
    await store.putReports('2026-09-16', { '1': goldenReport({ spots: [nothing, flat] }) });

    await handleUpdate(msg('/outer_kom'), deps);
    expect(sent()[0].text.startsWith('🏄 Kommetjie – Outer Kom')).toBe(true);
    expect(sent()[0].text).not.toContain('closed');
    expect(sent()[0].reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "🙋 I'm going: Outer Kom", callback_data: 'go:260916:outer-kom' }],
        [{ text: '📍 Go to Outer Kom', url: 'https://www.google.com/maps/search/?api=1&query=-34.142%2C18.319' }],
      ],
    });

    await handleUpdate(msg('/muizenberg'), deps);
    expect(sent()[1].reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "🙋 I'm going: Muizenberg", callback_data: 'go:260916:muizenberg' }],
        [{ text: '📍 Go to Muizenberg', url: 'https://www.google.com/maps/search/?api=1&query=-34.1085%2C18.4715' }],
      ],
    });
  });

  it('matches by exact slug, exact id, unique prefix and unique substring', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await store.putReports('2026-09-16', { '1': goldenReport() });
    for (const cmd of ['/long_beach', '/kommetjie_long_beach', '/kommetjie', '/beach']) {
      await handleUpdate(msg(cmd), deps);
    }
    expect(sent()).toHaveLength(4);
    for (const m of sent()) expect(m.text.startsWith('🏄 Kommetjie – Long Beach')).toBe(true);
  });

  it('an ambiguous spot query lists the candidate commands and sends nothing else (no report fetch)', async () => {
    const { deps, store, sent, omCalls } = setup({ spots: SPOTS });
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/reef'), deps);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].text).toBe('Multiple matches: /kalk_bay, /nahoon_reef — be more specific.');
    expect(omCalls).toHaveLength(0);
  });

  it('an unknown spot query falls back to the help text', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/zzznotaspot'), deps);
    expect(sent()[0].text.startsWith('Commands:')).toBe(true);
  });

  it('a known but out-of-radius spot replies with its distance and fetches no forecast', async () => {
    const { deps, store, sent, omCalls } = setup({ spots: SPOTS });
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/vic_bay'), deps);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].text).toBe('Victoria Bay is a known spot, but it is 376 km away — outside your 20 km radius.');
    expect(omCalls).toHaveLength(0);
  });

  it('reaches imported spots too: /about counts them, and /<slug> finds one', async () => {
    const tofo: SpotTuple = ['Tofo', 'Tofo', -23.8522, 35.5478, 90, 0];
    const { deps, store, sent, omCalls } = setup({ worldTuples: [tofo] });
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/about'), deps);
    await handleUpdate(msg('/tofo'), deps);
    const km = Math.round(haversineKm(ready().location, { lat: tofo[2], lon: tofo[3] }));
    expect(sent()[0].text.startsWith(`Should I Work checks ${GOLDEN_SPOTS.length + 1} known surf spots`)).toBe(true);
    expect(sent()[1].text).toBe(`Tofo is a known spot, but it is ${km} km away — outside your 20 km radius.`);
    expect(omCalls).toHaveLength(0);
  });

  it('/about states what the bot does, the licence and the spot count', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('/about'), deps);
    expect(sent()[0].text).toBe(
      'Should I Work checks 2 known surf spots every evening and tells you whether to work tomorrow or go surf.\nData: Open-Meteo.com (CC-BY 4.0)',
    );
  });

  it('help gains /all, /about and a real spot-command example', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready() });
    await handleUpdate(msg('hello'), deps);
    const text = sent()[0].text;
    expect(text.startsWith('Commands:')).toBe(true);
    expect(text).toContain('/all');
    expect(text).toContain('/week');
    expect(text).toContain('/about');
    expect(text).toContain('/long_beach');
    expect(text).toContain("🙋 I'm going, under a forecast — see who else goes");
    expect(text).toContain('⭐ clean waves · ☆ spoilt by onshore wind · 🌡️ water and wetsuit');
  });

  it('help says the same in Russian', async () => {
    const { deps, store, sent } = setup();
    await store.putProfiles({ '1': ready({ lang: 'ru' }) });
    await handleUpdate(msg('привет'), deps);
    const text = sent()[0].text;
    expect(text.startsWith('Команды:')).toBe(true);
    expect(text).toContain('🙋 «Я еду» под прогнозом — посмотри, кто ещё едет');
    expect(text).toContain('⭐ чистая волна · ☆ испорчена оншором · 🌡️ вода и гидрик');
  });

  it('Russian: /about and the out-of-radius reply', async () => {
    const { deps, store, sent } = setup({ spots: SPOTS });
    await store.putProfiles({ '1': ready({ lang: 'ru' }) });
    await handleUpdate(msg('/about'), deps);
    expect(sent()[0].text).toBe(
      'Should I Work каждый вечер проверяет 35 известных спотов и подсказывает: завтра сёрфить или работать.\nДанные: Open-Meteo.com (CC-BY 4.0)',
    );
    await handleUpdate(msg('/vic_bay'), deps);
    expect(sent()[1].text).toBe('Victoria Bay — известный спот, но он в 376 км от тебя — за пределами радиуса 20 км.');
  });
});
