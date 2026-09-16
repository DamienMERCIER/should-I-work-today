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

/**
 * Resolves the text after `/` to a spot: an exact slug, then an exact id-with-underscores, then a
 * single fuzzy pool (prefix *or* substring of the slug, the id or the lowercased name).
 *
 * The fuzzy stage is deliberately one pool rather than a prefix tier followed by a substring tier:
 * with tiers, `/kom` matched `kommetjie_long_beach` by prefix, the tier returned a single candidate
 * and stopped — so the bot confidently showed Long Beach and never mentioned Inner Kom or Outer Kom,
 * which only match as a substring. A query that fits several spots must say so.
 *
 * The exact stages collect rather than take the first hit, so a future slug collision surfaces as
 * `ambiguous` instead of silently resolving to whichever spot comes first in the file.
 * `input` is normalised here (lowercased, `-` → `_`), so callers can pass the raw command text.
 */
export function matchSpot(input: string, spots: Spot[]): SpotMatch {
  const q = input.toLowerCase().replace(/-/g, '_');
  if (!q) return { kind: 'none' };

  const resolve = (matches: Spot[]): SpotMatch | undefined => {
    if (matches.length === 1) return { kind: 'one', spot: matches[0] };
    if (matches.length > 1) return { kind: 'ambiguous', spots: matches };
    return undefined;
  };

  return (
    resolve(spots.filter((s) => spotSlug(s) === q)) ??
    resolve(spots.filter((s) => idSlug(s) === q)) ??
    resolve(
      spots.filter((s) => {
        const haystacks = [spotSlug(s), idSlug(s), s.name.toLowerCase()];
        return haystacks.some((h) => h.includes(q));
      }),
    ) ?? { kind: 'none' }
  );
}
