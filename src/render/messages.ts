import type { InlineButton, ReplyMarkup } from '../adapters/telegram';
import { FAR_FROM_COAST_KM, SCORING } from '../config';
import { worldSpotById } from '../data/world';
import type { Delta } from '../engine/delta';
import { cardinal8 } from '../engine/geo';
import { addDays, isWeekend, toMs } from '../engine/time';
import { rawStars, starGlyphs } from '../engine/rating';
import { compareSpotDays, primaryPick } from '../engine/verdict';
import { wetsuitFor } from '../engine/water';
import type { Lang, Report, Spot, SpotHour, SpotPick, SpotResult, Window, WindState } from '../types';
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

/**
 * Building an `Intl.DateTimeFormat` is expensive (~20 µs): one per language and per style, cached for the isolate's
 * lifetime. Recreating one per date made formatting the top cost of the Sunday send (7.7 ms for 40 friends).
 */
const dateFormats = new Map<string, Intl.DateTimeFormat>();
function dateFormat(lang: Lang, style: 'date' | 'day'): Intl.DateTimeFormat {
  const key = `${lang}|${style}`;
  let format = dateFormats.get(key);
  if (!format) {
    const month = style === 'date' ? { month: 'short' as const } : {};
    format = new Intl.DateTimeFormat(STRINGS[lang].locale, { weekday: 'short', day: 'numeric', ...month, timeZone: 'UTC' });
    dateFormats.set(key, format);
  }
  return format;
}

export function fmtDate(date: string, lang: Lang): string {
  return dateFormat(lang, 'date').format(new Date(toMs(`${date}T00:00`)));
}

/** Short day for a week line: "Tue 22", "вт, 22". */
export function fmtDay(date: string, lang: Lang): string {
  return dateFormat(lang, 'day').format(new Date(toMs(`${date}T00:00`)));
}

export const fmtWindow = (w: Window): string => `${fmtTime(w.start)}–${fmtTime(w.end)}`;

/**
 * `⭐⭐⭐⭐` when it's clean, `☆☆☆` under onshore wind, matching the site's gold and white. `0★` at zero:
 * the site shows nothing, and a lone dot would read like a bug.
 */
export const starsText = (stars: number, clean: boolean): string => (stars === 0 ? '0★' : starGlyphs({ stars, clean }));
/** Short form for fixed-width rows: `4⭐`, `3☆`, `0★`. */
const starsShort = (stars: number, clean: boolean): string => `${stars}${stars === 0 ? '★' : clean ? '⭐' : '☆'}`;
/** Below this, a spot doesn't earn its row in the 📋 view: zero stars all day long. */
const DAY_VIEW_MIN_STARS = 1;
const cardinal = (deg: number, s: Strings): string => s.cardinal[cardinal8(deg)];

/**
 * The spot behind a report id: among the context's curated spots, otherwise among the imported spots.
 * Reports only keep ids; without this fallback, an imported spot would lose its name, its 📍 button, and its
 * command in `/all`. Every lookup of a spot by id in a message goes through here.
 */
export function spotById(id: string, ctx: RenderCtx): Spot | undefined {
  return ctx.spots.get(id) ?? worldSpotById(id);
}

export function spotName(id: string, ctx: RenderCtx, s: Strings): string {
  const spot = spotById(id, ctx);
  if (!spot) return esc(id);
  return esc(spot.name);
}

/** Same `≈` rule as `spotName`, but the short (≤ 13 char) label used on the day view's secondary rows. */
function spotShort(id: string, ctx: RenderCtx, s: Strings): string {
  const spot = spotById(id, ctx);
  if (!spot) return esc(id);
  return esc(spot.short);
}

const hoursIn = (r: SpotResult, w: Window): SpotHour[] => r.hours.filter((h) => h.time >= w.start && h.time < w.end);

function peakHour(r: SpotResult, w?: Window): SpotHour | undefined {
  const hours = w ? hoursIn(r, w) : r.hours;
  return [...hours].sort((a, b) => b.score - a.score)[0];
}

/** The swell heading into the spot, to the nearest 0.1 m like surf-forecast: `2.1` or `1.8–2.1`. */
function heightRange(hours: SpotHour[]): string {
  const ms = hours.map((h) => Math.round(h.heightM * 10) / 10);
  const min = Math.min(...ms);
  const max = Math.max(...ms);
  return min === max ? min.toFixed(1) : `${min.toFixed(1)}–${max.toFixed(1)}`;
}

/** The stars of a window's best slot, in that hour's colour. */
function windowStars(r: SpotResult | undefined, w: Window): string {
  const h = r ? peakHour(r, w) : undefined;
  return h ? starsText(h.score, h.clean) : `${w.peak}★`;
}

/** The wind state as surf-forecast names it: glassy, offshore, cross-offshore, cross-shore, cross-onshore, onshore. */
const stateText = (h: SpotHour, s: Strings): string => s.windStates[h.windState];

function windText(h: SpotHour, s: Strings): string {
  if (h.windState === 'glassy') return stateText(h, s);
  return `${stateText(h, s)} ${cardinal(h.windDirDeg, s)} ${Math.round(h.windKt)} kt`;
}

/** Wind at the peak hour, "then <state>" if the state changes by the end of the window. */
function windSummary(r: SpotResult, w: Window, s: Strings): string {
  const hours = hoursIn(r, w);
  const peak = peakHour(r, w);
  const last = hours[hours.length - 1];
  if (!peak || !last) return '';
  const base = windText(peak, s);
  return last.windState !== peak.windState ? `${base} ${s.then} ${stateText(last, s)}` : base;
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
    m: heightRange(hoursIn(r, w)), dir: cardinal(peak.swellDirDeg, s), s: Math.round(peak.periodS),
    wind: windSummary(r, w, s), tide: tideText(report, peak, s),
  });
}

function sunLine(report: Report, s: Strings): string {
  const base = fill(s.spotLine.sun, { temp: Math.round(report.weather.tempMaxC), sunrise: fmtTime(report.sun.sunrise) });
  return report.weather.precipMm >= 1 ? `${base} · ${fill(s.rain, { mm: Math.round(report.weather.precipMm) })}` : base;
}

/** 🌡️ the day's water temperature at the spot and the wetsuit that goes with it; nothing when the sea gave no reading. */
function waterLine(r: SpotResult | undefined, s: Strings): string | undefined {
  if (r?.waterTempC === undefined) return undefined;
  return fill(s.water, { temp: r.waterTempC, suit: s.suits[wetsuitFor(r.waterTempC)] });
}

/**
 * A spot's two chart lines: an hour ruler, then a score per hour. One single definition for both the verdict
 * and the 📋 view — both must plot exactly the same day.
 * `<code>` line by line rather than one `<pre>` block: on phone, Telegram wraps a `<pre>` in a scrolling
 * container with a copy button that clipped the ruler's last column.
 * No indentation, like the spot's title: the 3 spaces on the conditions lines are in a proportional font
 * and don't align anything here, and every character saved pushes the clipping further away on mobile.
 * Each line says what it plots — 🕐 the hours, 🌊 each hour's level, ⭐ the hours with yellow stars (`━`, at
 * least one star and no onshore wind) —, emoji outside the `<code>`: same-width emoji in front of each line
 * keep the ruler aligned with the curve. No ⭐ line on a day with no yellow star: a line of dots would teach nothing.
 */
function spotChart(report: Report, spotId: string): string[] {
  const r = report.spots.find((x) => x.spotId === spotId);
  const hours = chartHours(report);
  const aligned = r ? alignedHours(r, report.date, hours) : hours.map(() => undefined);
  const lines = [`🕐 <code>${hourRuler(hours)}</code>`, `🌊 <code>${sparkline(aligned.map((h) => h?.score ?? 0))}</code>`];
  const gold = aligned.map((h) => (h && h.clean && h.score >= 1 ? '━' : '·')).join('');
  if (gold.includes('━')) lines.push(`⭐ <code>${gold}</code>`);
  return lines;
}

/**
 * `sameSpotAbove` for a 🟡's second window on the same spot: the chart and the water line hold for the whole
 * day, so repeating them under "after work" would just duplicate the lines above verbatim.
 */
function primaryBlock(pick: SpotPick, report: Report, ctx: RenderCtx, s: Strings, opts: { sameSpotAbove?: boolean } = {}): string[] {
  const r = report.spots.find((x) => x.spotId === pick.spotId);
  const lines = [`🏄 ${spotName(pick.spotId, ctx, s)} · ${fmtWindow(pick.window)} · ${windowStars(r, pick.window)}`];
  if (r) lines.push(`   ${conditionsLine(r, pick.window, report, s)}`);
  lines.push(`   ${sunLine(report, s)}`);
  if (opts.sameSpotAbove) return lines;
  const water = waterLine(r, s);
  if (water) lines.push(`   ${water}`);
  lines.push(...spotChart(report, pick.spotId));
  return lines;
}

/** The 🥈 of a 🟢: the best other spot with a window, using the verdict's tie-break rule. */
const runnerUpSpot = (report: Report, excludeId: string): SpotResult | undefined =>
  report.spots.filter((x) => x.spotId !== excludeId && x.best).sort(compareSpotDays)[0];

const MEDALS = ['🥇', '🥈', '🥉'] as const;

/**
 * The spots a verdict names, in the message's order: the 🟢 and its 🥈; a 🟡's dawn and dusk; for a 🔴, its
 * best spot then the others with at least one star, up to three, using the verdict's tie-break rule. The 🙋 + 📍
 * rows under the message derive from this: each row has its spot named in the text, in the same order, 🥇 first.
 */
function namedSpots(report: Report): SpotResult[] {
  const v = report.verdict;
  const find = (id: string | undefined): SpotResult | undefined => (id === undefined ? undefined : report.spots.find((r) => r.spotId === id));
  const present = (list: (SpotResult | undefined)[]): SpotResult[] => list.filter((r): r is SpotResult => r !== undefined);
  switch (v.kind) {
    case 'green':
      return present([find(v.spotId), runnerUpSpot(report, v.spotId)]);
    case 'yellow':
      return present([...new Set([v.dawn?.spotId, v.dusk?.spotId])].map(find));
    case 'red': {
      const best = find(v.bestSpotId);
      if (!best) return [];
      const others = report.spots.filter((r) => r.spotId !== best.spotId && r.maxScore >= 1).sort(compareSpotDays);
      return [best, ...others].slice(0, MEDALS.length);
    }
    default:
      return [];
  }
}

/** A day's stars, gold or white depending on its best hour. */
const dayStars = (r: SpotResult): string => starsText(r.maxScore, [...r.hours].sort((a, b) => b.score - a.score)[0]?.clean ?? true);

function runnerUp(report: Report, excludeId: string, ctx: RenderCtx, s: Strings): string[] {
  const r = runnerUpSpot(report, excludeId);
  if (!r?.best) return [];
  return [
    `🥈 ${spotName(r.spotId, ctx, s)} · ${fmtWindow(r.best)} · ${windowStars(r, r.best)}`,
    `   ${heightRange(hoursIn(r, r.best))} m · ${windSummary(r, r.best, s)}`,
    ...spotChart(report, r.spotId),
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

/** An hour's base surf-forecast score, 0..10: what the swell alone would allow. */
const baseOf = (h: SpotHour): number => h.factors.swell * 10;

/** What the wind takes away from that hour's swell, in stars before rounding. */
const windCost = (h: SpotHour): number => rawStars(baseOf(h), 1) - rawStars(baseOf(h), h.factors.wind);

/**
 * Why a 🔴: at the spot's best surfable hour, what's holding the stars back. Wind if it costs at least
 * one star, swell otherwise — in that case swell is the ceiling. Comparing the two factors directly
 * didn't work: `swell` is a base score scaled to 0..1, not a penalty, and 2.2 m (0.37) came out looking
 * worse than a 41 km/h offshore wind (×0.54) that actually cost two stars.
 * The storm is named when it's the only thing holding the daylight hours at zero; night is named when
 * there are no daylight hours at all.
 */
function lowestFactorReason(r: SpotResult, s: Strings): string {
  const daylit = r.hours.filter((x) => x.factors.day === 1);
  if (daylit.length === 0) return s.reasons.dark;
  const surfable = daylit.filter((x) => x.factors.weather === 1);
  if (surfable.length === 0) return s.reasons.storm;
  const h = [...surfable].sort((a, b) => b.score - a.score)[0];
  return windCost(h) >= 1 ? windText(h, s) : fill(s.reasons.size, { m: h.heightM.toFixed(1) });
}

/**
 * A verdict message is a series of blocks separated by a blank line: the title, then one block per
 * spot (its conditions lines and its chart). Otherwise everything runs together, and you can no longer
 * tell which chart belongs to which spot.
 */
export function renderEvening(report: Report, ctx: RenderCtx): string {
  const s = STRINGS[ctx.lang];
  const v = report.verdict;
  const blocks: string[] = [];
  const push = (...lines: string[]): void => {
    if (lines.length > 0) blocks.push(lines.join('\n'));
  };
  switch (v.kind) {
    case 'green':
      push(greenTitle(report, v.epic, ctx, s));
      push(...primaryBlock({ spotId: v.spotId, window: v.window }, report, ctx, s));
      push(...runnerUp(report, v.spotId, ctx, s));
      break;
    case 'yellow':
      if (v.dawn) push(fill(s.verdict.dawn, dateVars(report, ctx)), ...primaryBlock(v.dawn, report, ctx, s));
      if (v.dusk) push(fill(s.verdict.dusk, dateVars(report, ctx)), ...primaryBlock(v.dusk, report, ctx, s, { sameSpotAbove: v.dusk.spotId === v.dawn?.spotId }));
      break;
    case 'red': {
      push(redTitle(report, ctx, s));
      const named = namedSpots(report);
      const best = named[0];
      // A red has two distinct causes: nothing good enough, or a window that's good enough but
      // too short (or landing right in work hours). Saying "nothing ≥ 4★" and then showing "★★★★"
      // right underneath would contradict itself on screen.
      // the friend's own threshold, the one that made this day red, not the shared scale
      const good = report.minStars ?? SCORING.good;
      const tooShort = (best?.maxScore ?? 0) >= good;
      const body = fill(tooShort ? s.verdict.redTooShort : s.verdict.redBody, { radius: report.radiusKm, good });
      // the best spot's water line too: you might want to go anyway, and /now must state it regardless of the verdict
      const water = waterLine(best, s);
      const vars = (r: SpotResult): { spot: string; stars: string; reason: string } => ({ spot: spotName(r.spotId, ctx, s), stars: dayStars(r), reason: lowestFactorReason(r, s) });
      if (named.length < 2) {
        push(body, ...(best ? [fill(s.verdict.redBest, vars(best))] : []), ...(water ? [water] : []));
        break;
      }
      // several spots are worth a look: 🥇🥈🥉 instead of "Best:", each in its own block to give it room
      push(body);
      named.forEach((r, i) => push(fill(s.verdict.redRanked, { medal: MEDALS[i], ...vars(r) }), ...(i === 0 && water ? [`   ${water}`] : [])));
      break;
    }
    case 'outOfCoverage': {
      const lines = [fill(s.coverage.none, { radius: report.radiusKm })];
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
      push(...lines);
      break;
    }
    case 'noData':
      push(s.noData);
      break;
  }
  return blocks.join('\n\n');
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
  const pick = primaryPick(morning.verdict);
  const r = pick ? morning.spots.find((x) => x.spotId === pick.spotId) : undefined;
  // in the morning, right before heading out: which wetsuit to take
  const water = waterLine(r, s);
  if (!delta.changed) return [fill(s.morning.confirmed, { verdict: renderShortVerdict(morning, ctx) }), ...(water ? [water] : [])].join('\n');
  const lines = [fill(s.morning.changed, { from: renderShortVerdict(evening, ctx), to: renderShortVerdict(morning, ctx) })];
  if (pick && r) lines.push(conditionsLine(r, pick.window, morning, s));
  if (water) lines.push(water);
  if (delta.cause) lines.push(fill(s.morning.cause, { cause: s.causes[delta.cause] }));
  return lines.join('\n');
}

// ---- 🔥 the midday alert ------------------------------------------------------------------------

/**
 * Big days at D+2 or D+3, in date order: for each one, its title and the spot block exactly as the evening
 * send would show it, plus enough to plan around. The runner only passes epic 🟢 days; a report with no window
 * is skipped rather than rendered empty.
 */
export function renderAlert(reports: Report[], ctx: RenderCtx): string {
  const s = STRINGS[ctx.lang];
  const blocks: string[] = [];
  for (const report of reports) {
    const pick = primaryPick(report.verdict);
    if (pick) blocks.push([fill(s.alert.title, dateVars(report, ctx)), ...primaryBlock(pick, report, ctx, s)].join('\n'));
  }
  blocks.push(s.alert.footer);
  return blocks.join('\n\n');
}

// ---- 📅 the week ahead --------------------------------------------------------------------------

/** From how many days after today a forecast becomes just a trend. */
export const WEEK_TREND_FROM_DAYS = 4;

export interface WeekOptions { today: string }

/** The best a day has to offer: the verdict's window if there is one, otherwise the top-rated spot. */
interface DayBest { spotId: string; stars: number; clean: boolean; window?: Window; emoji: string }

function dayBest(report: Report): DayBest | undefined {
  const v = report.verdict;
  if (v.kind === 'green' || v.kind === 'yellow') {
    const pick = primaryPick(v);
    if (!pick) return undefined;
    const r = report.spots.find((x) => x.spotId === pick.spotId);
    const peak = r ? peakHour(r, pick.window) : undefined;
    const emoji = v.kind === 'green' ? '🟢' : v.dawn ? '🌅' : '🌇';
    return { spotId: pick.spotId, stars: pick.window.peak, clean: peak?.clean ?? true, window: pick.window, emoji };
  }
  if (v.kind !== 'red') return undefined;
  // the verdict already picked the best spot: one single tie-break rule, not two that could disagree
  const top = v.bestSpotId ? report.spots.find((x) => x.spotId === v.bestSpotId) : undefined;
  if (!top || top.maxScore === 0) return undefined;
  return { spotId: top.spotId, stars: top.maxScore, clean: peakHour(top)?.clean ?? true, emoji: '🔴' };
}

/**
 * The week as one line per day, best day first. Each day carries the verdict the evening send would
 * give (work hours, weekend rule), with the spot's short label so it fits on a phone line; the best
 * day, though, names the spot in full. Beyond a few days it's only a trend: a footer line says so
 * rather than letting it look just as precise.
 */
export function renderWeek(reports: Report[], ctx: RenderCtx, opts: WeekOptions): string {
  const s = STRINGS[ctx.lang];
  if (reports.length === 0 || reports.every((r) => r.verdict.kind === 'noData')) return s.noData;
  const label = (date: string): string => (date === opts.today ? s.week.today : fmtDay(date, ctx.lang));

  const lines = reports.map((report) => {
    const day = `<b>${label(report.date)}</b>`;
    if (report.verdict.kind === 'noData' || report.verdict.kind === 'outOfCoverage') return `⚠️ ${day} · ${s.week.noData}`;
    const best = dayBest(report);
    if (!best) return `🔴 ${day} · ${s.week.nothing}`;
    const window = best.window ? ` · ${fmtWindow(best.window)}` : '';
    return `${best.emoji} ${day} · ${spotShort(best.spotId, ctx, s)} ${starsText(best.stars, best.clean)}${window}`;
  });

  const blocks = [s.week.title];
  // most stars wins, earliest breaks a tie: a stable sort keeps the days in order
  const top = reports
    .map((report) => ({ report, best: dayBest(report) }))
    .filter((x): x is { report: Report; best: DayBest } => x.best !== undefined)
    .sort((a, b) => b.best.stars - a.best.stars)[0];
  if (top) {
    const window = top.best.window ? ` · ${fmtWindow(top.best.window)}` : '';
    blocks.push(`${fill(s.week.best, { day: label(top.report.date), spot: spotName(top.best.spotId, ctx, s), stars: starsText(top.best.stars, top.best.clean) })}${window}`);
  }
  blocks.push(lines.join('\n'));

  const trendFrom = reports.find((r) => r.date >= addDays(opts.today, WEEK_TREND_FROM_DAYS));
  if (trendFrom) blocks.push(fill(s.week.trend, { day: label(trendFrom.date) }));
  return blocks.join('\n\n');
}

// ---- 📋 day view: a chart of the day per spot, replacing the old flat one-snapshot-per-row list ----
// Full rationale, glyph/ruler rules and worked examples: .superpowers/sdd/day-view.md

/** This spot's hours, indexed by the report date, one slot per plotted hour (undefined = no data that hour). */
function alignedHours(r: SpotResult, date: string, hours: number[]): (SpotHour | undefined)[] {
  const byTime = new Map(r.hours.map((h) => [h.time, h] as const));
  return hours.map((h) => byTime.get(`${date}T${String(h).padStart(2, '0')}:00`));
}

/** Wind for the day view: state/direction from the peak hour, kt as a range across every plotted hour. */
function windRangeText(plotted: SpotHour[], peak: SpotHour, s: Strings): string {
  if (peak.windState === 'glassy') return stateText(peak, s);
  const kts = plotted.length > 0 ? plotted.map((h) => h.windKt) : [peak.windKt];
  const lo = Math.round(Math.min(...kts));
  const hi = Math.round(Math.max(...kts));
  const base = `${stateText(peak, s)} ${cardinal(peak.windDirDeg, s)}`;
  return lo === hi ? `${base} ${lo} kt` : `${base} ${lo}→${hi} kt`;
}

/** A factor is only named if it costs at least one star on its own — the same rule as a 🔴's reason. */
const MIN_EXPLAINED_STARS = 1;

/**
 * Stars depend only on wind and swell, and swell at the spot's grid cell moves hour to hour just as much
 * as wind does: both get cited. Tide and period don't affect the score, so naming them would be misleading.
 * Light, on the other hand, says when the session ends. Each reason arrives already worded, with the
 * stars it costs: we keep the two heaviest.
 */
const explain = (effects: [phrase: string, stars: number][]): string[] =>
  effects
    .filter(([, stars]) => stars >= MIN_EXPLAINED_STARS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([phrase]) => phrase);

/** The six wind states from cleanest to worst, as on surf-forecast. */
const STATE_RANK: Record<WindState, number> = { glassy: 0, off: 1, 'cross-off': 2, cross: 3, 'cross-on': 4, on: 5 };

/**
 * Wind is cited by what changed. When it's less clean elsewhere in the day, its state is what costs stars:
 * a weaker onshore breeze still takes stars away, and "wind picks up" or "wind drops" would be misleading.
 * Otherwise, it's cited by its strength.
 */
function windBestPhrase(peak: SpotHour, worst: SpotHour, s: Strings): string {
  const r = s.dayView.reasons;
  if (peak.windState === 'glassy') return stateText(peak, s);
  if (STATE_RANK[worst.windState] > STATE_RANK[peak.windState]) return fill(r.windIs, { state: stateText(peak, s) });
  return fill(r.windDrops, { kt: Math.round(peak.windKt) });
}

function windFadePhrase(peak: SpotHour, fade: SpotHour, s: Strings): string {
  const r = s.dayView.reasons;
  if (fade.windState === 'glassy') return stateText(fade, s);
  if (STATE_RANK[fade.windState] > STATE_RANK[peak.windState]) return fill(r.windTurns, { state: stateText(fade, s) });
  return fill(r.windBuilds, { kt: Math.round(fade.windKt) });
}

/**
 * Why the peak is the best moment: how many stars it would lose if this one factor alone dropped to its
 * least favourable value across the plotted day, with the other factor held at the peak's own value.
 */
function bestReasons(peak: SpotHour, plotted: SpotHour[], s: Strings): string[] {
  if (plotted.length === 0) return [];
  const worst = plotted.reduce((w, h) => (h.factors.wind < w.factors.wind ? h : w));
  const worstBase = Math.min(...plotted.map(baseOf));
  const atPeak = rawStars(baseOf(peak), peak.factors.wind);
  return explain([
    [windBestPhrase(peak, worst, s), atPeak - rawStars(baseOf(peak), worst.factors.wind)],
    [fill(s.dayView.reasons.swellPeaks, { m: peak.heightM.toFixed(1) }), atPeak - rawStars(worstBase, peak.factors.wind)],
  ]);
}

/** First hour after the peak (anywhere in the spot's day, not just the plotted range — dusk included) below 60 % of it. */
function fadeHourAfter(hours: SpotHour[], peak: SpotHour): SpotHour | undefined {
  const threshold = 0.6 * peak.score;
  return hours.find((h) => h.time > peak.time && h.score < threshold);
}

/**
 * What brings the score down between the peak and the hour where it collapses: that hour's wind alone
 * applied to the peak, that hour's swell alone, or night dropping everything to zero. Worded from the
 * fade hour's point of view.
 */
function fadeReasons(peak: SpotHour, fade: SpotHour, s: Strings): string[] {
  const r = s.dayView.reasons;
  const atPeak = rawStars(baseOf(peak), peak.factors.wind);
  return explain([
    [windFadePhrase(peak, fade, s), atPeak - rawStars(baseOf(peak), fade.factors.wind)],
    [fill(r.swellDrops, { m: fade.heightM.toFixed(1) }), atPeak - rawStars(baseOf(fade), peak.factors.wind)],
    [r.getsDark, peak.factors.day === 1 && fade.factors.day === 0 ? atPeak : 0],
  ]);
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
 * keeps the chart and conditions) — also called directly by the follow-up `/spot` command.
 */
export function renderSpotDay(report: Report, spotId: string, ctx: RenderCtx): string {
  const s = STRINGS[ctx.lang];
  const r = report.spots.find((x) => x.spotId === spotId);
  const name = spotName(spotId, ctx, s);
  const chart = spotChart(report, spotId).join('\n');
  const aligned = r ? alignedHours(r, report.date, chartHours(report)) : [];
  const peak = r ? (r.best ? peakHour(r, r.best) : peakHour(r)) : undefined;
  // with a window, the time slot; without one, the day's stars — otherwise the headline would show no number
  const headline = r?.best ? fmtWindow(r.best) : peak ? starsText(peak.score, peak.clean) : '';
  const title = `🏄 ${name}${headline ? ` · ${headline}` : ''}`;

  if (!r) return [title, chart].join('\n\n');

  const rest: string[] = [];
  if (peak) {
    if (r.best) rest.push(fill(s.dayView.peak, { stars: starsText(peak.score, peak.clean), time: fmtTime(peak.time) }));
    const heightHours = r.best ? hoursIn(r, r.best) : [peak];
    const plotted = aligned.filter((h): h is SpotHour => h !== undefined);
    rest.push(fill(s.spotLine.conditions, {
      m: heightRange(heightHours), dir: cardinal(peak.swellDirDeg, s), s: Math.round(peak.periodS),
      wind: windRangeText(plotted, peak, s), tide: tideText(report, peak, s),
    }));
    if (r.best) rest.push(...explanationLines(r, peak, plotted, s));
  }
  const water = waterLine(r, s);
  if (water) rest.push(water);
  return rest.length > 0 ? [title, chart, rest.join('\n')].join('\n\n') : [title, chart].join('\n\n');
}

/**
 * One compact row: short label (≤ 13 chars, own field — no truncation heuristics, § defect 2) · sparkline
 * (1 char/hour) · the day's best stars. Width budget for a 14-hour day (§ day-view.md "Width and naming fix"):
 * label 13 + 1 space + spark 14 + 2 spaces + stars ≤ 3 ("10★") = 33.
 */
function spotRow(r: SpotResult, hours: number[], date: string, ctx: RenderCtx, s: Strings): string {
  const label = spotShort(r.spotId, ctx, s);
  const aligned = alignedHours(r, date, hours);
  const top = peakHour(r);
  return `${label.padEnd(13, ' ')} ${sparkline(aligned.map((h) => h?.score ?? 0))}  ${starsShort(r.maxScore, top?.clean ?? true)}`;
}

/**
 * The 📋 day view: the primary spot's full chart, one sparkline row per other spot reaching at least one
 * star in daylight (sorted best first; the rest collapse into a count unless `opts.all`), the tide line
 * and a sun line. No Open-Meteo attribution — that now lives in the welcome message.
 */
/**
 * The verdict's spot first, then the other spots from best to worst. This is the order of
 * `renderDayView`'s rows; the router uses it so that `/all`'s command list follows exactly
 * the rows shown above (one single definition, not two that could drift apart).
 */
export function openSpotOrder(report: Report): string[] {
  const pick = primaryPick(report.verdict);
  const primaryId = pick?.spotId ?? [...report.spots].sort(compareSpotDays)[0]?.spotId;
  const others = report.spots.filter((r) => r.spotId !== primaryId).sort(compareSpotDays).map((r) => r.spotId);
  return primaryId ? [primaryId, ...others] : others;
}

/**
 * Hard cap on how many non-primary spots the `/all` surface shows or lists. `/all`'s spot list is
 * bounded only by the caller's radius query (`nearbySpots`), and once that query considers curated +
 * world spots (§report "Resilience, wiring and dedupe"), a dense real-world cluster of adjacent breaks
 * can put dozens of spots in one report — uncapped, the row block (≤ 33 chars/row, § "row width budget"
 * below) would grow without bound and risk exceeding Telegram's 4096-character message limit, and the
 * spot buttons under it (`spotDayRows`) would pile up past any usable keyboard.
 *
 * 30 is chosen with real margin, not just "under the limit": 30 rows × 34 chars ≈ 1050 chars, leaving well
 * over 2000 characters of headroom for the primary spot's own block, tide and sun lines even in a
 * pathological cluster (verified up to 200 synthetic spots — see the report for the measured message
 * length), and at most 31 spot buttons.
 */
export const ALL_SPOTS_CAP = 30;

/**
 * `openSpotOrder`, capped for `/all`: the primary spot, then at most `ALL_SPOTS_CAP` more. Both
 * `renderDayView({ all: true })`'s row block and the spot buttons under it (`spotDayRows`, through
 * `dayViewSpotOrder`) must derive their spot list from *this*, never from `openSpotOrder` directly, so
 * the two can never disagree on which spots are shown ("one single definition, not two that derive" —
 * the same rule `openSpotOrder` itself already follows for the un-capped case).
 */
export function allSpotOrder(report: Report): string[] {
  const [primaryId, ...others] = openSpotOrder(report);
  const capped = others.slice(0, ALL_SPOTS_CAP);
  return primaryId !== undefined ? [primaryId, ...capped] : capped;
}

/**
 * The spots of a 📋 view — or of `/all` with `all` —, in row order: the verdict's spot, then the rows (at
 * least one star during the day; for `/all`, all of them up to `ALL_SPOTS_CAP`). Both `renderDayView`'s rows
 * and the spot buttons that follow them (`spotDayRows`) derive from this: one single definition, never two
 * lists that can drift apart.
 */
export function dayViewSpotOrder(report: Report, opts: { all?: boolean } = {}): string[] {
  if (opts.all) return allSpotOrder(report);
  const [primaryId, ...others] = openSpotOrder(report);
  const maxScore = new Map(report.spots.map((r) => [r.spotId, r.maxScore]));
  const shown = others.filter((id) => (maxScore.get(id) ?? 0) >= DAY_VIEW_MIN_STARS);
  return primaryId !== undefined ? [primaryId, ...shown] : shown;
}

export function renderDayView(report: Report, ctx: RenderCtx, opts: { all?: boolean } = {}): string {
  const s = STRINGS[ctx.lang];
  const [primaryId, ...shownIds] = dayViewSpotOrder(report, opts);

  const blocks: string[] = [];
  if (primaryId) blocks.push(renderSpotDay(report, primaryId, ctx));

  const byId = new Map(report.spots.map((r) => [r.spotId, r]));
  const shown = shownIds.map((id) => byId.get(id)).filter((r): r is SpotResult => r !== undefined);
  const hours = chartHours(report);
  if (shown.length > 0) blocks.push(shown.map((r) => `<code>${spotRow(r, hours, report.date, ctx, s)}</code>`).join('\n'));

  const tail: string[] = [];
  const hidden = report.spots.filter((r) => r.spotId !== primaryId).length - shown.length;
  if (hidden > 0) tail.push(fill(opts.all ? s.dayView.moreSpots : s.dayView.flatSpots, { n: hidden }));
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

/**
 * 🙋 buttons: `go:<yymmdd>:<spot>` and `nogo:<yymmdd>`. The date drops the century and the dashes so the
 * longest imported ids still fit in the 64 bytes a Telegram button accepts — one button too long and Telegram
 * rejects the whole message, which means the whole evening send to a group.
 */
const CALLBACK_DATA_MAX_BYTES = 64;
const compactDate = (date: string): string => date.slice(2).replace(/-/g, '');
/** `yymmdd` → `YYYY-MM-DD`, or `undefined` for anything that isn't shaped like it. */
export const expandCompactDate = (compact: string): string | undefined =>
  /^\d{6}$/.test(compact) ? `20${compact.slice(0, 2)}-${compact.slice(2, 4)}-${compact.slice(4, 6)}` : undefined;
export const notGoingData = (date: string): string => `nogo:${compactDate(date)}`;

/** A spot's 🙋 button for a given day: only for a known spot, and only if its data fits in a Telegram button. */
function goingButton(date: string, spotId: string, ctx: RenderCtx): InlineButton | undefined {
  if (!spotById(spotId, ctx)) return undefined;
  const data = `go:${compactDate(date)}:${spotId}`;
  if (new TextEncoder().encode(data).length > CALLBACK_DATA_MAX_BYTES) return undefined;
  const s = STRINGS[ctx.lang];
  return { text: fill(s.buttons.going, { spot: spotShort(spotId, ctx, s) }), callback_data: data };
}

/**
 * 📍 directions to a spot, via Google Maps's documented URL API (`/maps/search/?api=1&query=<lat>,<lon>`):
 * the Google Maps app on iOS and Android, the browser otherwise; a Telegram `url` button only accepts http(s),
 * not `geo:`. Alone on its own row, it spells out where it leads; next to the same spot's 🙋, the emoji is enough.
 */
function mapButton(spotId: string, ctx: RenderCtx, alone: boolean): InlineButton | undefined {
  const spot = spotById(spotId, ctx);
  if (!spot) return undefined;
  const s = STRINGS[ctx.lang];
  return {
    text: alone ? `📍 ${fill(s.buttons.goTo, { spot: spotShort(spotId, ctx, s) })}` : '📍',
    url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${spot.lat},${spot.lon}`)}`,
  };
}

/** A spot's two actions on one row: "🙋 I'm going" and its 📍. Telegram splits a row evenly between them. */
function spotActionRow(date: string, spotId: string, ctx: RenderCtx): InlineButton[] {
  const going = goingButton(date, spotId, ctx);
  const map = mapButton(spotId, ctx, going === undefined);
  return [going, map].filter((b): b is InlineButton => b !== undefined);
}

/**
 * One action row per spot the message names (`namedSpots`: the 🟢 and its 🥈, a 🟡's dawn and dusk, a 🔴's
 * medals), in its order, never towards a spot at 0★. A 🔴 whose message names no spot (`redBestNamed: false`,
 * in the morning) gets none.
 */
function spotActionRows(report: Report, ctx: RenderCtx, redBestNamed: boolean): InlineButton[][] {
  if (report.verdict.kind === 'red' && !redBestNamed) return [];
  return namedSpots(report)
    .filter((r) => r.maxScore >= 1)
    .map((r) => spotActionRow(report.date, r.spotId, ctx))
    .filter((row) => row.length > 0);
}

/** Rows → `undefined` rather than `{ inline_keyboard: [] }` — Telegram rejects an empty keyboard. */
const toMarkup = (rows: InlineButton[][]): ReplyMarkup | undefined => (rows.length > 0 ? { inline_keyboard: rows } : undefined);

/**
 * 📍 "go to this spot" map buttons with their spot's name — one row per button (spot names are long), see `mapButton`.
 *
 * `opts.spotId` (a per-spot command, e.g. `/long_beach`): exactly that spot's 📍 button, unconditionally —
 * even at 0★, and even absent from `report.spots` entirely (looked up with `spotById`: curated, then imported).
 * Otherwise: one button per spot the message names (`namedSpots` — the 🟢 and its 🥈, a 🟡's dawn and dusk, a 🔴's
 * top three), in the message's order, never towards a spot at 0★ — the `/all` surface, under its spot buttons. At most
 * three. Possibly `[]`.
 */
export function goButtons(report: Report, ctx: RenderCtx, opts: { spotId?: string } = {}): InlineButton[][] {
  const ids = opts.spotId !== undefined ? [opts.spotId] : namedSpots(report).filter((r) => r.maxScore >= 1).map((r) => r.spotId);
  return ids.map((id) => mapButton(id, ctx, true)).filter((b): b is InlineButton => b !== undefined).map((b) => [b]);
}

/**
 * `/<spot>`: that spot's 🙋 for the day shown — whatever the verdict, the friend is looking at that spot —, then its 📍.
 * `spotById` must know it: an imported spot is either added to the context by the caller or found again by its id.
 */
export function spotMarkupFor(report: Report, spotId: string, ctx: RenderCtx): ReplyMarkup | undefined {
  const row = spotActionRow(report.date, spotId, ctx);
  return toMarkup(row.length > 0 ? [row] : []);
}

/**
 * 📋 and `/all`: one button per spot shown, in row order (`dayViewSpotOrder`), two per row, that opens its day
 * just like its command does. The label carries the day's stars when there are any. A spot whose data would
 * exceed a Telegram button's 64 bytes gets no button rather than getting the whole message rejected.
 */
export function spotDayRows(report: Report, ctx: RenderCtx, opts: { all?: boolean } = {}): InlineButton[][] {
  const byId = new Map(report.spots.map((r) => [r.spotId, r]));
  const buttons: InlineButton[] = [];
  for (const id of dayViewSpotOrder(report, opts)) {
    const spot = spotById(id, ctx);
    const data = `spot:${id}`;
    if (!spot || new TextEncoder().encode(data).length > CALLBACK_DATA_MAX_BYTES) continue;
    const r = byId.get(id);
    const stars = r && r.maxScore > 0 ? ` ${starsShort(r.maxScore, peakHour(r)?.clean ?? true)}` : '';
    buttons.push({ text: `${spot.short}${stars}`, callback_data: data });
  }
  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

/**
 * The end of the 📋 view — or of `/all` with `all` —: Telegram doesn't make a command inside a `<code>` block
 * tappable, so the spot rows don't open with a single tap; a button per spot does, announced by one line.
 * `/all` then keeps its 📍 buttons towards the spots with a window. With no spot, there's neither the line nor
 * any spot button.
 */
export function withSpotButtons(body: string, report: Report, ctx: RenderCtx, opts: { all?: boolean } = {}): { text: string; markup: ReplyMarkup | undefined } {
  const rows = spotDayRows(report, ctx, opts);
  return {
    text: rows.length > 0 ? `${body}\n\n${STRINGS[ctx.lang].spotCommand.detailsHint}` : body,
    markup: toMarkup(opts.all ? [...rows, ...goButtons(report, ctx)] : rows),
  };
}

/** `goButtons` wrapped into a `ReplyMarkup` — a surface with go buttons only (no 📋 row involved). */
export const goButtonsMarkup = (report: Report, ctx: RenderCtx, opts: { spotId?: string } = {}): ReplyMarkup | undefined =>
  toMarkup(goButtons(report, ctx, opts));

/**
 * The verdict surface (`/now`, the location reply, and the evening/morning push — same rendering path):
 * the 🙋 going buttons, then go buttons (own rows — spot names are long), then the 📋 row. No verdict
 * (out of coverage, no data) → no 📋 button: the panel it would open would be fabricated (§9) — and in
 * practice those reports never carry `spots` either, so no go buttons show there anyway. `redBestNamed: false`
 * is for a message that doesn't name a 🔴's best spot (the morning one): no 🙋 towards a spot missing from the text.
 */
export function detailsMarkupFor(report: Report, ctx: RenderCtx, opts: { redBestNamed?: boolean } = {}): ReplyMarkup | undefined {
  const hasDetails = report.verdict.kind === 'green' || report.verdict.kind === 'yellow' || report.verdict.kind === 'red';
  const rows = [...spotActionRows(report, ctx, opts.redBestNamed ?? true), ...(hasDetails ? [detailsButtonRow(report.date, ctx.lang)] : [])];
  return toMarkup(rows);
}
