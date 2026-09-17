#!/usr/bin/env -S npx tsx
// World-spot importer for the "Should I Work" bot — see .superpowers/sdd/world-import.md for the
// full write-up (pipeline, defaults, region assignment, runtime shape, estimated cost). Since
// 17/09/2026 the facing comes from each break page's wind table (scripts/lib/windFacing.ts), elevation
// sampling being only the fallback: 24 elevation points per spot did not fit Open-Meteo's free quota.
//
// ---------------------------------------------------------------------------------------------
// robots.txt, and why this script only ever fetches two kinds of URL
// ---------------------------------------------------------------------------------------------
// surf-forecast.com's robots.txt, for the user-agent "anthropic-ai", reads (in effect):
//
//   User-agent: anthropic-ai
//   Disallow: /breaks/*
//   Allow: /breaks/*/forecasts/*
//
// i.e. every /breaks/ path is disallowed EXCEPT the /forecasts/ pages underneath a break, which are
// explicitly carved back out. That is the ONLY shape of URL this script requests under /breaks/:
// stage 2 fetches exactly `/breaks/<slug>/forecasts/latest` (see breakUrl in scripts/lib/breakPage.ts)
// and nothing else — no /breaks/<slug> profile page, no photos, no comments. The sitemaps
// (`/sitemaps/<L>-<L>.xml.gz`) and Open-Meteo's public elevation API are unrelated paths robots.txt
// says nothing about restricting for this UA.
//
// Every request also carries an honest, identifying User-Agent (see scripts/lib/userAgentFetch.ts):
//   should-i-work-bot/1.0 (personal surf forecast bot; +https://github.com/DamienMERCIER/should-I-work-today)
// This script must never impersonate a browser — no spoofed Chrome/Safari UA, ever. Accept-Encoding
// is deliberately left alone (not overridden) so the runtime's own default (gzip, handled
// transparently by `fetch`) applies to stage 2's page fetches; the sitemap files are a different
// case — the URL itself is a `.xml.gz`, so stage 1 downloads the raw gzip bytes and decompresses
// them itself (scripts/lib/sitemap.ts's decompressGzip), regardless of transport-level compression.
// ---------------------------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FetchLike } from '../src/adapters/http';
import { REGIONS, SPOTS } from '../src/data/index';
import { assignRegion, worldSpotId, type SpotTuple } from '../src/data/world';
import type { Region, Spot } from '../src/types';
import { dedupeAdjacentWorld, dedupeAgainstCurated } from './lib/dedupe';
import { fetchBreakPages } from './lib/fetchBreaks';
import { loadProgress, saveProgress, type ImportProgress, type ProcessedEntry } from './lib/progress';
import { fetchSitemapSlugs } from './lib/sitemap';
import { deriveShort, shortSlug } from './lib/shortName';
import type { ElevationQuota } from './lib/elevation';
import { computeFacingsForSpots } from './lib/spotFacing';
import { toTuple } from './lib/tuple';
import { createFetch } from './lib/userAgentFetch';

// A skip caused by a transient failure (the site/service being briefly unreachable), as opposed to a
// permanent one (404, an unparseable page, a genuine no-sea-point geography) — retried on `--resume`
// instead of being treated as permanently done, so a real crawl actually recovers from the "at least
// one transient failure is near-certain" case (§report) rather than leaving silent, permanent gaps.
const RETRYABLE_SKIP_REASONS = new Set(['network-error', 'elevation-error', 'chunk-error']);

function isResolved(entry: ProcessedEntry | undefined): boolean {
  if (!entry) return false;
  return entry.status === 'spot' || !RETRYABLE_SKIP_REASONS.has(entry.reason);
}

const ALL_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
const DEFAULT_OUT = 'src/data/spots-world.json';
const DEFAULT_PROGRESS_PATH = '.superpowers/import-spots-progress.json';
const DEDUPE_THRESHOLD_M = 500;
const WORLD_DEDUPE_THRESHOLD_M = 200; // world-vs-world (§scripts/lib/dedupe.ts dedupeAdjacentWorld)
const CHUNK_SIZE = 200; // slugs per stage-2+3 batch, between which progress is saved (§resume grain)
const WORLD_SHORT_MAX_LEN = 13; // schema.ts: short ≤ 13 chars ; le préfixe ≈ ne s'affiche plus depuis e2ef7b1

export interface ImportArgs {
  limit?: number;
  letters: string[];
  out: string;
  resume: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ImportArgs {
  let limit: number | undefined;
  let letters = ALL_LETTERS;
  let out = DEFAULT_OUT;
  let resume = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--resume') resume = true;
    else if (arg === '--limit') {
      const n = Number(argv[++i]);
      limit = Number.isFinite(n) ? n : undefined;
    } else if (arg === '--letters') {
      letters = (argv[++i] ?? '')
        .toUpperCase()
        .split('')
        .filter((c) => /[A-Z]/.test(c));
    } else if (arg === '--out') {
      out = argv[++i] ?? DEFAULT_OUT;
    }
  }
  return { limit, letters, out, resume, help };
}

const HELP_TEXT = `Usage: tsx scripts/import-spots.ts [options]

Imports every surf spot in surf-forecast.com's sitemap into src/data/spots-world.json (a compact
tuple array — see .superpowers/sdd/world-import.md). Resumable: progress is saved after every
chunk, so an interrupted run can continue with --resume instead of starting over.

Each spot's facing is read from its own page's wind table — the orientation surf-forecast itself
uses. Open-Meteo's elevation API is only a fallback when the wind does not tell; it counts every
point against a free quota (5 000/hour, 10 000/day), and once it answers 429 the run stops asking:
those spots stay elevation-error until a later --resume.

Options:
  --limit N       Stop after considering N slugs total (from the combined, deduped sitemap list).
                   Use a small N (e.g. 20) for a trial run. Omit for no limit (all ~8032 slugs).
                   --limit 0 touches no network at all: it just (re)writes the output from whatever
                   is already recorded in progress (useful as a dry run / to verify the CLI wiring).
  --letters ABC   Only fetch these sitemap letters (case-insensitive). Default: all of A-Z.
  --out <path>    Where to write the tuple JSON. Default: ${DEFAULT_OUT}
                   The progress file lives alongside it as <path>.progress.json (or, at the
                   default path, under ${DEFAULT_PROGRESS_PATH}).
  --resume        Continue from the saved progress file instead of starting fresh. Without this
                   flag, any existing progress file is ignored and overwritten from a clean slate.
  --help, -h      Show this help and exit (no network requests).

Examples:
  tsx scripts/import-spots.ts --limit 20 --out .superpowers/spots-world-trial.json
  tsx scripts/import-spots.ts --resume
`;

export interface MainDeps {
  fetchFn?: FetchLike;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
};

function progressPathFor(out: string): string {
  return out === DEFAULT_OUT ? DEFAULT_PROGRESS_PATH : `${out}.progress.json`;
}

/** True once a spot ends up more than DEDUPE_THRESHOLD_M-scale away from every curated region — i.e.
 * `expandTuple` will synthesise a region for it on the fly at expand time (§src/data/world.ts). Used
 * only for the run summary ("N spots will get a synthetic region"); nothing is written for it. */
function needsSyntheticRegion(spot: { name: string; lat: number; lon: number; facing: number }, curated: readonly Region[]): boolean {
  const id = worldSpotId(spot.name, spot.lat, spot.lon);
  const region = assignRegion({ lat: spot.lat, lon: spot.lon, facing: spot.facing, id }, curated);
  return !curated.some((r) => r.id === region.id);
}

function writeOutput(out: string, progress: ImportProgress, curated: Spot[], log: (line: string) => void): void {
  const spots = Object.entries(progress.processed)
    .filter((entry): entry is [string, Extract<ProcessedEntry, { status: 'spot' }>] => entry[1].status === 'spot')
    .map(([slug, entry]) => ({ slug, ...entry }))
    .sort((a, b) => a.slug.localeCompare(b.slug)); // stable order => stable short-suffix assignment

  const { kept: keptAgainstCurated, droppedCount } = dedupeAgainstCurated(spots, curated, DEDUPE_THRESHOLD_M);
  const { kept, droppedCount: worldDroppedCount } = dedupeAdjacentWorld(keptAgainstCurated, WORLD_DEDUPE_THRESHOLD_M);

  const usedShortSlugs = new Set(curated.map((s) => shortSlug(s.short)));
  const tuples: SpotTuple[] = kept.map((spot) => {
    const short = deriveShort(spot.name, usedShortSlugs, WORLD_SHORT_MAX_LEN);
    return toTuple({ name: spot.name, short, lat: spot.lat, lon: spot.lon, facing: spot.facing, type: spot.type });
  });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(tuples));

  const skippedByReason = new Map<string, number>();
  for (const entry of Object.values(progress.processed)) {
    if (entry.status === 'skipped') skippedByReason.set(entry.reason, (skippedByReason.get(entry.reason) ?? 0) + 1);
  }
  const syntheticRegionCount = kept.filter((s) => needsSyntheticRegion(s, REGIONS)).length;

  log(`[import-spots] wrote ${tuples.length} spot(s) to ${out}`);
  const fromWind = spots.filter((s) => s.facingFrom === 'wind').length;
  log(`[import-spots] facing read from surf-forecast's wind table for ${fromWind} spot(s), from elevation for ${spots.length - fromWind}`);
  log(`[import-spots] dropped ${droppedCount} spot(s) within ${DEDUPE_THRESHOLD_M} m of a curated spot (curated wins)`);
  log(`[import-spots] dropped ${worldDroppedCount} adjacent world spot(s) within ${WORLD_DEDUPE_THRESHOLD_M} m of another world spot (earliest by slug wins)`);
  log(
    `[import-spots] skipped ${[...skippedByReason.values()].reduce((a, b) => a + b, 0)}: ${
      [...skippedByReason.entries()].map(([reason, n]) => `${reason}=${n}`).join(', ') || 'none'
    }`,
  );
  log(`[import-spots] ${syntheticRegionCount} of ${tuples.length} spot(s) are >500 km from every curated region (synthetic region at expand time)`);
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<void> {
  const args = parseArgs(argv);
  const log = deps.log ?? console.log;

  if (args.help) {
    log(HELP_TEXT);
    return;
  }

  const progressPath = progressPathFor(args.out);
  const progress: ImportProgress = args.resume && existsSync(progressPath) ? loadProgress(progressPath) : { letters: [], slugs: [], processed: {} };

  if (args.limit === 0) {
    log('[import-spots] --limit 0: dry run, no network requests');
    writeOutput(args.out, progress, SPOTS, log);
    return;
  }

  const fetchFn = createFetch(deps.fetchFn ?? fetch);
  const fetchOpts = { sleep: deps.sleep };
  const now = deps.now ?? Date.now;

  // stage 1: sitemaps → slug list (skips letters already folded into progress.slugs on --resume)
  for (const letter of args.letters) {
    if (progress.letters.includes(letter)) continue;
    const letterSlugs = await fetchSitemapSlugs(letter, fetchFn, fetchOpts);
    const known = new Set(progress.slugs);
    for (const slug of letterSlugs) {
      if (!known.has(slug)) {
        progress.slugs.push(slug);
        known.add(slug);
      }
    }
    progress.letters.push(letter);
    saveProgress(progressPath, progress);
    log(`[import-spots] sitemap ${letter}: +${letterSlugs.length} slugs (${progress.slugs.length} discovered so far)`);
  }

  const targetSlugs = args.limit === undefined ? progress.slugs : progress.slugs.slice(0, args.limit);
  const todo = targetSlugs.filter((slug) => !isResolved(progress.processed[slug]));
  log(`[import-spots] ${targetSlugs.length} slug(s) targeted, ${targetSlugs.length - todo.length} already done, ${todo.length} to process`);

  const t0 = now();
  // Open-Meteo compte chaque point d'altitude (5 000 par heure, 10 000 par jour) : un seul état pour
  // toute l'exécution, pour qu'un quota épuisé arrête les demandes des blocs suivants aussi.
  const elevationQuota: ElevationQuota = { exhausted: false };
  for (let i = 0; i < todo.length; i += CHUNK_SIZE) {
    const chunk = todo.slice(i, i + CHUNK_SIZE);
    try {
      const { results, skipped } = await fetchBreakPages(chunk, fetchFn, fetchOpts);
      // L'orientation lue dans le tableau de vent de la page d'abord ; l'altitude seulement quand le vent ne tranche pas.
      for (const r of results) {
        if (r.windFacing) progress.processed[r.slug] = { status: 'spot', name: r.name, lat: r.lat, lon: r.lon, facing: r.windFacing.facing, type: r.type, facingFrom: 'wind' };
      }
      const needElevation = results.filter((r) => !r.windFacing);
      const quotaWasSpent = elevationQuota.exhausted;
      const facingOutcomes = await computeFacingsForSpots(needElevation, fetchFn, { ...fetchOpts, quota: elevationQuota });
      if (!quotaWasSpent && elevationQuota.exhausted) {
        log('[import-spots] Open-Meteo quota reached: no more elevation requests this run — those spots are left as elevation-error, run again with --resume later');
      }

      needElevation.forEach((r, idx) => {
        const outcome = facingOutcomes[idx];
        progress.processed[r.slug] =
          'skipped' in outcome
            ? { status: 'skipped', reason: outcome.skipped.reason }
            : { status: 'spot', name: r.name, lat: r.lat, lon: r.lon, facing: outcome.facing, type: r.type, facingFrom: 'elevation' };
      });
      for (const s of skipped) progress.processed[s.slug] = { status: 'skipped', reason: s.reason };
    } catch (err) {
      // Both fetchBreakPages and computeFacingsForSpots already turn a per-slug/per-batch failure into
      // a skipped result rather than throwing (§report) — reaching here means something unexpected (a
      // bug, not a modelled failure mode). Defense in depth: whatever in this chunk wasn't recorded
      // yet (a slug already written above, if the throw came from computeFacingsForSpots after
      // fetchBreakPages resolved, is left alone) is marked skipped so the chunk's successes are never
      // silently lost and the run can still save progress and continue instead of aborting entirely.
      log(`[import-spots] chunk starting at ${i} failed unexpectedly, skipping its unresolved slug(s) and continuing: ${String(err)}`);
      for (const slug of chunk) {
        if (!(slug in progress.processed)) progress.processed[slug] = { status: 'skipped', reason: 'chunk-error' };
      }
    }
    saveProgress(progressPath, progress);

    const doneSoFar = Math.min(i + CHUNK_SIZE, todo.length);
    const elapsedMs = now() - t0;
    const etaMs = (elapsedMs / doneSoFar) * (todo.length - doneSoFar);
    log(`[import-spots] processed ${doneSoFar}/${todo.length} this run — elapsed ${formatDuration(elapsedMs)}, ETA ${formatDuration(etaMs)}`);
  }

  writeOutput(args.out, progress, SPOTS, log);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
