import { describe, it, expect } from 'vitest';
import {
  esc, fmtTime, fmtDate, fmtDay, renderEvening, renderShortVerdict, renderMorning, renderDetails, renderSpotDay, renderDayView, renderWeek,
  detailsMarkupFor, goButtons, goButtonsMarkup, openSpotOrder, allSpotOrder, ALL_SPOTS_CAP, spotName, type RenderCtx,
} from '../../src/render/messages';
import { STRINGS } from '../../src/render/i18n';
import { allWorldTuples, worldSpotId } from '../../src/data/world';
import { SPOTS } from '../../src/data/index';
import type { Report, SpotHour, SpotResult, TideTrend, Verdict, Window } from '../../src/types';
import { rawStars, starBase } from '../../src/engine/rating';
import { GOLDEN_DATE, goldenReport } from '../helpers/golden';
import { makeHour, makeReport, makeSpotDay } from '../helpers/reports';

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
    // Muizenberg n'a pas de fenêtre dans le scénario golden (2☆ sous le cross-onshore) : pas de bouton
    expect(detailsMarkupFor(goldenReport(), EN)).toEqual({
      inline_keyboard: [
        [{ text: '📍 Go to Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
        [{ text: '📋 All spots', callback_data: 'rep:2026-09-16' }],
      ],
    });
  });
  it('detailsMarkupFor: a red verdict with no windowed spot still gets its 📋 row alone — the two gates are independent', () => {
    const noWindow = goldenReport({ spots: [flatSpot('kommetjie-long-beach', 2), flatSpot('muizenberg', 1)], verdict: { kind: 'red' } });
    expect(detailsMarkupFor(noWindow, EN)).toEqual({ inline_keyboard: [[{ text: '📋 All spots', callback_data: 'rep:2026-09-16' }]] });
  });
  it('detailsMarkupFor: no button at all for outOfCoverage/noData (real reports never carry spots there — §9)', () => {
    expect(detailsMarkupFor(goldenReport({ spots: [], tides: [], verdict: { kind: 'outOfCoverage', nearest: [] } }), EN)).toBeUndefined();
    expect(detailsMarkupFor(goldenReport({ spots: [], verdict: { kind: 'noData', reason: 'x' } }), EN)).toBeUndefined();
  });
});

describe('spot order on a day without a window to pick', () => {
  const spotDay = makeSpotDay;
  // Jeudi 17/09 au Cap, /all : The Hoek, plus proche, passait en tête pour 2 heures à 2★ quand Long Beach les tenait 5 heures.
  const report = makeReport({
    verdict: { kind: 'red', bestSpotId: 'kommetjie-long-beach' },
    spots: [
      spotDay('noordhoek', 13, [0, 2, 2, 1, 0, 0, 0, 0]),
      spotDay('inner-kom', 14, [0, 1, 0, 0, 0, 0, 0, 0]),
      spotDay('outer-kom', 14.5, [1, 1, 1, 0, 0, 0, 0, 0]),
      spotDay('kommetjie-long-beach', 15, [0, 2, 2, 2, 2, 2, 1, 0]),
      spotDay('llandudno', 18, [0, 2, 2, 2, 0, 0, 2, 0]),
    ],
  });

  it('ranks spots tied on stars by the hours at those stars, then by the hours with at least one star', () => {
    expect(openSpotOrder(report)).toEqual(['kommetjie-long-beach', 'llandudno', 'noordhoek', 'outer-kom', 'inner-kom']);
  });

  it('/all heads with that spot and lists the others in the same order', () => {
    const out = renderDayView(report, EN, { all: true });
    const at = (label: string): number => out.indexOf(label);
    expect(at('🏄 Kommetjie – Long Beach')).toBeGreaterThanOrEqual(0);
    expect(at('Llandudno')).toBeLessThan(at('The Hoek'));
    expect(at('The Hoek')).toBeLessThan(at('Outer Kom'));
    expect(at('Outer Kom')).toBeLessThan(at('Inner Kom'));
  });
});

describe('spot names', () => {
  it("names an imported spot by its name, not its id — reports keep ids, and the render context only holds curated spots", () => {
    const [name, , lat, lon] = allWorldTuples()[0];
    expect(spotName(worldSpotId(name, lat, lon), EN, STRINGS.en)).toBe(esc(name));
  });

  it('an id matching nothing is still shown as it is', () => {
    expect(spotName('no-such-spot', EN, STRINGS.en)).toBe('no-such-spot');
  });
});

describe('go buttons (📍 "go to this spot" map link)', () => {
  const W6 = (peak: number): Window => ({ start: `${GOLDEN_DATE}T07:00`, end: `${GOLDEN_DATE}T08:00`, peak, mean: peak });
  const windowed = (spotId: string, peak: number): SpotResult => ({
    spotId, distanceKm: 1, hours: [], windows: [W6(peak)], best: W6(peak), maxScore: peak,
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

  it('an imported spot gets its button too — not only the curated ones held by the render context', () => {
    const [name, , lat, lon] = allWorldTuples()[0];
    const buttons = goButtons(goldenReport(), EN, { spotId: worldSpotId(name, lat, lon) });
    expect(buttons).toHaveLength(1);
    expect(buttons[0][0].url).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`);
  });

  it('opts.spotId: still the one button for a spot at 0★ or without a window', () => {
    const nothing: SpotResult = { spotId: 'outer-kom', distanceKm: 14.5, hours: [], windows: [], best: undefined, maxScore: 0 };
    const flat: SpotResult = { spotId: 'muizenberg', distanceKm: 0, hours: [], windows: [], best: undefined, maxScore: 2 };
    const r = goldenReport({ spots: [nothing, flat] });
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
        windowed('outer-kom', 2),
        windowed('muizenberg', 7),
        windowed('clovelly', 5),
        windowed('kalk-bay-reef', 6),
        windowed('strandfontein', 1),
        windowed('noordhoek', 4),
        windowed('kommetjie-long-beach', 8),
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
    const r = goldenReport({ spots: [flatSpot('kommetjie-long-beach', 2), flatSpot('muizenberg', 1)] });
    expect(goButtons(r, EN)).toEqual([]);
  });

  it('goButtonsMarkup collapses an empty row list to undefined, not an empty inline_keyboard', () => {
    const r = goldenReport({ spots: [flatSpot('kommetjie-long-beach', 2)] });
    expect(goButtonsMarkup(r, EN)).toBeUndefined();
  });

  it('goButtonsMarkup: the /all surface — go buttons only, no 📋 row', () => {
    expect(goButtonsMarkup(goldenReport(), EN)).toEqual({
      inline_keyboard: [
        [{ text: '📍 Go to Long Beach', url: 'https://www.google.com/maps/search/?api=1&query=-34.133%2C18.329' }],
      ],
    });
  });
});

describe('renderEvening — golden 🟢', () => {
  it('EN', () => {
    // 3,5 m de houle : 6★ or tant que l'offshore reste sous 30 km/h, donc epic (6★ sur 5 h) ;
    // Muizenberg plafonne à 2☆ sous le cross-onshore, sans fenêtre : pas de 🥈.
    expect(renderEvening(goldenReport(), EN)).toBe(
      [
        "🟢 <b>DON'T GO TO WORK TOMORROW</b> (Wed 16 Sept) — it's firing",
        // un bloc par spot, separe par une ligne vide : ses lignes de conditions puis son graphe du
        // jour — le verdict dit quand y aller, la courbe montre le reste de la journee sans ouvrir 📋
        [
          `🏄 ${KOM} · 7:00–12:00 · ★★★★★★`,
          '   3.5 m · SW 13 s · offshore SE 8 kt · incoming tide, high 9:00',
          '   ☀️ 22° · sunrise 6:44',
          '<code>6  9  12 15 18</code>',
          '<code>·▆▆▆▆▅▂······</code>',
        ].join('\n'),
      ].join('\n\n'),
    );
  });
  it('RU', () => {
    const lines = renderEvening(goldenReport(), RU).split('\n');
    expect(lines[0]).toContain('ЗАВТРА НЕ ИДИ НА РАБОТУ');
    expect(lines[0]).toContain('16 сент.');
    expect(lines[1]).toBe(''); // le titre est un bloc a lui seul
    expect(lines[2]).toBe(`🏄 ${KOM} · 7:00–12:00 · ★★★★★★`);
    expect(lines[3]).toBe('   3.5 м · ЮЗ 13 с · оффшор ЮВ 8 kt · прилив, полная 9:00');
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
  it('shows a 🥈 runner-up when another spot has a window, in white stars when the wind has an onshore component', () => {
    const r = goldenReport();
    const muiz = r.spots.find((x) => x.spotId === 'muizenberg')!;
    muiz.windows = [W('07:00', '09:00', 2)];
    muiz.best = muiz.windows[0];
    const lines = renderEvening(r, EN).split('\n');
    const i = lines.indexOf(`🥈 ${MUIZ} · 7:00–9:00 · ☆☆`);
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]).toBe('   3.5 m · cross-onshore SE 8 kt');
    // et son propre graphe juste dessous — c'est le second spot du message
    expect(lines[i + 2]).toBe('<code>6  9  12 15 18</code>');
    expect(lines[i + 3]).toBe('<code>·▂▂▂·········</code>');
  });
  it('mentions the wind state change at the end of the window', () => {
    const r = goldenReport();
    const kom = r.spots.find((x) => x.spotId === 'kommetjie-long-beach')!;
    kom.hours.find((h) => h.time === `${GOLDEN_DATE}T11:00`)!.windState = 'on';
    expect(renderEvening(r, EN).split('\n')).toContain('   3.5 m · SW 13 s · offshore SE 8 kt then onshore · incoming tide, high 9:00');
  });
});

describe('renderEvening — other verdicts', () => {
  it('🔴 names the best spot, its stars and what holds them back — here the cross-onshore wind', () => {
    const r = goldenReport({ verdict: { kind: 'red', bestSpotId: 'muizenberg' } });
    expect(renderEvening(r, EN)).toBe(
      ['🔴 <b>GO TO WORK TOMORROW</b> (Wed 16 Sept)', ['Nothing ≥ 4★ within 20 km.', `Best: ${MUIZ} ☆☆ (cross-onshore SE 8 kt)`].join('\n')].join('\n\n'),
    );
  });
  it('🔴 names the swell when the wind costs no star — the swell itself is the ceiling', () => {
    const r = goldenReport({ verdict: { kind: 'red', bestSpotId: 'kommetjie-long-beach' } });
    const kom = r.spots.find((x) => x.spotId === 'kommetjie-long-beach')!;
    // 0,9 m : note de base 2,33 → 2★ ; un vent à ×0,9 donne 2,1 → toujours 2★, il ne coûte rien
    for (const h of kom.hours) Object.assign(h, { heightM: 0.9, stars: 2, score: h.factors.day ? 2 : 0, factors: { ...h.factors, swell: 0.233, wind: 0.9 } });
    kom.maxScore = 2;
    expect(renderEvening(r, EN).split('\n')).toContain(`Best: ${KOM} ★★ (swell 0.9 m)`);
  });
  it('🔴 names the wind as soon as it costs a star, even when its factor is higher than the swell one', () => {
    // Long Beach le 17/09/2026 : 2,2 m (base 3,7, facteur 0,37) sous un offshore à 41 km/h (×0,54) → 2★.
    // Les deux facteurs ne sont pas sur la même échelle : sans le vent, c'était 4★ et un 🟢.
    const r = goldenReport({ verdict: { kind: 'red', bestSpotId: 'kommetjie-long-beach' } });
    const kom = r.spots.find((x) => x.spotId === 'kommetjie-long-beach')!;
    for (const h of kom.hours) Object.assign(h, { heightM: 2.2, windKt: 22, stars: 2, score: h.factors.day ? 2 : 0, factors: { ...h.factors, swell: 0.37, wind: 0.54 } });
    kom.maxScore = 2;
    expect(renderEvening(r, EN).split('\n')).toContain(`Best: ${KOM} ★★ (offshore SE 22 kt)`);
  });
  it('🔴 says the good window does not fit, never « nothing ≥ 4★ », when the best spot does reach 4★', () => {
    const lines = renderEvening(goldenReport({ verdict: { kind: 'red', bestSpotId: 'kommetjie-long-beach' } }), EN).split('\n');
    expect(lines).toContain('The good window within 20 km is too short or clashes with work.');
    expect(lines.join('\n')).not.toContain('Nothing ≥');
  });
  it('🔴 at exactly 4★ is already a good window: still « too short or clashes », the boundary is ≥', () => {
    const r = goldenReport({ verdict: { kind: 'red', bestSpotId: 'kommetjie-long-beach' } });
    r.spots.find((x) => x.spotId === 'kommetjie-long-beach')!.maxScore = 4;
    expect(renderEvening(r, EN)).toContain('The good window within 20 km is too short or clashes with work.');
  });
  it('🔴 names the thunderstorm when a storm is what kept every daylight hour at zero', () => {
    const r = goldenReport({ verdict: { kind: 'red', bestSpotId: 'kommetjie-long-beach' } });
    const kom = r.spots.find((x) => x.spotId === 'kommetjie-long-beach')!;
    for (const h of kom.hours) Object.assign(h, { score: 0, factors: { ...h.factors, weather: 0 } });
    kom.maxScore = 0;
    expect(renderEvening(r, EN).split('\n')).toContain(`Best: ${KOM} 0★ (thunderstorm)`);
  });
  it('🌅 dawn block', () => {
    const r = goldenReport({ verdict: { kind: 'yellow', dawn: { spotId: 'kommetjie-long-beach', window: W('07:00', '09:00', 6) } } });
    const lines = renderEvening(r, EN).split('\n');
    expect(lines[0]).toBe('🌅 <b>DAWN PATROL, THEN WORK</b> (Wed 16 Sept)');
    expect(lines[1]).toBe(`🏄 ${KOM} · 7:00–9:00 · ★★★★★★`);
    expect(lines[2]).toBe('   3.5 m · SW 13 s · offshore SE 8 kt · incoming tide, high 9:00');
  });
  it('🌅 a dawn+dusk 🟡 on one spot draws its day chart once, not twice', () => {
    // Le graphe couvre toute la journée : le redessiner sous « après le travail » répéterait à
    // l'identique la courbe déjà affichée sous « dawn patrol ».
    const pick = { spotId: 'kommetjie-long-beach', window: W('07:00', '09:00', 6) };
    const r = goldenReport({ verdict: { kind: 'yellow', dawn: pick, dusk: { spotId: 'kommetjie-long-beach', window: W('17:00', '18:00', 4) } } });
    const lines = renderEvening(r, EN).split('\n');
    expect(lines.filter((l) => l === '<code>6  9  12 15 18</code>').length).toBe(1);
  });
  it('🌅 a dawn+dusk 🟡 on two different spots draws one chart each', () => {
    const r = goldenReport({
      verdict: {
        kind: 'yellow',
        dawn: { spotId: 'muizenberg', window: W('07:00', '09:00', 4) },
        dusk: { spotId: 'kommetjie-long-beach', window: W('17:00', '18:00', 4) },
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
    expect(renderMorning(goldenReport({ mode: 'morning' }), { send: true, changed: false }, evening, EN)).toBe(`✅ Confirmed: 🟢 ${KOM} 7:00–12:00`);
  });
  it('changed with cause and the new conditions line', () => {
    const morning: Report = goldenReport({ mode: 'morning', verdict: { kind: 'green', spotId: 'kommetjie-long-beach', window: W('07:00', '10:00', 6), epic: false } });
    expect(renderMorning(morning, { send: true, changed: true, cause: 'wind' }, evening, EN)).toBe(
      [`⚠️ Change: 🟢 ${KOM} 7:00–12:00 → 🟢 ${KOM} 7:00–10:00`, '3.5 m · SW 13 s · offshore SE 8 kt · incoming tide, high 9:00', 'cause: wind'].join('\n'),
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
  it('is now the 📋 title line + the day view: primary spot chart, spot rows, tides, sun', () => {
    // Kommetjie's window (7:00–12:00, 6★), its "3.5 m · SW 13 s" conditions and "incoming tide, high 9:00"
    // match the 🟢 EN golden test above; the wind range 8→30 kt is goldenWindKt's min/max over 7..17;
    // the fade at 12:00 is the first hour under 60 % of the peak (2★ < 3,6), when the SE reaches 24 kt.
    expect(renderDetails(goldenReport(), EN)).toBe(
      [
        '📋 <b>Your day</b> (Wed 16 Sept)',
        `🏄 ${KOM} · 7:00–12:00`,
        '',
        '<code>6  9  12 15 18</code>',
        '<code>·▆▆▆▆▅▂······</code>',
        '',
        'peak ★★★★★★ at 7:00',
        '3.5 m · SW 13 s · offshore SE 8→30 kt · incoming tide, high 9:00',
        'best at 7:00 — wind drops to 8 kt',
        'fades from 12:00 — wind builds to 24 kt',
        '',
        '<code>Muizenberg    ·▂▂▂·········  2☆</code>',
        '',
        'tide: low 3:00 · high 9:00 · low 15:00 · high 21:00',
        '🌅 6:44 · 🌇 18:38',
      ].join('\n'),
    );
  });
  it('uses "today" in now mode, and no longer has any notion of a spot closed for a level', () => {
    const r = goldenReport({ mode: 'now' });
    r.spots.push({ spotId: 'outer-kom', distanceKm: 14.5, hours: [], windows: [], maxScore: 0 });
    const out = renderDetails(r, EN);
    expect(out.split('\n')[0]).toBe('📋 <b>Your day</b> (today)');
    expect(out).not.toContain('closed');
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

/** Kommetjie – Long Beach, hand-built on the star scale. Stars are derived from the factors exactly as the
 * engine does (base × wind, rounded), so a fixture can never claim a score its own factors contradict:
 * 3,1 m of swell (base 5.2) all day, only the wind moves — 4★ → 5★ at 8:00 → 2★ from 10:00 as the SE builds. */
const KOM_H = 3.1;
function komHour(
  hour: number,
  opts: { wind: number; windKt: number; tideState: 'low' | 'mid' | 'high'; trend: TideTrend; heightM?: number },
): SpotHour {
  const heightM = opts.heightM ?? KOM_H;
  const base = starBase(heightM);
  const stars = Math.round(rawStars(base, opts.wind));
  return {
    time: `${GOLDEN_DATE}T${String(hour).padStart(2, '0')}:00`,
    heightM, periodS: 12, swellDirDeg: 225,
    windKt: opts.windKt, windDirDeg: 135, windState: 'off',
    tide: { state: opts.tideState, trend: opts.trend },
    stars, clean: true,
    factors: { swell: base / 10, wind: opts.wind, day: 1, weather: 1 },
    score: stars,
  };
}

const KOM_HOURS: SpotHour[] = [
  komHour(7, { wind: 0.81, windKt: 18, tideState: 'mid', trend: 'rising' }),
  komHour(8, { wind: 0.97, windKt: 15, tideState: 'high', trend: 'falling' }),
  komHour(9, { wind: 0.8, windKt: 16, tideState: 'high', trend: 'falling' }),
  komHour(10, { wind: 0.4, windKt: 20, tideState: 'low', trend: 'falling' }),
  komHour(11, { wind: 0.4, windKt: 21, tideState: 'low', trend: 'falling' }),
  komHour(12, { wind: 0.4, windKt: 22, tideState: 'low', trend: 'rising' }),
  komHour(13, { wind: 0.4, windKt: 23, tideState: 'low', trend: 'rising' }),
  komHour(14, { wind: 0.4, windKt: 21, tideState: 'low', trend: 'rising' }),
  komHour(15, { wind: 0.2, windKt: 19, tideState: 'mid', trend: 'rising' }),
  komHour(16, { wind: 0.2, windKt: 18, tideState: 'high', trend: 'rising' }),
  komHour(17, { wind: 0.2, windKt: 17, tideState: 'high', trend: 'falling' }),
];
const KOM_WINDOW: Window = W('07:00', '10:00', 5);
const KOM_TIDES = [{ time: `${GOLDEN_DATE}T11:47`, kind: 'low' as const, heightM: -0.82 }];

// NB: both params are required (no defaults) — a default on `best` would fire even when a test passes
// `undefined` on purpose to mean "no window", which is exactly the case this fixture needs to express.
function komResult(hours: SpotHour[], best: Window | undefined): SpotResult {
  return {
    spotId: 'kommetjie-long-beach', distanceKm: 13.4,
    hours, windows: best ? [best] : [], best,
    maxScore: hours.reduce((m, h) => Math.max(m, h.score), 0),
  };
}

const KOM_CHART = '<code>6  9  12 15 18</code>\n<code>·▄▅▄▂▂▂▂▂▁▁▁·</code>';
const KOM_BLOCK = [
  `🏄 ${KOM} · 7:00–10:00`,
  '',
  KOM_CHART,
  '',
  'peak ★★★★★ at 8:00',
  '3.1 m · SW 12 s · offshore SE 15→23 kt · outgoing tide, low 11:47',
  'best at 8:00 — wind drops to 15 kt',
  'fades from 10:00 — wind builds to 20 kt',
].join('\n');

describe('renderSpotDay', () => {
  it('a spot with a window: title+window, chart, peak, conditions (wind as a range), and both explanation lines', () => {
    const report = makeReport({ spots: [komResult(KOM_HOURS, KOM_WINDOW)], tides: KOM_TIDES });
    expect(renderSpotDay(report, 'kommetjie-long-beach', EN)).toBe(KOM_BLOCK);
  });
  it('names the wind when only the wind moves — the swell is steady, and tide or period never weigh on the stars', () => {
    const report = makeReport({ spots: [komResult(KOM_HOURS, KOM_WINDOW)], tides: KOM_TIDES });
    const out = renderSpotDay(report, 'kommetjie-long-beach', EN);
    expect(out).toContain('best at 8:00 — wind drops to 15 kt');
    expect(out).toContain('fades from 10:00 — wind builds to 20 kt');
    expect(out).not.toMatch(/swell|tide still|low tide|mid tide|groundswell/);
  });
  it('credits the swell, not the wind, when the swell falls away under a steady offshore', () => {
    // 3,0 m → 0,9 m d'ici 10:00 ; le vent passe de 16 à 16,5 kt sans coûter une étoile
    const hours = [
      komHour(7, { wind: 1, windKt: 16, tideState: 'mid', trend: 'rising', heightM: 3.0 }),
      komHour(8, { wind: 1, windKt: 16, tideState: 'mid', trend: 'rising', heightM: 3.0 }),
      komHour(9, { wind: 1, windKt: 16, tideState: 'mid', trend: 'rising', heightM: 2.4 }),
      ...[10, 11, 12, 13, 14, 15, 16, 17].map((hr) => komHour(hr, { wind: 0.98, windKt: 16.5, tideState: 'mid', trend: 'rising', heightM: 0.9 })),
    ];
    const report = makeReport({ spots: [komResult(hours, W('07:00', '10:00', 5))] });
    const out = renderSpotDay(report, 'kommetjie-long-beach', EN);
    expect(out).toContain('best at 7:00 — swell peaks at 3.0 m');
    expect(out).toContain('fades from 10:00 — swell drops to 0.9 m');
    expect(out).not.toContain('wind');
  });
  it('RU: peak / best-at / fades-from translate with the same numbers', () => {
    const report = makeReport({ spots: [komResult(KOM_HOURS, KOM_WINDOW)], tides: KOM_TIDES });
    const out = renderSpotDay(report, 'kommetjie-long-beach', RU);
    expect(out).toContain('пик ★★★★★ в 8:00');
    expect(out).toContain('лучшее в 8:00 — ветер стихает до 15 kt');
    expect(out).toContain('спадает после 10:00 — ветер усиливается до 20 kt');
  });
  it('RU: the swell phrases translate too', () => {
    const hours = [
      komHour(7, { wind: 1, windKt: 16, tideState: 'mid', trend: 'rising', heightM: 3.0 }),
      ...[8, 9, 10].map((hr) => komHour(hr, { wind: 1, windKt: 16, tideState: 'mid', trend: 'rising', heightM: 0.9 })),
    ];
    const out = renderSpotDay(makeReport({ spots: [komResult(hours, W('07:00', '08:00', 5))] }), 'kommetjie-long-beach', RU);
    expect(out).toContain('лучшее в 7:00 — пик волны 3.0 м');
    expect(out).toContain('спадает после 8:00 — волна спадает до 0.9 м');
  });
  it('a spot with no window: skips peak/best-at/fades-from, keeps the chart and conditions', () => {
    const hours = Array.from({ length: 11 }, (_, i) =>
      komHour(7 + i, { wind: 0.4, windKt: 10, tideState: 'mid', trend: 'rising' }));
    const report = makeReport({ spots: [komResult(hours, undefined)], tides: [{ time: `${GOLDEN_DATE}T09:00`, kind: 'high', heightM: 0.5 }] });
    expect(renderSpotDay(report, 'kommetjie-long-beach', EN)).toBe(
      [
        `🏄 ${KOM} · ★★`, // sans fenêtre, l'en-tête chiffre quand même la journée
        '',
        '<code>6  9  12 15 18</code>\n<code>·▂▂▂▂▂▂▂▂▂▂▂·</code>',
        '',
        '3.1 m · SW 12 s · offshore SE 10 kt · incoming tide, high 9:00',
      ].join('\n'),
    );
  });
  it('a spot with no rated hour at all: its name and an empty chart, nothing invented', () => {
    const report = makeReport({ spots: [{ spotId: 'outer-kom', distanceKm: 14.5, hours: [], windows: [], best: undefined, maxScore: 0 }] });
    expect(renderSpotDay(report, 'outer-kom', EN)).toBe(
      ['🏄 Kommetjie – Outer Kom', '', '<code>6  9  12 15 18</code>\n<code>·············</code>'].join('\n'),
    );
  });
  it('says nothing when the day is flat: a window exists but every factor is steady all day', () => {
    const hours = Array.from({ length: 11 }, (_, i) =>
      komHour(7 + i, { wind: 0.8, windKt: 12, tideState: 'mid', trend: 'rising' }));
    const report = makeReport({
      spots: [komResult(hours, W('07:00', '18:00', 4))],
      tides: [{ time: `${GOLDEN_DATE}T09:00`, kind: 'high', heightM: 0.5 }],
    });
    const out = renderSpotDay(report, 'kommetjie-long-beach', EN);
    expect(out).toContain('peak ★★★★ at 7:00');
    expect(out).not.toContain('best at');
    expect(out).not.toContain('fades from');
  });
  it('names "gets dark" when the fade lands after the plotted hours, at the day factor dropping to 0', () => {
    // Flat 7:00–16:00 (never reaches windowMin), a one-hour window at 17:00 (the day's only peak, 5★),
    // then 18:00 where the wind is unchanged but daylight ends (day 1→0): the stars stay, the score drops.
    const flat = (hour: number): SpotHour => komHour(hour, { wind: 0.2, windKt: 12, tideState: 'high', trend: 'rising' });
    const lit = komHour(18, { wind: 0.97, windKt: 12, tideState: 'high', trend: 'rising' });
    const dusk: SpotHour = { ...lit, score: 0, factors: { ...lit.factors, day: 0 } };
    const hours = [
      ...Array.from({ length: 10 }, (_, i) => flat(7 + i)),
      komHour(17, { wind: 0.97, windKt: 12, tideState: 'high', trend: 'rising' }),
      dusk,
    ];
    const report = makeReport({ spots: [komResult(hours, W('17:00', '18:00', 5))] });
    expect(renderSpotDay(report, 'kommetjie-long-beach', EN)).toContain('fades from 18:00 — gets dark');
  });
});

function flatSpot(id: string, maxScore: number): SpotResult {
  return { spotId: id, distanceKm: 5, hours: [], windows: [], best: undefined, maxScore };
}
const DEAD_COLS = '·'.repeat(13); // 13 colonnes depuis que le graphique couvre les heures partiellement éclairées
/**
 * Same short-label/padding rule as `renderDayView`'s spot rows, re-derived independently for the test:
 * label (≤ 13 chars, own field — no truncation, § defect 2) padEnd(13) + 1 space + sparkline + 2 spaces + stars.
 */
function expectedRow(id: string, stars: number): string {
  const spot = SPOTS.find((sp) => sp.id === id)!;
  return `${spot.short.padEnd(13, ' ')} ${DEAD_COLS}  ${stars}★`;
}
const DAY_VIEW_TIDES = [
  { time: `${GOLDEN_DATE}T05:50`, kind: 'high' as const, heightM: -0.17 },
  { time: `${GOLDEN_DATE}T11:47`, kind: 'low' as const, heightM: -0.82 },
  { time: `${GOLDEN_DATE}T18:04`, kind: 'high' as const, heightM: -0.2 },
];
function dayViewReport(): Report {
  return makeReport({
    spots: [komResult(KOM_HOURS, KOM_WINDOW), flatSpot('muizenberg', 4), flatSpot('clovelly', 2), flatSpot('fish-hoek', 1), flatSpot('glen-beach', 0), flatSpot('kalk-bay-reef', 0)],
    tides: DAY_VIEW_TIDES,
    verdict: { kind: 'green', spotId: 'kommetjie-long-beach', window: KOM_WINDOW, epic: false },
  });
}
const DAY_VIEW_TAIL = ['tide: high 5:50 · low 11:47 · high 18:04', '🌅 6:44 · 🌇 18:38'];

describe('renderDayView', () => {
  it('shows the primary spot, then a sparkline row per spot with at least one star, then counts the 0★ ones', () => {
    expect(renderDayView(dayViewReport(), EN)).toBe(
      [
        KOM_BLOCK,
        `<code>${expectedRow('muizenberg', 4)}</code>\n<code>${expectedRow('clovelly', 2)}</code>\n<code>${expectedRow('fish-hoek', 1)}</code>`,
        ['2 spots at 0★ all day', ...DAY_VIEW_TAIL].join('\n'),
      ].join('\n\n'),
    );
  });
  it('with { all: true }: every spot gets a row, and the collapse line is omitted', () => {
    expect(renderDayView(dayViewReport(), EN, { all: true })).toBe(
      [
        KOM_BLOCK,
        [
          `<code>${expectedRow('muizenberg', 4)}</code>`,
          `<code>${expectedRow('clovelly', 2)}</code>`,
          `<code>${expectedRow('fish-hoek', 1)}</code>`,
          `<code>${expectedRow('glen-beach', 0)}</code>`,
          `<code>${expectedRow('kalk-bay-reef', 0)}</code>`,
        ].join('\n'),
        DAY_VIEW_TAIL.join('\n'),
      ].join('\n\n'),
    );
  });
  it('falls back to the highest-rated spot when the verdict has no pick', () => {
    const report = makeReport({
      spots: [flatSpot('muizenberg', 5), flatSpot('clovelly', 2)],
      verdict: { kind: 'red', bestSpotId: 'muizenberg' },
    });
    expect(renderDayView(report, EN).startsWith(`🏄 ${MUIZ}`)).toBe(true);
  });
  it('never mentions Open-Meteo any more', () => {
    expect(renderDayView(dayViewReport(), EN)).not.toContain('Open-Meteo');
  });
  it('distinguishes secondary rows a truncated full name could not (defect 2: Inner Kom / Outer Kom)', () => {
    const report = makeReport({
      spots: [komResult(KOM_HOURS, KOM_WINDOW), flatSpot('inner-kom', 3), flatSpot('outer-kom', 2)],
      tides: KOM_TIDES,
      verdict: { kind: 'green', spotId: 'kommetjie-long-beach', window: KOM_WINDOW, epic: false },
    });
    const out = renderDayView(report, EN);
    // both used to naively truncate to the identical "Kommetjie – " prefix — now each gets its own short
    // label; scoped to the secondary-rows block since the primary spot's own title legitimately uses the
    // full "Kommetjie – Long Beach" name.
    const rowsBlock = `<code>${expectedRow('inner-kom', 3)}</code>\n<code>${expectedRow('outer-kom', 2)}</code>`;
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
      // de 10★ à 1★, jamais croissant : world-0 en tête (spot principal), et le tri stable garde l'ordre d'insertion
      results.push(flatSpot(id, 10 - Math.floor((10 * i) / n)));
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
    // principal, les suivants sont une ligne par autre spot — seuls ceux-là sont plafonnés.
    const codeLines = [...out.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => m[1]);
    expect(codeLines).toHaveLength(2 + ALL_SPOTS_CAP);
    expect(out).toContain('+49 more spots not shown'); // 80 - 1 primary - 30 shown = 49 hidden
    expect(out).not.toContain('all day');
  });

  it('the capped /all message stays comfortably under Telegram\'s 4096-char limit even in an extreme, worse-than-realistic cluster', () => {
    const { report, ctx } = manySpots(200);
    const body = renderDetails(report, ctx, { all: true });
    expect(body.length).toBeLessThan(2500);
  });

  it('a cluster with no hidden spots (exactly at the cap) shows no "+N more" tail', () => {
    const { report, ctx } = manySpots(1 + ALL_SPOTS_CAP); // primary + exactly ALL_SPOTS_CAP others
    const out = renderDayView(report, ctx, { all: true });
    expect(out).not.toContain('more spots not shown');
  });
});

describe('renderDayView — row width budget (≤ 34 chars, § day-view.md "Width and naming fix")', () => {
  // Same three daylight spans chart.test.ts's chartHours suite already pins to 8/11/14-hour days.
  const withDaylight = (sunrise: string, sunset: string): Report =>
    makeReport({
      sun: { sunrise: `${GOLDEN_DATE}T${sunrise}`, sunset: `${GOLDEN_DATE}T${sunset}` },
      spots: [komResult(KOM_HOURS, KOM_WINDOW), flatSpot('muizenberg', 4), flatSpot('clovelly', 10)],
      tides: KOM_TIDES,
      verdict: { kind: 'green', spotId: 'kommetjie-long-beach', window: KOM_WINDOW, epic: false },
    });

  it.each([
    ['8-hour day', '09:00', '17:00'],
    ['11-hour day', '06:44', '18:38'],
    ['14-hour day', '05:32', '19:58'],
  ])('keeps every monospace line ≤ 34 chars on a %s (worst case: a 10★ spot)', (_name, sunrise, sunset) => {
    const out = renderDayView(withDaylight(sunrise, sunset), EN);
    const monoLines = [...out.matchAll(/<code>([\s\S]*?)<\/code>/g)].flatMap((m) => m[1].split('\n'));
    expect(monoLines.length).toBeGreaterThan(0);
    monoLines.forEach((line) => expect(line.length).toBeLessThanOrEqual(34));
  });
});

describe('renderWeek — the week ahead, best day first', () => {
  const Wd = (date: string, s: string, e: string, peak: number): Window => ({ start: `${date}T${s}`, end: `${date}T${e}`, peak, mean: peak });
  /** Un spot sur une journée : une heure à `stars` au début de la fenêtre, or ou blanche. */
  const spotOn = (spotId: string, date: string, stars: number, w?: Window, clean = true): SpotResult => ({
    spotId, distanceKm: 5, windows: w ? [w] : [], best: w, maxScore: stars,
    hours: [{ ...makeHour(w?.start ?? `${date}T08:00`, stars), clean }],
  });
  const day = (date: string, verdict: Verdict, spots: SpotResult[] = []): Report => makeReport({ date, verdict, spots });

  const WEEK: Report[] = [
    day('2026-09-16', { kind: 'green', spotId: 'kommetjie-long-beach', window: Wd('2026-09-16', '08:00', '12:00', 6), epic: true },
      [spotOn('kommetjie-long-beach', '2026-09-16', 6, Wd('2026-09-16', '08:00', '12:00', 6))]),
    day('2026-09-17', { kind: 'yellow', dawn: { spotId: 'muizenberg', window: Wd('2026-09-17', '07:00', '09:00', 4) } },
      [spotOn('muizenberg', '2026-09-17', 4, Wd('2026-09-17', '07:00', '09:00', 4), false)]),
    day('2026-09-18', { kind: 'red', bestSpotId: 'kommetjie-long-beach' },
      [spotOn('kommetjie-long-beach', '2026-09-18', 3), spotOn('muizenberg', '2026-09-18', 1)]),
    day('2026-09-19', { kind: 'red', bestSpotId: 'muizenberg' }, [spotOn('muizenberg', '2026-09-19', 0)]),
    day('2026-09-20', { kind: 'noData', reason: 'marine 500' }),
    day('2026-09-21', { kind: 'yellow', dusk: { spotId: 'llandudno', window: Wd('2026-09-21', '16:00', '18:00', 5) } },
      [spotOn('llandudno', '2026-09-21', 5, Wd('2026-09-21', '16:00', '18:00', 5))]),
    day('2026-09-22', { kind: 'green', spotId: 'kommetjie-long-beach', window: Wd('2026-09-22', '07:00', '11:00', 7), epic: true },
      [spotOn('kommetjie-long-beach', '2026-09-22', 7, Wd('2026-09-22', '07:00', '11:00', 7))]),
  ];

  it('EN: best day on top, one line per day, the trend from the fourth day after today', () => {
    expect(renderWeek(WEEK, EN, { today: '2026-09-16' })).toBe(
      [
        '📅 <b>THE WEEK AHEAD</b>',
        `⭐ Best: Tue 22 · ${KOM} ★★★★★★★ · 7:00–11:00`,
        [
          '🟢 <b>Today</b> · Long Beach ★★★★★★ · 8:00–12:00',
          '🌅 <b>Thu 17</b> · Muizenberg ☆☆☆☆ · 7:00–9:00',
          '🔴 <b>Fri 18</b> · Long Beach ★★★',
          '🔴 <b>Sat 19</b> · 0★ everywhere',
          '⚠️ <b>Sun 20</b> · no data',
          '🌇 <b>Mon 21</b> · Llandudno ★★★★★ · 16:00–18:00',
          '🟢 <b>Tue 22</b> · Long Beach ★★★★★★★ · 7:00–11:00',
        ].join('\n'),
        'From Sun 20 on, a trend only: check again closer to the day.',
      ].join('\n\n'),
    );
  });

  it('RU: the same week in Russian', () => {
    const out = renderWeek(WEEK, RU, { today: '2026-09-16' });
    expect(out.startsWith('📅 <b>НЕДЕЛЯ ВПЕРЕДИ</b>')).toBe(true);
    expect(out).toContain(`⭐ Лучший день: ${fmtDay('2026-09-22', 'ru')} · ${KOM} ★★★★★★★ · 7:00–11:00`);
    expect(out).toContain('🟢 <b>Сегодня</b> · Long Beach ★★★★★★ · 8:00–12:00');
    expect(out).toContain(`🔴 <b>${fmtDay('2026-09-19', 'ru')}</b> · везде 0★`);
    expect(out).toContain(`⚠️ <b>${fmtDay('2026-09-20', 'ru')}</b> · нет данных`);
  });

  it('fmtDay is a short weekday and the day of the month', () => {
    expect(fmtDay('2026-09-22', 'en')).toBe('Tue 22');
    expect(fmtDay('2026-09-22', 'ru')).toContain('22');
  });

  it('names the earliest of equally good days, and a red day can be the best the week offers', () => {
    const flat = [
      day('2026-09-17', { kind: 'red', bestSpotId: 'muizenberg' }, [spotOn('muizenberg', '2026-09-17', 3)]),
      day('2026-09-18', { kind: 'red', bestSpotId: 'llandudno' }, [spotOn('llandudno', '2026-09-18', 3)]),
    ];
    expect(renderWeek(flat, EN, { today: '2026-09-16' }).split('\n\n')[1]).toBe(`⭐ Best: Thu 17 · ${MUIZ} ★★★`);
  });

  it('no best line when the whole week is at 0★, and no trend line when every day is close', () => {
    const nothing = [day('2026-09-17', { kind: 'red' }, [spotOn('muizenberg', '2026-09-17', 0)])];
    expect(renderWeek(nothing, EN, { today: '2026-09-16' })).toBe(['📅 <b>THE WEEK AHEAD</b>', '🔴 <b>Thu 17</b> · 0★ everywhere'].join('\n\n'));
  });

  it('says there is no data at all rather than seven « no data » lines when Open-Meteo is down', () => {
    const down = Array.from({ length: 7 }, (_, i) => day(`2026-09-${17 + i}`, { kind: 'noData', reason: 'marine 500' }));
    expect(renderWeek(down, EN, { today: '2026-09-16' })).toBe('⚠️ No data (Open-Meteo unreachable). Try /now later.');
  });
});
