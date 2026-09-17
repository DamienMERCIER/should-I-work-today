import { describe, it, expect } from 'vitest';
import { SPOTS } from '../../src/data/index';
import { allWorldTuples, worldSpotId } from '../../src/data/world';
import type { SpotTuple } from '../../src/data/world';
import { matchSpot, spotSlug, totalSpotCount } from '../../src/bot/spotMatch';
import { fastestMs } from '../helpers/timing';

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

// The behaviour of the 35 curated spots alone: imported spots have their own tests further down, and the
// imported file grows with every resumed import.
const CURATED_ONLY: SpotTuple[] = [];

describe('matchSpot against the 35 curated spots alone', () => {
  it('matches an exact slug', () => {
    expect(matchSpot('long_beach', SPOTS, CURATED_ONLY)).toEqual({ kind: 'one', spot: byId('kommetjie-long-beach') });
  });

  it('matches an exact id-with-underscores when it differs from the slug', () => {
    // kommetjie-long-beach: slug is "long_beach" (from `short`), id-with-underscores is "kommetjie_long_beach".
    expect(matchSpot('kommetjie_long_beach', SPOTS, CURATED_ONLY)).toEqual({ kind: 'one', spot: byId('kommetjie-long-beach') });
  });

  it('is case-insensitive and normalises hyphens to underscores', () => {
    expect(matchSpot('Long-Beach', SPOTS, CURATED_ONLY)).toEqual({ kind: 'one', spot: byId('kommetjie-long-beach') });
  });

  it('"kom" is ambiguous — a prefix hit must not hide the three Kommetjie spots', () => {
    // kommetjie_long_beach starts with "kom"; inner_kom and outer_kom both contain it.
    // As long as the prefix tier short-circuited the substring tier, /kom used to confidently
    // return Long Beach, without ever naming the other two.
    const m = matchSpot('kom', SPOTS, CURATED_ONLY);
    expect(m.kind).toBe('ambiguous');
    expect((m as { spots: { id: string }[] }).spots.map((s) => s.id).sort()).toEqual(['inner-kom', 'kommetjie-long-beach', 'outer-kom']);
  });
  it('"kommetjie" names the three Kommetjie spots rather than picking one', () => {
    const m = matchSpot('kommetjie', SPOTS, CURATED_ONLY);
    expect(m.kind).toBe('ambiguous');
    expect((m as { spots: { id: string }[] }).spots).toHaveLength(3);
  });
  it('an exact slug still wins over any fuzzy candidate', () => {
    expect(matchSpot('inner_kom', SPOTS, CURATED_ONLY)).toEqual({ kind: 'one', spot: byId('inner-kom') });
    expect(matchSpot('long_beach', SPOTS, CURATED_ONLY)).toEqual({ kind: 'one', spot: byId('kommetjie-long-beach') });
  });

  it('"jbay" is an ambiguous prefix (Jeffreys Bay has two spots)', () => {
    const m = matchSpot('jbay', SPOTS, CURATED_ONLY);
    expect(m.kind).toBe('ambiguous');
    if (m.kind === 'ambiguous') expect(m.spots.map((s) => s.id).sort()).toEqual(['jbay-point', 'jbay-supertubes']);
  });

  it('"reef" is an ambiguous substring (Kalk Bay Reef, Nahoon Reef) since neither has it as a prefix', () => {
    const m = matchSpot('reef', SPOTS, CURATED_ONLY);
    expect(m.kind).toBe('ambiguous');
    if (m.kind === 'ambiguous') expect(m.spots.map((s) => s.id).sort()).toEqual(['kalk-bay-reef', 'nahoon-reef']);
  });

  it('falls back to a substring of the lowercased name when neither slug nor id contains it', () => {
    // "Durban – New Pier / North Beach": "north" is in the name only, not in slug "new_pier" or id "durban_new_pier".
    expect(matchSpot('north', SPOTS, CURATED_ONLY)).toEqual({ kind: 'one', spot: byId('durban-new-pier') });
  });

  it('returns none for input matching nothing', () => {
    expect(matchSpot('zzznotaspot', SPOTS, CURATED_ONLY)).toEqual({ kind: 'none' });
  });

  it('returns none for empty input', () => {
    expect(matchSpot('', SPOTS, CURATED_ONLY)).toEqual({ kind: 'none' });
  });
});

describe('matchSpot against a synthetic world set (§report "Resilience, wiring and dedupe")', () => {
  const WORLD: SpotTuple[] = [
    ['Praia do Guincho', 'Guincho', -38.7325, -9.4723, 280, 0],
    ['Kalk Bay Left', 'Kalk Left', -34.5, 18.6, 150, 1], // shares a "kalk_bay"-ish prefix with curated Kalk Bay
  ];

  it('matches an exact slug that only exists in the world set', () => {
    const m = matchSpot('guincho', SPOTS, WORLD);
    expect(m.kind).toBe('one');
    if (m.kind === 'one') expect(m.spot.name).toBe('Praia do Guincho');
  });

  it('matches an exact id-with-underscores that only exists in the world set — id and slug differ, so this isolates the id tier', () => {
    const [name, , lat, lon] = WORLD[0];
    const idQuery = worldSpotId(name, lat, lon).replace(/-/g, '_'); // e.g. "praia-do-guincho-s38...-w9..." -> underscored
    expect(idQuery).not.toBe('guincho'); // sanity: genuinely a different string from the slug tier
    const m = matchSpot(idQuery, SPOTS, WORLD);
    expect(m).toEqual({ kind: 'one', spot: expect.objectContaining({ name: 'Praia do Guincho' }) });
  });

  it('a substring match reaches the world set, not just curated', () => {
    const m = matchSpot('praia', SPOTS, WORLD);
    expect(m.kind).toBe('one');
    if (m.kind === 'one') expect(m.spot.name).toBe('Praia do Guincho');
  });

  it('a query matching one curated AND one world spot at the same tier is ambiguous — a real collision risk since world data is unverified', () => {
    // "reef" already matches two curated spots (kalk-bay-reef, nahoon-reef) as a substring (see above).
    // Add a world spot whose slug also contains "reef" and confirm the ambiguous set grows to include it.
    const worldReef: SpotTuple = ['World Reef Spot', 'World Reef', 10, 10, 0, 1];
    const m = matchSpot('reef', SPOTS, [worldReef]);
    expect(m.kind).toBe('ambiguous');
    if (m.kind === 'ambiguous') {
      expect(m.spots.map((s) => s.name).sort()).toEqual(['Kalk Bay Reef', 'Nahoon Reef (East London)', 'World Reef Spot'].sort());
    }
  });

  it('an exact slug in the world set still wins over a fuzzy curated candidate (tier ordering preserved)', () => {
    // "kalk_left" is an exact slug for the world spot and not a substring/prefix collision with curated
    // Kalk Bay's slug ("kalk_bay") — confirms the exact-tier check runs (and can resolve) before fuzzy.
    const m = matchSpot('kalk_left', SPOTS, WORLD);
    expect(m).toEqual({ kind: 'one', spot: expect.objectContaining({ name: 'Kalk Bay Left' }) });
  });

  it('with the real world import, every curated spot is still found by its own command — no imported spot shadows it', () => {
    expect(allWorldTuples().length).toBeGreaterThan(0);
    for (const spot of SPOTS) expect(matchSpot(spotSlug(spot), SPOTS), spotSlug(spot)).toEqual({ kind: 'one', spot });
  });
});

describe('matchSpot performance against an 8000-entry world set (§report "Resilience, wiring and dedupe")', () => {
  const longNames = ['Praia do Guincho – Norte', 'Île de Ré, Pointe du Grouin', 'São Conrado – Barra da Tijuca', 'Işıklar Plajı Sahili', 'Кабардинка – Центральный пляж'];
  const bigWorld: SpotTuple[] = Array.from({ length: 8000 }, (_, i) => {
    const name = `${longNames[i % longNames.length]} #${i}`;
    return [name, name.slice(0, 11), -80 + ((i * 37) % 160), -180 + ((i * 71) % 360), (i * 13) % 360, i % 4];
  });

  it('a query matching nothing (every tier scanned — the worst case) still resolves correctly against 8000 tuples', () => {
    expect(matchSpot('zzznotfound', SPOTS, bigWorld)).toEqual({ kind: 'none' });
  });

  it('steady state (the id-slug cache warm — the overwhelming majority of real calls on a long-lived Worker isolate, since the world tuple array never changes) stays well under the 10 ms budget even on the worst-case (no-match) query', () => {
    matchSpot('zzznotfound', SPOTS, bigWorld); // prime worldTupleIdSlug's per-tuple cache (§world.ts)
    expect(fastestMs(() => void matchSpot('zzznotfound', SPOTS, bigWorld), 11)).toBeLessThan(5);
  });
});

describe('totalSpotCount (/about, §report "Resilience, wiring and dedupe")', () => {
  it('adds the world tuple count to the curated spot count', () => {
    const world: SpotTuple[] = [
      ['A', 'A', 0, 0, 0, 0],
      ['B', 'B', 1, 1, 0, 0],
    ];
    expect(totalSpotCount(SPOTS, world)).toBe(SPOTS.length + 2);
  });

  it('with the real world import, /about counts the curated spots plus every imported one', () => {
    expect(totalSpotCount(SPOTS)).toBe(SPOTS.length + allWorldTuples().length);
  });
});
