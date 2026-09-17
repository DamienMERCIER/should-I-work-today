import { toMs } from '../engine/time';
import type { Report } from '../types';

/** Longest day we ever plot — keeps a phone-width chart readable (§ design doc). */
const MAX_CHART_HOURS = 14;

const pad2 = (h: number): string => String(h).padStart(2, '0');
const slotAt = (date: string, h: number): string => `${date}T${pad2(h)}:00`;

/**
 * Every hour of the day whose slot touches daylight, even partially. The engine itself only
 * scores slots with ≥ 45 min of daylight: so we plot one extra column on each side, at zero,
 * which shows where the day opens and closes instead of cutting off abruptly.
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
 * One bar per star: `·` at 0, then ▁▂▃▄▅▆▇ from 1★ to 7★, █ from 8★ up. Scores are whole stars
 * (`src/engine/rating.ts`); splitting 0..10 into eight equal slices gave the same glyph to 5★
 * and 6★, exactly where the difference between a good day and an exceptional one is decided.
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
 * The ruler above a sparkline, on a grid of one character per hour: the label for
 * `hours[i]` starts at character `i`, so right above its glyph. The first and last
 * hour are always written, and the in-between labels (every 3) are only placed if they
 * keep an empty column on each side. A two-digit label on the last column makes the
 * ruler run one character past the edge: that's intentional, nothing aligns on its right
 * edge, and the end-of-day hour matters more than a clean border.
 */
export function hourRuler(hours: number[]): string {
  const width = hours.length + 2; // a two-digit label on the last column overflows by one notch
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


