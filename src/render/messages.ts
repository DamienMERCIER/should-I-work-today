import type { ReplyMarkup } from '../adapters/telegram';
import { FAR_FROM_COAST_KM } from '../config';
import type { Delta } from '../engine/delta';
import { cardinal8 } from '../engine/geo';
import { isWeekend, toMs } from '../engine/time';
import { primaryPick } from '../engine/verdict';
import type { HourFactors, Lang, Report, Spot, SpotHour, SpotPick, SpotResult, Window } from '../types';
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

function spotName(id: string, ctx: RenderCtx, s: Strings): string {
  const spot = ctx.spots.get(id);
  if (!spot) return esc(id);
  return spot.verified ? esc(spot.name) : `${s.approx} ${esc(spot.name)}`;
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

function conditionsLine(r: SpotResult, w: Window, report: Report, ctx: RenderCtx, s: Strings): string {
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
  if (r) lines.push(`   ${conditionsLine(r, pick.window, report, ctx, s)}`);
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
  if (pick && r) lines.push(conditionsLine(r, pick.window, morning, ctx, s));
  if (delta.cause) lines.push(fill(s.morning.cause, { cause: s.causes[delta.cause] }));
  return lines.join('\n');
}

export function renderDetails(report: Report, ctx: RenderCtx): string {
  const s = STRINGS[ctx.lang];
  const lines = [fill(s.details.title, { date: report.mode === 'now' ? s.today : fmtDate(report.date, ctx.lang) })];
  const open = report.spots
    .filter((r) => r.open)
    .sort((a, b) => (b.best?.peak ?? 0) - (a.best?.peak ?? 0) || b.maxScore - a.maxScore);
  for (const r of open) {
    const h = peakHour(r, r.best);
    if (!h) continue;
    const arrow = h.tide.trend === 'rising' ? '↑' : '↓';
    const win = r.best ? fmtWindow(r.best) : s.details.noWindow;
    const ft = r.best ? ftRange(hoursIn(r, r.best)) : String(Math.round(h.faceFt));
    lines.push(`${spotName(r.spotId, ctx, s)} · ${win} · ${score1(r.best?.peak ?? r.maxScore)} · ${ft} ft · ${windText(h, s)} ${arrow}`);
  }
  const closed = report.spots.filter((r) => !r.open).map((r) => spotName(r.spotId, ctx, s));
  if (closed.length > 0) lines.push(fill(s.details.closed, { spots: closed.join(', ') }));
  if (report.tides.length > 0) {
    lines.push(fill(s.details.tides, { list: report.tides.map((e) => fill(s.tideNext[e.kind], { time: fmtTime(e.time) })).join(' · ') }));
  }
  lines.push(
    fill(s.details.sun, { temp: Math.round(report.weather.tempMaxC), sunrise: fmtTime(report.sun.sunrise), sunset: fmtTime(report.sun.sunset) }),
    s.details.license,
  );
  return lines.join('\n');
}

export const detailsButton = (date: string, lang: Lang): ReplyMarkup => ({
  inline_keyboard: [[{ text: STRINGS[lang].buttons.allSpots, callback_data: `rep:${date}` }]],
});

/** Pas de verdict (hors-couverture, pas de données) → pas de bouton 📋 : le panneau qu'il ouvrirait serait fabriqué (§9). */
export const detailsMarkupFor = (report: Report, lang: Lang): ReplyMarkup | undefined =>
  (report.verdict.kind === 'green' || report.verdict.kind === 'yellow' || report.verdict.kind === 'red' ? detailsButton(report.date, lang) : undefined);
