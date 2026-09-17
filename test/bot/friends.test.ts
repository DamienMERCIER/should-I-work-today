import { describe, it, expect } from 'vitest';
import { renderFriends, telegramName } from '../../src/bot/friends';
import { SPOTS } from '../../src/data/index';
import type { Profile } from '../../src/types';

const friend = (chatId: number, over: Partial<Profile> = {}): Profile => ({
  chatId, lang: 'en', workHours: { start: '09:00', end: '18:00' },
  location: { lat: -34.1085, lon: 18.4715, source: 'default' }, active: true, createdAt: '2026-09-16T14:33', ...over,
});

describe('telegramName', () => {
  it('joins first and last name on one line, and keeps the username', () => {
    expect(telegramName({ id: 1, first_name: ' Ivan ', last_name: 'Petrov', username: 'ivan' })).toEqual({ name: 'Ivan Petrov', username: 'ivan' });
  });

  it('strips line breaks, control and bidi characters, and caps the lengths', () => {
    const rightToLeftOverride = String.fromCharCode(0x202e);
    const out = telegramName({ id: 1, first_name: `Sa\n\nsha${rightToLeftOverride}`, username: 'x'.repeat(40) });
    expect(out.name).toBe('Sa sha');
    expect(out.username).toHaveLength(32);
    expect(telegramName({ id: 1, first_name: 'y'.repeat(100) }).name).toHaveLength(64);
  });

  it('gives nothing when Telegram gives no name', () => {
    expect(telegramName(undefined)).toEqual({});
    expect(telegramName({ id: 1 })).toEqual({});
  });
});

describe('renderFriends', () => {
  it('heads with the counts, then one line per friend by arrival: name, language, place, hours, arrival, status', () => {
    const profiles = [
      friend(2, { name: 'Olga', username: 'olga', lang: 'ru', createdAt: '2026-09-17T08:00', active: false, inactiveReason: 'stopped' }),
      friend(1, { name: 'Ivan Petrov', username: 'ivan' }),
      friend(3, {
        createdAt: '2026-09-17T09:00', active: false, inactiveReason: 'blocked',
        location: { lat: -34.133, lon: 18.329, source: 'custom' }, workHours: { start: '07:30', end: '16:30' },
      }),
    ];
    expect(renderFriends(profiles, SPOTS, 20)).toEqual([[
      '👥 <b>Amis</b> · 3 inscrits · 1 actif · 1 en pause · 1 a bloqué le bot',
      '',
      '1. Ivan Petrov (@ivan) · 🇬🇧 · Muizenberg · 9:00–18:00 · depuis le 16/09',
      '2. Olga (@olga) · 🇷🇺 · Muizenberg · 9:00–18:00 · depuis le 17/09 · ⏸️ en pause',
      '3. id 3 · 🇬🇧 · près de Long Beach · 7:30–16:30 · depuis le 17/09 · 🚫 a bloqué le bot',
    ].join('\n')]);
  });

  it('counts a friend switched off before the reason was kept as paused', () => {
    const [text] = renderFriends([friend(1, { active: false }), friend(2, { active: false }), friend(3)], SPOTS, 20);
    expect(text.split('\n')[0]).toBe('👥 <b>Amis</b> · 3 inscrits · 1 actif · 2 en pause');
    expect(text).toContain('1. id 1 · 🇬🇧 · Muizenberg · 9:00–18:00 · depuis le 16/09 · ⏸️ en pause');
  });

  it('says out of coverage for a position with no spot within the radius, and escapes names for Telegram HTML', () => {
    const [text] = renderFriends([friend(1, { name: '<b>Bob</b> & co', location: { lat: -26.2, lon: 28.04, source: 'custom' } })], SPOTS, 20);
    expect(text).toContain('1. &lt;b&gt;Bob&lt;/b&gt; &amp; co (id 1) · 🇬🇧 · hors couverture · 9:00–18:00');
  });

  it('adds the id to a name without a username — two friends can pick the same name', () => {
    const [text] = renderFriends([friend(501, { name: 'Alex Smith' }), friend(777, { name: 'Alex Smith', createdAt: '2026-09-17T10:00' })], SPOTS, 20);
    expect(text).toContain('1. Alex Smith (id 501) ·');
    expect(text).toContain('2. Alex Smith (id 777) ·');
  });

  it('still heads the list when nobody is in', () => {
    expect(renderFriends([], SPOTS, 20)).toEqual(['👥 <b>Amis</b> · 0 inscrit · 0 actif']);
  });

  it('splits a long list into messages under 4,000 characters, lines in order, the counts only once', () => {
    const many = Array.from({ length: 80 }, (_, i) => friend(i + 1, {
      name: `Friend with a rather long display name ${i + 1}`, username: `friend_number_${i + 1}`,
      createdAt: `2026-09-16T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
    }));
    const messages = renderFriends(many, SPOTS, 20);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(m.length).toBeLessThanOrEqual(4000);
    const numbers = messages.join('\n').split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => Number(l.split('.')[0]));
    expect(numbers).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
    expect(messages.filter((m) => m.includes('👥'))).toHaveLength(1);
  });
});
