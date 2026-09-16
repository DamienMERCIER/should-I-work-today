import { describe, it, expect } from 'vitest';
import { deriveShort, shortSlug } from '../../scripts/lib/shortName';
import { spotSlug } from '../../src/bot/spotMatch';
import type { Spot } from '../../src/types';

describe('deriveShort', () => {
  it('keeps a short name as-is when it already fits', () => {
    const used = new Set<string>();
    expect(deriveShort('Muizenberg', used)).toBe('Muizenberg');
  });

  it('truncates to the ≤ 13 char rule (default cap)', () => {
    const used = new Set<string>();
    const short = deriveShort('A Very Long Spot Name Indeed', used);
    expect(short.length).toBeLessThanOrEqual(13);
  });

  it('honours a custom max length (the importer uses 11 for unverified world spots)', () => {
    const used = new Set<string>();
    const short = deriveShort('A Very Long Spot Name Indeed', used, 11);
    expect(short.length).toBeLessThanOrEqual(11);
  });

  it('suffixes on a collision and stays unique and ≤ 13 chars (synthetic collision)', () => {
    const used = new Set<string>();
    const a = deriveShort('Long Beach', used);
    const b = deriveShort('Long Beach', used);
    expect(a).toBe('Long Beach');
    expect(b).not.toBe(a);
    expect(b.length).toBeLessThanOrEqual(13);
    expect(shortSlug(b)).not.toBe(shortSlug(a));
  });

  it('treats different punctuation/case as the same slug and still disambiguates', () => {
    const used = new Set<string>();
    const a = deriveShort('Vic Bay', used);
    const b = deriveShort('vic-bay', used); // same spotSlug as "Vic Bay" once normalised
    expect(shortSlug(a)).not.toBe(shortSlug(b));
  });

  it('keeps disambiguating and staying within the cap over many collisions of the same base name', () => {
    const used = new Set<string>();
    const shorts = Array.from({ length: 15 }, () => deriveShort('Point', used, 13));
    expect(new Set(shorts.map(shortSlug)).size).toBe(15); // all unique once slugified
    for (const s of shorts) expect(s.length).toBeLessThanOrEqual(13);
  });

  it('never returns an empty string, even for a name with no alphanumerics', () => {
    const used = new Set<string>();
    expect(deriveShort('***', used).length).toBeGreaterThan(0);
  });

  it('strips diacritics so the slug stays ASCII (e.g. accented place names)', () => {
    const used = new Set<string>();
    const short = deriveShort('Île de Ré', used);
    expect(short).toBe('Ile de Re');
    expect(short).not.toMatch(/[îÎéÉ]/);
  });
});

describe('shortSlug', () => {
  it('matches src/bot/spotMatch.ts\'s spotSlug for the same label (no drift between the two implementations)', () => {
    for (const short of ['Long Beach', 'Misty Cliffs', 'Vic Bay', 'The Hoek', 'Ding Dangs']) {
      expect(shortSlug(short)).toBe(spotSlug({ short } as Spot));
    }
  });
});
