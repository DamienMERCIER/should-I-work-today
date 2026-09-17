import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type ProcessedEntry =
  // `short` is deliberately not stored: `writeOutput` (scripts/import-spots.ts) always recomputes it
  // via `deriveShort` at write time (global-uniqueness disambiguation needs the whole kept set, not a
  // single spot in isolation), so a `short` field here would be write-only dead data.
  // `facingFrom`: read from the page's wind table, or computed from elevation as a fallback;
  // absent from a progress file written before the wind reading was added (17/09/2026), when everything came from elevation.
  | { status: 'spot'; name: string; lat: number; lon: number; facing: number; type: string; facingFrom?: 'wind' | 'elevation' }
  | { status: 'skipped'; reason: string };

export interface ImportProgress {
  /** Sitemap letters (A..Z) already fetched in stage 1 — a resumed run skips re-fetching these. */
  letters: string[];
  /** The full deduped slug list discovered so far, across `letters` — persisted so a resumed run
   * doesn't need to re-fetch a sitemap just to reconstruct which slugs it named. */
  slugs: string[];
  /** slug → outcome, covering both stage 2 (fetch/parse) and stage 3 (facing) — a resumed run only
   * re-fetches slugs not yet in here. */
  processed: Record<string, ProcessedEntry>;
}

const EMPTY: ImportProgress = { letters: [], slugs: [], processed: {} };

/** The empty default when there is no file yet, or the file is unreadable/corrupt — e.g. the process
 * was killed mid-write on a previous run. A resumable tool must never let a bad progress file turn
 * into a crash; worst case it just re-does the work. */
export function loadProgress(path: string): ImportProgress {
  if (!existsSync(path)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.letters) || !Array.isArray(parsed.slugs) || typeof parsed.processed !== 'object') {
      return { ...EMPTY };
    }
    return { letters: parsed.letters, slugs: parsed.slugs, processed: parsed.processed };
  } catch {
    return { ...EMPTY };
  }
}

/** Write-to-temp-then-rename so a save is atomic from a reader's point of view — an interrupt
 * (§loadProgress) can only ever see the previous complete save or the new one, never a half-written
 * file. */
export function saveProgress(path: string, progress: ImportProgress): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(progress));
  renameSync(tmpPath, path);
}
