import { describe, it, expect } from 'vitest';
import {
  esc, fmtTime, fmtDate, renderEvening, renderShortVerdict, renderMorning, renderDetails, renderSpotDay, renderDayView,
  detailsMarkupFor, goButtons, goButtonsMarkup, openSpotOrder, allSpotOrder, ALL_SPOTS_CAP, type RenderCtx,
} from '../../src/render/messages';
import { SPOTS } from '../../src/data/index';
import type { Report, SpotHour, SpotResult, TideTrend, Verdict, Window } from '../../src/types';
import { GOLDEN_DATE, goldenReport } from '../helpers/golden';
import { makeReport } from '../helpers/reports';

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
  it('detailsMarkupFor: go buttons (ordered by peak) then the 📋 row, for a verdict with windows', () => {
    expect(detailsMarkupFor(goldenReport(), EN)).toEqual({
      inline_keyboard: [
        [{ text: '📍 Go to Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
        [{ text: '📍 Go to Muizenberg', url: 'https://www.google.com/maps/search/?api=1&query=-34.1085%2C18.4715' }],
        [{ text: '📋 All spots', callback_data: 'rep:2026-09-16' }],
      ],
    });
  });
  it('detailsMarkupFor: a red verdict with no windowed spot still gets its 📋 row alone — the two gates are independent', () => {
    const noWindow = goldenReport({ spots: [flatSpot('kommetjie-long-beach', 3.0), flatSpot('muizenberg', 2.0)], verdict: { kind: 'red' } });
    expect(detailsMarkupFor(noWindow, EN)).toEqual({ inline_keyboard: [[{ text: '📋 All spots', callback_data: 'rep:2026-09-16' }]] });
  });
  it('detailsMarkupFor: no button at all for outOfCoverage/noData (real reports never carry spots there — §9)', () => {
    expect(detailsMarkupFor(goldenReport({ spots: [], tides: [], verdict: { kind: 'outOfCoverage', nearest: [] } }), EN)).toBeUndefined();
    expect(detailsMarkupFor(goldenReport({ spots: [], verdict: { kind: 'noData', reason: 'x' } }), EN)).toBeUndefined();
  });
});

describe('go buttons (📍 "go to this spot" map link)', () => {
  const W6 = (peak: number): Window => ({ start: `${GOLDEN_DATE}T07:00`, end: `${GOLDEN_DATE}T08:00`, peak, mean: peak });
  const windowed = (spotId: string, peak: number): SpotResult => ({
    spotId, distanceKm: 1, open: true, hours: [], windows: [W6(peak)], best: W6(peak), maxScore: peak,
  });

  it('the url is the documented Google Maps search form, coordinates through encodeURIComponent', () => {
    expect(goButtons(goldenReport(), EN, { spotId: 'kommetjie-long-beach' })).toEqual([
      [{ text: '📍 Go to Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
    ]);
  });

  it('opts.spotId: exactly one button, unconditionally — even for a spot absent from the report entirely', () => {
    expect(goButtons(goldenReport(), EN, { spotId: 'outer-kom' })).toEqual([
      [{ text: '📍 Go to Outer Kom', url: 'https://www.google.com/maps/search/?api=1&query=-34.142%2C18.319' }],
    ]);
  });

  it('opts.spotId: still the one button for a spot that is closed or flat in the report', () => {
    const closed: SpotResult = { spotId: 'outer-kom', distanceKm: 14.5, open: false, hours: [], windows: [], best: undefined, maxScore: 0 };
    const flat: SpotResult = { spotId: 'muizenberg', distanceKm: 0, open: true, hours: [], windows: [], best: undefined, maxScore: 3.0 };
    const r = goldenReport({ spots: [closed, flat] });
    expect(goButtons(r, EN, { spotId: 'outer-kom' })).toEqual([[{ text: '📍 Go to Outer Kom', url: 'https://www.google.com/maps/search/?api=1&query=-34.142%2C18.319' }]]);
    expect(goButtons(r, EN, { spotId: 'muizenberg' })).toEqual([[{ text: '📍 Go to Muizenberg', url: 'https://www.google.com/maps/search/?api=1&query=-34.1085%2C18.4715' }]]);
  });

  it('uses the prefix on the short label for an unverified spot, same rule as spotName', () => {
    expect(goButtons(goldenReport(), EN, { spotId: 'victoria-bay' })).toEqual([
      [{ text: '📍 Go to Vic Bay', url: 'https://www.google.com/maps/search/?api=1&query=-34.005%2C22.548' }],
    ]);
  });

  it('RU: the button text uses the localized template', () => {
    expect(goButtons(goldenReport(), RU, { spotId: 'kommetjie-long-beach' })).toEqual([
      [{ text: '📍 Маршрут до Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
    ]);
  });

  it('no opts: one button per interesting (windowed) spot, ordered by peak, capped at 5', () => {
    const r = makeReport({
      spots: [
        windowed('outer-kom', 3.0),
        windowed('muizenberg', 9.0),
        windowed('clovelly', 7.5),
        windowed('kalk-bay-reef', 8.5),
        windowed('strandfontein', 2.0),
        windowed('noordhoek', 6.0),
        windowed('kommetjie-long-beach', 10.0),
      ],
    });
    expect(goButtons(r, EN)).toEqual([
      [{ text: '📍 Go to Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
      [{ text: '📍 Go to Muizenberg', url: 'https://www.google.com/maps/search/?api=1&query=-34.1085%2C18.4715' }],
      [{ text: '📍 Go to Kalk Bay', url: 'https://www.google.com/maps/search/?api=1&query=-34.129%2C18.451' }],
      [{ text: '📍 Go to Clovelly', url: 'https://www.google.com/maps/search/?api=1&query=-34.129%2C18.4386' }],
      [{ text: '📍 Go to The Hoek', url: 'https://www.google.com/maps/search/?api=1&query=-34.1%2C18.352' }],
    ]);
  });

  it('no opts: empty array when no spot has a window today', () => {
    const r = goldenReport({ spots: [flatSpot('kommetjie-long-beach', 3.0), flatSpot('muizenberg', 2.0)] });
    expect(goButtons(r, EN)).toEqual([]);
  });

  it('goButtonsMarkup collapses an empty row list to undefined, not an empty inline_keyboard', () => {
    const r = goldenReport({ spots: [flatSpot('kommetjie-long-beach', 3.0)] });
    expect(goButtonsMarkup(r, EN)).toBeUndefined();
  });

  it('goButtonsMarkup: the /all surface — go buttons only, no 📋 row', () => {
    expect(goButtonsMarkup(goldenReport(), EN)).toEqual({
      inline_keyboard: [
        [{ text: '📍 Go to Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
        [{ text: '📍 Go to Muizenberg', url: 'https://www.google.com/maps/search/?api=1&query=-34.1085%2C18.4715' }],
      ],
    });
  });
});

describe('renderEvening — golden 🟢', () => {
  it('EN', () => {
    // Kommetjie is now epic (window peak 10.0 ≥ 9, 5 h ≥ 1.5 h) since Tp=13 s maxes out periodFactor and k(T) —
    // and Muizenberg's own window (peak 6.1, driven by size+period) now clears windowMin, so it shows as runner-up.
    expect(renderEvening(goldenReport(), EN)).toBe(
      [
        "🟢 <b>DON'T GO TO WORK TOMORROW</b> (Wed 16 Sept) — it's firing",
        // un bloc par spot, separe par une ligne vide : ses lignes de conditions puis son graphe du
        // jour — le verdict dit quand y aller, la courbe montre le reste de la journee sans ouvrir 📋
        [
          `🏄 ${KOM} · 7:00–11:00 · 10.0/10`,
          '   5 ft · SW 13 s · offshore SE 8 kt · incoming tide, high 9:00',
          '   ☀️ 22° · sunrise 6:44',
          '<code>6  9  12 15 18</code>',
          '<code>·████▅▂······</code>',
        ].join('\n'),
        [
          `🥈 ${MUIZ} · 7:00–10:00 · 6.1/10`,
          '   3 ft · onshore SE 8 kt',
          '<code>6  9  12 15 18</code>',
          '<code>·▅▅▅▃········</code>',
        ].join('\n'),
      ].join('\n\n'),
    );
  });
  it('RU', () => {
    const lines = renderEvening(goldenReport(), RU).split('\n');
    expect(lines[0]).toContain('ЗАВТРА НЕ ИДИ НА РАБОТУ');
    expect(lines[0]).toContain('16 сент.');
    expect(lines[1]).toBe(''); // le titre est un bloc a lui seul
    expect(lines[2]).toBe(`🏄 ${KOM} · 7:00–11:00 · 10.0/10`);
    expect(lines[3]).toBe('   5 ft · ЮЗ 13 с · оффшор ЮВ 8 kt · прилив, полная 9:00');
  });
  it('adds the epic suffix, the weekend and now titles', () => {
    const r = goldenReport();
    const green = r.verdict as Extract<Verdict, { kind: 'green' }>;
    const epic: Verdict = { ...green, epic: true };
    expect(renderEvening({ ...r, verdict: epic }, EN).split('\n')[0]).toBe("🟢 <b>DON'T GO TO WORK TOMORROW</b> (Wed 16 Sept) — it's firing");
    // the golden scenario is naturally epic now (see 'EN' above) — force epic:false here so these two
    // assertions isolate the weekend/now title format, not the (already-covered) epic suffix.
    const notEpic: Verdict = { ...green, epic: false };
    expect(renderEvening({ ...r, verdict: notEpic, date: '2026-09-19' }, EN).split('\n')[0]).toBe('🟢 <b>GO SURF TOMORROW</b> (Sat 19 Sept)');
    expect(renderEvening({ ...r, verdict: notEpic, mode: 'now' }, EN).split('\n')[0]).toBe('🟢 <b>GO SURF</b> (today)');
  });
  it('mentions rain when ≥ 1 mm', () => {
    const r = goldenReport({ weather: { tempMaxC: 17.6, tempMinC: 12, precipMm: 4.6, code: 61 } });
    // par contenu et non par index : le graphe du spot s'intercale avant cette ligne
    expect(renderEvening(r, EN).split('\n')).toContain('   ☀️ 18° · sunrise 6:44 · rain 5 mm');
  });
  it('shows a 🥈 runner-up when another open spot has a window', () => {
    const r = goldenReport();
    const muiz = r.spots.find((x) => x.spotId === 'muizenberg')!;
    muiz.windows = [W('07:00', '09:00', 6.5)];
    muiz.best = muiz.windows[0];
    const lines = renderEvening(r, EN).split('\n');
    const i = lines.indexOf(`🥈 ${MUIZ} · 7:00–9:00 · 6.5/10`);
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]).toBe('   3 ft · onshore SE 8 kt');
    // et son propre graphe juste dessous — c'est le second spot du message
    expect(lines[i + 2]).toBe('<code>6  9  12 15 18</code>');
    expect(lines[i + 3]).toBe('<code>·▅▅▅▃········</code>');
  });
  it('mentions the wind change at the end of the window', () => {
    const r = goldenReport();
    const kom = r.spots.find((x) => x.spotId === 'kommetjie-long-beach')!;
    kom.hours.find((h) => h.time === `${GOLDEN_DATE}T10:00`)!.windRelation = 'onshore';
    expect(renderEvening(r, EN).split('\n')).toContain('   5 ft · SW 13 s · offshore SE 8 kt then onshore · incoming tide, high 9:00');
  });
});

describe('renderEvening — other verdicts', () => {
  it('🔴 names the best spot and its weakest factor', () => {
    const r = goldenReport({ verdict: { kind: 'red', bestSpotId: 'muizenberg' } });
    // Muizenberg's maxScore is now 6.1 (size 0.87, period 1.0), and wind (0.7) is its weakest factor —
    // size, at 0.87, is no longer the lowest now that period no longer drags it down (was 0.549 · 0.86 before).
    expect(renderEvening(r, EN)).toBe(
      ['🔴 <b>GO TO WORK TOMORROW</b> (Wed 16 Sept)', ['Nothing ≥ 7/10 within 20 km.', `Best: ${MUIZ} 6.1/10 (onshore SE 8 kt)`].join('\n')].join('\n\n'),
    );
  });
  it('🌅 dawn block', () => {
    const r = goldenReport({ verdict: { kind: 'yellow', dawn: { spotId: 'muizenberg', window: W('07:00', '09:00', 7.2) } } });
    const lines = renderEvening(r, EN).split('\n');
    expect(lines[0]).toBe('🌅 <b>DAWN PATROL, THEN WORK</b> (Wed 16 Sept)');
    expect(lines[1]).toBe(`🏄 ${MUIZ} · 7:00–9:00 · 7.2/10`);
    expect(lines[2]).toBe('   3 ft · SW 13 s · onshore SE 8 kt · incoming tide, high 9:00');
  });
  it('🌅 a dawn+dusk 🟡 on one spot draws its day chart once, not twice', () => {
    // Le graphe couvre toute la journée : le redessiner sous « après le travail » répéterait à
    // l'identique la courbe déjà affichée sous « dawn patrol ».
    const pick = { spotId: 'muizenberg', window: W('07:00', '09:00', 7.2) };
    const r = goldenReport({ verdict: { kind: 'yellow', dawn: pick, dusk: { spotId: 'muizenberg', window: W('17:00', '18:00', 7.0) } } });
    const lines = renderEvening(r, EN).split('\n');
    expect(lines.filter((l) => l.startsWith('<code>') && l.includes('▅')).length).toBe(1);
  });
  it('🌅 a dawn+dusk 🟡 on two different spots draws one chart each', () => {
    const r = goldenReport({
      verdict: {
        kind: 'yellow',
        dawn: { spotId: 'muizenberg', window: W('07:00', '09:00', 7.2) },
        dusk: { spotId: 'kommetjie-long-beach', window: W('17:00', '18:00', 7.0) },
      },
    });
    const lines = renderEvening(r, EN).split('\n');
    expect(lines.filter((l) => l === '<code>6  9  12 15 18</code>').length).toBe(2);
  });
  it('out of coverage with raw conditions and nearest spots', () => {
    const r = goldenReport({
      spots: [], tides: [],
      verdict: { kind: 'outOfCoverage', raw: { swellHeightM: 1.8, periodS: 12, swellDirDeg: 225, windKt: 14, windDirDeg: 315 }, nearest: [{ spotId: 'victoria-bay', distanceKm: 38.2 }] },
    });
    expect(renderEvening(r, EN)).toBe(
      ['📍 No known spot within 20 km.', 'Raw conditions here: swell 1.8 m 12 s SW · wind 14 kt NW', 'Nearest known spots: Victoria Bay (38 km)'].join('\n'),
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
    expect(renderEvening(r, RU).split('\n')[2]).toBe('Ближайшие известные споты: Victoria Bay (38 км)');
  });
});

describe('renderMorning', () => {
  const evening = goldenReport();
  it('confirmed', () => {
    expect(renderMorning(goldenReport({ mode: 'morning' }), { send: true, changed: false }, evening, EN)).toBe(`✅ Confirmed: 🟢 ${KOM} 7:00–11:00`);
  });
  it('changed with cause and the new conditions line', () => {
    const morning: Report = goldenReport({ mode: 'morning', verdict: { kind: 'green', spotId: 'kommetjie-long-beach', window: W('07:00', '10:00', 8.0), epic: false } });
    expect(renderMorning(morning, { send: true, changed: true, cause: 'wind' }, evening, EN)).toBe(
      [`⚠️ Change: 🟢 ${KOM} 7:00–11:00 → 🟢 ${KOM} 7:00–10:00`, '5 ft · SW 13 s · offshore SE 8 kt · incoming tide, high 9:00', 'cause: wind'].join('\n'),
    );
  });
  it('degraded to red', () => {
    const morning = goldenReport({ mode: 'morning', verdict: { kind: 'red', bestSpotId: 'kommetjie-long-beach' } });
    expect(renderMorning(morning, { send: true, changed: true }, evening, EN)).toBe(`⚠️ Change: 🟢 ${KOM} 7:00–11:00 → 🔴 go to work`);
  });
  it('noData keeps last night verdict', () => {
    const morning = goldenReport({ mode: 'morning', verdict: { kind: 'noData', reason: 'x' } });
    expect(renderMorning(morning, { send: true, changed: false }, evening, EN)).toBe(`⚠️ No data this morning — last night's verdict stands: 🟢 ${KOM} 7:00–11:00`);
  });
  it('short verdict of a missing report is red', () => {
    expect(renderShortVerdict(undefined, EN)).toBe('🔴 go to work');
  });
});

describe('renderDetails', () => {
  it('is now the 📋 title line + the day view: primary spot chart, spot rows, tides, sun', () => {
    // Captured from the real implementation against goldenReport() and spot-checked against numbers the
    // OLD renderDetails/renderEvening golden tests already trusted (same engine, same fixtures — only the
    // rendering changed): Kommetjie's window (7:00–11:00, peak 10.0), its "5 ft · SW 13 s" conditions and
    // "incoming tide, high 9:00" all match the pre-existing 🟢 EN golden test above; the wind range
    // 8→30 kt is exactly goldenWindKt's min/max over 7..17; Muizenberg's 6.1 matches the 🥈 golden test.
    expect(renderDetails(goldenReport(), EN)).toBe(
      [
        '📋 <b>Your day</b> (Wed 16 Sept)',
        `🏄 ${KOM} · 7:00–11:00`,
        '',
        '<code>6  9  12 15 18</code>',
        '<code>·████▅▂······</code>',
        '',
        'peak 10.0 at 7:00',
        '5 ft · SW 13 s · offshore SE 8→30 kt · incoming tide, high 9:00',
        'best at 7:00 — wind drops to 8 kt, tide still high',
        'fades from 11:00 — wind builds to 18 kt',
        '',
        '<code>Muizenberg    ·▅▅▅▃········  6.1</code>',
        '',
        'tide: low 3:00 · high 9:00 · low 15:00 · high 21:00',
        '🌅 6:44 · 🌇 18:38',
      ].join('\n'),
    );
  });
  it('lists closed spots and uses "today" in now mode', () => {
    const r = goldenReport({ mode: 'now' });
    r.spots.push({ spotId: 'outer-kom', distanceKm: 14.5, open: false, hours: [], windows: [], maxScore: 0 });
    const lines = renderDetails(r, EN).split('\n');
    expect(lines[0]).toBe('📋 <b>Your day</b> (today)');
    expect(lines).toContain('closed for your level: Kommetjie – Outer Kom');
  });
  it('never mentions Open-Meteo any more (the licence moved to the welcome message)', () => {
    expect(renderDetails(goldenReport(), EN)).not.toContain('Open-Meteo');
  });
  it('{ all: true } uses the "All spots" title reserved for the future /all view', () => {
    const lines = renderDetails(goldenReport(), EN, { all: true }).split('\n');
    expect(lines[0]).toBe('📋 <b>All spots</b> (Wed 16 Sept)');
  });
});

// ---- 📋 day view: a chart per spot instead of a flat, one-snapshot-per-row list ----

/** Kommetjie – Long Beach, hand-built: size & period pinned at 1 all day; wind 0.81→0.97→0.54-ish;
 * tide 1.00→0.60→1.00. Peak at 8:00 (9.7), window 7:00–10:00, fades from 10:00 — matches the design doc's
 * worked example (day-view.md) so "best at"/"fades from" name wind & tide, never size or period. */
function komHour(
  hour: number,
  opts: { wind: number; tide: number; windKt: number; tideState: 'low' | 'mid' | 'high'; trend: TideTrend; score: number },
): SpotHour {
  return {
    time: `${GOLDEN_DATE}T${String(hour).padStart(2, '0')}:00`,
    faceFt: 6, periodS: 12, swellDirDeg: 225,
    windKt: opts.windKt, windDirDeg: 135, gustKt: opts.windKt + 5, windRelation: 'offshore',
    tide: { state: opts.tideState, trend: opts.trend },
    factors: { size: 1, period: 1, wind: opts.wind, tide: opts.tide, day: 1, weather: 1 },
    score: opts.score,
  };
}

const KOM_HOURS: SpotHour[] = [
  komHour(7, { wind: 0.81, tide: 1.0, windKt: 18, tideState: 'mid', trend: 'rising', score: 8.1 }),
  komHour(8, { wind: 0.97, tide: 1.0, windKt: 15, tideState: 'high', trend: 'falling', score: 9.7 }),
  komHour(9, { wind: 0.9, tide: 1.0, windKt: 16, tideState: 'high', trend: 'falling', score: 9.0 }),
  komHour(10, { wind: 0.7, tide: 0.6, windKt: 20, tideState: 'low', trend: 'falling', score: 4.2 }),
  komHour(11, { wind: 0.65, tide: 0.6, windKt: 21, tideState: 'low', trend: 'falling', score: 3.9 }),
  komHour(12, { wind: 0.6, tide: 0.6, windKt: 22, tideState: 'low', trend: 'rising', score: 3.6 }),
  komHour(13, { wind: 0.55, tide: 0.6, windKt: 23, tideState: 'low', trend: 'rising', score: 3.3 }),
  komHour(14, { wind: 0.6, tide: 0.6, windKt: 21, tideState: 'low', trend: 'rising', score: 3.6 }),
  komHour(15, { wind: 0.45, tide: 1.0, windKt: 19, tideState: 'mid', trend: 'rising', score: 4.5 }),
  komHour(16, { wind: 0.4, tide: 1.0, windKt: 18, tideState: 'high', trend: 'rising', score: 4.0 }),
  komHour(17, { wind: 0.42, tide: 1.0, windKt: 17, tideState: 'high', trend: 'falling', score: 4.2 }),
];
const KOM_WINDOW: Window = W('07:00', '10:00', 9.7);
const KOM_TIDES = [{ time: `${GOLDEN_DATE}T11:47`, kind: 'low' as const, heightM: -0.82 }];

// NB: both params are required (no defaults) — a default on `best` would fire even when a test passes
// `undefined` on purpose to mean "no window", which is exactly the case this fixture needs to express.
function komResult(hours: SpotHour[], best: Window | undefined): SpotResult {
  return {
    spotId: 'kommetjie-long-beach', distanceKm: 13.4, open: true,
    hours, windows: best ? [best] : [], best,
    maxScore: hours.reduce((m, h) => Math.max(m, h.score), 0),
  };
}

const KOM_CHART = '<code>6  9  12 15 18</code>\n<code>·▇██▄▄▃▃▃▄▄▄·</code>';
const KOM_BLOCK = [
  `🏄 ${KOM} · 7:00–10:00`,
  '',
  KOM_CHART,
  '',
  'peak 9.7 at 8:00',
  '6 ft · SW 12 s · offshore SE 15→23 kt · outgoing tide, low 11:47',
  'best at 8:00 — wind drops to 15 kt, tide still high',
  'fades from 10:00 — low tide, wind builds to 20 kt',
].join('\n');

describe('renderSpotDay', () => {
  it('a spot with a window: title+window, chart, peak, conditions (wind as a range), and both explanation lines', () => {
    const report = makeReport({ spots: [komResult(KOM_HOURS, KOM_WINDOW)], tides: KOM_TIDES });
    expect(renderSpotDay(report, 'kommetjie-long-beach', EN)).toBe(KOM_BLOCK);
  });
  it('names exactly wind and tide on the pinned Kommetjie fixture, never size or period', () => {
    const report = makeReport({ spots: [komResult(KOM_HOURS, KOM_WINDOW)], tides: KOM_TIDES });
    const out = renderSpotDay(report, 'kommetjie-long-beach', EN);
    expect(out).toContain('best at 8:00 — wind drops to 15 kt, tide still high');
    expect(out).toContain('fades from 10:00 — low tide, wind builds to 20 kt');
    expect(out).not.toMatch(/size peaks|groundswell/);
  });
  it('RU: peak / best-at / fades-from translate with the same numbers', () => {
    const report = makeReport({ spots: [komResult(KOM_HOURS, KOM_WINDOW)], tides: KOM_TIDES });
    const out = renderSpotDay(report, 'kommetjie-long-beach', RU);
    expect(out).toContain('пик 9.7 в 8:00');
    expect(out).toContain('лучшее в 8:00 — ветер стихает до 15 kt, вода всё ещё полная');
    expect(out).toContain('спадает после 10:00 — малая вода, ветер усиливается до 20 kt');
  });
  it('a spot with no window: skips peak/best-at/fades-from, keeps the chart and conditions', () => {
    const hours = Array.from({ length: 11 }, (_, i) =>
      komHour(7 + i, { wind: 0.5, tide: 1, windKt: 10, tideState: 'mid', trend: 'rising', score: 5.0 }));
    const report = makeReport({ spots: [komResult(hours, undefined)], tides: [{ time: `${GOLDEN_DATE}T09:00`, kind: 'high', heightM: 0.5 }] });
    expect(renderSpotDay(report, 'kommetjie-long-beach', EN)).toBe(
      [
        `🏄 ${KOM} · 5.0/10`, // sans fenêtre, l'en-tête chiffre quand même la journée
        '',
        '<code>6  9  12 15 18</code>\n<code>·▅▅▅▅▅▅▅▅▅▅▅·</code>',
        '',
        '6 ft · SW 12 s · offshore SE 10 kt · incoming tide, high 9:00',
      ].join('\n'),
    );
  });
  it('a spot closed for the level: chart of zeros, says it is closed', () => {
    const report = makeReport({ spots: [{ spotId: 'outer-kom', distanceKm: 14.5, open: false, hours: [], windows: [], best: undefined, maxScore: 0 }] });
    expect(renderSpotDay(report, 'outer-kom', EN)).toBe(
      ['🏄 Kommetjie – Outer Kom · 0.0/10', '', '<code>6  9  12 15 18</code>\n<code>·············</code>', '', 'closed for your level'].join('\n'),
    );
  });
  it('says nothing when the day is flat: a window exists but every factor is steady all day', () => {
    const hours = Array.from({ length: 11 }, (_, i) =>
      komHour(7 + i, { wind: 0.9, tide: 0.9, windKt: 12, tideState: 'mid', trend: 'rising', score: 6.6 }));
    const report = makeReport({
      spots: [komResult(hours, W('07:00', '18:00', 6.6))],
      tides: [{ time: `${GOLDEN_DATE}T09:00`, kind: 'high', heightM: 0.5 }],
    });
    const out = renderSpotDay(report, 'kommetjie-long-beach', EN);
    expect(out).toContain('peak 6.6 at 7:00');
    expect(out).not.toContain('best at');
    expect(out).not.toContain('fades from');
  });
  it('names "gets dark" when the fade lands after the plotted hours, at the day factor dropping to 0', () => {
    // Flat 7:00–16:00 (never reaches windowMin), a one-hour window at 17:00 (the day's only peak, score 8.0),
    // then 18:00 — past chartHours' 7..17 range — where wind/tide are unchanged but daylight ends (day 1→0).
    const flat = (hour: number): SpotHour => komHour(hour, { wind: 0.3, tide: 1, windKt: 12, tideState: 'high', trend: 'rising', score: 3.0 });
    const dusk: SpotHour = {
      time: `${GOLDEN_DATE}T18:00`, faceFt: 6, periodS: 12, swellDirDeg: 225,
      windKt: 12, windDirDeg: 135, gustKt: 17, windRelation: 'offshore', tide: { state: 'high', trend: 'rising' },
      factors: { size: 1, period: 1, wind: 0.8, tide: 1, day: 0, weather: 1 }, score: 0,
    };
    const hours = [
      ...Array.from({ length: 10 }, (_, i) => flat(7 + i)),
      komHour(17, { wind: 0.8, tide: 1, windKt: 12, tideState: 'high', trend: 'rising', score: 8.0 }),
      dusk,
    ];
    const report = makeReport({ spots: [komResult(hours, W('17:00', '18:00', 8.0))] });
    expect(renderSpotDay(report, 'kommetjie-long-beach', EN)).toContain('fades from 18:00 — gets dark');
  });
});

function flatSpot(id: string, maxScore: number, open = true): SpotResult {
  return { spotId: id, distanceKm: 5, open, hours: [], windows: [], best: undefined, maxScore };
}
const DEAD_COLS = '·'.repeat(13); // 13 colonnes depuis que le graphique couvre les heures partiellement éclairées
/**
 * Same short-label/padding rule as `renderDayView`'s spot rows, re-derived independently for the test:
 * label (≤ 13 chars, own field — no truncation, § defect 2) padEnd(13) + 1 space + sparkline + 2 spaces + score.
 */
function expectedRow(id: string, score: number): string {
  const spot = SPOTS.find((sp) => sp.id === id)!;
  const label = spot.verified ? spot.short : `${spot.short}`;
  return `${label.padEnd(13, ' ')} ${DEAD_COLS}  ${score.toFixed(1)}`;
}
const DAY_VIEW_TIDES = [
  { time: `${GOLDEN_DATE}T05:50`, kind: 'high' as const, heightM: -0.17 },
  { time: `${GOLDEN_DATE}T11:47`, kind: 'low' as const, heightM: -0.82 },
  { time: `${GOLDEN_DATE}T18:04`, kind: 'high' as const, heightM: -0.2 },
];
function dayViewReport(): Report {
  return makeReport({
    spots: [komResult(KOM_HOURS, KOM_WINDOW), flatSpot('muizenberg', 7.0), flatSpot('clovelly', 3.0), flatSpot('fish-hoek', 2.0), flatSpot('glen-beach', 1.0), flatSpot('kalk-bay-reef', 0, false)],
    tides: DAY_VIEW_TIDES,
    verdict: { kind: 'green', spotId: 'kommetjie-long-beach', window: KOM_WINDOW, epic: false },
  });
}
const DAY_VIEW_TAIL = ['closed for your level: Kalk Bay Reef', 'tide: high 5:50 · low 11:47 · high 18:04', '🌅 6:44 · 🌇 18:38'];

describe('renderDayView', () => {
  it('shows the primary spot, then a sparkline row per open spot ≥ 2.5, then collapses the rest into a count', () => {
    expect(renderDayView(dayViewReport(), EN)).toBe(
      [
        KOM_BLOCK,
        `<code>${expectedRow('muizenberg', 7.0)}</code>\n<code>${expectedRow('clovelly', 3.0)}</code>`,
        ['2 spots flat all day', ...DAY_VIEW_TAIL].join('\n'),
      ].join('\n\n'),
    );
  });
  it('with { all: true }: every open spot gets a row, and the collapse line is omitted', () => {
    expect(renderDayView(dayViewReport(), EN, { all: true })).toBe(
      [
        KOM_BLOCK,
        [
          `<code>${expectedRow('muizenberg', 7.0)}</code>`,
          `<code>${expectedRow('clovelly', 3.0)}</code>`,
          `<code>${expectedRow('fish-hoek', 2.0)}</code>`,
          `<code>${expectedRow('glen-beach', 1.0)}</code>`,
        ].join('\n'),
        DAY_VIEW_TAIL.join('\n'),
      ].join('\n\n'),
    );
  });
  it('falls back to the highest-scoring OPEN spot when the verdict has no pick (a closed spot never wins)', () => {
    const report = makeReport({
      spots: [flatSpot('muizenberg', 8.0), flatSpot('clovelly', 3.0), flatSpot('kalk-bay-reef', 9.0, false)],
      verdict: { kind: 'red', bestSpotId: 'muizenberg' },
    });
    expect(renderDayView(report, EN).startsWith(`🏄 ${MUIZ}`)).toBe(true);
  });
  it('never mentions Open-Meteo any more', () => {
    expect(renderDayView(dayViewReport(), EN)).not.toContain('Open-Meteo');
  });
  it('distinguishes secondary rows a truncated full name could not (defect 2: Inner Kom / Outer Kom)', () => {
    const report = makeReport({
      spots: [komResult(KOM_HOURS, KOM_WINDOW), flatSpot('inner-kom', 4.0), flatSpot('outer-kom', 3.5)],
      tides: KOM_TIDES,
      verdict: { kind: 'green', spotId: 'kommetjie-long-beach', window: KOM_WINDOW, epic: false },
    });
    const out = renderDayView(report, EN);
    // both used to naively truncate to the identical "Kommetjie – " prefix — now each gets its own short
    // label; scoped to the secondary-rows block since the primary spot's own title legitimately uses the
    // full "Kommetjie – Long Beach" name.
    const rowsBlock = `<code>${expectedRow('inner-kom', 4.0)}</code>\n<code>${expectedRow('outer-kom', 3.5)}</code>`;
    expect(out).toContain(rowsBlock);
    expect(rowsBlock).not.toContain('Kommetjie – ');
  });
});

describe('renderDayView / allSpotOrder — /all cap in a dense cluster (§report "Resilience, wiring and dedupe")', () => {
  function manySpots(n: number): { report: Report; ctx: RenderCtx } {
    const map = new Map(SPOTS.map((s) => [s.id, s]));
    const results: SpotResult[] = [];
    for (let i = 0; i < n; i++) {
      const id = `world-${i}`;
      map.set(id, {
        id, name: `World Spot ${i}`, short: `W${i}`, region: 'cape-peninsula', lat: 0, lon: 0, facing: 0,
        swellWindow: [0, 90], exposure: 0.7, tide: { best: [], forbidden: [] }, levels: {}, character: 'punchy', verified: false,
      });
      results.push(flatSpot(id, n - i)); // strictly descending scores: world-0 highest (becomes primary)
    }
    const report = makeReport({ spots: results, verdict: { kind: 'red' } });
    return { report, ctx: { lang: 'en', spots: map } };
  }

  it('allSpotOrder caps at ALL_SPOTS_CAP others (plus the primary), in the same score order as openSpotOrder', () => {
    const { report } = manySpots(80);
    const order = allSpotOrder(report);
    expect(order).toHaveLength(1 + ALL_SPOTS_CAP);
    expect(order).toEqual(openSpotOrder(report).slice(0, 1 + ALL_SPOTS_CAP));
    expect(order[0]).toBe('world-0');
    expect(order[order.length - 1]).toBe(`world-${ALL_SPOTS_CAP}`);
  });

  it('under the cap, allSpotOrder is identical to openSpotOrder — no truncation when nothing needs hiding', () => {
    const { report } = manySpots(5);
    expect(allSpotOrder(report)).toEqual(openSpotOrder(report));
  });

  it('renderDayView({ all: true }) shows at most ALL_SPOTS_CAP rows and a "+N more" tail once a cluster exceeds it, never the flat-spots wording', () => {
    const { report, ctx } = manySpots(80);
    const out = renderDayView(report, ctx, { all: true });
    // Chaque ligne a son propre <code> : les deux premiers sont la règle et le sparkline du spot
    // principal, les suivants sont une ligne par autre spot ouvert — seuls ceux-là sont plafonnés.
    const codeLines = [...out.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => m[1]);
    expect(codeLines).toHaveLength(2 + ALL_SPOTS_CAP);
    expect(out).toContain('+49 more open spots not shown'); // 80 - 1 primary - 30 shown = 49 hidden
    expect(out).not.toContain('flat all day');
  });

  it('the capped /all message stays comfortably under Telegram\'s 4096-char limit even in an extreme, worse-than-realistic cluster', () => {
    const { report, ctx } = manySpots(200);
    const body = renderDetails(report, ctx, { all: true });
    expect(body.length).toBeLessThan(2500);
  });

  it('a cluster with no hidden spots (exactly at the cap) shows no "+N more" tail', () => {
    const { report, ctx } = manySpots(1 + ALL_SPOTS_CAP); // primary + exactly ALL_SPOTS_CAP others
    const out = renderDayView(report, ctx, { all: true });
    expect(out).not.toContain('more open spots');
  });
});

describe('renderDayView — row width budget (≤ 34 chars, § day-view.md "Width and naming fix")', () => {
  // Same three daylight spans chart.test.ts's chartHours suite already pins to 8/11/14-hour days.
  const withDaylight = (sunrise: string, sunset: string): Report =>
    makeReport({
      sun: { sunrise: `${GOLDEN_DATE}T${sunrise}`, sunset: `${GOLDEN_DATE}T${sunset}` },
      spots: [komResult(KOM_HOURS, KOM_WINDOW), flatSpot('muizenberg', 7.0), flatSpot('clovelly', 10.0)],
      tides: KOM_TIDES,
      verdict: { kind: 'green', spotId: 'kommetjie-long-beach', window: KOM_WINDOW, epic: false },
    });

  it.each([
    ['8-hour day', '09:00', '17:00'],
    ['11-hour day', '06:44', '18:38'],
    ['14-hour day', '05:32', '19:58'],
  ])('keeps every monospace line ≤ 34 chars on a %s (worst case: a 10.0 score)', (_name, sunrise, sunset) => {
    const out = renderDayView(withDaylight(sunrise, sunset), EN);
    const monoLines = [...out.matchAll(/<code>([\s\S]*?)<\/code>/g)].flatMap((m) => m[1].split('\n'));
    expect(monoLines.length).toBeGreaterThan(0);
    monoLines.forEach((line) => expect(line.length).toBeLessThanOrEqual(34));
  });
});
