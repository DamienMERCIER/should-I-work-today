import { destinationPoint, haversineKm, norm360 } from '../engine/geo';
import type { LatLon, Region, Spot } from '../types';
import { REGIONS } from './index';
import spotsWorldJson from './spots-world.json';

/**
 * The world-import output (`scripts/import-spots.ts`) is a compact tuple, not an object, so that
 * loading 8000 of them at Worker cold start is cheap: `[name, short, lat, lon, facing, typeCode]`,
 * numbers rounded to 4 decimals. Everything else a `Spot` needs (`id`, `region`, `swellWindow`,
 * `exposure`, `tide`, `levels`, `character`, `verified`, `notes`) is *derived* from these six fields
 * at expand time (§`expandTuple`) rather than stored, which is what keeps the tuple this small.
 */
export type SpotTuple = [name: string, short: string, lat: number, lon: number, facing: number, typeCode: number];

/**
 * surf-forecast publishes finer-grained types ("River Mouth", "Beach and Reef", ...) than the
 * importer's defaults distinguish (§report: Defaults). Only the three the task specifies get their
 * own code; everything else buckets into "Other", which happens to share Beach's numbers.
 * 0 Beach, 1 Reef, 2 Point, 3 Other.
 */
const TYPE_NAME_TO_CODE: Record<string, number> = { Beach: 0, Reef: 1, Point: 2 };
export const typeCodeFor = (type: string): number => TYPE_NAME_TO_CODE[type] ?? 3;

const TYPE_DEFAULTS: ReadonlyArray<{ exposure: number; character: Spot['character'] }> = [
  { exposure: 0.7, character: 'punchy' }, // 0 Beach
  { exposure: 0.9, character: 'heavy' }, // 1 Reef
  { exposure: 0.8, character: 'punchy' }, // 2 Point
  { exposure: 0.7, character: 'punchy' }, // 3 Other
];

const WORLD_REGION_MAX_KM = 500;
const WORLD_OFFSHORE_KM = 30;

const WORLD_NOTES =
  "World import: facing is read from surf-forecast's own wind-state table for the spot (elevation sampling around the spot only when the wind does not tell); exposure, tide, levels and region are coarse, undocumented defaults, not verified.";

const stripDiacritics = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** Signed 4-decimal-degree value → an `[ns]ddddddd`-shaped id segment, kebab-case-safe (no sign, no dot). */
const coordSegment = (value: number, positive: string, negative: string): string => {
  const sign = value < 0 ? negative : positive;
  const digits = Math.round(Math.abs(value) * 10000)
    .toString()
    .padStart(2, '0');
  return `${sign}${digits}`;
};

/**
 * The tuple carries no `id` (kebab-case, schema-unique) — it is derived from `name` + the exact
 * `(lat, lon)`, both already in the tuple, rather than tracked separately. A slugified name alone
 * would collide constantly at world scale (common break names like "Left Point" recur across
 * countries, and even the *same* named break can appear once in curated and once — at a different,
 * surf-forecast-sourced coordinate — in world data, see `worldSpotId` tests). Appending the
 * coordinate makes a collision require two different spots at the exact same name AND the same
 * 4-decimal-degree point (~11 m), which does not happen in practice.
 */
export function worldSpotId(name: string, lat: number, lon: number): string {
  const base =
    stripDiacritics(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'spot';
  return `${base}-${coordSegment(lat, 'n', 's')}-${coordSegment(lon, 'e', 'w')}`;
}

interface RegionAssignmentInput extends LatLon {
  facing: number;
  id: string;
}

/**
 * Reuses the nearest curated region's `swellRef` when it is within 500 km; otherwise synthesises one
 * on the fly, 30 km offshore of the spot in its facing direction (never at the beach — swell must be
 * read at an open-water point). "A new synthetic region per spot" would be wrong if it happened for
 * *every* spot (it would defeat sharing a region's swell fetch across nearby spots), but for a spot
 * that is genuinely isolated — nothing else within 500 km — a region of its own is the only option;
 * there is no clustering between two far-away world spots here (see the report for why).
 * Deterministic and stateless: callable identically at import time (to report how many regions were
 * created) and at expand time (§`expandTuple`) from the tuple's own fields alone.
 */
export function assignRegion(spot: RegionAssignmentInput, curated: readonly Region[]): Region {
  let nearest: Region | undefined;
  let nearestKm = Infinity;
  for (const region of curated) {
    const km = haversineKm(spot, region.swellRef);
    if (km < nearestKm) {
      nearestKm = km;
      nearest = region;
    }
  }
  if (nearest && nearestKm <= WORLD_REGION_MAX_KM) return nearest;

  const swellRef = destinationPoint(spot.lat, spot.lon, spot.facing, WORLD_OFFSHORE_KM);
  return { id: `${spot.id}-region`, name: 'Offshore (auto)', tz: 'Africa/Johannesburg', swellRef };
}

/**
 * Expands one tuple into a full `Spot`. Cheap (string ops + a handful of haversines against the
 * curated region list), which is what lets `worldSpots` call it only for the handful of tuples that
 * actually match a radius query instead of eagerly materialising all 8000 (§module doc).
 */
export function expandTuple(tuple: SpotTuple, curated: readonly Region[] = REGIONS): Spot {
  const [name, short, lat, lon, facing, typeCode] = tuple;
  const id = worldSpotId(name, lat, lon);
  const region = assignRegion({ lat, lon, facing, id }, curated);
  const { exposure, character } = TYPE_DEFAULTS[typeCode] ?? TYPE_DEFAULTS[3];

  return {
    id,
    name,
    short,
    region: region.id,
    lat,
    lon,
    facing,
    swellWindow: [norm360(facing - 90), norm360(facing + 90)],
    exposure,
    tide: { best: [], forbidden: [] },
    levels: { beginner: [1, 3], intermediate: [2, 6], advanced: [3, 12] },
    character,
    verified: false,
    notes: WORLD_NOTES,
  };
}

const ALL_WORLD_TUPLES = spotsWorldJson as SpotTuple[];

/** Every tuple in `src/data/spots-world.json`, unexpanded — for tooling (e.g. `check:spots`) that
 * needs to walk the whole set rather than query a radius. Never call this from request-handling code. */
export function allWorldTuples(): SpotTuple[] {
  return ALL_WORLD_TUPLES;
}

/**
 * The world-spot radius query: a linear scan of the (unexpanded) tuple array computing a haversine
 * per entry directly off its `[lat, lon]` fields, expanding to a full `Spot` only for the handful
 * that fall inside `radiusKm`. A few thousand cheap haversines comfortably fit the Worker's 10 ms
 * per-invocation CPU budget; materialising all 8000 `Spot` objects up front would not (§report).
 */
export function worldSpots(center: LatLon, radiusKm: number, tuples: SpotTuple[] = ALL_WORLD_TUPLES, curated: readonly Region[] = REGIONS): Spot[] {
  const out: Spot[] = [];
  for (const tuple of tuples) {
    if (haversineKm(center, { lat: tuple[2], lon: tuple[3] }) <= radiusKm) {
      out.push(expandTuple(tuple, curated));
    }
  }
  return out;
}

/**
 * "Nearest N, anywhere" — the world-set counterpart of `worldSpots`' radius query, for the out-of-
 * coverage path (`nearestSpots` in `src/jobs/collect.ts`), which needs the closest spots regardless of
 * distance rather than everything inside a radius. Still one O(tuples) linear scan of cheap haversines
 * off each tuple's own `[lat, lon]` — the same cost shape as `worldSpots` — bounded top-`n` selection
 * (`n` is always small, e.g. 3) keeps it from ever expanding more than `n` tuples to a full `Spot`.
 */
export function nearestWorldSpots(center: LatLon, n: number, tuples: SpotTuple[] = ALL_WORLD_TUPLES, curated: readonly Region[] = REGIONS): Spot[] {
  if (n <= 0) return [];
  const best: { tuple: SpotTuple; distanceKm: number }[] = [];
  for (const tuple of tuples) {
    const distanceKm = haversineKm(center, { lat: tuple[2], lon: tuple[3] });
    if (best.length < n) {
      best.push({ tuple, distanceKm });
      best.sort((a, b) => a.distanceKm - b.distanceKm);
    } else if (distanceKm < best[best.length - 1].distanceKm) {
      best[best.length - 1] = { tuple, distanceKm };
      best.sort((a, b) => a.distanceKm - b.distanceKm);
    }
  }
  return best.map(({ tuple }) => expandTuple(tuple, curated));
}

/** Mirrors `src/bot/spotMatch.ts`'s `spotSlug` transform, operating directly on a tuple's `short`
 * field instead of a full `Spot`. `matchSpot` needs to search the whole ~8000-tuple world set on
 * every unmatched `/command`, and expanding every tuple to a full `Spot` (region assignment included)
 * just to compute a slug would burn the Worker's 10 ms budget for no reason. Duplicated rather than
 * imported — the same trade `scripts/lib/shortName.ts`'s `shortSlug` already makes for the same
 * transform — to avoid a `world.ts` ⇄ `spotMatch.ts` import cycle (`spotMatch.ts` imports *this*
 * module to search the world set); cross-checked against the real `spotSlug` by
 * `test/data/world.test.ts` so the two copies cannot silently drift apart. Cheap enough (~0.9 ms for
 * 8000 tuples, measured) that it needs no caching of its own — `matchSpot` computes it at most once
 * per tuple per call (§ single-pass matching). */
export function worldTupleSlug(tuple: SpotTuple): string {
  return tuple[1].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// `worldSpotId`'s diacritics-stripping (`String#normalize('NFKD')`) plus its regex passes cost ~3.6 ms
// per 8000 calls (measured) — cheap once, but `matchSpot` needs the id-slug of every world tuple on
// every unmatched `/command`, repeated across many Telegram updates over a warm Worker isolate's
// lifetime. `ALL_WORLD_TUPLES` (and any caller-supplied `tuples` array) is immutable for as long as
// the tuple objects themselves are referenced, so a tuple's id-slug never changes — caching it per
// tuple (not per array, so it works for both the real data and a test's synthetic tuples) turns an
// O(8000 expensive string ops) cost paid on *every* call into a one-time cost amortized across the
// isolate's whole lifetime (measured: ~0.6 ms/8000 once warm, vs. ~5 ms/8000 cold — see the report).
// `WeakMap` (not a plain `Map`) so an entry is only ever reachable via the tuple's own reference and
// can be collected if the tuple itself ever stops being referenced (never happens for the real,
// static `spots-world.json` array, but avoids any chance of an unbounded leak for callers that build
// fresh tuple arrays repeatedly, e.g. tests).
const idSlugCache = new WeakMap<SpotTuple, string>();

/** `id`-with-underscores for a tuple, computed the same cheap way (`worldSpotId` off `name` + exact
 * coordinates, no region assignment) — the tuple-level counterpart of `spotMatch.ts`'s `idSlug`.
 * Memoized per tuple (see `idSlugCache` above) — the expensive part. */
export function worldTupleIdSlug(tuple: SpotTuple): string {
  const cached = idSlugCache.get(tuple);
  if (cached !== undefined) return cached;
  const idSlug = worldSpotId(tuple[0], tuple[2], tuple[3]).replace(/-/g, '_');
  idSlugCache.set(tuple, idSlug);
  return idSlug;
}
