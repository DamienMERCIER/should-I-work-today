import { describe, it, expect, vi } from 'vitest';
import { Store } from '../../src/adapters/kv';
import { Telegram } from '../../src/adapters/telegram';
import { REGIONS } from '../../src/data/index';
import { runEvening, runMorning, estimateBudget, notifyAdmin, type JobDeps } from '../../src/jobs/runs';
import type { Profile } from '../../src/types';
import { fakeFetch, jsonResponse } from '../helpers/fakeFetch';
import { GOLDEN_DAILY, GOLDEN_SPOTS, goldenReport, goldenSwell, goldenWind } from '../helpers/golden';
import { MemoryKV } from '../helpers/memoryKv';
import { openMeteoServer } from '../helpers/openMeteoServer';

const ready = (chatId: number, over: Partial<Profile> = {}): Profile => ({
  chatId, lang: 'en', level: 'intermediate', board: 'shortboard', workHours: { start: '09:00', end: '18:00' },
  location: { lat: -34.1085, lon: 18.4715, source: 'default' }, active: true, createdAt: '2026-09-15T19:00', ...over,
});
const JOBURG = { lat: -26.2, lon: 28.04, source: 'custom' as const };

function setup(opts: { now: string; blocked?: number[]; failMarine?: boolean; profiles?: Profile[] }) {
  const kv = new MemoryKV();
  const store = new Store(kv);
  const tg = fakeFetch((_url, init) => {
    const body = JSON.parse(String(init?.body)) as { chat_id?: number };
    return opts.blocked?.includes(body.chat_id ?? 0) ? jsonResponse({ ok: false, description: 'Forbidden: bot was blocked by the user' }, 403) : jsonResponse({ ok: true });
  });
  const om = fakeFetch(openMeteoServer({ swell: goldenSwell(), wind: goldenWind(), daily: GOLDEN_DAILY, failMarine: opts.failMarine }));
  const deps: JobDeps = {
    store, telegram: new Telegram('t', tg.fn), spots: GOLDEN_SPOTS, regions: REGIONS, fetchFn: om.fn,
    adminChatId: 999, now: () => opts.now, sleep: async () => {},
  };
  const sent = () => tg.calls.filter((c) => c.url.endsWith('/sendMessage')).map((c) => JSON.parse(String(c.init?.body)) as { chat_id: number; text: string; reply_markup?: unknown });
  const seed = async (profiles: Profile[]) => store.putProfiles(Object.fromEntries(profiles.map((p) => [String(p.chatId), p])));
  return { deps, store, kv, sent, seed, omCalls: om.calls };
}

const ALL = [ready(1), ready(2, { lang: 'ru' }), ready(3, { active: false }), ready(4, { onboarding: 'board' }), ready(5, { location: JOBURG })];

describe('runEvening', () => {
  it('sends tomorrow verdict to active, onboarded profiles and stores the reports twice', async () => {
    const { deps, store, kv, sent, seed, omCalls } = setup({ now: '2026-09-15T19:00' });
    await seed(ALL);
    const result = await runEvening(deps);
    expect(result).toEqual({ skipped: false, sent: 3, failed: 0, date: '2026-09-16' });
    expect(omCalls).toHaveLength(3); // une région (marine + forecast + période pic), le profil de Johannesburg est loin de tout
    expect(sent().map((m) => m.chat_id)).toEqual([1, 2, 5]);
    expect(sent()[0].text.startsWith("🟢 <b>DON'T GO TO WORK TOMORROW</b> (Wed 16 Sept)")).toBe(true);
    expect(sent()[1].text).toContain('ЗАВТРА НЕ ИДИ НА РАБОТУ');
    expect(sent()[2].text.startsWith('📍 No known spot')).toBe(true);
    // the evening push carries the 📍 go buttons (ordered by peak) before the 📋 row — same verdict rendering path as /now.
    expect(sent()[0].reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '📍 Go to Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
        [{ text: '📍 Go to Muizenberg', url: 'https://www.google.com/maps/search/?api=1&query=-34.1085%2C18.4715' }],
        [{ text: '📋 All spots', callback_data: 'rep:2026-09-16' }],
      ],
    });
    expect(sent()[2].reply_markup).toBeUndefined();
    const reports = await store.getReports('2026-09-16');
    expect(Object.keys(reports).sort()).toEqual(['1', '2', '5']);
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
    expect(sent()[0].text).toBe('✅ Confirmed: 🟢 Kommetjie – Long Beach 7:00–11:00');
    expect(sent()[1].text.startsWith('⚠️ Change: 🔴 go to work → 🟢 Kommetjie – Long Beach 7:00–11:00')).toBe(true);
    // the morning push is the same rendering path as the evening one — it carries the go buttons too.
    expect(sent()[0].reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '📍 Go to Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
        [{ text: '📍 Go to Muizenberg', url: 'https://www.google.com/maps/search/?api=1&query=-34.1085%2C18.4715' }],
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
    expect(sent()[0].text).toBe("⚠️ No data this morning — last night's verdict stands: 🟢 Kommetjie – Long Beach 7:00–11:00");
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
