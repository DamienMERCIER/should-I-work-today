import { describe, it, expect } from 'vitest';
import { parseForecastTable, SF_SLUGS } from '../../scripts/compare-surf-forecast';
import { SPOTS } from '../../src/data/index';

/**
 * Fixture synthétique calquée sur le rendu texte de /breaks/Muizenberg/forecasts/latest (16/09/2026).
 * Le vrai balisage peut différer (classes, div dans les cellules) : ce test verrouille la logique du
 * parseur (colspan, AM/PM, changement de mois, « ! »), pas le HTML exact du site — voir --dump-html.
 */
const page = (issued: string, days: string, times: string, rating: string, wave: string, kj: string, wind: string, state: string): string => `
<html><body>
<p>Issued: <b>${issued}</b> (local time)</p>
<table class="forecast-table">
<tr><th>Change units</th>${days}</tr>
<tr><th></th>${times}</tr>
<tr><td><b>Rating</b> (10 max)</td>${rating}</tr>
<tr><td>Wave&nbsp;Height (m) Direction Period (s)</td>${wave}</tr>
<tr><td><img alt="Energy" src="x.svg"> kJ</td>${kj}</tr>
<tr><td>Wind (km/h)</td>${wind}</tr>
<tr><td>Wind State <span>on-shore cross-onshore cross-shore cross-offshore off-shore glassy</span></td>${state}</tr>
</table></body></html>`;

const cells = (...v: string[]): string => v.map((x) => `<td><div class="cell">${x}</div></td>`).join('');

describe('parseForecastTable', () => {
  it('lit note, houle, énergie, vent et état, heure par heure, avec les colspan des jours', () => {
    const html = page(
      '7 am 16 Sep 2026',
      '<th colspan="3">Wednesday<br>16</th><th colspan="2">Thursday<br>17</th>',
      cells('5 AM', '8 AM', '11 PM', '2 AM', '5 AM'),
      cells('0', '2', '!', '4', '5'),
      cells('2.1<br>SW<br>14', '1.7<br>SSW<br>9', '1.5<br>SW<br>13', '2.3<br>SW<br>14', '3<br>SW<br>16'),
      cells('1812', '411', '744', '2006', '4549'),
      cells('25<br>SSE', '35<br>SE', '40<br>SE', '5<br>WSW', '20<br>WNW'),
      cells('cross-on', 'on', 'on', 'glassy', 'off'),
    );
    const slots = parseForecastTable(html);
    expect(slots.map((s) => s.time)).toEqual(['2026-09-16T05:00', '2026-09-16T08:00', '2026-09-16T23:00', '2026-09-17T02:00', '2026-09-17T05:00']);
    expect(slots.map((s) => s.rating)).toEqual([0, 2, null, 4, 5]);
    expect(slots[0]).toMatchObject({ heightM: 2.1, dir: 'SW', periodS: 14, energyKJ: 1812, windKmh: 25, windDir: 'SSE', state: 'cross-on' });
    expect(slots[4]).toMatchObject({ heightM: 3, periodS: 16, windKmh: 20, state: 'off' });
  });

  it('passe au mois suivant quand le jour du mois redescend', () => {
    const html = page(
      '1 pm 30 Sep 2026',
      '<th colspan="1">Wed<br>30</th><th colspan="1">Thursday<br>1</th>',
      cells('11 PM', '2 AM'),
      cells('1', '1'),
      cells('1<br>SW<br>12', '1<br>SW<br>12'),
      cells('288', '288'),
      cells('10<br>SE', '10<br>SE'),
      cells('off', 'off'),
    );
    expect(parseForecastTable(html).map((s) => s.time)).toEqual(['2026-09-30T23:00', '2026-10-01T02:00']);
  });

  it('rend une liste vide plutôt que de planter quand la table manque', () => {
    expect(parseForecastTable('<html><body>Go Pro</body></html>')).toEqual([]);
  });
});

describe('SF_SLUGS', () => {
  it('ne référence que des spots curatés existants', () => {
    const ids = new Set(SPOTS.map((s) => s.id));
    for (const id of Object.keys(SF_SLUGS)) expect(ids.has(id), id).toBe(true);
  });
});
