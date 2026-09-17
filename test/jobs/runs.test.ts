import { describe, it, expect, vi } from 'vitest';
import { Store } from '../../src/adapters/kv';
import { Telegram } from '../../src/adapters/telegram';
import { REGIONS } from '../../src/data/index';
import { runAlert, runEvening, runMorning, runWeek, estimateBudget, notifyAdmin, type JobDeps } from '../../src/jobs/runs';
import type { Profile } from '../../src/types';
import { fakeFetch, jsonResponse } from '../helpers/fakeFetch';
import { GOLDEN_DAILY, GOLDEN_SPOTS, goldenReport, goldenSwell, goldenWind, weekData } from '../helpers/golden';
import { MemoryKV } from '../helpers/memoryKv';
import { openMeteoServer, type ServerData } from '../helpers/openMeteoServer';
import { fmtDay } from '../../src/render/messages';

const ready = (chatId: number, over: Partial<Profile> = {}): Profile => ({
  chatId, lang: 'en', workHours: { start: '09:00', end: '18:00' },
  location: { lat: -34.1085, lon: 18.4715, source: 'default' }, active: true, createdAt: '2026-09-15T19:00', ...over,
});
const JOBURG = { lat: -26.2, lon: 28.04, source: 'custom' as const };

function setup(opts: { now: string; blocked?: number[]; failMarine?: boolean; profiles?: Profile[]; data?: ServerData }) {
  const kv = new MemoryKV();
  const store = new Store(kv);
  const tg = fakeFetch((_url, init) => {
    const body = JSON.parse(String(init?.body)) as { chat_id?: number };
    return opts.blocked?.includes(body.chat_id ?? 0) ? jsonResponse({ ok: false, description: 'Forbidden: bot was blocked by the user' }, 403) : jsonResponse({ ok: true });
  });
  const om = fakeFetch(openMeteoServer(opts.data ?? { swell: goldenSwell(), wind: goldenWind(), daily: GOLDEN_DAILY, failMarine: opts.failMarine }));
  const deps: JobDeps = {
    store, telegram: new Telegram('t', tg.fn), spots: GOLDEN_SPOTS, regions: REGIONS, fetchFn: om.fn,
    adminChatId: 999, now: () => opts.now, sleep: async () => {},
  };
  const sent = () => tg.calls.filter((c) => c.url.endsWith('/sendMessage')).map((c) => JSON.parse(String(c.init?.body)) as { chat_id: number; text: string; reply_markup?: unknown });
  const seed = async (profiles: Profile[]) => store.putProfiles(Object.fromEntries(profiles.map((p) => [String(p.chatId), p])));
  return { deps, store, kv, sent, seed, omCalls: om.calls };
}

// 4 : un ami resté entre les deux questions de l'ancien onboarding — il reçoit désormais le verdict
const LEGACY_MID_ONBOARDING = { ...ready(4), level: 'beginner', onboarding: 'board' } as unknown as Profile;
const ALL = [ready(1), ready(2, { lang: 'ru' }), ready(3, { active: false }), LEGACY_MID_ONBOARDING, ready(5, { location: JOBURG })];

describe('runEvening', () => {
  it('sends tomorrow verdict to every active profile — one stuck in the old onboarding included — and stores the reports twice', async () => {
    const { deps, store, kv, sent, seed, omCalls } = setup({ now: '2026-09-15T19:00' });
    await seed(ALL);
    const result = await runEvening(deps);
    expect(result).toEqual({ skipped: false, sent: 4, failed: 0, date: '2026-09-16' });
    expect(omCalls).toHaveLength(3); // une région (marine + forecast + période pic), le profil de Johannesburg est loin de tout
    expect(sent().map((m) => m.chat_id)).toEqual([1, 2, 4, 5]);
    expect(sent()[0].text.startsWith("🟢 <b>DON'T GO TO WORK TOMORROW</b> (Wed 16 Sept)")).toBe(true);
    expect(sent()[1].text).toContain('ЗАВТРА НЕ ИДИ НА РАБОТУ');
    expect(sent()[3].text.startsWith('📍 No known spot')).toBe(true);
    // the evening push carries the 📍 go buttons (ordered by peak) before the 📋 row — same verdict rendering path as /now.
    expect(sent()[0].reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "🙋 I'm going: Long Beach", callback_data: 'go:260916:kommetjie-long-beach' }, { text: '📍', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
        [{ text: '📋 All spots', callback_data: 'rep:2026-09-16' }],
      ],
    });
    expect(sent()[3].reply_markup).toBeUndefined();
    const reports = await store.getReports('2026-09-16');
    expect(Object.keys(reports).sort()).toEqual(['1', '2', '4', '5']);
    expect(reports['1'].sentAt).toBe('2026-09-15T19:00');
    expect(kv.writes.filter((k) => k === 'reports:2026-09-16')).toHaveLength(2);
    expect(kv.data.has('run:2026-09-16:evening')).toBe(true);
  });
  it('is idempotent: a replayed cron is skipped', async () => {
    const { deps, sent, seed } = setup({ now: '2026-09-15T19:00' });
    await seed([ready(1)]);
    await runEvening(deps);
    expect(await runEvening(deps)).toEqual({ skipped: true, sent: 0, failed: 0, date: '2026-09-16' });
    expect(sent()).toHaveLength(1);
  });
  it('logs and tells the admin when a send fails, deactivating a blocked profile', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { deps, store, sent, seed } = setup({ now: '2026-09-15T19:00', blocked: [2] });
      await seed([ready(1), ready(2)]);
      const result = await runEvening(deps);
      expect(result).toMatchObject({ sent: 1, failed: 1 });
      expect(await store.getProfile(2)).toMatchObject({ active: false, inactiveReason: 'blocked' });
      // les deux amis partagent le même rapport calculé : marquer l'envoi de l'un ne marque pas l'autre
      const stored = await store.getReports('2026-09-16');
      expect(stored['1'].sentAt).toBe('2026-09-15T19:00');
      expect(stored['2'].sentAt).toBeUndefined();
      expect(sent().find((m) => m.chat_id === 999)?.text).toContain('bot was blocked');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain('bot was blocked');
    } finally {
      errorSpy.mockRestore();
    }
  });
  it('a failed write while turning off a blocked profile is logged, not turned into a failed run — the messages have already gone', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { deps, store, seed } = setup({ now: '2026-09-15T19:00', blocked: [2] });
      await seed([ready(1), ready(2)]);
      store.putProfiles = async () => {
        throw new Error('KV PUT failed: 500 Internal Server Error');
      };
      await expect(runEvening(deps)).resolves.toMatchObject({ sent: 1, failed: 1 });
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('KV PUT failed'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
  it('sends noData when Open-Meteo is down', async () => {
    const { deps, sent, seed } = setup({ now: '2026-09-15T19:00', failMarine: true });
    await seed([ready(1)]);
    await runEvening(deps);
    expect(sent()[0].text).toBe('⚠️ No data (Open-Meteo unreachable). Try /now later.');
  });
  it('escapes HTML in admin notifications', async () => {
    const { deps, sent } = setup({ now: '2026-09-15T19:00' });
    await notifyAdmin(deps, 'cron <evening> failed & more');
    expect(sent()[0].text).toBe('⚙️ cron &lt;evening&gt; failed &amp; more');
  });
});

describe('runMorning', () => {
  it('a morning turned 🔴 names no spot, so it offers no 🙋 button — the 📋 row stays', async () => {
    const { deps, store, sent, seed } = setup({ now: '2026-09-16T06:00', data: weekData('2026-09-16', 9, () => 1.2) });
    await seed([ready(1)]);
    await store.putReports('2026-09-16', { '1': goldenReport({ chatId: 1 }) });
    await runMorning(deps);
    expect(sent()[0].text.startsWith('⚠️ Change: 🟢 Kommetjie – Long Beach 7:00–12:00 → 🔴 go to work')).toBe(true);
    expect(JSON.stringify(sent()[0].reply_markup)).not.toContain('"go:');
    expect(JSON.stringify(sent()[0].reply_markup)).toContain('rep:2026-09-16');
  });

  it('confirms, upgrades, and stays silent on 🔴 → 🔴', async () => {
    const { deps, store, sent, seed } = setup({ now: '2026-09-16T06:00' });
    await seed([ready(1), ready(2), ready(5, { location: JOBURG })]);
    await store.putReports('2026-09-16', {
      '1': goldenReport({ chatId: 1 }),
      '2': goldenReport({ chatId: 2, verdict: { kind: 'red', bestSpotId: 'muizenberg' } }),
      '5': goldenReport({ chatId: 5, spots: [], verdict: { kind: 'outOfCoverage', nearest: [] } }),
    });
    const result = await runMorning(deps);
    expect(result).toEqual({ skipped: false, sent: 2, failed: 0, date: '2026-09-16' });
    expect(sent().map((m) => m.chat_id)).toEqual([1, 2]);
    expect(sent()[0].text).toBe('✅ Confirmed: 🟢 Kommetjie – Long Beach 7:00–12:00');
    expect(sent()[1].text.startsWith('⚠️ Change: 🔴 go to work → 🟢 Kommetjie – Long Beach 7:00–12:00')).toBe(true);
    // the morning push is the same rendering path as the evening one — it carries the go buttons too.
    expect(sent()[0].reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "🙋 I'm going: Long Beach", callback_data: 'go:260916:kommetjie-long-beach' }, { text: '📍', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
        [{ text: '📋 All spots', callback_data: 'rep:2026-09-16' }],
      ],
    });
    const reports = await store.getReports('2026-09-16');
    expect(reports['1'].mode).toBe('morning');
    expect(reports['5'].mode).toBe('morning');
  });
  it('keeps last night report and says so when the morning has no data', async () => {
    const { deps, store, kv, sent, seed } = setup({ now: '2026-09-16T06:00', failMarine: true });
    await seed([ready(1), ready(2)]);
    await store.putReports('2026-09-16', { '1': goldenReport({ chatId: 1 }), '2': goldenReport({ chatId: 2, verdict: { kind: 'red' } }) });
    const writesBeforeRun = kv.writes.filter((k) => k === 'reports:2026-09-16').length;
    await runMorning(deps);
    expect(sent().map((m) => m.chat_id)).toEqual([1]);
    expect(sent()[0].text).toBe("⚠️ No data this morning — last night's verdict stands: 🟢 Kommetjie – Long Beach 7:00–12:00");
    expect((await store.getReports('2026-09-16'))['1'].mode).toBe('evening');
    // un envoi a eu lieu (chat 1) : le run fait bien ses deux écritures (première + sentAt).
    expect(kv.writes.filter((k) => k === 'reports:2026-09-16').length - writesBeforeRun).toBe(2);
  });
  it('treats a missing evening report as 🔴', async () => {
    const { deps, sent, seed } = setup({ now: '2026-09-16T06:00' });
    await seed([ready(1)]);
    await runMorning(deps);
    expect(sent()[0].text.startsWith('⚠️ Change: 🔴 go to work → 🟢')).toBe(true);
  });
  it('writes reports only once when nothing is sent (silent run: Johannesburg is out of coverage evening and morning)', async () => {
    const { deps, kv, sent, seed } = setup({ now: '2026-09-16T06:00' });
    await seed([ready(5, { location: JOBURG })]);
    // pas de rapport de la veille stocké : équivalent à un 🔴 pour compareReports, tout comme le hors-couverture du matin.
    const result = await runMorning(deps);
    expect(result.sent).toBe(0);
    expect(sent()).toHaveLength(0);
    expect(kv.writes.filter((k) => k === 'reports:2026-09-16')).toHaveLength(1);
  });
});

describe('budget guard', () => {
  const friends = (n: number) => Array.from({ length: n }, (_, i) => ready(i + 1, { createdAt: `2026-09-15T19:${String(i).padStart(2, '0')}` }));

  it('sends to 40 friends in one place: only Open-Meteo and Telegram count against the 50 external requests', async () => {
    const { deps, sent, seed } = setup({ now: '2026-09-15T19:00' });
    await seed(friends(40));
    const result = await runEvening(deps);
    expect(result.sent).toBe(40);
    expect(sent().some((m) => m.chat_id === 999)).toBe(false);
  });

  it('defers the newest profiles by createdAt when the external budget is exceeded, and notifies the admin', async () => {
    const { deps, sent, seed } = setup({ now: '2026-09-15T19:00' });
    // 3 (une région, Muizenberg : marine + forecast + période pic) + N envois ; dépasse 47 (50 moins la marge des alertes) pour N > 44.
    await seed(friends(48));
    const result = await runEvening(deps);
    expect(result.sent).toBe(44);
    expect(result.failed).toBe(0);
    // les 4 profils les plus récents (chatId 45 à 48) sont reportés.
    for (const chatId of [45, 46, 47, 48]) expect(sent().some((m) => m.chat_id === chatId)).toBe(false);
    expect(sent().find((m) => m.chat_id === 999)?.text).toContain('4 profil(s) reportés');
  });

  it('shares messages only between friends with the same language, place and hours — a night worker still gets their own verdict', async () => {
    // 2,3 m toute la journée : 4★, bon sans être epic — les horaires décident donc du verdict
    const { deps, sent, seed } = setup({ now: '2026-09-15T19:00', data: weekData('2026-09-16', 2, () => 2.3) });
    await seed([ready(1), ready(2), ready(3, { workHours: { start: '19:00', end: '23:00' } }), ready(4, { lang: 'ru' })]);
    await runEvening(deps);
    const texts = new Map(sent().map((m) => [m.chat_id, m.text]));
    expect(texts.get(2)).toBe(texts.get(1));
    expect(texts.get(1)?.startsWith('🟢')).toBe(true);
    expect(texts.get(3)?.startsWith('🟢')).toBe(false);
    expect(texts.get(4)).toContain('ЗАВТРА НЕ ИДИ НА РАБОТУ');
  });
});

describe('estimateBudget', () => {
  it('counts only external requests — 3 per region, 2 per place out of coverage, 1 send per profile — since KV has a limit of its own', () => {
    const { deps } = setup({ now: '2026-09-15T19:00' });
    // 3×1 région (marine + forecast + période pic) + 2 envois
    expect(estimateBudget([ready(1), ready(2)], deps)).toBe(5);
    // + 2 appels bruts pour Johannesburg, une seule fois pour deux amis au même endroit, + 3 envois
    expect(estimateBudget([ready(1), ready(5, { location: JOBURG }), ready(6, { location: JOBURG })], deps)).toBe(8);
  });
});

describe('runAlert — noon, a big day two or three days out', () => {
  // lun 21 → dim 27 : 2,3 / 1,2 / 3,5 / 0,2 m, puis on recommence ; vent de SE 8 kt partout
  const week = () => weekData('2026-09-21', 7, (i) => [2.3, 1.2, 3.5, 0.2][i % 4]);

  it('tells each active friend near a spot about an epic day in two or three days, from one load per region, and only once', async () => {
    const { deps, kv, sent, seed, omCalls } = setup({ now: '2026-09-21T12:00', data: week() });
    const inland = { lat: -33.9, lon: 18.87, source: 'custom' as const }; // à 25 km de la côte, aucun spot dans le rayon
    await seed([ready(1), ready(2, { lang: 'ru' }), ready(3, { active: false }), ready(5, { location: JOBURG }), ready(7, { location: inland })]);
    expect(await runAlert(deps)).toEqual({ skipped: false, sent: 2, failed: 0, date: '2026-09-21' });
    // mer 23 (J+2) : 3,5 m, 6★ toute la journée → alerte ; jeu 24 (J+3) : 0,2 m → rien ; hors couverture : ni alerte, ni appel
    expect(sent().map((m) => m.chat_id)).toEqual([1, 2]);
    expect(sent()[0].text.startsWith('🔥 <b>BIG DAY AHEAD</b> (Wed 23 Sept)\n🏄 Kommetjie – Long Beach · 7:00–18:00 · ⭐⭐⭐⭐⭐⭐')).toBe(true);
    expect(sent()[0].text).not.toContain('24 Sept');
    expect(sent()[1].text).toContain('БУДЕТ ЭПИЧНО');
    expect(omCalls).toHaveLength(3);
    // J+3 et sa marée du lendemain matin : cinq jours de prévision, aujourd'hui compris
    expect(omCalls.every((c) => c.url.includes('forecast_days=5'))).toBe(true);
    expect(kv.data.get('alerted:2026-09-23:1')?.ttl).toBe(5 * 24 * 3600);
    expect(kv.data.has('run:2026-09-21:alert')).toBe(true);
    expect(await runAlert(deps)).toEqual({ skipped: true, sent: 0, failed: 0, date: '2026-09-21' });
  });

  it('never announces a date twice: the next noon, only a friend who has not heard about it yet does', async () => {
    const { deps, seed, sent } = setup({ now: '2026-09-20T12:00', data: week() });
    await seed([ready(1)]);
    await runAlert(deps); // dim 20 : mer 23 est à J+3
    expect(sent().map((m) => m.chat_id)).toEqual([1]);
    await seed([ready(6, { createdAt: '2026-09-21T08:00' })]);
    deps.now = () => '2026-09-21T12:00'; // lun 21 : mer 23 est à J+2
    expect(await runAlert(deps)).toMatchObject({ sent: 1 });
    expect(sent().map((m) => m.chat_id)).toEqual([1, 6]);
  });

  it('puts two big days in one message, and remembers both', async () => {
    const { deps, kv, seed, sent } = setup({ now: '2026-09-21T12:00', data: weekData('2026-09-21', 7, () => 3.5) });
    await seed([ready(1)]);
    await runAlert(deps);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].text.split('\n').filter((l) => l.startsWith('🔥'))).toEqual(['🔥 <b>BIG DAY AHEAD</b> (Wed 23 Sept)', '🔥 <b>BIG DAY AHEAD</b> (Thu 24 Sept)']);
    expect(kv.data.has('alerted:2026-09-23:1')).toBe(true);
    expect(kv.data.has('alerted:2026-09-24:1')).toBe(true);
  });

  it('gives friends who share a place only the dates each has not heard about', async () => {
    const { deps, kv, seed, sent } = setup({ now: '2026-09-21T12:00', data: weekData('2026-09-21', 7, () => 3.5) });
    await seed([ready(1), ready(2)]);
    await kv.put('alerted:2026-09-23:1', '1', { expirationTtl: 60 });
    await runAlert(deps);
    const titles = (chatId: number) => sent().find((m) => m.chat_id === chatId)!.text.split('\n').filter((l) => l.startsWith('🔥'));
    expect(titles(1)).toEqual(['🔥 <b>BIG DAY AHEAD</b> (Thu 24 Sept)']);
    expect(titles(2)).toEqual(['🔥 <b>BIG DAY AHEAD</b> (Wed 23 Sept)', '🔥 <b>BIG DAY AHEAD</b> (Thu 24 Sept)']);
  });

  it('stays silent on good days that are not epic', async () => {
    const { deps, seed, sent } = setup({ now: '2026-09-21T12:00', data: weekData('2026-09-21', 7, () => 2.3) });
    await seed([ready(1)]);
    expect(await runAlert(deps)).toEqual({ skipped: false, sent: 0, failed: 0, date: '2026-09-21' });
    expect(sent()).toEqual([]);
  });

  it('keeps a failed send unmarked, so the next noon tries again, and turns off a friend who blocked the bot', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { deps, kv, store, seed } = setup({ now: '2026-09-21T12:00', data: week(), blocked: [2] });
      await seed([ready(1), ready(2)]);
      expect(await runAlert(deps)).toMatchObject({ sent: 1, failed: 1 });
      expect(kv.data.has('alerted:2026-09-23:1')).toBe(true);
      expect(kv.data.has('alerted:2026-09-23:2')).toBe(false);
      expect(await store.getProfile(2)).toMatchObject({ active: false, inactiveReason: 'blocked' });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('runWeek — Sunday evening, the week ahead', () => {
  const SUNDAY = '2026-09-20T19:05';
  // lun 21 → dim 27 : 2,3 / 1,2 / 3,5 / 0,2 m, puis on recommence ; vent de SE 8 kt partout
  const week = () => weekData('2026-09-21', 7, (i) => [2.3, 1.2, 3.5, 0.2][i % 4]);

  it('friends in the same place but with other work hours each get their own week — shared work never mixes them up', async () => {
    const { deps, sent, seed } = setup({ now: SUNDAY, data: week() });
    await seed([ready(1), ready(2), ready(3, { workHours: { start: '19:00', end: '23:00' } }), ready(4, { lang: 'ru' })]);
    await runWeek(deps);
    const texts = new Map(sent().map((m) => [m.chat_id, m.text]));
    expect(texts.get(2)).toBe(texts.get(1));
    expect(texts.get(1)).toContain('🟢 <b>Mon 21</b>');
    expect(texts.get(3)).toContain('🌅 <b>Mon 21</b>');
    expect(texts.get(4)).toContain('НЕДЕЛЯ ВПЕРЕДИ');
  });

  it('sends Monday to Sunday to every active profile near a spot, from one load per region, and only once', async () => {
    const { deps, sent, seed, omCalls } = setup({ now: SUNDAY, data: week() });
    await seed([ready(1), ready(2, { lang: 'ru' }), ready(3, { active: false }), ready(5, { location: JOBURG })]);
    const result = await runWeek(deps);
    expect(result).toEqual({ skipped: false, sent: 2, failed: 0, date: '2026-09-21' });
    // Johannesburg est loin de tout spot : pas de semaine vide pour lui
    expect(sent().map((m) => m.chat_id)).toEqual([1, 2]);
    const text = sent()[0].text;
    expect(text.startsWith('📅 <b>THE WEEK AHEAD</b>')).toBe(true);
    expect(text).toContain('⭐ Best: Wed 23 · Kommetjie – Long Beach ⭐⭐⭐⭐⭐⭐ · 7:00–18:00');
    expect(text).toContain('🟢 <b>Mon 21</b> · Long Beach ⭐⭐⭐⭐ · 7:00–18:00');
    expect(text).toContain('🟢 <b>Sun 27</b> · Long Beach ⭐⭐⭐⭐⭐⭐ · 7:00–18:00');
    expect(text).toContain('From Thu 24 on, a trend only: check again closer to the day.');
    expect(text).not.toContain('Today');
    expect(sent()[1].text.startsWith('📅 <b>НЕДЕЛЯ ВПЕРЕДИ</b>')).toBe(true);
    // chaque profil reçoit sa propre tranche de sept rapports, lundi → dimanche, dans sa langue
    const dayLines = (t: string): string[] => t.split('\n').filter((l) => /^(🟢|🌅|🌇|🔴|⚠️) <b>/.test(l));
    for (const [i, lang] of [[0, 'en'], [1, 'ru']] as const) {
      const lines = dayLines(sent()[i].text);
      expect(lines).toHaveLength(7);
      expect(lines[0].startsWith(`🟢 <b>${fmtDay('2026-09-21', lang)}</b>`)).toBe(true);
      expect(lines[6].startsWith(`🟢 <b>${fmtDay('2026-09-27', lang)}</b>`)).toBe(true);
    }
    expect(omCalls).toHaveLength(3);
    expect(await runWeek(deps)).toEqual({ skipped: true, sent: 0, failed: 0, date: '2026-09-21' });
  });

  it('turns off a profile that blocked the bot, like the daily runs do', async () => {
    const { deps, store, seed } = setup({ now: SUNDAY, data: week(), blocked: [2] });
    await seed([ready(1), ready(2)]);
    const result = await runWeek(deps);
    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect((await store.getProfile(2))?.active).toBe(false);
    expect((await store.getProfile(1))?.active).toBe(true);
  });
});
