import { describe, it, expect } from 'vitest';
import { chartHours, sparkline, hourRuler } from '../../src/render/chart';
import { makeHour, makeReport } from '../helpers/reports';
import type { Report, SpotResult } from '../../src/types';

const DATE = '2026-09-16';

const spotWith = (id: string, scoreAtHour: (h: number) => number): SpotResult => ({
  spotId: id, distanceKm: 0, open: true, windows: [], best: undefined,
  maxScore: Math.max(...Array.from({ length: 24 }, (_, h) => scoreAtHour(h))),
  hours: Array.from({ length: 24 }, (_, h) => makeHour(`${DATE}T${String(h).padStart(2, '0')}:00`, scoreAtHour(h))),
});

describe('sparkline', () => {
  it('shows a dead glyph for a score of exactly 0', () => {
    expect(sparkline([0])).toBe('·');
  });
  it('shows a dead glyph up to and including 0.05', () => {
    expect(sparkline([0.05])).toBe('·');
  });
  it('shows the lowest block just above the dead threshold', () => {
    expect(sparkline([0.06])).toBe('▁');
  });
  it('stays on the lowest block up to the first band boundary', () => {
    expect(sparkline([1.24])).toBe('▁');
  });
  it('moves to the second block exactly at 1.25 (10/8)', () => {
    expect(sparkline([1.25])).toBe('▂');
  });
  it('reaches the top block from 8.75', () => {
    expect(sparkline([8.75])).toBe('█');
  });
  it('clamps a perfect 10 to the top block', () => {
    expect(sparkline([10])).toBe('█');
  });
  it('joins one glyph per hour with no separator (1 char/hour)', () => {
    expect(sparkline([0, 10, 4])).toBe('·█▄');
  });
  it('is ≤ 34 characters for an 11-hour day', () => {
    const scores = [8.4, 9.7, 9.2, 5.0, 4.3, 3.7, 3.4, 3.3, 5.6, 5.4, 5.4];
    expect(sparkline(scores).length).toBeLessThanOrEqual(34);
  });
  it('is ≤ 34 characters for a 14-hour day', () => {
    const scores = Array.from({ length: 14 }, (_, i) => i % 10);
    expect(sparkline(scores).length).toBeLessThanOrEqual(34);
  });
});

describe('hourRuler', () => {
  const range = (start: number, end: number): number[] =>
    Array.from({ length: end - start + 1 }, (_, i) => start + i);

  it.each([
    ['8-hour day', 8],
    ['11-hour day', 11],
    ['14-hour day', 14],
  ])('aligns every label it writes on its own hour column, and never exceeds the sparkline (%s)', (_n, len) => {
    const hours = Array.from({ length: len }, (_, i) => 6 + i);
    const ruler = hourRuler(hours);
    expect(ruler.length).toBeLessThanOrEqual(hours.length + 2); // un repère à 2 chiffres sur la dernière colonne dépasse
    for (const m of ruler.matchAll(/\d+/g)) {
      expect(hours[m.index!]).toBe(Number(m[0]));
    }
  });

  it('always labels the first and the last hour (7..17)', () => {
    expect(hourRuler(range(7, 17))).toBe('7  10 13  17');
  });

  it('is ≤ 34 characters for an 11-hour day', () => {
    expect(hourRuler(range(7, 17)).length).toBeLessThanOrEqual(34);
  });
  it('is ≤ 34 characters for a 14-hour day', () => {
    expect(hourRuler(range(6, 19)).length).toBeLessThanOrEqual(34);
  });
});

describe('chartHours', () => {
  it('is 6..18 (13 h) on a September day (sunrise 6:44, sunset 18:38)', () => {
    const report = makeReport({ spots: [] });
    expect(chartHours(report)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });
  it('is capped at 14 h on a December day (sunrise 5:32, sunset 19:58)', () => {
    const report = makeReport({ spots: [], sun: { sunrise: `${DATE}T05:32`, sunset: `${DATE}T19:58` } });
    expect(chartHours(report)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });
  it('caps at 14 h, centred on the highest-scoring part of the day, when daylight would give more', () => {
    // sunrise 4:00 / sunset 21:00 → 17 raw daylight hours (4..20); scores peak at 16:00.
    const report: Report = makeReport({
      sun: { sunrise: `${DATE}T04:00`, sunset: `${DATE}T21:00` },
      spots: [spotWith('peaky', (h) => (h === 16 ? 9 : h >= 4 && h <= 20 ? 1 : 0))],
    });
    const hours = chartHours(report);
    expect(hours).toHaveLength(14);
    expect(hours).toContain(16);
    expect(hours).toEqual([...hours].sort((a, b) => a - b));
    hours.forEach((h) => expect(h).toBeGreaterThanOrEqual(4));
    hours.forEach((h) => expect(h).toBeLessThanOrEqual(20));
  });
  it.each([7, 8, 9, 10, 11, 12, 13, 14])('never overhangs its sparkline by more than a closing label (%i h)', (n) => {
    // un label à deux chiffres sur le dernier index labellisé débordait la grille
    const hours = Array.from({ length: n }, (_, i) => 6 + i);
    expect(hourRuler(hours).length).toBeLessThanOrEqual(hours.length + 2);
  });
  it('always writes the closing label, even when it overhangs the last column', () => {
    // 10 h (hiver au Cap : 8h→17h) : "17" tombe à l'index 9, il déborderait la grille
    expect(hourRuler([8, 9, 10, 11, 12, 13, 14, 15, 16, 17])).toBe('8  11 14 17');
    expect(hourRuler([6, 7, 8, 9, 10, 11, 12])).toBe('6  9  12');
  });

  it('still caps at 14 h when the day is entirely flat (deterministic, no crash)', () => {
    const report: Report = makeReport({
      sun: { sunrise: `${DATE}T04:00`, sunset: `${DATE}T21:00` },
      spots: [spotWith('flat', () => 0)],
    });
    expect(chartHours(report)).toHaveLength(14);
  });
});
