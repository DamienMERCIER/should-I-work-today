const DEFAULT_MAX_LEN = 13;

/**
 * Mirrors `src/bot/spotMatch.ts`'s `spotSlug` transform (lowercase, every run of non-alphanumeric
 * characters collapsed to one `_`, ends trimmed) so two `short` labels that would collide as the
 * same Telegram command slug are treated as one collision here, not just labels that are byte-for-
 * byte equal. Duplicated rather than imported because `spotSlug` takes a full `Spot`, not a bare
 * string; `test/scripts/shortName.test.ts` cross-checks this copy against the real function so the
 * two can't silently drift apart.
 */
export function shortSlug(short: string): string {
  return short
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const stripDiacritics = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
const truncate = (s: string, maxLen: number): string => s.slice(0, Math.max(0, maxLen)).trimEnd();

/**
 * Derives a `short` label (schema-validated ≤ 13 chars, ≤ 11 for an unverified spot — every world
 * spot is unverified, so the importer calls this with `maxLen: 11`) from a spot's name, truncating to
 * fit and appending a numeric suffix (shrinking the base further if needed) until the resulting
 * label's slug (§`shortSlug`) is not in `used`. `used` must be seeded by the caller with the slugs of
 * every label already claimed — curated spots' `short` included — so a world spot can never collide
 * with a curated one even when they end up sharing a region. Mutates `used` by adding the winning
 * slug, so repeat calls sharing the same set keep disambiguating against each other.
 */
export function deriveShort(name: string, used: Set<string>, maxLen = DEFAULT_MAX_LEN): string {
  const base = truncate(stripDiacritics(name), maxLen) || 'Spot';
  let candidate = base;
  let suffixNum = 2;
  while (used.has(shortSlug(candidate))) {
    const suffix = String(suffixNum);
    candidate = truncate(base, maxLen - suffix.length) + suffix;
    suffixNum++;
  }
  used.add(shortSlug(candidate));
  return candidate;
}
