import { describe, it, expect } from 'vitest';
import { RADIUS_KM } from '../../src/config';
import { REGIONS, SPOTS } from '../../src/data/index';
import { validateRegions, validateSpots } from '../../src/data/schema';
import { haversineKm, destinationPoint } from '../../src/engine/geo';
import { spotSlug } from '../../src/bot/spotMatch';
import type { Spot } from '../../src/types';
import { fastestMs } from '../helpers/timing';
import {
  allWorldTuples,
  assignRegion,
  expandTuple,
  nearestWorldSpots,
  typeCodeFor,
  worldSpotId,
  worldSpotById,
  worldSpots,
  worldTupleIdSlug,
  worldTupleSlug,
  type SpotTuple,
} from '../../src/data/world';

describe('typeCodeFor', () => {
  it('maps the three known surf-forecast types and buckets everything else as "Other"', () => {
    expect(typeCodeFor('Beach')).toBe(0);
    expect(typeCodeFor('Reef')).toBe(1);
    expect(typeCodeFor('Point')).toBe(2);
    expect(typeCodeFor('River Mouth')).toBe(3);
    expect(typeCodeFor('')).toBe(3);
  });
});

describe('worldSpotId', () => {
  it('produces a kebab-case id (schema ID_RE-compatible)', () => {
    expect(worldSpotId('Praia do Guincho', -38.7325, -9.4723)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
  it('is deterministic for the same inputs', () => {
    expect(worldSpotId('Muizenberg', -34.1026, 18.4737)).toBe(worldSpotId('Muizenberg', -34.1026, 18.4737));
  });
  it('disambiguates same-named breaks at different coordinates (id alone carries no region info)', () => {
    const a = worldSpotId('Muizenberg', -34.1026, 18.4737); // surf-forecast's own coordinate
    const b = worldSpotId('Muizenberg', -34.1085, 18.4715); // curated's coordinate
    expect(a).not.toBe(b);
  });
});

describe('assignRegion', () => {
  const spot = { lat: -34.3, lon: 18.6, facing: 150, id: 'near-cape-peninsula' };

  it('reuses the nearest existing region when within 500 km', () => {
    const region = assignRegion(spot, REGIONS);
    expect(region.id).toBe('cape-peninsula');
    expect(haversineKm(spot, region.swellRef)).toBeLessThanOrEqual(500);
  });

  it('creates a region on the fly, offshore in the facing direction, when nothing is within 500 km', () => {
    // Praia do Guincho, Portugal — thousands of km from every curated (South African) region.
    const farSpot = { lat: -38.7325, lon: -9.4723, facing: 280, id: 'guincho' };
    const region = assignRegion(farSpot, REGIONS);
    expect(region.id).toBe('guincho-region');
    expect(region.tz).toBe('Africa/Johannesburg');
    const expectedOffshore = destinationPoint(farSpot.lat, farSpot.lon, farSpot.facing, 30);
    expect(region.swellRef.lat).toBeCloseTo(expectedOffshore.lat, 6);
    expect(region.swellRef.lon).toBeCloseTo(expectedOffshore.lon, 6);
    // the swell reference must be read offshore, never at the beach itself
    expect(haversineKm(farSpot, region.swellRef)).toBeCloseTo(30, 1);
    expect(validateRegions([region])).toEqual([]);
  });

  it('falls back to synthesising when given no curated regions at all', () => {
    const region = assignRegion(spot, []);
    expect(region.id).toBe('near-cape-peninsula-region');
  });
});

describe('expandTuple', () => {
  it('round-trips a tuple into a Spot that passes validateSpots, reusing an existing nearby region', () => {
    // ~9 km from the curated cape-peninsula region's swellRef (-34.5, 18.2) and closer to it than to
    // any other curated region, so no synthetic region is needed and validating against REGIONS alone
    // is enough.
    const tuple: SpotTuple = ['Test Reef Spot', 'Test Reef', -34.5, 18.3, 142.3167, 1];
    const spot = expandTuple(tuple);
    expect(validateSpots([spot], REGIONS)).toEqual([]);
    expect(spot.region).toBe('cape-peninsula');
    expect(spot.exposure).toBe(0.9); // Reef
    expect(spot.character).toBe('heavy'); // Reef
    expect(spot.verified).toBe(false);
  });

  it('round-trips a tuple far from every curated region into a Spot that passes validateSpots against its own synthetic region', () => {
    const tuple: SpotTuple = ['Praia do Guincho', 'Guincho', -38.7325, -9.4723, 280, 0];
    const spot = expandTuple(tuple);
    const region = assignRegion({ lat: tuple[2], lon: tuple[3], facing: tuple[4], id: spot.id }, REGIONS);
    expect(validateRegions([region])).toEqual([]);
    expect(validateSpots([spot], [region])).toEqual([]);
    expect(spot.region).toBe(region.id);
    expect(spot.exposure).toBe(0.7); // Beach
    expect(spot.character).toBe('punchy');
  });

  it('derives swellWindow as facing ± 90°, wrapping through 0/360', () => {
    const tuple: SpotTuple = ['Wrap Spot', 'Wrap', -34.5, 18.9, 10, 2];
    const spot = expandTuple(tuple);
    expect(spot.swellWindow).toEqual([280, 100]);
  });

  it('always sets the permissive default levels and empty tide preference', () => {
    const tuple: SpotTuple = ['Levels Spot', 'Levels', -34.5, 18.9, 90, 0];
    const spot = expandTuple(tuple);
    expect(spot.levels).toEqual({ beginner: [1, 3], intermediate: [2, 6], advanced: [3, 12] });
    expect(spot.tide).toEqual({ best: [], forbidden: [] });
  });

  it('maps type code 2 (Point) to exposure 0.8 / character punchy', () => {
    const tuple: SpotTuple = ['Point Spot', 'Point', -34.5, 18.9, 200, 2];
    const spot = expandTuple(tuple);
    expect(spot.exposure).toBe(0.8);
    expect(spot.character).toBe('punchy');
  });
});

// Representative long, multi-byte UTF-8 names (accented Latin, Turkish, Cyrillic) — real surf-forecast
// data is not short ASCII (§report "the perf test... on short ASCII names"). `worldSpots`'s scan never
// reads these for a non-matching tuple (only `[lat, lon]` drive the haversine filter), so they exist
// here to make the *data* representative, not because they are expected to move the timing.
const LONG_UTF8_NAMES = [
  'Praia do Guincho – Norte',
  'Île de Ré, Pointe du Grouin',
  'São Conrado – Barra da Tijuca',
  'Işıklar Plajı Sahili',
  'Playa de Ñuñez del Prado',
  'Кабардинка – Центральный пляж',
  'Kommetjie – Baía do Fundo Comprida',
];
const longUtf8Name = (i: number): string => `${LONG_UTF8_NAMES[i % LONG_UTF8_NAMES.length]} #${i}`;

describe('worldSpots (radius query)', () => {
  const center = { lat: 10.1234, lon: 20.5678 };
  const near = (bearing: number, km: number, label: string): SpotTuple => {
    const p = destinationPoint(center.lat, center.lon, bearing, km);
    return [label, label.slice(0, 13), p.lat, p.lon, bearing, 0];
  };
  const noise = (i: number): SpotTuple => {
    const name = longUtf8Name(i);
    return [name, name.slice(0, 13), -80 + ((i * 37) % 160), -180 + ((i * 71) % 360), (i * 13) % 360, i % 4];
  };

  const knownNear = [near(10, 1, 'Near1'), near(90, 10, 'Near10'), near(200, 19.9, 'Near19_9')];
  const knownFar = [near(45, 20.1, 'Far20_1'), near(300, 50, 'Far50')];
  const tuples: SpotTuple[] = [...knownNear, ...knownFar, ...Array.from({ length: 7995 }, (_, i) => noise(i))];

  it('still finds a spot due north or due south right at the edge of the radius — skipping by latitude never drops one inside', () => {
    const north = destinationPoint(center.lat, center.lon, 0, 19.999);
    const south = destinationPoint(center.lat, center.lon, 180, 19.999);
    const justOut = destinationPoint(center.lat, center.lon, 0, 20.001);
    const edge: SpotTuple[] = [['North', 'North', north.lat, north.lon, 0, 0], ['South', 'South', south.lat, south.lon, 0, 0], ['Out', 'Out', justOut.lat, justOut.lon, 0, 0]];
    expect(worldSpots(center, 20, edge).map((s) => s.name)).toEqual(['North', 'South']);
  });

  it('returns exactly the spots within the radius, expanded to full Spot records', () => {
    const result = worldSpots(center, 20, tuples);
    const names = result.map((s) => s.name);
    for (const t of knownNear) expect(names).toContain(t[0]);
    for (const t of knownFar) expect(names).not.toContain(t[0]);
    // sanity: every returned spot really is within the radius, and is a fully expanded Spot
    for (const s of result) {
      expect(haversineKm(center, s)).toBeLessThanOrEqual(20);
      expect(typeof s.id).toBe('string');
      expect(s.verified).toBe(false);
    }
  });

  it('scans an 8000-entry tuple array of representative long UTF-8 names in well under the 10 ms Worker CPU budget (linear scan, no eager expansion)', () => {
    expect(tuples.length).toBeGreaterThanOrEqual(8000);
    // Tightened from the original 50 ms (5× the actual 10 ms budget) now that the data is realistic —
    // see the report for the measured figure on this machine.
    expect(fastestMs(() => void worldSpots(center, 20, tuples))).toBeLessThan(5);
  });

  it('returns an empty array when nothing is in range', () => {
    expect(worldSpots({ lat: 0, lon: 0 }, 1, knownFar)).toEqual([]);
  });
});

describe('worldSpotById', () => {
  const tuples: SpotTuple[] = [
    ['Tofo', 'Tofo', -23.8522, 35.5478, 90, 0],
    ['Praia do Guincho', 'Guincho', 38.7325, -9.4723, 280, 0],
  ];

  it('finds the imported spot behind an id — the id carries its coordinates — expanded like any world spot', () => {
    for (const t of tuples) {
      const spot = worldSpotById(worldSpotId(t[0], t[2], t[3]), tuples);
      expect(spot).toEqual(expandTuple(t));
    }
  });

  it('finds nothing for a curated id, an unknown place, or a different name at the same coordinates', () => {
    expect(worldSpotById('kommetjie-long-beach', tuples)).toBeUndefined();
    expect(worldSpotById(worldSpotId('Tofo', -23.8523, 35.5478), tuples)).toBeUndefined();
    expect(worldSpotById(worldSpotId('Tofinho', -23.8522, 35.5478), tuples)).toBeUndefined();
  });
});

describe('nearestWorldSpots', () => {
  const center = { lat: 10.1234, lon: 20.5678 };
  const at = (bearing: number, km: number, label: string): SpotTuple => {
    const p = destinationPoint(center.lat, center.lon, bearing, km);
    return [label, label.slice(0, 13), p.lat, p.lon, bearing, 0];
  };

  it('returns the n closest tuples, expanded, nearest first', () => {
    const tuples = [at(10, 50, 'Far'), at(90, 5, 'Near'), at(200, 20, 'Mid')];
    const result = nearestWorldSpots(center, 2, tuples);
    expect(result.map((s) => s.name)).toEqual(['Near', 'Mid']);
  });

  it('a closer spot straight north still replaces the current candidate — skipping by latitude only drops spots that cannot be closer', () => {
    const tuples = [at(90, 100, 'East100'), at(0, 90, 'North90'), at(0, 150, 'North150')];
    expect(nearestWorldSpots(center, 1, tuples).map((s) => s.name)).toEqual(['North90']);
    expect(nearestWorldSpots(center, 2, tuples).map((s) => s.name)).toEqual(['North90', 'East100']);
  });

  it('returns every tuple, sorted, when n exceeds the tuple count', () => {
    const tuples = [at(10, 50, 'Far'), at(90, 5, 'Near')];
    const result = nearestWorldSpots(center, 10, tuples);
    expect(result.map((s) => s.name)).toEqual(['Near', 'Far']);
  });

  it('returns an empty array for n <= 0 or an empty tuple list', () => {
    expect(nearestWorldSpots(center, 0, [at(10, 1, 'X')])).toEqual([]);
    expect(nearestWorldSpots(center, 3, [])).toEqual([]);
  });

  it('scans an 8000-entry array for the nearest 3 in well under the 10 ms Worker CPU budget', () => {
    const tuples = [at(10, 1, 'Near1'), ...Array.from({ length: 7999 }, (_, i) => {
      const name = longUtf8Name(i);
      return [name, name.slice(0, 13), -80 + ((i * 37) % 160), -180 + ((i * 71) % 360), (i * 13) % 360, i % 4] as SpotTuple;
    })];
    expect(fastestMs(() => void nearestWorldSpots(center, 3, tuples))).toBeLessThan(5);
    expect(nearestWorldSpots(center, 3, tuples)[0].name).toBe('Near1');
  });
});

describe('worldTupleSlug / worldTupleIdSlug', () => {
  it('worldTupleSlug matches src/bot/spotMatch.ts\'s spotSlug for the same `short` (no drift between the two)', () => {
    for (const short of ['Long Beach', 'Misty Cliffs', 'Vic Bay', 'The Hoek', 'Ding Dangs']) {
      const tuple: SpotTuple = ['irrelevant', short, 0, 0, 0, 0];
      expect(worldTupleSlug(tuple)).toBe(spotSlug({ short } as Spot));
    }
  });

  it('worldTupleIdSlug matches worldSpotId(...).replace(/-/g, "_") for the same name/coordinates', () => {
    const tuple: SpotTuple = ['Praia do Guincho', 'Guincho', -38.7325, -9.4723, 280, 0];
    expect(worldTupleIdSlug(tuple)).toBe(worldSpotId(tuple[0], tuple[2], tuple[3]).replace(/-/g, '_'));
  });
});

describe('the real world import (src/data/spots-world.json)', () => {
  it("leaves the hand-picked coverage alone: no imported spot within the bot's radius of a curated spot", () => {
    // Around Cape Town, surf-forecast's own Muizenberg, Clovelly or Witsands sat 500 m–1.9 km from ours with
    // another facing: they showed up twice, and 35 spots instead of 15 pushed /week past its 10 ms of CPU.
    expect(allWorldTuples().length).toBeGreaterThan(0);
    for (const spot of SPOTS) expect(worldSpots(spot, RADIUS_KM).map((s) => s.name), spot.name).toEqual([]);
  });

  it('names no imported spot with control or bidi-override characters — scraped names reach Telegram messages, where those would reorder text or fake a line', () => {
    const invisible = (code: number): boolean =>
      code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x61c || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
    const offenders = allWorldTuples().filter(([name, short]) => [...name, ...short].some((ch) => invisible(ch.codePointAt(0) ?? 0)));
    expect(offenders.map((t) => t[0])).toEqual([]);
  });
});
