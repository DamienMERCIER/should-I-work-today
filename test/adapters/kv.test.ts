import { describe, it, expect } from 'vitest';
import { Store } from '../../src/adapters/kv';
import { MemoryKV } from '../helpers/memoryKv';
import { makeReport } from '../helpers/reports';
import type { Profile } from '../../src/types';

const profile = (chatId: number): Profile => ({
  chatId, lang: 'fr', level: 'intermediate', board: 'both', workHours: { start: '09:00', end: '18:00' },
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
    const updated = await store.updateProfile(7, (p) => ({ ...p!, level: 'advanced' }));
    expect(updated.level).toBe('advanced');
    expect((await store.getProfiles())['7'].level).toBe('advanced');
    expect(kv.writes).toEqual(['profiles', 'profiles']);
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
