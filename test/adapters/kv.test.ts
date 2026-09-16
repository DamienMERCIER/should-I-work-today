import { describe, it, expect } from 'vitest';
import { Store } from '../../src/adapters/kv';
import { MemoryKV } from '../helpers/memoryKv';
import { makeHour, makeReport } from '../helpers/reports';
import type { Profile } from '../../src/types';

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
    expect(kv.writes).toEqual(['profiles']);
  });
  it('updateProfile creates or mutates one entry with a single write', async () => {
    const kv = new MemoryKV();
    const store = new Store(kv);
    const created = await store.updateProfile(7, (p) => p ?? profile(7));
    expect(created.chatId).toBe(7);
    const updated = await store.updateProfile(7, (p) => ({ ...p!, active: false }));
    expect(updated.active).toBe(false);
    expect((await store.getProfiles())['7'].active).toBe(false);
    expect(kv.writes).toEqual(['profiles', 'profiles']);
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
