import { describe, it, expect } from 'vitest';
import spotsJson from '../../src/data/spots.json';
import regionsJson from '../../src/data/regions.json';
import { validateRegions, validateSpots, loadSpots } from '../../src/data/schema';
import { SPOTS, REGIONS } from '../../src/data/index';
import { haversineKm } from '../../src/engine/geo';
import { DEFAULT_LOCATION, RADIUS_KM } from '../../src/config';

describe('bundled data', () => {
  it('validates without errors', () => {
    expect(validateRegions(regionsJson)).toEqual([]);
    const { regions } = loadSpots(spotsJson, regionsJson);
    expect(validateSpots(spotsJson, regions)).toEqual([]);
  });
  it('exposes 35 spots and 7 regions with unique ids', () => {
    expect(SPOTS).toHaveLength(35);
    expect(REGIONS).toHaveLength(7);
    expect(new Set(SPOTS.map((s) => s.id)).size).toBe(35);
  });
  it('has exactly 15 spots within 20 km of Muizenberg (glen-beach\'s corrected coordinate, plus fish-hoek, glencairn and witsands, now qualify), Dungeons excluded', () => {
    const near = SPOTS.filter((s) => haversineKm(DEFAULT_LOCATION, s) <= RADIUS_KM).map((s) => s.id).sort();
    expect(near).toEqual([
      'clovelly', 'crayfish-factory', 'fish-hoek', 'glen-beach', 'glencairn', 'inner-kom', 'kalk-bay-reef',
      'kommetjie-long-beach', 'llandudno', 'muizenberg', 'noordhoek', 'outer-kom', 'scarborough', 'strandfontein', 'witsands',
    ].sort());
    expect(SPOTS.find((s) => s.id === 'dungeons')).toBeUndefined();
  });
  it('glen-beach\'s corrected coordinate sits inside the 20 km radius (regression pin: a 780 m coordinate error used to place it at 20.66 km, outside RADIUS_KM)', () => {
    const glenBeach = SPOTS.find((s) => s.id === 'glen-beach')!;
    expect(haversineKm(DEFAULT_LOCATION, glenBeach)).toBeLessThan(RADIUS_KM);
  });
});

describe('validateSpots', () => {
  const regions = loadSpots(spotsJson, regionsJson).regions;
  const good = (spotsJson as unknown[])[0] as Record<string, unknown>;
  const bad = (patch: Record<string, unknown>) => validateSpots([{ ...good, ...patch }], regions);

  it('rejects a bad id, an unknown region, out-of-range numbers', () => {
    expect(bad({ id: 'Muizenberg Corner' })).toEqual(['spots[0].id: must be kebab-case']);
    expect(bad({ region: 'mars' })).toEqual(['spots[0].region: unknown region "mars"']);
    expect(bad({ facing: 360 })).toEqual(['spots[0].facing: expected number in [0, 360)']);
    expect(bad({ exposure: 0 })).toEqual(['spots[0].exposure: expected number in (0, 1.5]']);
    expect(bad({ lat: -95 })).toEqual(['spots[0].lat: expected number in [-90, 90]']);
  });
  it('rejects a bad short label', () => {
    expect(bad({ short: '' })).toEqual(['spots[0].short: expected non-empty string']);
    expect(bad({ short: 'Way Too Long Label' })).toEqual(['spots[0].short: expected ≤ 13 characters']);
  });
  it('rejects a short label duplicated within the same region', () => {
    const a = { ...good, id: 'spot-a', short: 'Dup' };
    const b = { ...good, id: 'spot-b', short: 'Dup' };
    expect(validateSpots([a, b], regions)).toEqual(['spots[1].short: duplicate "Dup" in region "cape-peninsula"']);
  });
  it('allows the same short label reused in a different region', () => {
    const a = { ...good, id: 'spot-a', short: 'Dup' };
    const b = { ...good, id: 'spot-b', region: 'west-coast', short: 'Dup' };
    expect(validateSpots([a, b], regions)).toEqual([]);
  });
  it('rejects malformed windows, tides and levels', () => {
    expect(bad({ swellWindow: [200] })).toEqual(['spots[0].swellWindow: expected [from, to] in [0, 360]']);
    expect(bad({ tide: { best: ['mid'], forbidden: ['mid'] } })).toEqual(['spots[0].tide: best and forbidden overlap']);
    expect(bad({ tide: { best: ['dry'], forbidden: [] } })).toEqual(['spots[0].tide.best: unknown tide state "dry"']);
    expect(bad({ levels: {} })).toEqual(['spots[0].levels: at least one level required']);
    expect(bad({ levels: { intermediate: [5, 2] } })).toEqual(['spots[0].levels.intermediate: expected [min, max] with 0 < min < max']);
    expect(bad({ levels: { pro: [2, 5] } })).toEqual(['spots[0].levels: unknown level "pro"']);
    expect(bad({ character: 'gnarly' })).toEqual(['spots[0].character: expected mellow | punchy | heavy']);
    expect(bad({ verified: 'yes' })).toEqual(['spots[0].verified: expected boolean']);
  });
  it('rejects a short label too long for an unverified spot (the ≈ prefix costs 2 columns)', () => {
    expect(bad({ short: 'Twelve chars', verified: false })).toEqual(['spots[0].short: expected ≤ 11 characters for an unverified spot (the ≈ prefix costs 2)']);
    expect(bad({ short: 'Twelve chars', verified: true })).toEqual([]);
  });

  it('rejects duplicate ids and non-array input', () => {
    // short differs on the second copy so this isolates id-duplicate detection from short-duplicate
    // detection (covered on its own above).
    expect(validateSpots([good, { ...good, short: 'Other' }], regions)).toEqual(['spots[1].id: duplicate "muizenberg"']);
    expect(validateSpots({}, regions)).toEqual(['spots: expected an array']);
  });
  it('loadSpots throws with all errors joined', () => {
    expect(() => loadSpots([{ ...good, facing: 400, verified: 1 }], regionsJson)).toThrow(/facing.*\n.*verified/s);
  });
});
