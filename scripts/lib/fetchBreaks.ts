import { sleep as defaultSleep, type FetchLike } from '../../src/adapters/http';
import { breakUrl, parseBreakPage, type ParsedBreak } from './breakPage';
import { mapWithConcurrency } from './concurrency';
import { parseForecastTable } from './forecastTable';
import { fetchWithRetry, type RetryOptions } from './httpRetry';
import { facingFromWind, type WindFacing } from './windFacing';

const DEFAULT_CONCURRENCY = 4;
/** "A short delay between requests" (task spec) — also reused as the retry backoff (§httpRetry) when
 * a request needs a second attempt; one knob is enough for a dev-run CLI tool, see the report. */
const DEFAULT_DELAY_MS = 250;

export interface FetchBreaksOptions extends RetryOptions {
  concurrency?: number;
  delayMs?: number;
}

export interface BreakResult extends ParsedBreak {
  slug: string;
  /** l'orientation que le site donne au spot, lue dans le tableau de vent de la même page ; `null` si le vent ne tranche pas */
  windFacing: WindFacing | null;
}

export interface SkippedBreak {
  slug: string;
  reason: string;
}

export interface FetchBreaksResult {
  results: BreakResult[];
  skipped: SkippedBreak[];
}

type Outcome = { result: BreakResult } | { skipped: SkippedBreak };

/**
 * Stage 2: fetches `/breaks/<slug>/forecasts/latest` for every slug — concurrency 4, a short delay
 * between requests, one retry on a 5xx, and a 404 or an unparseable page is *skipped and counted*,
 * never thrown — one bad slug (a stale sitemap entry, a page that changed shape) must not abort a
 * multi-hour run over 8000 spots.
 */
export async function fetchBreakPages(slugs: string[], fetchFn: FetchLike, opts: FetchBreaksOptions = {}): Promise<FetchBreaksResult> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;

  const outcomes = await mapWithConcurrency<string, Outcome>(slugs, concurrency, async (slug) => {
    try {
      const res = await fetchWithRetry(breakUrl(slug), fetchFn, { ...opts, delayMs, sleep });
      if (res.status === 404) return { skipped: { slug, reason: '404' } };
      if (!res.ok) return { skipped: { slug, reason: `http-${res.status}` } };
      const html = await res.text();
      const parsed = parseBreakPage(html);
      if (!parsed) return { skipped: { slug, reason: 'no-coordinate-blob' } };
      return { result: { slug, ...parsed, windFacing: facingFromWind(parseForecastTable(html)) } };
    } catch {
      // fetchWithRetry throws only when fetchFn itself rejects on every attempt (a real network
      // failure — timeout, DNS, connection reset — surviving the built-in retry), never for an HTTP
      // status (those are handled above). One bad slug must not discard every other result in this
      // chunk (§report "Resilience, wiring and dedupe") — skip and count it like any other outcome.
      return { skipped: { slug, reason: 'network-error' } };
    } finally {
      await sleep(delayMs);
    }
  });

  const results: BreakResult[] = [];
  const skipped: SkippedBreak[] = [];
  for (const outcome of outcomes) {
    if ('result' in outcome) results.push(outcome.result);
    else skipped.push(outcome.skipped);
  }
  return { results, skipped };
}
