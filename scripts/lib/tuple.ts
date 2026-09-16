import { typeCodeFor, type SpotTuple } from '../../src/data/world';

export interface WorkingSpot {
  name: string;
  short: string;
  lat: number;
  lon: number;
  facing: number;
  type: string;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Encode side of `src/data/world.ts`'s `expandTuple` — builds the compact `[name, short, lat, lon,
 * facing, typeCode]` written to `spots-world.json` (§output format, CPU budget). Numbers rounded to
 * 4 decimals (~11 m), matching the precision already used for curated spots in `spots.json`.
 */
export function toTuple(spot: WorkingSpot): SpotTuple {
  return [spot.name, spot.short, round4(spot.lat), round4(spot.lon), round4(spot.facing), typeCodeFor(spot.type)];
}
