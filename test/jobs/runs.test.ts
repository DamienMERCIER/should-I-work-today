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
  chatId, lang: 'fr', level: 'intermediate', board: 'shortboard', workHours: { start: '09:00', end: '18:00' },
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
  const sent = () => tg.calls.filter((c) => c.url.endsWith('/sendMessage')).map((c) => JSON.parse(String(c.init?.body)) as { chat_id: number; text: string });
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
    expect(omCalls).toHaveLength(2); // une région, le profil de Johannesburg est loin de tout
    expect(sent().map((m) => m.chat_id)).toEqual([1, 2, 5]);
    expect(sent()[0].text.startsWith('🟢 <b>NE VA PAS TRAVAILLER DEMAIN</b> (mer. 16 sept.)')).toBe(true);
    expect(sent()[1].text).toContain('ЗАВТРА НЕ ИДИ НА РАБОТУ');
    expect(sent()[2].text.startsWith('📍 Aucun spot connu')).toBe(true);
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
    expect(sent()[0].text).toBe('⚠️ Pas de données (Open-Meteo injoignable). Réessaie /now plus tard.');
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
    expect(sent()[0].text).toBe('✅ Confirmé : 🟢 Kommetjie – Long Beach 7h–12h');
    expect(sent()[1].text.startsWith('⚠️ Changement : 🔴 va bosser → 🟢 Kommetjie – Long Beach 7h–12h')).toBe(true);
    const reports = await store.getReports('2026-09-16');
    expect(reports['1'].mode).toBe('morning');
    expect(reports['5'].mode).toBe('morning');
  });
  it('keeps last night report and says so when the morning has no data', async () => {
    const { deps, store, sent, seed } = setup({ now: '2026-09-16T06:00', failMarine: true });
    await seed([ready(1), ready(2)]);
    await store.putReports('2026-09-16', { '1': goldenReport({ chatId: 1 }), '2': goldenReport({ chatId: 2, verdict: { kind: 'red' } }) });
    await runMorning(deps);
    expect(sent().map((m) => m.chat_id)).toEqual([1]);
    expect(sent()[0].text).toBe("⚠️ Pas de données ce matin — le verdict d'hier soir reste : 🟢 Kommetjie – Long Beach 7h–12h");
    expect((await store.getReports('2026-09-16'))['1'].mode).toBe('evening');
  });
  it('treats a missing evening report as 🔴', async () => {
    const { deps, sent, seed } = setup({ now: '2026-09-16T06:00' });
    await seed([ready(1)]);
    await runMorning(deps);
    expect(sent()[0].text.startsWith('⚠️ Changement : 🔴 va bosser → 🟢')).toBe(true);
  });
});

describe('estimateBudget', () => {
  it('counts locks, profiles, regions, raw lookups, report writes and sends', () => {
    const { deps } = setup({ now: '2026-09-15T19:00' });
    // 3 (verrou + profils) + 2×1 région + 0 brut + 2 écritures + 2 envois = 9
    expect(estimateBudget([ready(1), ready(2)], deps, 'evening')).toBe(9);
    // + 1 lecture des rapports de la veille, + 2 appels bruts pour le profil hors couverture
    expect(estimateBudget([ready(1), ready(5, { location: JOBURG })], deps, 'morning')).toBe(12);
  });
});
