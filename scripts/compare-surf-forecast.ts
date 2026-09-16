/**
 * Calibration contre surf-forecast.com, spot par spot, créneau par créneau.
 *
 *   npm run compare:sf                                  # tous les spots du Cap qui ont un slug ci-dessous
 *   npm run compare:sf -- --spots muizenberg,outer-kom  # une sélection
 *   npm run compare:sf -- --out data/sf-compare.csv     # fichier d'accumulation (défaut)
 *   npm run compare:sf -- --dump-html tmp/              # sauve chaque page HTML (pour adapter le parseur)
 *   npm run compare:sf -- --from-html tmp/Muizenberg.html --spots muizenberg   # rejoue une page sauvée
 *
 * Pour chaque spot : la table « hourly » du site (3 h par 3 h, ~2 jours : note, hauteur, période,
 * énergie, vent, état du vent) est mise en face de ce que le moteur calcule sur Open-Meteo aux mêmes
 * heures (houle au point régional ET à la cellule du spot, vent au spot, les étoiles que le bot
 * affiche, et à titre de comparaison les étoiles qu'aurait données la houle régionale × exposure).
 * Le moteur est appelé exactement comme `src/jobs/collect.ts` l'appelle. Chaque run AJOUTE ses lignes au
 * CSV : lancé tous les jours pendant quelques semaines, il donne la matière pour recaler `exposure`,
 * les courbes de vent et la note de base, spot par spot et pas seulement sur Muizenberg.
 *
 * Pages lues : uniquement `/breaks/<slug>/forecasts/latest`, la même famille d'URL que l'importeur
 * (voir la note robots.txt dans scripts/import-spots.ts), avec le même User-Agent honnête.
 * Une page par spot et par run : rien d'agressif. Le parseur HTML a été écrit d'après le rendu texte
 * des pages du 16/09/2026 : au premier run, vérifier avec --dump-html qu'il trouve bien les lignes.
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
import { createFetch } from './lib/userAgentFetch';

// --- slugs surf-forecast des spots curatés (région Cape Town du site, relevés le 16/09/2026) --------
// Absents volontairement : strandfontein (pas de break équivalent, « Monwabisi Strand » est ailleurs),
// kogel-bay et strand (région Overberg du site, à vérifier), et les régions hors Cap.
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
  'glen-beach': 'Bali-Bay', // « Bali Bay (Glen Reef) » sur le site : le récif, pas la plage — à confirmer
  'big-bay': 'Big-Bay',
  derdesteen: 'Derde-Steen',
  'sunset-beach': 'Sunset-Beach_2',
  'fish-hoek': 'Fish-Hoek',
  glencairn: 'Glencairn',
  witsands: 'Witsands',
};

// --- parseur de la table « hourly » ---------------------------------------------------------------

export interface SfSlot {
  /** 'YYYY-MM-DDTHH:00', heure locale du spot */
  time: string;
  /** null quand le site affiche « ! » (très gros / dangereux) */
  rating: number | null;
  heightM: number;
  dir: string;
  periodS: number;
  energyKJ: number;
  windKmh: number;
  windDir: string;
  state: WindState;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const text = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

interface Cell { text: string; colspan: number }

function rowsOf(html: string): Cell[][] {
  const rows: Cell[][] = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: Cell[] = [];
    for (const td of tr[1].matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi)) {
      const colspan = Number(/colspan\s*=\s*["']?(\d+)/i.exec(td[2])?.[1] ?? 1);
      cells.push({ text: text(td[3]), colspan });
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

const STATE_MAP: Record<string, WindState> = {
  glassy: 'glassy', off: 'off', 'cross-off': 'cross-off', cross: 'cross', 'cross-on': 'cross-on', on: 'on',
  'off-shore': 'off', 'on-shore': 'on', 'cross-shore': 'cross', 'cross-offshore': 'cross-off', 'cross-onshore': 'cross-on',
};

/** Date d'émission « Issued: 7 am 16 Sep 2026 » → { day, month (0..11), year }. */
function issuedDate(html: string): { day: number; month: number; year: number } | null {
  const m = /Issued:[\s\S]{0,80}?(\d{1,2})\s*(?:am|pm)\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/i.exec(html);
  if (!m) return null;
  const month = MONTHS.indexOf(m[3].toLowerCase());
  return month < 0 ? null : { day: Number(m[2]), month, year: Number(m[4]) };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function parseForecastTable(html: string, fallbackNow = new Date()): SfSlot[] {
  const rows = rowsOf(html);
  const dayRow = rows.find((r) => r.filter((c) => /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+\d{1,2}$/i.test(c.text)).length >= 1);
  const timeRow = rows.find((r) => r.filter((c) => /^\d{1,2}\s*(am|pm)$/i.test(c.text)).length >= 2);
  if (!dayRow || !timeRow) return [];

  // colonnes horaires
  const times = timeRow.filter((c) => /^\d{1,2}\s*(am|pm)$/i.test(c.text)).map((c) => {
    const m = /^(\d{1,2})\s*(am|pm)$/i.exec(c.text)!;
    let h = Number(m[1]) % 12;
    if (m[2].toLowerCase() === 'pm') h += 12;
    return h;
  });

  // colonnes → jour du mois, en déroulant les colspan de la ligne des jours
  const issued = issuedDate(html);
  let month = issued?.month ?? fallbackNow.getMonth();
  let year = issued?.year ?? fallbackNow.getFullYear();
  let prevDay = issued?.day ?? fallbackNow.getDate();
  const dates: string[] = [];
  for (const c of dayRow) {
    const m = /^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+(\d{1,2})$/i.exec(c.text);
    if (!m) continue;
    const day = Number(m[1]);
    if (day < prevDay) {
      month += 1;
      if (month > 11) { month = 0; year += 1; }
    }
    prevDay = day;
    for (let i = 0; i < c.colspan; i++) dates.push(`${year}-${pad2(month + 1)}-${pad2(day)}`);
  }
  const n = Math.min(times.length, dates.length);
  if (n === 0) return [];

  const lastN = (r: Cell[]): string[] => r.slice(-n).map((c) => c.text);
  const findRow = (test: (label: string) => boolean): string[] | undefined => {
    const r = rows.find((row) => row.length > n && test(row[0].text.toLowerCase()));
    return r ? lastN(r) : undefined;
  };
  const rating = findRow((l) => l.startsWith('rating'));
  const wave = findRow((l) => l.startsWith('wave') && l.includes('height'));
  const energy = findRow((l) => l.includes('kj'));
  const wind = findRow((l) => l.startsWith('wind (') || l.startsWith('wind('));
  const state = findRow((l) => l.startsWith('wind state'));
  if (!rating || !wave || !wind || !state) return [];

  const slots: SfSlot[] = [];
  for (let i = 0; i < n; i++) {
    const w = /^(\d+(?:\.\d+)?)\s+([NESW]{1,3})\s+(\d+)/i.exec(wave[i]);
    const v = /^(\d+)\s+([NESW]{1,3})/i.exec(wind[i]);
    const st = STATE_MAP[state[i].toLowerCase().replace(/\s+/g, '-')];
    if (!w || !v || !st) continue;
    const r = rating[i].trim();
    slots.push({
      time: `${dates[i]}T${pad2(times[i])}:00`,
      rating: /^\d+$/.test(r) ? Number(r) : null,
      heightM: Number(w[1]), dir: w[2].toUpperCase(), periodS: Number(w[3]),
      energyKJ: energy ? Number(energy[i]) || 0 : 0,
      windKmh: Number(v[1]), windDir: v[2].toUpperCase(), state: st,
    });
  }
  return slots;
}

// --- côté bot : mêmes heures, données Open-Meteo ---------------------------------------------------

interface BotHour {
  regionH: number; regionDir: number; regionT: number;
  spotH: number; spotDir: number; spotT: number;
  windKt: number; windDir: number; gustKt: number;
  /** la houle dirigée vers le spot que le moteur a notée — celle du message */
  botH: number; score: number;
  starsSpot: number; cleanSpot: boolean; stateSpot: WindState;
  starsRegionExposure: number;
}

async function botHours(spot: Spot, fetchFn: FetchLike): Promise<Map<string, BotHour>> {
  const region = REGIONS.find((r) => r.id === spot.region);
  if (!region) throw new Error(`région inconnue ${spot.region}`);
  const [[regional, atSpot], [forecast], peak] = await Promise.all([
    fetchMarine([region.swellRef, spot], fetchFn),
    fetchForecast([spot], fetchFn, { forecastDays: 3 }),
    fetchPeakPeriod([region.swellRef], fetchFn, { retries: 0 }).catch(() => null),
  ]);
  // mêmes séries que `collect.ts` : période pic régionale fusionnée, repli régional × exposure si la cellule est vide
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
    console.error(`aucun spot à comparer (slugs connus : ${Object.keys(SF_SLUGS).join(', ')})`);
    process.exit(1);
  }
  const fetchFn = createFetch();
  const runAt = nowLocal();
  const lines: string[] = [];
  const summary: string[] = [];

  for (const [index, spot] of spots.entries()) {
    // une page à la fois, pas de rafale sur le site — y compris quand la page précédente a échoué
    if (index > 0 && !fromHtml) await new Promise((r) => setTimeout(r, 1500));
    const slug = SF_SLUGS[spot.id];
    let html: string;
    if (fromHtml) {
      html = readFileSync(fromHtml, 'utf8');
    } else {
      const res = await fetchWithRetry(breakUrl(slug), fetchFn);
      if (!res.ok) { console.error(`${spot.id}: HTTP ${res.status} sur ${breakUrl(slug)}`); continue; }
      html = await res.text();
      if (dump) { mkdirSync(dump, { recursive: true }); writeFileSync(join(dump, `${slug}.html`), html); }
    }
    const sf = parseForecastTable(html);
    if (sf.length === 0) { console.error(`${spot.id}: table introuvable dans la page (${html.length} octets) — utiliser --dump-html et adapter parseForecastTable`); continue; }
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
    if (n === 0) { summary.push(`${spot.id.padEnd(22)} aucune heure commune (${sf.length} créneaux site, ${bot.size} heures bot)`); continue; }
    summary.push(
      `${spot.id.padEnd(22)} n=${String(n).padStart(2)}  site ${r1(sfSum / n)} vs bot ${r1(botSum / n)} étoiles` +
      `  MAE étoiles (houle au spot) ${r1(absSpot / n)}  (région×exposure) ${r1(absExp / n)}` +
      `  |ΔH| ${r1(absH / n)} m  |Δvent| ${r1(absWind / n)} km/h  même état vent ${Math.round((100 * sameState) / n)} %`,
    );
  }

  if (lines.length > 0) {
    mkdirSync(dirname(out), { recursive: true });
    if (!existsSync(out)) writeFileSync(out, `${HEADER}\n`);
    appendFileSync(out, `${lines.join('\n')}\n`);
  }
  console.log(`\n# comparaison surf-forecast · ${runAt} · ${lines.length} lignes ajoutées à ${out}\n`);
  console.log(summary.join('\n'));
}

// Lancé directement (tsx scripts/compare-surf-forecast.ts), pas quand un test importe le parseur.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
