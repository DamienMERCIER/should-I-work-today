import { describe, it, expect, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, main } from '../../scripts/import-spots';
import { destinationPoint } from '../../src/engine/geo';
import type { SpotTuple } from '../../src/data/world';
import { MUIZENBERG_WINDS, forecastTableHtml } from '../helpers/forecastPage';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('defaults to no limit, all 26 letters, the standard out path, resume off, help off', () => {
    const args = parseArgs([]);
    expect(args.limit).toBeUndefined();
    expect(args.letters).toEqual('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
    expect(args.out).toBe('src/data/spots-world.json');
    expect(args.resume).toBe(false);
    expect(args.help).toBe(false);
  });

  it('parses --limit, --letters, --out, --resume, --help', () => {
    const args = parseArgs(['--limit', '20', '--letters', 'mzq', '--out', 'custom/path.json', '--resume', '--help']);
    expect(args.limit).toBe(20);
    expect(args.letters).toEqual(['M', 'Z', 'Q']);
    expect(args.out).toBe('custom/path.json');
    expect(args.resume).toBe(true);
    expect(args.help).toBe(true);
  });

  it('accepts --limit 0 as an explicit value, not "no limit"', () => {
    expect(parseArgs(['--limit', '0']).limit).toBe(0);
  });
});

const sitemapFor = (slugs: string[]): Buffer =>
  gzipSync(Buffer.from(`<urlset>${slugs.map((s) => `<url><loc>https://www.surf-forecast.com/breaks/${s}/forecasts/latest</loc></url>`).join('')}</urlset>`, 'utf8'));
const blobFor = (name: string, lat: number, lon: number): string => `"currentLocation":{"name":"${name}","filename":"${name}","lat":${lat},"lng":${lon},"type":"Beach"}`;
const seaElevation = (url: string): Response => {
  const count = new URL(url).searchParams.get('latitude')!.split(',').length;
  return new Response(JSON.stringify({ elevation: Array(count).fill(-1) }), { status: 200 }); // every ring point is "sea"
};

describe('main', () => {
  it('--help prints usage and makes no network requests', async () => {
    const logs: string[] = [];
    let fetchCalls = 0;
    await main(['--help'], {
      log: (l) => logs.push(l),
      fetchFn: async () => {
        fetchCalls++;
        throw new Error('should not be called');
      },
    });
    expect(fetchCalls).toBe(0);
    const text = logs.join('\n');
    expect(text).toContain('--limit');
    expect(text).toContain('--letters');
    expect(text).toContain('--out');
    expect(text).toContain('--resume');
  });

  it('--limit 0 makes no network requests and still writes a (empty, on a fresh run) output file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'import-spots-test-'));
    const out = join(dir, 'spots-world.json');
    let fetchCalls = 0;
    await main(['--limit', '0', '--out', out], {
      log: () => {},
      fetchFn: async () => {
        fetchCalls++;
        throw new Error('should not be called');
      },
    });
    expect(fetchCalls).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual([]);
  });

  it('runs the full offline pipeline end to end: sitemap → break pages → facing → dedupe → tuples — a spot inside the hand-picked coverage is left out', async () => {
    dir = mkdtempSync(join(tmpdir(), 'import-spots-test-'));
    const out = join(dir, 'spots-world.json');

    const sitemapXml = [
      '<urlset>',
      '<url><loc>https://www.surf-forecast.com/breaks/Muizenberg/forecasts/latest</loc></url>',
      '<url><loc>https://www.surf-forecast.com/breaks/Tofo/forecasts/latest</loc></url>',
      '<url><loc>https://www.surf-forecast.com/breaks/Gone404/forecasts/latest</loc></url>',
      '<url><loc>https://www.surf-forecast.com/breaks/NoBlobSlug/forecasts/latest</loc></url>',
      '</urlset>',
    ].join('');

    const fetchFn = async (url: string) => {
      if (url.includes('/sitemaps/')) {
        if (!url.includes('/sitemaps/M-M.xml.gz')) return new Response('', { status: 404 });
        return new Response(gzipSync(Buffer.from(sitemapXml, 'utf8')), { status: 200 });
      }
      if (url.includes('/breaks/Gone404/')) return new Response('nope', { status: 404 });
      if (url.includes('/breaks/NoBlobSlug/')) return new Response('<html>nothing here</html>', { status: 200 });
      if (url.includes('/breaks/Muizenberg/')) {
        const blob = '"currentLocation":{"name":"Muizenberg","filename":"Muizenberg","lat":-34.1026,"lng":18.4737,"type":"Beach"}';
        return new Response(blob, { status: 200 });
      }
      if (url.includes('/breaks/Tofo/')) return new Response(blobFor('Tofo', -23.8522, 35.5478), { status: 200 });
      if (url.includes('api.open-meteo.com/v1/elevation')) {
        const count = new URL(url).searchParams.get('latitude')!.split(',').length;
        return new Response(JSON.stringify({ elevation: Array(count).fill(-1) }), { status: 200 }); // every ring point is "sea"
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const logs: string[] = [];
    await main(['--letters', 'M', '--out', out], { fetchFn, log: (l) => logs.push(l), sleep: async () => {} });

    const tuples = JSON.parse(readFileSync(out, 'utf8')) as SpotTuple[];
    // surf-forecast's own Muizenberg sits ~690 m from the curated one: inside the bot's 20 km radius of a
    // hand-picked spot, it is left out rather than shown twice with another orientation.
    expect(tuples).toHaveLength(1);
    expect(tuples[0][0]).toBe('Tofo');
    expect(tuples[0][2]).toBeCloseTo(-23.8522, 4);
    expect(tuples[0][3]).toBeCloseTo(35.5478, 4);

    const text = logs.join('\n');
    expect(text).toMatch(/1.*spot|spot.*1/i);
    expect(text).toContain('404');
    expect(text).toContain('no-coordinate-blob');
    expect(text).toContain('dropped 1 spot(s) within 20 km of a curated spot');

    // progress file exists alongside the custom --out path and remembers the outcome
    expect(existsSync(`${out}.progress.json`)).toBe(true);
    const progress = JSON.parse(readFileSync(`${out}.progress.json`, 'utf8'));
    expect(progress.processed.Muizenberg.status).toBe('spot');
    expect(progress.processed.Gone404).toEqual({ status: 'skipped', reason: '404' });
    expect(progress.processed.NoBlobSlug).toEqual({ status: 'skipped', reason: 'no-coordinate-blob' });
  });

  it('with --resume, does not re-fetch a slug that was already processed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'import-spots-test-'));
    const out = join(dir, 'spots-world.json');
    let breakFetches = 0;

    const sitemapXml = '<urlset><url><loc>https://www.surf-forecast.com/breaks/Muizenberg/forecasts/latest</loc></url></urlset>';
    const fetchFn = async (url: string) => {
      if (url.includes('/sitemaps/')) return new Response(gzipSync(Buffer.from(sitemapXml, 'utf8')), { status: 200 });
      if (url.includes('/breaks/Muizenberg/')) {
        breakFetches++;
        const blob = '"currentLocation":{"name":"Muizenberg","filename":"Muizenberg","lat":-34.1026,"lng":18.4737,"type":"Beach"}';
        return new Response(blob, { status: 200 });
      }
      if (url.includes('api.open-meteo.com/v1/elevation')) {
        const count = new URL(url).searchParams.get('latitude')!.split(',').length;
        return new Response(JSON.stringify({ elevation: Array(count).fill(-1) }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await main(['--letters', 'M', '--out', out], { fetchFn, log: () => {}, sleep: async () => {} });
    expect(breakFetches).toBe(1);

    await main(['--letters', 'M', '--out', out, '--resume'], { fetchFn, log: () => {}, sleep: async () => {} });
    expect(breakFetches).toBe(1); // unchanged: Muizenberg was already in progress, not re-fetched
  });

  it("orients a spot from its own page's wind table without asking Open-Meteo — only a page whose wind does not tell falls back to elevation", async () => {
    dir = mkdtempSync(join(tmpdir(), 'import-spots-test-'));
    const out = join(dir, 'spots-world.json');
    const pages: Record<string, string> = {
      Supertubos: blobFor('Supertubos', 39.3434, -9.3633) + forecastTableHtml(MUIZENBERG_WINDS), // the Muizenberg fixture's winds, far from any curated spot
      Tofo: blobFor('Tofo', -23.8522, 35.5478),
    };
    let elevationPoints = 0;
    const fetchFn = async (url: string) => {
      if (url.includes('/sitemaps/')) return new Response(sitemapFor(Object.keys(pages)), { status: 200 });
      const slug = /\/breaks\/([^/]+)\//.exec(url)?.[1];
      if (slug && pages[slug]) return new Response(pages[slug], { status: 200 });
      if (url.includes('api.open-meteo.com/v1/elevation')) {
        elevationPoints += new URL(url).searchParams.get('latitude')!.split(',').length;
        return seaElevation(url);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const logs: string[] = [];
    await main(['--letters', 'M', '--out', out], { fetchFn, log: (l) => logs.push(l), sleep: async () => {} });

    const tuples = JSON.parse(readFileSync(out, 'utf8')) as SpotTuple[];
    expect(tuples.map((t) => [t[0], t[4]])).toEqual([['Supertubos', 124], ['Tofo', expect.any(Number)]]);
    expect(elevationPoints).toBe(24); // Tofo's ring only
    const progress = JSON.parse(readFileSync(`${out}.progress.json`, 'utf8'));
    expect(progress.processed.Supertubos).toMatchObject({ status: 'spot', facing: 124, facingFrom: 'wind' });
    expect(progress.processed.Tofo).toMatchObject({ status: 'spot', facingFrom: 'elevation' });
    expect(logs.join('\n')).toContain("facing read from surf-forecast's wind table for 1 spot(s), from elevation for 1");
  });

  it("at Open-Meteo's first 429, stops asking for elevation for the rest of the run and leaves those spots to --resume", async () => {
    dir = mkdtempSync(join(tmpdir(), 'import-spots-test-'));
    const out = join(dir, 'spots-world.json');
    const slugs = Array.from({ length: 201 }, (_, i) => `Bare${i}`); // two chunks: 200 + 1
    let elevationRequests = 0;
    const fetchFn = async (url: string) => {
      if (url.includes('/sitemaps/')) return new Response(sitemapFor(slugs), { status: 200 });
      const slug = /\/breaks\/(Bare\d+)\//.exec(url)?.[1];
      if (slug) return new Response(blobFor(slug, -30 + Number(slug.slice(4)) * 0.1, 30), { status: 200 });
      if (url.includes('api.open-meteo.com/v1/elevation')) {
        elevationRequests++;
        return new Response('{"error":true,"reason":"Hourly API request limit exceeded. Please try again in the next hour."}', { status: 429 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const logs: string[] = [];
    await main(['--letters', 'M', '--out', out], { fetchFn, log: (l) => logs.push(l), sleep: async () => {} });

    const progress = JSON.parse(readFileSync(`${out}.progress.json`, 'utf8'));
    expect(Object.values(progress.processed)).toEqual(Array(201).fill({ status: 'skipped', reason: 'elevation-error' }));
    // Without the stop: 49 batches (48 for the first chunk's 4 800 ring points, 1 for the second), each retried once.
    expect(elevationRequests).toBeLessThanOrEqual(8); // at most the 4 batches already in flight, and their retries
    expect(logs.filter((l) => l.includes('Open-Meteo quota')).length).toBe(1);
  });

  describe('resilience (§report "Resilience, wiring and dedupe")', () => {
    it('a slug whose fetch rejects on every attempt does not discard the healthy slugs in the same run — main() resolves, the failure is counted', async () => {
      dir = mkdtempSync(join(tmpdir(), 'import-spots-test-'));
      const out = join(dir, 'spots-world.json');
      const fetchFn = async (url: string) => {
        if (url.includes('/sitemaps/')) return url.includes('/sitemaps/M-M.xml.gz') ? new Response(sitemapFor(['Healthy1', 'FlakySlug', 'Healthy2']), { status: 200 }) : new Response('', { status: 404 });
        if (url.includes('/breaks/FlakySlug/')) throw new Error('ECONNRESET');
        if (url.includes('/breaks/Healthy1/')) return new Response(blobFor('Healthy1', -1, 1), { status: 200 });
        if (url.includes('/breaks/Healthy2/')) return new Response(blobFor('Healthy2', -2, 2), { status: 200 });
        if (url.includes('api.open-meteo.com/v1/elevation')) return seaElevation(url);
        throw new Error(`unexpected fetch: ${url}`);
      };

      const logs: string[] = [];
      await main(['--letters', 'M', '--out', out], { fetchFn, log: (l) => logs.push(l), sleep: async () => {} });

      const tuples = JSON.parse(readFileSync(out, 'utf8')) as SpotTuple[];
      expect(tuples.map((t) => t[0]).sort()).toEqual(['Healthy1', 'Healthy2']);
      for (const t of tuples) expect(Number.isFinite(t[4])).toBe(true); // facing: a real number, never a stray object

      const progress = JSON.parse(readFileSync(`${out}.progress.json`, 'utf8'));
      expect(progress.processed.FlakySlug).toEqual({ status: 'skipped', reason: 'network-error' });
      expect(logs.join('\n')).toContain('network-error=1');
    });

    it('a persistently-5xx elevation endpoint never throws the run — every spot is skipped (elevation-error) and counted, not silently faced', async () => {
      dir = mkdtempSync(join(tmpdir(), 'import-spots-test-'));
      const out = join(dir, 'spots-world.json');
      const fetchFn = async (url: string) => {
        if (url.includes('/sitemaps/')) return url.includes('/sitemaps/M-M.xml.gz') ? new Response(sitemapFor(['Spot1', 'Spot2']), { status: 200 }) : new Response('', { status: 404 });
        if (url.includes('/breaks/Spot1/')) return new Response(blobFor('Spot1', -1, 1), { status: 200 });
        if (url.includes('/breaks/Spot2/')) return new Response(blobFor('Spot2', -2, 2), { status: 200 });
        if (url.includes('api.open-meteo.com/v1/elevation')) return new Response('boom', { status: 500 });
        throw new Error(`unexpected fetch: ${url}`);
      };

      const logs: string[] = [];
      await expect(main(['--letters', 'M', '--out', out], { fetchFn, log: (l) => logs.push(l), sleep: async () => {} })).resolves.toBeUndefined();

      const tuples = JSON.parse(readFileSync(out, 'utf8')) as SpotTuple[];
      expect(tuples).toEqual([]);

      const progress = JSON.parse(readFileSync(`${out}.progress.json`, 'utf8'));
      expect(progress.processed.Spot1).toEqual({ status: 'skipped', reason: 'elevation-error' });
      expect(progress.processed.Spot2).toEqual({ status: 'skipped', reason: 'elevation-error' });
      expect(logs.join('\n')).toContain('elevation-error=2');
    });

    it('a transient mid-run failure followed by --resume completes the job: the failed slug is retried and the output ends up whole', async () => {
      dir = mkdtempSync(join(tmpdir(), 'import-spots-test-'));
      const out = join(dir, 'spots-world.json');
      let bFetches = 0;

      const flakyFetchFn = async (url: string) => {
        if (url.includes('/sitemaps/')) return url.includes('/sitemaps/M-M.xml.gz') ? new Response(sitemapFor(['A', 'B', 'C']), { status: 200 }) : new Response('', { status: 404 });
        if (url.includes('/breaks/B/')) {
          bFetches++;
          throw new Error('ECONNRESET'); // B is down for the whole first run
        }
        if (url.includes('/breaks/A/')) return new Response(blobFor('A', -1, 1), { status: 200 });
        if (url.includes('/breaks/C/')) return new Response(blobFor('C', -3, 3), { status: 200 });
        if (url.includes('api.open-meteo.com/v1/elevation')) return seaElevation(url);
        throw new Error(`unexpected fetch: ${url}`);
      };
      await main(['--letters', 'M', '--out', out], { fetchFn: flakyFetchFn, log: () => {}, sleep: async () => {} });

      let firstRun = JSON.parse(readFileSync(out, 'utf8')) as SpotTuple[];
      expect(firstRun.map((t) => t[0]).sort()).toEqual(['A', 'C']); // B missing — the run still completed for the healthy two
      expect(bFetches).toBe(2); // fetchWithRetry's own built-in retry: 1 initial attempt + 1 retry, both rejecting

      // The transient issue is gone: this time every slug succeeds, including B.
      let aFetches = 0;
      const healedFetchFn = async (url: string) => {
        if (url.includes('/sitemaps/')) return url.includes('/sitemaps/M-M.xml.gz') ? new Response(sitemapFor(['A', 'B', 'C']), { status: 200 }) : new Response('', { status: 404 });
        if (url.includes('/breaks/A/')) {
          aFetches++;
          return new Response(blobFor('A', -1, 1), { status: 200 });
        }
        if (url.includes('/breaks/B/')) {
          bFetches++;
          return new Response(blobFor('B', -2, 2), { status: 200 });
        }
        if (url.includes('/breaks/C/')) return new Response(blobFor('C', -3, 3), { status: 200 });
        if (url.includes('api.open-meteo.com/v1/elevation')) return seaElevation(url);
        throw new Error(`unexpected fetch: ${url}`);
      };
      await main(['--letters', 'M', '--out', out, '--resume'], { fetchFn: healedFetchFn, log: () => {}, sleep: async () => {} });

      expect(aFetches).toBe(0); // A was already a resolved success — never re-fetched
      expect(bFetches).toBe(3); // 2 from the failed first run + 1 more on --resume, now succeeding first try

      const secondRun = JSON.parse(readFileSync(out, 'utf8')) as SpotTuple[];
      expect(secondRun.map((t) => t[0]).sort()).toEqual(['A', 'B', 'C']); // job completed: all three now present
    });
  });

  describe('world-vs-world dedupe (§report "Resilience, wiring and dedupe")', () => {
    it('two world spots under 200 m apart collapse to one (earliest by slug), even though neither is close to any curated spot', async () => {
      dir = mkdtempSync(join(tmpdir(), 'import-spots-test-'));
      const out = join(dir, 'spots-world.json');
      // Slug-sorted order is AdjacentA, AdjacentB — the writeOutput stable sort processes them in that
      // order, so AdjacentA (earlier) must be the one that survives.
      const center = { lat: -38.7325, lon: -9.4723 }; // Praia do Guincho, PT — far from every curated (ZA) spot
      const near = destinationPoint(center.lat, center.lon, 45, 0.08); // 80 m away — inside the 200 m default
      const fetchFn = async (url: string) => {
        if (url.includes('/sitemaps/')) {
          return url.includes('/sitemaps/A-A.xml.gz')
            ? new Response(sitemapFor(['AdjacentA', 'AdjacentB']), { status: 200 })
            : new Response('', { status: 404 });
        }
        if (url.includes('/breaks/AdjacentA/')) return new Response(blobFor('Adjacent A', center.lat, center.lon), { status: 200 });
        if (url.includes('/breaks/AdjacentB/')) return new Response(blobFor('Adjacent B', near.lat, near.lon), { status: 200 });
        if (url.includes('api.open-meteo.com/v1/elevation')) return seaElevation(url);
        throw new Error(`unexpected fetch: ${url}`);
      };

      const logs: string[] = [];
      await main(['--letters', 'A', '--out', out], { fetchFn, log: (l) => logs.push(l), sleep: async () => {} });

      const tuples = JSON.parse(readFileSync(out, 'utf8')) as SpotTuple[];
      expect(tuples.map((t) => t[0])).toEqual(['Adjacent A']); // the earlier-by-slug survivor, not both
      expect(logs.join('\n')).toContain('dropped 1 adjacent world spot(s) within 200 m of another world spot');
    });
  });
});
