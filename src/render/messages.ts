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
 * Construire un `Intl.DateTimeFormat` coûte cher (~20 µs) : un par langue et par style, gardé pour l'isolate. En
 * recréer un par date faisait de la rédaction le premier poste de l'envoi du dimanche (7,7 ms pour 40 amis).
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

/** Jour court pour une ligne de semaine : « Tue 22 », « вт, 22 ». */
export function fmtDay(date: string, lang: Lang): string {
  return dateFormat(lang, 'day').format(new Date(toMs(`${date}T00:00`)));
}

export const fmtWindow = (w: Window): string => `${fmtTime(w.start)}–${fmtTime(w.end)}`;

/**
 * `⭐⭐⭐⭐` quand c'est propre, `☆☆☆` sous l'onshore, comme l'or et le blanc du site. `0★` à zéro :
 * le site n'affiche rien, et un point seul se lirait comme un bug.
 */
export const starsText = (stars: number, clean: boolean): string => (stars === 0 ? '0★' : starGlyphs({ stars, clean }));
/** Forme courte pour les rangées à largeur fixe : `4⭐`, `3☆`, `0★`. */
const starsShort = (stars: number, clean: boolean): string => `${stars}${stars === 0 ? '★' : clean ? '⭐' : '☆'}`;
/** En dessous, un spot ne mérite pas sa rangée dans la vue 📋 : zéro étoile de toute la journée. */
const DAY_VIEW_MIN_STARS = 1;
const cardinal = (deg: number, s: Strings): string => s.cardinal[cardinal8(deg)];

/**
 * Le spot derrière un id de rapport : parmi les spots curatés du contexte, sinon parmi les spots importés.
 * Les rapports ne gardent que des ids ; sans ce repli, un spot importé perdait son nom, son bouton 📍 et sa
 * commande dans `/all`. Toute lecture d'un spot par son id dans un message passe par ici.
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

/** La houle dirigée vers le spot, au 0,1 m comme sur surf-forecast : `2.1` ou `1.8–2.1`. */
function heightRange(hours: SpotHour[]): string {
  const ms = hours.map((h) => Math.round(h.heightM * 10) / 10);
  const min = Math.min(...ms);
  const max = Math.max(...ms);
  return min === max ? min.toFixed(1) : `${min.toFixed(1)}–${max.toFixed(1)}`;
}

/** Les étoiles du meilleur créneau d'une fenêtre, dans la couleur de cette heure-là. */
function windowStars(r: SpotResult | undefined, w: Window): string {
  const h = r ? peakHour(r, w) : undefined;
  return h ? starsText(h.score, h.clean) : `${w.peak}★`;
}

/** L'état du vent tel que surf-forecast le nomme : glassy, offshore, cross-offshore, cross-shore, cross-onshore, onshore. */
const stateText = (h: SpotHour, s: Strings): string => s.windStates[h.windState];

function windText(h: SpotHour, s: Strings): string {
  if (h.windState === 'glassy') return stateText(h, s);
  return `${stateText(h, s)} ${cardinal(h.windDirDeg, s)} ${Math.round(h.windKt)} kt`;
}

/** Vent à l'heure du pic, « puis <état> » si la fin de fenêtre change d'état. */
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

/** 🌡️ l'eau du jour au spot et la combinaison qui va avec ; rien quand la mer n'a pas donné de température. */
function waterLine(r: SpotResult | undefined, s: Strings): string | undefined {
  if (r?.waterTempC === undefined) return undefined;
  return fill(s.water, { temp: r.waterTempC, suit: s.suits[wetsuitFor(r.waterTempC)] });
}

/**
 * Les deux lignes de graphe d'un spot : règle des heures, puis une note par heure. Une seule
 * définition pour le verdict et pour la vue 📋 — les deux doivent tracer exactement la même journée.
 * `<code>` ligne à ligne plutôt qu'un bloc `<pre>` : sur téléphone, Telegram enferme un `<pre>` dans
 * un conteneur défilant avec bouton copier qui rognait la dernière colonne de la règle.
 * Sans indentation, comme le titre du spot : les 3 espaces des lignes de conditions sont en police
 * proportionnelle et n'alignent rien ici, et chaque caractère gagné éloigne le rognage sur mobile.
 * Chaque ligne dit ce qu'elle trace — 🕐 les heures, 🌊 le niveau de chaque heure, ⭐ les heures à étoiles jaunes (`━`,
 * au moins une étoile et pas d'onshore) —, emoji hors du `<code>` : des emojis de même largeur devant chaque ligne gardent
 * la règle alignée sur la courbe. Pas de ligne ⭐ un jour sans étoile jaune : une ligne de points n'apprendrait rien.
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
 * `sameSpotAbove` pour le second créneau d'un 🟡 sur le même spot : le graphe et l'eau valent pour toute la
 * journée, donc les redonner sous « après le travail » répéterait les lignes du dessus à l'identique.
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

function runnerUp(report: Report, excludeId: string, ctx: RenderCtx, s: Strings): string[] {
  const r = report.spots
    .filter((x) => x.spotId !== excludeId && x.best)
    .sort((a, b) => (b.best?.peak ?? 0) - (a.best?.peak ?? 0))[0];
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

/** La note de base surf-forecast d'une heure, 0..10 : ce que la houle seule permettrait. */
const baseOf = (h: SpotHour): number => h.factors.swell * 10;

/** Ce que le vent retire à la houle de cette heure, en étoiles avant arrondi. */
const windCost = (h: SpotHour): number => rawStars(baseOf(h), 1) - rawStars(baseOf(h), h.factors.wind);

/**
 * Pourquoi un 🔴 : à la meilleure heure surfable du spot, ce qui retient les étoiles. Le vent s'il en
 * coûte au moins une, la houle sinon — c'est alors elle qui plafonne. Comparer les deux facteurs
 * entre eux ne marchait pas : `swell` est une note de base ramenée sur 0..1, pas une pénalité, et
 * 2,2 m (0,37) passait pour pire qu'un offshore à 41 km/h (×0,54) qui coûtait deux étoiles.
 * L'orage est nommé quand il est la seule chose qui ait tenu les heures de jour à zéro, la nuit quand
 * il n'y a aucune heure de jour.
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
 * Un message de verdict est une suite de blocs separes par une ligne vide : le titre, puis un bloc
 * par spot (ses lignes de conditions et son graphe). Tout colle sinon, et on ne voit plus quelle
 * courbe appartient a quel spot.
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
      const best = v.bestSpotId ? report.spots.find((x) => x.spotId === v.bestSpotId) : undefined;
      // Un rouge a deux causes distinctes : rien d'assez bon, ou bien une fenetre assez bonne mais
      // trop courte (ou tombant en plein travail). Dire « rien ≥ 4★ » puis afficher « ★★★★ »
      // juste en dessous se contredirait a l'ecran.
      const tooShort = (best?.maxScore ?? 0) >= SCORING.good;
      const top = best && [...best.hours].sort((a, b) => b.score - a.score)[0];
      // l'eau du meilleur spot aussi : on peut vouloir y aller quand même, et /now doit la dire quel que soit le verdict
      const water = waterLine(best, s);
      push(
        fill(tooShort ? s.verdict.redTooShort : s.verdict.redBody, { radius: report.radiusKm, good: SCORING.good }),
        ...(best ? [fill(s.verdict.redBest, { spot: spotName(best.spotId, ctx, s), stars: starsText(best.maxScore, top?.clean ?? true), reason: lowestFactorReason(best, s) })] : []),
        ...(water ? [water] : []),
      );
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
  // le matin, juste avant d'y aller : quelle combinaison prendre
  const water = waterLine(r, s);
  if (!delta.changed) return [fill(s.morning.confirmed, { verdict: renderShortVerdict(morning, ctx) }), ...(water ? [water] : [])].join('\n');
  const lines = [fill(s.morning.changed, { from: renderShortVerdict(evening, ctx), to: renderShortVerdict(morning, ctx) })];
  if (pick && r) lines.push(conditionsLine(r, pick.window, morning, s));
  if (water) lines.push(water);
  if (delta.cause) lines.push(fill(s.morning.cause, { cause: s.causes[delta.cause] }));
  return lines.join('\n');
}

// ---- 🔥 l'alerte de midi ------------------------------------------------------------------------

/**
 * Les grosses journées à J+2 ou J+3, dans l'ordre des dates : pour chacune son titre et le bloc du spot tel que
 * le soir le montrera, puis de quoi s'organiser. Le runner ne passe que des 🟢 epic ; un rapport sans créneau
 * est sauté plutôt que rendu vide.
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

// ---- 📅 la semaine à venir ----------------------------------------------------------------------

/** À partir de combien de jours après aujourd'hui une prévision n'est plus qu'une tendance. */
export const WEEK_TREND_FROM_DAYS = 4;

export interface WeekOptions { today: string }

/** Ce qu'un jour a de mieux : le créneau du verdict s'il y en a un, sinon le spot le mieux noté. */
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
  // le verdict a déjà choisi le meilleur spot : une seule règle de départage, pas deux qui divergent
  const top = v.bestSpotId ? report.spots.find((x) => x.spotId === v.bestSpotId) : undefined;
  if (!top || top.maxScore === 0) return undefined;
  return { spotId: top.spotId, stars: top.maxScore, clean: peakHour(top)?.clean ?? true, emoji: '🔴' };
}

/**
 * La semaine en une ligne par jour, le meilleur jour en tête. Chaque jour porte le verdict que le soir
 * donnerait (heures de travail, règle du week-end), avec le libellé court du spot pour tenir sur une
 * ligne de téléphone ; le meilleur jour, lui, nomme le spot en entier. Au-delà de quelques jours ce
 * n'est qu'une tendance : une ligne de pied le dit plutôt que de laisser croire à la même précision.
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
  // le plus d'étoiles, le plus tôt à égalité : un tri stable garde l'ordre des jours
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

/** Un facteur n'est nommé que s'il pèse au moins une étoile à lui seul — la même règle que la raison d'un 🔴. */
const MIN_EXPLAINED_STARS = 1;

/**
 * Les étoiles ne dépendent que du vent et de la houle, et la houle à la cellule du spot bouge d'heure en
 * heure autant que le vent : les deux se citent. La marée et la période ne pèsent pas sur la note,
 * les nommer mentirait. La lumière, elle, dit quand la session s'arrête. Chaque raison arrive déjà formulée,
 * avec les étoiles qu'elle pèse : on garde les deux plus lourdes.
 */
const explain = (effects: [phrase: string, stars: number][]): string[] =>
  effects
    .filter(([, stars]) => stars >= MIN_EXPLAINED_STARS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([phrase]) => phrase);

/** Les six états de vent du plus propre au pire, comme sur surf-forecast. */
const STATE_RANK: Record<WindState, number> = { glassy: 0, off: 1, 'cross-off': 2, cross: 3, 'cross-on': 4, on: 5 };

/**
 * Le vent se cite par ce qui a changé. Quand il est moins propre ailleurs dans la journée, c'est son état qui coûte :
 * une brise onshore plus faible retire quand même des étoiles, et « le vent forcit » ou « le vent tombe » mentiraient.
 * Sinon, c'est sa force.
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
 * Pourquoi le pic est le meilleur moment : combien d'étoiles il perdrait si ce seul facteur tombait à sa
 * valeur la moins favorable de la journée tracée, l'autre restant celui du pic.
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
 * Ce qui fait retomber la note entre le pic et l'heure où elle s'effondre : le seul vent de cette heure
 * appliqué au pic, la seule houle de cette heure, ou la nuit qui ramène tout à zéro. Formulé depuis
 * l'heure de la chute.
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
  // avec une fenêtre, le créneau ; sans fenêtre, les étoiles du jour — sinon l'en-tête ne chiffrait rien
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
 * Spot du verdict d'abord, puis les autres spots du meilleur au moins bon. C'est l'ordre
 * des lignes de `renderDayView` ; le routeur s'en sert pour que la liste de commandes de `/all`
 * suive exactement les lignes affichées au-dessus (une seule définition, pas deux qui dérivent).
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
 * Les spots d'une vue 📋 — ou de `/all` avec `all` —, dans l'ordre de leurs lignes : le spot du verdict, puis les
 * rangées (au moins une étoile dans la journée ; pour `/all`, toutes jusqu'à `ALL_SPOTS_CAP`). Les rangées de
 * `renderDayView` et les boutons de spots qui les suivent (`spotDayRows`) en dérivent tous les deux : une seule
 * définition, jamais deux listes qui divergent.
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
 * Boutons 🙋 : `go:<aammjj>:<spot>` et `nogo:<aammjj>`. La date perd siècle et tirets pour que les ids importés les plus
 * longs tiennent dans les 64 octets qu'un bouton Telegram accepte — un seul bouton trop long et Telegram refuse le
 * message entier, donc l'envoi du soir à tout un groupe.
 */
const CALLBACK_DATA_MAX_BYTES = 64;
const compactDate = (date: string): string => date.slice(2).replace(/-/g, '');
/** `aammjj` → `AAAA-MM-JJ`, ou `undefined` pour tout ce qui n'en a pas la forme. */
export const expandCompactDate = (compact: string): string | undefined =>
  /^\d{6}$/.test(compact) ? `20${compact.slice(0, 2)}-${compact.slice(2, 4)}-${compact.slice(4, 6)}` : undefined;
export const notGoingData = (date: string): string => `nogo:${compactDate(date)}`;

/** Le bouton 🙋 d'un spot pour un jour : seulement pour un spot connu, et si ses données tiennent dans un bouton Telegram. */
function goingRow(date: string, spotId: string | undefined, ctx: RenderCtx): InlineButton[] | undefined {
  if (spotId === undefined || !spotById(spotId, ctx)) return undefined;
  const data = `go:${compactDate(date)}:${spotId}`;
  if (new TextEncoder().encode(data).length > CALLBACK_DATA_MAX_BYTES) return undefined;
  const s = STRINGS[ctx.lang];
  return [{ text: fill(s.buttons.going, { spot: spotShort(spotId, ctx, s) }), callback_data: data }];
}

/**
 * Un bouton 🙋 par spot que le message propose — le 🟢, l'aube et le soir d'un 🟡 — ou nomme : le meilleur spot d'un 🔴,
 * pour qui veut y aller quand même, quand le message le cite (`redBestNamed`). Dans l'ordre du message.
 */
function goingRows(report: Report, ctx: RenderCtx, redBestNamed: boolean): InlineButton[][] {
  const v = report.verdict;
  const picks = v.kind === 'green' ? [v.spotId] : v.kind === 'yellow' ? [v.dawn?.spotId, v.dusk?.spotId] : v.kind === 'red' && redBestNamed ? [v.bestSpotId] : [];
  return [...new Set(picks)].map((spotId) => goingRow(report.date, spotId, ctx)).filter((row): row is InlineButton[] => row !== undefined);
}

/** Rows → `undefined` rather than `{ inline_keyboard: [] }` — Telegram rejects an empty keyboard. */
const toMarkup = (rows: InlineButton[][]): ReplyMarkup | undefined => (rows.length > 0 ? { inline_keyboard: rows } : undefined);

/**
 * 📍 "go to this spot" map buttons — one row per button (spot names are long). Opens Google's documented
 * URL API (`/maps/search/?api=1&query=<lat>,<lon>`), which opens the Google Maps app on iOS/Android and
 * falls back to the browser; Telegram's `url` button only accepts http(s), so a `geo:` URI is not an option.
 *
 * `opts.spotId` (a per-spot command, e.g. `/long_beach`): exactly that spot's button, unconditionally —
 * even at 0★, and even absent from `report.spots` entirely (looked up with `spotById`: curated, then imported).
 * Otherwise: one button per *interesting* spot — a spot whose day has a window (`SpotResult.best` set,
 * the existing `SCORING.windowMin` threshold via `evaluateSpot`/`findWindows`) — ordered by `best.peak`
 * descending, capped at 5 so the keyboard stays usable. Possibly `[]`.
 */
export function goButtons(report: Report, ctx: RenderCtx, opts: { spotId?: string } = {}): InlineButton[][] {
  const s = STRINGS[ctx.lang];
  const row = (spotId: string): InlineButton[] | undefined => {
    const spot = spotById(spotId, ctx);
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

/**
 * `/<spot>` : le 🙋 de ce spot pour le jour affiché — quel que soit le verdict, l'ami regarde ce spot-là —, puis son 📍.
 * `spotById` doit le connaître : un spot importé est ajouté au contexte par l'appelant ou retrouvé par son id.
 */
export function spotMarkupFor(report: Report, spotId: string, ctx: RenderCtx): ReplyMarkup | undefined {
  const going = goingRow(report.date, spotId, ctx);
  return toMarkup([...(going ? [going] : []), ...goButtons(report, ctx, { spotId })]);
}

/**
 * 📋 et `/all` : un bouton par spot montré, dans l'ordre des rangées (`dayViewSpotOrder`), deux par ligne, qui ouvre sa
 * journée comme sa commande. Le libellé porte les étoiles du jour quand il y en a. Un spot dont les données dépasseraient
 * les 64 octets d'un bouton Telegram reste sans bouton plutôt que de faire refuser le message entier.
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
 * La fin de la vue 📋 — ou de `/all` avec `all` — : Telegram ne rend pas cliquable une commande dans un `<code>`, donc les
 * rangées de spots ne s'ouvrent pas d'un appui ; un bouton par spot le fait, annoncé par une ligne. `/all` garde ensuite
 * ses 📍 vers les spots à créneau. Sans spot, ni ligne ni bouton de spot.
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
 * the 🙋 going buttons, then go buttons (own rows — spot names are long), then the 📋 row. Pas de verdict (hors-couverture,
 * pas de données) → pas de bouton 📋 : le panneau qu'il ouvrirait serait fabriqué (§9) — and in practice
 * those reports never carry `spots` either, so no go buttons show there anyway. `redBestNamed: false` pour un message qui
 * ne cite pas le meilleur spot d'un 🔴 (le matin) : pas de 🙋 vers un spot absent du texte.
 */
export function detailsMarkupFor(report: Report, ctx: RenderCtx, opts: { redBestNamed?: boolean } = {}): ReplyMarkup | undefined {
  const hasDetails = report.verdict.kind === 'green' || report.verdict.kind === 'yellow' || report.verdict.kind === 'red';
  const rows = [...goingRows(report, ctx, opts.redBestNamed ?? true), ...goButtons(report, ctx), ...(hasDetails ? [detailsButtonRow(report.date, ctx.lang)] : [])];
  return toMarkup(rows);
}
