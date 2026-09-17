import type { SwellHour, TideEvent, TideState, TideTrend } from '../types';
import { addDays, atTime, fromMs, toMs } from './time';

export interface TideInfo {
  states: Map<string, { state: TideState; trend: TideTrend }>;
  events: TideEvent[];
}

const HOUR_MS = 3_600_000;

/** Analysis window: day D−3h .. day D+24h+3h. */
export function tideWindow(date: string): { from: string; to: string } {
  return { from: atTime(addDays(date, -1), '21:00'), to: atTime(addDays(date, 1), '03:00') };
}

export function computeTide(series: SwellHour[], date: string): TideInfo {
  const { from, to } = tideWindow(date);
  const fromMs_ = toMs(from);
  const toMs_ = toMs(to);
  const pts = series
    .filter((h) => {
      const t = toMs(h.time);
      return t >= fromMs_ && t <= toMs_;
    })
    .map((h) => ({ time: h.time, y: h.seaLevelM }));

  const states = new Map<string, { state: TideState; trend: TideTrend }>();
  const events: TideEvent[] = [];
  if (pts.length < 2) return { states, events };

  const trendAt = (i: number): TideTrend => {
    const p = pts[i];
    const next = pts[i + 1];
    const prev = pts[i - 1];
    return next ? (next.y > p.y ? 'rising' : 'falling') : (prev && p.y > prev.y ? 'rising' : 'falling');
  };

  const ys = pts.map((p) => p.y);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const range = max - min;

  // Flat or nearly flat series (dead sensor, no tide): neutral rather than 'low' everywhere, and no events.
  if (range < 0.05) {
    pts.forEach((p, i) => states.set(p.time, { state: 'mid', trend: trendAt(i) }));
    return { states, events };
  }

  pts.forEach((p, i) => {
    const norm = (p.y - min) / range;
    const state: TideState = norm < 1 / 3 ? 'low' : norm > 2 / 3 ? 'high' : 'mid';
    states.set(p.time, { state, trend: trendAt(i) });
  });

  const dayStart = toMs(atTime(date, '00:00'));
  const dayEnd = dayStart + 24 * HOUR_MS;
  for (let i = 1; i < pts.length - 1; i++) {
    const y0 = pts[i - 1].y;
    const y1 = pts[i].y;
    const y2 = pts[i + 1].y;
    const isHigh = y1 > y0 && y1 >= y2;
    const isLow = y1 < y0 && y1 <= y2;
    if (!isHigh && !isLow) continue;
    // vertex of the parabola through (−1, y0), (0, y1), (1, y2)
    const denom = y0 - 2 * y1 + y2;
    const offsetH = denom === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom));
    const heightM = y1 - 0.25 * (y0 - y2) * offsetH;
    const t = toMs(pts[i].time) + offsetH * HOUR_MS;
    if (t < dayStart || t >= dayEnd) continue;
    events.push({ time: fromMs(t), kind: isHigh ? 'high' : 'low', heightM: Math.round(heightM * 100) / 100 });
  }
  return { states, events };
}
