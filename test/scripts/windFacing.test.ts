import { describe, it, expect } from 'vitest';
import { facingFromWind, type WindSlot } from '../../scripts/lib/windFacing';
import { windState } from '../../src/engine/rating';
import { MUIZENBERG_WINDS } from '../helpers/forecastPage';

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const gap = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);
const times = (n: number, slot: WindSlot): WindSlot[] => Array.from({ length: n }, () => slot);

describe('facingFromWind', () => {
  it("recovers a spot's orientation, to the compass' resolution, from the states our own sectors give for the 16 wind directions — through north too", () => {
    for (const truth of [0, 37, 95, 180, 222, 290, 359]) {
      const slots = COMPASS.map((windDir, i) => ({ windDir, state: windState(i * 22.5, truth, 20) }));
      const found = facingFromWind(slots);
      expect(found, `facing ${truth}°`).not.toBeNull();
      expect(gap(found!.facing, truth), `facing ${truth}° → ${found!.facing}°`).toBeLessThanOrEqual(11.25);
      expect(found!.explained).toBe(16);
    }
  });

  it('a week of south-easterlies blowing onshore at Muizenberg: 113°–134°, centred on 124°', () => {
    expect(facingFromWind(MUIZENBERG_WINDS)).toEqual({ facing: 124, widthDeg: 21, explained: 18, usable: 19 });
  });

  it('one wind direction blowing cross-shore cannot tell which side the sea is on: no orientation', () => {
    expect(facingFromWind(times(10, { windDir: 'SE', state: 'cross' }))).toBeNull();
  });

  it('best orientations tied in separate places (here 315° and 0°) give no orientation — their midpoint would explain fewer slots', () => {
    const slots = [
      { windDir: 'E', state: 'cross' },
      { windDir: 'NNW', state: 'cross-on' },
      { windDir: 'ENE', state: 'cross-off' },
      { windDir: 'SSE', state: 'off' },
    ] satisfies WindSlot[];
    expect(facingFromWind(slots)).toBeNull();
  });

  it('glassy says nothing about the direction: it counts neither for nor against an orientation', () => {
    const glassy = times(20, { windDir: 'SE', state: 'glassy' } satisfies WindSlot);
    expect(facingFromWind(glassy)).toBeNull();
    expect(facingFromWind([...MUIZENBERG_WINDS, ...glassy])).toEqual({ facing: 124, widthDeg: 21, explained: 18, usable: 19 });
  });

  it('needs at least 4 usable slots — a direction the compass does not know is not usable', () => {
    const three = [{ windDir: 'N', state: 'off' }, { windDir: 'E', state: 'cross' }, { windDir: 'S', state: 'on' }] satisfies WindSlot[];
    expect(facingFromWind([...three, ...times(5, { windDir: 'VAR', state: 'on' })])).toBeNull();
    expect(facingFromWind([...three, { windDir: 'W', state: 'cross' }])).not.toBeNull();
  });

  it('gives no orientation when the best one explains fewer than 3 slots out of 4', () => {
    const on = { windDir: 'SE', state: 'on' } satisfies WindSlot;
    const off = { windDir: 'SE', state: 'off' } satisfies WindSlot;
    expect(facingFromWind([...times(6, on), ...times(4, off)])).toBeNull();
    expect(facingFromWind([...times(9, on), ...times(3, off)])).toMatchObject({ explained: 9, usable: 12 });
  });
});
