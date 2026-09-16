import type { FetchLike } from '../../src/adapters/http';
import type { LatLon } from '../../src/types';
import { computeFacing, ringPoints } from './facing';
import { fetchElevations, type FetchElevationsOptions } from './elevation';

/** One spot's outcome: a real facing, or a skip with a reason — mirrors `fetchBreaks.ts`'s `Outcome`
 * shape so callers handle both stages the same way. */
export type FacingOutcome = { facing: number } | { skipped: { reason: string } };

/**
 * Computes facing for every spot in one pass: flattens all their 2 km/24-point rings into a single
 * point list, fetches elevations for the whole list through `fetchElevations` (which packs them into
 * shared ≤100-point Open-Meteo requests — a spot's own ring can and does straddle two different
 * requests once spots are packed tightly), then slices the results back per spot to run
 * `computeFacing`.
 *
 * Two distinct skip reasons, never conflated (§report "Resilience, wiring and dedupe"): `no-sea-point`
 * — every ring point resolved to a real elevation, but none was ≤ 0 m (a genuine geographic fact,
 * e.g. a bad coordinate or a lake) — vs. `elevation-error` — at least one ring point's batch never
 * came back at all (`fetchElevations` returns `null` for those, never thrown). A `null` must never be
 * read as "sea level" (`null <= 0` is true in JS!), so a ring touching even one failed batch is
 * skipped outright rather than averaging over whatever real elevations it does have.
 */
export async function computeFacingsForSpots(spots: LatLon[], fetchFn: FetchLike, opts: FetchElevationsOptions = {}): Promise<FacingOutcome[]> {
  const rings = spots.map((spot) => ringPoints(spot.lat, spot.lon));
  const flatPoints = rings.flat();
  const elevations = await fetchElevations(flatPoints, fetchFn, opts);

  const outcomes: FacingOutcome[] = [];
  let offset = 0;
  for (const ring of rings) {
    const ringElevations = ring.map((_, i) => elevations[offset + i]);
    offset += ring.length;
    if (ringElevations.some((e) => e === null)) {
      outcomes.push({ skipped: { reason: 'elevation-error' } });
      continue;
    }
    const sample = ring.map((p, i) => ({ bearing: p.bearing, elevation: ringElevations[i] as number }));
    const facing = computeFacing(sample);
    outcomes.push(facing === null ? { skipped: { reason: 'no-sea-point' } } : { facing });
  }
  return outcomes;
}
