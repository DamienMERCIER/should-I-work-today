/**
 * Parses a surf-forecast.com `/breaks/<slug>/forecasts/latest` page for the one JSON blob the
 * importer needs: `"currentLocation":{"name":...,"lat":...,"lng":...,"type":...}`, embedded inside a
 * much larger inline-script payload near the end of the ~540 KB document. We deliberately do not
 * try to `JSON.parse` the whole page (it is not a standalone JSON document, and its shape outside
 * this one object is undocumented and irrelevant) — a small regex locates the balanced-brace object
 * and we `JSON.parse` just that fragment. Any failure (object absent, truncated, wrong field types)
 * yields `null` rather than throwing, so one malformed page never aborts the run (§import-spots.ts
 * stage 2: skip and count, don't crash).
 */
export interface ParsedBreak {
  name: string;
  lat: number;
  lon: number;
  type: string;
}

// Non-nested object: `currentLocation` in practice is a flat bag of strings/numbers/booleans/null
// (verified against the saved fixture), so a `[^{}]*` body is enough to capture it without a full
// JSON tokenizer.
const CURRENT_LOCATION_RE = /"currentLocation"\s*:\s*(\{[^{}]*\})/;

export function parseBreakPage(html: string): ParsedBreak | null {
  const match = CURRENT_LOCATION_RE.exec(html);
  if (!match) return null;

  let blob: unknown;
  try {
    blob = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (typeof blob !== 'object' || blob === null) return null;

  const { name, lat, lng, type } = blob as Record<string, unknown>;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof type !== 'string' || type.length === 0) return null;
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return null;
  if (typeof lng !== 'number' || !Number.isFinite(lng)) return null;

  return { name, lat, lon: lng, type };
}

// `/breaks/<slug>/forecasts/latest` is the only path under /breaks/ that robots.txt allows this bot
// to fetch (see the User-Agent-specific rule quoted in full in scripts/import-spots.ts) — every
// fetch in stage 2 must go through this builder, never a bare `/breaks/<slug>` URL.
export function breakUrl(slug: string): string {
  return `https://www.surf-forecast.com/breaks/${slug}/forecasts/latest`;
}
