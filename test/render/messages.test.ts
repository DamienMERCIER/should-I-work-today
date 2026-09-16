import { describe, it, expect } from 'vitest';
import {
  esc, fmtTime, fmtDate, renderEvening, renderShortVerdict, renderMorning, renderDetails, detailsButton, detailsMarkupFor, type RenderCtx,
} from '../../src/render/messages';
import { SPOTS } from '../../src/data/index';
import type { Report, Verdict } from '../../src/types';
import { GOLDEN_DATE, goldenReport } from '../helpers/golden';

const spots = new Map(SPOTS.map((s) => [s.id, s]));
const FR: RenderCtx = { lang: 'fr', spots };
const RU: RenderCtx = { lang: 'ru', spots };
const W = (s: string, e: string, peak: number) => ({ start: `${GOLDEN_DATE}T${s}`, end: `${GOLDEN_DATE}T${e}`, peak, mean: peak });
const KOM = "Kommetjie – Long Beach";
const MUIZ = "Muizenberg – Surfer's Corner";

describe('formatting', () => {
  it('fmtTime', () => {
    expect(fmtTime('07:00', 'fr')).toBe('7h');
    expect(fmtTime('2026-09-16T09:40', 'fr')).toBe('9h40');
    expect(fmtTime('07:00', 'ru')).toBe('7:00');
    expect(fmtTime('2026-09-16T09:40', 'ru')).toBe('9:40');
  });
  it('fmtDate', () => {
    expect(fmtDate('2026-09-16', 'fr')).toBe('mer. 16 sept.');
    expect(fmtDate('2026-09-16', 'ru')).toContain('16 сент.');
  });
  it('esc', () => {
    expect(esc('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
  it('detailsButton', () => {
    expect(detailsButton(GOLDEN_DATE, 'fr')).toEqual({ inline_keyboard: [[{ text: '📋 Tous les spots', callback_data: 'rep:2026-09-16' }]] });
  });
  it('detailsMarkupFor only attaches the 📋 button when there is a verdict', () => {
    expect(detailsMarkupFor(goldenReport(), 'fr')).toEqual({ inline_keyboard: [[{ text: '📋 Tous les spots', callback_data: 'rep:2026-09-16' }]] });
    expect(detailsMarkupFor(goldenReport({ spots: [], tides: [], verdict: { kind: 'outOfCoverage', nearest: [] } }), 'fr')).toBeUndefined();
    expect(detailsMarkupFor(goldenReport({ verdict: { kind: 'noData', reason: 'x' } }), 'fr')).toBeUndefined();
  });
});

describe('renderEvening — golden 🟢', () => {
  it('FR', () => {
    expect(renderEvening(goldenReport(), FR)).toBe(
      [
        '🟢 <b>NE VA PAS TRAVAILLER DEMAIN</b> (mer. 16 sept.)',
        `🏄 ${KOM} · 7h–12h · 8.6/10`,
        '   4 ft · SO 10 s · offshore SE 8 kt · marée montante, haute 9h',
        '   ☀️ 22° · lever 6h44',
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
    expect(renderEvening({ ...r, verdict: epic }, FR).split('\n')[0]).toBe("🟢 <b>NE VA PAS TRAVAILLER DEMAIN</b> (mer. 16 sept.) — c'est épique");
    expect(renderEvening({ ...r, date: '2026-09-19' }, FR).split('\n')[0]).toBe('🟢 <b>VA SURFER DEMAIN</b> (sam. 19 sept.)');
    expect(renderEvening({ ...r, mode: 'now' }, FR).split('\n')[0]).toBe("🟢 <b>VA SURFER</b> (aujourd'hui)");
  });
  it('mentions rain when ≥ 1 mm', () => {
    const r = goldenReport({ weather: { tempMaxC: 17.6, tempMinC: 12, precipMm: 4.6, code: 61 } });
    expect(renderEvening(r, FR).split('\n')[3]).toBe('   ☀️ 18° · lever 6h44 · pluie 5 mm');
  });
  it('shows a 🥈 runner-up when another open spot has a window', () => {
    const r = goldenReport();
    const muiz = r.spots.find((x) => x.spotId === 'muizenberg')!;
    muiz.windows = [W('07:00', '09:00', 6.5)];
    muiz.best = muiz.windows[0];
    const lines = renderEvening(r, FR).split('\n');
    expect(lines[4]).toBe(`🥈 ${MUIZ} · 7h–9h · 6.5/10`);
    expect(lines[5]).toBe('   3 ft · onshore SE 8 kt');
  });
  it('mentions the wind change at the end of the window', () => {
    const r = goldenReport();
    const kom = r.spots.find((x) => x.spotId === 'kommetjie-long-beach')!;
    kom.hours.find((h) => h.time === `${GOLDEN_DATE}T11:00`)!.windRelation = 'onshore';
    expect(renderEvening(r, FR).split('\n')[2]).toBe('   4 ft · SO 10 s · offshore SE 8 kt puis onshore · marée montante, haute 9h');
  });
});

describe('renderEvening — other verdicts', () => {
  it('🔴 names the best spot and its weakest factor', () => {
    const r = goldenReport({ verdict: { kind: 'red', bestSpotId: 'muizenberg' } });
    expect(renderEvening(r, FR)).toBe(
      ['🔴 <b>VA BOSSER DEMAIN</b> (mer. 16 sept.)', 'Rien à ≥ 7/10 dans les 20 km.', `Meilleur : ${MUIZ} 3.3/10 (2.5 ft)`].join('\n'),
    );
  });
  it('🌅 dawn block', () => {
    const r = goldenReport({ verdict: { kind: 'yellow', dawn: { spotId: 'muizenberg', window: W('07:00', '09:00', 7.2) } } });
    const lines = renderEvening(r, FR).split('\n');
    expect(lines[0]).toBe('🌅 <b>DAWN PATROL PUIS BOSSE</b> (mer. 16 sept.)');
    expect(lines[1]).toBe(`🏄 ${MUIZ} · 7h–9h · 7.2/10`);
    expect(lines[2]).toBe('   3 ft · SO 10 s · onshore SE 8 kt · marée montante, haute 9h');
  });
  it('out of coverage with raw conditions and nearest spots', () => {
    const r = goldenReport({
      spots: [], tides: [],
      verdict: { kind: 'outOfCoverage', raw: { swellHeightM: 1.8, periodS: 12, swellDirDeg: 225, windKt: 14, windDirDeg: 315 }, nearest: [{ spotId: 'victoria-bay', distanceKm: 38.2 }] },
    });
    expect(renderEvening(r, FR)).toBe(
      ['📍 Aucun spot connu à moins de 20 km.', 'Conditions brutes ici : houle 1.8 m 12 s SO · vent 14 kt NO', 'Spots connus les plus proches : ≈ Victoria Bay (38 km)'].join('\n'),
    );
  });
  it('far from the coast: no raw conditions', () => {
    const r = goldenReport({ spots: [], tides: [], verdict: { kind: 'outOfCoverage', nearest: [{ spotId: 'durban-new-pier', distanceKm: 512 }] } });
    expect(renderEvening(r, FR).split('\n')[1]).toBe("Tu es loin de l'océan — le spot connu le plus proche est à plus de 150 km.");
  });
  it('noData', () => {
    expect(renderEvening(goldenReport({ verdict: { kind: 'noData', reason: 'x' } }), FR)).toBe('⚠️ Pas de données (Open-Meteo injoignable). Réessaie /now plus tard.');
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
    expect(renderMorning(goldenReport({ mode: 'morning' }), { send: true, changed: false }, evening, FR)).toBe(`✅ Confirmé : 🟢 ${KOM} 7h–12h`);
  });
  it('changed with cause and the new conditions line', () => {
    const morning: Report = goldenReport({ mode: 'morning', verdict: { kind: 'green', spotId: 'kommetjie-long-beach', window: W('07:00', '11:00', 8.0), epic: false } });
    expect(renderMorning(morning, { send: true, changed: true, cause: 'wind' }, evening, FR)).toBe(
      [`⚠️ Changement : 🟢 ${KOM} 7h–12h → 🟢 ${KOM} 7h–11h`, '4 ft · SO 10 s · offshore SE 8 kt · marée montante, haute 9h', 'cause : vent'].join('\n'),
    );
  });
  it('degraded to red', () => {
    const morning = goldenReport({ mode: 'morning', verdict: { kind: 'red', bestSpotId: 'kommetjie-long-beach' } });
    expect(renderMorning(morning, { send: true, changed: true }, evening, FR)).toBe(`⚠️ Changement : 🟢 ${KOM} 7h–12h → 🔴 va bosser`);
  });
  it('noData keeps last night verdict', () => {
    const morning = goldenReport({ mode: 'morning', verdict: { kind: 'noData', reason: 'x' } });
    expect(renderMorning(morning, { send: true, changed: false }, evening, FR)).toBe(`⚠️ Pas de données ce matin — le verdict d'hier soir reste : 🟢 ${KOM} 7h–12h`);
  });
  it('short verdict of a missing report is red', () => {
    expect(renderShortVerdict(undefined, FR)).toBe('🔴 va bosser');
  });
});

describe('renderDetails', () => {
  it('lists open spots by peak, then tides, sun and licence', () => {
    expect(renderDetails(goldenReport(), FR)).toBe(
      [
        '📋 <b>Tous les spots</b> (mer. 16 sept.)',
        `${KOM} · 7h–12h · 8.6 · 4 ft · offshore SE 8 kt ↑`,
        `${MUIZ} · — · 3.3 · 3 ft · onshore SE 8 kt ↑`,
        'marée : basse 3h · haute 9h · basse 15h · haute 21h',
        '☀️ 22° · lever 6h44 · coucher 18h38',
        'Données : Open-Meteo.com (CC-BY 4.0)',
      ].join('\n'),
    );
  });
  it('lists closed spots and uses "aujourd\'hui" in now mode', () => {
    const r = goldenReport({ mode: 'now' });
    r.spots.push({ spotId: 'outer-kom', distanceKm: 14.5, open: false, hours: [], windows: [], maxScore: 0 });
    const lines = renderDetails(r, FR).split('\n');
    expect(lines[0]).toBe("📋 <b>Tous les spots</b> (aujourd'hui)");
    expect(lines[3]).toBe('fermés à ton niveau : Kommetjie – Outer Kom');
  });
});
