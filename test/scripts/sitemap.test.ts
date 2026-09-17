import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { sitemapUrl, extractBreakSlugs, decompressGzip, fetchSitemapSlugs } from '../../scripts/lib/sitemap';

const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.surf-forecast.com/breaks/Muizenberg/forecasts/latest</loc></url>
  <url><loc>https://www.surf-forecast.com/breaks/Kommetjie-Long-Beach/forecasts/latest</loc></url>
  <url><loc>https://www.surf-forecast.com/regions/South-Africa</loc></url>
  <url><loc>https://www.surf-forecast.com/breaks/Llandudno/photos</loc></url>
  <url><loc>https://www.surf-forecast.com/breaks/Noordhoek/forecasts/latest</loc></url>
</urlset>`;

describe('sitemapUrl', () => {
  it('builds the per-letter gzipped sitemap URL', () => {
    expect(sitemapUrl('A')).toBe('https://www.surf-forecast.com/sitemaps/A-A.xml.gz');
    expect(sitemapUrl('Z')).toBe('https://www.surf-forecast.com/sitemaps/Z-Z.xml.gz');
  });
});

describe('extractBreakSlugs', () => {
  it('extracts only the /breaks/<slug>/forecasts/latest slugs, ignoring other <loc> entries', () => {
    expect(extractBreakSlugs(sampleXml)).toEqual(['Muizenberg', 'Kommetjie-Long-Beach', 'Noordhoek']);
  });
  it('returns an empty array when there are no matching entries', () => {
    expect(extractBreakSlugs('<urlset></urlset>')).toEqual([]);
  });
});

describe('decompressGzip', () => {
  it('round-trips a gzip-compressed buffer back to the original text', () => {
    const compressed = gzipSync(Buffer.from(sampleXml, 'utf8'));
    expect(decompressGzip(compressed)).toBe(sampleXml);
  });
});

describe('decompressGzip on an already-decompressed body', () => {
  it('passes plain XML through instead of trying to gunzip it', () => {
    // fetch sends `accept-encoding: gzip`; the server replies `Content-Encoding: gzip` and the
    // HTTP layer already decompresses it. The body therefore arrives in the clear despite the .xml.gz URL,
    // and gunzip used to fail on "incorrect header check" (Z_DATA_ERROR).
    const xml = '<?xml version="1.0"?><urlset><url><loc>https://x/breaks/Aan/forecasts/latest</loc></url></urlset>';
    expect(decompressGzip(new TextEncoder().encode(xml))).toBe(xml);
  });
  it('still gunzips a body that really is gzipped', () => {
    const xml = '<urlset><loc>ok</loc></urlset>';
    expect(decompressGzip(gzipSync(Buffer.from(xml, 'utf8')))).toBe(xml);
  });
});

describe('fetchSitemapSlugs', () => {
  it('fetches, decompresses and parses a letter\'s sitemap', async () => {
    const compressed = gzipSync(Buffer.from(sampleXml, 'utf8'));
    let requestedUrl = '';
    const fetchFn = async (url: string) => {
      requestedUrl = url;
      return new Response(compressed, { status: 200 });
    };
    const slugs = await fetchSitemapSlugs('M', fetchFn, { sleep: async () => {} });
    expect(requestedUrl).toBe('https://www.surf-forecast.com/sitemaps/M-M.xml.gz');
    expect(slugs).toEqual(['Muizenberg', 'Kommetjie-Long-Beach', 'Noordhoek']);
  });

  it('returns an empty array (not a crash) when a letter has no sitemap (404)', async () => {
    const fetchFn = async () => new Response('not found', { status: 404 });
    const slugs = await fetchSitemapSlugs('Q', fetchFn, { sleep: async () => {} });
    expect(slugs).toEqual([]);
  });
});
