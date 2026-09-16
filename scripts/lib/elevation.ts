import type { FetchLike } from '../../src/adapters/http';
import type { LatLon } from '../../src/types';
import { mapWithConcurrency } from './concurrency';
import { fetchWithRetry, type RetryOptions } from './httpRetry';

const ELEVATION_BASE = 'https://api.open-meteo.com/v1/elevation';
const MAX_POINTS_PER_REQUEST = 100;
const DEFAULT_CONCURRENCY = 4;

const coords = (points: LatLon[], key: keyof LatLon): string => points.map((p) => p[key].toFixed(4)).join(',');

/** Open-Meteo's elevation endpoint, no key required — up to 100 points per request (established fact). */
export function elevationUrl(points: LatLon[]): string {
  const q = new URLSearchParams({ latitude: coords(points, 'lat'), longitude: coords(points, 'lon') });
  return `${ELEVATION_BASE}?${q.toString()}`;
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

interface ElevationResponse {
  elevation?: number[];
}

export interface FetchElevationsOptions extends RetryOptions {
  concurrency?: number;
}

/**
 * Elevations for `points`, in the same order, packing up to 100 coordinates per request (stage 3 of
 * the importer batches many spots' rings together into these chunks — see `computeFacingsForSpots`)
 * and running at most `concurrency` requests at once (default 4, matching stage 2's politeness rule —
 * this is a free, no-key API, but there is no reason to hammer it either).
 *
 * A batch that never comes back cleanly — a persistent non-2xx status, the fetch itself rejecting
 * (network failure surviving the retry), or a malformed/short body — yields `null` for every point in
 * *that* batch rather than throwing (§report "Resilience, wiring and dedupe"): one bad batch out of
 * ~1928 for a full run must not discard every other spot's elevation. `computeFacingsForSpots` turns a
 * `null` into a distinct `elevation-error` skip, never silently treating it as sea level.
 */
export async function fetchElevations(points: LatLon[], fetchFn: FetchLike, opts: FetchElevationsOptions = {}): Promise<(number | null)[]> {
  const chunks = chunk(points, MAX_POINTS_PER_REQUEST);
  const perChunk = await mapWithConcurrency(chunks, opts.concurrency ?? DEFAULT_CONCURRENCY, async (batch): Promise<(number | null)[]> => {
    try {
      const res = await fetchWithRetry(elevationUrl(batch), fetchFn, opts);
      if (!res.ok) return batch.map(() => null);
      const json = (await res.json()) as ElevationResponse;
      if (!Array.isArray(json.elevation) || json.elevation.length !== batch.length) return batch.map(() => null);
      return json.elevation;
    } catch {
      return batch.map(() => null);
    }
  });
  return perChunk.flat();
}
