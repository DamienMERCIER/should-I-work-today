import type { InlineButton, ReplyMarkup } from '../adapters/telegram';
import { FAR_FROM_COAST_KM } from '../config';
import type { Delta } from '../engine/delta';
import { cardinal8 } from '../engine/geo';
import { isWeekend, toMs } from '../engine/time';
import { primaryPick } from '../engine/verdict';
import type { HourFactors, Lang, Report, Spot, SpotHour, SpotPick, SpotResult, Window } from '../types';
import { chartHours, hourRuler, sparkline } from './chart';
import { fill, STRINGS, type Strings } from './i18n';

export interface RenderCtx { lang: Lang; spots: Map<string, Spot> }

export const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 'HH:MM' or 'YYYY-MM-DDTHH:mm' → '7:00' / '9:40'. */
export function fmtTime(t: string): string {
  const hhmm = t.length > 5 ? t.slice(11, 16) : t;
  const [h, m] = hhmm.split(':');
  const hour = String(Number(h));
  return `${hour}:${m}`;
}

export function fmtDate(date: string, lang: Lang): string {
  return new Intl.DateTimeFormat(STRINGS[lang].locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(toMs(`${date}T00:00`)));
}

export const fmtWindow = (w: Window): string => `${fmtTime(w.start)}–${fmtTime(w.end)}`;

const score1 = (x: number): string => x.toFixed(1);
const cardinal = (deg: number, s: Strings): string => s.cardinal[cardinal8(deg)];

export function spotName(id: string, ctx: RenderCtx, s: Strings): string {
  const spot = ctx.spots.get(id);
  if (!spot) return esc(id);
  return esc(spot.name);
}

/** Same `≈` rule as `spotName`, but the short (≤ 13 char) label used on the day view's secondary rows. */
function spotShort(id: string, ctx: RenderCtx, s: Strings): string {
  const spot = ctx.spots.get(id);
  if (!spot) return esc(id);
  return esc(spot.short);
}

const hoursIn = (r: SpotResult, w: Window): SpotHour[] => r.hours.filter((h) => h.time >= w.start && h.time < w.end);

function peakHour(r: SpotResult, w?: Window): SpotHour | undefined {
  const hours = w ? hoursIn(r, w) : r.hours;
  return [...hours].sort((a, b) => b.score - a.score)[0];
}

function ftRange(hours: SpotHour[]): string {
  const fts = hours.map((h) => Math.round(h.faceFt));
  const min = Math.min(...fts);
  const max = Math.max(...fts);
  return min === max ? String(min) : `${min}–${max}`;
}

const relationText = (h: SpotHour, s: Strings): string => (h.windKt < 5 ? s.glassy : s.relations[h.windRelation]);

function windText(h: SpotHour, s: Strings): string {
  if (h.windKt < 5) return s.glassy;
  return `${s.relations[h.windRelation]} ${cardinal(h.windDirDeg, s)} ${Math.round(h.windKt)} kt`;
}

/** Vent à l'heure du pic, « puis <relation> » si la fin de fenêtre diffère. */
function windSummary(r: SpotResult, w: Window, s: Strings): string {
  const hours = hoursIn(r, w);
  const peak = peakHour(r, w);
  const last = hours[hours.length - 1];
  if (!peak || !last) return '';
  const base = windText(peak, s);
  return relationText(last, s) !== relationText(peak, s) ? `${base} ${s.then} ${relationText(last, s)}` : base;
}

function tideText(report: Report, h: SpotHour, s: Strings): string {
  const trend = s.tideTrends[h.tide.trend];
  const next = report.tides.find((e) => e.time >= h.time);
  return next ? `${trend}, ${fill(s.tideNext[next.kind], { time: fmtTime(next.time) })}` : trend;
}

function conditionsLine(r: SpotResult, w: Window, report: Report, s: Strings): string {
  const peak = peakHour(r, w);
  if (!peak) return '';
  return fill(s.spotLine.conditions, {
    ft: ftRange(hoursIn(r, w)), dir: cardinal(peak.swellDirDeg, s), s: Math.round(peak.periodS),
    wind: windSummary(r, w, s), tide: tideText(report, peak, s),
  });
}

function sunLine(report: Report, s: Strings): string {
  const base = fill(s.spotLine.sun, { temp: Math.round(report.weather.tempMaxC), sunrise: fmtTime(report.sun.sunrise) });
  return report.weather.precipMm >= 1 ? `${base} · ${fill(s.rain, { mm: Math.round(report.weather.precipMm) })}` : base;
}

function primaryBlock(pick: SpotPick, report: Report, ctx: RenderCtx, s: Strings): string[] {
  const r = report.spots.find((x) => x.spotId === pick.spotId);
  const lines = [`🏄 ${spotName(pick.spotId, ctx, s)} · ${fmtWindow(pick.window)} · ${score1(pick.window.peak)}/10`];
  if (r) lines.push(`   ${conditionsLine(r, pick.window, report, s)}`);
  lines.push(`   ${sunLine(report, s)}`);
  return lines;
}

function runnerUp(report: Report, excludeId: string, ctx: RenderCtx, s: Strings): string[] {
  const r = report.spots
    .filter((x) => x.open && x.spotId !== excludeId && x.best)
    .sort((a, b) => (b.best?.peak ?? 0) - (a.best?.peak ?? 0))[0];
  if (!r?.best) return [];
  return [
    `🥈 ${spotName(r.spotId, ctx, s)} · ${fmtWindow(r.best)} · ${score1(r.best.peak)}/10`,
    `   ${ftRange(hoursIn(r, r.best))} ft · ${windSummary(r, r.best, s)}`,
  ];
}

const dateVars = (report: Report, ctx: RenderCtx): { date: string } => ({ date: fmtDate(report.date, ctx.lang) });

function greenTitle(report: Report, epic: boolean, ctx: RenderCtx, s: Strings): string {
  const base = report.mode === 'now'
    ? s.verdict.greenNow
    : isWeekend(report.date) ? fill(s.verdict.greenWeekend, dateVars(report, ctx)) : fill(s.verdict.green, dateVars(report, ctx));
  return epic ? `${base}${s.verdict.greenEpicSuffix}` : base;
}

function redTitle(report: Report, ctx: RenderCtx, s: Strings): string {
  if (report.mode === 'now') return s.verdict.redNow;
  return isWeekend(report.date) ? fill(s.verdict.redWeekend, dateVars(report, ctx)) : fill(s.verdict.red, dateVars(report, ctx));
}

/** Le facteur le plus bas à l'heure du meilleur score → raison affichée sur un 🔴. */
function lowestFactorReason(r: SpotResult, s: Strings): string {
  const h = peakHour(r);
  if (!h) return s.reasons.dark;
  const ranked: [keyof HourFactors, number][] = [
    ['day', h.factors.day], ['wind', h.factors.wind], ['size', h.factors.size], ['period', h.factors.period], ['tide', h.factors.tide],
  ];
  const [key] = ranked.sort((a, b) => a[1] - b[1])[0];
  switch (key) {
    case 'day':
      return s.reasons.dark;
    case 'wind':
      return fill(s.reasons.wind, { relation: s.relations[h.windRelation], dir: cardinal(h.windDirDeg, s), kt: Math.round(h.windKt) });
    case 'size':
      return fill(s.reasons.size, { ft: h.faceFt.toFixed(1) });
    case 'period':
      return fill(s.reasons.period, { s: Math.round(h.periodS) });
    default:
      return fill(s.reasons.tide, { state: s.tideStates[h.tide.state] });
  }
}

export function renderEvening(report: Report, ctx: RenderCtx): string {
  const s = STRINGS[ctx.lang];
  const v = report.verdict;
  const lines: string[] = [];
  switch (v.kind) {
    case 'green':
      lines.push(greenTitle(report, v.epic, ctx, s), ...primaryBlock({ spotId: v.spotId, window: v.window }, report, ctx, s), ...runnerUp(report, v.spotId, ctx, s));
      break;
    case 'yellow':
      if (v.dawn) lines.push(fill(s.verdict.dawn, dateVars(report, ctx)), ...primaryBlock(v.dawn, report, ctx, s));
      if (v.dusk) lines.push(fill(s.verdict.dusk, dateVars(report, ctx)), ...primaryBlock(v.dusk, report, ctx, s));
      break;
    case 'red': {
      lines.push(redTitle(report, ctx, s), fill(s.verdict.redBody, { radius: report.radiusKm }));
      const best = v.bestSpotId ? report.spots.find((x) => x.spotId === v.bestSpotId) : undefined;
      if (best) lines.push(fill(s.verdict.redBest, { spot: spotName(best.spotId, ctx, s), score: score1(best.maxScore), reason: lowestFactorReason(best, s) }));
      break;
    }
    case 'outOfCoverage':
      lines.push(fill(s.coverage.none, { radius: report.radiusKm }));
      if (v.raw) {
        lines.push(fill(s.coverage.raw, {
          swell: v.raw.swellHeightM.toFixed(1), s: Math.round(v.raw.periodS), dir: cardinal(v.raw.swellDirDeg, s),
          kt: Math.round(v.raw.windKt), windDir: cardinal(v.raw.windDirDeg, s),
        }));
      } else {
        lines.push(fill(s.coverage.farFromCoast, { km: FAR_FROM_COAST_KM }));
      }
      if (v.nearest.length > 0) {
        lines.push(fill(s.coverage.nearest, { list: v.nearest.map((n) => fill(s.coverage.nearestItem, { spot: spotName(n.spotId, ctx, s), km: Math.round(n.distanceKm) })).join(', ') }));
      }
      break;
    case 'noData':
      lines.push(s.noData);
      break;
  }
  return lines.join('\n');
}

export function renderShortVerdict(report: Report | undefined, ctx: RenderCtx): string {
  const s = STRINGS[ctx.lang];
  const v = report?.verdict;
  if (!v) return s.shortVerdict.red;
  const pickText = (template: string, pick: SpotPick): string =>
    fill(template, { spot: spotName(pick.spotId, ctx, s), window: fmtWindow(pick.window) });
  switch (v.kind) {
    case 'green':
      return pickText(s.shortVerdict.green, { spotId: v.spotId, window: v.window });
    case 'yellow':
      return [v.dawn && pickText(s.shortVerdict.dawn, v.dawn), v.dusk && pickText(s.shortVerdict.dusk, v.dusk)].filter(Boolean).join(' · ');
    default:
      return s.shortVerdict.red;
  }
}

export function renderMorning(morning: Report, delta: Delta, evening: Report | undefined, ctx: RenderCtx): string {
  const s = STRINGS[ctx.lang];
  if (morning.verdict.kind === 'noData') return fill(s.morning.noDataKeep, { verdict: renderShortVerdict(evening, ctx) });
  if (!delta.changed) return fill(s.morning.confirmed, { verdict: renderShortVerdict(morning, ctx) });
  const lines = [fill(s.morning.changed, { from: renderShortVerdict(evening, ctx), to: renderShortVerdict(morning, ctx) })];
  const pick = primaryPick(morning.verdict);
  const r = pick ? morning.spots.find((x) => x.spotId === pick.spotId) : undefined;
  if (pick && r) lines.push(conditionsLine(r, pick.window, morning, s));
  if (delta.cause) lines.push(fill(s.morning.cause, { cause: s.causes[delta.cause] }));
  return lines.join('\n');
}

// ---- 📋 day view: a chart of the day per spot, replacing the old flat one-snapshot-per-row list ----
// Full rationale, glyph/ruler rules and worked examples: .superpowers/sdd/day-view.md

/** This spot's hours, indexed by the report date, one slot per plotted hour (undefined = no data that hour). */
function alignedHours(r: SpotResult, date: string, hours: number[]): (SpotHour | undefined)[] {
  const byTime = new Map(r.hours.map((h) => [h.time, h] as const));
  return hours.map((h) => byTime.get(`${date}T${String(h).padStart(2, '0')}:00`));
}

/** Wind for the day view: relation/direction from the peak hour, kt as a range across every plotted hour. */
function windRangeText(plotted: SpotHour[], peak: SpotHour, s: Strings): string {
  if (peak.windKt < 5) return s.glassy;
  const kts = plotted.length > 0 ? plotted.map((h) => h.windKt) : [peak.windKt];
  const lo = Math.round(Math.min(...kts));
  const hi = Math.round(Math.max(...kts));
  const base = `${s.relations[peak.windRelation]} ${cardinal(peak.windDirDeg, s)}`;
  return lo === hi ? `${base} ${lo} kt` : `${base} ${lo}→${hi} kt`;
}

type ExplainKey = 'wind' | 'tide' | 'size' | 'period' | 'day';
/** best-at: factors that can be favourable *or* not — size/period rarely swing, but wind & tide do. */
const BEST_KEYS: readonly ExplainKey[] = ['wind', 'tide', 'size', 'period'];
/** fades-from: no "size drops"/"period shortens" phrase exists, so only wind, tide and daylight explain a fade. */
const FADE_KEYS: readonly ExplainKey[] = ['wind', 'tide', 'day'];

function spreadOf(hours: SpotHour[], key: ExplainKey): number {
  if (hours.length === 0) return 0;
  const values = hours.map((h) => h.factors[key]);
  return Math.max(...values) - Math.min(...values);
}

function phraseFor(key: ExplainKey, h: SpotHour, direction: 'best' | 'fade', s: Strings): string {
  const r = s.dayView.reasons;
  switch (key) {
    case 'wind':
      if (h.windKt < 5) return s.glassy;
      return fill(direction === 'best' ? r.windDrops : r.windBuilds, { kt: Math.round(h.windKt) });
    case 'tide':
      return h.tide.state === 'high' ? r.tideStillHigh : h.tide.state === 'low' ? r.tideLow : r.tideMid;
    case 'size':
      return fill(r.sizePeaks, { ft: Math.round(h.faceFt) });
    case 'period':
      return fill(r.groundswell, { s: Math.round(h.periodS) });
    case 'day':
      return r.getsDark;
  }
}

/** Factors at the peak hour that are favourable (≥ 0.9) *and* meaningfully lower elsewhere (spread ≥ 0.15). */
function bestReasons(peak: SpotHour, plotted: SpotHour[], s: Strings): string[] {
  return BEST_KEYS.filter((k) => peak.factors[k] >= 0.9 && spreadOf(plotted, k) >= 0.15)
    .sort((a, b) => spreadOf(plotted, b) - spreadOf(plotted, a))
    .slice(0, 2)
    .map((k) => phraseFor(k, peak, 'best', s));
}

/** First hour after the peak (anywhere in the spot's day, not just the plotted range — dusk included) below 60 % of it. */
function fadeHourAfter(hours: SpotHour[], peak: SpotHour): SpotHour | undefined {
  const threshold = 0.6 * peak.score;
  return hours.find((h) => h.time > peak.time && h.score < threshold);
}

/** Factors that dropped the most from the peak to the fade hour, phrased from their value at the fade hour. */
function fadeReasons(peak: SpotHour, fade: SpotHour, s: Strings): string[] {
  return FADE_KEYS.map((k) => ({ k, drop: peak.factors[k] - fade.factors[k] }))
    .filter((x) => x.drop > 0)
    .sort((a, b) => b.drop - a.drop)
    .slice(0, 2)
    .map((x) => phraseFor(x.k, fade, 'fade', s));
}

/** The two explanation lines (§3 day-view.md) — silent (returns []) on a flat day rather than inventing a story. */
function explanationLines(r: SpotResult, peak: SpotHour, plotted: SpotHour[], s: Strings): string[] {
  const lines: string[] = [];
  const best = bestReasons(peak, plotted, s);
  if (best.length > 0) lines.push(fill(s.dayView.bestAt, { time: fmtTime(peak.time), reasons: best.join(', ') }));
  const fade = fadeHourAfter(r.hours, peak);
  if (fade) {
    const reasons = fadeReasons(peak, fade, s);
    if (reasons.length > 0) lines.push(fill(s.dayView.fadesFrom, { time: fmtTime(fade.time), reasons: reasons.join(', ') }));
  }
  return lines;
}

/**
 * The detailed chart block for one spot: title (+ its best window, if any), ruler + sparkline in `<code>` lines
 * block, then the peak/conditions/explanation lines. Works with no window (skips peak/best-at/fades-from,
 * keeps the chart and conditions) and for a spot closed at the user's level (chart of zeros, says so) —
 * also called directly by the follow-up `/spot` command.
 */
export function renderSpotDay(report: Report, spotId: string, ctx: RenderCtx): string {
  const s = STRINGS[ctx.lang];
  const r = report.spots.find((x) => x.spotId === spotId);
  const name = spotName(spotId, ctx, s);
  const hours = chartHours(report);
  const aligned = r ? alignedHours(r, report.date, hours) : hours.map(() => undefined);
  // `<code>` ligne à ligne plutôt qu'un bloc `<pre>` : sur téléphone, Telegram enferme un `<pre>`
  // dans un conteneur défilant avec bouton copier qui rognait la dernière colonne de la règle.
  const chart = [`<code>${hourRuler(hours)}</code>`, `<code>${sparkline(aligned.map((h) => h?.score ?? 0))}</code>`].join('\n');
  // avec une fenêtre, le créneau ; sans fenêtre, la note du jour — sinon l'en-tête ne chiffrait rien
  const headline = r?.best ? fmtWindow(r.best) : r ? `${r.maxScore.toFixed(1)}/10` : '';
  const title = `🏄 ${name}${headline ? ` · ${headline}` : ''}`;

  if (!r || !r.open) return [title, chart, s.dayView.closedSpot].join('\n\n');

  const peak = r.best ? peakHour(r, r.best) : peakHour(r);
  const rest: string[] = [];
  if (peak) {
    if (r.best) rest.push(fill(s.dayView.peak, { score: score1(r.best.peak), time: fmtTime(peak.time) }));
    const ftHours = r.best ? hoursIn(r, r.best) : [peak];
    const plotted = aligned.filter((h): h is SpotHour => h !== undefined);
    rest.push(fill(s.spotLine.conditions, {
      ft: ftRange(ftHours), dir: cardinal(peak.swellDirDeg, s), s: Math.round(peak.periodS),
      wind: windRangeText(plotted, peak, s), tide: tideText(report, peak, s),
    }));
    if (r.best) rest.push(...explanationLines(r, peak, plotted, s));
  }
  return rest.length > 0 ? [title, chart, rest.join('\n')].join('\n\n') : [title, chart].join('\n\n');
}

/**
 * One compact row: short label (≤ 13 chars, own field — no truncation heuristics, § defect 2) · sparkline
 * (1 char/hour) · maxScore. Width budget for a 14-hour day (§ day-view.md "Width and naming fix"):
 * label 13 + 1 space + spark 14 + 2 spaces + score ≤ 4 ("10.0") = 34.
 */
function spotRow(r: SpotResult, hours: number[], date: string, ctx: RenderCtx, s: Strings): string {
  const label = spotShort(r.spotId, ctx, s);
  const aligned = alignedHours(r, date, hours);
  return `${label.padEnd(13, ' ')} ${sparkline(aligned.map((h) => h?.score ?? 0))}  ${score1(r.maxScore)}`;
}

/**
 * The 📋 day view: the primary spot's full chart, one sparkline row per other open spot scoring ≥ 2.5
 * (sorted best first; below that they collapse into a count unless `opts.all`), the closed-spots line,
 * the tide line and a sun line. No Open-Meteo attribution — that now lives in the welcome message.
 */
/**
 * Spot du verdict d'abord, puis les autres spots ouverts du meilleur au moins bon. C'est l'ordre
 * des lignes de `renderDayView` ; le routeur s'en sert pour que la liste de commandes de `/all`
 * suive exactement les lignes affichées au-dessus (une seule définition, pas deux qui dérivent).
 */
export function openSpotOrder(report: Report): string[] {
  const pick = primaryPick(report.verdict);
  const byScore = (a: SpotResult, b: SpotResult): number => b.maxScore - a.maxScore;
  const primaryId = pick?.spotId ?? [...report.spots].filter((r) => r.open).sort(byScore)[0]?.spotId;
  const others = report.spots.filter((r) => r.open && r.spotId !== primaryId).sort(byScore).map((r) => r.spotId);
  return primaryId ? [primaryId, ...others] : others;
}

/**
 * Hard cap on how many non-primary spots the `/all` surface shows or lists. `/all`'s spot list is
 * bounded only by the caller's radius query (`nearbySpots`), and once that query considers curated +
 * world spots (§report "Resilience, wiring and dedupe"), a dense real-world cluster of adjacent breaks
 * can put dozens of open spots in one report — uncapped, both the row block (≤ 34 chars/row,
 * § "row width budget" below) and the trailing command line would grow without bound and risk
 * exceeding Telegram's 4096-character message limit.
 *
 * 30 is chosen with real margin, not just "under the limit": 30 rows × 34 chars ≈ 1050 chars, plus 31
 * command-line entries (primary + 30) × ~17 chars ≈ 530 chars, leaving well over 2000 characters of
 * headroom for the primary spot's own block, the closed-spots line, tide and sun lines even in a
 * pathological cluster (verified in this session up to 200 synthetic open spots — see the report for
 * the measured message length).
 */
export const ALL_SPOTS_CAP = 30;

/**
 * `openSpotOrder`, capped for `/all`: the primary spot, then at most `ALL_SPOTS_CAP` more. Both
 * `renderDayView({ all: true })`'s row block and the router's trailing command line
 * (`allSpotsCommandLine`, `src/bot/router.ts`) must derive their spot list from *this*, never from
 * `openSpotOrder` directly, so the two can never disagree on which spots are shown ("one single
 * definition, not two that derive" — the same rule `openSpotOrder` itself already follows for the
 * un-capped case).
 */
export function allSpotOrder(report: Report): string[] {
  const [primaryId, ...others] = openSpotOrder(report);
  const capped = others.slice(0, ALL_SPOTS_CAP);
  return primaryId !== undefined ? [primaryId, ...capped] : capped;
}

export function renderDayView(report: Report, ctx: RenderCtx, opts: { all?: boolean } = {}): string {
  const s = STRINGS[ctx.lang];
  const primaryId = openSpotOrder(report)[0];

  const blocks: string[] = [];
  if (primaryId) blocks.push(renderSpotDay(report, primaryId, ctx));

  const others = report.spots.filter((r) => r.open && r.spotId !== primaryId).sort((a, b) => b.maxScore - a.maxScore);
  const shown = opts.all ? others.slice(0, ALL_SPOTS_CAP) : others.filter((r) => r.maxScore >= 2.5);
  const hours = chartHours(report);
  if (shown.length > 0) blocks.push(shown.map((r) => `<code>${spotRow(r, hours, report.date, ctx, s)}</code>`).join('\n'));

  const tail: string[] = [];
  const hidden = others.length - shown.length;
  if (hidden > 0) tail.push(fill(opts.all ? s.dayView.moreSpots : s.dayView.flatSpots, { n: hidden }));
  const closed = report.spots.filter((r) => !r.open).map((r) => spotName(r.spotId, ctx, s));
  if (closed.length > 0) tail.push(fill(s.details.closed, { spots: closed.join(', ') }));
  if (report.tides.length > 0) {
    tail.push(fill(s.details.tides, { list: report.tides.map((e) => fill(s.tideNext[e.kind], { time: fmtTime(e.time) })).join(' · ') }));
  }
  tail.push(fill(s.dayView.sun, { sunrise: fmtTime(report.sun.sunrise), sunset: fmtTime(report.sun.sunset) }));
  blocks.push(tail.join('\n'));

  return blocks.join('\n\n');
}

/**
 * Thin alias: title line (still used by the 📋 callback handler in `src/bot/router.ts`) + the day view
 * body. Default title ("Your day") describes the day-chart-plus-collapsed-rows body this renders today;
 * `opts.all` switches to the "All spots" title reserved for the future genuinely-everything `/all` view.
 */
export function renderDetails(report: Report, ctx: RenderCtx, opts: { all?: boolean } = {}): string {
  const s = STRINGS[ctx.lang];
  const titleTemplate = opts.all ? s.details.title : s.dayView.title;
  const title = fill(titleTemplate, { date: report.mode === 'now' ? s.today : fmtDate(report.date, ctx.lang) });
  return `${title}\n${renderDayView(report, ctx, opts)}`;
}

const detailsButtonRow = (date: string, lang: Lang): InlineButton[] => [{ text: STRINGS[lang].buttons.allSpots, callback_data: `rep:${date}` }];


/** Rows → `undefined` rather than `{ inline_keyboard: [] }` — Telegram rejects an empty keyboard. */
const toMarkup = (rows: InlineButton[][]): ReplyMarkup | undefined => (rows.length > 0 ? { inline_keyboard: rows } : undefined);

/**
 * 📍 "go to this spot" map buttons — one row per button (spot names are long). Opens Google's documented
 * URL API (`/maps/search/?api=1&query=<lat>,<lon>`), which opens the Google Maps app on iOS/Android and
 * falls back to the browser; Telegram's `url` button only accepts http(s), so a `geo:` URI is not an option.
 *
 * `opts.spotId` (a per-spot command, e.g. `/long_beach`): exactly that spot's button, unconditionally —
 * even closed or flat, and even absent from `report.spots` entirely (only `ctx.spots` is consulted).
 * Otherwise: one button per *interesting* spot — a spot whose day has a window (`SpotResult.best` set,
 * the existing `SCORING.windowMin` threshold via `evaluateSpot`/`findWindows`) — ordered by `best.peak`
 * descending, capped at 5 so the keyboard stays usable. Possibly `[]`.
 */
export function goButtons(report: Report, ctx: RenderCtx, opts: { spotId?: string } = {}): InlineButton[][] {
  const s = STRINGS[ctx.lang];
  const row = (spotId: string): InlineButton[] | undefined => {
    const spot = ctx.spots.get(spotId);
    if (!spot) return undefined;
    const text = fill(s.buttons.goTo, { spot: spotShort(spotId, ctx, s) });
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${spot.lat},${spot.lon}`)}`;
    return [{ text, url }];
  };

  if (opts.spotId !== undefined) {
    const one = row(opts.spotId);
    return one ? [one] : [];
  }

  return report.spots
    .filter((r) => r.best)
    .sort((a, b) => (b.best?.peak ?? 0) - (a.best?.peak ?? 0))
    .slice(0, 5)
    .map((r) => row(r.spotId))
    .filter((r): r is InlineButton[] => r !== undefined);
}

/** `goButtons` wrapped into a `ReplyMarkup` — the `/all` and per-spot surfaces (no 📋 row involved). */
export const goButtonsMarkup = (report: Report, ctx: RenderCtx, opts: { spotId?: string } = {}): ReplyMarkup | undefined =>
  toMarkup(goButtons(report, ctx, opts));

/**
 * The verdict surface (`/now`, the location reply, and the evening/morning push — same rendering path):
 * go buttons first (own rows — spot names are long), then the 📋 row. Pas de verdict (hors-couverture,
 * pas de données) → pas de bouton 📋 : le panneau qu'il ouvrirait serait fabriqué (§9) — and in practice
 * those reports never carry `spots` either, so no go buttons show there anyway.
 */
export function detailsMarkupFor(report: Report, ctx: RenderCtx): ReplyMarkup | undefined {
  const hasDetails = report.verdict.kind === 'green' || report.verdict.kind === 'yellow' || report.verdict.kind === 'red';
  const rows = [...goButtons(report, ctx), ...(hasDetails ? [detailsButtonRow(report.date, ctx.lang)] : [])];
  return toMarkup(rows);
}
