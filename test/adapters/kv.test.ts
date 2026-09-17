import { describe, it, expect } from 'vitest';
import { Store } from '../../src/adapters/kv';
import { MemoryKV } from '../helpers/memoryKv';
import { makeHour, makeReport } from '../helpers/reports';
import type { Profile, Report, SpotResult } from '../../src/types';

const profile = (chatId: number): Profile => ({
  chatId, lang: 'en', workHours: { start: '09:00', end: '18:00' },
  location: { lat: -34.1085, lon: 18.4715, source: 'default' }, active: true, createdAt: '2026-09-15T19:00',
});

describe('Store profiles', () => {
  it('is empty by default and round-trips a map', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    expect(await store.getProfiles()).toEqual({});
    await store.putProfiles({ '1': profile(1) });
    expect(await store.getProfile(1)).toEqual(profile(1));
    expect(await store.getProfile(2)).toBeUndefined();
    expect(kv.writes).toEqual(['profile:1']);
  });
  it('updateProfile creates or mutates one entry with a single write', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    const created = await store.updateProfile(7, (p) => p ?? profile(7));
    expect(created.chatId).toBe(7);
    const updated = await store.updateProfile(7, (p) => ({ ...p!, active: false }));
    expect(updated.active).toBe(false);
    expect((await store.getProfiles())['7'].active).toBe(false);
    expect(kv.writes).toEqual(['profile:7', 'profile:7']);
  });

  it('two friends joining in the same instant both keep their profile — each has an entry of their own', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    // Les deux lectures passent avant les deux écritures : avec une seule entrée pour tous, la seconde effaçait la première.
    await Promise.all([store.updateProfile(1, () => profile(1)), store.updateProfile(2, () => profile(2))]);
    expect(await store.getProfiles()).toEqual({ '1': profile(1), '2': profile(2) });
  });

  it('reads every profile with one listing, from the copy stored beside each entry — no read per friend', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    await store.putProfiles({ '1': profile(1), '2': profile(2), '3': profile(3) });
    kv.gets.length = 0;
    expect(Object.keys(await store.getProfiles()).sort()).toEqual(['1', '2', '3']);
    expect(kv.gets.filter((k) => k.startsWith('profile:'))).toEqual([]);
  });

  it('pages through a listing longer than one page', async () => {
    const kv = new MemoryKV(2);
    const store = new Store(kv);
    await store.putProfiles(Object.fromEntries([1, 2, 3, 4, 5].map((id) => [String(id), profile(id)])));
    expect(Object.keys(await store.getProfiles()).sort()).toEqual(['1', '2', '3', '4', '5']);
  });

  it('stores a profile too large for its copy without it, rather than having the write refused', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    const large = { ...profile(13), note: 'x'.repeat(2000) } as unknown as Profile;
    await store.putProfiles({ '13': large });
    expect(kv.data.get('profile:13')?.metadata).toBeUndefined();
    expect(await store.getProfiles()).toEqual({ '13': large });
  });

  it('reads an entry stored without its copy (too large, or written by hand) from its value', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    await kv.put('profile:12', JSON.stringify(profile(12)));
    expect(await store.getProfiles()).toEqual({ '12': profile(12) });
  });

  it('a friend still in the old shared entry is read from it until their own entry exists, which then wins — the old entry is never written again', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    const legacy = JSON.stringify({ '7': { ...profile(7), lang: 'ru' }, '8': profile(8) });
    await kv.put('profiles', legacy);
    kv.writes.length = 0;
    expect((await store.getProfile(7))?.lang).toBe('ru');
    await store.updateProfile(7, (p) => ({ ...p!, active: false }));
    expect(kv.writes).toEqual(['profile:7']);
    expect(await store.getProfiles()).toEqual({ '7': { ...profile(7), lang: 'ru', active: false }, '8': profile(8) });
    expect(kv.data.get('profiles')?.value).toBe(legacy);
  });

  it('writes again once, a second later, whatever the error says — even an outage, not only the 429 of a second write within a second', async () => {
    const kv = new MemoryKV();
    const waits: number[] = [];
    const store = new Store(kv, { sleep: async (ms) => void waits.push(ms) });
    let failed = false;
    const put = kv.put.bind(kv);
    kv.put = async (key, value, options) => {
      if (!failed) {
        failed = true;
        throw new Error('KV PUT failed: 500 Internal Server Error');
      }
      return put(key, value, options);
    };
    await store.updateProfile(7, () => profile(7));
    expect(waits).toEqual([1100]);
    expect(await store.getProfile(7)).toEqual(profile(7));
  });

  it('gives up with the error when the second write fails too', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv, { sleep: async () => {} });
    kv.put = async () => {
      throw new Error('KV PUT failed: 429 Too Many Requests');
    };
    await expect(store.updateProfile(7, () => profile(7))).rejects.toThrow('429');
  });

  it('writes again once, a second later, when Cloudflare refuses a second write to the same entry within a second', async () => {
    const kv = new MemoryKV();
    const waits: number[] = [];
    const store = new Store(kv, { sleep: async (ms) => void waits.push(ms) });
    let refused = false;
    const put = kv.put.bind(kv);
    kv.put = async (key, value, options) => {
      if (!refused) {
        refused = true;
        throw new Error('KV PUT failed: 429 Too Many Requests');
      }
      return put(key, value, options);
    };
    await store.updateProfile(7, () => profile(7));
    expect(waits).toEqual([1100]);
    expect(await store.getProfile(7)).toEqual(profile(7));
  });

  it('coerces a language that no longer exists to English instead of crashing the renderer', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    // profil écrit par une version antérieure (locale FR retirée le 2026-09-16)
    await kv.put('profiles', JSON.stringify({ '7': { ...profile(7), lang: 'fr' } }));
    expect(await store.getProfile(7)).toEqual({ ...profile(7), lang: 'en' });
    expect((await store.getProfiles())['7'].lang).toBe('en');
  });
  it('leaves a supported language untouched', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    await kv.put('profiles', JSON.stringify({ '8': { ...profile(8), lang: 'ru' } }));
    expect((await store.getProfile(8))?.lang).toBe('ru');
  });
  it('drops the level, board and onboarding step an older version stored — nothing reads them any more', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    // un ami resté au milieu de l'ancien onboarding (niveau choisi, planche pas encore)
    await kv.put('profiles', JSON.stringify({ '9': { ...profile(9), level: 'advanced', board: 'fish', onboarding: 'board' } }));
    expect(await store.getProfile(9)).toEqual(profile(9));
  });
  it('lets a malformed entry through untouched instead of breaking the whole map', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    await kv.put('profiles', JSON.stringify({ '10': null, '11': profile(11) }));
    await expect(store.getProfiles()).resolves.toEqual({ '10': null, '11': profile(11) });
  });
});

describe('Store reports and locks', () => {
  const W = { start: '2026-09-16T07:00', end: '2026-09-16T09:00', peak: 3, mean: 3 };
  // Comme l'évaluation mémorisée : un seul objet par spot-journée, copié par ami avec sa propre distance.
  const dayOf = (spotId: string, score: number): SpotResult => ({ spotId, distanceKm: 0, hours: [makeHour('2026-09-16T07:00', score), makeHour('2026-09-16T08:00', score)], windows: [W], best: W, maxScore: score });
  const forFriend = (chatId: number, days: SpotResult[], distanceKm: number): Report =>
    makeReport({ chatId, spots: days.map((d) => ({ ...d, distanceKm })) });

  it('stores each spot-day once, however many friends share it, and gives every friend back their full report', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    const days = [dayOf('muizenberg', 3), dayOf('kommetjie-long-beach', 2)];
    const reports = Object.fromEntries([1, 2, 3].map((id) => [String(id), forFriend(id, days, id * 1.5)]));
    await store.putReports('2026-09-16', reports);
    const stored = JSON.parse(kv.data.get('reports:2026-09-16')!.value);
    expect(stored.v).toBe(2);
    expect(stored.days).toHaveLength(2);
    expect(await store.getReports('2026-09-16')).toEqual(reports);
  });

  it("keeps apart two different days of the same spot — the morning keeps the evening's report for a friend without morning data", async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    const reports = { '1': forFriend(1, [dayOf('muizenberg', 3)], 0), '2': forFriend(2, [dayOf('muizenberg', 5)], 0) };
    await store.putReports('2026-09-16', reports);
    expect(JSON.parse(kv.data.get('reports:2026-09-16')!.value).days).toHaveLength(2);
    expect(await store.getReports('2026-09-16')).toEqual(reports);
  });

  it('drops a stored report pointing at a spot-day that is not there, without touching the others', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    const good = forFriend(2, [dayOf('muizenberg', 3)], 0);
    await store.putReports('2026-09-16', { '2': good });
    const stored = JSON.parse(kv.data.get('reports:2026-09-16')!.value);
    stored.reports['1'] = { ...stored.reports['2'], chatId: 1, spots: [{ spotId: 'muizenberg', distanceKm: 0, day: 9 }] };
    await kv.put('reports:2026-09-16', JSON.stringify(stored));
    expect(await store.getReports('2026-09-16')).toEqual({ '2': good });
  });

  it('stores reports per date with a 48 h TTL', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    expect(await store.getReports('2026-09-16')).toEqual({});
    await store.putReports('2026-09-16', { '1': makeReport({ chatId: 1 }) });
    expect((await store.getReports('2026-09-16'))['1'].chatId).toBe(1);
    expect(kv.data.get('reports:2026-09-16')?.ttl).toBe(48 * 3600);
  });
  it('ignores a report stored by the pre-star version, so every reader recomputes instead of rendering NaN and undefined', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    // SpotHour d'avant le 16/09/2026 : faceFt, windRelation, facteurs perso, score sur 10, pas d'étoiles
    const oldHour = { time: '2026-09-16T07:00', faceFt: 5, periodS: 13, swellDirDeg: 225, windKt: 8, windDirDeg: 120, gustKt: 20,
      windRelation: 'offshore', tide: { state: 'high', trend: 'rising' }, factors: { size: 1, period: 1, wind: 1, tide: 1, day: 1, weather: 1 }, score: 10 };
    const old = { ...makeReport({ chatId: 1 }), spots: [{ spotId: 'kommetjie-long-beach', distanceKm: 13.4, open: true, hours: [oldHour], windows: [], maxScore: 10 }] };
    const current = makeReport({ chatId: 2, spots: [{ spotId: 'muizenberg', distanceKm: 0, hours: [makeHour('2026-09-16T07:00', 3)], windows: [], maxScore: 3 }] });
    const noSpots = makeReport({ chatId: 3, verdict: { kind: 'noData', reason: 'x' } });
    await kv.put('reports:2026-09-16', JSON.stringify({ '1': old, '2': current, '3': noSpots }));
    expect(Object.keys(await store.getReports('2026-09-16')).sort()).toEqual(['2', '3']);
  });
  it('one malformed stored report is dropped on its own, never taking every other user\'s report down with it', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    const good = makeReport({ chatId: 4, spots: [{ spotId: 'muizenberg', distanceKm: 0, hours: [makeHour('2026-09-16T07:00', 3)], windows: [], maxScore: 3 }] });
    await kv.put('reports:2026-09-16', JSON.stringify({
      '1': { ...makeReport({ chatId: 1 }), spots: [null] },
      '2': { ...makeReport({ chatId: 2 }), spots: [{ spotId: 'x', hours: 'not-an-array' }] },
      '3': { ...makeReport({ chatId: 3 }), spots: [{ spotId: 'x', hours: [null] }] },
      '4': good,
      '5': null,
    }));
    await expect(store.getReports('2026-09-16')).resolves.toEqual({ '4': good });
  });
  it('acquireLock succeeds once per date and run, with a 6 h TTL', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    expect(await store.acquireLock('2026-09-16', 'evening', '2026-09-15T19:00')).toBe(true);
    expect(await store.acquireLock('2026-09-16', 'evening', '2026-09-15T19:01')).toBe(false);
    expect(await store.acquireLock('2026-09-16', 'morning', '2026-09-16T06:00')).toBe(true);
    expect(kv.data.get('run:2026-09-16:evening')?.ttl).toBe(6 * 3600);
    expect(JSON.parse(kv.data.get('run:2026-09-16:evening')!.value)).toEqual({ startedAt: '2026-09-15T19:00' });
  });
});
