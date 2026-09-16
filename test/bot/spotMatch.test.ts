import { describe, it, expect } from 'vitest';
import { SPOTS } from '../../src/data/index';
import { matchSpot, spotSlug } from '../../src/bot/spotMatch';

const byId = (id: string) => {
  const spot = SPOTS.find((s) => s.id === id);
  if (!spot) throw new Error(`fixture spot not found: ${id}`);
  return spot;
};

describe('spotSlug', () => {
  it('has exactly 35 spots in the database (sanity check for the tests below)', () => {
    expect(SPOTS.length).toBe(35);
  });

  it('is non-empty and matches ^[a-z0-9_]+$ for every spot', () => {
    for (const spot of SPOTS) {
      const slug = spotSlug(spot);
      expect(slug.length).toBeGreaterThan(0);
      expect(slug).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('is unique across the whole 35-spot database', () => {
    const slugs = SPOTS.map(spotSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('derives the documented examples (Long Beach, Misty Cliffs, Vic Bay)', () => {
    expect(spotSlug(byId('kommetjie-long-beach'))).toBe('long_beach');
    expect(spotSlug(byId('scarborough'))).toBe('misty_cliffs'); // "Scarborough / Misty Cliffs" -> short "Misty Cliffs"
    expect(spotSlug(byId('victoria-bay'))).toBe('vic_bay');
  });

  it('collapses runs of non-alphanumeric characters to one underscore and trims the ends', () => {
    expect(spotSlug(byId('noordhoek'))).toBe('the_hoek'); // short "The Hoek"
    expect(spotSlug(byId('mossel-bay'))).toBe('ding_dangs'); // short "Ding Dangs"
  });
});

describe('matchSpot against the real 35-spot database', () => {
  it('matches an exact slug', () => {
    expect(matchSpot('long_beach', SPOTS)).toEqual({ kind: 'one', spot: byId('kommetjie-long-beach') });
  });

  it('matches an exact id-with-underscores when it differs from the slug', () => {
    // kommetjie-long-beach: slug is "long_beach" (from `short`), id-with-underscores is "kommetjie_long_beach".
    expect(matchSpot('kommetjie_long_beach', SPOTS)).toEqual({ kind: 'one', spot: byId('kommetjie-long-beach') });
  });

  it('is case-insensitive and normalises hyphens to underscores', () => {
    expect(matchSpot('Long-Beach', SPOTS)).toEqual({ kind: 'one', spot: byId('kommetjie-long-beach') });
  });

  it('"kom" is ambiguous — a prefix hit must not hide the three Kommetjie spots', () => {
    // kommetjie_long_beach commence par "kom" ; inner_kom et outer_kom le contiennent.
    // Tant que le niveau préfixe court-circuitait le niveau sous-chaîne, /kom renvoyait
    // Long Beach avec assurance, sans jamais nommer les deux autres.
    const m = matchSpot('kom', SPOTS);
    expect(m.kind).toBe('ambiguous');
    expect((m as { spots: { id: string }[] }).spots.map((s) => s.id).sort()).toEqual(['inner-kom', 'kommetjie-long-beach', 'outer-kom']);
  });
  it('"kommetjie" names the three Kommetjie spots rather than picking one', () => {
    const m = matchSpot('kommetjie', SPOTS);
    expect(m.kind).toBe('ambiguous');
    expect((m as { spots: { id: string }[] }).spots).toHaveLength(3);
  });
  it('an exact slug still wins over any fuzzy candidate', () => {
    expect(matchSpot('inner_kom', SPOTS)).toEqual({ kind: 'one', spot: byId('inner-kom') });
    expect(matchSpot('long_beach', SPOTS)).toEqual({ kind: 'one', spot: byId('kommetjie-long-beach') });
  });

  it('"jbay" is an ambiguous prefix (Jeffreys Bay has two spots)', () => {
    const m = matchSpot('jbay', SPOTS);
    expect(m.kind).toBe('ambiguous');
    if (m.kind === 'ambiguous') expect(m.spots.map((s) => s.id).sort()).toEqual(['jbay-point', 'jbay-supertubes']);
  });

  it('"reef" is an ambiguous substring (Kalk Bay Reef, Nahoon Reef) since neither has it as a prefix', () => {
    const m = matchSpot('reef', SPOTS);
    expect(m.kind).toBe('ambiguous');
    if (m.kind === 'ambiguous') expect(m.spots.map((s) => s.id).sort()).toEqual(['kalk-bay-reef', 'nahoon-reef']);
  });

  it('falls back to a substring of the lowercased name when neither slug nor id contains it', () => {
    // "Durban – New Pier / North Beach": "north" is in the name only, not in slug "new_pier" or id "durban_new_pier".
    expect(matchSpot('north', SPOTS)).toEqual({ kind: 'one', spot: byId('durban-new-pier') });
  });

  it('returns none for input matching nothing', () => {
    expect(matchSpot('zzznotaspot', SPOTS)).toEqual({ kind: 'none' });
  });

  it('returns none for empty input', () => {
    expect(matchSpot('', SPOTS)).toEqual({ kind: 'none' });
  });
});
