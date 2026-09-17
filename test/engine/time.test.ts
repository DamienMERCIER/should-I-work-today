import { describe, it, expect } from 'vitest';
import {
  toMs, fromMs, addHours, addDays, hoursBetween, dateOf, hhmm, atTime, isWeekend, nowLocal, floorHour,
} from '../../src/engine/time';

describe('time helpers (local wall-clock strings)', () => {
  it('round-trips through ms', () => {
    expect(fromMs(toMs('2026-09-16T07:00'))).toBe('2026-09-16T07:00');
  });
  it('rejects garbage', () => {
    expect(() => toMs('yesterday')).toThrow(/Invalid local time/);
  });
  it('reads every shape the engine uses the way Date.parse always did — the digits are read directly on the hot path', () => {
    const iso = (t: string): string => new Date(toMs(t)).toISOString();
    expect(iso('2024-02-29T12:30')).toBe('2024-02-29T12:30:00.000Z');
    expect(iso('2026-09-31T00:00')).toBe('2026-10-01T00:00:00.000Z'); // one day too many overflows, as before
    expect(iso('2026-09-16T24:00')).toBe('2026-09-17T00:00:00.000Z');
    expect(iso('2026-09-16T07:00:30')).toBe('2026-09-16T07:00:30.000Z');
    expect(iso('2026-09-16')).toBe('2026-09-16T00:00:00.000Z');
    expect(toMs('0001-01-01T00:00')).toBe(-62135596800000); // not the year 1901 that Date.UTC would give
    expect(() => toMs('2026-13-01T00:00')).toThrow(/Invalid local time/);
    expect(() => toMs('2026-09-16T23:60')).toThrow(/Invalid local time/);
    expect(() => toMs('2026-09-00T00:00')).toThrow(/Invalid local time/);
  });
  it('adds hours across midnight', () => {
    expect(addHours('2026-09-16T23:00', 2)).toBe('2026-09-17T01:00');
  });
  it('adds days', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-09-16', -1)).toBe('2026-09-15');
  });
  it('measures fractional hours', () => {
    expect(hoursBetween('2026-09-16T07:00', '2026-09-16T09:30')).toBe(2.5);
  });
  it('extracts parts', () => {
    expect(dateOf('2026-09-16T07:00')).toBe('2026-09-16');
    expect(hhmm('2026-09-16T07:05')).toBe('07:05');
    expect(atTime('2026-09-16', '09:00')).toBe('2026-09-16T09:00');
    expect(floorHour('2026-09-16T07:45')).toBe('2026-09-16T07:00');
  });
  it('knows weekends (2026-09-19 is a Saturday, 2026-09-16 a Wednesday)', () => {
    expect(isWeekend('2026-09-19')).toBe(true);
    expect(isWeekend('2026-09-20')).toBe(true);
    expect(isWeekend('2026-09-16')).toBe(false);
  });
  it('converts a UTC instant to SAST wall-clock', () => {
    expect(nowLocal(Date.UTC(2026, 8, 15, 17, 0))).toBe('2026-09-15T19:00');
  });
});
