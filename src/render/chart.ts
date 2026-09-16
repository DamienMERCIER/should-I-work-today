import { daylightFactor } from '../engine/factors';
import type { Report } from '../types';

/** Longest day we ever plot — keeps a phone-width `<pre>` block readable (§ design doc). */
const MAX_CHART_HOURS = 14;

const pad2 = (h: number): string => String(h).padStart(2, '0');
const slotAt = (date: string, h: number): string => `${date}T${pad2(h)}:00`;

/** Every hour of `date` whose slot has ≥ 45 min of daylight (same rule the engine scores on). */
function daylightHours(report: Report): number[] {
  const { date } = report;
  const hours: number[] = [];
  for (let h = 0; h < 24; h++) {
    if (daylightFactor(slotAt(date, h), report.sun.sunrise, report.sun.sunset) === 1) hours.push(h);
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
 * Sparkline glyph bands. `·` marks a dead/dark hour (score ≤ 0.05); otherwise the
 * 0–10 score range is split into 8 equal 1.25-point bands mapped onto ▁▂▃▄▅▆▇█
 * (▁ = lowest non-dead band, █ = 8.75–10).
 */
const BLOCKS = '▁▂▃▄▅▆▇█';
const BAND_WIDTH = 10 / BLOCKS.length;

function glyphFor(score: number): string {
  if (score <= 0.05) return '·';
  const level = Math.min(BLOCKS.length - 1, Math.floor(score / BAND_WIDTH));
  return BLOCKS[level];
}

/** One glyph per hour, no separator — 1 character/hour so the block fits a phone screen (§ defect 1). */
export function sparkline(scores: number[]): string {
  return scores.map(glyphFor).join('');
}

/**
 * The ruler line above a sparkline: every third hour (array index 0, 3, 6, …) is labelled, written
 * into a 1-character-per-hour grid so the label for `hours[i]` starts at character index `i` —
 * lining up with that hour's glyph in the sparkline (glyph `i` also sits at character `i`, since
 * `sparkline` now joins single-character glyphs with no separator). A label can be 2 characters
 * wide (e.g. "16"); it spills into the next column, which is otherwise blank since labelled
 * indices are 3 apart (e.g. "7  10 13 16" for 7..17). A label that would run past the last
 * column is dropped rather than truncated or shifted: the ruler must never be wider than the
 * sparkline it sits above, and a shifted label would read as one number glued to the previous
 * one ("1417"). Reachable on real dates — a 10-hour Cape Town midwinter day labels index 9.
 */
export function hourRuler(hours: number[]): string {
  let ruler = ' '.repeat(hours.length);
  hours.forEach((h, i) => {
    if (i % 3 !== 0) return;
    const label = String(h);
    if (i + label.length > hours.length) return;
    ruler = ruler.slice(0, i) + label + ruler.slice(i + label.length);
  });
  return ruler.trimEnd();
}
