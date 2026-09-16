import { allWorldTuples, expandTuple, worldTupleIdSlug, worldTupleSlug, type SpotTuple } from '../data/world';
import type { Spot } from '../types';

/**
 * Telegram only linkifies `[a-z0-9_]` in a command, so a kebab-case spot id (e.g.
 * `kommetjie-long-beach`) is not tappable — Telegram stops at the hyphen. The tappable command is
 * derived from the spot's `short` label instead (schema-validated ≤ 13 chars, unique within a
 * region): lowercase, every run of non-alphanumeric characters collapsed to one `_`, ends trimmed.
 * "Long Beach" → "long_beach", "Misty Cliffs" → "misty_cliffs", "Vic Bay" → "vic_bay".
 * Uniqueness across the *whole* database (not just per-region, unlike `short`) is asserted by
 * `test/bot/spotMatch.test.ts` against the real 35-spot data, not just guaranteed by construction.
 */
export function spotSlug(spot: Spot): string {
  return spot.short
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** `id` normalised the same way user input is (`-` → `_`), for the "exact id" / prefix / substring tiers. */
const idSlug = (spot: Spot): string => spot.id.replace(/-/g, '_');

export type SpotMatch =
  | { kind: 'one'; spot: Spot }
  | { kind: 'ambiguous'; spots: Spot[] }
  | { kind: 'none' };

/** Curated + world spot count, for `/about` (`src/bot/router.ts`). `worldTuples` defaults to the real
 * `allWorldTuples()` (currently empty — §report, unchanged until the owner runs the import); the
 * parameter exists for tests. */
export function totalSpotCount(spots: Spot[], worldTuples: SpotTuple[] = allWorldTuples()): number {
  return spots.length + worldTuples.length;
}

/**
 * Resolves the text after `/` to a spot: an exact slug, then an exact id-with-underscores, then a
 * single fuzzy pool (prefix *or* substring of the slug, the id or the lowercased name). Searches
 * curated `spots` **and** the world set (`worldTuples`, every `/command` looks across the whole
 * ~8000-tuple database — a spot can be known but outside the user's radius, §`handleSpotCommand`) —
 * at each tier, a world tuple's cheap fields (`worldTupleSlug`/`worldTupleIdSlug`, computed straight
 * off the tuple, no region assignment) are checked alongside curated `Spot`s *before* falling to the
 * next tier, and only the tuples that actually match get expanded via `expandTuple` — expanding all
 * ~8000 just to search would burn the Worker's 10 ms budget for nothing. `worldTuples` defaults to the
 * real `allWorldTuples()` (currently an empty placeholder, §report — behaviour is unchanged until the
 * owner runs the import); the parameter exists for tests.
 *
 * The fuzzy stage is deliberately one pool rather than a prefix tier followed by a substring tier:
 * with tiers, `/kom` matched `kommetjie_long_beach` by prefix, the tier returned a single candidate
 * and stopped — so the bot confidently showed Long Beach and never mentioned Inner Kom or Outer Kom,
 * which only match as a substring. A query that fits several spots must say so.
 *
 * Every stage collects rather than takes the first hit, so a collision — including a curated spot and
 * a (unverified) world spot matching at the same tier — surfaces as `ambiguous` instead of silently
 * resolving to whichever one comes first. `input` is normalised here (lowercased, `-` → `_`), so
 * callers can pass the raw command text.
 *
 * **Perf, measured against a synthetic 8000-tuple world set** (§report "Resilience, wiring and
 * dedupe"): steady state (the id-slug cache warm, `worldTupleIdSlug`/§world.ts) is well under 1 ms
 * even for a no-match query that scans every tier — the case that matters, since a Worker isolate's
 * `ALL_WORLD_TUPLES` never changes across the many requests it serves. The one residual case that does
 * not fit inside 10 ms cleanly: the *very first* call ever made on a freshly cold isolate (JIT and the
 * id-slug cache both cold at once) measured ~10-12 ms on a dev machine — one bad worst-case slug
 * scanned all 8000 tuples' `worldSpotId` (diacritics-stripping is the expensive part) with nothing
 * memoized yet. Judged an acceptable, narrow residual risk (a single slightly-slow response on a rare
 * cold start, not a crash or data loss) rather than something to engineer further for — flagged here
 * rather than silently accepted.
 */
export function matchSpot(input: string, spots: Spot[], worldTuples: SpotTuple[] = allWorldTuples()): SpotMatch {
  const q = input.toLowerCase().replace(/-/g, '_');
  if (!q) return { kind: 'none' };

  // One pass over the world tuples — not three independent `.filter()` passes, one per tier — bucketing
  // each tuple into the first tier it matches. `worldTupleIdSlug` is memoized per tuple (§world.ts), so
  // three separate passes would still cost the same on a *warm* cache; the point here is the *cold*
  // case (a query nothing matches, e.g. a typo, so every tier runs): three passes each recompute
  // `worldTupleSlug` and re-touch every tuple, and the very first idSlug computation for all 8000
  // tuples is the expensive one regardless of how many passes ask for it. A single pass keeps that
  // one-time cost to exactly one slug + one id-slug computation per tuple (measured: worst case drops
  // from ~13 ms to a few ms cold, and sub-millisecond once the id-slug cache is warm — see the report).
  const worldTier1: SpotTuple[] = [];
  const worldTier2: SpotTuple[] = [];
  const worldTier3: SpotTuple[] = [];
  for (const t of worldTuples) {
    const slug = worldTupleSlug(t);
    if (slug === q) {
      worldTier1.push(t);
      continue;
    }
    const id = worldTupleIdSlug(t);
    if (id === q) {
      worldTier2.push(t);
      continue;
    }
    if (slug.includes(q) || id.includes(q) || t[0].toLowerCase().includes(q)) worldTier3.push(t);
  }

  const expandAll = (tuples: SpotTuple[]): Spot[] => tuples.map((t) => expandTuple(t));

  const resolve = (curatedMatches: Spot[], worldMatches: SpotTuple[]): SpotMatch | undefined => {
    const combined = [...curatedMatches, ...expandAll(worldMatches)];
    if (combined.length === 1) return { kind: 'one', spot: combined[0] };
    if (combined.length > 1) return { kind: 'ambiguous', spots: combined };
    return undefined;
  };

  return (
    resolve(spots.filter((s) => spotSlug(s) === q), worldTier1) ??
    resolve(spots.filter((s) => idSlug(s) === q), worldTier2) ??
    resolve(
      spots.filter((s) => [spotSlug(s), idSlug(s), s.name.toLowerCase()].some((h) => h.includes(q))),
      worldTier3,
    ) ?? { kind: 'none' }
  );
}
