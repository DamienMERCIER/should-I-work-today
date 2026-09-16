import { describe, it, expect } from 'vitest';
import {
  esc, fmtTime, fmtDate, renderEvening, renderShortVerdict, renderMorning, renderDetails, detailsButton, detailsMarkupFor, type RenderCtx,
} from '../../src/render/messages';
import { SPOTS } from '../../src/data/index';
import type { Report, Verdict } from '../../src/types';
import { GOLDEN_DATE, goldenReport } from '../helpers/golden';

const spots = new Map(SPOTS.map((s) => [s.id, s]));
const EN: RenderCtx = { lang: 'en', spots };
const RU: RenderCtx = { lang: 'ru', spots };
const W = (s: string, e: string, peak: number) => ({ start: `${GOLDEN_DATE}T${s}`, end: `${GOLDEN_DATE}T${e}`, peak, mean: peak });
const KOM = "Kommetjie – Long Beach";
const MUIZ = "Muizenberg – Surfer's Corner";

describe('formatting', () => {
  it('fmtTime', () => {
    expect(fmtTime('07:00')).toBe('7:00');
    expect(fmtTime('2026-09-16T09:40')).toBe('9:40');
  });
  it('fmtDate', () => {
    expect(fmtDate('2026-09-16', 'en')).toBe('Wed 16 Sept');
    expect(fmtDate('2026-09-16', 'ru')).toContain('16 сент.');
  });
  it('esc', () => {
    expect(esc('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
  it('detailsButton', () => {
    expect(detailsButton(GOLDEN_DATE, 'en')).toEqual({ inline_keyboard: [[{ text: '📋 All spots', callback_data: 'rep:2026-09-16' }]] });
  });
  it('detailsMarkupFor only attaches the 📋 button when there is a verdict', () => {
    expect(detailsMarkupFor(goldenReport(), 'en')).toEqual({ inline_keyboard: [[{ text: '📋 All spots', callback_data: 'rep:2026-09-16' }]] });
    expect(detailsMarkupFor(goldenReport({ spots: [], tides: [], verdict: { kind: 'outOfCoverage', nearest: [] } }), 'en')).toBeUndefined();
    expect(detailsMarkupFor(goldenReport({ verdict: { kind: 'noData', reason: 'x' } }), 'en')).toBeUndefined();
  });
});

describe('renderEvening — golden 🟢', () => {
  it('EN', () => {
    expect(renderEvening(goldenReport(), EN)).toBe(
      [
        "🟢 <b>DON'T GO TO WORK TOMORROW</b> (Wed 16 Sept)",
        `🏄 ${KOM} · 7:00–12:00 · 8.6/10`,
        '   4 ft · SW 10 s · offshore SE 8 kt · incoming tide, high 9:00',
        '   ☀️ 22° · sunrise 6:44',
      ].join('\n'),
    );
  });
  it('RU', () => {
    const lines = renderEvening(goldenReport(), RU).split('\n');
    expect(lines[0]).toContain('ЗАВТРА НЕ ИДИ НА РАБОТУ');
    expect(lines[0]).toContain('16 сент.');
    expect(lines[1]).toBe(`🏄 ${KOM} · 7:00–12:00 · 8.6/10`);
    expect(lines[2]).toBe('   4 ft · ЮЗ 10 с · оффшор ЮВ 8 kt · прилив, полная 9:00');
  });
  it('adds the epic suffix, the weekend and now titles', () => {
    const r = goldenReport();
    const epic: Verdict = { ...(r.verdict as Extract<Verdict, { kind: 'green' }>), epic: true };
    expect(renderEvening({ ...r, verdict: epic }, EN).split('\n')[0]).toBe("🟢 <b>DON'T GO TO WORK TOMORROW</b> (Wed 16 Sept) — it's firing");
    expect(renderEvening({ ...r, date: '2026-09-19' }, EN).split('\n')[0]).toBe('🟢 <b>GO SURF TOMORROW</b> (Sat 19 Sept)');
    expect(renderEvening({ ...r, mode: 'now' }, EN).split('\n')[0]).toBe('🟢 <b>GO SURF</b> (today)');
  });
  it('mentions rain when ≥ 1 mm', () => {
    const r = goldenReport({ weather: { tempMaxC: 17.6, tempMinC: 12, precipMm: 4.6, code: 61 } });
    expect(renderEvening(r, EN).split('\n')[3]).toBe('   ☀️ 18° · sunrise 6:44 · rain 5 mm');
  });
  it('shows a 🥈 runner-up when another open spot has a window', () => {
    const r = goldenReport();
    const muiz = r.spots.find((x) => x.spotId === 'muizenberg')!;
    muiz.windows = [W('07:00', '09:00', 6.5)];
    muiz.best = muiz.windows[0];
    const lines = renderEvening(r, EN).split('\n');
    expect(lines[4]).toBe(`🥈 ${MUIZ} · 7:00–9:00 · 6.5/10`);
    expect(lines[5]).toBe('   3 ft · onshore SE 8 kt');
  });
  it('mentions the wind change at the end of the window', () => {
    const r = goldenReport();
    const kom = r.spots.find((x) => x.spotId === 'kommetjie-long-beach')!;
    kom.hours.find((h) => h.time === `${GOLDEN_DATE}T11:00`)!.windRelation = 'onshore';
    expect(renderEvening(r, EN).split('\n')[2]).toBe('   4 ft · SW 10 s · offshore SE 8 kt then onshore · incoming tide, high 9:00');
  });
});

describe('renderEvening — other verdicts', () => {
  it('🔴 names the best spot and its weakest factor', () => {
    const r = goldenReport({ verdict: { kind: 'red', bestSpotId: 'muizenberg' } });
    expect(renderEvening(r, EN)).toBe(
      ['🔴 <b>GO TO WORK TOMORROW</b> (Wed 16 Sept)', 'Nothing ≥ 7/10 within 20 km.', `Best: ${MUIZ} 3.3/10 (2.5 ft)`].join('\n'),
    );
  });
  it('🌅 dawn block', () => {
    const r = goldenReport({ verdict: { kind: 'yellow', dawn: { spotId: 'muizenberg', window: W('07:00', '09:00', 7.2) } } });
    const lines = renderEvening(r, EN).split('\n');
    expect(lines[0]).toBe('🌅 <b>DAWN PATROL, THEN WORK</b> (Wed 16 Sept)');
    expect(lines[1]).toBe(`🏄 ${MUIZ} · 7:00–9:00 · 7.2/10`);
    expect(lines[2]).toBe('   3 ft · SW 10 s · onshore SE 8 kt · incoming tide, high 9:00');
  });
  it('out of coverage with raw conditions and nearest spots', () => {
    const r = goldenReport({
      spots: [], tides: [],
      verdict: { kind: 'outOfCoverage', raw: { swellHeightM: 1.8, periodS: 12, swellDirDeg: 225, windKt: 14, windDirDeg: 315 }, nearest: [{ spotId: 'victoria-bay', distanceKm: 38.2 }] },
    });
    expect(renderEvening(r, EN)).toBe(
      ['📍 No known spot within 20 km.', 'Raw conditions here: swell 1.8 m 12 s SW · wind 14 kt NW', 'Nearest known spots: ≈ Victoria Bay (38 km)'].join('\n'),
    );
  });
  it('far from the coast: no raw conditions', () => {
    const r = goldenReport({ spots: [], tides: [], verdict: { kind: 'outOfCoverage', nearest: [{ spotId: 'durban-new-pier', distanceKm: 512 }] } });
    expect(renderEvening(r, EN).split('\n')[1]).toBe('You are far from the ocean — the nearest known spot is more than 150 km away.');
  });
  it('noData', () => {
    expect(renderEvening(goldenReport({ verdict: { kind: 'noData', reason: 'x' } }), EN)).toBe('⚠️ No data (Open-Meteo unreachable). Try /now later.');
  });
  it('RU out of coverage uses the localized distance unit', () => {
    const r = goldenReport({
      spots: [], tides: [],
      verdict: { kind: 'outOfCoverage', raw: { swellHeightM: 1.8, periodS: 12, swellDirDeg: 225, windKt: 14, windDirDeg: 315 }, nearest: [{ spotId: 'victoria-bay', distanceKm: 38.2 }] },
    });
    expect(renderEvening(r, RU).split('\n')[2]).toBe('Ближайшие известные споты: ≈ Victoria Bay (38 км)');
  });
});

describe('renderMorning', () => {
  const evening = goldenReport();
  it('confirmed', () => {
    expect(renderMorning(goldenReport({ mode: 'morning' }), { send: true, changed: false }, evening, EN)).toBe(`✅ Confirmed: 🟢 ${KOM} 7:00–12:00`);
  });
  it('changed with cause and the new conditions line', () => {
    const morning: Report = goldenReport({ mode: 'morning', verdict: { kind: 'green', spotId: 'kommetjie-long-beach', window: W('07:00', '11:00', 8.0), epic: false } });
    expect(renderMorning(morning, { send: true, changed: true, cause: 'wind' }, evening, EN)).toBe(
      [`⚠️ Change: 🟢 ${KOM} 7:00–12:00 → 🟢 ${KOM} 7:00–11:00`, '4 ft · SW 10 s · offshore SE 8 kt · incoming tide, high 9:00', 'cause: wind'].join('\n'),
    );
  });
  it('degraded to red', () => {
    const morning = goldenReport({ mode: 'morning', verdict: { kind: 'red', bestSpotId: 'kommetjie-long-beach' } });
    expect(renderMorning(morning, { send: true, changed: true }, evening, EN)).toBe(`⚠️ Change: 🟢 ${KOM} 7:00–12:00 → 🔴 go to work`);
  });
  it('noData keeps last night verdict', () => {
    const morning = goldenReport({ mode: 'morning', verdict: { kind: 'noData', reason: 'x' } });
    expect(renderMorning(morning, { send: true, changed: false }, evening, EN)).toBe(`⚠️ No data this morning — last night's verdict stands: 🟢 ${KOM} 7:00–12:00`);
  });
  it('short verdict of a missing report is red', () => {
    expect(renderShortVerdict(undefined, EN)).toBe('🔴 go to work');
  });
});

describe('renderDetails', () => {
  it('lists open spots by peak, then tides, sun and licence', () => {
    expect(renderDetails(goldenReport(), EN)).toBe(
      [
        '📋 <b>All spots</b> (Wed 16 Sept)',
        `${KOM} · 7:00–12:00 · 8.6 · 4 ft · offshore SE 8 kt ↑`,
        `${MUIZ} · — · 3.3 · 3 ft · onshore SE 8 kt ↑`,
        'tide: low 3:00 · high 9:00 · low 15:00 · high 21:00',
        '☀️ 22° · sunrise 6:44 · sunset 18:38',
        'Data: Open-Meteo.com (CC-BY 4.0)',
      ].join('\n'),
    );
  });
  it('lists closed spots and uses "today" in now mode', () => {
    const r = goldenReport({ mode: 'now' });
    r.spots.push({ spotId: 'outer-kom', distanceKm: 14.5, open: false, hours: [], windows: [], maxScore: 0 });
    const lines = renderDetails(r, EN).split('\n');
    expect(lines[0]).toBe('📋 <b>All spots</b> (today)');
    expect(lines[3]).toBe('closed for your level: Kommetjie – Outer Kom');
  });
});
