/**
 * Calibration against surf-forecast.com, spot by spot, time slot by time slot.
 *
 *   npm run compare:sf                                  # every Cape Town spot that has a slug below
 *   npm run compare:sf -- --spots muizenberg,outer-kom  # a selection
 *   npm run compare:sf -- --out data/sf-compare.csv     # accumulation file (default)
 *   npm run compare:sf -- --dump-html tmp/              # saves each HTML page (to help adjust the parser)
 *   npm run compare:sf -- --from-html tmp/Muizenberg.html --spots muizenberg   # replays a saved page
 *
 * For each spot: the site's "hourly" table (every 3 h, ~2 days: rating, height, period,
 * energy, wind, wind state) is set side by side with what the engine computes on Open-Meteo at the same
 * times (swell at the regional point AND at the spot's cell, wind at the spot, the star rating the bot
 * displays, and for comparison the star rating the regional swell × exposure would have given).
 * The engine is called exactly the way `src/jobs/collect.ts` calls it. Each run APPENDS its rows to the
 * CSV: run every day for a few weeks, it provides material to recalibrate `exposure`,
 * the wind curves and the base rating, spot by spot and not just for Muizenberg.
 *
 * Pages fetched: only `/breaks/<slug>/forecasts/latest`, the same family of URL as the importer
 * (see the robots.txt note in scripts/import-spots.ts), with the same honest User-Agent.
 * One page per spot per run: nothing aggressive. The HTML parser was written from the text rendering
 * of the pages as of 16/09/2026: on the first run, check with --dump-html that it does find the rows.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchForecast, fetchMarine, fetchPeakPeriod } from '../src/adapters/openMeteo';
import type { FetchLike } from '../src/adapters/http';
import { REGIONS, SPOTS } from '../src/data/index';
import { nowLocal } from '../src/engine/time';
import { evaluateSpot } from '../src/engine/score';
import { effectiveSwell } from '../src/engine/swell';
import { computeTide } from '../src/engine/tide';
import { KT_TO_KMH, rateLikeSurfForecast, type WindState } from '../src/engine/rating';
import { mergePeakPeriod, spotSwellSeries } from '../src/jobs/collect';
import type { Spot, SwellHour } from '../src/types';
import { breakUrl } from './lib/breakPage';
import { fetchWithRetry } from './lib/httpRetry';
import { parseForecastTable } from './lib/forecastTable';
import { createFetch } from './lib/userAgentFetch';

// --- surf-forecast slugs for the curated spots (the site's Cape Town region, recorded on 16/09/2026) --------
// Deliberately absent: strandfontein (no equivalent break, "Monwabisi Strand" is elsewhere),
// kogel-bay and strand (the site's Overberg region, to verify), and the regions outside Cape Town.
export const SF_SLUGS: Record<string, string> = {
  muizenberg: 'Muizenberg',
  clovelly: 'Clovelly-1',
  'kalk-bay-reef': 'Kalk-Bay-Reef',
  noordhoek: 'Noordhoek',
  'kommetjie-long-beach': 'Long-Beach_2',
  'inner-kom': 'Inner-Kom',
  'outer-kom': 'Outer-Kom_1',
  'crayfish-factory': 'Crayfish-Factory',
  scarborough: 'Scarborough-Beach',
  llandudno: 'Llandudno_1',
  'glen-beach': 'Bali-Bay', // "Bali Bay (Glen Reef)" on the site: the reef, not the beach — to confirm
  'big-bay': 'Big-Bay',
  derdesteen: 'Derde-Steen',
  'sunset-beach': 'Sunset-Beach_2',
  'fish-hoek': 'Fish-Hoek',
  glencairn: 'Glencairn',
  witsands: 'Witsands',
};

// --- "hourly" table parser: scripts/lib/forecastTable.ts (shared with the spot importer) ----

export { parseForecastTable, type SfSlot } from './lib/forecastTable';

// --- bot side: same hours, Open-Meteo data ---------------------------------------------------

interface BotHour {
  regionH: number; regionDir: number; regionT: number;
  spotH: number; spotDir: number; spotT: number;
  windKt: number; windDir: number; gustKt: number;
  /** the swell directed toward the spot that the engine rated — the one in the message */
  botH: number; score: number;
  starsSpot: number; cleanSpot: boolean; stateSpot: WindState;
  starsRegionExposure: number;
}

async function botHours(spot: Spot, fetchFn: FetchLike): Promise<Map<string, BotHour>> {
  const region = REGIONS.find((r) => r.id === spot.region);
  if (!region) throw new Error(`unknown region ${spot.region}`);
  const [[regional, atSpot], [forecast], peak] = await Promise.all([
    fetchMarine([region.swellRef, spot], fetchFn),
    fetchForecast([spot], fetchFn, { forecastDays: 3 }),
    fetchPeakPeriod([region.swellRef], fetchFn, { retries: 0 }).catch(() => null),
  ]);
  // same series as `collect.ts`: merged regional peak period, regional × exposure fallback if the cell is empty
  const withPeak = (series: SwellHour[]): SwellHour[] => (peak ? mergePeakPeriod(series, peak[0]) : series);
  const regionSwell = withPeak(regional);
  const spotSwell = withPeak(spotSwellSeries(atSpot, regional, spot.exposure));
  const rawSpotByTime = new Map(atSpot.map((h) => [h.time, h]));
  const regionByTime = new Map(regionSwell.map((h) => [h.time, h]));
  const windByTime = new Map(forecast.wind.map((h) => [h.time, h]));
  const out = new Map<string, BotHour>();
  const dates = [...new Set(forecast.wind.map((h) => h.time.slice(0, 10)))];
  for (const date of dates) {
    const daily = forecast.daily.find((d) => d.date === date);
    if (!daily) continue;
    const result = evaluateSpot({
      spot, date, swell: spotSwell, wind: forecast.wind,
      sun: { sunrise: daily.sunrise, sunset: daily.sunset }, tide: computeTide(regionSwell, date), distanceKm: 0,
    });
    for (const h of result.hours) {
      const none = { heightM: 0, periodS: 0, directionDeg: 0 };
      const raw = rawSpotByTime.get(h.time);
      const spotEff = raw ? effectiveSwell(raw, spot.swellWindow) : none;
      const regionHour = regionByTime.get(h.time);
      const regionEff = regionHour ? effectiveSwell(regionHour, spot.swellWindow) : none;
      const viaExposure = rateLikeSurfForecast({ heightM: regionEff.heightM * spot.exposure, periodS: regionEff.periodS, windKt: h.windKt, windFromDeg: h.windDirDeg, facingDeg: spot.facing });
      out.set(h.time, {
        regionH: regionEff.heightM, regionDir: regionEff.directionDeg, regionT: regionEff.periodS,
        spotH: spotEff.heightM, spotDir: spotEff.directionDeg, spotT: spotEff.periodS,
        windKt: h.windKt, windDir: h.windDirDeg, gustKt: windByTime.get(h.time)?.gustKt ?? 0,
        botH: h.heightM, score: h.score,
        starsSpot: h.stars, cleanSpot: h.clean, stateSpot: h.windState,
        starsRegionExposure: viaExposure.stars,
      });
    }
  }
  return out;
}

// --- CLI -------------------------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v !== undefined && !v.startsWith('--') ? v : undefined;
}

const HEADER = [
  'run_at', 'spot', 'slug', 'time',
  'sf_rating', 'sf_h_m', 'sf_dir', 'sf_t_s', 'sf_kj', 'sf_wind_kmh', 'sf_wind_dir', 'sf_state',
  'om_region_h_m', 'om_region_dir', 'om_region_t_s', 'om_spot_h_m', 'om_spot_dir', 'om_spot_t_s',
  'om_wind_kmh', 'om_wind_dir', 'om_gust_kmh',
  'bot_h_m', 'bot_score', 'bot_state', 'bot_stars_spot', 'bot_clean_spot', 'bot_stars_region_exposure',
].join(',');

const r1 = (x: number): string => (Math.round(x * 10) / 10).toString();

async function main(): Promise<void> {
  const out = arg('out') ?? 'data/sf-compare.csv';
  const dump = arg('dump-html');
  const fromHtml = arg('from-html');
  const wanted = arg('spots')?.split(',').map((s) => s.trim()).filter(Boolean);
  const spots = SPOTS.filter((s) => SF_SLUGS[s.id] && (!wanted || wanted.includes(s.id)));
  if (spots.length === 0) {
    console.error(`no spot to compare (known slugs: ${Object.keys(SF_SLUGS).join(', ')})`);
    process.exit(1);
  }
  const fetchFn = createFetch();
  const runAt = nowLocal();
  const lines: string[] = [];
  const summary: string[] = [];

  for (const [index, spot] of spots.entries()) {
    // one page at a time, no burst of requests to the site — even when the previous page failed
    if (index > 0 && !fromHtml) await new Promise((r) => setTimeout(r, 1500));
    const slug = SF_SLUGS[spot.id];
    let html: string;
    if (fromHtml) {
      html = readFileSync(fromHtml, 'utf8');
    } else {
      const res = await fetchWithRetry(breakUrl(slug), fetchFn);
      if (!res.ok) { console.error(`${spot.id}: HTTP ${res.status} on ${breakUrl(slug)}`); continue; }
      html = await res.text();
      if (dump) { mkdirSync(dump, { recursive: true }); writeFileSync(join(dump, `${slug}.html`), html); }
    }
    const sf = parseForecastTable(html);
    if (sf.length === 0) { console.error(`${spot.id}: no table found in the page (${html.length} bytes) — use --dump-html and adjust parseForecastTable`); continue; }
    const bot = await botHours(spot, fetchFn);

    let n = 0; let absSpot = 0; let absExp = 0; let absH = 0; let absWind = 0; let sameState = 0; let sfSum = 0; let botSum = 0;
    for (const s of sf) {
      const b = bot.get(s.time);
      if (!b) continue;
      lines.push([
        runAt, spot.id, slug, s.time,
        s.rating ?? '!', s.heightM, s.dir, s.periodS, s.energyKJ, s.windKmh, s.windDir, s.state,
        r1(b.regionH), Math.round(b.regionDir), r1(b.regionT), r1(b.spotH), Math.round(b.spotDir), r1(b.spotT),
        r1(b.windKt * KT_TO_KMH), Math.round(b.windDir), r1(b.gustKt * KT_TO_KMH),
        r1(b.botH), b.score, b.stateSpot, b.starsSpot, b.cleanSpot, b.starsRegionExposure,
      ].join(','));
      if (s.rating === null) continue;
      n++;
      absSpot += Math.abs(s.rating - b.starsSpot);
      absExp += Math.abs(s.rating - b.starsRegionExposure);
      absH += Math.abs(s.heightM - b.spotH);
      absWind += Math.abs(s.windKmh - b.windKt * KT_TO_KMH);
      if (s.state === b.stateSpot) sameState++;
      sfSum += s.rating; botSum += b.starsSpot;
    }
    if (n === 0) { summary.push(`${spot.id.padEnd(22)} no shared hour (${sf.length} site slots, ${bot.size} bot hours)`); continue; }
    summary.push(
      `${spot.id.padEnd(22)} n=${String(n).padStart(2)}  site ${r1(sfSum / n)} vs bot ${r1(botSum / n)} stars` +
      `  MAE stars (swell at the spot) ${r1(absSpot / n)}  (region×exposure) ${r1(absExp / n)}` +
      `  |ΔH| ${r1(absH / n)} m  |Δwind| ${r1(absWind / n)} km/h  same wind state ${Math.round((100 * sameState) / n)}%`,
    );
  }

  if (lines.length > 0) {
    mkdirSync(dirname(out), { recursive: true });
    if (!existsSync(out)) writeFileSync(out, `${HEADER}\n`);
    appendFileSync(out, `${lines.join('\n')}\n`);
  }
  console.log(`\n# surf-forecast comparison · ${runAt} · ${lines.length} lines appended to ${out}\n`);
  console.log(summary.join('\n'));
}

// Run directly (tsx scripts/compare-surf-forecast.ts), not when a test imports the parser.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
