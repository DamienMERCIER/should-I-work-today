import { describe, it, expect } from 'vitest';
import { toTuple } from '../../scripts/lib/tuple';
import { expandTuple } from '../../src/data/world';

describe('toTuple', () => {
  it('builds the [name, short, lat, lon, facing, typeCode] tuple', () => {
    const t = toTuple({ name: 'Muizenberg', short: 'Muizenberg', lat: -34.1026, lon: 18.4737, facing: 142.3167, type: 'Beach' });
    expect(t).toEqual(['Muizenberg', 'Muizenberg', -34.1026, 18.4737, 142.3167, 0]);
  });

  it('rounds lat/lon/facing to 4 decimals', () => {
    const t = toTuple({ name: 'X', short: 'X', lat: -34.102649, lon: 18.473721, facing: 142.31666, type: 'Reef' });
    expect(t).toEqual(['X', 'X', -34.1026, 18.4737, 142.3167, 1]);
  });

  it('maps type to the same typeCode expandTuple decodes back', () => {
    for (const type of ['Beach', 'Reef', 'Point', 'River Mouth']) {
      const t = toTuple({ name: 'X', short: 'X', lat: 0, lon: 0, facing: 0, type });
      const spot = expandTuple(t);
      const expected = type === 'Reef' ? 0.9 : type === 'Point' ? 0.8 : 0.7;
      expect(spot.exposure).toBe(expected);
    }
  });
});
