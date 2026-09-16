import { describe, it, expect } from 'vitest';
import { en } from '../../src/render/i18n/en';
import { ru } from '../../src/render/i18n/ru';
import { fill, detectLang, STRINGS } from '../../src/render/i18n';

function flatten(obj: unknown, prefix = ''): Record<string, string> {
  if (typeof obj === 'string') return { [prefix]: obj };
  if (Array.isArray(obj)) return Object.assign({}, ...obj.map((v, i) => flatten(v, `${prefix}[${i}]`)));
  return Object.assign({}, ...Object.entries(obj as Record<string, unknown>).map(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k)));
}
const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  it('en and ru have the same keys', () => {
    expect(Object.keys(flatten(ru)).sort()).toEqual(Object.keys(flatten(en)).sort());
  });
  it('en and ru have the same placeholders for every key', () => {
    const f = flatten(en);
    const r = flatten(ru);
    for (const key of Object.keys(f)) {
      expect({ key, placeholders: placeholders(r[key]) }).toEqual({ key, placeholders: placeholders(f[key]) });
    }
  });
  it('fill replaces every placeholder and rejects missing ones', () => {
    expect(fill('{a} and {b}', { a: 1, b: 'x' })).toBe('1 and x');
    expect(() => fill('{a} and {b}', { a: 1 })).toThrow(/missing placeholder "b"/);
  });
  it('detectLang maps Telegram language codes', () => {
    expect(detectLang('ru')).toBe('ru');
    expect(detectLang('ru-RU')).toBe('ru');
    expect(detectLang('en')).toBe('en');
    expect(detectLang('fr')).toBe('en');
    expect(detectLang(undefined)).toBe('en');
  });
  it('STRINGS exposes both languages', () => {
    expect(STRINGS.en.locale).toBe('en-GB');
    expect(STRINGS.ru.locale).toBe('ru-RU');
  });
});
