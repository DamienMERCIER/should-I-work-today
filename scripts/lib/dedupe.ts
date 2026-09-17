import { haversineKm } from '../../src/engine/geo';
import type { LatLon } from '../../src/types';

const DEFAULT_THRESHOLD_M = 500;
const DEFAULT_WORLD_THRESHOLD_M = 200;

export interface DedupeResult<T> {
  kept: T[];
  droppedCount: number;
}

/**
 * Curated spots win: a world spot within `thresholdM` (default 500 m) of ANY curated spot is
 * dropped, so e.g. surf-forecast's own "Muizenberg" (a ~685 m-away, independently-sourced coordinate
 * for the same real-world break, per the saved fixture) doesn't show up twice next to the hand-tuned
 * curated one. Distance to the *nearest* curated spot decides it — a world spot only needs to clear
 * every curated spot to survive. The real import passes the bot's own radius instead (20 km,
 * `CURATED_COVERAGE_M` in scripts/import-spots.ts): where hand-picked spots exist, they alone are shown.
 */
export function dedupeAgainstCurated<T extends LatLon>(worldSpots: T[], curated: LatLon[], thresholdM = DEFAULT_THRESHOLD_M): DedupeResult<T> {
  const thresholdKm = thresholdM / 1000;
  const kept: T[] = [];
  let droppedCount = 0;
  for (const spot of worldSpots) {
    const tooClose = curated.some((c) => haversineKm(spot, c) <= thresholdKm);
    if (tooClose) droppedCount++;
    else kept.push(spot);
  }
  return { kept, droppedCount };
}

/**
 * A second pass, world spots against *each other* — `dedupeAgainstCurated` only ever compares a world
 * spot to the curated set, so two world spots that are both far from every curated spot but close to
 * each other both survive it untouched. surf-forecast lists many adjacent peaks along the same stretch
 * of coast as separate breaks (§report "Resilience, wiring and dedupe"): left unchecked, two of those
 * ~100 m apart would both show up in every radius query near that cluster.
 *
 * 200 m (tighter than the 500 m curated threshold, deliberately) is chosen against a real, verified
 * gap: the curated Inner Kom and Outer Kom are ~298 m apart (`src/data/spots.json`, cross-checked by
 * `test/scripts/dedupe.test.ts` against `haversineKm`) — two genuinely distinct breaks that must both
 * survive. 200 m sits safely under that gap while still catching same-peak duplicates closer together.
 *
 * Deterministic and order-sensitive by design: `worldSpots` must already be in the caller's stable
 * order (§writeOutput — sorted by slug, the same order that fixes `short` suffix assignment). A spot
 * is dropped only when it is within `thresholdM` of a spot *earlier in that order that has already
 * survived* — so which spot "wins" a cluster is simply "comes first in the input", never iteration-
 * order nondeterminism, and a later spot never retroactively drops an earlier, already-kept one (no
 * chain-collapse across a whole coastline of closely-spaced points — see the "chain" test).
 */
export function dedupeAdjacentWorld<T extends LatLon>(worldSpots: T[], thresholdM = DEFAULT_WORLD_THRESHOLD_M): DedupeResult<T> {
  const thresholdKm = thresholdM / 1000;
  const kept: T[] = [];
  let droppedCount = 0;
  for (const spot of worldSpots) {
    const tooClose = kept.some((k) => haversineKm(spot, k) <= thresholdKm);
    if (tooClose) droppedCount++;
    else kept.push(spot);
  }
  return { kept, droppedCount };
}
