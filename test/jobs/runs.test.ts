import { describe, it, expect, vi } from 'vitest';
import { Store } from '../../src/adapters/kv';
import { Telegram } from '../../src/adapters/telegram';
import { REGIONS } from '../../src/data/index';
import { runEvening, runMorning, runWeek, estimateBudget, notifyAdmin, type JobDeps } from '../../src/jobs/runs';
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
        [{ text: '📍 Go to Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
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
      expect((await store.getProfile(2))?.active).toBe(false);
      expect(sent().find((m) => m.chat_id === 999)?.text).toContain('bot was blocked');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain('bot was blocked');
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
        [{ text: '📍 Go to Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
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
  it('defers the newest profiles by createdAt when the budget is exceeded, and notifies the admin', async () => {
    const { deps, sent, seed } = setup({ now: '2026-09-15T19:00' });
    // 3 (verrou + profils) + 3 (une région, Muizenberg : marine + forecast + période pic) + 2 (écritures) + N (envois) ; dépasse 45 pour N > 37.
    const profiles = Array.from({ length: 40 }, (_, i) => ready(i + 1, { createdAt: `2026-09-15T19:${String(i).padStart(2, '0')}` }));
    await seed(profiles);
    const result = await runEvening(deps);
    expect(result.sent).toBe(37);
    expect(result.failed).toBe(0);
    expect(sent().filter((m) => m.chat_id !== 999)).toHaveLength(37);
    // les 3 profils les plus récents (createdAt 19:37, 19:38 et 19:39, chatId 38, 39 et 40) sont reportés.
    expect(sent().some((m) => m.chat_id === 38)).toBe(false);
    expect(sent().some((m) => m.chat_id === 39)).toBe(false);
    expect(sent().some((m) => m.chat_id === 40)).toBe(false);
    const admin = sent().find((m) => m.chat_id === 999);
    expect(admin?.text).toContain('3 profil(s) reportés');
  });
});

describe('estimateBudget', () => {
  it('counts locks, profiles, regions, raw lookups, report writes and sends', () => {
    const { deps } = setup({ now: '2026-09-15T19:00' });
    // 3 (verrou + profils) + 3×1 région (marine + forecast + période pic) + 0 brut + 2 écritures + 2 envois = 10
    expect(estimateBudget([ready(1), ready(2)], deps, 'evening')).toBe(10);
    // + 1 lecture des rapports de la veille, + 2 appels bruts pour le profil hors couverture
    expect(estimateBudget([ready(1), ready(5, { location: JOBURG })], deps, 'morning')).toBe(13);
  });
});

describe('runWeek — Sunday evening, the week ahead', () => {
  const SUNDAY = '2026-09-20T19:05';
  // lun 21 → dim 27 : 2,3 / 1,2 / 3,5 / 0,2 m, puis on recommence ; vent de SE 8 kt partout
  const week = () => weekData('2026-09-21', 7, (i) => [2.3, 1.2, 3.5, 0.2][i % 4]);

  it('sends Monday to Sunday to every active profile near a spot, from one load per region, and only once', async () => {
    const { deps, sent, seed, omCalls } = setup({ now: SUNDAY, data: week() });
    await seed([ready(1), ready(2, { lang: 'ru' }), ready(3, { active: false }), ready(5, { location: JOBURG })]);
    const result = await runWeek(deps);
    expect(result).toEqual({ skipped: false, sent: 2, failed: 0, date: '2026-09-21' });
    // Johannesburg est loin de tout spot : pas de semaine vide pour lui
    expect(sent().map((m) => m.chat_id)).toEqual([1, 2]);
    const text = sent()[0].text;
    expect(text.startsWith('📅 <b>THE WEEK AHEAD</b>')).toBe(true);
    expect(text).toContain('⭐ Best: Wed 23 · Kommetjie – Long Beach ★★★★★★ · 7:00–18:00');
    expect(text).toContain('🟢 <b>Mon 21</b> · Long Beach ★★★★ · 7:00–18:00');
    expect(text).toContain('🟢 <b>Sun 27</b> · Long Beach ★★★★★★ · 7:00–18:00');
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
