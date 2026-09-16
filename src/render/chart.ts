import { toMs } from '../engine/time';
import type { Report } from '../types';

/** Longest day we ever plot — keeps a phone-width chart readable (§ design doc). */
const MAX_CHART_HOURS = 14;

const pad2 = (h: number): string => String(h).padStart(2, '0');
const slotAt = (date: string, h: number): string => `${date}T${pad2(h)}:00`;

/**
 * Toute heure du jour dont le créneau touche la lumière, même partiellement. Le moteur, lui, ne
 * note que les créneaux qui ont ≥ 45 min de jour : on trace donc une colonne de plus de chaque
 * côté, à zéro, ce qui montre où la journée s'ouvre et se ferme plutôt que de couper net.
 */
function daylightHours(report: Report): number[] {
  const { date } = report;
  const sunrise = toMs(report.sun.sunrise);
  const sunset = toMs(report.sun.sunset);
  const hours: number[] = [];
  for (let h = 0; h < 24; h++) {
    const start = toMs(slotAt(date, h));
    if (Math.min(start + 3_600_000, sunset) > Math.max(start, sunrise)) hours.push(h);
  }
  return hours;
}

/** Best score across every spot at hour `h` — used only to find the "busiest" part of a long day. */
function bestScoreAt(report: Report, h: number): number {
  const time = slotAt(report.date, h);
  return report.spots.reduce((best, r) => {
    const hour = r.hours.find((x) => x.time === time);
    return hour ? Math.max(best, hour.score) : best;
  }, 0);
}

/**
 * The hours to plot on the day's chart: every daylight-scored hour, capped at
 * `MAX_CHART_HOURS`. Midsummer days (~14.5 h of daylight) can exceed the cap; when they
 * do, the window is centred on the hour with the best score anywhere in the report
 * (clamped so it never runs past either end of the daylight range).
 */
export function chartHours(report: Report): number[] {
  const all = daylightHours(report);
  if (all.length <= MAX_CHART_HOURS) return all;

  const lo = all[0];
  const hi = all[all.length - 1] + 1; // exclusive
  const peak = all.reduce((best, h) => (bestScoreAt(report, h) > bestScoreAt(report, best) ? h : best), all[0]);

  let start = peak - Math.floor(MAX_CHART_HOURS / 2);
  let end = start + MAX_CHART_HOURS;
  if (start < lo) {
    end += lo - start;
    start = lo;
  }
  if (end > hi) {
    start -= end - hi;
    end = hi;
  }
  return all.filter((h) => h >= start && h < end);
}

/**
 * Une barre par étoile : `·` à 0, puis ▁▂▃▄▅▆▇ de 1★ à 7★, █ à partir de 8★. Les notes sont des étoiles
 * entières (`src/engine/rating.ts`) ; découper 0..10 en huit tranches égales donnait le même glyphe à
 * 5★ et 6★, justement là où se joue la différence entre une bonne journée et une journée exceptionnelle.
 */
const BLOCKS = '▁▂▃▄▅▆▇█';

function glyphFor(stars: number): string {
  if (stars <= 0) return '·';
  return BLOCKS[Math.min(BLOCKS.length, Math.max(1, Math.round(stars))) - 1];
}

/** One glyph per hour, no separator — 1 character/hour so the block fits a phone screen (§ defect 1). */
export function sparkline(scores: number[]): string {
  return scores.map(glyphFor).join('');
}

/**
 * La règle au-dessus d'un sparkline, sur une grille d'un caractère par heure : le repère de
 * `hours[i]` commence au caractère `i`, donc au-dessus de son glyphe. La première et la dernière
 * heure sont toujours écrites, et les repères intermédiaires (tous les 3) ne sont posés que s'ils
 * gardent une colonne vide de chaque côté. Un repère à deux chiffres sur la dernière colonne fait
 * dépasser la règle d'un caractère : c'est voulu, rien ne s'aligne sur son bord droit, et l'heure
 * de fin de journée compte plus qu'un bord net.
 */
export function hourRuler(hours: number[]): string {
  const width = hours.length + 2; // un repère à deux chiffres sur la dernière colonne déborde d'un cran
  const cells = Array.from({ length: width }, () => ' ');
  const place = (i: number, label: string): boolean => {
    if (i < 0 || i + label.length > width) return false;
    for (let k = i - 1; k <= i + label.length; k++) if (k >= 0 && k < width && cells[k] !== ' ') return false;
    for (let k = 0; k < label.length; k++) cells[i + k] = label[k];
    return true;
  };
  place(0, String(hours[0]));
  if (hours.length > 1) place(hours.length - 1, String(hours[hours.length - 1]));
  for (let i = 3; i < hours.length - 1; i += 3) place(i, String(hours[i]));
  return cells.join('').trimEnd();
}


