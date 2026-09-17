import { gunzipSync } from 'node:zlib';
import type { FetchLike } from '../../src/adapters/http';
import { fetchWithRetry, type RetryOptions } from './httpRetry';

/** `https://www.surf-forecast.com/sitemaps/<L>-<L>.xml.gz` for `L` in A..Z (established fact). */
export function sitemapUrl(letter: string): string {
  return `https://www.surf-forecast.com/sitemaps/${letter}-${letter}.xml.gz`;
}

const LOC_RE = /<loc>https:\/\/www\.surf-forecast\.com\/breaks\/([^/<]+)\/forecasts\/latest<\/loc>/g;

/**
 * A sitemap's `<loc>` entries cover more than break forecast pages (region pages, photo pages, ...) —
 * only `/breaks/<slug>/forecasts/latest` is a slug the importer wants, and matches the only path
 * robots.txt allows this bot to fetch under `/breaks/*`.
 */
export function extractBreakSlugs(xml: string): string[] {
  return [...xml.matchAll(LOC_RE)].map((m) => m[1]);
}

// `TextDecoder` rather than `Buffer#toString('utf8')`: this file type-checks under both
// `@cloudflare/workers-types` and `@types/node` (tsconfig includes `scripts`), and the two disagree
// on which global `Buffer`/`ArrayBuffer` declaration wins — `TextDecoder` is unambiguous either way.
export function decompressGzip(bytes: ArrayBuffer | Uint8Array): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // The URL ends in .xml.gz, but `fetch` advertises `accept-encoding: gzip` and the server replies
  // `Content-Encoding: gzip`: the HTTP layer has already decompressed it, and the body arrives already plain.
  // So we only decompress if the bytes really carry the gzip signature (0x1f 0x8b),
  // otherwise gunzip fails with "incorrect header check".
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  return new TextDecoder('utf-8').decode(isGzip ? gunzipSync(buf) : buf);
}

/** Fetches and parses one letter's sitemap. A 404 (no sitemap for that letter) yields `[]`, not a crash. */
export async function fetchSitemapSlugs(letter: string, fetchFn: FetchLike, opts: RetryOptions = {}): Promise<string[]> {
  const res = await fetchWithRetry(sitemapUrl(letter), fetchFn, opts);
  if (!res.ok) return [];
  return extractBreakSlugs(decompressGzip(await res.arrayBuffer()));
}
